import { useOwnerTab } from "@/state/tabScope";
import { Box, Menu, Text } from "@mantine/core";
import { Merge, ArrowUpRight, Copy, Flag, Grid2x2, Target, Trash2 } from "lucide-react";
import equal from "fast-deep-equal";
import {
  createContext,
  memo,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useFileChapterSwitch } from "@/components/boards/FileChapterSwitch";
import { usePlayFromHere } from "@/components/boards/usePlayFromHere";
import Comment from "@/components/common/Comment";
import IconAction from "@/components/common/IconAction";
import { useFileFreshness } from "@/state/fileFreshness";
import {
  getFileChapterOccurrences,
  getFilePositionIndex,
  subscribeFilePositionIndex,
} from "@/state/filePositionIndex";
import {
  getMoveLine,
  getTranspositionTarget,
  type OpenChapterOccurrence,
  type TranspositionTarget,
} from "@/state/transpositionTarget";

import type { Annotation } from "@/utils/annotation";
import { formatMoveNumber } from "@/utils/format";
import { getTabFile, getTabGameNumber, isRepertoireTab } from "@/utils/tabs";
import {
  getBoardState,
  getEffectiveGameEnd,
  getMemoizedBoardStateMap,
  getNodeAtPath,
  type TreeNode,
} from "@/utils/treeReducer";
import { variationStartPath } from "@/state/store/tree";
import type { NotationNodeIndex } from "./notationRows";
import { pathForNotationNode } from "./notationRows";
import MoveCell, { releasePointerFocus } from "./MoveCell";
import { TreeStateContext } from "./TreeStateContext";
import { MoveDeletionContext } from "./MoveDeletionContext";
import classes from "./GameNotation.module.css";

export type NotationMoveActions =
  | false
  | {
      promote: (path: number[]) => void;
      delete: (path: number[]) => void;
    };
export const NotationMoveActionsContext = createContext<NotationMoveActions | undefined>(undefined);

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
  /** Frame the move as an open variation: a side line one move long, in a notation that marks them. */
  openVariation?: boolean;
  /** Flagged as unsure during an active scoresheet photo review. */
  unsure?: boolean;
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
  openVariation,
  unsure,
  isStart: providedIsStart,
  isCurrentVariation: providedIsCurrentVariation,
  root,
}: CompleteMoveCellProps) {
  const store = useContext(TreeStateContext)!;
  const moveActions = useContext(NotationMoveActionsContext);
  const [currentTab] = useOwnerTab();
  const switchChapter = useFileChapterSwitch();
  const tabFile =
    switchChapter && currentTab?.type === "analysis" ? getTabFile(currentTab) : undefined;
  const openChapter = tabFile ? getTabGameNumber(currentTab) : undefined;
  const { verifiedRevision } = useFileFreshness(currentTab?.value ?? "");
  const activeRevision = tabFile ? verifiedRevision : null;
  const fileIndex = useSyncExternalStore(
    subscribeFilePositionIndex,
    () => (tabFile ? getFilePositionIndex(tabFile.handle, activeRevision) : null),
    () => null,
  );
  const state = store.getState();
  const path = useMemo(() => pathForNotationNode(nodeIndex, node) ?? [], [node, nodeIndex]);
  const isCurrentVariation = providedIsCurrentVariation ?? node === state.currentNode();
  const isStart = providedIsStart ?? equal(path, state.headers.start || []);
  const boardState = useMemo(() => getBoardState(fen), [fen]);
  const boardStateMap = useMemo(() => getMemoizedBoardStateMap(root), [root]);
  const transpositionTarget = useMemo(() => {
    if (path.length === 0) return undefined;
    const rawOccurrences = Object.hasOwn(boardStateMap, boardState)
      ? boardStateMap[boardState]
      : undefined;
    const openOccurrences: OpenChapterOccurrence[] = rawOccurrences
      ? rawOccurrences.map((entry) => ({
          path: entry.path,
          hasContinuation: entry.node.children.length > 0,
        }))
      : [];
    const fileOccurrences =
      fileIndex && openChapter !== undefined
        ? getFileChapterOccurrences(fileIndex, boardState, openChapter)
        : [];
    const moveLine =
      fileOccurrences.length > 0 ? getMoveLine(root, path) : { rootKey: "", moveOrder: "" };
    return getTranspositionTarget(
      {
        path,
        rootKey: moveLine.rootKey,
        moveOrder: moveLine.moveOrder,
        chapter: openChapter,
      },
      openOccurrences,
      fileOccurrences,
    );
  }, [boardState, boardStateMap, fileIndex, openChapter, path, root]);
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
      openVariation={openVariation}
      unsure={unsure}
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
            openVariation={openVariation}
            unsure={unsure}
            onClose={() => setOpen(false)}
          />
        ) : (
          moveCell
        )}
        {transpositionTarget && (
          <TranspositionAction
            target={transpositionTarget}
            onClick={() => {
              if (store.getState().root !== root) return;
              if (transpositionTarget.scope === "chapter") {
                store.getState().goToMove(transpositionTarget.path);
              } else {
                void switchChapter?.(transpositionTarget.chapter, {
                  path: transpositionTarget.path,
                  boardState,
                });
              }
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

function TranspositionAction({
  target,
  onClick,
}: {
  target: TranspositionTarget;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const label =
    target.scope === "file"
      ? t("Notation.TranspositionInChapter", { chapter: target.chapterName })
      : t("Notation.Transposition", { defaultValue: "Transposition" });
  return (
    <IconAction
      label={label}
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
  deleteVariation?: () => void;
  deleteMovesAfter?: () => void;
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
      {actions.deleteVariation && (
        <Menu.Item
          color="danger"
          leftSection={<Trash2 size="0.875rem" />}
          onClick={() => onAction(actions.deleteVariation!)}
        >
          {t("Menu.DeleteVariation")}
        </Menu.Item>
      )}
      {actions.deleteMovesAfter && (
        <Menu.Item
          color="danger"
          leftSection={<Trash2 size="0.875rem" />}
          onClick={() => onAction(actions.deleteMovesAfter!)}
        >
          {t("Menu.DeleteMovesAfter")}
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
  openVariation,
  unsure,
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
  openVariation?: boolean;
  unsure?: boolean;
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
          openVariation={openVariation}
          unsure={unsure}
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
            // A live game's tree mirrors the native game, which only takes back the last move.
            deleteVariation:
              !deletion && variationStartPath(path)
                ? () => actions.deleteVariation(path)
                : undefined,
            deleteMovesAfter:
              !deletion && getNodeAtPath(root, path).children.length > 0
                ? () => actions.deleteMovesAfter(path)
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
    prev.openVariation === next.openVariation &&
    prev.unsure === next.unsure &&
    prev.isStart === next.isStart &&
    prev.isCurrentVariation === next.isCurrentVariation
  );
});
