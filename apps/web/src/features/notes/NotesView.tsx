"use client";

import { extractIntent, type MeetingIntent } from "@anw/agent/intents";
import { dayParts, people, person } from "@anw/sync";
import type { Editor } from "@tiptap/react";
import { AnimatePresence, motion as m } from "motion/react";
import { useCallback, useState } from "react";
import * as Y from "yjs";
import type { CalendarEvent } from "@/features/calendar/CalendarView";
import { DocEditor } from "@/features/docs/DocEditor";
import { SurfaceHeader } from "@/features/shell/SurfaceHeader";
import { clock, day } from "@/shared/format/time";
import { useRoom, useWorkspace, useYDerived } from "@/shared/sync/workspace";
import { motion } from "@/shared/theme/tokens";
import { Button, Icon, SkeletonLines, StateView } from "@/shared/ui";
import s from "./notes.module.css";

interface NoteRef {
  id: string;
  createdAt: number;
}

function textOf(fragment: Y.XmlFragment): string[] {
  const lines: string[] = [];
  const walk = (el: Y.XmlFragment | Y.XmlElement) => {
    for (const c of el.toArray()) {
      if (c instanceof Y.XmlText) lines.push(c.toString().replace(/<[^>]+>/g, ""));
      else if (c instanceof Y.XmlElement) walk(c);
    }
  };
  walk(fragment);
  return lines.filter((l) => l.trim());
}

/** Lines in a note that read like an appointment, found as you type. Nothing is booked until you say so. */
function useAppointments(lines: string[], user: string) {
  const names = Object.fromEntries(people.map((p) => [p.id, [p.name.toLowerCase()]]));
  return lines
    .map((line) => ({
      line,
      intent: extractIntent(line, {
        author: user,
        timeZone: person(user).timeZone,
        members: [user],
        names,
        now: new Date().toISOString(),
        mode: "note",
        dayParts,
        defaultDurationMin: 30,
      }),
    }))
    .filter((x): x is { line: string; intent: MeetingIntent } => x.intent?.kind === "meeting");
}

export function NotesView() {
  const { user } = useWorkspace();
  const room = `notes:${user}`;
  const { provider, doc, status } = useRoom(room);
  const cal = useRoom("calendar:team");
  const list = doc.getArray<NoteRef>("list");
  const added = doc.getMap<string>("added");
  const notes = useYDerived(list, () => list.toArray());
  const [current, setCurrent] = useState<string | null>(null);
  const active = current ?? notes[0]?.id ?? null;
  const fragment = active ? doc.getXmlFragment(`note:${active}`) : null;
  const lines = useYDerived(fragment, () => (fragment ? textOf(fragment) : []));
  const titles = useYDerived(doc.getXmlFragment(`note:${active ?? "_"}`), () =>
    Object.fromEntries(notes.map((n) => [n.id, textOf(doc.getXmlFragment(`note:${n.id}`))[0] ?? "Untitled"])),
  );
  const addedMap = useYDerived(added, () => Object.fromEntries(added.entries()));
  const appointments = useAppointments(lines, user);
  const [, setEditor] = useState<Editor | null>(null);
  const onEditor = useCallback((e: Editor | null) => setEditor(e), []);

  const create = () => {
    const id = crypto.randomUUID().slice(0, 8);
    doc.transact(() => list.insert(0, [{ id, createdAt: Date.now() }]));
    setCurrent(id);
  };

  const book = (line: string, intent: MeetingIntent) => {
    const w = intent.windows[0]!;
    const id = crypto.randomUUID();
    const title = line.replace(/\b(mon|tue|wed|thu|fri|sat|sun)\w*\b.*$/i, "").trim() || line;
    const ev: CalendarEvent = { id, title, start: w.start, end: w.end, attendees: [user], createdBy: user };
    cal.doc.getMap<CalendarEvent>("events").set(id, ev);
    added.set(line, id);
  };

  if (status === "denied")
    return <StateView kind="error" title="Your notes are not available" icon="notes" />;

  return (
    <div className={s.layout}>
      <nav className={s.list} aria-label="Notes">
        <div className={s.listHead}>
          <h2>Notes</h2>
          <Button small variant="quiet" icon="plus" onClick={create} aria-label="New note" />
        </div>
        {status !== "synced" && notes.length === 0 ? (
          <SkeletonLines label="Loading notes" lines={4} />
        ) : notes.length === 0 ? (
          <p className={s.muted}>No notes yet.</p>
        ) : (
          <ul>
            {notes.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  aria-current={n.id === active ? "page" : undefined}
                  onClick={() => setCurrent(n.id)}
                >
                  {titles[n.id] ?? "Untitled"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
      <section className={s.main} aria-label="Note">
        <SurfaceHeader
          title={active ? (titles[active] ?? "Untitled") : "Notes"}
          detail="Only you can see these"
          status={status}
        />
        {!active ? (
          status === "synced" ? (
            <StateView
              kind="empty"
              title="Write something down"
              icon="notes"
              action={
                <Button variant="primary" icon="plus" onClick={create}>
                  New note
                </Button>
              }
            >
              Write “Dentist Tue 10am” and it can go straight into your calendar.
            </StateView>
          ) : (
            <SkeletonLines label="Loading the note" lines={6} />
          )
        ) : (
          <div className={s.body}>
            <div className={s.paper}>
              <DocEditor
                key={active}
                provider={provider}
                user={user}
                editable
                field={`note:${active}`}
                label="Note"
                onEditor={onEditor}
              />
            </div>
            <aside className={s.chips} aria-label="Found in this note">
              {appointments.length === 0 ? (
                <p className={s.hint}>
                  Write a day and a time, like “Dentist Tue 10am”, and it shows up here, ready for your
                  calendar.
                </p>
              ) : null}
              <AnimatePresence initial={false}>
                {appointments.map(({ line, intent }) => (
                  <m.div
                    key={line}
                    className={s.chip}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: motion.med, ease: motion.ease }}
                  >
                    <span className={s.chipWhen}>
                      <Icon name="calendar" size={16} />{" "}
                      {day(intent.windows[0]!.start, person(user).timeZone)},{" "}
                      {clock(intent.windows[0]!.start, person(user).timeZone)}
                    </span>
                    <span className={s.chipLine}>{line}</span>
                    {addedMap[line] ? (
                      <span className={s.done}>
                        <Icon name="check" size={16} /> In your calendar
                      </span>
                    ) : (
                      <Button
                        small
                        variant="agent"
                        onClick={() => book(line, intent)}
                        disabled={cal.status !== "synced"}
                      >
                        Add to calendar
                      </Button>
                    )}
                  </m.div>
                ))}
              </AnimatePresence>
            </aside>
          </div>
        )}
      </section>
    </div>
  );
}
