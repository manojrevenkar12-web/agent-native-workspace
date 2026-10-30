import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  bindSheet,
  colIndex,
  colName,
  Engine,
  formatValue,
  key,
  parseFormula,
  sheetMaps,
} from "../src/index.ts";

const show = (e: Engine, k: string) => formatValue(e.get(k));

describe("addresses", () => {
  it("round-trips column names", () => {
    for (const c of [0, 25, 26, 51, 701]) expect(colIndex(colName(c))).toBe(c);
    expect(colName(26)).toBe("AA");
    expect(key(0, 0)).toBe("A1");
  });
});

describe("formulas", () => {
  const cases: [string, string][] = [
    ["=1+2*3", "7"],
    ["=(1+2)*3", "9"],
    ["=-2^2", "4"],
    ["=2^3^2", "64"],
    ["=10%", "0.1"],
    ['="a"&"b"&1', "ab1"],
    ["=1/0", "#DIV/0!"],
    ['=1+"x"', "#VALUE!"],
    ["=NOPE(1)", "#NAME?"],
    ["=1+", "#PARSE!"],
    ['=IF(1>2,"yes","no")', "no"],
    ["=IFERROR(1/0,42)", "42"],
    ["=ROUND(2.345,2)", "2.35"],
    ["=AND(TRUE,1)", "TRUE"],
    ['="B"<"a"', "FALSE"],
    ["=0.1+0.2", "0.3"],
    ['=LEN("hello")', "5"],
    ['=UPPER("ok")', "OK"],
  ];
  it.each(cases)("%s → %s", (src, want) => {
    const e = new Engine();
    e.set("A1", src);
    expect(show(e, "A1")).toBe(want);
  });

  it("aggregates skip text in ranges but not in arguments", () => {
    const e = new Engine();
    e.setMany([
      ["A1", "1"],
      ["A2", "two"],
      ["A3", "3"],
      ["B1", "=SUM(A1:A3)"],
      ["B2", "=SUM(A1,A2)"],
      ["B3", "=AVERAGE(A1:A3)"],
      ["B4", "=COUNTA(A1:A3)"],
      ["B5", "=COUNT(A1:A3)"],
    ]);
    expect(show(e, "B1")).toBe("4");
    expect(show(e, "B2")).toBe("#VALUE!");
    expect(show(e, "B3")).toBe("2");
    expect(show(e, "B4")).toBe("3");
    expect(show(e, "B5")).toBe("2");
  });

  it("SUMIF, COUNTIF and VLOOKUP", () => {
    const e = new Engine();
    e.setMany([
      ["A1", "travel"],
      ["B1", "120"],
      ["A2", "venue"],
      ["B2", "900"],
      ["A3", "travel"],
      ["B3", "80"],
      ["C1", '=SUMIF(A1:A3,"travel",B1:B3)'],
      ["C2", '=COUNTIF(B1:B3,">=100")'],
      ["C3", '=VLOOKUP("venue",A1:B3,2,FALSE)'],
      ["C4", '=VLOOKUP("food",A1:B3,2,FALSE)'],
    ]);
    expect(show(e, "C1")).toBe("200");
    expect(show(e, "C2")).toBe("2");
    expect(show(e, "C3")).toBe("900");
    expect(show(e, "C4")).toBe("#N/A");
  });

  it("parses ranges, absolute references and semicolons as argument separators", () => {
    expect(parseFormula("SUM($A$1:B2; 3)")).toMatchObject({ t: "call", name: "SUM" });
  });
});

describe("recalculation", () => {
  it("recomputes only what an edit reaches", () => {
    const e = new Engine();
    const rows: [string, string][] = [];
    for (let r = 1; r <= 100; r++) {
      rows.push([`A${r}`, String(r)]);
      rows.push([`B${r}`, `=A${r}*2`]);
    }
    rows.push(["C1", "=SUM(B1:B100)"]);
    e.setMany(rows);
    expect(show(e, "C1")).toBe("10100");
    e.evaluations = 0;
    const changed = e.set("A50", "1000");
    expect(e.evaluations).toBe(2); // B50 and C1, not the other 99 rows
    expect(changed.sort()).toEqual(["A50", "B50", "C1"]);
    expect(show(e, "C1")).toBe(String(10100 - 100 + 2000));
  });

  it("marks cycles and lets their dependents read the error", () => {
    const e = new Engine();
    e.setMany([
      ["A1", "=B1+1"],
      ["B1", "=A1+1"],
      ["C1", "=IFERROR(A1,5)"],
      ["D1", "=D1"],
    ]);
    expect(show(e, "A1")).toBe("#CYCLE!");
    expect(show(e, "B1")).toBe("#CYCLE!");
    expect(show(e, "C1")).toBe("5");
    expect(show(e, "D1")).toBe("#CYCLE!");
    e.set("B1", "1");
    expect(show(e, "A1")).toBe("2");
    expect(show(e, "C1")).toBe("2");
  });

  it("handles a 100,000-cell chain without overflowing the stack", () => {
    const e = new Engine();
    const rows: [string, string][] = [["A1", "1"]];
    for (let r = 2; r <= 100_000; r++) rows.push([`A${r}`, `=A${r - 1}+1`]);
    const t0 = performance.now();
    e.setMany(rows);
    expect(show(e, "A100000")).toBe("100000");
    e.set("A1", "10");
    expect(show(e, "A100000")).toBe("100009");
    expect(performance.now() - t0).toBeLessThan(10_000);
  });

  it("deleting a cell clears it and updates readers", () => {
    const e = new Engine();
    e.setMany([
      ["A1", "4"],
      ["B1", "=A1*A1"],
    ]);
    e.set("A1", "");
    expect(show(e, "B1")).toBe("0");
    expect(e.input("A1")).toBe("");
  });
});

// Random sheets: incremental recalculation must equal recomputing from scratch after every edit.
const CELLS = ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3"];
const ref = fc.constantFrom(...CELLS);
const leaf = fc.oneof(ref, fc.integer({ min: -5, max: 9 }).map(String), fc.constantFrom('"x"', "TRUE"));
const expr: fc.Arbitrary<string> = fc.letrec<{ e: string }>((tie) => ({
  e: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    leaf,
    fc
      .tuple(tie("e"), fc.constantFrom("+", "-", "*", "/", "&", ">", "="), tie("e"))
      .map(([a, o, b]) => `(${a}${o}${b})`),
    fc.tuple(ref, ref).map(([a, b]) => `SUM(${a}:${b})`),
    fc.tuple(tie("e"), tie("e"), tie("e")).map(([a, b, c]) => `IF(${a},${b},${c})`),
    fc.tuple(tie("e"), tie("e")).map(([a, b]) => `IFERROR(${a},${b})`),
    fc.tuple(ref, ref).map(([a, b]) => `COUNTIF(${a}:${b},">0")`),
  ),
})).e;
const input = fc.oneof(
  fc.constant(""),
  fc.integer({ min: -9, max: 9 }).map(String),
  fc.constantFrom("hello", "TRUE", "1.5", "50%"),
  expr.map((e) => `=${e}`),
);

describe("incremental equals full recompute", () => {
  it("holds for random edit sequences", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(ref, input), { minLength: 1, maxLength: 30 }), (edits) => {
        const live = new Engine();
        for (const [k, raw] of edits) {
          live.set(k, raw);
          const fresh = new Engine();
          fresh.setMany([...live.cells()]);
          for (const c of CELLS) expect(show(live, c)).toBe(show(fresh, c));
        }
      }),
      { numRuns: 400 },
    );
  });
});

describe("shared sheets", () => {
  it("two documents that exchange updates compute the same values", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on("update", (u: Uint8Array) => Y.applyUpdate(b, u));
    b.on("update", (u: Uint8Array) => Y.applyUpdate(a, u));
    const seen: string[][] = [];
    const ea = bindSheet(a, (c) => seen.push(c));
    const eb = bindSheet(b, () => {});
    sheetMaps(a).cells.set("A1", "2");
    sheetMaps(b).cells.set("A2", "=A1*21");
    expect(formatValue(ea.engine.get("A2"))).toBe("42");
    expect(formatValue(eb.engine.get("A2"))).toBe("42");
    expect(seen.flat()).toContain("A2");
    ea.dispose();
    eb.dispose();
  });
});
