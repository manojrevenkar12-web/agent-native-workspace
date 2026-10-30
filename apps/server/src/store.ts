import { DatabaseSync } from "node:sqlite";
import type { Message, Proposal } from "@anw/sync";

/**
 * Durable state in SQLite (node:sqlite, no native add-on): the update log and compacted
 * snapshot of every shared document, and the chat log. Every document change is written
 * before it is broadcast, so a restart loses nothing anyone has seen.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      pragma journal_mode = wal;
      pragma synchronous = normal;
      create table if not exists doc_updates (id integer primary key autoincrement, room text not null, data blob not null);
      create index if not exists doc_updates_room on doc_updates(room, id);
      create table if not exists doc_snapshots (room text primary key, data blob not null);
      create table if not exists messages (
        id text primary key, channel text not null, seq integer not null, author text not null, body text not null,
        created_at integer not null, edited_at integer, deleted integer not null default 0, status text not null,
        reply_to text, client_msg_id text, proposal text, version integer not null,
        unique (channel, seq), unique (channel, author, client_msg_id));
      create table if not exists reads (channel text not null, user text not null, seq integer not null, primary key (channel, user));
    `);
  }

  close(): void {
    this.db.close();
  }

  loadDoc(room: string): { snapshot: Uint8Array | null; updates: Uint8Array[] } {
    const snap = this.db.prepare("select data from doc_snapshots where room = ?").get(room) as
      | { data: Uint8Array }
      | undefined;
    const rows = this.db.prepare("select data from doc_updates where room = ? order by id").all(room) as {
      data: Uint8Array;
    }[];
    return {
      snapshot: snap ? new Uint8Array(snap.data) : null,
      updates: rows.map((r) => new Uint8Array(r.data)),
    };
  }

  appendUpdate(room: string, data: Uint8Array): number {
    this.db.prepare("insert into doc_updates (room, data) values (?, ?)").run(room, data);
    return (this.db.prepare("select count(*) n from doc_updates where room = ?").get(room) as { n: number })
      .n;
  }

  /** Replaces the log with one snapshot, atomically. */
  compact(room: string, snapshot: Uint8Array): void {
    this.db.exec("begin immediate");
    try {
      this.db
        .prepare(
          "insert into doc_snapshots (room, data) values (?, ?) on conflict(room) do update set data = excluded.data",
        )
        .run(room, snapshot);
      this.db.prepare("delete from doc_updates where room = ?").run(room);
      this.db.exec("commit");
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
  }

  byClientId(channel: string, author: string, clientMsgId: string): Message | null {
    const r = this.db
      .prepare("select * from messages where channel = ? and author = ? and client_msg_id = ?")
      .get(channel, author, clientMsgId);
    return r ? row(r) : null;
  }

  message(id: string): Message | null {
    const r = this.db.prepare("select * from messages where id = ?").get(id);
    return r ? row(r) : null;
  }

  /** Appends with the next seq in the channel; the unique keys make a retried send a no-op. */
  insert(m: Omit<Message, "seq">): Message {
    this.db.exec("begin immediate");
    try {
      const head = (
        this.db.prepare("select coalesce(max(seq), 0) s from messages where channel = ?").get(m.channel) as {
          s: number;
        }
      ).s;
      const msg: Message = { ...m, seq: head + 1 };
      this.db
        .prepare(
          "insert into messages (id, channel, seq, author, body, created_at, edited_at, deleted, status, reply_to, client_msg_id, proposal, version) values (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          msg.id,
          msg.channel,
          msg.seq,
          msg.author,
          msg.body,
          msg.createdAt,
          msg.editedAt ?? null,
          msg.deleted ? 1 : 0,
          msg.status,
          msg.replyTo ?? null,
          msg.clientMsgId ?? null,
          msg.proposal ? JSON.stringify(msg.proposal) : null,
          msg.version,
        );
      this.db.exec("commit");
      return msg;
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
  }

  update(m: Message): void {
    this.db
      .prepare(
        "update messages set body = ?, edited_at = ?, deleted = ?, status = ?, proposal = ?, version = ? where id = ?",
      )
      .run(
        m.body,
        m.editedAt ?? null,
        m.deleted ? 1 : 0,
        m.status,
        m.proposal ? JSON.stringify(m.proposal) : null,
        m.version,
        m.id,
      );
  }

  after(channel: string, seq: number, limit: number): Message[] {
    return this.db
      .prepare("select * from messages where channel = ? and seq > ? order by seq limit ?")
      .all(channel, seq, limit)
      .map(row);
  }

  recent(channel: string, limit: number): Message[] {
    return this.db
      .prepare("select * from messages where channel = ? order by seq desc limit ?")
      .all(channel, limit)
      .map(row)
      .reverse();
  }

  head(channel: string): number {
    return (
      this.db.prepare("select coalesce(max(seq), 0) s from messages where channel = ?").get(channel) as {
        s: number;
      }
    ).s;
  }

  read(channel: string, user: string, seq: number): number {
    this.db
      .prepare(
        "insert into reads (channel, user, seq) values (?, ?, ?) on conflict(channel, user) do update set seq = max(seq, excluded.seq)",
      )
      .run(channel, user, seq);
    return (
      this.db.prepare("select seq from reads where channel = ? and user = ?").get(channel, user) as {
        seq: number;
      }
    ).seq;
  }

  reads(channel: string): { user: string; seq: number }[] {
    return this.db.prepare("select user, seq from reads where channel = ?").all(channel) as {
      user: string;
      seq: number;
    }[];
  }
}

function row(r: unknown): Message {
  const x = r as Record<string, unknown>;
  const m: Message = {
    id: x.id as string,
    channel: x.channel as string,
    seq: Number(x.seq),
    author: x.author as string,
    body: x.body as string,
    createdAt: Number(x.created_at),
    status: x.status as Message["status"],
    version: Number(x.version),
  };
  if (x.edited_at != null) m.editedAt = Number(x.edited_at);
  if (x.deleted) m.deleted = true;
  if (x.reply_to != null) m.replyTo = x.reply_to as string;
  if (x.client_msg_id != null) m.clientMsgId = x.client_msg_id as string;
  if (x.proposal != null) m.proposal = JSON.parse(x.proposal as string) as Proposal;
  return m;
}
