import { randomUUID } from "node:crypto";
import { assistant, config, inChannel, type Message, type Proposal, type ServerFrame } from "@anw/sync";
import type { Peer } from "./rooms.ts";
import type { Store } from "./store.ts";

/**
 * The chat log. The server is the only place a seq is assigned, so every client shows the same
 * order; a send is keyed by (channel, author, clientMsgId), so a retry after a lost ack returns
 * the message that already exists instead of a second copy.
 */
export class Chat {
  private readonly subs = new Map<string, Set<Peer>>();
  /** Streaming assistant messages live here between persists. */
  private readonly live = new Map<string, { msg: Message; dirty: boolean }>();
  private readonly timer: ReturnType<typeof setInterval>;
  onHumanMessage: (m: Message) => void = () => {};

  constructor(private readonly store: Store) {
    this.timer = setInterval(() => this.persistLive(), config.sync.chatPersistEveryMs);
    this.timer.unref?.();
  }

  close(): void {
    clearInterval(this.timer);
    this.persistLive();
  }

  subscribe(peer: Peer, channel: string, after: number): void {
    if (!inChannel(peer.user, channel)) {
      peer.send({ t: "error", code: "not-a-member", message: `You are not in #${channel}.`, ref: channel });
      return;
    }
    let s = this.subs.get(channel);
    if (!s) this.subs.set(channel, (s = new Set()));
    s.add(peer);
    let cursor = after;
    for (;;) {
      const page = this.store
        .after(channel, cursor, config.sync.chatBacklogPage)
        .map((m) => this.live.get(m.id)?.msg ?? m);
      peer.send({ t: "chat.backlog", channel, msgs: page, head: this.store.head(channel) });
      if (page.length < config.sync.chatBacklogPage) break;
      cursor = page.at(-1)!.seq;
    }
    for (const r of this.store.reads(channel))
      peer.send({ t: "chat.read", channel, user: r.user, seq: r.seq });
  }

  unsubscribeAll(peer: Peer): void {
    for (const s of this.subs.values()) s.delete(peer);
  }

  private broadcast(channel: string, frame: ServerFrame, except?: Peer) {
    for (const p of this.subs.get(channel) ?? []) if (p !== except) p.send(frame);
  }

  send(peer: Peer, channel: string, clientMsgId: string, body: string, replyTo?: string): void {
    if (!inChannel(peer.user, channel)) {
      peer.send({ t: "error", code: "not-a-member", message: `You are not in #${channel}.`, ref: channel });
      return;
    }
    const existing = this.store.byClientId(channel, peer.user, clientMsgId);
    if (existing) {
      peer.send({ t: "chat.ack", channel, clientMsgId, seq: existing.seq, id: existing.id });
      return;
    }
    const m: Omit<Message, "seq"> = {
      id: randomUUID(),
      channel,
      author: peer.user,
      body,
      createdAt: Date.now(),
      status: "complete",
      clientMsgId,
      version: 0,
    };
    if (replyTo) m.replyTo = replyTo;
    const msg = this.store.insert(m);
    peer.send({ t: "chat.ack", channel, clientMsgId, seq: msg.seq, id: msg.id });
    this.broadcast(channel, { t: "chat.msg", channel, msg });
    this.onHumanMessage(msg);
  }

  /** A message from the assistant (proposals, replies); no proactive pass runs on it. */
  post(
    channel: string,
    body: string,
    extra: { replyTo?: string; proposal?: Proposal; streaming?: boolean } = {},
  ): Message {
    const m: Omit<Message, "seq"> = {
      id: randomUUID(),
      channel,
      author: assistant.id,
      body,
      createdAt: Date.now(),
      status: extra.streaming ? "streaming" : "complete",
      version: 0,
    };
    if (extra.replyTo) m.replyTo = extra.replyTo;
    if (extra.proposal) m.proposal = extra.proposal;
    const msg = this.store.insert(m);
    if (extra.streaming) this.live.set(msg.id, { msg, dirty: false });
    this.broadcast(channel, { t: "chat.msg", channel, msg });
    return msg;
  }

  /** Appends streamed text; clients apply it only at the offset they already have. */
  delta(id: string, text: string): void {
    const l = this.live.get(id);
    if (!l || !text) return;
    const offset = l.msg.body.length;
    l.msg = { ...l.msg, body: l.msg.body + text, version: l.msg.version + 1 };
    l.dirty = true;
    this.broadcast(l.msg.channel, {
      t: "chat.delta",
      channel: l.msg.channel,
      id,
      offset,
      text,
      version: l.msg.version,
    });
  }

  finish(id: string, status: "complete" | "stopped"): void {
    const l = this.live.get(id);
    if (!l) return;
    this.live.delete(id);
    const msg = { ...l.msg, status, version: l.msg.version + 1 };
    this.store.update(msg);
    this.broadcast(msg.channel, { t: "chat.msg", channel: msg.channel, msg });
  }

  private persistLive() {
    for (const l of this.live.values())
      if (l.dirty) {
        this.store.update(l.msg);
        l.dirty = false;
      }
  }

  get(id: string): Message | null {
    return this.live.get(id)?.msg ?? this.store.message(id);
  }

  /** Writes a changed message and tells everyone in the channel. */
  change(msg: Message, patch: Partial<Message>): Message {
    const next = { ...msg, ...patch, version: msg.version + 1 };
    this.store.update(next);
    this.broadcast(next.channel, { t: "chat.msg", channel: next.channel, msg: next });
    return next;
  }

  edit(peer: Peer, id: string, body: string): void {
    const m = this.store.message(id);
    if (!m || m.author !== peer.user || m.deleted) {
      peer.send({ t: "error", code: "cannot-edit", message: "Only the author can edit a message.", ref: id });
      return;
    }
    this.change(m, { body, editedAt: Date.now() });
  }

  remove(peer: Peer, id: string): void {
    const m = this.store.message(id);
    if (!m || m.author !== peer.user) {
      peer.send({
        t: "error",
        code: "cannot-delete",
        message: "Only the author can delete a message.",
        ref: id,
      });
      return;
    }
    this.change(m, { body: "", deleted: true });
  }

  read(peer: Peer, channel: string, seq: number): void {
    if (!inChannel(peer.user, channel)) return;
    const s = this.store.read(channel, peer.user, Math.min(seq, this.store.head(channel)));
    this.broadcast(channel, { t: "chat.read", channel, user: peer.user, seq: s });
  }

  typing(peer: Peer, channel: string): void {
    if (inChannel(peer.user, channel))
      this.broadcast(channel, { t: "chat.typing", channel, user: peer.user }, peer);
  }

  /** Recent lines as "Name: text", the context the assistant works from. */
  context(channel: string, limit = 30, names: (id: string) => string = (x) => x, people = false): string[] {
    return this.store
      .recent(channel, limit)
      .filter((m) => !m.deleted && m.body && (!people || m.author !== assistant.id))
      .map((m) => `${names(m.author)}: ${m.body}`);
  }
}
