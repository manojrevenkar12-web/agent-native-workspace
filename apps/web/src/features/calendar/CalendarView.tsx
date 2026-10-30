"use client";

import { people, person } from "@anw/sync";
import { AnimatePresence, motion as m } from "motion/react";
import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { Temporal } from "temporal-polyfill";
import { SurfaceHeader } from "@/features/shell/SurfaceHeader";
import { city, clock, day, todayIn, zoned } from "@/shared/format/time";
import { useRoom, useWorkspace, useYDerived } from "@/shared/sync/workspace";
import { layout, motion } from "@/shared/theme/tokens";
import { Avatar, Button, Icon, SkeletonLines, StateView } from "@/shared/ui";
import s from "./calendar.module.css";

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
  createdBy: string;
  source?: string;
}

interface TaskItem {
  id: string;
  text: string;
  assignee: string;
  due?: string;
  done: boolean;
}

const HOURS = Array.from(
  { length: layout.dayEndHour - layout.dayStartHour },
  (_, i) => layout.dayStartHour + i,
);
const PX_PER_MIN = layout.hourHeight / 60;

/** Side-by-side columns for overlapping events within one day. */
function columns(evs: { e: CalendarEvent; top: number; bottom: number }[]) {
  const sorted = [...evs].sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  const placed: { e: CalendarEvent; top: number; bottom: number; col: number; cols: number }[] = [];
  let group: typeof placed = [];
  let groupEnd = -1;
  const flush = () => {
    const n = Math.max(1, ...group.map((g) => g.col + 1));
    for (const g of group) g.cols = n;
    group = [];
  };
  for (const ev of sorted) {
    if (ev.top >= groupEnd) {
      flush();
      groupEnd = -1;
    }
    const used = new Set(group.filter((g) => g.bottom > ev.top).map((g) => g.col));
    let col = 0;
    while (used.has(col)) col++;
    const p = { ...ev, col, cols: 1 };
    group.push(p);
    placed.push(p);
    groupEnd = Math.max(groupEnd, ev.bottom);
  }
  flush();
  return placed;
}

export function CalendarView() {
  const { user } = useWorkspace();
  const { doc, status, role } = useRoom("calendar:team");
  const eventsMap = doc.getMap<CalendarEvent>("events");
  const tasksMap = doc.getMap<TaskItem>("tasks");
  const events = useYDerived(eventsMap, () => [...eventsMap.values()]);
  const tasks = useYDerived(tasksMap, () => [...tasksMap.values()]);
  const [tz, setTz] = useState(person(user).timeZone);
  const [onlyMine, setOnlyMine] = useState(false);
  const [weekStart, setWeekStart] = useState(() => {
    const t = todayIn(person(user).timeZone);
    return t.subtract({ days: t.dayOfWeek - 1 });
  });
  const [selected, setSelected] = useState<string | null>(null);
  const drag = useRef<{
    id: string;
    y0: number;
    x0: number;
    start: string;
    end: string;
    dayWidth: number;
  } | null>(null);
  const [preview, setPreview] = useState<{ id: string; minutes: number; days: number } | null>(null);

  const days = Array.from({ length: 7 }, (_, i) => weekStart.add({ days: i }));
  const today = todayIn(tz);
  const visible = events.filter((e) => !onlyMine || e.attendees.includes(user));
  const editable = role === "editor";

  const shift = (id: string, minutes: number, dayShift: number) => {
    const e = eventsMap.get(id);
    if (!e || !editable) return;
    const delta = { minutes: minutes + dayShift * 24 * 60 };
    eventsMap.set(id, {
      ...e,
      start: Temporal.Instant.from(e.start).add(delta).toString(),
      end: Temporal.Instant.from(e.end).add(delta).toString(),
    });
  };

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>, ev: CalendarEvent) => {
    if (!editable) return;
    const col =
      (e.currentTarget.closest("[data-day]") as HTMLElement | null)?.getBoundingClientRect().width ?? 1;
    drag.current = { id: ev.id, y0: e.clientY, x0: e.clientX, start: ev.start, end: ev.end, dayWidth: col };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const minutes = Math.round((e.clientY - d.y0) / PX_PER_MIN / layout.snapMinutes) * layout.snapMinutes;
    const dayShift = Math.round((e.clientX - d.x0) / d.dayWidth);
    setPreview({ id: d.id, minutes, days: dayShift });
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && preview && (preview.minutes || preview.days)) shift(d.id, preview.minutes, preview.days);
    setPreview(null);
  };
  const onEventKey = (e: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (!e.altKey) return;
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-layout.snapMinutes, 0],
      ArrowDown: [layout.snapMinutes, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const mv = moves[e.key];
    if (!mv) return;
    e.preventDefault();
    shift(id, mv[0], mv[1]);
  };

  const create = (d: Temporal.PlainDate, hour: number) => {
    if (!editable) return;
    const start = d.toZonedDateTime({ timeZone: tz, plainTime: new Temporal.PlainTime(hour) });
    const id = crypto.randomUUID();
    eventsMap.set(id, {
      id,
      title: "New event",
      start: start.toInstant().toString(),
      end: start.add({ minutes: 30 }).toInstant().toString(),
      attendees: [user],
      createdBy: user,
    });
    setSelected(id);
  };

  const sel = selected ? events.find((e) => e.id === selected) : undefined;
  const zones = [...new Set(people.map((p) => p.timeZone))];
  const myTasks = tasks
    .filter((t) => t.assignee === user || onlyMine === false)
    .sort((a, b) => (a.due ?? "9").localeCompare(b.due ?? "9"));

  const header = (
    <SurfaceHeader
      title={`${day(days[0]!)} – ${day(days[6]!)}`}
      detail={`Times in ${city(tz)}`}
      status={status}
      actions={
        <div className={s.controls}>
          <Button
            small
            variant="quiet"
            icon="left"
            aria-label="Previous week"
            onClick={() => setWeekStart(weekStart.subtract({ weeks: 1 }))}
          />
          <Button
            small
            onClick={() => {
              const t = todayIn(tz);
              setWeekStart(t.subtract({ days: t.dayOfWeek - 1 }));
            }}
          >
            This week
          </Button>
          <Button
            small
            variant="quiet"
            icon="right"
            aria-label="Next week"
            onClick={() => setWeekStart(weekStart.add({ weeks: 1 }))}
          />
          <label className={s.zone}>
            <span className="visually-hidden">Time zone</span>
            <select value={tz} onChange={(e) => setTz(e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {city(z)}
                </option>
              ))}
            </select>
          </label>
          <label className={s.check}>
            <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} /> Only
            mine
          </label>
        </div>
      }
    />
  );

  if (status === "denied")
    return <StateView kind="error" title="The team calendar is not shared with you" icon="calendar" />;
  if (status !== "synced" && events.length === 0)
    return (
      <>
        {header}
        <SkeletonLines label="Loading the calendar" lines={8} />
      </>
    );

  return (
    <div className={s.page}>
      {header}
      <div className={s.body}>
        <section className={s.week} aria-label={`Week of ${day(days[0]!)}`}>
          <div className={s.dayHeads} aria-hidden>
            <span />
            {days.map((d) => (
              <span key={d.toString()} className={s.dayHead} data-today={d.equals(today) || undefined}>
                {day(d)}
              </span>
            ))}
          </div>
          <div className={s.scroll}>
            <div className={s.grid}>
              <div className={s.hours} aria-hidden>
                {HOURS.map((h) => (
                  <span key={h} style={{ height: layout.hourHeight }}>
                    {String(h).padStart(2, "0")}:00
                  </span>
                ))}
              </div>
              {days.map((d) => {
                const dayEvents = visible
                  .map((e) => {
                    const st = zoned(e.start, tz);
                    const en = zoned(e.end, tz);
                    if (!st.toPlainDate().equals(d)) return null;
                    const top = (st.hour - layout.dayStartHour) * 60 + st.minute;
                    const bottom = Math.max(
                      top + 15,
                      (en.hour - layout.dayStartHour) * 60 +
                        en.minute +
                        (en.toPlainDate().equals(d) ? 0 : 24 * 60),
                    );
                    return { e, top, bottom };
                  })
                  .filter((x): x is { e: CalendarEvent; top: number; bottom: number } => x !== null);
                const due = tasks.filter((t) => t.due === d.toString() && (!onlyMine || t.assignee === user));
                return (
                  <section key={d.toString()} className={s.day} data-day aria-label={day(d)}>
                    {HOURS.map((h) => (
                      <button
                        key={h}
                        type="button"
                        className={s.slot}
                        style={{ height: layout.hourHeight }}
                        aria-label={`New event ${day(d)} ${h}:00`}
                        tabIndex={-1}
                        onDoubleClick={() => create(d, h)}
                      />
                    ))}
                    {due.length ? (
                      <div className={s.dueStrip}>
                        {due.map((t) => (
                          <span
                            key={t.id}
                            className={s.due}
                            data-done={t.done || undefined}
                            title={`${person(t.assignee).name}: ${t.text}`}
                          >
                            <Icon name="task" size={12} /> {t.text}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {columns(dayEvents).map(({ e, top, bottom, col, cols }) => {
                      const p = preview?.id === e.id ? preview : null;
                      const mine = e.attendees.includes(user);
                      return (
                        <m.button
                          key={e.id}
                          type="button"
                          layout="position"
                          transition={{ duration: motion.fast }}
                          className={s.event}
                          data-mine={mine || undefined}
                          data-short={bottom - top < 30 || undefined}
                          data-selected={selected === e.id || undefined}
                          style={{
                            top: Math.max(0, top) * PX_PER_MIN + (p ? p.minutes * PX_PER_MIN : 0),
                            height: Math.max(18, (bottom - Math.max(0, top)) * PX_PER_MIN - 2),
                            left: `calc(${(col / cols) * 100}% + ${p ? p.days * 100 : 0}%)`,
                            width: `calc(${100 / cols}% - 4px)`,
                          }}
                          aria-label={`${e.title}, ${clock(e.start, tz)} to ${clock(e.end, tz)}, with ${e.attendees.map((a) => person(a).name).join(", ")}. Alt and arrow keys move it.`}
                          onClick={() => setSelected(e.id)}
                          onKeyDown={(k) => onEventKey(k, e.id)}
                          onPointerDown={(pe) => onPointerDown(pe, e)}
                          onPointerMove={onPointerMove}
                          onPointerUp={onPointerUp}
                        >
                          <strong>{e.title}</strong>
                          <span>
                            {clock(e.start, tz)}–{clock(e.end, tz)}
                          </span>
                        </m.button>
                      );
                    })}
                  </section>
                );
              })}
            </div>
          </div>
        </section>
        <aside className={s.side} aria-label="Details and tasks">
          <AnimatePresence mode="wait" initial={false}>
            {sel ? (
              <m.section
                key={sel.id}
                className={s.details}
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: motion.med, ease: motion.ease }}
              >
                <label className="visually-hidden" htmlFor="event-title">
                  Event title
                </label>
                <input
                  id="event-title"
                  className={s.title}
                  value={sel.title}
                  readOnly={!editable}
                  onChange={(e) => eventsMap.set(sel.id, { ...sel, title: e.target.value })}
                />
                <ul className={s.times}>
                  {[...new Set(sel.attendees.map((a) => person(a).timeZone))].map((z) => (
                    <li key={z}>
                      <span>{city(z)}</span>
                      {day(sel.start, z)}, {clock(sel.start, z)}–{clock(sel.end, z)}
                    </li>
                  ))}
                </ul>
                <div className={s.people}>
                  {sel.attendees.map((a) => (
                    <span key={a}>
                      <Avatar id={a} size="1.5rem" /> {person(a).name}
                    </span>
                  ))}
                </div>
                {sel.source ? <p className={s.muted}>Booked from a chat message.</p> : null}
                <div className={s.row}>
                  {editable && sel.createdBy === user ? (
                    <Button
                      small
                      variant="danger"
                      icon="trash"
                      onClick={() => {
                        eventsMap.delete(sel.id);
                        setSelected(null);
                      }}
                    >
                      Delete
                    </Button>
                  ) : null}
                  <Button small variant="quiet" onClick={() => setSelected(null)}>
                    Close
                  </Button>
                </div>
              </m.section>
            ) : null}
          </AnimatePresence>
          <section>
            <h2 className={s.sideTitle}>Tasks</h2>
            {myTasks.length === 0 ? (
              <p className={s.muted}>
                No tasks yet. When someone asks you for something in chat, the assistant offers to add it
                here.
              </p>
            ) : (
              <ul className={s.tasks}>
                {myTasks.map((t) => (
                  <li key={t.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={t.done}
                        onChange={() => tasksMap.set(t.id, { ...t, done: !t.done })}
                        disabled={!editable}
                      />
                      <span data-done={t.done || undefined}>{t.text}</span>
                    </label>
                    <small>
                      {person(t.assignee).name.split(" ")[0]}
                      {t.due ? ` · due ${day(Temporal.PlainDate.from(t.due))}` : ""}
                    </small>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <p className={s.muted}>
            Double-click an empty hour to add an event. Drag events, or focus one and use Alt with the arrow
            keys.
          </p>
        </aside>
      </div>
    </div>
  );
}
