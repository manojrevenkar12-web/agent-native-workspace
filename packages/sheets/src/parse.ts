import { type Cell, normalise, parseA1, type Range } from "./address.ts";

export type ErrorCode = "#DIV/0!" | "#REF!" | "#NAME?" | "#VALUE!" | "#CYCLE!" | "#N/A" | "#PARSE!" | "#NUM!";

export type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "ref"; cell: Cell }
  | { t: "range"; range: Range }
  | { t: "call"; name: string; args: Node[] }
  | { t: "un"; op: "-" | "+"; e: Node }
  | { t: "pct"; e: Node }
  | { t: "bin"; op: BinOp; l: Node; r: Node }
  | { t: "err"; code: ErrorCode };

export type BinOp = "+" | "-" | "*" | "/" | "^" | "&" | "=" | "<>" | "<" | "<=" | ">" | ">=";

type Tok =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "id"; v: string }
  | { k: "op"; v: string }
  | { k: "end" };

export class ParseError extends Error {}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === " " || ch === "\t" || ch === "\n") {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const m = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (!m) throw new ParseError(`bad number at ${i}`);
      out.push({ k: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let s = "";
      for (;;) {
        if (j >= src.length) throw new ParseError("unterminated string");
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            s += '"';
            j += 2;
            continue;
          }
          break;
        }
        s += src[j];
        j++;
      }
      out.push({ k: "str", v: s });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_.$]*/.exec(src.slice(i))!;
      out.push({ k: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    if (ch === "#") {
      const m = /^#(DIV\/0!|REF!|NAME\?|VALUE!|CYCLE!|N\/A|NUM!)/.exec(src.slice(i));
      if (!m) throw new ParseError(`bad error literal at ${i}`);
      out.push({ k: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") {
      out.push({ k: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/^&=<>(),:%;".includes(ch)) {
      out.push({ k: "op", v: ch === ";" ? "," : ch });
      i++;
      continue;
    }
    throw new ParseError(`unexpected "${ch}" at ${i}`);
  }
  out.push({ k: "end" });
  return out;
}

const BINARY: Record<string, [number, BinOp]> = {
  "=": [1, "="],
  "<>": [1, "<>"],
  "<": [1, "<"],
  "<=": [1, "<="],
  ">": [1, ">"],
  ">=": [1, ">="],
  "&": [2, "&"],
  "+": [3, "+"],
  "-": [3, "-"],
  "*": [4, "*"],
  "/": [4, "/"],
  "^": [5, "^"],
};

/** Parses a formula body (without the leading "="). */
export function parseFormula(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p]!;
  const next = () => toks[p++]!;
  const isOp = (v: string) => {
    const t = peek();
    return t.k === "op" && t.v === v;
  };
  const expect = (v: string) => {
    if (!isOp(v)) throw new ParseError(`expected "${v}"`);
    p++;
  };

  function primary(): Node {
    const t = next();
    if (t.k === "num") return { t: "num", v: t.v };
    if (t.k === "str") return { t: "str", v: t.v };
    if (t.k === "op" && t.v === "(") {
      const e = expr(0);
      expect(")");
      return e;
    }
    if (t.k === "op" && (t.v === "-" || t.v === "+")) {
      return { t: "un", op: t.v, e: unaryOperand() };
    }
    if (t.k === "id") {
      if (t.v.startsWith("#")) return { t: "err", code: t.v as ErrorCode };
      const upper = t.v.toUpperCase();
      if (isOp("(")) {
        p++;
        const args: Node[] = [];
        if (!isOp(")")) {
          for (;;) {
            args.push(expr(0));
            if (isOp(",")) {
              p++;
              continue;
            }
            break;
          }
        }
        expect(")");
        return { t: "call", name: upper, args };
      }
      if (upper === "TRUE" || upper === "FALSE") return { t: "bool", v: upper === "TRUE" };
      const a = parseA1(t.v);
      if (a) {
        if (isOp(":")) {
          p++;
          const bt = next();
          const b = bt.k === "id" ? parseA1(bt.v) : null;
          if (!b) return { t: "err", code: "#REF!" };
          return { t: "range", range: normalise(a, b) };
        }
        return { t: "ref", cell: a };
      }
      return { t: "err", code: "#NAME?" };
    }
    throw new ParseError("unexpected end of formula");
  }

  // Unary minus binds tighter than ^ in spreadsheets: -2^2 = 4.
  function unaryOperand(): Node {
    let e = primary();
    while (isOp("%")) {
      p++;
      e = { t: "pct", e };
    }
    return e;
  }

  function expr(minPrec: number): Node {
    let left = unaryOperand();
    for (;;) {
      const t = peek();
      if (t.k !== "op") break;
      const b = BINARY[t.v];
      if (!b || b[0] < minPrec) break;
      p++;
      // ^ is left-associative in spreadsheets (2^3^2 = 64).
      const right = expr(b[0] + 1);
      left = { t: "bin", op: b[1], l: left, r: right };
    }
    return left;
  }

  const ast = expr(0);
  if (peek().k !== "end") throw new ParseError("unexpected trailing input");
  return ast;
}

/** Every cell and range a formula reads. */
export function references(
  n: Node,
  cells: Cell[] = [],
  ranges: Range[] = [],
): { cells: Cell[]; ranges: Range[] } {
  switch (n.t) {
    case "ref":
      cells.push(n.cell);
      break;
    case "range":
      ranges.push(n.range);
      break;
    case "call":
      for (const a of n.args) references(a, cells, ranges);
      break;
    case "un":
    case "pct":
      references(n.e, cells, ranges);
      break;
    case "bin":
      references(n.l, cells, ranges);
      references(n.r, cells, ranges);
      break;
    default:
      break;
  }
  return { cells, ranges };
}
