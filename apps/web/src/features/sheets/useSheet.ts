"use client";

import { sheetSuggestions } from "@anw/agent/doc";
import { bindSheet, cellOf, type Engine, sheetMaps } from "@anw/sheets";
import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";

export interface SheetState {
  engine: Engine | null;
  /** Grows when any visible value may have changed. */
  rev: number;
  rows: number;
  cols: number;
  pending: Map<string, string>;
  suggestions: { id: string; cells: number }[];
}

const MIN_ROWS = 200;
const MIN_COLS = 12;

/**
 * Binds the formula engine to a shared sheet. Every client computes values itself from the
 * shared inputs; updates are coalesced to one render per animation frame, so 4 cells/flush
 * from the assistant or a 10,000-cell paste both cost one paint.
 */
export function useSheet(doc: Y.Doc, ready: boolean): SheetState {
  const [state, setState] = useState<SheetState>({
    engine: null,
    rev: 0,
    rows: MIN_ROWS,
    cols: MIN_COLS,
    pending: new Map(),
    suggestions: [],
  });
  const frame = useRef(0);
  useEffect(() => {
    if (!ready) return;
    const { cells, pending } = sheetMaps(doc);
    let maxRow = 0;
    let maxCol = 0;
    const grow = (keys: Iterable<string>) => {
      for (const k of keys) {
        const c = cellOf(k);
        if (c.row > maxRow) maxRow = c.row;
        if (c.col > maxCol) maxCol = c.col;
      }
    };
    const publish = () => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() =>
        setState((s) => ({
          engine: bound.engine,
          rev: s.rev + 1,
          rows: Math.max(MIN_ROWS, maxRow + 50),
          cols: Math.max(MIN_COLS, maxCol + 4),
          pending: new Map([...pending.entries()].map(([k, v]) => [k, v.id])),
          suggestions: sheetSuggestions(doc),
        })),
      );
    };
    grow(cells.keys());
    const bound = bindSheet(doc, (changed) => {
      grow(changed);
      publish();
    });
    const onPending = () => publish();
    pending.observe(onPending);
    publish();
    return () => {
      cancelAnimationFrame(frame.current);
      pending.unobserve(onPending);
      bound.dispose();
    };
  }, [doc, ready]);
  return state;
}
