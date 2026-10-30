import { describe, expect, it } from "vitest";
import {
  backoff,
  ChatChannel,
  type Connection,
  type Message,
  memoryStorage,
  type ServerFrame,
} from "../src/index.ts";

/** A connection double: records sends, lets the test deliver server frames. */
function fakeConnection(open = true) {
  const handlers = new Map<string, ((f: ServerFrame) => void)[]>();
  const sent: unknown[] = [];
  const conn = {
    status: open ? "open" : "offline",
    user: "lena",
    on(t: string, fn: (f: ServerFrame) => void) {
      handlers.set(t, [...(handlers.get(t) ?? []), fn]);
      return () => {};
    },
    onOpen: () => () => {},
    onStatus: () => () => {},
    send(f: unknown) {
      if (conn.status !== "open") return false;
      sent.push(f);
      return true;
    },
  };
  const deliver = (f: ServerFrame) => {
    for (const fn of handlers.get(f.t) ?? []) fn(f);
  };
  return { conn: conn as unknown as Connection, sent, deliver };
}

const msg = (seq: number, over: Partial<Message> = {}): Message => ({
  id: `m${seq}`,
  seq,
  channel: "launch",
  author: "arif",
  body: `message ${seq}`,
  createdAt: seq,
  status: "complete",
  version: 0,
  ...over,
});

describe("chat channel", () => {
  it("gives React a new snapshot (and new arrays) on every change", () => {
    const { conn } = fakeConnection(false);
    const ch = new ChatChannel(conn, "launch", { owner: "lena" });
    const before = ch.getSnapshot();
    ch.send("offline message");
    const after = ch.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.pending).not.toBe(before.pending);
    expect(after.pending.map((p) => p.body)).toEqual(["offline message"]);
  });

  it("keeps the outbox across reloads and clears it when the server acknowledges", () => {
    const storage = memoryStorage();
    const first = fakeConnection(false);
    new ChatChannel(first.conn, "launch", { owner: "lena", storage }).send("survives a reload");
    const second = fakeConnection();
    const ch = new ChatChannel(second.conn, "launch", { owner: "lena", storage });
    expect(ch.getSnapshot().pending).toHaveLength(1);
    const id = ch.getSnapshot().pending[0]!.clientMsgId;
    second.deliver({
      t: "chat.msg",
      channel: "launch",
      msg: msg(1, { author: "lena", clientMsgId: id, body: "survives a reload" }),
    });
    expect(ch.getSnapshot().pending).toHaveLength(0);
    expect(ch.getSnapshot().messages).toHaveLength(1);
  });

  it("asks for the missing range when it sees a gap, and orders what arrives late", () => {
    const { conn, sent, deliver } = fakeConnection();
    const ch = new ChatChannel(conn, "launch", { owner: "lena" });
    deliver({ t: "chat.backlog", channel: "launch", msgs: [msg(1)], head: 1 });
    deliver({ t: "chat.msg", channel: "launch", msg: msg(3) });
    expect(sent).toContainEqual({ t: "chat.sub", channel: "launch", after: 1 });
    expect(ch.getSnapshot().head).toBe(1);
    deliver({ t: "chat.backlog", channel: "launch", msgs: [msg(2), msg(3)], head: 3 });
    expect(ch.getSnapshot().messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(ch.getSnapshot().head).toBe(3);
  });

  it("applies streamed text only at the offset it already has, and keeps the newest version", () => {
    const { deliver, conn } = fakeConnection();
    const ch = new ChatChannel(conn, "launch", { owner: "lena" });
    deliver({
      t: "chat.msg",
      channel: "launch",
      msg: msg(1, { author: "assistant", body: "", status: "streaming", version: 0 }),
    });
    deliver({ t: "chat.delta", channel: "launch", id: "m1", offset: 0, text: "Hel", version: 1 });
    deliver({ t: "chat.delta", channel: "launch", id: "m1", offset: 0, text: "Hel", version: 1 }); // duplicate
    deliver({ t: "chat.delta", channel: "launch", id: "m1", offset: 9, text: "???", version: 3 }); // gap: ignored
    deliver({ t: "chat.delta", channel: "launch", id: "m1", offset: 3, text: "lo", version: 2 });
    expect(ch.getSnapshot().messages[0]!.body).toBe("Hello");
    deliver({
      t: "chat.msg",
      channel: "launch",
      msg: msg(1, { author: "assistant", body: "Hello there", status: "complete", version: 4 }),
    });
    deliver({
      t: "chat.msg",
      channel: "launch",
      msg: msg(1, { author: "assistant", body: "stale", status: "streaming", version: 3 }),
    });
    expect(ch.getSnapshot().messages[0]).toMatchObject({ body: "Hello there", status: "complete" });
  });
});

describe("reconnect backoff", () => {
  it("grows, caps and jitters", () => {
    const r = { initialMs: 250, maxMs: 8000, factor: 2, jitter: 0.3 };
    expect(backoff(0, r, () => 0.5)).toBe(250);
    expect(backoff(3, r, () => 0.5)).toBe(2000);
    expect(backoff(20, r, () => 0.5)).toBe(8000);
    expect(backoff(20, r, () => 0)).toBe(5600);
    expect(backoff(20, r, () => 1)).toBe(10400);
  });
});
