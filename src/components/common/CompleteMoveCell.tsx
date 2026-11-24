import { useOwnerTab } from "@/state/tabScope";
import { Box, Menu, Text } from "@mantine/core";
import { Merge, ArrowUpRight, Copy, Flag, Grid2x2, Target, Trash2 } from "lucide-react";
import equal from "fast-deep-equal";
import { createContext, memo, useContext, useMemo, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { usePlayFromHere } from "@/components/boards/usePlayFromHere";
import Comment from "@/components/common/Comment";
import IconAction from "@/components/common/IconAction";

import type { Annotation } from "@/utils/annotation";
import { stripClock } from "@/utils/chess";
import { formatMoveNumber } from "@/utils/format";
import { isPrefix } from "@/utils/misc";
import { isRepertoireTab } from "@/utils/tabs";
import { getEffectiveGameEnd, type TreeNode } from "@/utils/treeReducer";
import type { NotationNodeIndex } from "./notationRows";
import { pathForNotationNode } from "./notationRows";
import MoveCell, { releasePointerFocus } from "./MoveCell";
import { TreeStateContext } from "./TreeStateContext";
import { MoveDeletionContext } from "./MoveDeletionContext";
import classes from "./GameNotation.module.css";

const transpositionCache = new WeakMap<TreeNode, Map<string, TreeNode[]>>();

export type NotationMoveActions =
  | false
  | {
      promote: (path: number[]) => void;
      delete: (path: number[]) => void;
    };
export const NotationMoveActionsContext = createContext<NotationMoveActions | undefined>(undefined);

function getTranspositionMap(root: TreeNode) {
  const cached = transpositionCache.get(root);
  if (cached) return cached;

  const map = new Map<string, TreeNode[]>();
  const stack: TreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const strippedFen = stripClock(node.fen);
    const matchingNodes = map.get(strippedFen);
    if (matchingNodes) matchingNodes.push(node);
    else map.set(strippedFen, [node]);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]);
    }
  }

  transpositionCache.set(root, map);
  return map;
}

/**
 * Where a move's transposition marker leads, or undefined when its position occurs nowhere else.
 * Every occurrence is marked, whichever line was entered first. The target is the first other
 * occurrence in tree order (main line first) that has a continuation, because that is where the
 * position was already analysed; when none continues, the first other occurrence. An occurrence on
 * the move's own line is a repetition, not a transposition, and is never a target.
 */
function getTranspositionTarget(
  fen: string,
  node: TreeNode,
  position: number[],
  root: TreeNode,
  index: NotationNodeIndex,
): number[] | undefined {
  if (position.length === 0) return undefined;

  const matchingNodes = getTranspositionMap(root).get(stripClock(fen));
  if (!matchingNodes || matchingNodes.length < 2) return undefined;

  let firstOther: number[] | undefined;
  for (const targetNode of matchingNodes) {
    if (targetNode === node) continue;
    const targetPath = pathForNotationNode(index, targetNode);
    if (!targetPath || isPrefix(targetPath, position) || isPrefix(position, targetPath)) continue;
    if (targetNode.children.length > 0) return targetPath;
    firstOther ??= targetPath;
  }
  return firstOther;
}

type CompleteMoveCellProps = {
  halfMoves: number;
  comment: string;
  startingComment?: string;
  annotations: Annotation[];
  showComments: boolean;
  move?: string | null;
  fen: string;
  first?: boolean;
  node: TreeNode;
  nodeIndex: NotationNodeIndex;
  tableLayout?: boolean;
  scoreText?: string;
  analysis?: boolean;
  isStart?: boolean;
  isCurrentVariation?: boolean;
  root: TreeNode;
};

function CompleteMoveCell({
  halfMoves,
  comment,
  startingComment,
  annotations,
  showComments,
  move,
  fen,
  first,
  node,
  nodeIndex,
  tableLayout,
  scoreText,
  analysis,
  isStart: providedIsStart,
  isCurrentVariation: providedIsCurrentVariation,
  root,
}: CompleteMoveCellProps) {
  const store = useContext(TreeStateContext)!;
  const moveActions = useContext(NotationMoveActionsContext);
  const state = store.getState();
  const path = useMemo(() => pathForNotationNode(nodeIndex, node) ?? [], [node, nodeIndex]);
  const isCurrentVariation = providedIsCurrentVariation ?? node === state.currentNode();
  const isStart = providedIsStart ?? equal(path, state.headers.start || []);
  const transpositionTarget = useMemo(
    () => getTranspositionTarget(fen, node, path, root, nodeIndex),
    [fen, node, nodeIndex, path, root],
  );
  const [open, setOpen] = useState(false);

  const isWhite = halfMoves % 2 === 1;
  const hasNumber = !tableLayout && halfMoves > 0 && (first || isWhite);

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    if (moveActions === false) return;
    if (store.getState().root !== root) return;
    setOpen(true);
  };

  const rightAccessory =
    tableLayout && scoreText ? (
      <Text component="span" size="xs" c="dimmed">
        {scoreText}
      </Text>
    ) : undefined;

  const moveCell = move ? (
    <MoveCell
      move={move}
      annotations={annotations}
      forceAnnotations={moveActions !== undefined}
      isStart={isStart}
      isCurrentVariation={isCurrentVariation}
      onClick={() => {
        if (store.getState().root === root) store.getState().goToMove(path);
      }}
      onContextMenu={onContextMenu}
      fullWidth={tableLayout}
      rightAccessory={rightAccessory}
      analysis={analysis}
    />
  ) : null;

  return (
    <>
      {showComments && !tableLayout && startingComment && (
        // A comment before a move annotates the position the move is played from.
        <Comment
          comment={startingComment}
          annotatedNode={nodeIndex.links.get(node)?.parent ?? undefined}
        />
      )}
      <Box
        component="span"
        data-notation-current={isCurrentVariation ? "true" : undefined}
        style={{
          display: tableLayout ? "block" : "inline-block",
          marginLeft: hasNumber ? 6 : 0,
          fontSize: "80%",
          width: tableLayout ? "100%" : undefined,
        }}
      >
        {hasNumber && <span className={classes.moveNumber}>{formatMoveNumber(halfMoves)}</span>}
        {open && move && moveActions && store.getState().root === root ? (
          <Menu opened onClose={() => setOpen(false)} width={200}>
            <Menu.Target>{moveCell}</Menu.Target>
            <Menu.Dropdown>
              <MoveActionItems
                actions={{
                  promote: () => moveActions.promote(path),
                  delete: () => moveActions.delete(path),
                }}
                onAction={(action) => {
                  if (store.getState().root === root) action();
                  setOpen(false);
                }}
              />
            </Menu.Dropdown>
          </Menu>
        ) : open && move && moveActions === undefined && store.getState().root === root ? (
          <OpenMoveMenu
            store={store}
            root={root}
            path={path}
            hasDiagram={node.diagram === true}
            move={move}
            annotations={annotations}
            isStart={isStart}
            isCurrentVariation={isCurrentVariation}
            fullWidth={tableLayout}
            rightAccessory={rightAccessory}
            analysis={analysis}
            onClose={() => setOpen(false)}
          />
        ) : (
          moveCell
        )}
        {transpositionTarget && (
          <TranspositionAction
            onClick={() => {
              if (store.getState().root === root) store.getState().goToMove(transpositionTarget);
            }}
          />
        )}
      </Box>
      {showComments && !tableLayout && comment && (
        <Comment comment={comment} annotatedNode={node} />
      )}
    </>
  );
}

function TranspositionAction({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <IconAction
      label={t("Notation.Transposition", { defaultValue: "Transposition" })}
      size="xs"
      onClick={(event) => {
        releasePointerFocus(event);
        onClick();
      }}
    >
      <Merge size="0.875rem" />
    </IconAction>
  );
}

type MoveMenuActions = {
  playFromHere?: () => void;
  toggleDiagram?: () => void;
  markGameEnd?: () => void;
  markStart?: () => void;
  promoteToMainline?: () => void;
  promote: () => void;
  copy?: () => void;
  delete?: () => void;
};

function MoveActionItems({
  actions,
  isGameEnd,
  hasDiagram,
  onAction,
}: {
  actions: MoveMenuActions;
  isGameEnd?: boolean;
  hasDiagram?: boolean;
  onAction: (action: () => void) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {actions.playFromHere && (
        <Menu.Item
          leftSection={<Target size="0.875rem" />}
          onClick={() => onAction(actions.playFromHere!)}
        >
          {t("Board.Action.PlayFromHere")}
        </Menu.Item>
      )}
      {actions.toggleDiagram && (
        <Menu.Item
          leftSection={<Grid2x2 size="0.875rem" />}
          onClick={() => onAction(actions.toggleDiagram!)}
        >
          {hasDiagram ? t("Notation.RemoveDiagram") : t("Notation.AddDiagram")}
        </Menu.Item>
      )}
      {actions.markGameEnd && (
        <Menu.Item
          leftSection={<Flag size="0.875rem" />}
          onClick={() => onAction(actions.markGameEnd!)}
        >
          {isGameEnd ? t("Notation.ClearGameEnd") : t("Notation.MarkGameEndHere")}
        </Menu.Item>
      )}
      {actions.markStart && (
        <Menu.Item
          leftSection={<Flag size="0.875rem" />}
          onClick={() => onAction(actions.markStart!)}
        >
          {t("Menu.MarkAsStart")}
        </Menu.Item>
      )}
      {actions.promoteToMainline && (
        <Menu.Item
          leftSection={<ArrowUpRight size="0.875rem" />}
          onClick={() => onAction(actions.promoteToMainline!)}
        >
          {t("Menu.PromoteToMainLine")}
        </Menu.Item>
      )}
      <Menu.Item
        leftSection={<ArrowUpRight size="0.875rem" />}
        onClick={() => onAction(actions.promote)}
      >
        {t("Menu.PromoteVariation")}
      </Menu.Item>
      {actions.copy && (
        <Menu.Item leftSection={<Copy size="0.875rem" />} onClick={() => onAction(actions.copy!)}>
          {t("Menu.CopyVariationPGN")}
        </Menu.Item>
      )}
      {actions.delete && (
        <Menu.Item
          color="danger"
          leftSection={<Trash2 size="0.875rem" />}
          onClick={() => onAction(actions.delete!)}
        >
          {t("Menu.DeleteMove")}
        </Menu.Item>
      )}
    </>
  );
}

function OpenMoveMenu({
  store,
  root,
  path,
  hasDiagram,
  move,
  annotations,
  isStart,
  isCurrentVariation,
  fullWidth,
  rightAccessory,
  analysis,
  onClose,
}: {
  store: NonNullable<React.ContextType<typeof TreeStateContext>>;
  root: TreeNode;
  path: number[];
  hasDiagram: boolean;
  move: string;
  annotations: Annotation[];
  isStart: boolean;
  isCurrentVariation: boolean;
  fullWidth?: boolean;
  rightAccessory?: React.ReactNode;
  analysis?: boolean;
  onClose: () => void;
}) {
  const [currentTab] = useOwnerTab();
  const deletion = useContext(MoveDeletionContext);
  const playFromHere = usePlayFromHere();
  const actions = store.getState();
  const mainline = path.length > 0 && path.every((index) => index === 0);
  const isGameEnd = equal(getEffectiveGameEnd(root)?.position, path);

  return (
    <Menu opened onClose={onClose} width={200}>
      <Menu.Target>
        <MoveCell
          move={move}
          annotations={annotations}
          isStart={isStart}
          isCurrentVariation={isCurrentVariation}
          onClick={() => {
            if (store.getState().root === root) actions.goToMove(path);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            onClose();
          }}
          fullWidth={fullWidth}
          rightAccessory={rightAccessory}
          analysis={analysis}
        />
      </Menu.Target>
      <Menu.Dropdown>
        <MoveActionItems
          actions={{
            playFromHere:
              currentTab?.type === "analysis"
                ? () => playFromHere(root, store.getState().headers.orientation, path)
                : undefined,
            toggleDiagram: () => actions.toggleDiagram(path),
            markGameEnd:
              currentTab && mainline
                ? () => {
                    if (isGameEnd) actions.clearGameEnd();
                    else actions.setGameEnd(path);
                  }
                : undefined,
            markStart: isRepertoireTab(currentTab) ? () => actions.setStart(path) : undefined,
            promoteToMainline: () => actions.promoteToMainline(path),
            promote: () => actions.promoteVariation(path),
            copy: () => actions.copyVariationPgn(path),
            delete: !deletion
              ? () => actions.deleteMove(path)
              : deletion.canDelete(path)
                ? () => deletion.delete(path)
                : undefined,
          }}
          isGameEnd={isGameEnd}
          hasDiagram={hasDiagram}
          onAction={(action) => {
            if (store.getState().root !== root) return;
            action();
            onClose();
          }}
        />
      </Menu.Dropdown>
    </Menu>
  );
}

export default memo(CompleteMoveCell, (prev, next) => {
  return (
    prev.node === next.node &&
    prev.move === next.move &&
    prev.fen === next.fen &&
    prev.comment === next.comment &&
    prev.startingComment === next.startingComment &&
    equal(prev.annotations, next.annotations) &&
    prev.showComments === next.showComments &&
    prev.first === next.first &&
    prev.root === next.root &&
    prev.nodeIndex === next.nodeIndex &&
    prev.halfMoves === next.halfMoves &&
    prev.tableLayout === next.tableLayout &&
    prev.scoreText === next.scoreText &&
    prev.analysis === next.analysis &&
    prev.isStart === next.isStart &&
    prev.isCurrentVariation === next.isCurrentVariation
  );
});
