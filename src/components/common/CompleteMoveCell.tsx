import { useOwnerTab } from "@/state/tabScope";
import { Box, Menu, Text } from "@mantine/core";
import { Merge, ArrowUpRight, Copy, Flag, Trash2 } from "lucide-react";
import equal from "fast-deep-equal";
import { createContext, memo, useContext, useMemo, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import Comment from "@/components/common/Comment";
import IconAction from "@/components/common/IconAction";

import type { Annotation } from "@/utils/annotation";
import { hasMorePriority, stripClock } from "@/utils/chess";
import { formatMoveNumber } from "@/utils/format";
import { getTabFile } from "@/utils/tabs";
import { getEffectiveGameEnd, type TreeNode } from "@/utils/treeReducer";
import type { NotationNodeIndex } from "./notationRows";
import { pathForNotationNode } from "./notationRows";
import MoveCell, { releasePointerFocus } from "./MoveCell";
import { TreeStateContext } from "./TreeStateContext";
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

function getTranspositions(
  fen: string,
  node: TreeNode,
  position: number[],
  root: TreeNode,
  index: NotationNodeIndex,
) {
  if (position.length === 0 || position.every((value) => value === 0)) return [];

  const matchingNodes = getTranspositionMap(root).get(stripClock(fen)) || [];
  const paths: number[][] = [];
  for (const targetNode of matchingNodes) {
    const targetPath = pathForNotationNode(index, targetNode);
    if (targetPath && targetNode !== node && !hasMorePriority(position, targetPath)) {
      paths.push(targetPath);
    }
  }
  return paths;
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
  const { t } = useTranslation();
  const state = store.getState();
  const path = useMemo(() => pathForNotationNode(nodeIndex, node) ?? [], [node, nodeIndex]);
  const isCurrentVariation = providedIsCurrentVariation ?? node === state.currentNode();
  const isStart = providedIsStart ?? equal(path, state.headers.start || []);
  const transpositions = useMemo(
    () => getTranspositions(fen, node, path, root, nodeIndex),
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
      {showComments && !tableLayout && startingComment && <Comment comment={startingComment} />}
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
              <Menu.Item
                leftSection={<ArrowUpRight size="0.875rem" />}
                onClick={() => {
                  if (store.getState().root === root) moveActions.promote(path);
                  setOpen(false);
                }}
              >
                {t("Menu.PromoteVariation")}
              </Menu.Item>
              <Menu.Item
                color="danger"
                leftSection={<Trash2 size="0.875rem" />}
                onClick={() => {
                  if (store.getState().root === root) moveActions.delete(path);
                  setOpen(false);
                }}
              >
                {t("Menu.DeleteMove")}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        ) : open && move && moveActions === undefined && store.getState().root === root ? (
          <OpenMoveMenu
            store={store}
            root={root}
            path={path}
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
        {transpositions.length > 0 && (
          <TranspositionAction
            onClick={() => {
              if (store.getState().root === root) store.getState().goToMove(transpositions[0]);
            }}
          />
        )}
      </Box>
      {showComments && !tableLayout && comment && <Comment comment={comment} />}
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

function OpenMoveMenu({
  store,
  root,
  path,
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
  const tabFile = getTabFile(currentTab);
  const { t } = useTranslation();
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
        {currentTab && mainline && (
          <Menu.Item
            leftSection={<Flag size="0.875rem" />}
            onClick={() => {
              if (store.getState().root !== root) return;
              if (isGameEnd) actions.clearGameEnd();
              else actions.setGameEnd(path);
              onClose();
            }}
          >
            {isGameEnd ? t("Notation.ClearGameEnd") : t("Notation.MarkGameEndHere")}
          </Menu.Item>
        )}
        {tabFile?.metadata.type === "repertoire" && (
          <Menu.Item
            leftSection={<Flag size="0.875rem" />}
            onClick={() => {
              if (store.getState().root !== root) return;
              actions.setStart(path);
              onClose();
            }}
          >
            {t("Menu.MarkAsStart")}
          </Menu.Item>
        )}
        <Menu.Item
          leftSection={<ArrowUpRight size="0.875rem" />}
          onClick={() => {
            if (store.getState().root !== root) return;
            actions.promoteToMainline(path);
            onClose();
          }}
        >
          {t("Menu.PromoteToMainLine")}
        </Menu.Item>
        <Menu.Item
          leftSection={<ArrowUpRight size="0.875rem" />}
          onClick={() => {
            if (store.getState().root !== root) return;
            actions.promoteVariation(path);
            onClose();
          }}
        >
          {t("Menu.PromoteVariation")}
        </Menu.Item>
        <Menu.Item
          leftSection={<Copy size="0.875rem" />}
          onClick={() => {
            if (store.getState().root !== root) return;
            actions.copyVariationPgn(path);
            onClose();
          }}
        >
          {t("Menu.CopyVariationPGN")}
        </Menu.Item>
        <Menu.Item
          color="danger"
          leftSection={<Trash2 size="0.875rem" />}
          onClick={() => {
            if (store.getState().root !== root) return;
            actions.deleteMove(path);
            onClose();
          }}
        >
          {t("Menu.DeleteMove")}
        </Menu.Item>
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
