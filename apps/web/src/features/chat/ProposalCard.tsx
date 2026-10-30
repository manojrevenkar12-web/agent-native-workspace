"use client";

import { type MeetingProposal, type Proposal, person, type TaskProposal } from "@anw/sync";
import { AnimatePresence, motion as m } from "motion/react";
import Link from "next/link";
import { Temporal } from "temporal-polyfill";
import { city, clock, day } from "@/shared/format/time";
import { motion } from "@/shared/theme/tokens";
import { Button, Icon } from "@/shared/ui";
import s from "./chat.module.css";

const first = (id: string) => person(id).name.split(" ")[0];

function Meeting({
  p,
  me,
  onDecide,
}: {
  p: MeetingProposal;
  me: string;
  onDecide: (c: number | "dismiss") => void;
}) {
  const tz = person(me).timeZone;
  const others = [...new Set(p.attendees.filter((a) => a !== me).map((a) => person(a).timeZone))].filter(
    (z) => z !== tz,
  );
  const invited = p.attendees.includes(me);
  if (p.status === "booked") {
    const slot = p.slots[0];
    return (
      <p className={s.settled}>
        <Icon name="check" size={16} /> {first(p.decidedBy ?? me)} booked “{p.title}”
        {slot ? ` for ${day(slot.start, tz)} at ${clock(slot.start, tz)}` : ""}.{" "}
        <Link href="/calendar">Open calendar</Link>
      </p>
    );
  }
  if (p.status === "dismissed") return <p className={s.settled}>Dismissed by {first(p.decidedBy ?? me)}.</p>;
  return (
    <div className={s.proposal} data-kind="meeting">
      <div className={s.proposalHead}>
        <strong>{p.title}</strong>
        <span>
          {p.durationMin} min · {p.window}
        </span>
      </div>
      {p.note ? <p className={s.note}>{p.note}</p> : null}
      {p.slots.length ? (
        <ul className={s.slots} aria-label="Times that work">
          {p.slots.map((slot, i) => (
            <li key={slot.start}>
              <button
                type="button"
                className={s.slot}
                onClick={() => onDecide(i)}
                disabled={!invited}
                aria-label={`Book ${day(slot.start, tz)} at ${clock(slot.start, tz)}${slot.missing?.length ? `, without ${slot.missing.map(first).join(", ")}` : ""}`}
              >
                <span className={s.slotDay}>{day(slot.start, tz)}</span>
                <span className={s.slotTime}>{clock(slot.start, tz)}</span>
                {others.map((z) => (
                  <span key={z} className={s.slotOther}>
                    {clock(slot.start, z)} {city(z)}
                  </span>
                ))}
                {slot.missing?.length ? (
                  <span className={s.slotMissing}>without {slot.missing.map(first).join(", ")}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={s.proposalActions}>
        {!invited ? <span className={s.note}>Only people in the meeting can book it.</span> : null}
        <Button small variant="quiet" onClick={() => onDecide("dismiss")}>
          Not now
        </Button>
      </div>
    </div>
  );
}

function Task({
  p,
  me,
  onDecide,
}: {
  p: TaskProposal;
  me: string;
  onDecide: (c: "accept" | "dismiss") => void;
}) {
  if (p.status === "added")
    return (
      <p className={s.settled}>
        <Icon name="check" size={16} /> Added to {first(p.assignee)}'s tasks
        {p.due ? `, due ${day(Temporal.PlainDate.from(p.due))}` : ""}.
      </p>
    );
  if (p.status === "dismissed") return <p className={s.settled}>Dismissed by {first(p.decidedBy ?? me)}.</p>;
  return (
    <div className={s.proposal} data-kind="task">
      <div className={s.proposalHead}>
        <strong>{p.text}</strong>
        <span>
          {first(p.assignee)}
          {p.due ? ` · due ${day(Temporal.PlainDate.from(p.due))}` : ""}
        </span>
      </div>
      <div className={s.proposalActions}>
        <Button small variant="decide" icon="task" onClick={() => onDecide("accept")}>
          Add to tasks
        </Button>
        <Button small variant="quiet" onClick={() => onDecide("dismiss")}>
          Not now
        </Button>
      </div>
    </div>
  );
}

export function ProposalCard({
  proposal,
  me,
  onDecide,
}: {
  proposal: Proposal;
  me: string;
  onDecide: (choice: number | "dismiss" | "accept") => void;
}) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <m.div
        key={proposal.status}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={{ duration: motion.med, ease: motion.ease }}
      >
        {proposal.kind === "meeting" ? (
          <Meeting p={proposal} me={me} onDecide={onDecide} />
        ) : (
          <Task p={proposal} me={me} onDecide={onDecide} />
        )}
      </m.div>
    </AnimatePresence>
  );
}
