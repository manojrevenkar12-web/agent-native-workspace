import { Extension, Mark } from "@tiptap/core";
import { Fragment, type MarkType, type Node as PMNode, Slice } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/**
 * The editor side of "agent edits are suggestions". The server writes text with a
 * `suggestion` mark ({ id, author }) and blocks with a `suggestion` attribute; these
 * extensions render them, and make sure what a person types or pastes never carries the
 * agent's mark, even inside the agent's text. So rejecting a suggestion can never delete
 * a person's words.
 */
export const SuggestionMark = Mark.create({
  name: "suggestion",
  inclusive: false,
  addAttributes() {
    return {
      id: { default: null, parseHTML: (el) => el.getAttribute("data-suggestion") },
      author: { default: null, parseHTML: (el) => el.getAttribute("data-author") },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-suggestion]" }];
  },
  renderHTML({ mark }) {
    return [
      "span",
      { class: "suggestion", "data-suggestion": mark.attrs.id, "data-author": mark.attrs.author },
      0,
    ];
  },
});

export const SuggestionBlocks = Extension.create({
  name: "suggestionBlocks",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading", "bulletList", "listItem"],
        attributes: {
          suggestion: {
            default: null,
            parseHTML: (el) => el.getAttribute("data-suggestion-block"),
            renderHTML: (attrs) => (attrs.suggestion ? { "data-suggestion-block": attrs.suggestion } : {}),
          },
        },
      },
    ];
  },
});

function strip(fragment: Fragment, type: MarkType): Fragment {
  const nodes: PMNode[] = [];
  fragment.forEach((node) => {
    if (node.isText) nodes.push(node.mark(type.removeFromSet(node.marks)));
    else {
      const attrs = "suggestion" in node.attrs ? { ...node.attrs, suggestion: null } : node.attrs;
      nodes.push(node.type.create(attrs, strip(node.content, type), node.marks));
    }
  });
  return Fragment.from(nodes);
}

export const humanTypingKey = new PluginKey("humanTyping");

export const HumanTyping = Extension.create({
  name: "humanTyping",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: humanTypingKey,
        props: {
          handleTextInput(view, from, to, text) {
            const type = view.state.schema.marks.suggestion;
            if (!type) return false;
            const tr = view.state.tr.insertText(text, from, to);
            tr.removeMark(from, from + text.length, type);
            view.dispatch(tr);
            return true;
          },
          transformPasted(slice, view) {
            const type = view.state.schema.marks.suggestion;
            return type ? new Slice(strip(slice.content, type), slice.openStart, slice.openEnd) : slice;
          },
        },
      }),
    ];
  },
});

/** How a collaborator's caret looks; the assistant's says what it is doing. */
export function renderCaret(user: Record<string, unknown>): HTMLElement {
  const caret = document.createElement("span");
  caret.className = user.agent ? "caret caret-agent" : "caret";
  caret.style.setProperty("--caret", String(user.color ?? "currentColor"));
  const label = document.createElement("span");
  label.className = "caret-label";
  label.textContent = user.agent ? `${String(user.name)} is writing` : String(user.name ?? "");
  caret.append(label);
  return caret;
}
