import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import {
  extractIntent,
  findSlots,
  type IntentContext,
  type MeetingIntent,
  stillFree,
  type TaskIntent,
} from "../src/index.ts";

// Wednesday 4 November 2026, 10:00 in Berlin.
const NOW = "2026-11-04T09:00:00Z";
const ctx = (over: Partial<IntentContext> = {}): IntentContext => ({
  author: "lena",
  timeZone: "Europe/Berlin",
  members: ["lena", "arif", "maya"],
  names: { lena: ["lena hoffmann"], arif: ["arif rahman"], maya: ["maya okafor"] },
  now: NOW,
  channelName: "launch-plan",
  dayParts: {
    morning: ["09:00", "12:00"],
    lunch: ["12:00", "14:00"],
    afternoon: ["13:00", "18:00"],
    evening: ["17:00", "20:00"],
  },
  defaultDurationMin: 30,
  ...over,
});

const local = (iso: string, tz = "Europe/Berlin") =>
  Temporal.Instant.from(iso).toZonedDateTimeISO(tz).toPlainDateTime().toString().slice(0, 16);

const meeting = (text: string, c = ctx()) => {
  const i = extractIntent(text, c);
  expect(i?.kind, text).toBe("meeting");
  return i as MeetingIntent;
};
const task = (text: string, c = ctx()) => {
  const i = extractIntent(text, c);
  expect(i?.kind, text).toBe("task");
  return i as TaskIntent;
};

describe("meetings in English and German", () => {
  it("reads a weekday with 'after'", () => {
    const m = meeting("Can we have a quick call Thursday after 3pm?");
    expect(m.durationMin).toBe(15);
    expect(m.windows).toHaveLength(1);
    expect(local(m.windows[0]!.start)).toBe("2026-11-05T15:00");
    expect(m.label).toBe("Thu 5 Nov, after 15:00");
    expect(m.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("reads German day parts and 'nächste Woche'", () => {
    const m = meeting("Lass uns nächste Woche vormittags kurz telefonieren");
    expect(m.windows).toHaveLength(5);
    expect(local(m.windows[0]!.start)).toBe("2026-11-09T09:00");
    expect(local(m.windows[0]!.end)).toBe("2026-11-09T12:00");
  });

  it("reads 'morgen um 14 Uhr' as tomorrow at 14:00 and a duration", () => {
    const m = meeting("Können wir morgen um 14 Uhr eine Stunde zum Budget sprechen? Termin?");
    expect(m.exact).toBe(true);
    expect(m.durationMin).toBe(60);
    expect(local(m.windows[0]!.start)).toBe("2026-11-05T14:00");
    expect(m.title).toBe("Budget sprechen");
  });

  it("does not take 'Guten Morgen' for tomorrow", () => {
    expect(extractIntent("Guten Morgen zusammen!", ctx())).toBeNull();
  });

  it("uses the writer's time zone", () => {
    const m = meeting("let's sync tomorrow at 9am", ctx({ author: "maya", timeZone: "America/New_York" }));
    expect(local(m.windows[0]!.start, "America/New_York")).toBe("2026-11-05T09:00");
    expect(m.windows[0]!.start).toBe("2026-11-05T14:00:00Z");
  });

  it("reads dates written as 12.11. and 'Nov 12th'", () => {
    expect(local(meeting("Termin am 12.11. um 10:30?").windows[0]!.start)).toBe("2026-11-12T10:30");
    expect(local(meeting("Can we meet Nov 12th at 10:30?").windows[0]!.start)).toBe("2026-11-12T10:30");
  });

  it("finds the topic after a day named with 'on'", () => {
    expect(meeting("Can we have a call on Wednesday after 3pm about onboarding?").title).toBe("Onboarding");
  });

  it("invites only the people mentioned, plus the writer", () => {
    expect(meeting("@arif can we do a call tomorrow afternoon?").attendees.sort()).toEqual(["arif", "lena"]);
  });

  it.each([
    "The call yesterday went well",
    "Wir hatten gestern ein gutes Meeting",
    "When is the meeting tomorrow?",
    "Let's cancel the call on Friday",
    "Thanks, that works",
    "The meeting notes are in the doc",
  ])("leaves %s alone", (text) => {
    const i = extractIntent(text, ctx());
    expect(i === null || i.confidence < 0.6).toBe(true);
  });
});

describe("tasks", () => {
  it("assigns a request to the person mentioned, with a due date", () => {
    const t = task("@arif can you send the venue contract by Friday?");
    expect(t.assignee).toBe("arif");
    expect(t.due).toBe("2026-11-06");
    expect(t.text).toBe("Send the venue contract by Friday");
  });

  it("assigns to the other person in a direct conversation", () => {
    const t = task(
      "Kannst du bitte die Präsentation bis morgen schicken?",
      ctx({ members: ["lena", "arif"] }),
    );
    expect(t.assignee).toBe("arif");
    expect(t.due).toBe("2026-11-05");
  });

  it("takes 'I'll' as a task for the writer", () => {
    expect(task("I'll update the budget sheet today").assignee).toBe("lena");
  });

  it("does not guess an assignee in a group without a mention", () => {
    expect(extractIntent("Can you send the deck?", ctx())).toBeNull();
  });

  it("treats 'can you set up a call' as a meeting", () => {
    meeting("@maya can you set up a call with the venue tomorrow?");
  });
});

describe("notes", () => {
  it("finds an appointment in a note line", () => {
    const m = meeting("Dentist Tue 10am", ctx({ mode: "note", members: ["lena"] }));
    expect(local(m.windows[0]!.start)).toBe("2026-11-10T10:00");
  });
});

describe("scheduler", () => {
  const wh = { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] };
  const lena = { id: "lena", timeZone: "Europe/Berlin", busy: [] };
  const maya = { id: "maya", timeZone: "America/New_York", busy: [] };
  const arif = { id: "arif", timeZone: "Asia/Kuala_Lumpur", busy: [] };
  const day = (d: string) => [{ start: `${d}T00:00:00Z`, end: `${d}T23:59:00Z` }];

  it("follows each city's own daylight-saving change", () => {
    // 28 Oct: Berlin is back on winter time, New York is not yet: overlap starts 13:00 UTC.
    const oct = findSlots({
      attendees: [lena, maya],
      windows: day("2026-10-28"),
      durationMin: 30,
      now: "2026-10-27T00:00:00Z",
      stepMin: 30,
      workingHours: wh,
    });
    expect(oct[0]!.start).toBe("2026-10-28T13:00:00Z");
    // 4 Nov: both on winter time, the overlap starts an hour later in UTC.
    const nov = findSlots({
      attendees: [lena, maya],
      windows: day("2026-11-04"),
      durationMin: 30,
      now: "2026-11-03T00:00:00Z",
      stepMin: 30,
      workingHours: wh,
    });
    expect(nov[0]!.start).toBe("2026-11-04T14:00:00Z");
  });

  it("skips busy time and spreads the choices", () => {
    const busy = { ...lena, busy: [{ start: "2026-11-04T14:00:00Z", end: "2026-11-04T15:00:00Z" }] };
    const slots = findSlots({
      attendees: [busy, maya],
      windows: day("2026-11-04"),
      durationMin: 30,
      now: "2026-11-03T00:00:00Z",
      stepMin: 30,
      workingHours: wh,
    });
    expect(slots.map((s) => s.start)).toEqual(["2026-11-04T15:00:00Z"]);
    expect(slots[0]!.missing).toEqual([]);
    expect(stillFree(slots[0]!, [busy, maya])).toBe(true);
    expect(stillFree({ start: "2026-11-04T14:30:00Z", end: "2026-11-04T15:00:00Z" }, [busy])).toBe(false);
  });

  it("says who is left out when three time zones share no working hours", () => {
    const slots = findSlots({
      attendees: [lena, maya, arif],
      windows: [{ start: "2026-11-04T00:00:00Z", end: "2026-11-05T23:59:00Z" }],
      durationMin: 30,
      now: "2026-11-03T00:00:00Z",
      stepMin: 30,
      workingHours: wh,
    });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) expect(s.missing).toHaveLength(1);
  });

  it("never offers a slot in the past", () => {
    const slots = findSlots({
      attendees: [lena],
      windows: day("2026-11-04"),
      durationMin: 30,
      now: NOW,
      stepMin: 30,
      workingHours: wh,
    });
    expect(Temporal.Instant.compare(slots[0]!.start, NOW)).toBeGreaterThanOrEqual(0);
  });
});
