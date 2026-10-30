import { config, MSG_AWARENESS, MSG_SYNC, roleIn, type ServerFrame, toB64 } from "@anw/sync";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import type { Store } from "./store.ts";

export interface Peer {
  readonly id: string;
  readonly user: string;
  send(frame: ServerFrame): void;
}

export class Room {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  /** Each peer and the awareness client ids it has announced. */
  readonly peers = new Map<Peer, { role: "editor" | "viewer"; clients: Set<number> }>();
  private sinceCompact = 0;

  constructor(
    readonly name: string,
    private readonly store: Store,
    seed?: (doc: Y.Doc) => void,
  ) {
    this.doc = new Y.Doc({ gc: true });
    const { snapshot, updates } = store.loadDoc(name);
    if (snapshot) Y.applyUpdate(this.doc, snapshot, "load");
    for (const u of updates) Y.applyUpdate(this.doc, u, "load");
    this.sinceCompact = updates.length;
    // Write before broadcast: whatever a client sees is already durable.
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "load") return;
      this.sinceCompact = store.appendUpdate(name, update);
      if (this.sinceCompact >= config.sync.compactAfterUpdates) this.compact();
      this.broadcast(
        syncFrame((e) => syncProtocol.writeUpdate(e, update)),
        origin,
      );
    });
    if (!snapshot && updates.length === 0 && seed) this.doc.transact(() => seed(this.doc), "seed");
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null);
    this.awareness.on(
      "update",
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const changed = [...added, ...updated, ...removed];
        if (origin instanceof Object && this.peers.has(origin as Peer)) {
          const own = this.peers.get(origin as Peer)!.clients;
          for (const c of added) own.add(c);
          for (const c of removed) own.delete(c);
        }
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, MSG_AWARENESS);
        encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
        this.broadcast(encoding.toUint8Array(e), origin);
      },
    );
  }

  compact(): void {
    this.store.compact(this.name, Y.encodeStateAsUpdate(this.doc));
    this.sinceCompact = 0;
  }

  join(peer: Peer): "editor" | "viewer" | null {
    const role = roleIn(peer.user, this.name);
    if (!role) return null;
    this.peers.set(peer, { role, clients: new Set() });
    peer.send({ t: "joined", room: this.name, role });
    this.sendTo(
      peer,
      syncFrame((e) => syncProtocol.writeSyncStep1(e, this.doc)),
    );
    const states = [...this.awareness.getStates().keys()];
    if (states.length) {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_AWARENESS);
      encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, states));
      this.sendTo(peer, encoding.toUint8Array(e));
    }
    return role;
  }

  leave(peer: Peer): void {
    const p = this.peers.get(peer);
    if (!p) return;
    this.peers.delete(peer);
    if (p.clients.size) awarenessProtocol.removeAwarenessStates(this.awareness, [...p.clients], "left");
  }

  /** Applies a client's message. Viewers may read and show presence, never write. */
  receive(peer: Peer, bytes: Uint8Array): void {
    const p = this.peers.get(peer);
    if (!p) return;
    const d = decoding.createDecoder(bytes);
    const type = decoding.readVarUint(d);
    if (type === MSG_SYNC) {
      const inner = decoding.peekVarUint(d);
      if (p.role === "viewer" && inner !== syncProtocol.messageYjsSyncStep1) {
        peer.send({
          t: "error",
          code: "read-only",
          message: `You can view ${this.name} but not edit it.`,
          ref: this.name,
        });
        return;
      }
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      syncProtocol.readSyncMessage(d, e, this.doc, peer);
      if (encoding.length(e) > 1) this.sendTo(peer, encoding.toUint8Array(e));
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(d), peer);
    }
  }

  private sendTo(peer: Peer, bytes: Uint8Array) {
    peer.send({ t: "y", room: this.name, m: toB64(bytes) });
  }

  private broadcast(bytes: Uint8Array, except: unknown) {
    if (this.peers.size === 0) return;
    const frame: ServerFrame = { t: "y", room: this.name, m: toB64(bytes) };
    for (const peer of this.peers.keys()) if (peer !== except) peer.send(frame);
  }
}

function syncFrame(write: (e: encoding.Encoder) => void): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MSG_SYNC);
  write(e);
  return encoding.toUint8Array(e);
}

export class Rooms {
  private readonly rooms = new Map<string, Room>();
  constructor(
    private readonly store: Store,
    private readonly seeds: (room: string) => ((doc: Y.Doc) => void) | undefined,
  ) {}

  get(name: string): Room {
    let r = this.rooms.get(name);
    if (!r) {
      r = new Room(name, this.store, this.seeds(name));
      this.rooms.set(name, r);
    }
    return r;
  }

  peek(name: string): Room | undefined {
    return this.rooms.get(name);
  }

  leaveAll(peer: Peer): void {
    for (const r of this.rooms.values()) r.leave(peer);
  }

  compactAll(): void {
    for (const r of this.rooms.values()) r.compact();
  }
}
