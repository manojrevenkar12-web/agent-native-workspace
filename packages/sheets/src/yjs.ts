import type * as Y from "yjs";
import { Engine } from "./engine.ts";

/** The shared parts of a sheet document. */
export function sheetMaps(doc: Y.Doc) {
  return {
    /** "A1" → what someone typed. */
    cells: doc.getMap<string>("cells"),
    /** "A1" → the agent's suggestion and what the cell held before, until a person decides. */
    pending: doc.getMap<{ id: string; prev: string }>("pending"),
    /** Column widths and other view settings everybody shares. */
    meta: doc.getMap<unknown>("meta"),
  };
}

/**
 * Keeps an engine in step with a shared sheet. Every client computes the same values from the
 * same inputs, so only inputs travel over the network.
 */
export function bindSheet(
  doc: Y.Doc,
  onChange: (changed: string[]) => void,
): { engine: Engine; dispose: () => void } {
  const { cells } = sheetMaps(doc);
  const engine = new Engine();
  engine.setMany([...cells.entries()]);
  const observer = (event: Y.YMapEvent<string>) => {
    const entries: [string, string][] = [];
    for (const k of event.keysChanged) entries.push([k, cells.get(k) ?? ""]);
    const changed = engine.setMany(entries);
    if (changed.length) onChange(changed);
  };
  cells.observe(observer);
  return { engine, dispose: () => cells.unobserve(observer) };
}
