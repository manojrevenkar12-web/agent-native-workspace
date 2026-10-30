import { z } from "zod";

/**
 * One WebSocket per client carries every surface: Yjs sync and awareness for each open room,
 * the chat log, and agent runs. Frames are JSON; Yjs payloads are base64 so they survive JSON.
 */

export const Slot = z.object({ start: z.string(), end: z.string(), missing: z.array(z.string()).optional() });
export type Slot = z.infer<typeof Slot>;

export const MeetingProposal = z.object({
  kind: z.literal("meeting"),
  id: z.string(),
  sourceId: z.string(),
  title: z.string(),
  window: z.string(),
  durationMin: z.number().int().positive(),
  attendees: z.array(z.string()),
  slots: z.array(Slot),
  status: z.enum(["open", "booked", "dismissed", "stale"]),
  eventId: z.string().optional(),
  decidedBy: z.string().optional(),
  note: z.string().optional(),
});

export const TaskProposal = z.object({
  kind: z.literal("task"),
  id: z.string(),
  sourceId: z.string(),
  text: z.string(),
  assignee: z.string(),
  due: z.string().optional(),
  status: z.enum(["open", "added", "dismissed"]),
  taskId: z.string().optional(),
  decidedBy: z.string().optional(),
});

export const Proposal = z.discriminatedUnion("kind", [MeetingProposal, TaskProposal]);
export type Proposal = z.infer<typeof Proposal>;
export type MeetingProposal = z.infer<typeof MeetingProposal>;
export type TaskProposal = z.infer<typeof TaskProposal>;

export const Message = z.object({
  id: z.string(),
  seq: z.number().int().positive(),
  channel: z.string(),
  author: z.string(),
  body: z.string(),
  createdAt: z.number(),
  editedAt: z.number().optional(),
  deleted: z.boolean().optional(),
  status: z.enum(["complete", "streaming", "stopped"]),
  replyTo: z.string().optional(),
  clientMsgId: z.string().optional(),
  proposal: Proposal.optional(),
  /** Grows with every change to the message; clients keep the highest. */
  version: z.number().int().nonnegative(),
});
export type Message = z.infer<typeof Message>;

const room = z.string().min(1).max(120);
const channel = z.string().min(1).max(80);
const id = z.string().min(1).max(80);

export const AgentTask = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("doc.draft"),
    room,
    instruction: z.string().max(2000),
    /** Base64 Yjs relative position of the block the draft goes after. */
    anchor: z.string().optional(),
    /** Optional chat channel whose recent messages are the source material. */
    fromChannel: channel.optional(),
  }),
  z.object({
    kind: z.literal("sheet.fill"),
    room,
    sourceColumn: z.string().regex(/^[A-Z]{1,2}$/),
    targetColumn: z.string().regex(/^[A-Z]{1,2}$/),
    instruction: z.string().max(500),
    fromRow: z.number().int().positive(),
    toRow: z.number().int().positive(),
  }),
  z.object({ kind: z.literal("chat.reply"), channel, messageId: id }),
]);
export type AgentTask = z.infer<typeof AgentTask>;

export const ClientFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("join"), room }),
  z.object({ t: z.literal("leave"), room }),
  z.object({ t: z.literal("y"), room, m: z.string() }),
  z.object({ t: z.literal("chat.sub"), channel, after: z.number().int().nonnegative() }),
  z.object({
    t: z.literal("chat.send"),
    channel,
    clientMsgId: id,
    body: z.string().min(1).max(8000),
    replyTo: id.optional(),
  }),
  z.object({ t: z.literal("chat.edit"), channel, id, body: z.string().min(1).max(8000) }),
  z.object({ t: z.literal("chat.delete"), channel, id }),
  z.object({ t: z.literal("chat.read"), channel, seq: z.number().int().nonnegative() }),
  z.object({ t: z.literal("chat.typing"), channel }),
  z.object({
    t: z.literal("proposal.decide"),
    channel,
    messageId: id,
    choice: z.union([z.number().int().nonnegative(), z.literal("dismiss"), z.literal("accept")]),
  }),
  z.object({ t: z.literal("agent.run"), runId: id, task: AgentTask }),
  z.object({ t: z.literal("agent.cancel"), runId: id }),
  z.object({ t: z.literal("ping"), at: z.number() }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

export type AgentState = "queued" | "running" | "yielded" | "done" | "cancelled" | "failed";

export type ServerFrame =
  | { t: "welcome"; user: string; serverTime: number; connection: string }
  | { t: "joined"; room: string; role: "editor" | "viewer" }
  | { t: "denied"; room: string; reason: string }
  | { t: "y"; room: string; m: string }
  | { t: "chat.msg"; channel: string; msg: Message }
  | { t: "chat.ack"; channel: string; clientMsgId: string; seq: number; id: string }
  | { t: "chat.backlog"; channel: string; msgs: Message[]; head: number }
  | { t: "chat.delta"; channel: string; id: string; offset: number; text: string; version: number }
  | { t: "chat.typing"; channel: string; user: string }
  | { t: "chat.read"; channel: string; user: string; seq: number }
  | { t: "agent.status"; runId: string; state: AgentState; detail?: string; room?: string }
  | { t: "error"; code: string; message: string; ref?: string }
  | { t: "pong"; at: number };

export const encode = (f: ClientFrame | ServerFrame): string => JSON.stringify(f);

export function parseClientFrame(raw: string): ClientFrame | null {
  try {
    const r = ClientFrame.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
