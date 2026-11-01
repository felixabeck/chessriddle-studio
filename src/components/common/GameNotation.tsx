import { useTabAtom } from "@/state/tabScope";
import { Box, Divider, Group, Overlay, Paper, ScrollArea, Stack, Table, Text } from "@mantine/core";
import {
  ArrowRight,
  Split,
  MessageSquare,
  MessageSquareOff,
  Eye,
  EyeOff,
  TableProperties,
  List,
  Minus,
  Plus,
} from "lucide-react";
import { elementScroll, useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { useAtom, useAtomValue } from "jotai";
import { memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { isTreeViewDeferred, useTreeView } from "@/state/deferredTreeView";
import Comment from "@/components/common/Comment";
import IconAction from "@/components/common/IconAction";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import {
  invisibleFamily,
  showCommentsFamily,
  showVariationsFamily,
  tableViewAtom,
} from "@/state/atoms";
import { keyMapAtom } from "@/state/keybinds";
import { nagGlyphs } from "@/utils/annotation";
import { formatScore } from "@/utils/score";
import { getNodeAtPath, type TreeNode } from "@/utils/treeReducer";
import CompleteMoveCell from "./CompleteMoveCell";
import {
  buildNotationRows,
  type NotationMove,
  type NotationNodeIndex,
  type NotationRow,
  type NotationRows,
} from "./notationRows";
import styles from "./GameNotation.module.css";
import OpeningName from "./OpeningName";
import { GameReferenceProvider } from "./GameReference";

// Bound the frames spent waiting for React to mount a row after its offset scroll.
const NOTATION_REVEAL_MAX_ATTEMPTS = 10;
const notationOffsetScrolls = new WeakMap<
  Virtualizer<HTMLDivElement, Element>,
  { direct: boolean }
>();

export function scrollNotationElement(
  offset: number,
  options: Parameters<typeof elementScroll>[1],
  virtualizer: Virtualizer<HTMLDivElement, Element>,
) {
  const scroll = notationOffsetScrolls.get(virtualizer);
  const pending = virtualizer as unknown as { currentScrollToIndex: number | null };
  // A retry already queued by scheduleRetry calls tryScroll without checking the field first.
  // Guard index writes at the scroll boundary, keeping direct reveals and size adjustments.
  if (
    !scroll ||
    pending.currentScrollToIndex !== null ||
    scroll.direct ||
    options.adjustments !== undefined
  ) {
    elementScroll(offset, options, virtualizer);
  }
}

export function cancelNotationIndexScroll(virtualizer: Virtualizer<HTMLDivElement, Element>) {
  // virtual-core 3.13.18's verify loop checks this private field, which scrollToOffset leaves set.
  const pending = virtualizer as unknown as { currentScrollToIndex: number | null };
  pending.currentScrollToIndex = null;
  if (!notationOffsetScrolls.has(virtualizer)) {
    notationOffsetScrolls.set(virtualizer, { direct: false });
  }
}

export function scrollNotationToOffset(
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  offset: number,
) {
  cancelNotationIndexScroll(virtualizer);
  const scroll = notationOffsetScrolls.get(virtualizer)!;
  scroll.direct = true;
  try {
    virtualizer.scrollToOffset(offset);
  } finally {
    scroll.direct = false;
  }
}

function GameNotation({ topBar, controls }: { topBar?: boolean; controls?: React.ReactNode }) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const { root, headers } = useTreeView(store);
  const currentNode = useStore(store, (s) => s.currentNode());
  const copyPgn = useStore(store, (s) => s.copyPgn);
  const showComments = useAtomValue(useTabAtom(showCommentsFamily));
  const showVariations = useAtomValue(useTabAtom(showVariationsFamily));
  const [tableView] = useAtom(tableViewAtom);
  const [collapsedVariations, setCollapsedVariations] = useState<Set<TreeNode>>(() => new Set());
  const viewport = useRef<HTMLDivElement>(null);
  const [invisibleValue, setInvisible] = useAtom(useTabAtom(invisibleFamily));
  const invisible = topBar && invisibleValue;
  const keyMap = useAtomValue(keyMapAtom);

  const model = useMemo<NotationRows>(() => {
    // A remount while deferred has no previous rows. Skipping avoids walking either tree.
    // An already mounted notation keeps its cached rows because this root has not changed.
    if (isTreeViewDeferred(store)) {
      return { rows: [], index: { root, links: new WeakMap() }, rowForNode: new Map() };
    }
    return buildNotationRows(root, {
      showVariations,
      showComments,
      tableView,
      collapsedVariations,
    });
  }, [root, showVariations, showComments, tableView, collapsedVariations, store]);
  const startNode = useMemo(() => getNodeAtPath(root, headers.start || []), [root, headers.start]);
  const rowVirtualizer = useVirtualizer({
    count: model.rows.length,
    estimateSize: () => 32,
    overscan: 8,
    getScrollElement: () => viewport.current,
    scrollToFn: scrollNotationElement,
  });

  useEffect(() => {
    let node: TreeNode | null = currentNode;
    let rowIndex: number | undefined;
    while (node) {
      rowIndex = model.rowForNode.get(node);
      if (rowIndex !== undefined) break;
      const link = model.index.links.get(node);
      node = link?.parent ?? null;
    }
    if (rowIndex !== undefined) {
      const scrollViewport = viewport.current;
      if (node !== currentNode || !scrollViewport || scrollViewport.clientHeight === 0) {
        rowVirtualizer.scrollToIndex(rowIndex, { align: "center" });
        return;
      }

      const rowSelector = `[data-index="${rowIndex}"]`;
      const mountedRow = scrollViewport.querySelector<HTMLElement>(rowSelector);
      if (mountedRow && mountedRow.getBoundingClientRect().height <= scrollViewport.clientHeight) {
        rowVirtualizer.scrollToIndex(rowIndex, { align: "center" });
        return;
      }

      // Cancel an earlier selection's verification even when this cell already needs no scroll.
      cancelNotationIndexScroll(rowVirtualizer);
      // Mount the row without an index-scroll retry that could later recenter a tall row.
      if (!mountedRow) {
        const offset = rowVirtualizer.getOffsetForIndex(rowIndex, "start");
        if (!offset) return;
        scrollNotationToOffset(rowVirtualizer, offset[0]);
      }

      let frame: number;
      let attempts = 0;
      const revealMove = () => {
        const row = scrollViewport.querySelector<HTMLElement>(rowSelector);
        if (!row) {
          if (++attempts < NOTATION_REVEAL_MAX_ATTEMPTS) frame = requestAnimationFrame(revealMove);
          return;
        }
        if (row.getBoundingClientRect().height <= scrollViewport.clientHeight) {
          rowVirtualizer.scrollToIndex(rowIndex, { align: "center" });
          return;
        }
        const cell = row.querySelector<HTMLElement>('[data-notation-current="true"]');
        if (!cell) return;
        const cellBounds = cell.getBoundingClientRect();
        const viewportTop = scrollViewport.getBoundingClientRect().top + scrollViewport.clientTop;
        const viewportBottom = viewportTop + scrollViewport.clientHeight;
        const delta =
          cellBounds.top < viewportTop
            ? cellBounds.top - viewportTop
            : cellBounds.bottom > viewportBottom
              ? cellBounds.bottom - viewportBottom
              : 0;
        if (delta) {
          // Fractional text bounds need the browser's scroll offset rounded toward visibility.
          const offset = scrollViewport.scrollTop + delta;
          scrollNotationToOffset(
            rowVirtualizer,
            delta > 0 ? Math.ceil(offset) : Math.floor(offset),
          );
        }
      };
      // Give the mounted row and ResizeObserver a frame to settle before reading geometry.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(revealMove);
      });
      return () => cancelAnimationFrame(frame);
    } else if (model.rows.length > 0) {
      rowVirtualizer.scrollToIndex(0, { align: "start" });
    }
  }, [currentNode, model, rowVirtualizer]);

  useHotkeys(keyMap.TOGGLE_BLUR.keys, () => setInvisible((value) => !value));
  useHotkeys(keyMap.COPY_PGN.keys, () => copyPgn());

  const content = (
    <Paper withBorder flex={1} style={{ position: "relative", overflow: "hidden" }}>
      <Group h="100%" wrap="nowrap" align="stretch" gap={0}>
        {controls && (
          <Box className={styles.toolbar} style={{ flexShrink: 0 }}>
            <ScrollArea type="never" h="100%" py="md" px="xs">
              {controls}
            </ScrollArea>
          </Box>
        )}
        <Stack h="100%" gap={0} style={{ flex: 1, minWidth: 0 }}>
          {topBar && <NotationHeader />}
          <ScrollArea flex={1} offsetScrollbars scrollbars="y" viewportRef={viewport}>
            <Stack gap="xs">
              <Box>
                {invisible && (
                  <Overlay backgroundOpacity={0.6} color="var(--cf-inset)" blur={8} zIndex={2} />
                )}
                <Box
                  style={{
                    height: rowVirtualizer.getTotalSize(),
                    width: "100%",
                    position: "relative",
                  }}
                >
                  {rowVirtualizer.getVirtualItems().map((virtualRow) => (
                    <NotationVirtualRow
                      key={virtualRow.index}
                      row={model.rows[virtualRow.index]}
                      index={model.index}
                      root={root}
                      currentNode={currentNode}
                      startNode={startNode}
                      showComments={showComments}
                      tableView={tableView}
                      onToggleVariation={(parent) => {
                        setCollapsedVariations((previous) => {
                          const next = new Set(previous);
                          if (next.has(parent)) next.delete(parent);
                          else next.add(parent);
                          return next;
                        });
                      }}
                      measureRef={rowVirtualizer.measureElement}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                      dataIndex={virtualRow.index}
                    />
                  ))}
                </Box>
              </Box>
              <Box pb="md">
                {headers.result !== "*" && (
                  <Text ta="center">
                    {headers.result}
                    <br />
                    <Text span fs="italic">
                      {headers.result === "1/2-1/2"
                        ? t("Board.Analysis.Tablebase.Draw")
                        : headers.result === "1-0"
                          ? t("Board.Analysis.Tablebase.WhiteWins")
                          : t("Board.Analysis.Tablebase.BlackWins")}
                    </Text>
                  </Text>
                )}
              </Box>
            </Stack>
          </ScrollArea>
        </Stack>
      </Group>
    </Paper>
  );
  return <GameReferenceProvider>{content}</GameReferenceProvider>;
}

function NotationHeader() {
  const { t } = useTranslation();
  const [invisible, setInvisible] = useAtom(useTabAtom(invisibleFamily));
  const [showComments, setShowComments] = useAtom(useTabAtom(showCommentsFamily));
  const [showVariations, setShowVariations] = useAtom(useTabAtom(showVariationsFamily));
  const [tableView, setTableView] = useAtom(tableViewAtom);
  return (
    <Stack gap="xs" pt="xs">
      <Group justify="space-between" px="sm">
        <OpeningName />
        <Group gap="sm">
          <IconAction
            label={invisible ? t("Notation.ShowMoves") : t("Notation.HideMoves")}
            onClick={() => setInvisible((value) => !value)}
            pressed={!invisible}
          >
            {invisible ? <EyeOff size="1rem" /> : <Eye size="1rem" />}
          </IconAction>
          <IconAction
            label={tableView ? t("Notation.NormalView") : t("Notation.TableView")}
            onClick={() => setTableView((value) => !value)}
            pressed={tableView}
          >
            {tableView ? <List size="1rem" /> : <TableProperties size="1rem" />}
          </IconAction>
          <IconAction
            label={showComments ? t("Notation.HideComments") : t("Notation.ShowComments")}
            onClick={() => setShowComments((value) => !value)}
            pressed={showComments}
          >
            {showComments ? <MessageSquare size="1rem" /> : <MessageSquareOff size="1rem" />}
          </IconAction>
          <IconAction
            label={showVariations ? t("Notation.HideVariations") : t("Notation.ShowVariations")}
            onClick={() => setShowVariations((value) => !value)}
            pressed={showVariations}
          >
            {showVariations ? <Split size="1rem" /> : <ArrowRight size="1rem" />}
          </IconAction>
        </Group>
      </Group>
      <Divider />
    </Stack>
  );
}

function NotationVirtualRow({
  row,
  index,
  root,
  currentNode,
  startNode,
  showComments,
  tableView,
  onToggleVariation,
  measureRef,
  style,
  dataIndex,
}: {
  row: NotationRow;
  index: NotationNodeIndex;
  root: TreeNode;
  currentNode: TreeNode;
  startNode: TreeNode;
  showComments: boolean;
  tableView: boolean;
  onToggleVariation: (parent: TreeNode) => void;
  measureRef: (element: Element | null) => void;
  style: React.CSSProperties;
  dataIndex: number;
}) {
  return (
    <Box ref={measureRef} data-index={dataIndex} style={style}>
      {row.type === "comment" && <CommentRow row={row} tableView={tableView} />}
      {row.type === "variation" && (
        <VariationRow row={row} onToggle={() => onToggleVariation(row.parent)} />
      )}
      {row.type === "moves" && (
        <InlineRow
          row={row}
          index={index}
          root={root}
          currentNode={currentNode}
          startNode={startNode}
          showComments={showComments}
        />
      )}
      {row.type === "table" && (
        <TableRow
          row={row}
          index={index}
          root={root}
          currentNode={currentNode}
          startNode={startNode}
          showComments={showComments}
        />
      )}
    </Box>
  );
}

function moveProps(
  move: NotationMove,
  index: NotationNodeIndex,
  root: TreeNode,
  currentNode: TreeNode,
  startNode: TreeNode,
  showComments: boolean,
  tableLayout?: boolean,
  scoreText?: string,
) {
  return {
    node: move.node,
    nodeIndex: index,
    root,
    halfMoves: move.node.halfMoves,
    move: move.node.san,
    fen: move.node.fen,
    comment: move.node.comment,
    startingComment: move.startingComment,
    annotations: nagGlyphs(move.node.nags),
    showComments,
    first: move.first,
    isStart: move.node === startNode,
    isCurrentVariation: move.node === currentNode,
    tableLayout,
    scoreText,
  };
}

function variationBlockStyle(guideDepth: number): React.CSSProperties {
  return { "--notation-variation-depth": guideDepth } as React.CSSProperties;
}

function InlineRow({
  row,
  index,
  root,
  currentNode,
  startNode,
  showComments,
}: {
  row: Extract<NotationRow, { type: "moves" }>;
  index: NotationNodeIndex;
  root: TreeNode;
  currentNode: TreeNode;
  startNode: TreeNode;
  showComments: boolean;
}) {
  const isVariationBlock = row.depth >= 1;
  return (
    <Box
      className={isVariationBlock ? styles.variationBlock : undefined}
      style={isVariationBlock ? variationBlockStyle(row.depth) : undefined}
    >
      {row.moves.map((move) => (
        <CompleteMoveCell
          key={move.node.fen}
          {...moveProps(move, index, root, currentNode, startNode, showComments)}
        />
      ))}
    </Box>
  );
}

function CommentRow({
  row,
  tableView,
}: {
  row: Extract<NotationRow, { type: "comment" }>;
  tableView: boolean;
}) {
  if (tableView) {
    return (
      <Table layout="fixed">
        <Table.Tbody>
          <Table.Tr>
            <Table.Td colSpan={3}>
              <Box pl="sm" pt="xs">
                <Comment comment={row.comment} />
              </Box>
            </Table.Td>
          </Table.Tr>
        </Table.Tbody>
      </Table>
    );
  }
  return (
    <Box pl="sm" pt="xs" style={row.depth ? { marginLeft: row.depth * 12 } : undefined}>
      <Comment comment={row.comment} />
    </Box>
  );
}

function VariationRow({
  row,
  onToggle,
}: {
  row: Extract<NotationRow, { type: "variation" }>;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Box
      className={`${styles.variationBlock} ${styles.variationToggle}`}
      // A toggle row carries its parent's depth while the alternatives it controls are at
      // depth + 1, so the toggle shares their first guide line.
      style={variationBlockStyle(row.depth + 1)}
    >
      <IconAction
        label={t("Notation.ToggleVariation")}
        size="xs"
        onClick={onToggle}
        pressed={!row.collapsed}
      >
        {row.collapsed ? <Plus size="0.5rem" /> : <Minus size="0.5rem" />}
      </IconAction>
    </Box>
  );
}

function TableRow({
  row,
  index,
  root,
  currentNode,
  startNode,
  showComments,
}: {
  row: Extract<NotationRow, { type: "table" }>;
  index: NotationNodeIndex;
  root: TreeNode;
  currentNode: TreeNode;
  startNode: TreeNode;
  showComments: boolean;
}) {
  return (
    <Table layout="fixed">
      <Table.Tbody>
        <Table.Tr>
          <Table.Td className={styles.moveTableMoveNumber}>{row.moveNumber}</Table.Td>
          <Table.Td className={styles.moveTableCell}>
            {row.white ? (
              <CompleteMoveCell
                {...moveProps(
                  row.white,
                  index,
                  root,
                  currentNode,
                  startNode,
                  showComments,
                  true,
                  showComments && row.white.node.score
                    ? formatScore(row.white.node.score.value, 1)
                    : undefined,
                )}
              />
            ) : (
              <Text c="dimmed" style={{ padding: "5px 8px" }}>
                ...
              </Text>
            )}
          </Table.Td>
          <Table.Td className={styles.moveTableCell}>
            {row.black ? (
              <CompleteMoveCell
                {...moveProps(
                  row.black,
                  index,
                  root,
                  currentNode,
                  startNode,
                  showComments,
                  true,
                  showComments && row.black.node.score
                    ? formatScore(row.black.node.score.value, 1)
                    : undefined,
                )}
              />
            ) : row.splitRow ? (
              <Text c="dimmed" style={{ padding: "5px 8px" }}>
                ...
              </Text>
            ) : null}
          </Table.Td>
        </Table.Tr>
      </Table.Tbody>
    </Table>
  );
}

export default memo(GameNotation);
