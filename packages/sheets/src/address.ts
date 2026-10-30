/** A1 addresses. Rows and columns are zero-based internally; "A1" is { row: 0, col: 0 }. */

export interface Cell {
  row: number;
  col: number;
}

export interface Range {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export const MAX_COLS = 702; // A..ZZ
export const MAX_ROWS = 1_048_576;

export function colName(col: number): string {
  let n = col + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function colIndex(name: string): number {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function key(row: number, col: number): string {
  return `${colName(col)}${row + 1}`;
}

const A1 = /^\$?([A-Za-z]{1,2})\$?([0-9]{1,7})$/;

export function parseA1(text: string): Cell | null {
  const m = A1.exec(text);
  if (!m) return null;
  const col = colIndex(m[1]!);
  const row = Number(m[2]) - 1;
  if (row < 0 || row >= MAX_ROWS || col < 0 || col >= MAX_COLS) return null;
  return { row, col };
}

export function cellOf(k: string): Cell {
  const c = parseA1(k);
  if (!c) throw new Error(`not a cell address: ${k}`);
  return c;
}

export function normalise(a: Cell, b: Cell): Range {
  return {
    r0: Math.min(a.row, b.row),
    c0: Math.min(a.col, b.col),
    r1: Math.max(a.row, b.row),
    c1: Math.max(a.col, b.col),
  };
}

export function inRange(r: Range, row: number, col: number): boolean {
  return row >= r.r0 && row <= r.r1 && col >= r.c0 && col <= r.c1;
}

export function rangeSize(r: Range): number {
  return (r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1);
}
