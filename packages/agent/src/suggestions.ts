import * as Y from "yjs";

/**
 * Agent edits are suggestions. Text the agent writes carries a `suggestion` format attribute
 * ({ id, author }) and blocks it creates carry a `suggestion` attribute with the id, which the
 * editor renders as tracked changes. A person accepts (the marks go, the text stays) or rejects
 * (the agent's text goes, anything a person typed stays). The agent never edits people's text.
 */

export const FRAGMENT = "content";
export const AGENT_ORIGIN = "agent";

export interface SuggestionAttr {
  id: string;
  author: string;
}

export interface SuggestionInfo {
  id: string;
  author: string;
  chars: number;
  blocks: number;
  preview: string;
}

type Node = Y.XmlElement | Y.XmlText;

function* walk(parent: Y.XmlFragment | Y.XmlElement): Generator<Node> {
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlElement) {
      yield child;
      yield* walk(child);
    } else if (child instanceof Y.XmlText) {
      yield child;
    }
  }
}

interface DeltaOp {
  insert: unknown;
  attributes?: Record<string, unknown>;
}

const suggestionOf = (op: DeltaOp): SuggestionAttr | undefined => {
  const s = op.attributes?.suggestion as SuggestionAttr | null | undefined;
  return s && typeof s === "object" && typeof s.id === "string" ? s : undefined;
};

/** [index, length] runs of text in `t` that belong to suggestion `id`. */
function runs(t: Y.XmlText, id: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  for (const op of t.toDelta() as DeltaOp[]) {
    const len = typeof op.insert === "string" ? op.insert.length : 1;
    if (suggestionOf(op)?.id === id) out.push([i, len]);
    i += len;
  }
  return out;
}

/** Characters in `t` that are not part of any suggestion: what people typed. */
function humanChars(t: Y.XmlText): number {
  let n = 0;
  for (const op of t.toDelta() as DeltaOp[]) {
    if (typeof op.insert === "string" && !suggestionOf(op)) n += op.insert.length;
  }
  return n;
}

function hasHumanText(el: Y.XmlElement): boolean {
  for (const n of walk(el)) if (n instanceof Y.XmlText && humanChars(n) > 0) return true;
  return false;
}

export function textOf(t: Y.XmlText): string {
  return (t.toDelta() as DeltaOp[]).map((op) => (typeof op.insert === "string" ? op.insert : "")).join("");
}

export function listSuggestions(doc: Y.Doc): SuggestionInfo[] {
  const found = new Map<string, SuggestionInfo>();
  const get = (id: string, author: string) => {
    let s = found.get(id);
    if (!s) found.set(id, (s = { id, author, chars: 0, blocks: 0, preview: "" }));
    return s;
  };
  for (const n of walk(doc.getXmlFragment(FRAGMENT))) {
    if (n instanceof Y.XmlElement) {
      const id = n.getAttribute("suggestion");
      if (typeof id === "string") get(id, "").blocks++;
      continue;
    }
    for (const op of n.toDelta() as DeltaOp[]) {
      const s = suggestionOf(op);
      if (!s || typeof op.insert !== "string") continue;
      const info = get(s.id, s.author);
      info.author ||= s.author;
      info.chars += op.insert.length;
      if (info.preview.length < 120) info.preview = `${info.preview} ${op.insert}`.trim().slice(0, 120);
    }
  }
  return [...found.values()].filter((s) => s.chars > 0 || s.blocks > 0);
}

/** Keeps the agent's text and makes it ordinary text. */
export function acceptSuggestion(doc: Y.Doc, id: string, origin: unknown = "accept"): void {
  doc.transact(() => {
    for (const n of [...walk(doc.getXmlFragment(FRAGMENT))]) {
      if (n instanceof Y.XmlElement) {
        if (n.getAttribute("suggestion") === id) n.removeAttribute("suggestion");
      } else {
        for (const [i, len] of runs(n, id)) n.format(i, len, { suggestion: null });
      }
    }
  }, origin);
}

/** Removes the agent's text; blocks it created go too unless a person typed in them. */
export function rejectSuggestion(doc: Y.Doc, id: string, origin: unknown = "reject"): void {
  doc.transact(() => {
    const fragment = doc.getXmlFragment(FRAGMENT);
    for (const n of [...walk(fragment)]) {
      if (n instanceof Y.XmlText) for (const [i, len] of runs(n, id).reverse()) n.delete(i, len);
    }
    // Innermost first, so a list emptied of its items can go as well.
    const created = [...walk(fragment)].filter(
      (n): n is Y.XmlElement => n instanceof Y.XmlElement && n.getAttribute("suggestion") === id,
    );
    for (const el of created.reverse()) {
      const parent = el.parent as Y.XmlElement | Y.XmlFragment | null;
      if (!parent || el._item?.deleted) continue;
      if (hasHumanText(el)) {
        el.removeAttribute("suggestion");
        continue;
      }
      const idx = parent.toArray().indexOf(el);
      if (idx >= 0) parent.delete(idx, 1);
    }
    // A document must keep at least one block for the editor to place a cursor.
    if (fragment.length === 0) fragment.insert(0, [new Y.XmlElement("paragraph")]);
  }, origin);
}

export type Yield = { reason: "edited" | "removed" };

/**
 * Streams an agent's draft into a shared document as new blocks after an anchor, while people
 * keep typing. Positions are Yjs relative positions tied to the agent's own last block and
 * character, so concurrent edits never move the agent into someone else's sentence, and the
 * agent's text stays contiguous. If a person deletes or accepts any of the text being written,
 * the writer yields: it stops and leaves what is there for review.
 *
 * Lines become blocks: "# " and "## " start headings, "- " starts a bullet item, anything else
 * a paragraph.
 */
export class SuggestionWriter {
  private buffer = "";
  private atBlockStart = true;
  private nextBlock: Y.RelativePosition | null;
  private text: Y.XmlText | null = null;
  private textEnd: Y.RelativePosition | null = null;
  private list: Y.XmlElement | null = null;
  private readonly written = new Map<Y.XmlText, number>();
  private readonly blocks: Y.XmlElement[] = [];
  yielded: Yield | null = null;
  chars = 0;

  constructor(
    private readonly doc: Y.Doc,
    readonly suggestion: SuggestionAttr,
    /** Insert after the top-level block this relative position points at; end of document if absent. */
    anchor?: Y.RelativePosition,
    private readonly origin: unknown = AGENT_ORIGIN,
  ) {
    this.nextBlock = anchor ?? null;
  }

  write(chunk: string): void {
    this.buffer += chunk;
  }

  /** Applies buffered text in one transaction (one network update). */
  flush(final = false): void {
    if (this.yielded || this.buffer === "") return;
    this.check();
    if (this.yielded) return;
    this.doc.transact(() => {
      while (this.buffer.length) {
        if (this.atBlockStart) {
          const nl = this.buffer.indexOf("\n");
          const head = nl < 0 ? this.buffer : this.buffer.slice(0, nl);
          // Wait for enough characters to know what kind of block this is.
          if (nl < 0 && !final && head.length < 3 && /^[#-]/.test(head)) return;
          if (nl === 0) {
            this.buffer = this.buffer.slice(1);
            continue;
          }
          const m = /^(#{1,2}) |^- /.exec(head);
          this.buffer = this.buffer.slice(m ? m[0].length : 0);
          if (m?.[1]) this.openBlock("heading", { level: m[1].length });
          else if (m) this.openBlock("listItem");
          else this.openBlock("paragraph");
          this.atBlockStart = false;
          continue;
        }
        const nl = this.buffer.indexOf("\n");
        const piece = nl < 0 ? this.buffer : this.buffer.slice(0, nl);
        if (piece) this.insertText(piece);
        if (nl < 0) {
          this.buffer = "";
        } else {
          this.buffer = this.buffer.slice(nl + 1);
          this.atBlockStart = true;
        }
      }
    }, this.origin);
  }

  finish(): void {
    this.flush(true);
  }

  private fragment() {
    return this.doc.getXmlFragment(FRAGMENT);
  }

  /** Index in `parent` right after the agent's last block (or the anchor). */
  private resolve(rel: Y.RelativePosition | null, parent: Y.XmlFragment | Y.XmlElement): number {
    if (!rel) return parent.length;
    const abs = Y.createAbsolutePositionFromRelativePosition(rel, this.doc);
    if (!abs || abs.type !== parent) return parent.length;
    return abs.index;
  }

  private openBlock(kind: "heading" | "paragraph" | "listItem", attrs: Record<string, number> = {}) {
    const fragment = this.fragment();
    const text = new Y.XmlText();
    if (kind === "listItem") {
      const item = new Y.XmlElement("listItem");
      item.setAttribute("suggestion", this.suggestion.id);
      const p = new Y.XmlElement("paragraph");
      p.insert(0, [text]);
      item.insert(0, [p]);
      if (!this.list || this.list._item?.deleted) {
        const list = new Y.XmlElement("bulletList");
        list.setAttribute("suggestion", this.suggestion.id);
        this.place(fragment, list);
        this.list = list;
      }
      this.list.insert(this.list.length, [item]);
      this.blocks.push(item);
    } else {
      this.list = null;
      const el = new Y.XmlElement(kind);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v as unknown as string);
      el.setAttribute("suggestion", this.suggestion.id);
      el.insert(0, [text]);
      this.place(fragment, el);
    }
    this.text = text;
    this.textEnd = null;
    this.written.set(text, 0);
  }

  private place(fragment: Y.XmlFragment, el: Y.XmlElement) {
    const at = this.resolve(this.nextBlock, fragment);
    fragment.insert(at, [el]);
    this.blocks.push(el);
    // Next block goes right after this one, associated with it (assoc -1), not with whatever
    // a person inserts after it in the meantime.
    this.nextBlock = Y.createRelativePositionFromTypeIndex(fragment, at + 1, -1);
  }

  private insertText(piece: string) {
    const t = this.text!;
    const at = this.textEnd ? this.resolve(this.textEnd, t as unknown as Y.XmlElement) : t.length;
    t.insert(at, piece, { suggestion: { ...this.suggestion } });
    this.textEnd = Y.createRelativePositionFromTypeIndex(t, at + piece.length, -1);
    this.written.set(t, (this.written.get(t) ?? 0) + piece.length);
    this.chars += piece.length;
  }

  /** Did a person delete, reject or accept any of what the agent has written so far? */
  private check() {
    for (const el of this.blocks)
      if (el._item?.deleted) {
        this.yielded = { reason: "removed" };
        return;
      }
    for (const [t, n] of this.written) {
      const left = runs(t, this.suggestion.id).reduce((s, [, len]) => s + len, 0);
      if (left < n) {
        this.yielded = { reason: t._item?.deleted ? "removed" : "edited" };
        return;
      }
    }
  }

  /** Where the agent's caret is: right after the last character it wrote. */
  caret(): Y.RelativePosition | null {
    if (this.textEnd) return this.textEnd;
    return this.text ? Y.createRelativePositionFromTypeIndex(this.text, this.text.length, -1) : null;
  }

  /** True if the writer stopped because a person changed what it wrote. */
  get stopped(): boolean {
    this.check();
    return this.yielded !== null;
  }
}

/** The relative position a client sends to say "after this block". */
export function anchorAfterBlock(doc: Y.Doc, index: number): Y.RelativePosition {
  return Y.createRelativePositionFromTypeIndex(doc.getXmlFragment(FRAGMENT), index + 1, -1);
}

export function plainText(doc: Y.Doc): string {
  const lines: string[] = [];
  for (const el of doc.getXmlFragment(FRAGMENT).toArray()) {
    if (el instanceof Y.XmlElement) {
      const parts: string[] = [];
      for (const n of walk(el)) if (n instanceof Y.XmlText) parts.push(textOf(n));
      lines.push(parts.join(el.nodeName === "bulletList" ? "\n" : ""));
    }
  }
  return lines.join("\n");
}
