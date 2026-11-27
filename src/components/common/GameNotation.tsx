import { useTabAtom } from "@/state/tabScope";
import {
  Box,
  Group,
  Menu,
  Overlay,
  Paper,
  ScrollArea,
  SegmentedControl,
  Stack,
  Table,
  Text,
  UnstyledButton,
  Button,
} from "@mantine/core";
import {
  Check,
  Split,
  MessageSquare,
  Eye,
  EyeOff,
  Grid2x2,
  SlidersHorizontal,
  TableProperties,
  Minus,
  Plus,
} from "lucide-react";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { useAtom, useAtomValue } from "jotai";
import type { TFunction } from "i18next";
import {
  memo,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MiniBoard } from "@/components/common/MiniBoard";
import { useHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { isTreeViewDeferred, useTreeView } from "@/state/deferredTreeView";
import Comment from "@/components/common/Comment";
import IconAction from "@/components/common/IconAction";
import { NotationIcon } from "@/components/common/iconCatalog";
import PanelHeader from "@/components/boards/PanelHeader";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import {
  invisibleFamily,
  moveHighlightAtom,
  opponentPreparationAtom,
  showCommentsFamily,
  showDiagramsFamily,
  showVariationsFamily,
  tabPreparationViewFamily,
  tableViewAtom,
} from "@/state/atoms";
import { classifyTreeNodes, preparationViewForSource } from "@/utils/opponentPreparation";
import { lastMoveSquares, positionFromFen } from "@/utils/chessops";
import { keyMapAtom } from "@/state/keybinds";
import { nagGlyphs } from "@/utils/annotation";
import { formatScore } from "@/utils/score";
import {
  displayedScore,
  getEffectiveGameEnd,
  getEffectiveTermination,
  getNodeAtPath,
  type TreeNode,
} from "@/utils/treeReducer";
import CompleteMoveCell, {
  NotationMoveActionsContext,
  type NotationMoveActions,
} from "./CompleteMoveCell";
import {
  buildNotationRows,
  collapseKeysOnPath,
  collapseMoveToken,
  pathForNotationNode,
  variationCollapseKey,
  type NotationMove,
  type NotationNodeIndex,
  type NotationRow,
  type NotationRows,
} from "./notationRows";
import styles from "./GameNotation.module.css";
import OpeningName from "./OpeningName";
import { GameReferenceProvider } from "./GameReference";

// Room for three inline move rows, including their padding and line boxes.
const NOTATION_MIN_HEIGHT_REM = "9rem";

// Strong enough that SAN at any notation font size cannot be read through it (f-20261125-10).
const HIDDEN_NOTATION_FILTER = "blur(8px)";

// Bound the frames spent waiting for React to mount a row after its offset scroll.
const NOTATION_REVEAL_MAX_ATTEMPTS = 10;
const NOTATION_INDEX_SCROLL_MAX_ATTEMPTS = 10;
// Consecutive checks with an unchanged list height before a matching target counts as settled.
const NOTATION_INDEX_SCROLL_STABLE_CHECKS = 3;
// Sub-pixel differences come from fractional layout and need no further scroll.
const NOTATION_INDEX_SCROLL_TOLERANCE_PX = 1;
// The virtualizer's row estimate; the follow margin is expressed in these rows.
const NOTATION_ROW_ESTIMATE_PX = 32;
// Stepping through moves keeps the list still until the current move is about three rows from an
// edge, then turns the page so it sits that far from the other edge.
const NOTATION_FOLLOW_MARGIN_PX = 3 * NOTATION_ROW_ESTIMATE_PX;
// Each margin takes at most a quarter of a short panel, so at least half of it stays a still band.
const NOTATION_FOLLOW_MARGIN_PANEL_DIVISOR = 4;
const NOTATION_PAGE_TURN_MS = 150;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

type NotationStep = "forward" | "backward" | "jump";

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** The current cell's bounds in scroll-content coordinates, or null when it is not rendered. */
function currentCellBounds(viewport: HTMLDivElement): { top: number; bottom: number } | null {
  const cell = viewport.querySelector<HTMLElement>('[data-notation-current="true"]');
  if (!cell) return null;
  const viewportTop = viewport.getBoundingClientRect().top + viewport.clientTop;
  const bounds = cell.getBoundingClientRect();
  return {
    top: bounds.top - viewportTop + viewport.scrollTop,
    bottom: bounds.bottom - viewportTop + viewport.scrollTop,
  };
}

/**
 * Keeps the current move visible on a cursor move inside an unchanged list: a one-ply step turns
 * the page only when the move reaches the margin in its direction of travel, a jump to a visible
 * move or a click on one does not scroll. Returns undefined when the caller's centre/reveal path
 * should decide instead (row not mounted or taller than the viewport, current cell not rendered,
 * or a jump to a move outside the viewport); otherwise the effect cleanup.
 */
function followNotationMove({
  virtualizer,
  viewport,
  rowIndex,
  step,
  clicked,
  interruptedTarget,
  onInterrupt,
}: {
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  viewport: HTMLDivElement;
  rowIndex: number;
  step: NotationStep;
  clicked: boolean;
  interruptedTarget: number | null;
  onInterrupt: (target: number) => void;
}): (() => void) | undefined {
  const height = viewport.clientHeight;
  const row = viewport.querySelector<HTMLElement>(`[data-index="${rowIndex}"]`);
  if (!row || row.getBoundingClientRect().height > height) return undefined;
  if (!viewport.querySelector('[data-notation-current="true"]')) return undefined;

  // Key repeat: finish the interrupted page turn first, so the board never runs ahead of the list.
  if (step !== "jump" && !clicked && interruptedTarget !== null) {
    virtualizer.scrollToOffset(interruptedTarget);
  }

  const top = viewport.scrollTop;
  const cell = currentCellBounds(viewport)!;
  const fullyVisible = cell.top >= top && cell.bottom <= top + height;
  const noCleanup = () => {};

  if (clicked && fullyVisible) return noCleanup;
  if (step === "jump") return fullyVisible ? noCleanup : undefined;

  // A cell taller than the band shrinks the margin so the whole cell still fits.
  const margin = Math.max(
    0,
    Math.min(
      NOTATION_FOLLOW_MARGIN_PX,
      Math.floor(height / NOTATION_FOLLOW_MARGIN_PANEL_DIVISOR),
      Math.floor((height - (cell.bottom - cell.top)) / 2),
    ),
  );
  const turnsForward =
    step === "forward" && (cell.bottom > top + height - margin || cell.top < top);
  const turnsBackward =
    step === "backward" && (cell.top < top + margin || cell.bottom > top + height);
  if (!turnsForward && !turnsBackward) return noCleanup;

  // Rounding toward the cell keeps it inside the new band despite fractional text bounds. The
  // target is re-read from the cell on every frame: rows mounted by the turn are measured on the
  // way and move the cell, which a precomputed offset would overwrite.
  const targetFor = (bounds: { top: number; bottom: number }) => {
    const target = turnsForward
      ? Math.floor(bounds.top - margin)
      : Math.ceil(bounds.bottom - height + margin);
    return Math.max(0, Math.min(target, viewport.scrollHeight - height));
  };
  let target = targetFor(cell);
  const distance = target - top;
  if (Math.abs(distance) < NOTATION_INDEX_SCROLL_TOLERANCE_PX) return noCleanup;
  const retarget = () => {
    const bounds = currentCellBounds(viewport);
    if (bounds) target = targetFor(bounds);
  };

  let cancelled = false;
  let finished = false;
  let frame: number;
  let settleChecks = 0;
  let stableChecks = 0;
  // After the turn, follow late measurements until the target has held still for a few frames.
  const settle = () => {
    if (cancelled) return;
    retarget();
    if (Math.abs(target - viewport.scrollTop) >= NOTATION_INDEX_SCROLL_TOLERANCE_PX) {
      virtualizer.scrollToOffset(target);
      stableChecks = 0;
    } else {
      stableChecks++;
    }
    if (
      ++settleChecks < NOTATION_INDEX_SCROLL_MAX_ATTEMPTS &&
      stableChecks < NOTATION_INDEX_SCROLL_STABLE_CHECKS
    ) {
      frame = requestAnimationFrame(settle);
    }
  };
  const finish = () => {
    finished = true;
    virtualizer.scrollToOffset(target);
    frame = requestAnimationFrame(settle);
  };

  if (prefersReducedMotion()) {
    finish();
  } else {
    let startTime: number | undefined;
    frame = requestAnimationFrame(function turnPage() {
      if (cancelled) return;
      const now = performance.now();
      startTime ??= now;
      const progress = Math.min(1, (now - startTime) / NOTATION_PAGE_TURN_MS);
      retarget();
      if (progress >= 1) {
        finish();
        return;
      }
      const eased = 1 - (1 - progress) ** 3;
      virtualizer.scrollToOffset(target - distance * (1 - eased));
      frame = requestAnimationFrame(turnPage);
    });
  }
  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
    if (!finished) onInterrupt(target);
  };
}

export function scrollNotationToIndex(
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  index: number,
  align: "center" | "start",
): () => void {
  const offsetInfo = virtualizer.getOffsetForIndex(index, align);
  if (!offsetInfo) return () => {};
  const [offset, resolvedAlign] = offsetInfo;
  let cancelled = false;
  let frame: number;
  let attempts = 1;
  let measuredSize = virtualizer.getTotalSize();
  let stableChecks = 0;

  const verify = () => {
    if (cancelled) return;
    if (attempts >= NOTATION_INDEX_SCROLL_MAX_ATTEMPTS) return;
    // getTotalSize refreshes the virtualizer's measurements, which getOffsetForIndex reads as is.
    const totalSize = virtualizer.getTotalSize();
    const target = virtualizer.getOffsetForIndex(index, resolvedAlign);
    stableChecks = totalSize === measuredSize ? stableChecks + 1 : 0;
    measuredSize = totalSize;
    if (
      target &&
      Math.abs(target[0] - (virtualizer.scrollOffset ?? 0)) >= NOTATION_INDEX_SCROLL_TOLERANCE_PX
    ) {
      attempts++;
      virtualizer.scrollToOffset(target[0]);
      scheduleVerification();
    } else if (stableChecks < NOTATION_INDEX_SCROLL_STABLE_CHECKS) {
      // Rows can still be measured after the first check (a view switch makes them taller over
      // several frames on a slow machine), which moves a target that matches now. Keep checking
      // until the list's height has held still for a few checks.
      attempts++;
      scheduleVerification();
    }
  };
  const scheduleVerification = () => {
    frame = requestAnimationFrame(() => {
      if (cancelled) return;
      frame = requestAnimationFrame(verify);
    });
  };

  virtualizer.scrollToOffset(offset);
  scheduleVerification();
  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
  };
}

function getResultText(result: string, t: TFunction): string | undefined {
  switch (result) {
    case "1-0":
      return t("Board.Analysis.Tablebase.WhiteWins");
    case "0-1":
      return t("Board.Analysis.Tablebase.BlackWins");
    case "1/2-1/2":
      return t("Board.Analysis.Tablebase.Draw");
    default:
      return undefined;
  }
}

type PreparationHeaderState = {
  opponentName: string;
  showAllLines: boolean;
  onShowAllLinesChange: (showAllLines: boolean) => void;
};

type NotationArrangeProps = {
  onDragStart: (event: ReactPointerEvent<HTMLElement>) => void;
  onSuppressClick: (event: ReactMouseEvent) => void;
  onStartPlacing: () => void;
};

function GameNotation({
  topBar,
  arrange,
  headerActions,
  moveActions,
  markOpenVariations,
  hidden,
  onReveal,
}: {
  topBar?: boolean;
  /** Arranging callbacks for the notation header's grip and drag handle; omit when arranging is unavailable. */
  arrange?: NotationArrangeProps;
  /** Optional controls rendered at the right end of the notation header after the View menu. */
  headerActions?: React.ReactNode;
  moveActions?: NotationMoveActions;
  /**
   * Frame side lines that are one move long. Set where the tree is a file being built (the
   * analysis board); a puzzle solution, a database preview or a game in play has no line to finish.
   */
  markOpenVariations?: boolean;
  /** Hide the moves regardless of the tab's hide-moves state (used by previews, which have no top bar). */
  hidden?: boolean;
  /** Called by the overlay's Show moves button to reveal this notation instance. */
  onReveal?: () => void;
}) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const { root, headers } = useTreeView(store);
  const gameEnd = useMemo(
    () => (isTreeViewDeferred(store) ? undefined : getEffectiveGameEnd(root)),
    [root, store],
  );
  const termination = useMemo(
    () => (isTreeViewDeferred(store) ? undefined : getEffectiveTermination({ root, headers })),
    [root, headers, store],
  );
  const currentNode = useStore(store, (s) => s.currentNode());
  const position = useStore(store, (s) => s.position);
  const copyPgn = useStore(store, (s) => s.copyPgn);
  const hasScoresheetReview = useStore(store, (s) => s.scoresheetReview !== undefined);
  const showComments = useAtomValue(useTabAtom(showCommentsFamily));
  const showVariations = useAtomValue(useTabAtom(showVariationsFamily));
  const showDiagrams = useAtomValue(useTabAtom(showDiagramsFamily));
  const [tableView] = useAtom(tableViewAtom);
  const [collapsedVariations, setCollapsedVariations] = useState<Set<string>>(() => new Set());
  const [revealedVariations, setRevealedVariations] = useState<Set<string>>(() => new Set());
  const storedPreparation = useAtomValue(opponentPreparationAtom);
  const [preparationView, setPreparationView] = useAtom(useTabAtom(tabPreparationViewFamily));
  const viewport = useRef<HTMLDivElement>(null);
  // Follow-scroll bookkeeping, read and reset by the scroll effect on every run.
  const previousModel = useRef<NotationRows | null>(null);
  const previousNode = useRef<TreeNode | null>(null);
  // The current move when a click inside the notation began (set in the viewport's capture phase,
  // before the move cell navigates). The scroll effect consumes it for the navigation that click
  // caused. A click that navigated nowhere (the current move, a comment, a game reference that
  // stops propagation, empty space) is dropped by a task queued behind the click's dispatch: the
  // store updates synchronously inside the click, so an unchanged current node then proves the click
  // did not navigate, and the next key, button or wheel step never inherits it.
  const notationClickFrom = useRef<TreeNode | null>(null);
  const notationClickCheck = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const interruptedTarget = useRef<number | null>(null);
  useEffect(() => () => clearTimeout(notationClickCheck.current), []);
  const [invisibleValue, setInvisible] = useAtom(useTabAtom(invisibleFamily));
  const invisible = hidden === true || (!!topBar && invisibleValue);
  const keyMap = useAtomValue(keyMapAtom);

  const activePreparation =
    storedPreparation !== null &&
    preparationView !== null &&
    preparationView.preparationId === storedPreparation.id
      ? storedPreparation
      : null;

  useEffect(() => {
    setRevealedVariations((previous) => (previous.size > 0 ? new Set() : previous));
  }, [activePreparation?.id]);

  const activePreparationView = activePreparation
    ? preparationViewForSource(activePreparation.views, activePreparation.source)
    : null;

  const treeClassification = useMemo(() => {
    if (!activePreparation || !activePreparationView || isTreeViewDeferred(store)) {
      return null;
    }
    return classifyTreeNodes(
      root,
      headers.orientation,
      activePreparation.opponentColor,
      activePreparationView.playedPositions,
    );
  }, [activePreparation, activePreparationView, headers.orientation, root, store]);

  const preparationInChapter = treeClassification?.inPreparation === true;

  const hiddenVariations = useMemo(() => {
    if (!preparationInChapter || !treeClassification || preparationView?.showAllLines) {
      return undefined;
    }
    const hidden = new Set<TreeNode>();
    const stack: { node: TreeNode; key: string }[] = [{ node: root, key: "" }];
    while (stack.length > 0) {
      const { node, key } = stack.pop()!;
      const parentRevealed = node.children.length > 1 && revealedVariations.has(key);
      for (let i = 0; i < node.children.length; i += 1) {
        const child = node.children[i];
        if (i >= 1 && !parentRevealed && !treeClassification.nodes.get(child)?.relevant) {
          hidden.add(child);
        }
        const token = collapseMoveToken(child);
        const childKey = key ? `${key} ${token}` : token;
        stack.push({ node: child, key: childKey });
      }
    }
    return hidden.size > 0 ? hidden : undefined;
  }, [
    preparationInChapter,
    treeClassification,
    preparationView?.showAllLines,
    root,
    revealedVariations,
  ]);

  const model = useMemo<NotationRows>(() => {
    // A remount while deferred has no previous rows. Skipping avoids walking either tree.
    // An already mounted notation keeps its cached rows because this root has not changed.
    if (isTreeViewDeferred(store)) {
      return { rows: [], index: { root, links: new WeakMap() }, rowForNode: new Map() };
    }
    return buildNotationRows(root, {
      showVariations: moveActions === undefined ? showVariations : true,
      showComments,
      showDiagrams,
      tableView: moveActions === undefined ? tableView : false,
      collapsedVariations,
      hiddenVariations,
      markOpenVariations,
    });
  }, [
    root,
    showVariations,
    showComments,
    showDiagrams,
    tableView,
    collapsedVariations,
    hiddenVariations,
    markOpenVariations,
    store,
    moveActions,
  ]);
  const startNode = useMemo(() => getNodeAtPath(root, headers.start || []), [root, headers.start]);

  // A cursor that lands inside a collapsed or preparation-hidden variation opens it, so the
  // current move is never hidden. Keyed on the path, not the node: editing the current move
  // replaces its node, and that must not reopen a variation the user has just collapsed around it.
  const revealedPosition = useRef<string | null>(null);
  useEffect(() => {
    const positionKey = position.join(",");
    if (revealedPosition.current !== positionKey) {
      revealedPosition.current = positionKey;
      const hiding = collapseKeysOnPath(root, position);
      setCollapsedVariations((previous) =>
        hiding.some((key) => previous.has(key))
          ? new Set([...previous].filter((key) => !hiding.includes(key)))
          : previous,
      );
    }
    const hiddenHiding = hiddenVariations
      ? collapseKeysOnPath(root, position, hiddenVariations)
      : [];
    if (hiddenHiding.length > 0) {
      setRevealedVariations((previous) => {
        if (hiddenHiding.every((key) => previous.has(key))) return previous;
        const next = new Set(previous);
        for (const key of hiddenHiding) next.add(key);
        return next;
      });
    }
  }, [position, root, hiddenVariations]);

  const rowVirtualizer = useVirtualizer({
    count: model.rows.length,
    estimateSize: () => NOTATION_ROW_ESTIMATE_PX,
    overscan: 8,
    getScrollElement: () => viewport.current,
  });

  useEffect(() => {
    const lastModel = previousModel.current;
    const lastNode = previousNode.current;
    previousModel.current = model;
    previousNode.current = currentNode;
    const clicked = notationClickFrom.current !== null;
    notationClickFrom.current = null;
    const interrupted = interruptedTarget.current;
    interruptedTarget.current = null;

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
      // Only a cursor move inside the list that was already measured follows; opening, restoring
      // and every view or filter change (a new model) centre below with settle verification.
      if (
        lastNode !== null &&
        lastModel === model &&
        node === currentNode &&
        scrollViewport &&
        scrollViewport.clientHeight > 0
      ) {
        const links = model.index.links;
        const step: NotationStep =
          links.get(currentNode)?.parent === lastNode
            ? "forward"
            : links.get(lastNode)?.parent === currentNode
              ? "backward"
              : "jump";
        const cleanup = followNotationMove({
          virtualizer: rowVirtualizer,
          viewport: scrollViewport,
          rowIndex,
          step,
          clicked,
          interruptedTarget: interrupted,
          onInterrupt: (target) => {
            interruptedTarget.current = target;
          },
        });
        if (cleanup) return cleanup;
      }
      if (node !== currentNode || !scrollViewport || scrollViewport.clientHeight === 0) {
        return scrollNotationToIndex(rowVirtualizer, rowIndex, "center");
      }

      const rowSelector = `[data-index="${rowIndex}"]`;
      const mountedRow = scrollViewport.querySelector<HTMLElement>(rowSelector);
      if (mountedRow && mountedRow.getBoundingClientRect().height <= scrollViewport.clientHeight) {
        return scrollNotationToIndex(rowVirtualizer, rowIndex, "center");
      }

      // The previous effect cleanup cancels the earlier selection's verification.
      // Mount the row without an index-scroll retry that could later recenter a tall row.
      if (!mountedRow) {
        const offset = rowVirtualizer.getOffsetForIndex(rowIndex, "start");
        if (!offset) return;
        rowVirtualizer.scrollToOffset(offset[0]);
      }

      let frame: number;
      let attempts = 0;
      let cancelled = false;
      let cancelIndexScroll: (() => void) | undefined;
      const revealMove = () => {
        if (cancelled) return;
        const row = scrollViewport.querySelector<HTMLElement>(rowSelector);
        if (!row) {
          if (++attempts < NOTATION_REVEAL_MAX_ATTEMPTS) frame = requestAnimationFrame(revealMove);
          return;
        }
        if (row.getBoundingClientRect().height <= scrollViewport.clientHeight) {
          cancelIndexScroll = scrollNotationToIndex(rowVirtualizer, rowIndex, "center");
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
          rowVirtualizer.scrollToOffset(delta > 0 ? Math.ceil(offset) : Math.floor(offset));
        }
      };
      // Give the mounted row and ResizeObserver a frame to settle before reading geometry.
      frame = requestAnimationFrame(() => {
        if (cancelled) return;
        frame = requestAnimationFrame(revealMove);
      });
      return () => {
        cancelled = true;
        cancelAnimationFrame(frame);
        cancelIndexScroll?.();
      };
    } else if (model.rows.length > 0) {
      return scrollNotationToIndex(rowVirtualizer, 0, "start");
    }
    return undefined;
  }, [currentNode, model, rowVirtualizer]);

  useHotkeys(keyMap.TOGGLE_BLUR.keys, () => setInvisible((value) => !value));
  useHotkeys(keyMap.COPY_PGN.keys, () => copyPgn());

  const preparationHeader: PreparationHeaderState | null =
    preparationInChapter && activePreparation && preparationView
      ? {
          opponentName: activePreparation.opponentName,
          showAllLines: preparationView.showAllLines,
          onShowAllLinesChange: (showAllLines) =>
            setPreparationView((current) => (current ? { ...current, showAllLines } : current)),
        }
      : null;

  const content = (
    <Paper
      withBorder
      flex={1}
      style={{
        position: "relative",
        overflow: "hidden",
        minHeight: topBar ? "min-content" : undefined,
        flexShrink: topBar ? 0 : undefined,
      }}
    >
      <Stack h="100%" gap={0} style={{ flex: 1, minWidth: 0 }}>
        {topBar && (
          <NotationHeader
            preparation={preparationHeader}
            arrange={arrange}
            headerActions={headerActions}
          />
        )}
        <ScrollArea
          flex={topBar ? "1 1 0px" : 1}
          mih={topBar ? NOTATION_MIN_HEIGHT_REM : undefined}
          offsetScrollbars
          scrollbars="y"
          viewportRef={viewport}
          viewportProps={{
            onClickCapture: () => {
              const from = store.getState().currentNode();
              notationClickFrom.current = from;
              clearTimeout(notationClickCheck.current);
              notationClickCheck.current = setTimeout(() => {
                if (notationClickFrom.current === from && store.getState().currentNode() === from) {
                  notationClickFrom.current = null;
                }
              });
            },
          }}
        >
          <Stack gap="xs">
            <Box>
              {invisible && (
                <Overlay
                  backgroundOpacity={0.6}
                  color="var(--cf-inset)"
                  zIndex={2}
                  center={onReveal != null}
                >
                  {onReveal ? (
                    <Button onClick={onReveal}>{t("Notation.ShowMoves")}</Button>
                  ) : undefined}
                </Overlay>
              )}
              {/* The overlay only blocks the pointer. `inert` also takes the hidden moves out of
                    the tab order and the accessibility tree, so neither Tab + Enter nor a screen
                    reader reaches the drill's answer (f-20261119-15). The rows blur themselves rather
                    than relying on an overlay backdrop-filter, which WebKit does not apply to these
                    transformed rows, so the moves stayed readable (f-20261125-10). */}
              <Box
                data-notation-rows
                inert={invisible}
                style={{
                  height: rowVirtualizer.getTotalSize(),
                  width: "100%",
                  position: "relative",
                  filter: invisible ? HIDDEN_NOTATION_FILTER : undefined,
                }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => (
                  <NotationVirtualRow
                    key={virtualRow.index}
                    row={model.rows[virtualRow.index]}
                    result={headers.result}
                    termination={termination}
                    index={model.index}
                    root={root}
                    currentNode={currentNode}
                    startNode={startNode}
                    showComments={showComments}
                    hasScoresheetReview={hasScoresheetReview}
                    tableView={tableView}
                    orientation={headers.orientation ?? "white"}
                    onToggleVariation={(parent) => {
                      const path = pathForNotationNode(model.index, parent);
                      if (path === undefined) return;
                      const key = variationCollapseKey(root, path);
                      setCollapsedVariations((previous) => {
                        const next = new Set(previous);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        return next;
                      });
                    }}
                    onRevealVariation={(parent) => {
                      const path = pathForNotationNode(model.index, parent);
                      if (path === undefined) return;
                      const key = variationCollapseKey(root, path);
                      setRevealedVariations((previous) => {
                        if (previous.has(key)) return previous;
                        const next = new Set(previous);
                        next.add(key);
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
              {!gameEnd && headers.result !== "*" && (
                <Text ta="center">
                  {headers.result}
                  <br />
                  <Text span fs="italic">
                    {getResultText(headers.result, t)}
                  </Text>
                </Text>
              )}
            </Box>
          </Stack>
        </ScrollArea>
      </Stack>
    </Paper>
  );
  return (
    <NotationMoveActionsContext.Provider value={moveActions}>
      <GameReferenceProvider>{content}</GameReferenceProvider>
    </NotationMoveActionsContext.Provider>
  );
}

function NotationHeader({
  preparation,
  arrange,
  headerActions,
}: {
  preparation: PreparationHeaderState | null;
  arrange?: NotationArrangeProps;
  headerActions?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [invisible, setInvisible] = useAtom(useTabAtom(invisibleFamily));
  const [showComments, setShowComments] = useAtom(useTabAtom(showCommentsFamily));
  const [showVariations, setShowVariations] = useAtom(useTabAtom(showVariationsFamily));
  const [showDiagrams, setShowDiagrams] = useAtom(useTabAtom(showDiagramsFamily));
  const [tableView, setTableView] = useAtom(tableViewAtom);

  return (
    <Stack gap={0}>
      <PanelHeader
        area="bottomRight"
        title={t("Board.Area.Notation")}
        icon={<NotationIcon size="1rem" />}
        arrangeable={Boolean(arrange)}
        onDragStart={arrange?.onDragStart}
        onSuppressClick={arrange?.onSuppressClick}
        onStartPlacing={arrange?.onStartPlacing}
        actions={
          <>
            <IconAction
              label={invisible ? t("Notation.ShowMoves") : t("Notation.HideMoves")}
              size="sm"
              variant="subtle"
              data-no-drag="true"
              onClick={() => setInvisible((value) => !value)}
              pressed={!invisible}
            >
              {invisible ? <EyeOff size="0.875rem" /> : <Eye size="0.875rem" />}
            </IconAction>
            <Menu position="bottom-end" shadow="md" closeOnItemClick={false} withinPortal>
              <Menu.Target>
                <IconAction
                  label={t("Notation.ViewOptions")}
                  size="sm"
                  variant="subtle"
                  data-no-drag="true"
                >
                  <SlidersHorizontal size="0.875rem" />
                </IconAction>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  role="menuitemcheckbox"
                  aria-checked={tableView}
                  leftSection={<TableProperties size="0.875rem" />}
                  rightSection={tableView ? <Check size="0.875rem" /> : null}
                  onClick={() => setTableView((value) => !value)}
                >
                  {t("Notation.TableView")}
                </Menu.Item>
                <Menu.Item
                  role="menuitemcheckbox"
                  aria-checked={showComments}
                  leftSection={<MessageSquare size="0.875rem" />}
                  rightSection={showComments ? <Check size="0.875rem" /> : null}
                  onClick={() => setShowComments((value) => !value)}
                >
                  {t("Notation.ShowComments")}
                </Menu.Item>
                <Menu.Item
                  role="menuitemcheckbox"
                  aria-checked={showDiagrams}
                  leftSection={<Grid2x2 size="0.875rem" />}
                  rightSection={showDiagrams ? <Check size="0.875rem" /> : null}
                  onClick={() => setShowDiagrams((value) => !value)}
                >
                  {t("Notation.ShowDiagrams")}
                </Menu.Item>
                <Menu.Item
                  role="menuitemcheckbox"
                  aria-checked={showVariations}
                  leftSection={<Split size="0.875rem" />}
                  rightSection={showVariations ? <Check size="0.875rem" /> : null}
                  onClick={() => setShowVariations((value) => !value)}
                >
                  {t("Notation.ShowVariations")}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
            {headerActions}
          </>
        }
      />
      <div className={styles.openingRow}>
        <OpeningName />
      </div>
      {preparation && (
        <Group
          justify="space-between"
          align="center"
          gap="xs"
          px="sm"
          py="xs"
          wrap="wrap"
          className={styles.preparationRow}
          data-notation-preparation-header
        >
          <Text size="xs" c="dimmed" className="wrap-anywhere">
            {t("Notation.PreparationFor", {
              defaultValue: "Preparing for {{name}}",
              name: preparation.opponentName,
            })}
          </Text>
          <SegmentedControl
            size="xs"
            aria-label={t("Notation.PreparationLinesFilter", {
              defaultValue: "Preparation lines",
            })}
            value={preparation.showAllLines ? "all" : "relevant"}
            onChange={(value) => preparation.onShowAllLinesChange(value === "all")}
            data={[
              {
                value: "relevant",
                label: t("Notation.PreparationOpponentLines", {
                  defaultValue: "Opponent's lines",
                }),
              },
              {
                value: "all",
                label: t("Notation.PreparationAllLines", {
                  defaultValue: "All lines",
                }),
              },
            ]}
          />
        </Group>
      )}
    </Stack>
  );
}

function NotationVirtualRow({
  row,
  result,
  termination,
  index,
  root,
  currentNode,
  startNode,
  showComments,
  hasScoresheetReview,
  tableView,
  orientation,
  onToggleVariation,
  onRevealVariation,
  measureRef,
  style,
  dataIndex,
}: {
  row: NotationRow;
  result: string;
  termination?: string;
  index: NotationNodeIndex;
  root: TreeNode;
  currentNode: TreeNode;
  startNode: TreeNode;
  showComments: boolean;
  hasScoresheetReview: boolean;
  tableView: boolean;
  orientation: "white" | "black";
  onToggleVariation: (parent: TreeNode) => void;
  onRevealVariation: (parent: TreeNode) => void;
  measureRef: (element: Element | null) => void;
  style: React.CSSProperties;
  dataIndex: number;
}) {
  return (
    <Box ref={measureRef} data-index={dataIndex} style={style}>
      {row.type === "gameEnd" && (
        <GameEndRow result={result} termination={termination} hasAnalysis={row.hasAnalysis} />
      )}
      {row.type === "comment" && <CommentRow row={row} tableView={tableView} />}
      {row.type === "diagram" && (
        <DiagramRow row={row} index={index} root={root} orientation={orientation} />
      )}
      {row.type === "variation" && (
        <VariationRow
          row={row}
          onToggle={() => onToggleVariation(row.parent)}
          onReveal={() => onRevealVariation(row.parent)}
        />
      )}
      {row.type === "moves" && (
        <InlineRow
          row={row}
          index={index}
          root={root}
          currentNode={currentNode}
          startNode={startNode}
          showComments={showComments}
          hasScoresheetReview={hasScoresheetReview}
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
          hasScoresheetReview={hasScoresheetReview}
        />
      )}
    </Box>
  );
}

function GameEndRow({
  result,
  termination,
  hasAnalysis,
}: {
  result: string;
  termination?: string;
  hasAnalysis: boolean;
}) {
  const { t } = useTranslation();
  const resultText = getResultText(result, t);
  return (
    <Box data-notation-game-end className={styles.gameEnd}>
      <Text size="sm">
        {result}
        {resultText && ` · ${resultText}`}
        {termination &&
          termination !== "Normal" &&
          termination !== "Unterminated" &&
          ` · ${termination}`}
      </Text>
      {hasAnalysis && (
        <Text size="xs" c="dimmed">
          {t("Notation.AnalysisAfterGame")}
        </Text>
      )}
    </Box>
  );
}

function notationScoreText(node: TreeNode): string | undefined {
  const score = displayedScore(node);
  return score ? formatScore(score.value, 1) : undefined;
}

function moveProps(
  move: NotationMove,
  index: NotationNodeIndex,
  root: TreeNode,
  currentNode: TreeNode,
  startNode: TreeNode,
  showComments: boolean,
  unsure: boolean,
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
    // A diagram row below the move shows the comment under its board.
    comment: move.diagram ? "" : move.node.comment,
    startingComment: move.startingComment,
    annotations: nagGlyphs(move.node.nags),
    showComments,
    first: move.first,
    isStart: move.node === startNode,
    isCurrentVariation: move.node === currentNode,
    tableLayout,
    scoreText,
    analysis: move.analysis,
    openVariation: move.openVariation,
    unsure,
    reviewMark: move.node.reviewMark === true,
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
  hasScoresheetReview,
}: {
  row: Extract<NotationRow, { type: "moves" }>;
  index: NotationNodeIndex;
  root: TreeNode;
  currentNode: TreeNode;
  startNode: TreeNode;
  showComments: boolean;
  hasScoresheetReview: boolean;
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
          {...moveProps(
            move,
            index,
            root,
            currentNode,
            startNode,
            showComments,
            hasScoresheetReview && row.depth === 0 && move.node.unsure === true,
          )}
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
                <Comment comment={row.comment} annotatedNode={row.annotatedNode} />
              </Box>
            </Table.Td>
          </Table.Tr>
        </Table.Tbody>
      </Table>
    );
  }
  return (
    <Box pl="sm" pt="xs">
      <Comment comment={row.comment} annotatedNode={row.annotatedNode} />
    </Box>
  );
}

function DiagramRow({
  row,
  index,
  root,
  orientation,
}: {
  row: Extract<NotationRow, { type: "diagram" }>;
  index: NotationNodeIndex;
  root: TreeNode;
  orientation: "white" | "black";
}) {
  const { t } = useTranslation();
  const store = useContext(TreeStateContext)!;
  const moveHighlight = useAtomValue(moveHighlightAtom);
  const { node } = row;
  // Side to move and check come from the position itself: ply parity is wrong for a game that
  // starts from a Black-to-move FEN.
  const position = useMemo(() => positionFromFen(node.fen)[0], [node.fen]);
  const isVariationBlock = row.depth >= 1;
  return (
    <Box
      data-notation-diagram
      className={isVariationBlock ? `${styles.diagram} ${styles.variationBlock}` : styles.diagram}
      style={isVariationBlock ? variationBlockStyle(row.depth) : undefined}
    >
      <UnstyledButton
        className={styles.diagramBoard}
        aria-label={t("Notation.DiagramGoTo")}
        onClick={() => {
          const path = pathForNotationNode(index, node);
          if (path && store.getState().root === root) store.getState().goToMove(path);
        }}
      >
        <MiniBoard
          fen={node.fen}
          orientation={orientation}
          lastMove={moveHighlight ? lastMoveSquares(node) : undefined}
          turnColor={position?.turn ?? "white"}
          check={moveHighlight && position?.isCheck()}
          shapes={node.shapes}
        />
      </UnstyledButton>
      {row.comment && (
        <Box pt="xs">
          <Comment comment={row.comment} annotatedNode={node} />
        </Box>
      )}
    </Box>
  );
}

function VariationRow({
  row,
  onToggle,
  onReveal,
}: {
  row: Extract<NotationRow, { type: "variation" }>;
  onToggle: () => void;
  onReveal: () => void;
}) {
  const { t } = useTranslation();
  const hiddenCount = row.hiddenCount ?? 0;
  const hasVisibleVariations = row.parent.children.length - 1 > hiddenCount;
  const showCollapseToggle = row.collapsed || hasVisibleVariations;
  const showReveal = !row.collapsed && hiddenCount > 0;
  return (
    <Box
      className={`${styles.variationBlock} ${styles.variationToggle}`}
      // A toggle row carries its parent's depth while the alternatives it controls are at
      // depth + 1, so the toggle shares their first guide line.
      style={variationBlockStyle(row.depth + 1)}
    >
      {showCollapseToggle && (
        <IconAction
          label={t("Notation.ToggleVariation")}
          size="xs"
          onClick={onToggle}
          pressed={!row.collapsed}
        >
          {row.collapsed ? <Plus size="0.5rem" /> : <Minus size="0.5rem" />}
        </IconAction>
      )}
      {showReveal && (
        <UnstyledButton
          type="button"
          className={styles.revealVariations}
          data-notation-reveal-variations={hiddenCount}
          onClick={onReveal}
        >
          <Plus size="0.65rem" aria-hidden />
          <span>
            {t("Notation.HiddenVariations", {
              count: hiddenCount,
              defaultValue: "{{count}} hidden lines",
            })}
          </span>
        </UnstyledButton>
      )}
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
  hasScoresheetReview,
}: {
  row: Extract<NotationRow, { type: "table" }>;
  index: NotationNodeIndex;
  root: TreeNode;
  currentNode: TreeNode;
  startNode: TreeNode;
  showComments: boolean;
  hasScoresheetReview: boolean;
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
                  hasScoresheetReview && row.white.node.unsure === true,
                  true,
                  showComments ? notationScoreText(row.white.node) : undefined,
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
                  hasScoresheetReview && row.black.node.unsure === true,
                  true,
                  showComments ? notationScoreText(row.black.node) : undefined,
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
