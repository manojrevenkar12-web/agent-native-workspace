"use client";

import { assistant, type Message, person } from "@anw/sync";
import { motion as m } from "motion/react";
import { memo, useState } from "react";
import { messageTime } from "@/shared/format/time";
import { motion } from "@/shared/theme/tokens";
import { Avatar, Button } from "@/shared/ui";
import s from "./chat.module.css";
import { ProposalCard } from "./ProposalCard";

/** Renders @mentions as marks; everything else is plain text (no HTML from messages, ever). */
function Body({ text }: { text: string }) {
  const parts = text.split(/(@\w+)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("@") ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one immutable string
          <mark key={i} className={s.mention}>
            {p}
          </mark>
        ) : (
          p
        ),
      )}
    </>
  );
}

export const MessageItem = memo(function MessageItem({
  msg,
  me,
  continued,
  replyTo,
  onDecide,
  onEdit,
  onDelete,
}: {
  msg: Message;
  me: string;
  continued: boolean;
  replyTo?: Message | undefined;
  onDecide: (id: string, choice: number | "dismiss" | "accept") => void;
  onEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.body);
  const isAgent = msg.author === assistant.id;
  const mine = msg.author === me;
  const tz = person(me).timeZone;
  const streaming = msg.status === "streaming";
  return (
    <m.li
      className={s.message}
      data-agent={isAgent || undefined}
      data-continued={continued || undefined}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: motion.med, ease: motion.ease }}
      aria-busy={streaming || undefined}
    >
      <div className={s.gutter}>{continued ? null : <Avatar id={msg.author} />}</div>
      <div className={s.bubble}>
        {continued ? null : (
          <div className={s.meta}>
            <span className={s.author}>{person(msg.author).name}</span>
            <time dateTime={new Date(msg.createdAt).toISOString()}>{messageTime(msg.createdAt, tz)}</time>
            {replyTo && isAgent ? (
              <span className={s.about}>about {person(replyTo.author).name.split(" ")[0]}'s message</span>
            ) : null}
          </div>
        )}
        {msg.deleted ? (
          <p className={s.deleted}>Message deleted</p>
        ) : editing ? (
          <form
            className={s.editForm}
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim()) onEdit(msg.id, draft.trim());
              setEditing(false);
            }}
          >
            <label className="visually-hidden" htmlFor={`edit-${msg.id}`}>
              Edit message
            </label>
            <input
              id={`edit-${msg.id}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
            />
            <Button small variant="primary" type="submit">
              Save
            </Button>
          </form>
        ) : (
          <p className={s.text}>
            <Body text={msg.body} />
            {streaming ? <span className={s.caret} aria-hidden /> : null}
            {msg.editedAt ? <span className={s.edited}> (edited)</span> : null}
            {msg.status === "stopped" ? <span className={s.edited}> (stopped)</span> : null}
          </p>
        )}
        {msg.proposal ? (
          <ProposalCard proposal={msg.proposal} me={me} onDecide={(c) => onDecide(msg.id, c)} />
        ) : null}
      </div>
      {mine && !msg.deleted && !editing ? (
        <div className={s.actions}>
          <Button
            small
            variant="quiet"
            icon="pencil"
            aria-label="Edit message"
            onClick={() => setEditing(true)}
          />
          <Button
            small
            variant="quiet"
            icon="trash"
            aria-label="Delete message"
            onClick={() => onDelete(msg.id)}
          />
        </div>
      ) : null}
    </m.li>
  );
});
