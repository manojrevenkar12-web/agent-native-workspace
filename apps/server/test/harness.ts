import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimulatedModel } from "@anw/agent";
import { ChatChannel, Connection, RoomProvider, type SocketLike } from "@anw/sync";
import { type RunningServer, type ServerOptions, startServer } from "../src/app.ts";

export const SECRET = "test-secret-that-is-long-enough-0123456789";

export function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "anw-")), "test.db");
}

export async function server(over: Partial<ServerOptions> = {}): Promise<RunningServer> {
  return startServer({
    dbPath: tempDb(),
    secret: SECRET,
    model: new SimulatedModel({ tokensPerSecond: 0, firstTokenMs: 0 }),
    seedChat: false,
    ...over,
  });
}

/** Seeded random numbers so a failing chaos run can be replayed. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * A WebSocket whose messages arrive late (in order, as on TCP) in both directions, so frames
 * from the two sides interleave in every possible way. Combined with `Connection.drop()` and
 * server restarts this is the network a phone on a train has.
 */
export function chaosSocket(random: () => number, maxDelayMs: number) {
  return (url: string): SocketLike => {
    const ws = new WebSocket(url);
    let outbound = Promise.resolve();
    let inbound = Promise.resolve();
    const delay = () => new Promise<void>((r) => setTimeout(r, Math.floor(random() * maxDelayMs)));
    const s: SocketLike = {
      get readyState() {
        return ws.readyState;
      },
      send(data) {
        outbound = outbound.then(delay).then(() => {
          if (ws.readyState === 1) ws.send(data);
        });
      },
      close: (code, reason) => ws.close(code, reason),
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    ws.onopen = (e) => s.onopen?.(e);
    ws.onclose = (e) => s.onclose?.(e);
    ws.onerror = (e) => s.onerror?.(e);
    ws.onmessage = (e) => {
      inbound = inbound.then(delay).then(() => s.onmessage?.({ data: e.data }));
    };
    return s;
  };
}

export interface Client {
  user: string;
  conn: Connection;
  room(name: string): RoomProvider;
  channel(id: string): ChatChannel;
  close(): void;
}

export function client(
  srv:
    | { wsUrl: string; tokens: RunningServer["tokens"] }
    | (() => { wsUrl: string; tokens: RunningServer["tokens"] }),
  user: string,
  socket?: (url: string) => SocketLike,
): Client {
  const get = typeof srv === "function" ? srv : () => srv;
  const conn = new Connection({
    url: get().wsUrl,
    token: () => get().tokens.issue(user, 3600),
    reconnect: { initialMs: 20, maxMs: 200, factor: 2, jitter: 0.3 },
    connectTimeoutMs: 1500,
    ...(socket ? { socket } : {}),
  });
  conn.connect();
  const rooms = new Map<string, RoomProvider>();
  const chans = new Map<string, ChatChannel>();
  return {
    user,
    conn,
    room(name) {
      let r = rooms.get(name);
      if (!r) rooms.set(name, (r = new RoomProvider(conn, name)));
      return r;
    },
    channel(id) {
      let c = chans.get(id);
      if (!c) chans.set(id, (c = new ChatChannel(conn, id, { owner: user })));
      return c;
    },
    close() {
      for (const r of rooms.values()) r.destroy();
      for (const c of chans.values()) c.destroy();
      conn.close();
    },
  };
}

export async function until(cond: () => boolean, timeoutMs = 10_000, what = "condition"): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
