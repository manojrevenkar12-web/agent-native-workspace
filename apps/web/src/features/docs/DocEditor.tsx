"use client";

import { FRAGMENT } from "@anw/agent/doc";
import { person, type RoomProvider } from "@anw/sync";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { type Editor, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";
import { HumanTyping, renderCaret, SuggestionBlocks, SuggestionMark } from "./extensions";
import "./prose.css";

/**
 * A rich-text editor bound to a shared Yjs fragment. Undo only covers this person's own
 * changes (Collaboration's undo manager tracks local edits), so undo never reverts what a
 * colleague or the assistant wrote.
 */
export function DocEditor({
  provider,
  user,
  editable,
  field = FRAGMENT,
  label,
  onEditor,
}: {
  provider: RoomProvider;
  user: string;
  editable: boolean;
  field?: string;
  label: string;
  onEditor?: (e: Editor | null) => void;
}) {
  const me = person(user);
  const editor = useEditor(
    {
      immediatelyRender: false,
      editable,
      extensions: [
        StarterKit.configure({ undoRedo: false, link: false }),
        Collaboration.configure({ document: provider.doc, field }),
        CollaborationCaret.configure({
          provider: { awareness: provider.awareness },
          user: { name: me.name, color: me.color },
          render: renderCaret,
        }),
        SuggestionMark,
        SuggestionBlocks,
        HumanTyping,
      ],
      editorProps: {
        attributes: { class: "prose", "aria-label": label, "aria-multiline": "true", role: "textbox" },
      },
    },
    [provider, field],
  );
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);
  useEffect(() => {
    onEditor?.(editor);
    return () => onEditor?.(null);
  }, [editor, onEditor]);
  return <EditorContent editor={editor} />;
}
