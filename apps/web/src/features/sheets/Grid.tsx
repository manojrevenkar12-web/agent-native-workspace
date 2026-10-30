"use client";

import { claimCell } from "@anw/agent/doc";
import { colName, type Engine, formatValue, isError, key, sheetMaps } from "@anw/sheets";
import { person } from "@anw/sync";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type KeyboardEvent, memo, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { layout } from "@/shared/theme/tokens";
import s from "./sheets.module.css";

export interface Cursor {
  row: number;
  col: number;
}

export interface Peer {
  user: string;
  cell: Cursor;
}

const ERROR_HELP: Record<string, string> = {
  "#DIV/0!": "Division by zero",
  "#REF!": "A reference points outside the sheet",
  "#NAME?": "Unknown function or name",
  "#VALUE!": "A value has the wrong type",
  "#CYCLE!": "This cell depends on itself",
  "#N/A": "No match found",
  "#PARSE!": "The formula could not be read",
  "#NUM!": "The number is too large or invalid",
};

/** Which cell an event happened in; handlers live on the grid, not on 500 cells. */
function cellAt(target: EventTarget): Cursor | null {
  const el = (target as HTMLElement).closest?.("[data-row]") as HTMLElement | null;
  if (!el) return null;
  return { row: Number(el.dataset.row), col: Number(el.dataset.col) };
}

interface RowProps {
  index: number;
  top: number;
  width: number;
  rowHead: number;
  colFirst: number;
  colLast: number;
  engine: Engine;
  rev: number;
  pending: Map<string, string>;
  selFrom: number;
  selTo: number;
  activeCol: number;
  peers: string;
}

/**
 * One row of cells. Rows that stay on screen while scrolling are not re-rendered: the props
 * are all primitives except the engine and pending map, whose changes `rev` announces.
 */
const Row = memo(
  function Row({
    index,
    top,
    width,
    rowHead,
    colFirst,
    colLast,
    engine,
    pending,
    selFrom,
    selTo,
    activeCol,
    peers,
  }: RowProps) {
    "use no memo";
    const peerAt = new Map(
      peers
        .split(",")
        .filter(Boolean)
        .map((x) => {
          const [c, u] = x.split(":");
          return [Number(c), u!] as const;
        }),
    );
    const cellsOut = [];
    for (let col = colFirst; col <= colLast; col++) {
      const k = key(index, col);
      const v = engine.get(k);
      const sel = col >= selFrom && col <= selTo;
      const peer = peerAt.get(col);
      const isPending = pending.has(k);
      cellsOut.push(
        <div
          key={col}
          id={`cell-${k}`}
          role="gridcell"
          aria-colindex={col + 2}
          aria-selected={sel}
          className={s.cell}
          data-row={index}
          data-col={col}
          data-num={typeof v === "number" ? "" : undefined}
          data-error={isError(v) ? "" : undefined}
          data-pending={isPending ? "" : undefined}
          data-selected={sel ? "" : undefined}
          data-active={col === activeCol ? "" : undefined}
          title={isError(v) ? ERROR_HELP[v.error] : isPending ? "Suggested by the assistant" : undefined}
          style={{
            left: rowHead + col * layout.colWidth,
            width: layout.colWidth,
            ...(peer ? { boxShadow: `inset 0 0 0 2px ${person(peer).color}` } : {}),
          }}
        >
          {formatValue(v)}
          {peer ? <span className={s.peerTag}>{person(peer).name.split(" ")[0]}</span> : null}
        </div>,
      );
    }
    return (
      <div
        role="row"
        aria-rowindex={index + 2}
        className={s.row}
        style={{ transform: `translateY(${top}px)`, width }}
      >
        <div
          role="rowheader"
          aria-colindex={1}
          className={s.rowHead}
          data-active={selFrom >= 0 ? "" : undefined}
        >
          {index + 1}
        </div>
        {cellsOut}
      </div>
    );
  },
  (a, b) =>
    a.index === b.index &&
    a.top === b.top &&
    a.width === b.width &&
    a.rowHead === b.rowHead &&
    a.colFirst === b.colFirst &&
    a.colLast === b.colLast &&
    a.rev === b.rev &&
    a.selFrom === b.selFrom &&
    a.selTo === b.selTo &&
    a.activeCol === b.activeCol &&
    a.peers === b.peers,
);

export function Grid({
  doc,
  engine,
  rev,
  rows,
  cols,
  pending,
  editable,
  active,
  setActive,
  peers,
  label,
}: {
  doc: Y.Doc;
  engine: Engine;
  rev: number;
  rows: number;
  cols: number;
  pending: Map<string, string>;
  editable: boolean;
  active: Cursor;
  setActive: (c: Cursor) => void;
  peers: Peer[];
  label: string;
}) {
  // The engine is mutable and changes outside React; `rev` says when. Opt out of automatic
  // memoisation so every render reads current values.
  "use no memo";
  const scroller = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLInputElement>(null);
  const [anchor, setAnchor] = useState<Cursor>(active);
  const [editing, setEditing] = useState<string | null>(null);
  const rowV = useVirtualizer({
    count: rows,
    getScrollElement: () => scroller.current,
    estimateSize: () => layout.rowHeight,
    overscan: 8,
    // Let React batch scroll renders instead of forcing a synchronous one per scroll event.
    useFlushSync: false,
  });
  const colV = useVirtualizer({
    horizontal: true,
    count: cols,
    getScrollElement: () => scroller.current,
    estimateSize: () => layout.colWidth,
    overscan: 1,
    useFlushSync: false,
  });
  const { cells } = sheetMaps(doc);

  useEffect(() => {
    rowV.scrollToIndex(active.row, { align: "auto" });
    colV.scrollToIndex(active.col, { align: "auto" });
  }, [active, rowV, colV]);

  const r0 = Math.min(anchor.row, active.row);
  const r1 = Math.max(anchor.row, active.row);
  const c0 = Math.min(anchor.col, active.col);
  const c1 = Math.max(anchor.col, active.col);

  const move = (row: number, col: number, extend = false) => {
    const next = { row: Math.max(0, Math.min(rows - 1, row)), col: Math.max(0, Math.min(cols - 1, col)) };
    setActive(next);
    if (!extend) setAnchor(next);
  };

  const commit = (value: string, then?: Cursor) => {
    const k = key(active.row, active.col);
    if (editable && value !== (cells.get(k) ?? "")) {
      doc.transact(() => {
        claimCell(doc, k);
        if (value === "") cells.delete(k);
        else cells.set(k, value);
      });
    }
    setEditing(null);
    if (then) move(then.row, then.col);
    scroller.current?.focus();
  };

  const clearSelection = () => {
    if (!editable) return;
    doc.transact(() => {
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++) {
          claimCell(doc, key(r, c));
          cells.delete(key(r, c));
        }
    });
  };

  /** Ctrl+arrow: to the edge of the data block, as in every spreadsheet. */
  const edge = (dr: number, dc: number): Cursor => {
    const filled = (r: number, c: number) => cells.has(key(r, c));
    let r = active.row;
    let c = active.col;
    const inside = (rr: number, cc: number) => rr >= 0 && rr < rows && cc >= 0 && cc < cols;
    const startFilled = filled(r, c) && inside(r + dr, c + dc) && filled(r + dr, c + dc);
    if (startFilled) {
      while (inside(r + dr, c + dc) && filled(r + dr, c + dc)) {
        r += dr;
        c += dc;
      }
    } else {
      r += dr;
      c += dc;
      while (inside(r, c) && !filled(r, c)) {
        r += dr;
        c += dc;
      }
      if (!inside(r, c))
        return { row: Math.max(0, Math.min(rows - 1, r - dr)), col: Math.max(0, Math.min(cols - 1, c - dc)) };
    }
    return { row: r, col: c };
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing !== null) return;
    const ext = e.shiftKey;
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 400) / layout.rowHeight) - 2);
    const mod = e.metaKey || e.ctrlKey;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
      case "ArrowRight":
      case "ArrowLeft": {
        const [dr, dc] = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1] }[
          e.key
        ] as [number, number];
        const to = mod ? edge(dr, dc) : { row: active.row + dr, col: active.col + dc };
        move(to.row, to.col, ext);
        break;
      }
      case "Tab":
        move(active.row, active.col + (ext ? -1 : 1));
        break;
      case "PageDown":
        move(active.row + page, active.col, ext);
        break;
      case "PageUp":
        move(active.row - page, active.col, ext);
        break;
      case "Home":
        move(mod ? 0 : active.row, 0, ext);
        break;
      case "End":
        move(mod ? rows - 1 : active.row, cols - 1, ext);
        break;
      case "Enter":
      case "F2":
        if (editable) setEditing(cells.get(key(active.row, active.col)) ?? "");
        break;
      case "Delete":
      case "Backspace":
        clearSelection();
        break;
      default:
        if (editable && e.key.length === 1 && !mod) {
          setEditing(e.key);
          e.preventDefault();
        }
        return;
    }
    e.preventDefault();
  };

  useEffect(() => {
    if (editing !== null) editorRef.current?.focus();
  }, [editing]);

  const onCopy = (e: ClipboardEvent | React.ClipboardEvent) => {
    const lines: string[] = [];
    for (let r = r0; r <= r1; r++) {
      const line: string[] = [];
      for (let c = c0; c <= c1; c++) line.push(formatValue(engine.get(key(r, c))));
      lines.push(line.join("\t"));
    }
    e.clipboardData?.setData("text/plain", lines.join("\n"));
    e.preventDefault();
  };

  const onPaste = (e: React.ClipboardEvent) => {
    if (!editable || editing !== null) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    const grid = text
      .replace(/\r/g, "")
      .replace(/\n$/, "")
      .split("\n")
      .map((l) => l.split("\t"));
    doc.transact(() => {
      grid.forEach((line, i) => {
        line.forEach((v, j) => {
          const k = key(active.row + i, active.col + j);
          claimCell(doc, k);
          if (v === "") cells.delete(k);
          else cells.set(k, v);
        });
      });
    });
  };

  // Peers per row as a string, so a row only re-renders when someone moves in or out of it.
  const peerRows = new Map<number, string>();
  for (const p of peers)
    peerRows.set(p.cell.row, `${peerRows.get(p.cell.row) ?? ""}${p.cell.col}:${p.user},`);
  const vRows = rowV.getVirtualItems();
  const vCols = colV.getVirtualItems();
  // Row numbers need room: 100,000 is wider than 100.
  const rowHead = Math.max(layout.rowHeadWidth, layout.rowHeadPad + String(rows).length * layout.digitWidth);
  const width = rowHead + colV.getTotalSize();
  const height = layout.rowHeight + rowV.getTotalSize();
  const activeId = `cell-${key(active.row, active.col)}`;
  void rev; // read so a new revision re-renders the visible cells

  return (
    <div
      ref={scroller}
      className={s.scroller}
      style={{ "--rowhead-width": `${rowHead}px` } as React.CSSProperties}
      role="grid"
      aria-label={label}
      aria-rowcount={rows + 1}
      aria-colcount={cols + 1}
      aria-multiselectable="true"
      aria-activedescendant={activeId}
      aria-readonly={!editable || undefined}
      tabIndex={0}
      onKeyDown={onKey}
      onCopy={onCopy}
      onPaste={onPaste}
      onMouseDown={(e) => {
        const at = cellAt(e.target);
        if (!at) return;
        if (editing !== null) commit(editorRef.current?.value ?? editing);
        move(at.row, at.col, e.shiftKey);
      }}
      onDoubleClick={(e) => {
        const at = cellAt(e.target);
        if (at && editable) setEditing(cells.get(key(at.row, at.col)) ?? "");
      }}
    >
      <div className={s.canvas} style={{ width, height }}>
        <div className={s.headRow} role="row" aria-rowindex={1} style={{ width }}>
          <div className={s.corner} role="columnheader" aria-colindex={1} />
          {vCols.map((c) => (
            <div
              key={c.key}
              role="columnheader"
              aria-colindex={c.index + 2}
              className={s.colHead}
              data-active={c.index >= c0 && c.index <= c1 ? "" : undefined}
              style={{ left: rowHead + c.start, width: c.size }}
            >
              {colName(c.index)}
            </div>
          ))}
        </div>
        {vRows.map((r) => {
          const inSel = r.index >= r0 && r.index <= r1;
          return (
            <Row
              key={r.key}
              index={r.index}
              top={layout.rowHeight + r.start}
              width={width}
              rowHead={rowHead}
              colFirst={vCols[0]?.index ?? 0}
              colLast={vCols.at(-1)?.index ?? -1}
              engine={engine}
              rev={rev}
              pending={pending}
              selFrom={inSel ? c0 : -1}
              selTo={inSel ? c1 : -1}
              activeCol={r.index === active.row ? active.col : -1}
              peers={peerRows.get(r.index) ?? ""}
            />
          );
        })}
        {editing !== null ? (
          <input
            ref={editorRef}
            className={s.editor}
            aria-label={`Edit ${key(active.row, active.col)}`}
            defaultValue={editing}
            style={{
              top: layout.rowHeight + active.row * layout.rowHeight,
              left:
                rowHead +
                (colV.getVirtualItems().find((c) => c.index === active.col)?.start ??
                  active.col * layout.colWidth),
              width: layout.colWidth,
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit(e.currentTarget.value, { row: active.row + 1, col: active.col });
              else if (e.key === "Tab") {
                e.preventDefault();
                commit(e.currentTarget.value, { row: active.row, col: active.col + (e.shiftKey ? -1 : 1) });
              } else if (e.key === "Escape") {
                setEditing(null);
                scroller.current?.focus();
              }
            }}
            onBlur={(e) => editing !== null && commit(e.currentTarget.value)}
          />
        ) : null}
      </div>
    </div>
  );
}
