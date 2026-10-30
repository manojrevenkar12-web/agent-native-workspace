import { FRAGMENT, listSuggestions, plainText, SimulatedModel, sheetSuggestions } from "@anw/agent";
import { bindSheet, formatValue, sheetMaps } from "@anw/sheets";
import type { AgentState, MeetingProposal, ServerFrame, TaskProposal } from "@anw/sync";
import { Temporal } from "temporal-polyfill";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CALENDAR, type CalendarEvent, type TaskItem } from "../src/assistant.ts";
import { type Client, client, server, until } from "./harness.ts";

const opened: Client[] = [];
const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const c of opened.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.close();
});
const track = (c: Client) => {
  opened.push(c);
  return c;
};

function statuses(c: Client) {
  const seen: { runId: string; state: AgentState; detail?: string }[] = [];
  c.conn.on("agent.status", (f) => seen.push(f));
  return seen;
}

const encodeAnchor = (doc: Y.Doc, index: number) =>
  Buffer.from(
    Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(doc.getXmlFragment(FRAGMENT), index + 1, -1),
    ),
  ).toString("base64");

// Wednesday 4 November 2026, 10:00 Berlin.
const NOW = Date.parse("2026-11-04T09:00:00Z");

describe("drafting into a document", () => {
  it("streams a suggestion after the anchor while the agent shows up as a collaborator", async () => {
    const s = await server({ model: new SimulatedModel({ tokensPerSecond: 300, firstTokenMs: 0 }) });
    servers.push(s);
    const lena = track(client(s, "lena"));
    const maya = track(client(s, "maya"));
    const room = lena.room("doc:launch-brief");
    const other = maya.room("doc:launch-brief");
    await until(() => room.status === "synced" && other.status === "synced");
    let sawAgent = false;
    other.awareness.on("change", () => {
      for (const st of other.awareness.getStates().values())
        if ((st as { user?: { agent?: boolean } }).user?.agent) sawAgent = true;
    });
    const seen = statuses(lena);
    lena.conn.send({
      t: "agent.run",
      runId: "r1",
      task: {
        kind: "doc.draft",
        room: "doc:launch-brief",
        instruction: "Write a risks section",
        anchor: encodeAnchor(room.doc, 0),
      },
    });
    // Maya keeps typing in another paragraph while the agent writes.
    const p = (other.doc.getXmlFragment(FRAGMENT).get(1) as Y.XmlElement).get(0) as Y.XmlText;
    for (let i = 0; i < 10; i++) {
      p.insert(0, "m", { suggestion: null });
      await new Promise((r) => setTimeout(r, 20));
    }
    await until(() => seen.some((x) => x.state === "done"), 15_000, "draft done");
    await until(() => listSuggestions(other.doc).length === 1);
    expect(sawAgent).toBe(true);
    const [sug] = listSuggestions(other.doc);
    expect(sug!.author).toBe("assistant");
    const lines = plainText(other.doc).split("\n");
    expect(lines[0]).toBe("Launch brief");
    expect(lines[1]).toBe("Risks section");
    expect(plainText(other.doc)).toContain("mmmmmmmmmm");
  });

  it("yields when someone deletes what it is writing", async () => {
    const s = await server({ model: new SimulatedModel({ tokensPerSecond: 40, firstTokenMs: 0 }) });
    servers.push(s);
    const lena = track(client(s, "lena"));
    const room = lena.room("doc:retro");
    await until(() => room.status === "synced");
    const seen = statuses(lena);
    lena.conn.send({
      t: "agent.run",
      runId: "r2",
      task: { kind: "doc.draft", room: "doc:retro", instruction: "Write a summary" },
    });
    await until(() => (listSuggestions(room.doc)[0]?.chars ?? 0) > 20, 10_000, "some text");
    // Delete the agent's first block, as a person would select it and press backspace.
    const f = room.doc.getXmlFragment(FRAGMENT);
    const idx = f.toArray().findIndex((el) => (el as Y.XmlElement).getAttribute("suggestion"));
    f.delete(idx, 1);
    await until(() => seen.some((x) => x.state === "yielded"), 10_000, "yield");
    expect(seen.find((x) => x.state === "yielded")!.detail).toMatch(/stopped/);
  });

  it("refuses a viewer and a second run in the same room", async () => {
    const s = await server({ model: new SimulatedModel({ tokensPerSecond: 50, firstTokenMs: 0 }) });
    servers.push(s);
    const jonas = track(client(s, "jonas"));
    const lena = track(client(s, "lena"));
    await until(() => jonas.conn.status === "open" && lena.conn.status === "open");
    const js = statuses(jonas);
    const ls = statuses(lena);
    jonas.conn.send({
      t: "agent.run",
      runId: "v",
      task: { kind: "doc.draft", room: "doc:launch-brief", instruction: "x" },
    });
    lena.conn.send({
      t: "agent.run",
      runId: "a",
      task: { kind: "doc.draft", room: "doc:launch-brief", instruction: "x" },
    });
    lena.conn.send({
      t: "agent.run",
      runId: "b",
      task: { kind: "doc.draft", room: "doc:launch-brief", instruction: "x" },
    });
    await until(() => js.length > 0 && ls.some((x) => x.runId === "b" && x.state === "failed"));
    expect(js[0]!.state).toBe("failed");
    lena.conn.send({ t: "agent.cancel", runId: "a" });
    await until(() => ls.some((x) => x.runId === "a" && x.state === "cancelled"));
  });
});

describe("proposals from chat", () => {
  it("offers free slots, books one, and re-offers when the slot was taken", async () => {
    const s = await server({ now: () => NOW });
    servers.push(s);
    const lena = track(client(s, "lena"));
    const maya = track(client(s, "maya"));
    const ch = lena.channel("design");
    const mc = maya.channel("design");
    const cal = maya.room(CALENDAR);
    await until(() => ch.getSnapshot().loaded && mc.getSnapshot().loaded && cal.status === "synced");
    ch.send("Can we have a call tomorrow after 3pm about onboarding?");
    await until(() => mc.getSnapshot().messages.some((m) => m.proposal), 5000, "proposal");
    const msg = mc.getSnapshot().messages.find((m) => m.proposal)!;
    const p = msg.proposal as MeetingProposal;
    expect(p.title).toBe("Onboarding");
    expect(p.attendees.sort()).toEqual(["lena", "maya"]);
    expect(p.slots.length).toBeGreaterThan(0);
    for (const slot of p.slots) {
      const berlin = Temporal.Instant.from(slot.start).toZonedDateTimeISO("Europe/Berlin");
      const ny = Temporal.Instant.from(slot.start).toZonedDateTimeISO("America/New_York");
      expect(berlin.toPlainDate().toString()).toBe("2026-11-05");
      expect(berlin.hour).toBeGreaterThanOrEqual(15);
      expect(ny.hour).toBeGreaterThanOrEqual(9);
    }
    // Someone books the first slot directly in the calendar before Maya clicks it.
    const events = cal.doc.getMap<CalendarEvent>("events");
    events.set("clash", {
      id: "clash",
      title: "Clash",
      start: p.slots[0]!.start,
      end: p.slots[0]!.end,
      attendees: ["lena"],
      createdBy: "lena",
    });
    await until(() => [...s.rooms.get(CALENDAR).doc.getMap("events").keys()].includes("clash"));
    mc.decide(msg.id, 0);
    await until(
      () =>
        (mc.getSnapshot().messages.find((m) => m.id === msg.id)!.proposal as MeetingProposal).note !==
        undefined,
    );
    const again = mc.getSnapshot().messages.find((m) => m.id === msg.id)!.proposal as MeetingProposal;
    expect(again.status).toBe("open");
    expect(again.slots.every((x) => x.start !== p.slots[0]!.start)).toBe(true);
    mc.decide(msg.id, 0);
    await until(
      () =>
        (mc.getSnapshot().messages.find((m) => m.id === msg.id)!.proposal as MeetingProposal).status ===
        "booked",
    );
    await until(() => [...events.values()].some((e) => e.title === "Onboarding"));
    const booked = [...events.values()].find((e) => e.title === "Onboarding")!;
    expect(booked.start).toBe(again.slots[0]!.start);
  });

  it("turns a request into a task the assignee can add", async () => {
    const s = await server({ now: () => NOW });
    servers.push(s);
    const lena = track(client(s, "lena"));
    const arif = track(client(s, "arif"));
    const ch = lena.channel("launch");
    const ac = arif.channel("launch");
    await until(() => ch.getSnapshot().loaded && ac.getSnapshot().loaded);
    ch.send("@arif can you send the venue contract by Friday?");
    await until(() => ac.getSnapshot().messages.some((m) => m.proposal?.kind === "task"));
    const msg = ac.getSnapshot().messages.find((m) => m.proposal)!;
    const p = msg.proposal as TaskProposal;
    expect(p).toMatchObject({
      assignee: "arif",
      due: "2026-11-06",
      text: "Send the venue contract by Friday",
    });
    const maya = track(client(s, "maya"));
    const mc = maya.channel("launch");
    await until(() => mc.getSnapshot().loaded);
    const errors: ServerFrame[] = [];
    maya.conn.on("error", (e) => errors.push(e));
    mc.decide(msg.id, "accept");
    await until(() => errors.length > 0);
    ac.decide(msg.id, "accept");
    await until(
      () =>
        (ac.getSnapshot().messages.find((m) => m.id === msg.id)!.proposal as TaskProposal).status === "added",
    );
    const tasks = [...s.rooms.get(CALENDAR).doc.getMap<TaskItem>("tasks").values()];
    expect(tasks).toEqual([expect.objectContaining({ assignee: "arif", due: "2026-11-06", done: false })]);
  });

  it("leaves ordinary messages alone", async () => {
    const s = await server({ now: () => NOW });
    servers.push(s);
    const lena = track(client(s, "lena"));
    const ch = lena.channel("launch");
    await until(() => ch.getSnapshot().loaded);
    ch.send("The call yesterday went really well, thanks all");
    ch.send("Guten Morgen zusammen");
    await until(() => ch.getSnapshot().messages.length === 2);
    await new Promise((r) => setTimeout(r, 200));
    expect(ch.getSnapshot().messages.length).toBe(2);
  });
});

describe("assistant replies", () => {
  it("streams a reply that a reconnecting client picks up mid-stream", async () => {
    const s = await server({ model: new SimulatedModel({ tokensPerSecond: 60, firstTokenMs: 0 }) });
    servers.push(s);
    const lena = track(client(s, "lena"));
    const maya = track(client(s, "maya"));
    const ch = lena.channel("design");
    const mc = maya.channel("design");
    await until(() => ch.getSnapshot().loaded && mc.getSnapshot().loaded);
    ch.send("Onboarding screens are ready for review.");
    ch.send("@assistant can you summarise this thread?");
    const reply = () => mc.getSnapshot().messages.find((m) => m.author === "assistant");
    await until(() => (reply()?.body.length ?? 0) > 10, 10_000, "first tokens");
    expect(reply()!.status).toBe("streaming");
    maya.conn.drop();
    await until(() => reply()?.status === "complete", 15_000, "complete");
    const lenaView = ch.getSnapshot().messages.find((m) => m.author === "assistant")!;
    await until(() => ch.getSnapshot().messages.find((m) => m.author === "assistant")?.status === "complete");
    expect(reply()!.body).toBe(ch.getSnapshot().messages.find((m) => m.author === "assistant")!.body);
    expect(lenaView.body).toMatch(/^Here is where this thread stands/);
  });
});

describe("filling a sheet", () => {
  it("writes categories as pending suggestions and the totals follow", async () => {
    const s = await server({ model: new SimulatedModel({ tokensPerSecond: 500, firstTokenMs: 0 }) });
    servers.push(s);
    const lena = track(client(s, "lena"));
    const room = lena.room("sheet:budget");
    await until(() => room.status === "synced");
    const { engine } = bindSheet(room.doc, () => {});
    expect(formatValue(engine.get("H11"))).toBe(formatValue(engine.get("H10")));
    // Lena types one category herself while the fill runs; hers must survive.
    const seen = statuses(lena);
    lena.conn.send({
      t: "agent.run",
      runId: "f",
      task: {
        kind: "sheet.fill",
        room: "sheet:budget",
        sourceColumn: "A",
        targetColumn: "C",
        instruction: "Categorise into Travel, Venue, Food, Marketing, Software, People, Other",
        fromRow: 2,
        toRow: 21,
      },
    });
    sheetMaps(room.doc).cells.set("C21", "Other");
    await until(() => seen.some((x) => x.state === "done"), 10_000, "fill");
    await until(() => sheetMaps(room.doc).cells.get("C2") === "Travel");
    const { cells, pending } = sheetMaps(room.doc);
    expect(cells.get("C4")).toBe("Venue");
    expect(cells.get("C6")).toBe("Food");
    expect(cells.get("C8")).toBe("Marketing");
    expect(sheetSuggestions(room.doc)[0]!.cells).toBeGreaterThan(15);
    expect(pending.has("C21")).toBe(false);
    expect(Number(formatValue(engine.get("H11")))).toBeLessThan(Number(formatValue(engine.get("H10"))));
  });
});
