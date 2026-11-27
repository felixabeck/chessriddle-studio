import { RichTextEditor } from "@mantine/tiptap";
import { Box, SegmentedControl, Text } from "@mantine/core";
import { Grid2x2 } from "lucide-react";
import Placeholder from "@tiptap/extension-placeholder";
import Underline from "@tiptap/extension-underline";
import { Markdown } from "@tiptap/markdown";
import {
  Extension,
  getExtensionField,
  type JSONContent,
  type MarkdownParseResult,
  useEditor,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useAtomValue } from "jotai";
import equal from "fast-deep-equal";
import type { marked } from "marked";
import { useContext, useEffect, useId, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { spellCheckAtom } from "@/state/atoms";
import { keyMapAtom } from "@/state/keybinds";
import { createCommentMarkdown } from "@/utils/commentMarkdown";
import { parseNotationComment } from "@/utils/commentNotation";
import {
  compareCommentDocument,
  flattenCommentDocument,
  normalizeCommentDocument,
} from "@/utils/commentSerializer";
import { splitPgnComment } from "@/utils/pgnComment";
import { acceptsStartingComment, getNodeAtPath } from "@/utils/treeReducer";
import { formatKeymap } from "@/utils/formatKeymap";

const CommentEscape = Extension.create({
  name: "commentEscape",
  markdownTokenName: "escape",
  parseMarkdown: (token, helpers) => helpers.createTextNode(token.text!),
});

export function includeHardBreakMarks(parsed: MarkdownParseResult): MarkdownParseResult {
  if (!("mark" in parsed)) return parsed;
  const mark = { type: parsed.mark, ...(parsed.attrs ? { attrs: parsed.attrs } : {}) };
  // Tiptap applies the enclosing mark to text only. Complete that same parse
  // result for breaks before the manager handles the text, without a transaction.
  const apply = (content: JSONContent[]): JSONContent[] =>
    content.map((node) => ({
      ...node,
      ...(node.type === "hardBreak" ? { marks: [...(node.marks ?? []), mark] } : {}),
      ...(node.content ? { content: apply(node.content) } : {}),
    }));
  return { ...parsed, content: apply(parsed.content ?? []) };
}

const CommentStarterKit = StarterKit.extend({
  addExtensions() {
    return this.parent!().map((extension) => {
      if (extension.name === "paragraph") {
        return extension.extend({
          // The manager's paragraph fallback keeps literal &nbsp; as comment text.
          parseMarkdown: () => undefined,
        });
      }
      const parseMarkdown = getExtensionField(extension, "parseMarkdown");
      return extension.extend({
        parseMarkdown:
          parseMarkdown &&
          ((token, helpers) => includeHardBreakMarks(parseMarkdown(token, helpers))),
      });
    });
  },
});

export { parseNotationComment } from "@/utils/commentNotation";

// The editor root draws the frame but has no padding; lines placed below the content
// take the content's inline inset so they never touch the border.
const FRAME_INSET = { px: "md", pb: "xs" } as const;

function AnnotationEditor() {
  "use no memo";
  // The React compiler would retain the mutable Marked instance across editor recreations.
  const { t, i18n } = useTranslation();
  const [saveFailed, setSaveFailed] = useState<boolean>();
  const [focused, setFocused] = useState(false);
  const focusDestination = useRef<string | null>(null);
  const keyMap = useAtomValue(keyMapAtom);

  const store = useContext(TreeStateContext)!;
  const hasDiagram = useStore(store, (s) => s.currentNode().diagram === true);
  const toggleDiagram = useStore(store, (s) => s.toggleDiagram);
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);
  const documentId = useStore(store, (s) => s.documentId);
  const setComment = useStore(store, (s) => s.setComment);
  const setStartingComment = useStore(store, (s) => s.setStartingComment);
  const [beforeChosen, setBeforeChosen] = useState(false);

  const currentNode = getNodeAtPath(root, position);
  // A move that opens a variation, or still carries a comment from one, has a slot before it.
  const canCommentBefore = acceptsStartingComment(root, position);
  // Which comment of the current move the editor writes: the one before it, or the one after it.
  const writesBefore = canCommentBefore && beforeChosen;
  // The before comment is stored verbatim; the editor shows and writes only its prose.
  const comment = writesBefore
    ? splitPgnComment(currentNode.startingComment ?? "").text
    : currentNode.comment;
  const spellCheck = useAtomValue(spellCheckAtom);
  const hintId = useId();
  const editor = useEditor(
    {
      extensions: [
        CommentStarterKit.configure({
          heading: false,
          blockquote: false,
          horizontalRule: false,
          bulletList: false,
          orderedList: false,
          listItem: false,
          listKeymap: false,
          codeBlock: false,
          code: false,
          underline: false,
          link: {
            openOnClick: false,
          },
        }),
        Underline.extend({
          parseMarkdown(token, helpers) {
            return includeHardBreakMarks(
              getExtensionField(Underline, "parseMarkdown")!(token, helpers),
            );
          },
          markdownTokenizer: {
            name: "underline",
            level: "inline",
            // Undefined inherits the parent's tokenizer. This defined no-op suppresses it.
            tokenize: () => undefined,
          },
        }),
        Markdown.configure({
          // Tiptap types this as the singleton, but uses only the instance's lexer/use API.
          marked: createCommentMarkdown() as unknown as typeof marked,
        }),
        CommentEscape,
        Placeholder.configure({ placeholder: t("Board.Annotate.WriteHere") }),
      ],
      content: comment || null,
      contentType: "markdown",
      autofocus: false,
      onCreate: ({ editor }) => {
        if (focusDestination.current !== position.join()) return;
        focusDestination.current = null;
        editor.commands.focus("end", { scrollIntoView: false });
      },
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
      onUpdate: ({ editor }) => {
        const result = compareCommentDocument(editor.getJSON(), [
          (source) => editor.markdown!.parse(source),
          parseNotationComment,
        ]);
        if (result.saved) (writesBefore ? setStartingComment : setComment)(result.source);
        setSaveFailed(!result.saved);
      },
      editorProps: {
        attributes: {
          // A contenteditable div needs role="textbox" for its label and aria-multiline.
          role: "textbox",
          "aria-label": t("Board.Annotate.Comment"),
          "aria-multiline": "true",
          "aria-describedby": hintId,
        },
      },
    },
    [position.join(), documentId, i18n.language, writesBefore],
  );

  const editedFieldIdentity = `${position.join()}:${currentNode.fen}:${writesBefore}`;
  useEffect(() => {
    if (!editor) return;
    const expected = flattenCommentDocument(normalizeCommentDocument(editor.getJSON()));
    // Equivalent source spellings must not replace the document or move its caret.
    const matches = [editor.markdown!.parse(comment), parseNotationComment(comment)].every(
      (document) => equal(flattenCommentDocument(document), expected),
    );
    if (!matches) {
      editor.commands.setContent(comment, { emitUpdate: false, contentType: "markdown" });
    }
    setSaveFailed(false);
  }, [comment, editor, editedFieldIdentity]);

  const navigate = (forward: boolean) => {
    const state = store.getState();
    if (forward && state.currentNode().children.length === 0) return;
    const previous = state.position.join();
    if (forward) state.goToNext();
    else state.goToPrevious();
    const destination = store.getState().position.join();
    if (destination !== previous) focusDestination.current = destination;
  };
  const options = { enableOnContentEditable: true, preventDefault: true };
  const nextRef = useHotkeys<HTMLDivElement>(
    keyMap.ANNOTATION_NEXT_MOVE.keys,
    () => navigate(true),
    options,
  );
  const previousRef = useHotkeys<HTMLDivElement>(
    keyMap.ANNOTATION_PREVIOUS_MOVE.keys,
    () => navigate(false),
    options,
  );
  const escapeRef = useHotkeys<HTMLDivElement>(
    "escape",
    (event) => (event.target as HTMLElement).blur(),
    options,
  );

  return (
    <RichTextEditor
      editor={editor}
      spellCheck={spellCheck}
      labels={{
        boldControlLabel: t("RichText.Bold"),
        italicControlLabel: t("RichText.Italic"),
        underlineControlLabel: t("RichText.Underline"),
        strikeControlLabel: t("RichText.Strike"),
        clearFormattingControlLabel: t("RichText.ClearFormatting"),
        linkControlLabel: t("RichText.Link"),
        unlinkControlLabel: t("RichText.RemoveLink"),
      }}
    >
      <RichTextEditor.Toolbar>
        <RichTextEditor.ControlsGroup>
          <RichTextEditor.Bold />
          <RichTextEditor.Italic />
          <RichTextEditor.Underline />
          <RichTextEditor.Strikethrough />
          <RichTextEditor.ClearFormatting />
        </RichTextEditor.ControlsGroup>

        <RichTextEditor.ControlsGroup>
          <RichTextEditor.Link />
          <RichTextEditor.Unlink />
        </RichTextEditor.ControlsGroup>

        {/* In the toolbar, so the editor keeps its height in a short panel. */}
        <RichTextEditor.ControlsGroup>
          <RichTextEditor.Control
            active={hasDiagram}
            aria-pressed={hasDiagram}
            aria-label={t("Board.Annotate.Diagram")}
            onClick={() => toggleDiagram()}
            w="auto"
            px={6}
          >
            <Grid2x2 size="1rem" />
            <Text span size="xs" ml={4}>
              {t("Board.Annotate.Diagram")}
            </Text>
          </RichTextEditor.Control>
        </RichTextEditor.ControlsGroup>

        {canCommentBefore && (
          <SegmentedControl
            size="xs"
            ml="auto"
            aria-label={t("Board.Annotate.CommentPosition")}
            value={writesBefore ? "before" : "after"}
            onChange={(value) => setBeforeChosen(value === "before")}
            data={[
              { value: "before", label: t("Board.Annotate.BeforeMove") },
              { value: "after", label: t("Board.Annotate.AfterMove") },
            ]}
          />
        )}
      </RichTextEditor.Toolbar>

      <div
        ref={(element) => {
          nextRef.current = element;
          previousRef.current = element;
          escapeRef.current = element;
        }}
      >
        <RichTextEditor.Content />
      </div>
      <Text id={hintId} c="dimmed" size="xs" {...FRAME_INSET} hidden={!focused}>
        {t("Board.Annotate.NavigationHint", {
          next: formatKeymap(keyMap.ANNOTATION_NEXT_MOVE.keys),
          previous: formatKeymap(keyMap.ANNOTATION_PREVIOUS_MOVE.keys),
        })}
      </Text>
      {saveFailed && (
        <Box role="alert" {...FRAME_INSET}>
          {t("Board.Annotate.SaveFailed")}
        </Box>
      )}
    </RichTextEditor>
  );
}

export default AnnotationEditor;
