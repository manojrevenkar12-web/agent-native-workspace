"use client";

import { assistant, channels, inChannel, type Message, person } from "@anw/sync";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { SurfaceHeader } from "@/features/shell/SurfaceHeader";
import { useChannel, useConnectionStatus, useWorkspace } from "@/shared/sync/workspace";
import { Button, Icon, SkeletonLines, StateView } from "@/shared/ui";
import s from "./chat.module.css";
import { MessageItem } from "./MessageItem";

const GROUP_MS = 5 * 60_000;
const first = (id: string) => person(id).name.split(" ")[0];

function Composer({
  onSend,
  onTyping,
  channelName,
}: {
  onSend: (body: string) => void;
  onTyping: () => void;
  channelName: string;
}) {
  const [body, setBody] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const send = () => {
    const text = body.trim();
    if (!text) return;
    onSend(text);
    setBody("");
    ref.current?.focus();
  };
  return (
    <form
      className={s.composer}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <label htmlFor="composer" className="visually-hidden">
        Message #{channelName}
      </label>
      <textarea
        id="composer"
        ref={ref}
        rows={1}
        value={body}
        placeholder={`Message #${channelName}. Mention @assistant to ask for a summary.`}
        onChange={(e) => {
          setBody(e.target.value);
          onTyping();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <Button type="submit" variant="primary" icon="send" aria-label="Send" disabled={!body.trim()} />
    </form>
  );
}

export function ChatView({ channel: id }: { channel: string }) {
  const { user } = useWorkspace();
  const status = useConnectionStatus();
  const info = channels.find((c) => c.id === id);
  const member = inChannel(user, id);
  const mine = channels.filter((c) => c.members.includes(user));
  return (
    <div className={s.layout}>
      <nav className={s.channels} aria-label="Conversations">
        <h2 className={s.channelsTitle}>Conversations</h2>
        <ul>
          {mine.map((c) => (
            <li key={c.id}>
              <Link href={`/chat/${c.id}`} aria-current={c.id === id ? "page" : undefined}>
                {c.members.length === 2 ? c.name : `# ${c.name}`}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <section className={s.pane} aria-label={info ? `#${info.name}` : "Conversation"}>
        {!info || !member ? (
          <StateView
            kind="error"
            title="You're not in this conversation"
            icon="chat"
            action={<Link href="/chat/launch">Go to #launch-plan</Link>}
          >
            Ask someone in it to add you, or pick one of your conversations.
          </StateView>
        ) : (
          <Conversation id={id} name={info.name} members={info.members} offline={status === "offline"} />
        )}
      </section>
    </div>
  );
}

function Conversation({
  id,
  name,
  members,
  offline,
}: {
  id: string;
  name: string;
  members: string[];
  offline: boolean;
}) {
  const { user } = useWorkspace();
  const { channel, snapshot } = useChannel(id);
  const listRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const byId = useMemo(() => new Map(snapshot.messages.map((m) => [m.id, m])), [snapshot.messages]);
  const last = snapshot.messages.at(-1);
  const lastLen = last ? last.body.length : 0;

  // Stay pinned to the newest message unless the reader scrolled up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the list or the streaming tail grows
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (atBottom) {
      el.scrollTop = el.scrollHeight;
      channel.markRead();
    } else setUnseen((n) => n + 1);
  }, [snapshot.messages.length, snapshot.pending.length, lastLen]);

  const seenBy = Object.entries(snapshot.reads)
    .filter(([u, seq]) => u !== user && last && seq >= last.seq)
    .map(([u]) => first(u));

  const header = (
    <SurfaceHeader
      title={members.length === 2 ? name : `# ${name}`}
      detail={`${members.length} people · ${members.map(first).join(", ")}`}
      status={offline ? "offline" : snapshot.loaded ? "synced" : "connecting"}
    />
  );

  if (!snapshot.loaded && snapshot.messages.length === 0)
    return (
      <>
        {header}
        <SkeletonLines label="Loading messages" lines={7} />
      </>
    );

  return (
    <>
      {header}
      <div className={s.scroller}>
        {snapshot.messages.length === 0 && snapshot.pending.length === 0 ? (
          <StateView kind="empty" title="Nothing here yet" icon="chat">
            Say hello. If you suggest a time to meet, the assistant will find slots that work for everyone.
          </StateView>
        ) : null}
        <div
          ref={listRef}
          className={s.list}
          role="log"
          aria-label={`Messages in ${name}`}
          onScroll={(e) => {
            const el = e.currentTarget;
            const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            setAtBottom(bottom);
            if (bottom) {
              setUnseen(0);
              channel.markRead();
            }
          }}
        >
          <ol className={s.items}>
            {snapshot.messages.map((msg: Message, i) => {
              const prev = snapshot.messages[i - 1];
              const continued =
                !!prev &&
                prev.author === msg.author &&
                msg.createdAt - prev.createdAt < GROUP_MS &&
                !msg.proposal &&
                !prev.proposal;
              return (
                <MessageItem
                  key={msg.id}
                  msg={msg}
                  me={user}
                  continued={continued}
                  replyTo={msg.replyTo ? byId.get(msg.replyTo) : undefined}
                  onDecide={(mid, c) => channel.decide(mid, c)}
                  onEdit={(mid, body) => channel.edit(mid, body)}
                  onDelete={(mid) => channel.remove(mid)}
                />
              );
            })}
            {snapshot.pending.map((p) => (
              <li key={p.clientMsgId} className={s.message} data-pending>
                <div className={s.gutter} />
                <div className={s.bubble}>
                  <p className={s.text}>{p.body}</p>
                  <span className={s.sending}>
                    <Icon name="clock" size={14} /> {offline ? "Waiting for connection" : "Sending"}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </div>
        {!atBottom && unseen > 0 ? (
          <Button
            className={s.jump}
            small
            variant="primary"
            onClick={() => {
              const el = listRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
          >
            New messages
          </Button>
        ) : null}
      </div>
      <div className={s.footer}>
        <p className={s.typing} aria-live="polite">
          {snapshot.typing.length
            ? `${snapshot.typing.map((u) => (u === assistant.id ? "Assistant" : first(u))).join(", ")} ${snapshot.typing.length > 1 ? "are" : "is"} typing…`
            : seenBy.length
              ? `Seen by ${seenBy.join(", ")}`
              : " "}
        </p>
        <Composer onSend={(b) => channel.send(b)} onTyping={() => channel.typing()} channelName={name} />
      </div>
    </>
  );
}
