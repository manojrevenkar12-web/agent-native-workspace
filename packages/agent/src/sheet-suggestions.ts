import { sheetMaps } from "@anw/sheets";
import type * as Y from "yjs";
import { AGENT_ORIGIN } from "./suggestions.ts";

/** Writes agent values into a sheet as pending suggestions, remembering what each cell held. */
export function suggestCells(
  doc: Y.Doc,
  id: string,
  entries: [string, string][],
  origin: unknown = AGENT_ORIGIN,
): void {
  const { cells, pending } = sheetMaps(doc);
  doc.transact(() => {
    for (const [k, raw] of entries) {
      const before = pending.get(k);
      pending.set(k, { id, prev: before ? before.prev : (cells.get(k) ?? "") });
      cells.set(k, raw);
    }
  }, origin);
}

export function sheetSuggestions(doc: Y.Doc): { id: string; cells: number }[] {
  const by = new Map<string, number>();
  for (const v of sheetMaps(doc).pending.values()) by.set(v.id, (by.get(v.id) ?? 0) + 1);
  return [...by].map(([id, cells]) => ({ id, cells }));
}

export function acceptCells(doc: Y.Doc, id: string): void {
  const { pending } = sheetMaps(doc);
  doc.transact(() => {
    for (const [k, v] of [...pending.entries()]) if (v.id === id) pending.delete(k);
  }, "accept");
}

/** Puts back what each cell held, unless a person has changed the cell since. */
export function rejectCells(doc: Y.Doc, id: string): void {
  const { cells, pending } = sheetMaps(doc);
  doc.transact(() => {
    for (const [k, v] of [...pending.entries()]) {
      if (v.id !== id) continue;
      if (v.prev === "") cells.delete(k);
      else cells.set(k, v.prev);
      pending.delete(k);
    }
  }, "reject");
}

/** A person typing into a pending cell takes it over: it is theirs now, not a suggestion. */
export function claimCell(doc: Y.Doc, k: string): void {
  sheetMaps(doc).pending.delete(k);
}
