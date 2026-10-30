import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { type Model, modelFromEnv } from "@anw/agent";
import {
  assistant,
  channels,
  config,
  fromB64,
  parseClientFrame,
  people,
  roleIn,
  roomsOf,
  type ServerFrame,
} from "@anw/sync";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { type WebSocket, WebSocketServer } from "ws";
import { Assistant } from "./assistant.ts";
import { Tokens } from "./auth.ts";
import { Chat } from "./chat.ts";
import { type Peer, Rooms } from "./rooms.ts";
import { CHAT_SEED, seeds } from "./seed.ts";
import { Store } from "./store.ts";

export interface ServerOptions {
  port?: number;
  dbPath: string;
  /** Required unless dev is true; in dev a random one is made per process. */
  secret?: string;
  /** Enables /auth/dev, which issues a token for any demo person. Never in production. */
  dev?: boolean;
  model?: Model;
  now?: () => number;
  seedChat?: boolean;
}

export interface RunningServer {
  url: string;
  wsUrl: string;
  port: number;
  tokens: Tokens;
  store: Store;
  rooms: Rooms;
  /** Live sockets, so tests can cut them like a failing network would. */
  sockets: Set<WebSocket>;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const secret = opts.secret ?? (opts.dev ? Tokens.devSecret() : undefined);
  if (!secret) throw new Error("Set ANW_SECRET (32+ characters). There is no default secret.");
  const tokens = new Tokens(secret);
  const store = new Store(opts.dbPath);
  const clock = opts.now ?? Date.now;
  const rooms = new Rooms(store, (name) => seeds(name, clock()));
  const chat = new Chat(store);
  const model = opts.model ?? modelFromEnv(config.agent.model, config.agent.simulated);
  const helper = new Assistant(rooms, chat, model, clock);
  chat.onHumanMessage = (m) => helper.onMessage(m);

  if (opts.seedChat !== false)
    for (const [channel, lines] of Object.entries(CHAT_SEED))
      if (store.head(channel) === 0)
        lines.forEach(([author, body], i) => {
          store.insert({
            id: randomUUID(),
            channel,
            author,
            body,
            createdAt: Date.now() - (lines.length - i) * 600_000,
            status: "complete",
            version: 0,
          });
        });

  const app = new Hono();
  app.use("*", cors({ origin: config.sync.allowedOrigins, credentials: false }));
  app.get("/healthz", (c) => c.json({ ok: true, model: model.name }));
  app.get("/api/workspace", (c) => {
    const user = tokens.verify((c.req.header("authorization") ?? "").replace(/^Bearer /, ""));
    if (!user) return c.json({ error: "unauthorised" }, 401);
    return c.json({
      user,
      people,
      assistant,
      channels: channels.filter((ch) => ch.members.includes(user)),
      rooms: roomsOf(user).map(([id, r]) => ({ id, title: r.title, kind: r.kind })),
    });
  });
  if (opts.dev)
    app.get("/auth/dev", (c) => {
      const user = c.req.query("user") ?? "";
      if (!people.some((p) => p.id === user)) return c.json({ error: "unknown person" }, 404);
      return c.json({ token: tokens.issue(user, config.sync.tokenTtlSeconds) });
    });

  const http = serve({ fetch: app.fetch, port: opts.port ?? 0 });
  await new Promise<void>((resolve) =>
    http.listening ? resolve() : http.once("listening", () => resolve()),
  );
  const port = (http.address() as AddressInfo).port;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.sync.maxMessageBytes,
    // Yjs updates in base64 JSON compress well; a 100k-row sheet syncs at a fraction of its size.
    perMessageDeflate: { threshold: 1024 },
  });
  const sockets = new Set<WebSocket>();

  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    const origin = req.headers.origin;
    if (url.pathname !== "/ws" || (origin && !config.sync.allowedOrigins.includes(origin))) {
      socket.destroy();
      return;
    }
    const user = tokens.verify(url.searchParams.get("token") ?? "");
    if (!user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => connected(ws, user));
  });

  function connected(ws: WebSocket, user: string) {
    sockets.add(ws);
    const peer: Peer = {
      id: randomUUID(),
      user,
      send(frame: ServerFrame) {
        if (ws.readyState !== ws.OPEN) return;
        // A client that cannot keep up is dropped; it reconnects and resyncs from state vectors.
        if (ws.bufferedAmount > config.sync.slowConsumerBytes) {
          ws.close(1013, "slow consumer");
          return;
        }
        ws.send(JSON.stringify(frame));
      },
    };
    peer.send({ t: "welcome", user, serverTime: Date.now(), connection: peer.id });
    ws.on("message", (data) => {
      const f = parseClientFrame(String(data));
      if (!f) {
        peer.send({ t: "error", code: "bad-frame", message: "Frame not understood." });
        return;
      }
      switch (f.t) {
        case "join": {
          // Access is decided before a room is even loaded.
          if (!roleIn(user, f.room) || !rooms.get(f.room).join(peer))
            peer.send({ t: "denied", room: f.room, reason: "You do not have access." });
          break;
        }
        case "leave":
          rooms.peek(f.room)?.leave(peer);
          break;
        case "y":
          rooms.peek(f.room)?.receive(peer, fromB64(f.m));
          break;
        case "chat.sub":
          chat.subscribe(peer, f.channel, f.after);
          break;
        case "chat.send":
          chat.send(peer, f.channel, f.clientMsgId, f.body, f.replyTo);
          break;
        case "chat.edit":
          chat.edit(peer, f.id, f.body);
          break;
        case "chat.delete":
          chat.remove(peer, f.id);
          break;
        case "chat.read":
          chat.read(peer, f.channel, f.seq);
          break;
        case "chat.typing":
          chat.typing(peer, f.channel);
          break;
        case "proposal.decide":
          helper.decide(peer, f.channel, f.messageId, f.choice);
          break;
        case "agent.run":
          void helper.run(peer, f.runId, f.task);
          break;
        case "agent.cancel":
          helper.cancel(peer, f.runId);
          break;
        case "ping":
          peer.send({ t: "pong", at: f.at });
          break;
      }
    });
    ws.on("close", () => {
      sockets.delete(ws);
      rooms.leaveAll(peer);
      chat.unsubscribeAll(peer);
    });
  }

  return {
    url: `http://localhost:${port}`,
    wsUrl: `ws://localhost:${port}/ws`,
    port,
    tokens,
    store,
    rooms,
    sockets,
    async close() {
      for (const ws of sockets) ws.terminate();
      wss.close();
      chat.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      store.close();
    },
  };
}
