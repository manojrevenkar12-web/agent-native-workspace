import { key, type Range } from "./address.ts";
import type { ErrorCode, Node } from "./parse.ts";

export interface CellError {
  error: ErrorCode;
}
export type Value = number | string | boolean | null | CellError;

export const err = (error: ErrorCode): CellError => ({ error });
export const isError = (v: unknown): v is CellError =>
  typeof v === "object" && v !== null && "error" in (v as Record<string, unknown>);

export type Lookup = (k: string) => Value;

/** A function argument: a single value, or a rectangular block from a range. */
type Arg = { kind: "value"; v: Value } | { kind: "range"; rows: Value[][] };

const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

export function toNumber(v: Value): number | CellError {
  if (isError(v)) return v;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null || v === "") return 0;
  const s = v.trim();
  if (NUMERIC.test(s)) return Number(s);
  return err("#VALUE!");
}

export function toText(v: Value): string | CellError {
  if (isError(v)) return v;
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return formatNumber(v);
  return v;
}

export function toBool(v: Value): boolean | CellError {
  if (isError(v)) return v;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (v === null) return false;
  const u = v.toUpperCase();
  if (u === "TRUE") return true;
  if (u === "FALSE") return false;
  return err("#VALUE!");
}

export function formatNumber(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  const s = n.toPrecision(12);
  return s.includes("e") ? s.replace(/\.?0+e/, "e") : s.replace(/\.?0+$/, "");
}

export function formatValue(v: Value): string {
  if (isError(v)) return v.error;
  return toText(v) as string;
}

const rank = (v: Value) =>
  typeof v === "number" ? 0 : typeof v === "string" ? 1 : typeof v === "boolean" ? 2 : 0;

/** Spreadsheet ordering: numbers < text < booleans; text compares case-insensitively; empty acts as 0 or "". */
export function compare(a: Value, b: Value): number {
  if (a === null) a = typeof b === "string" ? "" : typeof b === "boolean" ? false : 0;
  if (b === null) b = typeof a === "string" ? "" : typeof a === "boolean" ? false : 0;
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "string" && typeof b === "string") {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = Number(a);
  const y = Number(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function finite(n: number): number | CellError {
  return Number.isFinite(n) ? n : err("#NUM!");
}

function block(r: Range, get: Lookup): Value[][] {
  const rows: Value[][] = [];
  for (let row = r.r0; row <= r.r1; row++) {
    const line: Value[] = [];
    for (let col = r.c0; col <= r.c1; col++) line.push(get(key(row, col)));
    rows.push(line);
  }
  return rows;
}

export function evaluate(n: Node, get: Lookup): Value {
  switch (n.t) {
    case "num":
      return n.v;
    case "str":
      return n.v;
    case "bool":
      return n.v;
    case "err":
      return err(n.code);
    case "ref": {
      const v = get(key(n.cell.row, n.cell.col));
      return v;
    }
    case "range":
      // A bare range outside a function has no single value.
      return err("#VALUE!");
    case "un": {
      const x = toNumber(evaluate(n.e, get));
      if (isError(x)) return x;
      return n.op === "-" ? -x : x;
    }
    case "pct": {
      const x = toNumber(evaluate(n.e, get));
      return isError(x) ? x : x / 100;
    }
    case "bin":
      return binary(n.op, evaluate(n.l, get), evaluate(n.r, get));
    case "call":
      return call(n.name, n.args, get);
  }
}

function binary(op: string, l: Value, r: Value): Value {
  if (isError(l)) return l;
  if (isError(r)) return r;
  if (op === "&") return `${toText(l)}${toText(r)}`;
  if (op === "=" || op === "<>" || op === "<" || op === "<=" || op === ">" || op === ">=") {
    const c = compare(l, r);
    switch (op) {
      case "=":
        return c === 0;
      case "<>":
        return c !== 0;
      case "<":
        return c < 0;
      case "<=":
        return c <= 0;
      case ">":
        return c > 0;
      default:
        return c >= 0;
    }
  }
  const x = toNumber(l);
  if (isError(x)) return x;
  const y = toNumber(r);
  if (isError(y)) return y;
  switch (op) {
    case "+":
      return finite(x + y);
    case "-":
      return finite(x - y);
    case "*":
      return finite(x * y);
    case "/":
      return y === 0 ? err("#DIV/0!") : finite(x / y);
    default:
      return finite(x ** y);
  }
}

function args(nodes: Node[], get: Lookup): Arg[] {
  return nodes.map((a) =>
    a.t === "range" ? { kind: "range", rows: block(a.range, get) } : { kind: "value", v: evaluate(a, get) },
  );
}

/** Values for aggregates: ranges skip text and empties; direct arguments are coerced. */
function numbers(as: Arg[]): number[] | CellError {
  const out: number[] = [];
  for (const a of as) {
    if (a.kind === "range") {
      for (const line of a.rows)
        for (const v of line) {
          if (isError(v)) return v;
          if (typeof v === "number") out.push(v);
        }
    } else {
      if (a.v === null) continue;
      const x = toNumber(a.v);
      if (isError(x)) return x;
      out.push(x);
    }
  }
  return out;
}

function flat(a: Arg): Value[] {
  return a.kind === "range" ? a.rows.flat() : [a.v];
}

function matcher(criterion: Value): (v: Value) => boolean {
  if (typeof criterion === "string") {
    const m = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(criterion)!;
    const op = m[1] ?? "=";
    const raw = m[2]!;
    const target: Value = NUMERIC.test(raw.trim()) ? Number(raw) : raw;
    return (v) => {
      if (isError(v)) return false;
      if (typeof target === "number" && typeof v !== "number") return op === "<>";
      const c = compare(v === null ? (typeof target === "number" ? null : "") : v, target);
      switch (op) {
        case "=":
          return c === 0;
        case "<>":
          return c !== 0;
        case "<":
          return c < 0;
        case "<=":
          return c <= 0;
        case ">":
          return c > 0;
        default:
          return c >= 0;
      }
    };
  }
  return (v) => !isError(v) && v !== null && compare(v, criterion) === 0;
}

const single = (a: Arg | undefined): Value =>
  a === undefined ? null : a.kind === "value" ? a.v : err("#VALUE!");

function call(name: string, nodes: Node[], get: Lookup): Value {
  // Lazy functions first: only the chosen branch is evaluated.
  if (name === "IF") {
    if (nodes.length < 2 || nodes.length > 3) return err("#N/A");
    const c = toBool(evaluate(nodes[0]!, get));
    if (isError(c)) return c;
    if (c) return evaluate(nodes[1]!, get);
    return nodes[2] ? evaluate(nodes[2], get) : false;
  }
  if (name === "IFERROR") {
    if (nodes.length !== 2) return err("#N/A");
    const v = evaluate(nodes[0]!, get);
    return isError(v) ? evaluate(nodes[1]!, get) : v;
  }
  const as = args(nodes, get);
  switch (name) {
    case "SUM": {
      const xs = numbers(as);
      return isError(xs) ? xs : finite(xs.reduce((s, x) => s + x, 0));
    }
    case "AVERAGE": {
      const xs = numbers(as);
      if (isError(xs)) return xs;
      return xs.length === 0 ? err("#DIV/0!") : finite(xs.reduce((s, x) => s + x, 0) / xs.length);
    }
    case "MIN":
    case "MAX": {
      const xs = numbers(as);
      if (isError(xs)) return xs;
      if (xs.length === 0) return 0;
      return name === "MIN" ? Math.min(...xs) : Math.max(...xs);
    }
    case "COUNT":
      return as.flatMap(flat).filter((v) => typeof v === "number").length;
    case "COUNTA":
      return as.flatMap(flat).filter((v) => v !== null && v !== "").length;
    case "AND":
    case "OR": {
      const bs: boolean[] = [];
      for (const v of as.flatMap(flat)) {
        if (v === null) continue;
        const b = toBool(v);
        if (isError(b)) return b;
        bs.push(b);
      }
      if (bs.length === 0) return err("#VALUE!");
      return name === "AND" ? bs.every(Boolean) : bs.some(Boolean);
    }
    case "NOT": {
      const b = toBool(single(as[0]));
      return isError(b) ? b : !b;
    }
    case "ABS": {
      const x = toNumber(single(as[0]));
      return isError(x) ? x : Math.abs(x);
    }
    case "ROUND": {
      const x = toNumber(single(as[0]));
      const d = toNumber(single(as[1]) ?? 0);
      if (isError(x)) return x;
      if (isError(d)) return d;
      const f = 10 ** Math.trunc(d);
      return finite((Math.sign(x) * Math.round(Math.abs(x) * f + 1e-9)) / f);
    }
    case "CONCAT": {
      let s = "";
      for (const v of as.flatMap(flat)) {
        const t = toText(v);
        if (isError(t)) return t;
        s += t;
      }
      return s;
    }
    case "LEN": {
      const t = toText(single(as[0]));
      return isError(t) ? t : t.length;
    }
    case "UPPER":
    case "LOWER": {
      const t = toText(single(as[0]));
      if (isError(t)) return t;
      return name === "UPPER" ? t.toUpperCase() : t.toLowerCase();
    }
    case "SUMIF":
    case "COUNTIF": {
      const range = as[0];
      if (range?.kind !== "range") return err("#VALUE!");
      const crit = single(as[1]);
      if (isError(crit)) return crit;
      const ok = matcher(crit);
      const vals = range.rows.flat();
      if (name === "COUNTIF") return vals.filter(ok).length;
      const sumRange = as[2];
      const sums = sumRange ? (sumRange.kind === "range" ? sumRange.rows.flat() : [sumRange.v]) : vals;
      let total = 0;
      for (let i = 0; i < vals.length; i++) {
        if (!ok(vals[i]!)) continue;
        const s = sums[i] ?? null;
        if (isError(s)) return s;
        if (typeof s === "number") total += s;
      }
      return finite(total);
    }
    case "VLOOKUP": {
      const needle = single(as[0]);
      const table = as[1];
      const idx = toNumber(single(as[2]));
      if (isError(needle)) return needle;
      if (table?.kind !== "range") return err("#VALUE!");
      if (isError(idx)) return idx;
      const col = Math.trunc(idx) - 1;
      if (col < 0 || col >= (table.rows[0]?.length ?? 0)) return err("#REF!");
      const approx = as[3] === undefined ? true : toBool(single(as[3]));
      if (isError(approx)) return approx;
      let hit = -1;
      for (let i = 0; i < table.rows.length; i++) {
        const c = compare(table.rows[i]![0] ?? null, needle);
        if (c === 0) {
          hit = i;
          break;
        }
        if (approx && c < 0) hit = i;
        if (approx && c > 0) break;
      }
      return hit < 0 ? err("#N/A") : (table.rows[hit]![col] ?? null);
    }
    default:
      return err("#NAME?");
  }
}
