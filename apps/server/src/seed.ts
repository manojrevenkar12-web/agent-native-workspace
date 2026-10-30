import { FRAGMENT } from "@anw/agent";
import { sheetMaps } from "@anw/sheets";
import { rooms } from "@anw/sync";
import { Temporal } from "temporal-polyfill";
import * as Y from "yjs";
import type { CalendarEvent } from "./assistant.ts";

type Block = ["h", string, number] | ["p", string] | ["ul", string[]];

function blocks(f: Y.XmlFragment, list: Block[]) {
  for (const b of list) {
    if (b[0] === "ul") {
      const ul = new Y.XmlElement("bulletList");
      ul.insert(
        0,
        b[1].map((t) => {
          const li = new Y.XmlElement("listItem");
          const p = new Y.XmlElement("paragraph");
          p.insert(0, [new Y.XmlText(t)]);
          li.insert(0, [p]);
          return li;
        }),
      );
      f.insert(f.length, [ul]);
      continue;
    }
    const el = new Y.XmlElement(b[0] === "h" ? "heading" : "paragraph");
    if (b[0] === "h") el.setAttribute("level", b[2] as unknown as string);
    el.insert(0, [new Y.XmlText(b[1])]);
    f.insert(f.length, [el]);
  }
}

const DOCS: Record<string, Block[]> = {
  "doc:launch-brief": [
    ["h", "Launch brief", 1],
    [
      "p",
      "Tandem goes live for the first 5,000 households on Friday. This brief is the one place for what we are shipping, who owns what, and how we will know it worked.",
    ],
    ["h", "What ships", 2],
    [
      "ul",
      [
        "Shared lists that sort themselves by what is due",
        "Reminders that come from the conversation, not from a form",
        "Weekly digest on Sunday evening",
      ],
    ],
    ["h", "Owners", 2],
    ["p", "Lena owns the launch plan, Arif the venue and partners, Maya the press list."],
  ],
  "doc:retro": [
    ["h", "Sprint retro", 1],
    ["h", "What went well", 2],
    [
      "ul",
      ["Real-time lists held up with 40 testers editing at once", "Design review moved to async comments"],
    ],
    ["h", "What to change", 2],
    ["ul", ["Calendar invites across three time zones took too many messages"]],
  ],
};

const NOTES: Record<string, string[][]> = {
  lena: [
    ["Groceries", "Oat milk, lemons, coffee beans", "Pick up parcel at the Späti"],
    ["Ideas for the digest", "Lead with what changed for the household this week", "Dentist Tue 10am"],
  ],
  arif: [["Venue checklist", "Confirm AV by Thursday", "Call the caterer tomorrow at 11:00"]],
  maya: [["Press", "Embargo lifts Friday 9am ET", "Draft quote for Lena"]],
  jonas: [["Reading", "Local-first software essay", "Peritext paper"]],
};

const BUDGET: [string, string, number, string][] = [
  ["Flights Berlin–KL for Arif", "Lufthansa", 1240, "arif"],
  ["Hotel near venue, 3 nights", "Motel One", 486, "arif"],
  ["Venue rent, main hall", "Kulturbrauerei", 4200, "lena"],
  ["AV and stage tech", "Kulturbrauerei", 1350, "lena"],
  ["Catering lunch for 80", "Kantine 3000", 1920, "lena"],
  ["Coffee bar all day", "The Barn", 640, "lena"],
  ["Social ads, launch week", "Meta", 2500, "maya"],
  ["Printed posters A1", "Flyerpilot", 380, "maya"],
  ["Press photographer", "Freelance", 900, "maya"],
  ["Swag: tote bags", "Spreadshirt", 760, "maya"],
  ["Train tickets for crew", "Deutsche Bahn", 312, "jonas"],
  ["Figma seats", "Figma", 180, "jonas"],
  ["Hosting for the beta", "AWS", 450, "jonas"],
  ["Taxi from airport", "FreeNow", 64, "arif"],
  ["Dinner with partners", "Nobelhart", 540, "arif"],
  ["Speaker fee, keynote", "Freelance", 1500, "lena"],
  ["Domain and email", "Hetzner", 36, "jonas"],
  ["Banner for stage", "Flyerpilot", 220, "maya"],
  ["Breakfast for volunteers", "Kantine 3000", 260, "lena"],
  ["Slack upgrade", "Slack", 96, "jonas"],
];

function seedDoc(name: string) {
  return (doc: Y.Doc) => blocks(doc.getXmlFragment(FRAGMENT), DOCS[name] ?? [["p", ""]]);
}

function seedNotes(user: string) {
  return (doc: Y.Doc) => {
    const list = doc.getArray<{ id: string; createdAt: number }>("list");
    (NOTES[user] ?? []).forEach((lines, i) => {
      const id = `n${i + 1}`;
      list.push([{ id, createdAt: Date.UTC(2026, 9, 20 + i) }]);
      blocks(doc.getXmlFragment(`note:${id}`), [
        ["h", lines[0]!, 1],
        ...lines.slice(1).map((l): Block => ["p", l]),
      ]);
    });
  };
}

function seedBudget(doc: Y.Doc) {
  const { cells } = sheetMaps(doc);
  ["Item", "Vendor", "Category", "Amount (EUR)", "Owner"].forEach((h, i) => {
    cells.set(`${"ABCDE"[i]}1`, h);
  });
  BUDGET.forEach(([item, vendor, amount, owner], i) => {
    const r = i + 2;
    cells.set(`A${r}`, item);
    cells.set(`B${r}`, vendor);
    cells.set(`D${r}`, String(amount));
    cells.set(`E${r}`, owner);
  });
  const last = BUDGET.length + 1;
  cells.set("G1", "Category");
  cells.set("H1", "Total");
  ["Travel", "Venue", "Food", "Marketing", "Software", "People", "Other"].forEach((c, i) => {
    cells.set(`G${i + 2}`, c);
    cells.set(`H${i + 2}`, `=SUMIF(C$2:C$${last},G${i + 2},D$2:D$${last})`);
  });
  cells.set("G10", "All");
  cells.set("H10", `=SUM(D2:D${last})`);
  cells.set("G11", "Not yet categorised");
  cells.set("H11", "=H10-SUM(H2:H8)");
}

/** 100,000 rows to prove the grid and the engine at size. */
export function seedLedger(doc: Y.Doc, rows = 100_000) {
  const { cells } = sheetMaps(doc);
  const words = ["Coffee", "Train", "Hosting", "Lunch", "Taxi", "Ads", "Licence", "Hotel", "Print", "Snacks"];
  cells.set("A1", "Date");
  cells.set("B1", "Description");
  cells.set("C1", "Amount");
  cells.set("E1", "Total");
  cells.set("E2", `=SUM(C2:C${rows + 1})`);
  let x = 2026;
  const start = Temporal.PlainDate.from("2026-01-01");
  for (let r = 2; r <= rows + 1; r++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    cells.set(`A${r}`, start.add({ days: Math.floor((r - 2) / 300) }).toString());
    cells.set(`B${r}`, `${words[x % words.length]} #${r - 1}`);
    cells.set(`C${r}`, String(((x >> 8) % 20000) / 100));
  }
}

/** A plausible week: standups, focus time and one-to-ones, in each person's own hours. */
function seedCalendar(doc: Y.Doc, now: number) {
  const events = doc.getMap<CalendarEvent>("events");
  const today = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO("Europe/Berlin").toPlainDate();
  const monday = today.subtract({ days: today.dayOfWeek - 1 });
  const at = (d: Temporal.PlainDate, time: string, tz: string, minutes: number) => {
    const s = d.toZonedDateTime({ timeZone: tz, plainTime: Temporal.PlainTime.from(time) });
    return { start: s.toInstant().toString(), end: s.add({ minutes }).toInstant().toString() };
  };
  let n = 0;
  const add = (title: string, attendees: string[], when: { start: string; end: string }) => {
    const id = `seed-${++n}`;
    events.set(id, { id, title, attendees, createdBy: attendees[0]!, ...when });
  };
  for (let w = 0; w < 2; w++)
    for (let i = 0; i < 5; i++) {
      const d = monday.add({ days: w * 7 + i });
      add("Standup", ["lena", "jonas"], at(d, "09:30", "Europe/Berlin", 15));
      add("Focus time", ["maya"], at(d, "09:00", "America/New_York", 120));
      add("Partner calls", ["arif"], at(d, "14:00", "Asia/Kuala_Lumpur", 90));
      if (i === 1) add("1:1 Lena / Jonas", ["lena", "jonas"], at(d, "15:00", "Europe/Berlin", 30));
      if (i === 3) add("Design review", ["lena", "maya"], at(d, "16:00", "Europe/Berlin", 45));
    }
}

export function seeds(room: string, now: number = Date.now()): ((doc: Y.Doc) => void) | undefined {
  const info = rooms[room];
  if (!info) return undefined;
  if (info.kind === "doc") return seedDoc(room);
  if (info.kind === "notes") return seedNotes(room.split(":")[1]!);
  if (room === "sheet:budget") return seedBudget;
  if (room === "sheet:ledger") return (d) => seedLedger(d);
  if (info.kind === "calendar") return (d) => seedCalendar(d, now);
  return undefined;
}

export const CHAT_SEED: Record<string, [string, string][]> = {
  launch: [
    ["lena", "Morning! Venue is confirmed for Friday, 80 seats."],
    ["arif", "Great. I land Thursday night, hotel is booked near the venue."],
    ["maya", "Press list is at 42 names. Embargo lifts Friday 9am New York time."],
    ["lena", "Let's go with the shorter keynote, 20 minutes, then demos."],
  ],
  design: [
    ["maya", "New onboarding screens are in the review doc."],
    ["lena", "Looks good. The empty state copy needs one more pass."],
  ],
  "arif-lena": [["arif", "Do you have the partner list handy?"]],
};
