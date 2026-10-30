"use client";

import { acceptCells, rejectCells } from "@anw/agent/doc";
import { colName, formatValue, key, sheetMaps } from "@anw/sheets";
import { rooms } from "@anw/sync";
import Link from "next/link";
import { useEffect, useState } from "react";
import { SurfaceHeader } from "@/features/shell/SurfaceHeader";
import { useAgent, usePresence, useRoom, useWorkspace } from "@/shared/sync/workspace";
import { Button, Pill, SkeletonLines, StateView } from "@/shared/ui";
import { type Cursor, Grid, type Peer } from "./Grid";
import s from "./sheets.module.css";
import { useSheet } from "./useSheet";

const COLUMNS = Array.from({ length: 12 }, (_, i) => colName(i));

function FillPanel({ room, rows, editable }: { room: string; rows: number; editable: boolean }) {
  const { runs, start, cancel } = useAgent();
  const [source, setSource] = useState("A");
  const [target, setTarget] = useState("C");
  const [instruction, setInstruction] = useState(
    "Categorise into Travel, Venue, Food, Marketing, Software, People, Other",
  );
  const [runId, setRunId] = useState<string | null>(null);
  const run = runId ? runs[runId] : undefined;
  const busy = run?.state === "queued" || run?.state === "running";
  if (!editable) return null;
  return (
    <form
      className={s.fill}
      onSubmit={(e) => {
        e.preventDefault();
        setRunId(
          start({
            kind: "sheet.fill",
            room,
            sourceColumn: source,
            targetColumn: target,
            instruction,
            fromRow: 2,
            toRow: Math.min(rows, 5000),
          }),
        );
      }}
    >
      <span className={s.fillTitle}>Fill a column</span>
      <label>
        From
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          {COLUMNS.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <label>
        into
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          {COLUMNS.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <label className={s.grow}>
        <span className="visually-hidden">Instruction</span>
        <input value={instruction} onChange={(e) => setInstruction(e.target.value)} />
      </label>
      {busy ? (
        <Button small variant="quiet" icon="stop" onClick={() => runId && cancel(runId)}>
          Stop
        </Button>
      ) : (
        <Button
          small
          type="submit"
          variant="agent"
          icon="spark"
          disabled={!instruction.trim() || source === target}
        >
          Fill blanks
        </Button>
      )}
      <span className={s.fillState} aria-live="polite">
        {busy ? "Filling empty cells as suggestions…" : (run?.detail ?? "")}
      </span>
    </form>
  );
}

export function SheetView({ id }: { id: string }) {
  const name = `sheet:${id}`;
  const info = rooms[name];
  const { user } = useWorkspace();
  const { provider, doc, status, role, reason } = useRoom(name);
  const sheet = useSheet(doc, status === "synced");
  const [active, setActive] = useState<Cursor>({ row: 1, col: 0 });
  const presence = usePresence(provider, (st) => [st.id, st.cell]);
  const editable = role === "editor";
  const k = key(active.row, active.col);
  const raw = sheetMaps(doc).cells.get(k) ?? "";
  const [bar, setBar] = useState(raw);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the bar follows the active cell and its input
  useEffect(() => setBar(raw), [k, raw, sheet.rev]);
  useEffect(() => {
    provider.awareness.setLocalStateField("id", user);
    provider.awareness.setLocalStateField("cell", active);
  }, [provider, user, active]);

  const peers: Peer[] = presence
    .filter((p) => typeof p.state.id === "string" && p.state.cell)
    .map((p) => ({ user: p.state.id as string, cell: p.state.cell as Cursor }));
  const sheets = Object.entries(rooms).filter(
    ([, r]) => r.kind === "sheet" && (r.editors.includes(user) || r.viewers.includes(user)),
  );

  let body: React.ReactNode;
  if (!info)
    body = (
      <StateView
        kind="error"
        title="This sheet does not exist"
        icon="sheets"
        action={<Link href="/sheets/budget">Open the budget</Link>}
      />
    );
  else if (status === "denied")
    body = (
      <StateView kind="error" title="You don't have access to this sheet" icon="sheets">
        {reason}
      </StateView>
    );
  else if (!sheet.engine) body = <SkeletonLines label="Opening the sheet" lines={10} />;
  else
    body = (
      <>
        <div className={s.bar}>
          <span className={s.address}>
            <span className="visually-hidden">Active cell </span>
            {k}
          </span>
          <label className={s.grow}>
            <span className="visually-hidden">Formula or value of {k}</span>
            <input
              className={s.formula}
              value={bar}
              readOnly={!editable}
              onChange={(e) => setBar(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || !editable) return;
                const cells = sheetMaps(doc).cells;
                doc.transact(() => (bar === "" ? cells.delete(k) : cells.set(k, bar)));
              }}
            />
          </label>
          <span className={s.value}>
            <span className="visually-hidden">Computed value </span>= {formatValue(sheet.engine.get(k))}
          </span>
        </div>
        <FillPanel room={name} rows={sheet.rows} editable={editable} />
        {sheet.suggestions.length ? (
          <section className={s.review} aria-label="Suggested cells">
            {sheet.suggestions.map((sug) => (
              <span key={sug.id} className={s.reviewItem}>
                <Pill tone="agent">{sug.cells} cells suggested</Pill>
                {editable ? (
                  <>
                    <Button small variant="agent" icon="check" onClick={() => acceptCells(doc, sug.id)}>
                      Accept
                    </Button>
                    <Button small variant="quiet" icon="close" onClick={() => rejectCells(doc, sug.id)}>
                      Reject
                    </Button>
                  </>
                ) : null}
              </span>
            ))}
          </section>
        ) : null}
        <Grid
          doc={doc}
          engine={sheet.engine}
          rev={sheet.rev}
          rows={sheet.rows}
          cols={sheet.cols}
          pending={sheet.pending}
          editable={editable}
          active={active}
          setActive={setActive}
          peers={peers}
          label={info.title}
        />
      </>
    );

  return (
    <div className={s.layout}>
      <nav className={s.list} aria-label="Sheets">
        <h2 className={s.listTitle}>Sheets</h2>
        <ul>
          {sheets.map(([sid, r]) => (
            <li key={sid}>
              <Link href={`/sheets/${sid.slice(6)}`} aria-current={sid === name ? "page" : undefined}>
                {r.title}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <section className={s.main} aria-label={info?.title ?? "Sheet"}>
        <SurfaceHeader
          title={info?.title ?? "Sheet"}
          detail={role === "viewer" ? "View only" : `${sheet.rows.toLocaleString("en")} rows`}
          status={status}
          presence={[...new Set(peers.map((p) => p.user))]}
        />
        {body}
      </section>
    </div>
  );
}
