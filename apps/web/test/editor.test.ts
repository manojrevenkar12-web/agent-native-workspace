import {
  anchorAfterBlock,
  FRAGMENT,
  listSuggestions,
  plainText,
  rejectSuggestion,
  SuggestionWriter,
} from "@anw/agent/doc";
import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { HumanTyping, SuggestionBlocks, SuggestionMark } from "@/features/docs/extensions";

function setup() {
  const doc = new Y.Doc();
  const f = doc.getXmlFragment(FRAGMENT);
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText("Intro")]);
  f.insert(0, [p]);
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Collaboration.configure({ document: doc, field: FRAGMENT }),
      SuggestionMark,
      SuggestionBlocks,
      HumanTyping,
    ],
  });
  return { doc, editor, element };
}

describe("the editor and the assistant's suggestions", () => {
  it("renders streamed agent text as suggestions with block markers", () => {
    const { doc, editor, element } = setup();
    const w = new SuggestionWriter(doc, { id: "s1", author: "assistant" }, anchorAfterBlock(doc, 0));
    w.write("## Risks\nThe venue could cancel.\n");
    w.finish();
    expect(element.querySelector("h2[data-suggestion-block='s1'] span.suggestion")?.textContent).toBe(
      "Risks",
    );
    expect(element.querySelectorAll("span.suggestion[data-suggestion='s1']").length).toBe(2);
    expect(editor.getJSON().content?.[1]).toMatchObject({
      type: "heading",
      attrs: { level: 2, suggestion: "s1" },
    });
    editor.destroy();
  });

  it("text a person types inside the agent's sentence stays theirs, and survives a reject", () => {
    const { doc, editor } = setup();
    const w = new SuggestionWriter(doc, { id: "s1", author: "assistant" }, anchorAfterBlock(doc, 0));
    w.write("The venue could cancel.");
    w.finish();
    // Put the cursor inside "venue" and type, through the same path a keyboard uses.
    let pos = -1;
    editor.state.doc.descendants((n, p) => {
      if (n.isText && n.text?.startsWith("The venue")) pos = p + 4;
    });
    editor.commands.setTextSelection(pos);
    const view = editor.view;
    const handled = view.someProp("handleTextInput", (f) => f(view, pos, pos, "big ", () => view.state.tr));
    expect(handled).toBe(true);
    expect(plainText(doc)).toContain("The big venue could cancel.");
    expect(listSuggestions(doc)[0]!.chars).toBe("The venue could cancel.".length);
    rejectSuggestion(doc, "s1");
    expect(plainText(doc).split("\n")).toEqual(["Intro", "big "]);
    editor.destroy();
  });

  it("pasting text copied from a suggestion does not copy the mark", () => {
    const { doc, editor } = setup();
    const w = new SuggestionWriter(doc, { id: "s1", author: "assistant" }, anchorAfterBlock(doc, 0));
    w.write("Copied words");
    w.finish();
    const view = editor.view;
    const slice = editor.state.doc.slice(
      editor.state.doc.content.size - 14,
      editor.state.doc.content.size - 1,
    );
    const cleaned = view.someProp("transformPasted", (f) => f(slice, view, true)) ?? slice;
    let marked = false;
    cleaned.content.descendants((n) => {
      if (n.marks.some((m) => m.type.name === "suggestion")) marked = true;
    });
    expect(marked).toBe(false);
    editor.destroy();
  });
});
