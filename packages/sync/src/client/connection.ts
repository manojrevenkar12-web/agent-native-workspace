import { type ClientFrame, encode, type ServerFrame } from "../protocol.ts";
import { config } from "../workspace.ts";

export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;
export type Status = "idle" | "connecting" | "open" | "offline" | "closed";

type FrameOf<T extends ServerFrame["t"]> = Extract<ServerFrame, { t: T }>;
type Handler = (f: ServerFrame) => void;

export interface ConnectionOptions {
  url: string;
  token: () => string | Promise<string>;
  socket?: SocketFactory;
  random?: () => number;
  reconnect?: typeof config.sync.reconnect;
  heartbeatMs?: number;
  staleAfterMs?: number;
  connectTimeoutMs?: number;
}

const OPEN = 1;

/** Reconnect delay: exponential, capped, with jitter so a fleet does not reconnect in lockstep. */
export function backoff(attempt: number, r = config.sync.reconnect, random = Math.random): number {
  const base = Math.min(r.maxMs, r.initialMs * r.factor ** attempt);
  return Math.round(base * (1 - r.jitter + 2 * r.jitter * random()));
}

/**
 * The one WebSocket a client keeps. It reconnects with backoff, detects a dead link with a
 * heartbeat, and tells every surface (rooms, chat channels) when a fresh connection opens so
 * each can resume from what it already has.
 */
export class Connection {
  status: Status = "idle";
  user: string | null = null;
  private ws: SocketLike | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private lastFrameAt = 0;
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly openHandlers = new Set<() => void>();
  private readonly statusHandlers = new Set<(s: Status) => void>();
  private readonly opts: Required<Omit<ConnectionOptions, "socket">> & { socket: SocketFactory };
  private stopped = false;
  private readonly onOnline = () => this.reconnectNow();

  constructor(opts: ConnectionOptions) {
    this.opts = {
      random: Math.random,
      reconnect: config.sync.reconnect,
      heartbeatMs: config.sync.heartbeatMs,
      staleAfterMs: config.sync.staleAfterMs,
      connectTimeoutMs: config.sync.connectTimeoutMs,
      socket: (url) => new WebSocket(url) as unknown as SocketLike,
      ...opts,
    } as typeof this.opts;
  }

  on<T extends ServerFrame["t"]>(t: T, fn: (f: FrameOf<T>) => void): () => void {
    let s = this.handlers.get(t);
    if (!s) this.handlers.set(t, (s = new Set()));
    s.add(fn as Handler);
    return () => s.delete(fn as Handler);
  }

  /** Runs on every fresh connection (after the server's welcome), and now if already open. */
  onOpen(fn: () => void): () => void {
    this.openHandlers.add(fn);
    if (this.status === "open") fn();
    return () => this.openHandlers.delete(fn);
  }

  onStatus(fn: (s: Status) => void): () => void {
    this.statusHandlers.add(fn);
    return () => this.statusHandlers.delete(fn);
  }

  send(frame: ClientFrame): boolean {
    if (this.status !== "open" || !this.ws || this.ws.readyState !== OPEN) return false;
    this.ws.send(encode(frame));
    return true;
  }

  connect(): void {
    this.stopped = false;
    if (typeof window !== "undefined") window.addEventListener("online", this.onOnline);
    void this.open();
  }

  /** Drops the current socket as if the network failed; the connection heals itself. */
  drop(): void {
    this.ws?.close(4000, "dropped");
  }

  reconnectNow(): void {
    if (this.stopped || this.status === "open" || this.status === "connecting") return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.open();
  }

  close(): void {
    this.stopped = true;
    if (typeof window !== "undefined") window.removeEventListener("online", this.onOnline);
    if (this.timer) clearTimeout(this.timer);
    if (this.beat) clearInterval(this.beat);
    this.ws?.close(1000, "closed");
    this.ws = null;
    this.setStatus("closed");
  }

  private setStatus(s: Status) {
    if (this.status === s) return;
    this.status = s;
    for (const fn of this.statusHandlers) fn(s);
  }

  private async open(): Promise<void> {
    this.setStatus("connecting");
    let token: string;
    try {
      token = await this.opts.token();
    } catch {
      this.schedule();
      return;
    }
    if (this.stopped) return;
    const ws = this.opts.socket(`${this.opts.url}?token=${encodeURIComponent(token)}`);
    this.ws = ws;
    // A handshake can hang (a server going down mid-upgrade); WebSocket itself never times out.
    const guard = setTimeout(() => {
      if (this.ws !== ws || this.status === "open") return;
      this.ws = null;
      ws.onclose = ws.onmessage = ws.onopen = null;
      ws.close();
      if (this.stopped) return;
      this.setStatus("offline");
      this.schedule();
    }, this.opts.connectTimeoutMs);
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastFrameAt = Date.now();
      let f: ServerFrame;
      try {
        f = JSON.parse(String(ev.data)) as ServerFrame;
      } catch {
        return;
      }
      if (f.t === "welcome") {
        clearTimeout(guard);
        this.user = f.user;
        this.attempt = 0;
        this.setStatus("open");
        for (const fn of [...this.openHandlers]) fn();
      }
      for (const fn of [...(this.handlers.get(f.t) ?? [])]) fn(f);
    };
    ws.onclose = () => {
      clearTimeout(guard);
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.beat) clearInterval(this.beat);
      if (this.stopped) return;
      this.setStatus("offline");
      this.schedule();
    };
    ws.onerror = () => {};
    ws.onopen = () => {
      this.lastFrameAt = Date.now();
      if (this.beat) clearInterval(this.beat);
      this.beat = setInterval(() => {
        if (Date.now() - this.lastFrameAt > this.opts.staleAfterMs) ws.close(4001, "stale");
        else this.send({ t: "ping", at: Date.now() });
      }, this.opts.heartbeatMs);
    };
  }

  private schedule() {
    if (this.stopped || this.timer) return;
    const delay = backoff(this.attempt++, this.opts.reconnect, this.opts.random);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.open();
    }, delay);
  }
}
