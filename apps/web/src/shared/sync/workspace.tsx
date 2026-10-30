"use client";

import {
  type AgentState,
  type AgentTask,
  ChatChannel,
  type ChatSnapshot,
  Connection,
  RoomProvider,
  type RoomStatus,
  type Status,
} from "@anw/sync";
import { createContext, type ReactNode, use, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { timing } from "@/shared/theme/tokens";
import { browserStorage, fetchToken, WS_URL } from "./session";

interface Cached<T> {
  value: T;
  refs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Keeps a room or channel alive while any screen uses it, and a minute after, for quick back-navigation. */
class Cache<T> {
  private readonly items = new Map<string, Cached<T>>();
  constructor(
    private readonly make: (key: string) => T,
    private readonly dispose: (value: T) => void,
  ) {}

  get(key: string): T {
    let c = this.items.get(key);
    if (!c) this.items.set(key, (c = { value: this.make(key), refs: 0, timer: null }));
    return c.value;
  }

  acquire(key: string): () => void {
    this.get(key);
    const c = this.items.get(key)!;
    c.refs++;
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    return () => {
      c.refs--;
      if (c.refs > 0) return;
      c.timer = setTimeout(() => {
        if (c.refs > 0) return;
        this.items.delete(key);
        this.dispose(c.value);
      }, timing.roomIdleCloseMs);
    };
  }

  clear(): void {
    for (const c of this.items.values()) this.dispose(c.value);
    this.items.clear();
  }
}

export interface AgentRun {
  runId: string;
  state: AgentState;
  detail?: string;
  room?: string;
  task: AgentTask;
}

class Runs {
  runs: Record<string, AgentRun> = {};
  private readonly listeners = new Set<() => void>();
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  get = () => this.runs;
  set(r: AgentRun) {
    this.runs = { ...this.runs, [r.runId]: r };
    for (const fn of this.listeners) fn();
  }
}

export interface Workspace {
  user: string;
  conn: Connection;
  rooms: Cache<RoomProvider>;
  channels: Cache<ChatChannel>;
  runs: Runs;
}

const Ctx = createContext<Workspace | null>(null);

export function WorkspaceProvider({ user, children }: { user: string; children: ReactNode }) {
  const [ws] = useState<Workspace>(() => {
    const conn = new Connection({ url: WS_URL, token: () => fetchToken(user) });
    const runs = new Runs();
    conn.on("agent.status", (f) => {
      const prev = runs.runs[f.runId];
      if (prev) runs.set({ ...prev, state: f.state, ...(f.detail ? { detail: f.detail } : {}) });
    });
    return {
      user,
      conn,
      runs,
      rooms: new Cache(
        (name) => new RoomProvider(conn, name),
        (r) => r.destroy(),
      ),
      channels: new Cache(
        (id) => new ChatChannel(conn, id, { owner: user, storage: browserStorage }),
        (c) => c.destroy(),
      ),
    };
  });
  useEffect(() => {
    ws.conn.connect();
    return () => {
      ws.conn.close();
      ws.rooms.clear();
      ws.channels.clear();
    };
  }, [ws]);
  return <Ctx value={ws}>{children}</Ctx>;
}

export function useWorkspace(): Workspace {
  const ws = use(Ctx);
  if (!ws) throw new Error("useWorkspace outside WorkspaceProvider");
  return ws;
}

export function useConnectionStatus(): Status {
  const { conn } = useWorkspace();
  return useSyncExternalStore(
    (fn) => conn.onStatus(fn),
    () => conn.status,
    () => "idle",
  );
}

export interface RoomState {
  provider: RoomProvider;
  doc: Y.Doc;
  status: RoomStatus;
  role: "editor" | "viewer" | null;
  reason: string;
}

export function useRoom(name: string): RoomState {
  const { rooms } = useWorkspace();
  const provider = rooms.get(name);
  useEffect(() => rooms.acquire(name), [rooms, name]);
  const status = useSyncExternalStore(
    (fn) => provider.subscribe(fn),
    () => provider.status,
    () => "connecting" as RoomStatus,
  );
  return { provider, doc: provider.doc, status, role: provider.role, reason: provider.reason };
}

/** Re-renders when anything inside a shared type changes; returns a counter to key memos on. */
// biome-ignore lint/suspicious/noExplicitAny: any shared type
export function useYVersion(type: Y.AbstractType<any> | null): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!type) return;
    const fn = () => setVersion((v) => v + 1);
    type.observeDeep(fn);
    return () => type.unobserveDeep(fn);
  }, [type]);
  return version;
}

/**
 * A value derived from a shared type, recomputed whenever the type changes. The computation
 * runs in the observer, so it never depends on render-time memoisation guessing its inputs.
 */
// biome-ignore lint/suspicious/noExplicitAny: any shared type
export function useYDerived<T>(type: Y.AbstractType<any> | null, compute: () => T, throttleMs = 0): T {
  const [value, setValue] = useState<T>(compute);
  const latest = useRef(compute);
  latest.current = compute;
  useEffect(() => {
    if (!type) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      timer = null;
      setValue(latest.current());
    };
    // Throttled: a stream of remote updates costs one recomputation per window, off the
    // keystroke path, instead of one per update.
    const fn = () => {
      if (throttleMs <= 0) return run();
      timer ??= setTimeout(run, throttleMs);
    };
    run();
    type.observeDeep(fn);
    return () => {
      if (timer) clearTimeout(timer);
      type.unobserveDeep(fn);
    };
  }, [type, throttleMs]);
  return value;
}

export function useChannel(id: string): { channel: ChatChannel; snapshot: ChatSnapshot } {
  const { channels } = useWorkspace();
  const channel = channels.get(id);
  useEffect(() => channels.acquire(id), [channels, id]);
  const snapshot = useSyncExternalStore(channel.subscribe, channel.getSnapshot, channel.getSnapshot);
  return { channel, snapshot };
}

let runCounter = 0;

export function useAgent() {
  const { conn, runs } = useWorkspace();
  const all = useSyncExternalStore(runs.subscribe, runs.get, runs.get);
  return {
    runs: all,
    start(task: AgentTask): string {
      const runId = `${Date.now().toString(36)}-${(runCounter++).toString(36)}`;
      runs.set({ runId, state: "queued", task });
      if (!conn.send({ t: "agent.run", runId, task }))
        runs.set({
          runId,
          state: "failed",
          detail: "You are offline. Try again when the connection is back.",
          task,
        });
      return runId;
    },
    cancel(runId: string) {
      conn.send({ t: "agent.cancel", runId });
    },
  };
}

/**
 * Awareness states of everyone in a room except this tab. A remote caret moves on every
 * keystroke; the state only changes (and the screen only re-renders) when what the caller
 * shows changes, which `select` decides.
 */
export function usePresence(
  provider: RoomProvider,
  select: (state: Record<string, unknown>) => unknown = (x) => x,
) {
  const [states, setStates] = useState<{ client: number; state: Record<string, unknown> }[]>([]);
  const pick = useRef(select);
  pick.current = select;
  useEffect(() => {
    let last = "";
    const read = () => {
      const next = [...provider.awareness.getStates()]
        .filter(([c, s]) => c !== provider.doc.clientID && s && Object.keys(s).length > 0)
        .map(([client, state]) => ({ client, state: state as Record<string, unknown> }));
      const key = JSON.stringify(next.map((n) => [n.client, pick.current(n.state)]));
      if (key === last) return;
      last = key;
      setStates(next);
    };
    read();
    provider.awareness.on("change", read);
    return () => provider.awareness.off("change", read);
  }, [provider]);
  return states;
}
