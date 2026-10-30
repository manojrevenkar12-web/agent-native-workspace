import { cellOf, inRange, key, type Range } from "./address.ts";
import { err, evaluate, isError, type Value } from "./evaluate.ts";
import { type Node, ParseError, parseFormula, references } from "./parse.ts";

const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** What a raw cell input means when it is not a formula. */
export function literal(raw: string): Value {
  if (raw === "") return null;
  if (raw.startsWith("'")) return raw.slice(1);
  const s = raw.trim();
  if (NUMERIC.test(s)) return Number(s);
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)%$/.test(s)) return Number(s.slice(0, -1)) / 100;
  const u = s.toUpperCase();
  if (u === "TRUE" || u === "FALSE") return u === "TRUE";
  return raw;
}

interface Formula {
  ast: Node | null; // null: did not parse
  cells: string[];
  ranges: Range[];
}

function sameValue(a: Value | undefined, b: Value | undefined): boolean {
  if (a === b) return true;
  if (isError(a) && isError(b)) return a.error === b.error;
  return (a ?? null) === (b ?? null);
}

/**
 * A spreadsheet that recalculates only what an edit can affect.
 *
 * Inputs are raw strings (what a person typed). Formulas keep a dependency graph: single-cell
 * references in a reverse index, ranges in a per-column index. An edit marks the edited cells and
 * everything that transitively reads them; those formulas are ordered by strongly connected
 * components (Tarjan, iterative so a 100k-long chain does not overflow the stack), and every
 * component that is a real cycle evaluates to #CYCLE!. Recomputing from scratch gives the same
 * values; the property test checks exactly that.
 */
export class Engine {
  private readonly inputs = new Map<string, string>();
  private readonly formulas = new Map<string, Formula>();
  private readonly values = new Map<string, Value>();
  private readonly cellDependents = new Map<string, Set<string>>();
  private readonly rangeDependents = new Map<number, Set<string>>(); // column → formulas with a range over it
  evaluations = 0;

  get(k: string): Value {
    return this.values.get(k) ?? null;
  }

  input(k: string): string {
    return this.inputs.get(k) ?? "";
  }

  cells(): IterableIterator<[string, string]> {
    return this.inputs.entries();
  }

  /** Sets one cell; returns the cells whose value changed. */
  set(k: string, raw: string): string[] {
    return this.setMany([[k, raw]]);
  }

  setMany(entries: Iterable<readonly [string, string]>): string[] {
    const edited: string[] = [];
    for (const [k, raw] of entries) {
      this.unlink(k);
      if (raw === "") this.inputs.delete(k);
      else this.inputs.set(k, raw);
      if (raw.startsWith("=")) this.link(k, raw.slice(1));
      edited.push(k);
    }
    return this.recalculate(edited);
  }

  private link(k: string, body: string): void {
    let f: Formula;
    try {
      const ast = parseFormula(body);
      const refs = references(ast);
      f = { ast, cells: [...new Set(refs.cells.map((c) => key(c.row, c.col)))], ranges: refs.ranges };
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      f = { ast: null, cells: [], ranges: [] };
    }
    this.formulas.set(k, f);
    for (const c of f.cells) {
      let s = this.cellDependents.get(c);
      if (!s) this.cellDependents.set(c, (s = new Set()));
      s.add(k);
    }
    for (const r of f.ranges)
      for (let col = r.c0; col <= r.c1; col++) {
        let s = this.rangeDependents.get(col);
        if (!s) this.rangeDependents.set(col, (s = new Set()));
        s.add(k);
      }
  }

  private unlink(k: string): void {
    const f = this.formulas.get(k);
    if (!f) return;
    for (const c of f.cells) this.cellDependents.get(c)?.delete(k);
    for (const r of f.ranges)
      for (let col = r.c0; col <= r.c1; col++) this.rangeDependents.get(col)?.delete(k);
    this.formulas.delete(k);
  }

  /** Formulas that read cell k directly. */
  private dependentsOf(k: string): string[] {
    const out: string[] = [];
    const direct = this.cellDependents.get(k);
    if (direct) out.push(...direct);
    const { row, col } = cellOf(k);
    const byCol = this.rangeDependents.get(col);
    if (byCol)
      for (const f of byCol) {
        if (this.formulas.get(f)!.ranges.some((r) => inRange(r, row, col))) out.push(f);
      }
    return out;
  }

  private recalculate(edited: string[]): string[] {
    // 1. Everything an edit can reach.
    const dirty = new Set<string>(edited);
    const queue = [...edited];
    while (queue.length) {
      const k = queue.pop()!;
      for (const d of this.dependentsOf(k))
        if (!dirty.has(d)) {
          dirty.add(d);
          queue.push(d);
        }
    }
    const changed: string[] = [];
    const assign = (k: string, v: Value) => {
      if (!sameValue(this.values.get(k), v)) changed.push(k);
      if (v === null) this.values.delete(k);
      else this.values.set(k, v);
    };
    // 2. Plain inputs take their literal value.
    const dirtyFormulas: string[] = [];
    for (const k of dirty) {
      if (this.formulas.has(k)) dirtyFormulas.push(k);
      else assign(k, literal(this.inputs.get(k) ?? ""));
    }
    // 3. Formulas in dependency order, cycles as #CYCLE!.
    for (const scc of this.components(dirtyFormulas, dirty)) {
      if (scc.cyclic) {
        for (const k of scc.members) assign(k, err("#CYCLE!"));
        continue;
      }
      const k = scc.members[0]!;
      const f = this.formulas.get(k)!;
      this.evaluations++;
      assign(k, f.ast ? evaluate(f.ast, (c) => this.get(c)) : err("#PARSE!"));
    }
    return changed;
  }

  /** Precedents of formula k that are themselves dirty formulas. */
  private dirtyPrecedents(k: string, dirtyFormulas: Set<string>, byCol: Map<number, number[]>): string[] {
    const f = this.formulas.get(k)!;
    const out: string[] = [];
    for (const c of f.cells) if (dirtyFormulas.has(c)) out.push(c);
    for (const r of f.ranges)
      for (let col = r.c0; col <= r.c1; col++) {
        const rows = byCol.get(col);
        if (!rows) continue;
        let lo = 0;
        let hi = rows.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (rows[mid]! < r.r0) lo = mid + 1;
          else hi = mid;
        }
        for (let i = lo; i < rows.length && rows[i]! <= r.r1; i++) out.push(key(rows[i]!, col));
      }
    return out;
  }

  /** Strongly connected components in evaluation order (precedents first). */
  private components(formulas: string[], _dirty: Set<string>): { members: string[]; cyclic: boolean }[] {
    const set = new Set(formulas);
    const byCol = new Map<number, number[]>();
    for (const k of formulas) {
      const { row, col } = cellOf(k);
      let rows = byCol.get(col);
      if (!rows) byCol.set(col, (rows = []));
      rows.push(row);
    }
    for (const rows of byCol.values()) rows.sort((a, b) => a - b);

    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const out: { members: string[]; cyclic: boolean }[] = [];
    let counter = 0;
    // Deterministic order so equal inputs give equal evaluation traces.
    const roots = [...formulas].sort();
    for (const root of roots) {
      if (index.has(root)) continue;
      const work: { k: string; edges: string[]; i: number }[] = [];
      const enter = (k: string) => {
        index.set(k, counter);
        low.set(k, counter);
        counter++;
        stack.push(k);
        onStack.add(k);
        work.push({ k, edges: this.dirtyPrecedents(k, set, byCol), i: 0 });
      };
      enter(root);
      while (work.length) {
        const top = work[work.length - 1]!;
        if (top.i < top.edges.length) {
          const w = top.edges[top.i++]!;
          if (!index.has(w)) enter(w);
          else if (onStack.has(w)) low.set(top.k, Math.min(low.get(top.k)!, index.get(w)!));
          continue;
        }
        work.pop();
        const parent = work[work.length - 1];
        if (parent) low.set(parent.k, Math.min(low.get(parent.k)!, low.get(top.k)!));
        if (low.get(top.k) === index.get(top.k)) {
          const members: string[] = [];
          for (;;) {
            const w = stack.pop()!;
            onStack.delete(w);
            members.push(w);
            if (w === top.k) break;
          }
          const cyclic = members.length > 1 || top.edges.includes(top.k);
          out.push({ members, cyclic });
        }
      }
    }
    return out;
  }
}
