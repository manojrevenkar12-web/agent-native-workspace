"use client";

import { acceptSuggestion, FRAGMENT, listSuggestions, rejectSuggestion } from "@anw/agent/doc";
import { assistant, channels, rooms, toB64 } from "@anw/sync";
import type { Editor } from "@tiptap/react";
import { AnimatePresence, motion as m } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { SurfaceHeader } from "@/features/shell/SurfaceHeader";
import { useAgent, usePresence, useRoom, useWorkspace, useYDerived } from "@/shared/sync/workspace";
import { motion, timing } from "@/shared/theme/tokens";
import { Button, Pill, SkeletonLines, StateView } from "@/shared/ui";
import { DocEditor } from "./DocEditor";
import s from "./docs.module.css";

const reduced = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Accept with a short "drying" transition: the wash fades into ink, then the marks go. */
function dry(id: string, done: () => void) {
  if (reduced()) return done();
  const nodes = document.querySelectorAll<HTMLElement>(`[data-suggestion="${CSS.escape(id)}"]`);
  const blocks = document.querySelectorAll<HTMLElement>(`[data-suggestion-block="${CSS.escape(id)}"]`);
  for (const n of nodes) n.setAttribute("data-drying", "");
  for (const b of blocks) b.setAttribute("data-drying-block", "");
  setTimeout(done, motion.dryMs);
}

export function DocList({ current }: { current: string }) {
  const { user } = useWorkspace();
  const docs = Object.entries(rooms).filter(
    ([, r]) => r.kind === "doc" && (r.editors.includes(user) || r.viewers.includes(user)),
  );
  return (
    <nav className={s.list} aria-label="Documents">
      <h2 className={s.listTitle}>Documents</h2>
      <ul>
        {docs.map(([id, r]) => (
          <li key={id}>
            <Link href={`/docs/${id.slice(4)}`} aria-current={id === `doc:${current}` ? "page" : undefined}>
              {r.title}
              {r.viewers.includes(user) ? <small>view only</small> : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function AssistantPanel({
  room,
  editor,
  editable,
}: {
  room: string;
  editor: Editor | null;
  editable: boolean;
}) {
  const { user } = useWorkspace();
  const { doc } = useRoom(room);
  const fragment = doc.getXmlFragment(FRAGMENT);
  const suggestions = useYDerived(fragment, () => listSuggestions(doc), timing.deriveEveryMs);
  const { runs, start, cancel } = useAgent();
  const [instruction, setInstruction] = useState("Summarise the decisions so far");
  const [source, setSource] = useState("launch");
  const [runId, setRunId] = useState<string | null>(null);
  const run = runId ? runs[runId] : undefined;
  const busy = run?.state === "queued" || run?.state === "running";
  const mine = channels.filter((c) => c.members.includes(user));

  const draft = () => {
    // Anchor after the block holding the cursor; Yjs relative positions survive concurrent edits.
    let anchor: string | undefined;
    if (editor) {
      const index = editor.state.selection.$from.index(0);
      const rel = Y.createRelativePositionFromTypeIndex(fragment, Math.min(index + 1, fragment.length), -1);
      anchor = toB64(Y.encodeRelativePosition(rel));
    }
    setRunId(
      start({
        kind: "doc.draft",
        room,
        instruction,
        ...(anchor ? { anchor } : {}),
        ...(source ? { fromChannel: source } : {}),
      }),
    );
  };

  const show = (id: string) =>
    document
      .querySelector(`[data-suggestion="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });

  return (
    <aside className={s.panel} aria-label="Assistant">
      <h2 className={s.panelTitle}>Assistant</h2>
      {editable ? (
        <form
          className={s.ask}
          onSubmit={(e) => {
            e.preventDefault();
            draft();
          }}
        >
          <label htmlFor="instruction">What should it write?</label>
          <textarea
            id="instruction"
            rows={3}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
          <label htmlFor="source">Source</label>
          <select id="source" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">Nothing, just the instruction</option>
            {mine.map((c) => (
              <option key={c.id} value={c.id}>
                Messages in {c.members.length === 2 ? c.name : `#${c.name}`}
              </option>
            ))}
          </select>
          <div className={s.askRow}>
            {busy ? (
              <Button variant="quiet" icon="stop" onClick={() => runId && cancel(runId)}>
                Stop
              </Button>
            ) : (
              <Button type="submit" variant="agent" icon="spark" disabled={!instruction.trim()}>
                Draft after my cursor
              </Button>
            )}
          </div>
        </form>
      ) : (
        <p className={s.muted}>You can read this document. Ask an editor to change it.</p>
      )}
      <p className={s.runState} aria-live="polite">
        {run?.state === "running"
          ? "Writing as a suggestion. Keep typing anywhere; it will not get in your way."
          : (run?.detail ?? "")}
      </p>
      <h3 className={s.subTitle}>
        Suggestions <Pill tone={suggestions.length ? "agent" : undefined}>{suggestions.length}</Pill>
      </h3>
      {suggestions.length === 0 ? (
        <p className={s.muted}>
          Nothing waiting for review. What the assistant writes appears here before it is yours.
        </p>
      ) : (
        <ul className={s.suggestions}>
          <AnimatePresence initial={false}>
            {suggestions.map((sug) => (
              <m.li
                key={sug.id}
                layout
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: motion.med, ease: motion.ease }}
              >
                <button type="button" className={s.preview} onClick={() => show(sug.id)}>
                  {sug.preview || "Empty block"}
                </button>
                <span className={s.muted}>
                  {sug.chars} characters{sug.blocks ? ` in ${sug.blocks} blocks` : ""}
                </span>
                {editable && !(busy && run?.task.kind === "doc.draft") ? (
                  <div className={s.askRow}>
                    <Button
                      small
                      variant="agent"
                      icon="check"
                      onClick={() => dry(sug.id, () => acceptSuggestion(doc, sug.id))}
                    >
                      Accept
                    </Button>
                    <Button small variant="quiet" icon="close" onClick={() => rejectSuggestion(doc, sug.id)}>
                      Reject
                    </Button>
                  </div>
                ) : null}
              </m.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </aside>
  );
}

export function DocView({ id }: { id: string }) {
  const name = `doc:${id}`;
  const info = rooms[name];
  const { user } = useWorkspace();
  const { provider, status, role, reason } = useRoom(name);
  const presence = usePresence(provider, (st) => [
    st.id,
    (st.user as { agent?: boolean } | undefined)?.agent,
  ]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const onEditor = useCallback((e: Editor | null) => setEditor(e), []);
  const here = useMemo(() => {
    const ids = new Set<string>();
    for (const p of presence) {
      const u = p.state.user as { name?: string; agent?: boolean } | undefined;
      if (u?.agent) ids.add(assistant.id);
      else if (typeof p.state.id === "string") ids.add(p.state.id);
    }
    return [...ids];
  }, [presence]);

  useEffect(() => {
    provider.awareness.setLocalStateField("id", user);
  }, [provider, user]);

  const body = !info ? (
    <StateView
      kind="error"
      title="This document does not exist"
      icon="docs"
      action={<Link href="/docs/launch-brief">Open the launch brief</Link>}
    />
  ) : status === "denied" ? (
    <StateView kind="error" title="You don't have access to this document" icon="docs">
      {reason} Ask its owner to share it with you.
    </StateView>
  ) : status === "connecting" && !provider.doc.getXmlFragment(FRAGMENT).length ? (
    <SkeletonLines label="Opening the document" lines={9} />
  ) : (
    <div className={s.workspace}>
      <div className={s.paper}>
        <DocEditor
          provider={provider}
          user={user}
          editable={role === "editor"}
          label={info.title}
          onEditor={onEditor}
        />
      </div>
      <AssistantPanel room={name} editor={editor} editable={role === "editor"} />
    </div>
  );

  return (
    <div className={s.layout}>
      <DocList current={id} />
      <section className={s.main} aria-label={info?.title ?? "Document"}>
        <SurfaceHeader
          title={info?.title ?? "Document"}
          detail={role === "viewer" ? "View only" : undefined}
          status={status}
          presence={here}
        />
        {body}
      </section>
    </div>
  );
}
