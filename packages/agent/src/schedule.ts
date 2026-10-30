import { Temporal } from "temporal-polyfill";
import type { Interval } from "./intents.ts";

export interface Attendee {
  id: string;
  timeZone: string;
  busy: Interval[];
}

export interface WorkingHours {
  start: string;
  end: string;
  days: number[];
}

export interface SlotRequest {
  attendees: Attendee[];
  windows: Interval[];
  durationMin: number;
  now: string;
  stepMin: number;
  workingHours: WorkingHours;
  bufferMin?: number;
  max?: number;
}

const toMs = (iso: string) => Temporal.Instant.from(iso).epochMilliseconds;

/** Is [start, end) inside this person's working hours, in their own time zone? */
function working(a: Attendee, start: Temporal.Instant, end: Temporal.Instant, wh: WorkingHours): boolean {
  const s = start.toZonedDateTimeISO(a.timeZone);
  const e = end.subtract({ nanoseconds: 1 }).toZonedDateTimeISO(a.timeZone);
  if (!wh.days.includes(s.dayOfWeek)) return false;
  if (s.toPlainDate().toString() !== e.toPlainDate().toString()) return false;
  const open = Temporal.PlainTime.from(wh.start);
  const close = Temporal.PlainTime.from(wh.end);
  return (
    Temporal.PlainTime.compare(s.toPlainTime(), open) >= 0 &&
    Temporal.PlainTime.compare(end.toZonedDateTimeISO(a.timeZone).toPlainTime(), close) <= 0 &&
    Temporal.PlainTime.compare(end.toZonedDateTimeISO(a.timeZone).toPlainTime(), open) > 0
  );
}

function free(a: Attendee, s: number, e: number, buffer: number): boolean {
  return a.busy.every((b) => toMs(b.end) + buffer <= s || toMs(b.start) - buffer >= e);
}

export interface FoundSlot extends Interval {
  /** Attendees this slot does not work for (empty when it works for everyone). */
  missing: string[];
}

/**
 * Slots where every attendee is inside their own working hours (in their own time zone, so a
 * daylight-saving change in one city moves only that person's day) and free in the calendar.
 * Code decides the slot; the message only said roughly when.
 *
 * Candidates start on a fixed grid in UTC. The earliest slot comes first; the others are spread
 * out (at least two hours apart) so the choice is a real choice. When nobody-left-out is
 * impossible (Kuala Lumpur and New York share no working hours), the best slots that miss one
 * person are offered instead, and say who.
 */
export function findSlots(req: SlotRequest): FoundSlot[] {
  const step = req.stepMin * 60_000;
  const dur = req.durationMin * 60_000;
  const buffer = (req.bufferMin ?? 0) * 60_000;
  const max = req.max ?? 3;
  const now = toMs(req.now);
  const windows = [...req.windows].sort((a, b) => toMs(a.start) - toMs(b.start));
  const search = (allowMissing: number): FoundSlot[] => {
    const found: FoundSlot[] = [];
    for (const w of windows) {
      let s = Math.max(toMs(w.start), Math.ceil(now / step) * step);
      s = Math.ceil(s / step) * step;
      const last = toMs(w.end) - dur;
      for (; s <= last && found.length < max; s += step) {
        const e = s + dur;
        const start = Temporal.Instant.fromEpochMilliseconds(s);
        const end = Temporal.Instant.fromEpochMilliseconds(e);
        const missing = req.attendees
          .filter((a) => !(working(a, start, end, req.workingHours) && free(a, s, e, buffer)))
          .map((a) => a.id);
        if (missing.length > allowMissing) continue;
        if (found.some((f) => Math.abs(toMs(f.start) - s) < 2 * 3_600_000)) continue;
        found.push({ start: start.toString(), end: end.toString(), missing });
      }
      if (found.length >= max) break;
    }
    return found.sort((a, b) => toMs(a.start) - toMs(b.start));
  };
  const all = search(0);
  if (all.length > 0 || req.attendees.length < 3) return all;
  return search(1);
}

/** Whether a slot is still free for everyone (a calendar can change after a proposal). */
export function stillFree(slot: Interval, attendees: Attendee[], bufferMin = 0): boolean {
  const s = toMs(slot.start);
  const e = toMs(slot.end);
  return attendees.every((a) => free(a, s, e, bufferMin * 60_000));
}
