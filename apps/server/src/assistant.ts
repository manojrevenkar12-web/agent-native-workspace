import { randomUUID } from "node:crypto";
import {
  type Attendee,
  extractIntent,
  findSlots,
  type Interval,
  type Model,
  SuggestionWriter,
  stillFree,
  suggestCells,
} from "@anw/agent";
import { sheetMaps } from "@anw/sheets";
import {
  type AgentState,
  type AgentTask,
  assistant,
  channelMembers,
  channels,
  config,
  dayParts,
  inChannel,
  type MeetingProposal,
  type Message,
  people,
  person,
  roleIn,
  type TaskProposal,
} from "@anw/sync";
import * as Y from "yjs";
import type { Chat } from "./chat.ts";
import type { Peer, Rooms } from "./rooms.ts";

export const CALENDAR = "calendar:team";

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
  createdBy: string;
  source?: string;
}

export interface TaskItem {
  id: string;
  text: string;
  assignee: string;
  due?: string;
  done: boolean;
  createdBy: string;
  source?: string;
}

const first = (id: string) => person(id).name.split(" ")[0]!;
const names = Object.fromEntries(
  people.map((p) => [p.id, [p.name.toLowerCase(), p.name.split(" ")[0]!.toLowerCase()]]),
);
const listNames = (ids: string[]) =>
  ids.length <= 1
    ? ids.map(first).join("")
    : `${ids.slice(0, -1).map(first).join(", ")} and ${first(ids.at(-1)!)}`;

/**
 * The assistant around the conversation: it notices meetings and tasks in chat and offers them
 * in place, drafts into documents and fills sheets as a peer, and replies when mentioned.
 * The model writes text; this class decides who may ask for what, when a meeting can happen,
 * and what gets written where.
 */
export class Assistant {
  private readonly runs = new Map<string, { abort: AbortController; owner: string; room: string }>();

  constructor(
    private readonly rooms: Rooms,
    private readonly chat: Chat,
    private readonly model: Model,
    private readonly now: () => number = Date.now,
    private readonly pace = config.agent,
  ) {}

  private calendar() {
    const doc = this.rooms.get(CALENDAR).doc;
    return { doc, events: doc.getMap<CalendarEvent>("events"), tasks: doc.getMap<TaskItem>("tasks") };
  }

  private attendees(ids: string[]): Attendee[] {
    const events = [...this.calendar().events.values()];
    return ids.map((id) => ({
      id,
      timeZone: person(id).timeZone,
      busy: events.filter((e) => e.attendees.includes(id)).map((e) => ({ start: e.start, end: e.end })),
    }));
  }

  private slots(attendees: string[], windows: Interval[], durationMin: number) {
    return findSlots({
      attendees: this.attendees(attendees),
      windows,
      durationMin,
      now: new Date(this.now()).toISOString(),
      stepMin: config.scheduling.slotStepMinutes,
      workingHours: config.scheduling.workingHours,
      bufferMin: config.scheduling.bufferMinutes,
      max: config.agent.proactive.maxSlotsOffered,
    });
  }

  /** Runs after every human message. */
  onMessage(m: Message): void {
    if (m.author === assistant.id) return;
    if (/@(assistant|ai)\b/i.test(m.body)) {
      void this.reply(m);
      return;
    }
    const channel = channels.find((c) => c.id === m.channel);
    const intent = extractIntent(m.body, {
      author: m.author,
      timeZone: person(m.author).timeZone,
      members: channelMembers(m.channel),
      names,
      now: new Date(this.now()).toISOString(),
      channelName: channel?.name ?? m.channel,
      dayParts,
      defaultDurationMin: config.scheduling.defaultDurationMinutes,
    });
    if (!intent || intent.confidence < config.agent.proactive.minConfidence) return;
    if (intent.kind === "meeting") {
      const slots = this.slots(intent.attendees, intent.windows, intent.durationMin);
      const proposal: MeetingProposal = {
        kind: "meeting",
        id: randomUUID(),
        sourceId: m.id,
        title: intent.title,
        window: intent.label,
        durationMin: intent.durationMin,
        attendees: intent.attendees,
        slots,
        status: "open",
      };
      const who = listNames(intent.attendees);
      let body: string;
      if (slots.length === 0) {
        body = `No time works for ${who} ${intent.label}.`;
        proposal.note = "Try a wider window, or ask me again with another day.";
      } else if (slots.some((s) => s.missing?.length)) {
        body = `${who} share no working hours ${intent.label}. These times leave one person out:`;
      } else {
        body = `Times that work for ${who}, ${intent.label}:`;
      }
      this.chat.post(m.channel, body, { replyTo: m.id, proposal });
    } else {
      const proposal: TaskProposal = {
        kind: "task",
        id: randomUUID(),
        sourceId: m.id,
        text: intent.text,
        assignee: intent.assignee,
        status: "open",
      };
      if (intent.due) proposal.due = intent.due;
      const whose = intent.assignee === m.author ? "your" : `${first(intent.assignee)}'s`;
      this.chat.post(m.channel, `Add this to ${whose} tasks?`, { replyTo: m.id, proposal });
    }
  }

  /** A person answers a proposal. Only attendees (or the assignee and writer) may. */
  decide(peer: Peer, channel: string, messageId: string, choice: number | "dismiss" | "accept"): void {
    const msg = this.chat.get(messageId);
    const p = msg?.proposal;
    if (!msg || !p || msg.channel !== channel || !inChannel(peer.user, channel)) {
      peer.send({
        t: "error",
        code: "no-proposal",
        message: "That suggestion no longer exists.",
        ref: messageId,
      });
      return;
    }
    if (p.status !== "open") return;
    if (choice === "dismiss") {
      this.chat.change(msg, { proposal: { ...p, status: "dismissed", decidedBy: peer.user } });
      return;
    }
    if (p.kind === "task") {
      const source = this.chat.get(p.sourceId);
      if (peer.user !== p.assignee && peer.user !== source?.author) {
        peer.send({
          t: "error",
          code: "not-yours",
          message: `Only ${first(p.assignee)} can add this task.`,
          ref: messageId,
        });
        return;
      }
      const task: TaskItem = {
        id: randomUUID(),
        text: p.text,
        assignee: p.assignee,
        done: false,
        createdBy: peer.user,
        source: p.sourceId,
      };
      if (p.due) task.due = p.due;
      const cal = this.calendar();
      cal.doc.transact(() => cal.tasks.set(task.id, task), "proposal");
      this.chat.change(msg, { proposal: { ...p, status: "added", taskId: task.id, decidedBy: peer.user } });
      return;
    }
    if (!p.attendees.includes(peer.user)) {
      peer.send({
        t: "error",
        code: "not-invited",
        message: "Only people in the meeting can book it.",
        ref: messageId,
      });
      return;
    }
    if (typeof choice !== "number" || !p.slots[choice]) return;
    const slot = p.slots[choice]!;
    if (!stillFree(slot, this.attendees(p.attendees.filter((a) => !slot.missing?.includes(a))))) {
      // The calendar changed since the offer: offer again rather than double-book.
      const windows = p.slots.map((s) => ({
        start: s.start,
        end: new Date(Date.parse(s.end) + 6 * 3_600_000).toISOString(),
      }));
      const fresh = this.slots(p.attendees, windows, p.durationMin);
      this.chat.change(msg, {
        proposal: { ...p, slots: fresh, note: "That time was just taken. Here are new options." },
      });
      return;
    }
    const event: CalendarEvent = {
      id: randomUUID(),
      title: p.title,
      start: slot.start,
      end: slot.end,
      attendees: p.attendees.filter((a) => !slot.missing?.includes(a)),
      createdBy: peer.user,
      source: p.sourceId,
    };
    const cal = this.calendar();
    cal.doc.transact(() => cal.events.set(event.id, event), "proposal");
    this.chat.change(msg, { proposal: { ...p, status: "booked", eventId: event.id, decidedBy: peer.user } });
  }

  cancel(peer: Peer, runId: string): void {
    const r = this.runs.get(runId);
    if (r && r.owner === peer.user) r.abort.abort(new Error("cancelled"));
  }

  private status(peer: Peer | null, runId: string, state: AgentState, detail?: string, room?: string) {
    peer?.send({ t: "agent.status", runId, state, ...(detail ? { detail } : {}), ...(room ? { room } : {}) });
  }

  async run(peer: Peer, runId: string, task: AgentTask): Promise<void> {
    const room = task.kind === "chat.reply" ? `chat:${task.channel}` : task.room;
    if (task.kind !== "chat.reply" && roleIn(peer.user, task.room) !== "editor") {
      this.status(peer, runId, "failed", "You can only ask the assistant to edit what you can edit.");
      return;
    }
    if ([...this.runs.values()].some((r) => r.room === room)) {
      this.status(
        peer,
        runId,
        "failed",
        "The assistant is already working here. Wait for it or stop it first.",
      );
      return;
    }
    const abort = new AbortController();
    this.runs.set(runId, { abort, owner: peer.user, room });
    this.status(peer, runId, "running", undefined, room);
    try {
      let result: { state: AgentState; detail?: string };
      if (task.kind === "doc.draft") result = await this.draft(peer, task, abort.signal);
      else if (task.kind === "sheet.fill") result = await this.fill(task, abort.signal);
      else {
        const m = this.chat.get(task.messageId);
        if (!m || !inChannel(peer.user, task.channel))
          result = { state: "failed", detail: "Message not found." };
        else result = await this.reply(m, abort.signal);
      }
      this.status(peer, runId, result.state, result.detail, room);
    } catch (e) {
      const cancelled = abort.signal.aborted;
      this.status(
        peer,
        runId,
        cancelled ? "cancelled" : "failed",
        cancelled ? "Stopped." : String((e as Error).message ?? e),
        room,
      );
    } finally {
      this.runs.delete(runId);
    }
  }

  private async draft(peer: Peer, task: Extract<AgentTask, { kind: "doc.draft" }>, signal: AbortSignal) {
    const r = this.rooms.get(task.room);
    const anchor = task.anchor
      ? Y.decodeRelativePosition(Uint8Array.from(Buffer.from(task.anchor, "base64")))
      : undefined;
    const writer = new SuggestionWriter(r.doc, { id: randomUUID(), author: assistant.id }, anchor);
    const context =
      task.fromChannel && inChannel(peer.user, task.fromChannel)
        ? this.chat.context(task.fromChannel, 30, (id) => person(id).name)
        : [];
    const presence = (status: string) => {
      const caret = writer.caret();
      const cursor = caret
        ? { anchor: Y.relativePositionToJSON(caret), head: Y.relativePositionToJSON(caret) }
        : null;
      r.awareness.setLocalState({
        user: { name: assistant.name, color: assistant.color, agent: true },
        status,
        requestedBy: peer.user,
        ...(cursor ? { cursor } : {}),
      });
    };
    presence("thinking");
    let last = Date.now();
    try {
      for await (const t of this.model.stream(
        { kind: "draft", instruction: task.instruction, context },
        signal,
      )) {
        writer.write(t);
        if (Date.now() - last >= this.pace.stream.flushEveryMs || t.includes("\n")) {
          writer.flush();
          last = Date.now();
          if (writer.yielded) break;
          presence("writing");
        }
      }
      if (!writer.yielded && !signal.aborted) writer.finish();
    } finally {
      r.awareness.setLocalState(null);
    }
    if (signal.aborted)
      return { state: "cancelled" as const, detail: "Stopped. What was written is waiting for review." };
    if (writer.yielded)
      return {
        state: "yielded" as const,
        detail: "You changed the draft while I was writing, so I stopped. The rest is yours.",
      };
    return { state: "done" as const, detail: `Suggested ${writer.chars} characters for review.` };
  }

  private async fill(task: Extract<AgentTask, { kind: "sheet.fill" }>, signal: AbortSignal) {
    const doc = this.rooms.get(task.room).doc;
    const { cells, pending } = sheetMaps(doc);
    const id = randomUUID();
    const rows: number[] = [];
    const items: string[] = [];
    for (let r = task.fromRow; r <= task.toRow; r++) {
      const v = cells.get(`${task.sourceColumn}${r}`);
      if (v) {
        rows.push(r);
        items.push(v);
      }
    }
    let line = "";
    let i = 0;
    let batch: [string, string][] = [];
    let skipped = 0;
    const push = () => {
      if (!batch.length) return;
      suggestCells(doc, id, batch);
      batch = [];
    };
    for await (const t of this.model.stream(
      { kind: "classify", instruction: task.instruction, items },
      signal,
    )) {
      line += t;
      let nl = line.indexOf("\n");
      while (nl >= 0 && i < rows.length) {
        const label = line.slice(0, nl).trim();
        line = line.slice(nl + 1);
        const k = `${task.targetColumn}${rows[i]}`;
        i++;
        // The assistant fills blanks. A value someone typed, before or during the run, wins.
        if ((cells.get(k) ?? "") !== "" && pending.get(k)?.id !== id) skipped++;
        else batch.push([k, label]);
        if (batch.length >= this.pace.sheets.rowsPerFlush) push();
        nl = line.indexOf("\n");
      }
    }
    push();
    if (signal.aborted) return { state: "cancelled" as const, detail: `Stopped after ${i} rows.` };
    return {
      state: "done" as const,
      detail: `Filled ${i - skipped} cells for review${skipped ? `, left ${skipped} that already had a value` : ""}.`,
    };
  }

  private async reply(m: Message, signal?: AbortSignal): Promise<{ state: AgentState; detail?: string }> {
    const out = this.chat.post(m.channel, "", { replyTo: m.id, streaming: true });
    let buffer = "";
    let last = Date.now();
    try {
      const question = m.body.replace(/@(assistant|ai)\b/gi, "").trim();
      const context = this.chat.context(m.channel, 20, (id) => person(id).name);
      for await (const t of this.model.stream({ kind: "reply", question, context }, signal)) {
        buffer += t;
        if (Date.now() - last >= this.pace.chat.flushEveryMs) {
          this.chat.delta(out.id, buffer);
          buffer = "";
          last = Date.now();
        }
      }
      this.chat.delta(out.id, buffer);
      this.chat.finish(out.id, "complete");
      return { state: "done" };
    } catch (e) {
      this.chat.delta(out.id, buffer);
      this.chat.finish(out.id, "stopped");
      throw e;
    }
  }
}
