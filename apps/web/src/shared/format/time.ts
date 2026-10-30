import { Temporal } from "temporal-polyfill";

const CITY: Record<string, string> = {
  "Europe/Berlin": "Berlin",
  "Asia/Kuala_Lumpur": "Kuala Lumpur",
  "America/New_York": "New York",
  UTC: "UTC",
};

export const city = (tz: string) => CITY[tz] ?? tz.split("/").at(-1)!.replace(/_/g, " ");

export function zoned(iso: string | number, tz: string): Temporal.ZonedDateTime {
  const instant =
    typeof iso === "number" ? Temporal.Instant.fromEpochMilliseconds(iso) : Temporal.Instant.from(iso);
  return instant.toZonedDateTimeISO(tz);
}

export function clock(iso: string | number, tz: string): string {
  const z = zoned(iso, tz);
  return `${String(z.hour).padStart(2, "0")}:${String(z.minute).padStart(2, "0")}`;
}

const DAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function day(iso: string | number | Temporal.PlainDate, tz?: string): string {
  const d = iso instanceof Temporal.PlainDate ? iso : zoned(iso, tz ?? "UTC").toPlainDate();
  return `${DAYS[d.dayOfWeek]} ${d.day} ${MONTHS[d.month]}`;
}

/** "13:45" today, "Tue 13:45" this week, "4 Nov" before. */
export function messageTime(ms: number, tz: string, now = Date.now()): string {
  const z = zoned(ms, tz);
  const today = zoned(now, tz).toPlainDate();
  const d = z.toPlainDate();
  if (d.equals(today)) return clock(ms, tz);
  if (Temporal.PlainDate.compare(d, today.subtract({ days: 6 })) >= 0)
    return `${DAYS[d.dayOfWeek]} ${clock(ms, tz)}`;
  return `${d.day} ${MONTHS[d.month]}`;
}

export function todayIn(tz: string): Temporal.PlainDate {
  return Temporal.Now.zonedDateTimeISO(tz).toPlainDate();
}
