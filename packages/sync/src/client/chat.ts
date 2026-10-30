import type { Message } from "../protocol.ts";
import type { Connection } from "./connection.ts";

export interface KeyValue {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export const memoryStorage = (): KeyValue => {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
};

export interface Pending {
  clientMsgId: string;
  body: string;
  replyTo?: string;
  createdAt: number;
}

export interface ChatSnapshot {
  /** Confirmed messages in server order. */
  messages: readonly Message[];
  /** Sent but not yet acknowledged, in send order; shown at the end of the list. */
  pending: readonly Pending[];
  /** Highest seq with no gap before it. */
  head: number;
  loaded: boolean;
  typing: readonly string[];
  reads: Readonly<Record<string, number>>;
}

let counter = 0;
const newId = () =>
  `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * One channel's view of the chat log. The server orders messages (seq) and dedupes sends by
 * clientMsgId; the client keeps an outbox that survives reloads and resends it in order after
 * every reconnect, so a message is shown once however often the network drops.
 */
export class ChatChannel {
  private readonly byId = new Map<string, Message>();
  private ordered: Message[] = [];
  private outbox: Pending[];
  private head = 0;
  private loaded = false;
  private gapRequested = false;
  private readonly typingUntil = new Map<string, number>();
  private readonly reads: Record<string, number> = {};
  private snapshot: ChatSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly off: (() => void)[] = [];
  private lastTypingSent = 0;

  private readonly storage: KeyValue;
  private readonly now: () => number;
  private readonly owner: string;

  constructor(
    private readonly conn: Connection,
    readonly channel: string,
    opts: { owner: string; storage?: KeyValue; now?: () => number },
  ) {
    this.owner = opts.owner;
    this.storage = opts.storage ?? memoryStorage();
    this.now = opts.now ?? Date.now;
    this.outbox = this.loadOutbox();
    this.snapshot = this.build();
    this.off.push(
      conn.onOpen(() => {
        this.gapRequested = false;
        conn.send({ t: "chat.sub", channel, after: this.head });
        this.flush();
      }),
      conn.on("chat.backlog", (f) => {
        if (f.channel !== channel) return;
        for (const m of f.msgs) this.merge(m);
        this.loaded = true;
        this.gapRequested = false;
        this.advanceHead();
        this.emit();
      }),
      conn.on("chat.msg", (f) => {
        if (f.channel !== channel) return;
        this.merge(f.msg);
        this.advanceHead();
        if (f.msg.seq > this.head + 1 && !this.gapRequested) {
          this.gapRequested = true;
          conn.send({ t: "chat.sub", channel, after: this.head });
        }
        this.emit();
      }),
      conn.on("chat.ack", (f) => {
        if (f.channel !== channel) return;
        this.outbox = this.outbox.filter((p) => p.clientMsgId !== f.clientMsgId);
        this.saveOutbox();
        this.emit();
      }),
      conn.on("chat.delta", (f) => {
        if (f.channel !== channel) return;
        const m = this.byId.get(f.id);
        if (!m || m.version >= f.version || m.body.length !== f.offset) return;
        this.replace({ ...m, body: m.body + f.text, version: f.version });
        this.emit();
      }),
      conn.on("chat.typing", (f) => {
        if (f.channel !== channel || f.user === this.owner) return;
        this.typingUntil.set(f.user, this.now() + 4000);
        this.emit();
      }),
      conn.on("chat.read", (f) => {
        if (f.channel !== channel) return;
        this.reads[f.user] = Math.max(this.reads[f.user] ?? 0, f.seq);
        this.emit();
      }),
    );
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): ChatSnapshot => this.snapshot;

  send(body: string, replyTo?: string): string {
    const p: Pending = { clientMsgId: newId(), body, createdAt: this.now() };
    if (replyTo) p.replyTo = replyTo;
    this.outbox.push(p);
    this.saveOutbox();
    this.conn.send({ t: "chat.send", channel: this.channel, ...p });
    this.emit();
    return p.clientMsgId;
  }

  edit(id: string, body: string): void {
    this.conn.send({ t: "chat.edit", channel: this.channel, id, body });
  }

  remove(id: string): void {
    this.conn.send({ t: "chat.delete", channel: this.channel, id });
  }

  markRead(): void {
    if (this.head > (this.reads[this.owner] ?? 0))
      this.conn.send({ t: "chat.read", channel: this.channel, seq: this.head });
  }

  typing(): void {
    const t = this.now();
    if (t - this.lastTypingSent < 2000) return;
    this.lastTypingSent = t;
    this.conn.send({ t: "chat.typing", channel: this.channel });
  }

  decide(messageId: string, choice: number | "dismiss" | "accept"): void {
    this.conn.send({ t: "proposal.decide", channel: this.channel, messageId, choice });
  }

  destroy(): void {
    for (const f of this.off) f();
    this.listeners.clear();
  }

  private flush() {
    for (const p of this.outbox) this.conn.send({ t: "chat.send", channel: this.channel, ...p });
  }

  private merge(m: Message) {
    const old = this.byId.get(m.id);
    if (old && old.version >= m.version) return;
    if (old) this.replace(m);
    else {
      this.byId.set(m.id, m);
      // Usually appends; a backlog can fill a hole, so insert in seq order.
      let i = this.ordered.length;
      while (i > 0 && this.ordered[i - 1]!.seq > m.seq) i--;
      this.ordered = [...this.ordered.slice(0, i), m, ...this.ordered.slice(i)];
    }
    if (m.clientMsgId && this.outbox.some((p) => p.clientMsgId === m.clientMsgId)) {
      this.outbox = this.outbox.filter((p) => p.clientMsgId !== m.clientMsgId);
      this.saveOutbox();
    }
  }

  private replace(m: Message) {
    this.byId.set(m.id, m);
    this.ordered = this.ordered.map((x) => (x.id === m.id ? m : x));
  }

  private advanceHead() {
    const seqs = new Set(this.ordered.map((m) => m.seq));
    while (seqs.has(this.head + 1)) this.head++;
  }

  private build(): ChatSnapshot {
    const t = this.now();
    const typing = [...this.typingUntil].filter(([, until]) => until > t).map(([u]) => u);
    return {
      messages: this.ordered,
      pending: this.outbox,
      head: this.head,
      loaded: this.loaded,
      typing,
      reads: { ...this.reads },
    };
  }

  private emit() {
    this.snapshot = this.build();
    for (const fn of this.listeners) fn();
  }

  private key() {
    return `anw.outbox.${this.owner}.${this.channel}`;
  }

  private loadOutbox(): Pending[] {
    try {
      const raw = this.storage.get(this.key());
      return raw ? (JSON.parse(raw) as Pending[]) : [];
    } catch {
      return [];
    }
  }

  private saveOutbox() {
    try {
      this.storage.set(this.key(), JSON.stringify(this.outbox));
    } catch {
      // Storage can be full or blocked; the outbox still lives in memory for this session.
    }
  }
}
