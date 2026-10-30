import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { fromB64, toB64 } from "../b64.ts";
import type { Connection } from "./connection.ts";

export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;

export type RoomStatus = "connecting" | "syncing" | "synced" | "offline" | "denied";

/**
 * A shared document over the connection. Local edits are applied at once and sent when the
 * room is joined; after a reconnect the two sides exchange state vectors (sync step 1 and 2),
 * which sends exactly what the other side is missing, so nothing typed offline is lost.
 */
export class RoomProvider {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  status: RoomStatus = "connecting";
  role: "editor" | "viewer" | null = null;
  reason = "";
  private joined = false;
  private readonly listeners = new Set<() => void>();
  private readonly off: (() => void)[] = [];

  constructor(
    private readonly conn: Connection,
    readonly room: string,
    doc?: Y.Doc,
  ) {
    this.doc = doc ?? new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);
    this.off.push(
      conn.onOpen(() => {
        this.joined = false;
        this.setStatus("connecting");
        conn.send({ t: "join", room });
      }),
      conn.onStatus((s) => {
        if (s === "offline" || s === "closed") {
          this.joined = false;
          if (this.status !== "denied") this.setStatus("offline");
          // Other people's cursors are stale once we cannot hear from them.
          const others = [...this.awareness.getStates().keys()].filter((c) => c !== this.doc.clientID);
          awarenessProtocol.removeAwarenessStates(this.awareness, others, "offline");
        }
      }),
      conn.on("joined", (f) => {
        if (f.room !== room) return;
        this.joined = true;
        this.role = f.role;
        this.setStatus("syncing");
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, MSG_SYNC);
        syncProtocol.writeSyncStep1(e, this.doc);
        this.sendRaw(encoding.toUint8Array(e));
        if (this.awareness.getLocalState() !== null) {
          this.sendAwareness([this.doc.clientID]);
        }
      }),
      conn.on("denied", (f) => {
        if (f.room !== room) return;
        this.reason = f.reason;
        this.setStatus("denied");
      }),
      conn.on("y", (f) => {
        if (f.room === room) this.receive(fromB64(f.m));
      }),
    );
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setStatus(s: RoomStatus) {
    if (this.status === s) return;
    this.status = s;
    for (const fn of this.listeners) fn();
  }

  private sendRaw(bytes: Uint8Array) {
    this.conn.send({ t: "y", room: this.room, m: toB64(bytes) });
  }

  private sendAwareness(clients: number[]) {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_AWARENESS);
    encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients));
    this.sendRaw(encoding.toUint8Array(e));
  }

  private receive(bytes: Uint8Array) {
    const d = decoding.createDecoder(bytes);
    const type = decoding.readVarUint(d);
    if (type === MSG_SYNC) {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      const inner = syncProtocol.readSyncMessage(d, e, this.doc, this);
      if (encoding.length(e) > 1) this.sendRaw(encoding.toUint8Array(e));
      if (inner === syncProtocol.messageYjsSyncStep2) this.setStatus("synced");
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(d), this);
    }
  }

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this || !this.joined) return;
    if (this.role === "viewer") return;
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_SYNC);
    syncProtocol.writeUpdate(e, update);
    this.sendRaw(encoding.toUint8Array(e));
  };

  private readonly onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === this || !this.joined) return;
    this.sendAwareness([...added, ...updated, ...removed]);
  };

  destroy(): void {
    for (const f of this.off) f();
    this.conn.send({ t: "leave", room: this.room });
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "destroy");
    this.awareness.destroy();
    this.listeners.clear();
  }
}
