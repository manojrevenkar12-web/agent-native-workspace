import { sheetMaps } from "@anw/sheets";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  acceptCells,
  acceptSuggestion,
  anchorAfterBlock,
  FRAGMENT,
  listSuggestions,
  plainText,
  rejectCells,
  rejectSuggestion,
  SuggestionWriter,
  suggestCells,
  textOf,
} from "../src/index.ts";

function seed(doc: Y.Doc, paragraphs: string[]) {
  const f = doc.getXmlFragment(FRAGMENT);
  doc.transact(() => {
    for (const p of paragraphs) {
      const el = new Y.XmlElement("paragraph");
      el.insert(0, [new Y.XmlText(p)]);
      f.insert(f.length, [el]);
    }
  });
}

function* texts(parent: Y.XmlFragment | Y.XmlElement): Generator<Y.XmlText> {
  for (const c of parent.toArray()) {
    if (c instanceof Y.XmlText) yield c;
    else if (c instanceof Y.XmlElement) yield* texts(c);
  }
}

type Op = { insert: unknown; attributes?: { suggestion?: { id: string } } };

function split(doc: Y.Doc, id: string) {
  let agent = "";
  let human = "";
  for (const t of texts(doc.getXmlFragment(FRAGMENT)))
    for (const op of t.toDelta() as Op[]) {
      if (typeof op.insert !== "string") continue;
      if (op.attributes?.suggestion?.id === id) agent += op.insert;
      else human += op.insert;
    }
  return { agent, human };
}

/** What a stream should leave as text: line contents without their markers, in order. */
const contentOf = (text: string) =>
  text
    .split("\n")
    .map((l) => l.replace(/^(#{1,2} |- )/, ""))
    .join("");

const DRAFT = "## Plan\nWe launch on Friday.\n- Venue booked\n- Press list ready\nQuestions go to Lena.\n";

describe("streaming suggestions", () => {
  it("writes headings, paragraphs and bullets after the anchor as suggestions", () => {
    const doc = new Y.Doc();
    seed(doc, ["Intro", "Outro"]);
    const w = new SuggestionWriter(doc, { id: "s1", author: "assistant" }, anchorAfterBlock(doc, 0));
    for (const ch of DRAFT) {
      w.write(ch);
      w.flush();
    }
    w.finish();
    const names = doc
      .getXmlFragment(FRAGMENT)
      .toArray()
      .map((e) => (e as Y.XmlElement).nodeName);
    expect(names).toEqual(["paragraph", "heading", "paragraph", "bulletList", "paragraph", "paragraph"]);
    expect(plainText(doc).split("\n")).toEqual([
      "Intro",
      "Plan",
      "We launch on Friday.",
      "Venue booked",
      "Press list ready",
      "Questions go to Lena.",
      "Outro",
    ]);
    const [s] = listSuggestions(doc);
    expect(s).toMatchObject({ id: "s1", author: "assistant", blocks: 6 });
  });

  it("accept keeps the text; reject removes it and keeps what people typed", () => {
    const make = () => {
      const doc = new Y.Doc();
      seed(doc, ["Intro"]);
      const w = new SuggestionWriter(doc, { id: "s1", author: "assistant" }, anchorAfterBlock(doc, 0));
      w.write(DRAFT);
      w.finish();
      return doc;
    };
    const a = make();
    acceptSuggestion(a, "s1");
    expect(listSuggestions(a)).toEqual([]);
    expect(plainText(a)).toContain("We launch on Friday.");

    const r = make();
    // A person types into the agent's paragraph before rejecting.
    const para = r.getXmlFragment(FRAGMENT).get(2) as Y.XmlElement;
    (para.get(0) as Y.XmlText).insert(0, "Note: ");
    rejectSuggestion(r, "s1");
    expect(plainText(r).split("\n")).toEqual(["Intro", "Note: "]);
    expect(listSuggestions(r)).toEqual([]);
  });

  it("yields when a person deletes what the agent is writing", () => {
    const doc = new Y.Doc();
    seed(doc, ["Intro"]);
    const w = new SuggestionWriter(doc, { id: "s1", author: "assistant" }, anchorAfterBlock(doc, 0));
    w.write("A first sentence that is long enough.");
    w.flush();
    const p = doc.getXmlFragment(FRAGMENT).get(1) as Y.XmlElement;
    (p.get(0) as Y.XmlText).delete(0, 2);
    w.write(" More.");
    w.flush();
    expect(w.yielded).toEqual({ reason: "edited" });
    expect(textOf(p.get(0) as Y.XmlText)).toBe("first sentence that is long enough.");
  });

  it("keeps every character people type and the agent's text in order, under any interleaving", () => {
    const humanOp = fc.record({
      at: fc.nat(),
      offset: fc.nat(),
      text: fc.string({ minLength: 1, maxLength: 4, unit: fc.constantFrom("x", "y", "z", " ") }),
      newBlock: fc.boolean(),
    });
    const step = fc.oneof(
      fc.record({ who: fc.constant("agent" as const), chunk: fc.integer({ min: 1, max: 9 }) }),
      fc.record({ who: fc.constant("human" as const), op: humanOp }),
      fc.record({
        who: fc.constant("deliver" as const),
        toAgent: fc.boolean(),
        n: fc.integer({ min: 1, max: 4 }),
      }),
    );
    fc.assert(
      fc.property(fc.array(step, { minLength: 5, maxLength: 60 }), (steps) => {
        const agentDoc = new Y.Doc();
        const humanDoc = new Y.Doc();
        seed(agentDoc, ["Alpha", "Beta"]);
        Y.applyUpdate(humanDoc, Y.encodeStateAsUpdate(agentDoc));
        const toHuman: Uint8Array[] = [];
        const toAgent: Uint8Array[] = [];
        agentDoc.on("update", (u: Uint8Array, origin: unknown) => origin !== "net" && toHuman.push(u));
        humanDoc.on("update", (u: Uint8Array, origin: unknown) => origin !== "net" && toAgent.push(u));
        const w = new SuggestionWriter(
          agentDoc,
          { id: "s", author: "assistant" },
          anchorAfterBlock(agentDoc, 0),
        );
        let fed = 0;
        let typed = 0;
        const deliver = (q: Uint8Array[], to: Y.Doc, n: number) => {
          for (const u of q.splice(0, n)) Y.applyUpdate(to, u, "net");
        };
        for (const s of steps) {
          if (s.who === "agent") {
            const piece = DRAFT.slice(fed, fed + s.chunk);
            fed += piece.length;
            w.write(piece);
            w.flush();
          } else if (s.who === "deliver") {
            if (s.toAgent) deliver(toAgent, agentDoc, s.n);
            else deliver(toHuman, humanDoc, s.n);
          } else {
            const f = humanDoc.getXmlFragment(FRAGMENT);
            humanDoc.transact(() => {
              if (s.op.newBlock) {
                const el = new Y.XmlElement("paragraph");
                el.insert(0, [new Y.XmlText(s.op.text)]);
                f.insert(s.op.at % (f.length + 1), [el]);
              } else {
                const all = [...texts(f)];
                const t = all[s.op.at % all.length]!;
                // People's typing never carries the agent's mark (the editor strips it too);
                // without this Yjs would inherit the formatting to the left.
                t.insert(s.op.offset % (t.length + 1), s.op.text, { suggestion: null });
              }
            });
            typed += s.op.text.length;
          }
        }
        w.write(DRAFT.slice(fed));
        w.finish();
        deliver(toAgent, agentDoc, Number.POSITIVE_INFINITY);
        deliver(toHuman, humanDoc, Number.POSITIVE_INFINITY);
        expect(agentDoc.getXmlFragment(FRAGMENT).toJSON()).toBe(humanDoc.getXmlFragment(FRAGMENT).toJSON());
        expect(w.yielded).toBeNull();
        const { agent, human } = split(humanDoc, "s");
        expect(agent).toBe(contentOf(DRAFT));
        expect(human.length).toBe("AlphaBeta".length + typed);
      }),
      { numRuns: 300 },
    );
  });
});

describe("sheet suggestions", () => {
  it("rejecting puts back what each cell held", () => {
    const doc = new Y.Doc();
    const { cells, pending } = sheetMaps(doc);
    cells.set("C2", "old");
    suggestCells(doc, "f1", [
      ["C2", "Travel"],
      ["C3", "Food"],
    ]);
    expect(pending.size).toBe(2);
    rejectCells(doc, "f1");
    expect(cells.get("C2")).toBe("old");
    expect(cells.has("C3")).toBe(false);
    suggestCells(doc, "f2", [["C3", "Venue"]]);
    acceptCells(doc, "f2");
    expect(cells.get("C3")).toBe("Venue");
    expect(pending.size).toBe(0);
  });
});
