import { Typography } from "@mantine/core";
import { Fragment, memo, type ReactNode } from "react";
import { readCommentNotation, type CommentNotationNode } from "@/utils/commentNotation";
import { recognizeGameReferences, type GameReference } from "@/utils/gameReferences";
import type { TreeNode } from "@/utils/treeReducer";
import { useGameReference } from "./GameReference";
import { externalLinkProps } from "./ExternalLink";
import classes from "./GameNotation.module.css";

function renderNotation(nodes: CommentNotationNode[], multipleLine: boolean): ReactNode {
  return nodes.map((node, index) => {
    const children = "content" in node ? renderNotation(node.content, multipleLine) : undefined;
    let rendered: ReactNode;
    switch (node.type) {
      case "paragraph":
        rendered = multipleLine ? <p>{children}</p> : <span>{children}</span>;
        break;
      case "bold":
        rendered = <strong>{children}</strong>;
        break;
      case "italic":
        rendered = <em>{children}</em>;
        break;
      case "strike":
        rendered = <del>{children}</del>;
        break;
      case "underline":
        rendered = <u>{children}</u>;
        break;
      case "link":
        rendered = (
          <a {...externalLinkProps(node.attrs.href)} title={node.attrs.title ?? undefined}>
            {children}
          </a>
        );
        break;
      case "hardBreak":
        rendered = <br />;
        break;
      case "space":
        rendered = "\n";
        break;
      case "text":
        rendered = node.text;
        break;
    }
    return <Fragment key={index}>{rendered}</Fragment>;
  });
}

function visibleText(node: CommentNotationNode): string {
  if (node.type === "text") return node.text;
  if ("content" in node) return node.content.map(visibleText).join("");
  return "\n";
}

// Slice the existing safe tree by visible offsets. Formatting may cross a citation boundary.
// External anchors are atomic and exclude every overlapping citation from decoration.
function sliceNotation(
  nodes: CommentNotationNode[],
  from: number,
  to: number,
): CommentNotationNode[] {
  let offset = 0;
  return nodes.flatMap((node): CommentNotationNode[] => {
    const length = visibleText(node).length;
    const start = Math.max(0, from - offset);
    const end = Math.min(length, to - offset);
    offset += length;
    if (end <= start) return [];
    if (node.type === "text") return [{ ...node, text: node.text.slice(start, end) }];
    if ("content" in node)
      return [{ ...node, content: sliceNotation(node.content, start, end) } as CommentNotationNode];
    return [node];
  });
}

function decorate(
  nodes: CommentNotationNode[],
  multipleLine: boolean,
  activate: (reference: GameReference) => void,
): ReactNode {
  return nodes.map((node, index) => {
    if (node.type !== "paragraph")
      return <Fragment key={index}>{renderNotation([node], multipleLine)}</Fragment>;
    const text = visibleText(node);
    const links: { start: number; end: number }[] = [];
    let offset = 0;
    const walk = (children: CommentNotationNode[]) => {
      for (const child of children) {
        const start = offset;
        if (child.type !== "link" && "content" in child) walk(child.content);
        else offset += visibleText(child).length;
        if (child.type === "link") links.push({ start, end: offset });
      }
    };
    walk(node.content);
    const references = recognizeGameReferences(text).filter(
      (reference) =>
        !links.some((link) => reference.start < link.end && reference.end > link.start),
    );
    const parts: ReactNode[] = [];
    let previous = 0;
    for (const reference of references) {
      parts.push(
        <Fragment key={`text-${reference.start}`}>
          {renderNotation(sliceNotation(node.content, previous, reference.start), multipleLine)}
        </Fragment>,
      );
      parts.push(
        <button
          key={`reference-${reference.start}`}
          type="button"
          data-game-reference="true"
          style={{
            display: "inline",
            border: 0,
            padding: 0,
            background: "none",
            color: "var(--mantine-color-anchor)",
            font: "inherit",
            textAlign: "inherit",
            cursor: "pointer",
            textDecoration: "underline",
            whiteSpace: "normal",
            overflowWrap: "anywhere",
          }}
          onClick={(event) => {
            event.stopPropagation();
            activate(reference);
          }}
        >
          {renderNotation(
            sliceNotation(node.content, reference.start, reference.end),
            multipleLine,
          )}
        </button>,
      );
      previous = reference.end;
    }
    parts.push(
      <Fragment key="tail">
        {renderNotation(sliceNotation(node.content, previous, text.length), multipleLine)}
      </Fragment>,
    );
    return multipleLine ? <p key={index}>{parts}</p> : <span key={index}>{parts}</span>;
  });
}

/**
 * `annotatedNode` is the node whose position the comment annotates. A cited game opens at the
 * first position of that node's line, from it back to the root, that the game's mainline reaches.
 */
function Comment({ comment, annotatedNode }: { comment: string; annotatedNode?: TreeNode }) {
  const activate = useGameReference();
  const multipleLine = comment.split("\n").filter((v) => v.trim() !== "").length > 1;

  return (
    <Typography
      className={classes.comment}
      pl={0}
      mx={4}
      style={{
        display: multipleLine ? "block" : "inline",
      }}
    >
      {activate
        ? decorate(readCommentNotation(comment), multipleLine, (reference) =>
            activate(reference, annotatedNode),
          )
        : renderNotation(readCommentNotation(comment), multipleLine)}
    </Typography>
  );
}

export default memo(Comment);
