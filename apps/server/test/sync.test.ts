import { FRAGMENT, plainText } from "@anw/agent";
import { Connection } from "@anw/sync";
import { afterEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { startServer } from "../src/app.ts";
import { type Client, chaosSocket, client, rng, SECRET, server, tempDb, until } from "./harness.ts";

const opened: Client[] = [];
const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const c of opened.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.close().catch(() => {});
});
const track = (c: Client) => {
  opened.push(c);
  return c;
};

const para = (doc: Y.Doc, i: number) =>
  (doc.getXmlFragment(FRAGMENT).get(i) as Y.XmlElement).get(0) as Y.XmlText;

describe("rooms", () => {
  it("syncs two editors, and a viewer sees edits but cannot make them", async () => {
    const s = await server();
    servers.push(s);
    const lena = track(client(s, "lena"));
    const arif = track(client(s, "arif"));
    const jonas = track(client(s, "jonas"));
    const [a, b, v] = [
      lena.room("doc:launch-brief"),
      arif.room("doc:launch-brief"),
      jonas.room("doc:launch-brief"),
    ];
    await until(
      () => a.status === "synced" && b.status === "synced" && v.status === "synced",
      10_000,
      "synced",
    );
    expect(v.role).toBe("viewer");
    expect(plainText(a.doc)).toContain("Launch brief");
    para(a.doc, 1).insert(0, "Lena was here. ");
    await until(
      () => plainText(b.doc).includes("Lena was here.") && plainText(v.doc).includes("Lena was here."),
    );
    para(v.doc, 1).insert(0, "VIEWER ");
    await new Promise((r) => setTimeout(r, 200));
    expect(plainText(s.rooms.get("doc:launch-brief").doc)).not.toContain("VIEWER");
    expect(plainText(b.doc)).not.toContain("VIEWER");
  });

  it("denies rooms a person has no access to", async () => {
    const s = await server();
    servers.push(s);
    const arif = track(client(s, "arif"));
    const notes = arif.room("notes:lena");
    const nowhere = arif.room("doc:does-not-exist");
    await until(() => notes.status === "denied" && nowhere.status === "denied");
    expect(s.rooms.peek("doc:does-not-exist")).toBeUndefined();
  });

  it("merges what two people typed while offline", async () => {
    const s = await server();
    servers.push(s);
    const lena = track(client(s, "lena"));
    const maya = track(client(s, "maya"));
    const a = lena.room("doc:retro");
    const b = maya.room("doc:retro");
    await until(() => a.status === "synced" && b.status === "synced");
    lena.conn.close();
    para(a.doc, 0).insert(0, "[lena offline] ");
    para(b.doc, 0).insert(0, "[maya online] ");
    await until(() => plainText(s.rooms.get("doc:retro").doc).includes("[maya online]"));
    // Lena comes back on a new connection with the same document.
    const again = new Connection({ url: s.wsUrl, token: () => s.tokens.issue("lena", 60) });
    const { RoomProvider } = await import("@anw/sync");
    const back = new RoomProvider(again, "doc:retro", a.doc);
    again.connect();
    await until(() => back.status === "synced");
    await until(
      () => plainText(b.doc).includes("[lena offline]") && plainText(a.doc).includes("[maya online]"),
    );
    expect(a.doc.getXmlFragment(FRAGMENT).toJSON()).toBe(b.doc.getXmlFragment(FRAGMENT).toJSON());
    back.destroy();
    again.close();
  });

  it("restores documents after a restart, from a compacted log", async () => {
    const db = tempDb();
    let s = await startServer({ dbPath: db, secret: SECRET, seedChat: false });
    const port = s.port;
    const c = client(() => s, "lena");
    const r = c.room("doc:retro");
    await until(() => r.status === "synced");
    for (let i = 0; i < 250; i++) para(r.doc, 0).insert(0, "x");
    await until(() => plainText(s.rooms.get("doc:retro").doc).startsWith("x".repeat(250)));
    await s.close();
    s = await startServer({ dbPath: db, secret: SECRET, port, seedChat: false });
    servers.push(s);
    const fresh = track(client(s, "maya"));
    const r2 = fresh.room("doc:retro");
    await until(() => r2.status === "synced");
    expect(plainText(r2.doc).startsWith("x".repeat(250))).toBe(true);
    const rows = (
      s.store.db.prepare("select count(*) n from doc_updates where room = 'doc:retro'").get() as { n: number }
    ).n;
    expect(rows).toBeLessThan(200);
    c.close();
  });
});

describe("chaos", () => {
  // Several runs with different seeds: random latency on every frame, dropped connections,
  // and one server restart in the middle. At the end every replica must be identical and every
  // chat message must exist exactly once, in one order everyone agrees on.
  for (const seed of [1, 7, 42, 1337]) {
    it(`converges with seed ${seed}`, async () => {
      const random = rng(seed);
      const db = tempDb();
      let s = await startServer({ dbPath: db, secret: SECRET, seedChat: false });
      const port = s.port;
      const users = ["lena", "arif", "maya"];
      const cs = users.map((u) => track(client(() => s, u, chaosSocket(random, 15))));
      const docs = cs.map((c) => c.room("doc:retro"));
      const chats = cs.map((c) => c.channel("launch"));
      await until(() => docs.every((d) => d.status === "synced"), 15_000, "first sync");
      const sent: Record<string, string[]> = { lena: [], arif: [], maya: [] };
      let restarted = false;
      for (let step = 0; step < 120; step++) {
        const i = Math.floor(random() * cs.length);
        const c = cs[i]!;
        const roll = random();
        if (roll < 0.45) {
          const t = para(docs[i]!.doc, Math.floor(random() * 2));
          t.insert(Math.floor(random() * (t.length + 1)), `${c.user[0]}${step} `);
        } else if (roll < 0.75) {
          const body = `${c.user} message ${step}`;
          sent[c.user]!.push(body);
          chats[i]!.send(body);
        } else if (roll < 0.85) {
          c.conn.drop();
        } else if (!restarted && step > 60) {
          restarted = true;
          await s.close();
          s = await startServer({ dbPath: db, secret: SECRET, port, seedChat: false });
        }
        await new Promise((r) => setTimeout(r, Math.floor(random() * 8)));
      }
      servers.push(s);
      const total = Object.values(sent).flat().length;
      const state = () =>
        JSON.stringify({
          total,
          conn: cs.map((c) => c.conn.status),
          docs: docs.map((d) => d.status),
          chats: chats.map((ch) => [
            ch.getSnapshot().pending.length,
            ch.getSnapshot().messages.length,
            ch.getSnapshot().head,
          ]),
          server: s.store.head("launch"),
        });
      await until(
        () =>
          docs.every((d) => d.status === "synced") &&
          chats.every(
            (ch) => ch.getSnapshot().pending.length === 0 && ch.getSnapshot().messages.length === total,
          ),
        30_000,
        "heal",
      ).catch((e) => {
        throw new Error(`${(e as Error).message}: ${state()}`);
      });
      // One more round trip so the last updates land everywhere.
      await until(
        () => new Set(docs.map((d) => d.doc.getXmlFragment(FRAGMENT).toJSON())).size === 1,
        15_000,
        "docs equal",
      );
      const server = s.rooms.get("doc:retro").doc.getXmlFragment(FRAGMENT).toJSON();
      expect(docs[0]!.doc.getXmlFragment(FRAGMENT).toJSON()).toBe(server);
      const orders = chats.map((ch) =>
        ch
          .getSnapshot()
          .messages.map((m) => m.body)
          .join("|"),
      );
      expect(new Set(orders).size).toBe(1);
      const seen = chats[0]!.getSnapshot().messages;
      expect(new Set(seen.map((m) => m.body)).size).toBe(total);
      expect(seen.map((m) => m.seq)).toEqual(seen.map((_, k) => k + 1));
      for (const u of users) expect(seen.filter((m) => m.author === u).map((m) => m.body)).toEqual(sent[u]);
    }, 90_000);
  }
});

describe("auth", () => {
  it("refuses to start without a secret and rejects bad tokens", async () => {
    await expect(startServer({ dbPath: tempDb() })).rejects.toThrow(/no default secret/i);
    const s = await server();
    servers.push(s);
    const ws = new WebSocket(`${s.wsUrl}?token=forged.token`);
    const closed = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(false);
      ws.onerror = () => resolve(true);
      ws.onclose = () => resolve(true);
    });
    expect(closed).toBe(true);
    expect(s.tokens.verify(s.tokens.issue("lena", -1))).toBeNull();
  });
});
