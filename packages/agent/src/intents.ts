import { Temporal } from "temporal-polyfill";

/**
 * Finds what a chat message (or a line in a note) asks to happen: a meeting to schedule or a
 * task for someone. Rules, in English and German, read the message; they never decide when the
 * meeting is, only what window the writer meant. The scheduler decides the slot from calendars.
 */

export interface IntentContext {
  author: string;
  timeZone: string;
  /** Members of the conversation, the author included. */
  members: string[];
  /** id → names people use for them ("lena", "lena hoffmann"). */
  names: Record<string, string[]>;
  now: string;
  channelName?: string;
  mode?: "chat" | "note";
  dayParts: Record<string, [string, string]>;
  defaultDurationMin: number;
  /** Days to look ahead when the message names no day. */
  openDays?: number;
}

export interface Interval {
  start: string;
  end: string;
}

export interface MeetingIntent {
  kind: "meeting";
  confidence: number;
  title: string;
  durationMin: number;
  /** Where the meeting may start and end, in instants (the author's local reading). */
  windows: Interval[];
  /** True if the writer named an exact start time. */
  exact: boolean;
  label: string;
  attendees: string[];
}

export interface TaskIntent {
  kind: "task";
  confidence: number;
  text: string;
  assignee: string;
  due?: string;
  label: string;
}

export type Intent = MeetingIntent | TaskIntent;

const WEEKDAYS: Record<string, number> = {
  monday: 1,
  mon: 1,
  montag: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  dienstag: 2,
  wednesday: 3,
  wed: 3,
  mittwoch: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  donnerstag: 4,
  friday: 5,
  fri: 5,
  freitag: 5,
  saturday: 6,
  sat: 6,
  samstag: 6,
  sunday: 7,
  sun: 7,
  sonntag: 7,
};
const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  januar: 1,
  feb: 2,
  february: 2,
  februar: 2,
  mar: 3,
  march: 3,
  märz: 3,
  maerz: 3,
  apr: 4,
  april: 4,
  may: 5,
  mai: 5,
  jun: 6,
  june: 6,
  juni: 6,
  jul: 7,
  july: 7,
  juli: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  okt: 10,
  oktober: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
  dez: 12,
  dezember: 12,
};
const SHORT_DAY = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SHORT_MONTH = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const MEETING_NOUN =
  /\b(meet|meeting|call|calls|sync|catch[ -]?up|demo|walkthrough|walk-through|review session|standup|stand-up|1:1|one-on-one|huddle|hop on|jump on|get together|treffen|termin|besprechung|telefonat|telefonieren|abstimmen|abstimmung|zusammensetzen|meeten|kurzer call|videocall|jour fixe)\b/;
const PROPOSE =
  /\b(let'?s|lets|can we|could we|shall we|should we|are you free|is everyone free|anyone free|everyone free|are you around|do you have time|have time|got time|free for|time for|wanna|want to|need to|we should|how about|what about|lass uns|lasst uns|können wir|koennen wir|könnten wir|sollen wir|sollten wir|wollen wir|hast du zeit|habt ihr zeit|hättest du zeit|haettest du zeit|hättet ihr zeit|passt es|passt (?:dir|euch)|wann passt|wie wäre es|wie waere es|wie sieht es aus|bist du frei|seid ihr frei)\b/;
const PAST_OR_OFF =
  /\b(yesterday|gestern|last week|letzte woche|letzten|earlier today|heute früh war|was great|was good|went well|we met|met with|had a call|had the|hatten|war gut|war super|cancel|cancelled|canceled|call off|absagen|abgesagt|no need|kein bedarf|nicht nötig|nicht noetig|moved to|verschoben|already booked|schon gebucht|recording|notes from|protokoll)\b/;
const ASKS_EXISTING =
  /\b(when is|where is|what time is|is the .* still|wann ist|wo ist|um wie viel uhr ist|findet .* statt|link (?:for|to|zum|für)|agenda)\b/;
const REQUEST =
  /\b(can you|could you|would you|will you|please|pls|plz|kannst du|könntest du|koenntest du|würdest du|wuerdest du|kannst du bitte|bitte)\b/;
const SELF =
  /\b(i'?ll|i will|i can take|i'?m on it|i am on it|let me|ich werde|ich schicke|ich schick|ich kümmere mich|ich kuemmere mich|ich übernehme|ich uebernehme|mach ich|ich mache)\b/;
const ACTION =
  /\b(send|share|update|review|write|draft|check|fix|prepare|book|order|finish|upload|forward|sign|approve|merge|deploy|ship|test|call|email|ping|schick\w*|send\w*|teil\w*|aktualisier\w*|prüf\w*|pruef\w*|schreib\w*|erstell\w*|vorbereit\w*|bereite\w*|buch\w*|bestell\w*|fertig\w*|überarbeit\w*|ueberarbeit\w*|hochladen|lad\w* .* hoch|freigeben|unterschreib\w*|anruf\w*|ruf\w* .* an)\b/;

interface TimeOfDay {
  from?: string;
  to?: string;
  exact?: string;
  part?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

function hhmm(h: number, m: number): string | null {
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${pad(h)}:${pad(m)}`;
}

/** "3pm", "15:30", "15 uhr", "3" (after "at"/"um"): a 24h time, guessing pm for 1–7. */
function readTime(h: string, m: string | undefined, suffix: string | undefined): string | null {
  let hour = Number(h);
  const min = m ? Number(m) : 0;
  const s = suffix?.replace(/\./g, "");
  if (s === "pm" && hour < 12) hour += 12;
  else if (s === "am" && hour === 12) hour = 0;
  // "after 3", "um 3 Uhr": in working life a bare 1–7 is afternoon.
  else if (s !== "am" && s !== "pm" && !m && hour >= 1 && hour <= 7) hour += 12;
  return hhmm(hour, min);
}

const TIME = String.raw`(\d{1,2})(?:[:.](\d{2}))?\s?(am|pm|a\.m\.|p\.m\.|uhr|h)?`;

function timeOfDay(s: string): TimeOfDay {
  const out: TimeOfDay = {};
  const between = new RegExp(
    String.raw`\b(?:between|zwischen|von)\s+${TIME}\s*(?:and|und|-|–|bis)\s*${TIME}`,
  ).exec(s);
  if (between) {
    const to = readTime(between[4]!, between[5], between[6] ?? between[3]);
    const from = readTime(between[1]!, between[2], between[3] ?? between[6]);
    if (from) out.from = from;
    if (to) out.to = to;
  }
  const after = new RegExp(
    String.raw`\b(?:after|from|ab|nach|later than|frühestens|fruehestens)\s+${TIME}`,
  ).exec(s);
  if (after && !out.from) {
    const t = readTime(after[1]!, after[2], after[3]);
    if (t) out.from = t;
  }
  const before = new RegExp(
    String.raw`\b(?:before|until|till|by|vor|bis|spätestens|spaetestens)\s+${TIME}`,
  ).exec(s);
  if (before && !out.to) {
    const t = readTime(before[1]!, before[2], before[3]);
    if (t && (before[2] || before[3])) out.to = t;
  }
  if (!out.from && !out.to) {
    const at = new RegExp(String.raw`\b(?:at|um|gegen|around|@)\s+${TIME}`).exec(s);
    const bare = /(?<![\d.])(\d{1,2})(?:[:](\d{2}))\b|(?<![\d.])(\d{1,2})\s?(am|pm|uhr)\b/.exec(s);
    if (at) {
      const t = readTime(at[1]!, at[2], at[3]);
      if (t) out.exact = t;
    } else if (bare) {
      const t = bare[1] ? readTime(bare[1], bare[2], undefined) : readTime(bare[3]!, undefined, bare[4]);
      if (t) out.exact = t;
    }
  }
  if (/\b(morning|vormittag|vormittags|morgens|früh|frueh|am morgen)\b/.test(s)) out.part = "morning";
  else if (/\b(lunch|mittag|mittags|mittagspause)\b/.test(s)) out.part = "lunch";
  else if (/\b(afternoon|nachmittag|nachmittags)\b/.test(s)) out.part = "afternoon";
  else if (/\b(evening|tonight|abend|abends|heute abend)\b/.test(s)) out.part = "evening";
  return out;
}

function duration(s: string, fallback: number): { min: number; said: boolean } {
  let m = /(\d+)\s?(?:min|mins|minutes|minuten|minute)\b/.exec(s);
  if (m) return { min: Number(m[1]), said: true };
  m = /(\d+(?:[.,]5)?)\s?(?:h|hr|hrs|hour|hours|stunde|stunden|std)\b/.exec(s);
  if (m) return { min: Math.round(Number(m[1]!.replace(",", ".")) * 60), said: true };
  if (/\b(half an hour|half-hour|halbe stunde|halbes stündchen)\b/.test(s)) return { min: 30, said: true };
  if (/\b(an hour|one hour|eine stunde|1 stunde)\b/.test(s)) return { min: 60, said: true };
  if (/\b(quick|short|brief|kurz|kurzen|kurzes|kurze)\b/.test(s)) return { min: 15, said: true };
  return { min: fallback, said: false };
}

/** Local dates the text names, in the author's calendar. */
function days(s: string, today: Temporal.PlainDate): { dates: Temporal.PlainDate[]; said: boolean } {
  const add = (n: number) => today.add({ days: n });
  const out: Temporal.PlainDate[] = [];
  const weekdaysFrom = (start: Temporal.PlainDate, end: Temporal.PlainDate) => {
    const r: Temporal.PlainDate[] = [];
    for (let d = start; Temporal.PlainDate.compare(d, end) <= 0; d = d.add({ days: 1 }))
      if (d.dayOfWeek <= 5) r.push(d);
    return r;
  };
  if (/\b(übermorgen|uebermorgen|day after tomorrow)\b/.test(s)) out.push(add(2));
  else if (/\b(tomorrow|tmrw|tmr|morgen)\b/.test(s)) out.push(add(1));
  if (/\b(today|heute|this afternoon|this morning|tonight|later today|eod)\b/.test(s)) out.push(today);
  if (/\b(next week|nächste woche|naechste woche|nächster woche|kommende woche|kommenden woche)\b/.test(s)) {
    const mon = today.add({ days: 8 - today.dayOfWeek });
    out.push(...weekdaysFrom(mon, mon.add({ days: 4 })));
  }
  if (/\b(this week|diese woche|dieser woche|later this week|noch diese woche)\b/.test(s)) {
    out.push(...weekdaysFrom(today, today.add({ days: Math.max(0, 5 - today.dayOfWeek) })));
  }
  if (/\b(end of (?:the )?week|ende der woche|ende dieser woche)\b/.test(s)) {
    const fri = today.add({ days: Math.max(0, 5 - today.dayOfWeek) });
    out.push(
      ...weekdaysFrom(
        Temporal.PlainDate.compare(fri.subtract({ days: 1 }), today) >= 0 ? fri.subtract({ days: 1 }) : today,
        fri,
      ),
    );
  }
  const wd = new RegExp(
    String.raw`\b(this |next |coming |diesen |diesem |nächsten |naechsten |kommenden |am )?(${Object.keys(WEEKDAYS).join("|")})\b`,
    "g",
  );
  for (const m of s.matchAll(wd)) {
    const want = WEEKDAYS[m[2]!]!;
    let delta = (want - today.dayOfWeek + 7) % 7;
    const mod = (m[1] ?? "").trim();
    if (delta === 0 && mod !== "this" && mod !== "diesen" && mod !== "diesem") delta = 7;
    if ((mod === "next" || mod === "nächsten" || mod === "naechsten") && delta === 0) delta = 7;
    out.push(add(delta));
  }
  const iso = /\b(20\d\d)-(\d\d)-(\d\d)\b/.exec(s);
  if (iso) out.push(Temporal.PlainDate.from({ year: +iso[1]!, month: +iso[2]!, day: +iso[3]! }));
  const dotted = /(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{2,4})?(?![\d])/.exec(s);
  if (dotted) {
    const month = +dotted[2]!;
    const day = +dotted[1]!;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let year = dotted[3] ? +dotted[3] : today.year;
      if (year < 100) year += 2000;
      let d = Temporal.PlainDate.from({ year, month, day }, { overflow: "constrain" });
      if (!dotted[3] && Temporal.PlainDate.compare(d, today) < 0) d = d.add({ years: 1 });
      out.push(d);
    }
  }
  const monthNames = Object.keys(MONTHS).join("|");
  const named =
    new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th|\.)?\s+(?:of\s+)?(${monthNames})\b`).exec(s) ??
    new RegExp(String.raw`\b(${monthNames})\s+(\d{1,2})(?:st|nd|rd|th)?\b`).exec(s);
  if (named) {
    const [a, b] = [named[1]!, named[2]!];
    const day = /^\d/.test(a) ? +a : +b;
    const month = MONTHS[/^\d/.test(a) ? b : a]!;
    let d = Temporal.PlainDate.from({ year: today.year, month, day }, { overflow: "constrain" });
    if (Temporal.PlainDate.compare(d, today) < 0) d = d.add({ years: 1 });
    out.push(d);
  }
  const unique = [...new Map(out.map((d) => [d.toString(), d])).values()].sort(Temporal.PlainDate.compare);
  return { dates: unique.filter((d) => Temporal.PlainDate.compare(d, today) >= 0), said: unique.length > 0 };
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\bguten morgen\b|\bgood morning\b|\bmoin\b/g, " ")
    .replace(/\bmorgen (früh|frueh|vormittag)\b/g, "tomorrow morning")
    .replace(/\bmorgen (nachmittag)\b/g, "tomorrow afternoon")
    .replace(/\bmorgen (abend)\b/g, "tomorrow evening")
    .replace(/\s+/g, " ");
}

function mentioned(text: string, ctx: IntentContext): string[] {
  const s = text.toLowerCase();
  const out: string[] = [];
  for (const id of ctx.members) {
    const names = [id, ...(ctx.names[id] ?? [])];
    if (names.some((n) => new RegExp(String.raw`@${n.split(" ")[0]}\b`).test(s))) out.push(id);
  }
  return out;
}

function topic(text: string): string | null {
  const m =
    /\b(?:about|on|re:?|regarding|for|zu|zum|zur|wegen|über|ueber|bzgl\.?|bezüglich)\s+(?:the |our |unser\w* |den |die |das |dem )?([\p{L}\d][\p{L}\d&/\- ]{2,40})/iu.exec(
      text,
    );
  if (!m) return null;
  const stop =
    /^(today|tomorrow|next|this|on|at|after|before|between|by|morning|afternoon|monday|tuesday|wednesday|thursday|friday|heute|morgen|nächste|diese|am|um|ab|nach|vor|bis|montag|dienstag|mittwoch|donnerstag|freitag|for|für|with|mit|\d.*)$/i;
  const words = m[1]!.split(/\s+/);
  const kept: string[] = [];
  for (const w of words) {
    if (stop.test(w.replace(/[?!.,;:]+$/, "")) || kept.length >= 5) break;
    kept.push(w.replace(/[?!.,;:]+$/, ""));
  }
  const t = kept.join(" ").trim();
  return t.length >= 3 ? t.charAt(0).toUpperCase() + t.slice(1) : null;
}

function describe(dates: Temporal.PlainDate[], said: boolean, tod: TimeOfDay): string {
  const d = !said
    ? "the next few working days"
    : dates.length === 1
      ? `${SHORT_DAY[dates[0]!.dayOfWeek]} ${dates[0]!.day} ${SHORT_MONTH[dates[0]!.month]}`
      : `${SHORT_DAY[dates[0]!.dayOfWeek]} ${dates[0]!.day} ${SHORT_MONTH[dates[0]!.month]} – ${SHORT_DAY[dates.at(-1)!.dayOfWeek]} ${dates.at(-1)!.day} ${SHORT_MONTH[dates.at(-1)!.month]}`;
  const t = tod.exact
    ? `at ${tod.exact}`
    : tod.from && tod.to
      ? `between ${tod.from} and ${tod.to}`
      : tod.from
        ? `after ${tod.from}`
        : tod.to
          ? `before ${tod.to}`
          : tod.part
            ? `in the ${tod.part}`
            : "";
  return t ? `${d}, ${t}` : d;
}

function cleanTask(text: string): string {
  let t = text
    .replace(/@\w+[,:]?\s*/g, "")
    .replace(/^(hey|hi|hallo|hello|ok|okay)[,!]?\s+/i, "")
    .replace(/\b(can you|could you|would you|will you|kannst du|könntest du|koenntest du|würdest du)\s*/i, "")
    .replace(/\b(please|pls|plz|bitte)\b[,]?\s*/gi, "")
    .replace(/\b(i'?ll|i will|let me|ich werde|ich kümmere mich (?:um|darum)?)\s*/i, "")
    .replace(/[?!.]+\s*$/, "")
    .trim();
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t.length > 90 ? `${t.slice(0, 87)}…` : t;
}

export function extractIntent(text: string, ctx: IntentContext): Intent | null {
  const s = normalise(text);
  const now = Temporal.Instant.from(ctx.now).toZonedDateTimeISO(ctx.timeZone);
  const today = now.toPlainDate();
  const { dates, said: daySaid } = days(s, today);
  const tod = timeOfDay(s);
  const timeSaid = Boolean(tod.exact || tod.from || tod.to || tod.part);
  const mentions = mentioned(text, ctx);
  const mode = ctx.mode ?? "chat";

  // Meeting?
  let meeting = 0;
  const noun = MEETING_NOUN.test(s);
  const propose = PROPOSE.test(s);
  if (mode === "note") {
    if (daySaid && (tod.exact || tod.from)) meeting = 0.8;
  } else if (!PAST_OR_OFF.test(s) && !ASKS_EXISTING.test(s)) {
    if (noun && propose) meeting = daySaid || timeSaid ? 0.9 : 0.75;
    else if (
      noun &&
      (daySaid || timeSaid) &&
      (s.includes("?") || /\b(free|zeit|frei|passt|works|geht)\b/.test(s))
    )
      meeting = 0.75;
    else if (noun && (daySaid || timeSaid)) meeting = 0.62;
    else if (
      propose &&
      (daySaid || timeSaid) &&
      /\b(free|zeit|frei|passt|around|available|verfügbar)\b/.test(s)
    )
      meeting = 0.7;
    else if (noun) meeting = 0.4;
  }

  // Task?
  let task = 0;
  let assignee: string | null = null;
  const others = ctx.members.filter((m) => m !== ctx.author);
  if (mode === "chat" && ACTION.test(s) && !PAST_OR_OFF.test(s)) {
    if (REQUEST.test(s)) {
      assignee = mentions.find((m) => m !== ctx.author) ?? (others.length === 1 ? others[0]! : null);
      if (assignee) task = daySaid ? 0.85 : 0.7;
    } else if (SELF.test(s)) {
      assignee = ctx.author;
      task = daySaid ? 0.8 : 0.65;
    }
    // "Can you set up a call" is a meeting, not a task.
    if (
      noun &&
      /\b(set up|schedule|organi[sz]e|arrange|plan|einrichten|planen|organisier\w*|ansetzen|einplanen)\b/.test(
        s,
      )
    )
      task = 0;
    if (noun && propose) task = Math.min(task, meeting - 0.01);
  }

  if (meeting <= 0 && task <= 0) return null;

  if (task > meeting && assignee) {
    const intent: TaskIntent = {
      kind: "task",
      confidence: task,
      text: cleanTask(text),
      assignee,
      label: daySaid ? `due ${describe(dates.slice(0, 1), true, {})}` : "no due date",
    };
    if (daySaid && dates[0]) intent.due = dates[0].toString();
    return intent;
  }

  const dur = duration(s, ctx.defaultDurationMin);
  const workdays = (n: number) => {
    const r: Temporal.PlainDate[] = [];
    for (let d = today; r.length < n; d = d.add({ days: 1 })) if (d.dayOfWeek <= 5) r.push(d);
    return r;
  };
  const chosen = daySaid ? dates : workdays(ctx.openDays ?? 5);
  if (chosen.length === 0) return null;
  const windows: Interval[] = [];
  for (const d of chosen) {
    let from = "00:00";
    let to = "23:59";
    if (tod.part && ctx.dayParts[tod.part]) [from, to] = ctx.dayParts[tod.part]!;
    if (tod.from) from = tod.from;
    if (tod.to) to = tod.to;
    if (tod.exact) from = tod.exact;
    const start = d.toZonedDateTime({ timeZone: ctx.timeZone, plainTime: Temporal.PlainTime.from(from) });
    const end = tod.exact
      ? start.add({ minutes: dur.min })
      : d.toZonedDateTime({ timeZone: ctx.timeZone, plainTime: Temporal.PlainTime.from(to) });
    if (Temporal.ZonedDateTime.compare(end, now) <= 0) continue;
    windows.push({ start: start.toInstant().toString(), end: end.toInstant().toString() });
  }
  if (windows.length === 0) return null;
  const attendees = mentions.length ? [...new Set([ctx.author, ...mentions])] : ctx.members;
  return {
    kind: "meeting",
    confidence: meeting,
    title: topic(text) ?? (ctx.channelName ? `Call: ${ctx.channelName}` : "Call"),
    durationMin: dur.min,
    windows,
    exact: Boolean(tod.exact),
    label: describe(chosen, daySaid, tod),
    attendees,
  };
}
