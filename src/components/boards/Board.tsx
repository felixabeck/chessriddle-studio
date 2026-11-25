import { useTabAtom, useOwnerTabId } from "@/state/tabScope";
import type { DrawShape } from "@lichess-org/chessground/draw";
import { Box, Center, Group, Text, VisuallyHidden } from "@mantine/core";
import { ChevronRight } from "lucide-react";
import {
  type Color,
  makeSquare,
  makeUci,
  type NormalMove,
  opposite,
  type Piece,
  parseSquare,
  parseUci,
  type SquareName,
} from "chessops";
import { chessgroundDests, chessgroundMove } from "chessops/compat";
import { makeFen, parseFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import { atom, useAtom, useAtomValue } from "jotai";
import { memo, type MouseEvent, useCallback, useContext, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import { match } from "ts-pattern";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { Chessground, type ChessgroundRef } from "@/chessground/Chessground";
import { useNodeDrawables } from "@/chessground/useNodeDrawables";
import {
  autoPromoteAtom,
  createBestMovesAtom,
  enginesAtom,
  tabEngineSettingsFamily,
  evalOpenFamily,
  showCommentsFamily,
  enableBoardScrollAtom,
  materialDisplayAtom,
  moveHighlightAtom,
  moveInputAtom,
  showArrowsAtom,
  showConsecutiveArrowsAtom,
  showCoordinatesAtom,
  showDestsAtom,
  showVariationArrowsAtom,
  snapArrowsAtom,
  invisibleFamily,
} from "@/state/atoms";
import { keyMapAtom } from "@/state/keybinds";
import classes from "@/styles/Chessboard.module.css";
import { nagGlyphs } from "@/utils/annotation";
import { getVariationLine } from "@/utils/chess";
import { displayedScore } from "@/utils/treeReducer";
import {
  lastMoveSquares,
  lastMoveTarget,
  normalizeEditedFen,
  positionFromFen,
  translateChessopsError,
} from "@/utils/chessops";
import { backgroundHotkeyOptions } from "@/utils/keyboardOwnership";
import ShowMaterial from "../common/ShowMaterial";
import { TreeStateContext, useVariationChooser } from "@/components/common/TreeStateContext";
import BoardFrame from "@/components/boards/BoardFrame";
import {
  childMoveArrow,
  chooserArrows,
  continuationBrushes,
} from "@/components/boards/continuationArrows";
import { FidePlayerDialogs } from "../common/FidePlayerDialogs";
import { lineTitleOf } from "@/utils/lineTitle";
import { arrowColors } from "../panels/analysis/BestMoves";
import AnnotationHint from "./AnnotationHint";
import IconAction from "../common/IconAction";
import { accessibleBoardGrid, accessibleSquareLabel, boardColorLabel } from "./boardAccessibility";
import { BoardBar } from "./BoardBar";
import Clock from "./Clock";
import EvalBar from "./EvalBar";
import { useEvalBarScore } from "./useEvalBarScore";
import MoveInput from "./MoveInput";
import PromotionModal from "./PromotionModal";

const LARGE_BRUSH = 11;
const MEDIUM_BRUSH = 7.5;
const SMALL_BRUSH = 4;
const BAR_HEIGHT = "1.9rem";
// The space between a bar and the board.
const BAR_GUTTER = "0.5rem";
const EVAL_WIDTH = "var(--board-eval-width, 25px)";
// How far the global focus ring reaches beyond the grid (`src/styles/global.css`).
const FOCUS_RING_EXTENT = "calc(var(--cf-focus-ring-width) + var(--cf-focus-ring-offset))";
// The collapsed bar's reopen button. Its column is never narrower, since the board clips what
// passes the column's edge: an 8px stacked column cut the chevron's left side.
const SHOW_EVAL_BUTTON_SIZE = "1rem";
const VISUALLY_HIDDEN_STYLE = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
} as const;

interface ChessboardProps {
  editingMode: boolean;
  repertoire?: boolean;
  /** Opens the line naming dialog when a repertoire line's title is clicked. */
  onRenameLine?: () => void;
  viewOnly?: boolean;
  disableVariations?: boolean;
  movable?: "both" | "white" | "black" | "turn" | "none";
  boardRef: React.MutableRefObject<HTMLDivElement | null>;
  whiteTime?: number;
  blackTime?: number;
  practiceMove?: {
    canMove: boolean;
    hintSan?: string;
    submitMove: (san: string) => void;
  };
  selectedPiece?: Piece | null;
  onMove?: (uci: string) => Promise<boolean>;
  cgRef?: React.Ref<ChessgroundRef>;
  enablePremoves?: boolean;
  onKeyboardPremove?: (from: SquareName, to: SquareName) => boolean;
}

function Board({
  editingMode,
  repertoire,
  onRenameLine,
  viewOnly,
  disableVariations,
  movable = "turn",
  boardRef,
  whiteTime,
  blackTime,
  practiceMove,
  selectedPiece,
  onMove,
  cgRef,
  enablePremoves = false,
  onKeyboardPremove,
}: ChessboardProps) {
  const { t } = useTranslation();

  const store = useContext(TreeStateContext)!;

  const root = useStore(store, (s) => s.root);
  const rootFen = useStore(store, (s) => s.root.fen);
  const moves = useStore(
    store,
    useShallow((s) => getVariationLine(s.root, s.position)),
  );
  const headers = useStore(store, (s) => s.headers);
  const currentNode = useStore(store, (s) => s.currentNode());
  const positionPath = useStore(store, (s) => s.position.join(","));
  const documentId = useStore(store, (s) => s.documentId);

  const tabId = useOwnerTabId();
  const evalBarScore = useEvalBarScore({
    score: displayedScore(currentNode),
    tab: tabId,
    documentId,
    rootFen,
    moves,
  });
  const arrows = useAtomValue(
    useMemo(() => createBestMovesAtom(tabId, rootFen, moves), [tabId, rootFen, moves]),
  );
  const enabledEngines = useAtomValue(
    useMemo(
      () =>
        atom((get) =>
          (get(enginesAtom) ?? [])
            .filter((engine) => engine.loaded)
            .map(
              (engine) =>
                get(
                  tabEngineSettingsFamily({
                    tab: tabId,
                    engineId: engine.id,
                  }),
                ).enabled,
            ),
        ),
      [tabId],
    ),
  );

  const goToNext = useStore(store, (s) => s.goToNext);
  const goToPrevious = useStore(store, (s) => s.goToPrevious);
  const storeMakeMove = useStore(store, (s) => s.makeMove);
  const setHeaders = useStore(store, (s) => s.setHeaders);
  const clearShapes = useStore(store, (s) => s.clearShapes);
  const nodeDrawables = useNodeDrawables(store);
  const setFen = useStore(store, (s) => s.setFen);

  const [pos, error] = positionFromFen(currentNode.fen);
  const [fideColor, setFideColor] = useState<Color | null>(null);

  const moveInput = useAtomValue(moveInputAtom);
  const showDests = useAtomValue(showDestsAtom);
  const moveHighlight = useAtomValue(moveHighlightAtom);
  const showArrows = useAtomValue(showArrowsAtom);
  const showVariationArrows = useAtomValue(showVariationArrowsAtom);
  const notationHidden = useAtomValue(useTabAtom(invisibleFamily));
  const showConsecutiveArrows = useAtomValue(showConsecutiveArrowsAtom);
  const autoPromote = useAtomValue(autoPromoteAtom);
  const showCoordinates = useAtomValue(showCoordinatesAtom);
  const materialDisplay = useAtomValue(materialDisplayAtom);

  const dests = useMemo(() => {
    return pos ? chessgroundDests(pos) : new Map<SquareName, SquareName[]>();
  }, [pos]);

  const boardDests =
    editingMode || viewOnly || (disableVariations && currentNode.children.length > 0)
      ? undefined
      : dests;
  const premovesEnabled = enablePremoves && !editingMode && !viewOnly;

  const [pendingMove, setPendingMove] = useState<NormalMove | null>(null);
  const [, restorePracticeBoard] = useState(0);
  const [keyboardSquare, setKeyboardSquare] = useState<SquareName>("e2");
  const [keyboardSource, setKeyboardSource] = useState<SquareName | null>(null);
  const keyboardFocus = useRef(false);
  // A pending promotion and a keyboard move source belong to the position they were started in.
  // Navigating away (wheel, notation, engine line) drops both, so a later choice can never play
  // the move in a position the user did not make it in.
  const moveOrigin = `${positionPath}|${currentNode.fen}`;
  const [pendingMoveOrigin, setPendingMoveOrigin] = useState(moveOrigin);
  if (pendingMoveOrigin !== moveOrigin) {
    setPendingMoveOrigin(moveOrigin);
    setPendingMove(null);
    setKeyboardSource(null);
  }
  const [keyboardAnnouncement, setKeyboardAnnouncement] = useState("");

  const turn = pos?.turn || "white";
  const orientation = headers.orientation || "white";
  const toggleOrientation = () =>
    setHeaders({
      ...headers,
      fen: root.fen,
      orientation: orientation === "black" ? "white" : "black",
    });

  const keyMap = useAtomValue(keyMapAtom);
  useHotkeys(keyMap.SWAP_ORIENTATION.keys, () => toggleOrientation(), backgroundHotkeyOptions);
  const [evalOpen, setEvalOpen] = useAtom(useTabAtom(evalOpenFamily));
  const evalColumnWidth = evalOpen ? EVAL_WIDTH : `max(${EVAL_WIDTH}, ${SHOW_EVAL_BUTTON_SIZE})`;

  async function makeMove(move: NormalMove) {
    if (!pos) return;
    const san = makeSan(pos, move);
    if (practiceMove) {
      if (!practiceMove.canMove) return;
      practiceMove.submitMove(san);
      // Chessground already moved the piece. Reapply the live position and destinations
      // even when the controller rejects the move without changing the tree or phase.
      restorePracticeBoard((revision) => revision + 1);
      setPendingMove(null);
    } else {
      // A game move becomes part of the tree only after the native authority
      // accepts it. This prevents rejected moves from corrupting the visible line.
      if (onMove) {
        await onMove(makeUci(move));
        setPendingMove(null);
        return;
      }
      storeMakeMove({
        payload: move,
        clock: pos.turn === "white" ? whiteTime : blackTime,
      });
      setPendingMove(null);
    }
  }

  const { choice } = useVariationChooser();
  const isPractice = practiceMove !== undefined;
  const hintSan = practiceMove?.hintSan;
  const shapes = useMemo(() => {
    const [pos] = positionFromFen(currentNode.fen);
    const shapes: DrawShape[] = isPractice ? [] : chooserArrows(choice);
    if (hintSan && pos) {
      const hint = parseSan(pos, hintSan);
      if (hint && "from" in hint) {
        const [orig, dest] = chessgroundMove(hint);
        shapes.push({ orig, dest, brush: "green" });
      }
    }
    if (showArrows && evalOpen && arrows.size > 0 && pos) {
      const entries = Array.from(arrows.entries()).sort((a, b) => a[0] - b[0]);
      for (const [i, moves] of entries) {
        if (i < 4 && enabledEngines[i]) {
          const bestWinChance = moves[0].winChance;
          for (const [j, { pv, winChance }] of moves.entries()) {
            const posClone = pos.clone();
            let prevSquare = null;
            for (const [ii, uci] of pv.entries()) {
              const m = parseUci(uci)! as NormalMove;

              posClone.play(m);
              const from = makeSquare(m.from)!;
              const to = makeSquare(m.to)!;
              if (prevSquare === null) {
                prevSquare = from;
              }
              const brushSize = match(bestWinChance - winChance)
                .when(
                  (d) => d < 2.5,
                  () => LARGE_BRUSH,
                )
                .when(
                  (d) => d < 5,
                  () => MEDIUM_BRUSH,
                )
                .otherwise(() => SMALL_BRUSH);

              if (ii === 0 || (showConsecutiveArrows && j === 0 && ii % 2 === 0)) {
                if (
                  ii < 5 && // max 3 arrows
                  !shapes.find((s) => s.orig === from && s.dest === to) &&
                  prevSquare === from
                ) {
                  shapes.push({
                    orig: from,
                    dest: to,
                    brush: j === 0 ? arrowColors[i].strong : arrowColors[i].pale,
                    modifiers: {
                      lineWidth: brushSize,
                    },
                  });
                  prevSquare = to;
                } else {
                  break;
                }
              }
            }
          }
        }
      }
    }

    // Variation arrows: show all children moves when there are alternatives
    if (
      !isPractice &&
      !choice &&
      showVariationArrows &&
      currentNode.children.length > 1 &&
      !notationHidden
    ) {
      for (const child of currentNode.children) {
        const arrow = childMoveArrow(child, "variation", MEDIUM_BRUSH);
        if (arrow && !shapes.find((s) => s.orig === arrow.orig && s.dest === arrow.dest)) {
          shapes.push(arrow);
        }
      }
    }
    return shapes;
  }, [
    currentNode.fen,
    choice,
    isPractice,
    hintSan,
    showArrows,
    evalOpen,
    arrows,
    enabledEngines,
    showConsecutiveArrows,
    showVariationArrows,
    currentNode.children,
    notationHidden,
  ]);

  const hasClock =
    !!whiteTime ||
    !!blackTime ||
    !!headers.time_control ||
    !!headers.white_time_control ||
    !!headers.black_time_control;

  const practiceLock = practiceMove !== undefined && !practiceMove.canMove;

  const movableColor: "white" | "black" | "both" | undefined = useMemo(() => {
    return practiceLock
      ? undefined
      : editingMode
        ? "both"
        : match(movable)
            .with("white", () => "white" as const)
            .with("black", () => "black" as const)
            .with("turn", () => turn)
            .with("both", () => "both" as const)
            .with("none", () => undefined)
            .exhaustive();
  }, [practiceLock, editingMode, movable, turn]);

  function boardAllows(from: SquareName, to: SquareName): boolean {
    const sourceColor = pos?.board.get(parseSquare(from)!)?.color;
    return (
      boardDests?.get(from)?.includes(to) === true &&
      sourceColor !== undefined &&
      (movableColor === "both" || movableColor === sourceColor)
    );
  }

  const annotations = nagGlyphs(currentNode.nags);

  const [enableBoardScroll] = useAtom(enableBoardScrollAtom);
  const [snapArrows] = useAtom(snapArrowsAtom);
  const showComments = useAtomValue(useTabAtom(showCommentsFamily));

  const setBoardFen = useCallback(
    (fen: string) => {
      if (!fen || !editingMode) {
        return;
      }
      const boardFen = `${fen} ${currentNode.fen.split(" ").slice(1).join(" ")}`;
      const newFen = normalizeEditedFen(boardFen);
      if (!newFen) return;

      if (newFen !== currentNode.fen) {
        setFen(newFen);
      }
    },
    [editingMode, currentNode, setFen],
  );

  useHotkeys(keyMap.TOGGLE_EVAL_BAR.keys, () => setEvalOpen((e) => !e), backgroundHotkeyOptions);

  const square = lastMoveTarget(currentNode);
  const lastMove = lastMoveSquares(currentNode);

  // The side the board is oriented for plays from the bottom bar.
  const bottomColor = orientation;
  const topColor = opposite(orientation);
  const playerBar = (color: Color) => ({
    name: headers[color],
    rating: color === "white" ? headers.white_elo : headers.black_elo,
    onNameClick: () => setFideColor(color),
  });
  const topPlayer = playerBar(topColor);
  const lineTitle = repertoire ? lineTitleOf(headers) : undefined;
  // A repertoire line's name and idea form one title above the board; an idea-only line shows
  // its idea as the title.
  const repertoireTitle = lineTitle?.name ?? lineTitle?.idea ?? "";
  const repertoireDetail = lineTitle?.name ? lineTitle.idea : undefined;
  const accessibleGrid = accessibleBoardGrid(orientation);
  // An opening line has no players, so it shows one bar above the board and none below.
  const barsHeight = repertoire
    ? `(${BAR_HEIGHT} + ${BAR_GUTTER})`
    : `2 * (${BAR_HEIGHT} + ${BAR_GUTTER})`;
  const errorText = error && (
    <Text ta="center" c="danger">
      {translateChessopsError(t, error)}
    </Text>
  );
  const moveInputField = moveInput && (
    <MoveInput
      currentNode={currentNode}
      onMove={(move) => {
        if (!boardAllows(makeSquare(move.from), makeSquare(move.to))) return false;
        void makeMove(move);
        return true;
      }}
    />
  );

  function keyboardMove(event: React.KeyboardEvent<HTMLDivElement>) {
    const [fileName, rankName] = keyboardSquare;
    const file = fileName.charCodeAt(0) - "a".charCodeAt(0);
    const rank = Number(rankName) - 1;
    const horizontal = orientation === "white" ? 1 : -1;
    const vertical = orientation === "white" ? 1 : -1;
    let nextFile = file;
    let nextRank = rank;
    if (event.key === "ArrowLeft") nextFile -= horizontal;
    if (event.key === "ArrowRight") nextFile += horizontal;
    if (event.key === "ArrowUp") nextRank += vertical;
    if (event.key === "ArrowDown") nextRank -= vertical;
    if (nextFile !== file || nextRank !== rank) {
      keyboardFocus.current = true;
      event.preventDefault();
      if (nextFile >= 0 && nextFile < 8 && nextRank >= 0 && nextRank < 8) {
        const next =
          `${String.fromCharCode("a".charCodeAt(0) + nextFile)}${nextRank + 1}` as SquareName;
        setKeyboardSquare(next);
        setKeyboardAnnouncement(
          t("Board.Aria.FocusedSquare", { defaultValue: "Focused {{square}}", square: next }),
        );
      }
      return;
    }
    if (event.key === "Escape") {
      setKeyboardSource(null);
      setKeyboardAnnouncement(
        t("Board.Aria.MoveSelectionCancelled", { defaultValue: "Move selection cancelled" }),
      );
      return;
    }
    if (event.key !== " " && event.key !== "Enter") return;
    if (event.key === " " && !keyboardSource && !keyboardFocus.current) return;
    event.preventDefault();
    if (!keyboardSource) {
      setKeyboardSource(keyboardSquare);
      setKeyboardAnnouncement(
        t("Board.Aria.MoveSource", { defaultValue: "Selected {{square}}", square: keyboardSquare }),
      );
      return;
    }
    const legal = boardAllows(keyboardSource, keyboardSquare);
    if (!legal && premovesEnabled && onKeyboardPremove) {
      const queued = onKeyboardPremove(keyboardSource, keyboardSquare);
      setKeyboardAnnouncement(
        queued
          ? t("Board.Aria.MoveQueued", {
              defaultValue: "Premove {{from}} to {{to}} queued",
              from: keyboardSource,
              to: keyboardSquare,
            })
          : t("Board.Aria.IllegalMove", { defaultValue: "Move is not legal" }),
      );
      setKeyboardSource(null);
      return;
    }
    if (!legal || !pos) {
      setKeyboardAnnouncement(t("Board.Aria.IllegalMove", { defaultValue: "Move is not legal" }));
      setKeyboardSource(null);
      return;
    }
    const from = parseSquare(keyboardSource)!;
    const to = parseSquare(keyboardSquare)!;
    if (
      pos.board.get(from)?.role === "pawn" &&
      (keyboardSquare[1] === "8" || keyboardSquare[1] === "1")
    ) {
      setPendingMove({ from, to });
    } else {
      void makeMove({ from, to });
    }
    setKeyboardSource(null);
  }

  return (
    <>
      <Box w="100%" h="100%">
        <Box
          style={{
            display: "flex",
            flexDirection: "column",
            width: "100%",
            height: "100%",
            flexWrap: "nowrap",
            overflow: "hidden",
            maxWidth:
              // The board is square, so its width is capped by the height left for it. Terms in order:
              // navigation row (2.625rem); the panel's bottom padding (sm); the player bars and
              // their gutters; the eval bar beside the board (1.563rem, i.e. its 25px); md spacing
              // and a 0.2rem fudge, both empirical upstream constants (`git log -S` finds their
              // origin); the focus-ring extent; the height reserved below the board.
              `var(--board-max-width, calc(100vh - 2.625rem - var(--mantine-spacing-sm) - ${barsHeight} + 1.563rem + var(--mantine-spacing-md) - 0.2rem + ${FOCUS_RING_EXTENT} - var(--board-below-height, 0px)))`,
          }}
        >
          <BoardBar
            name={repertoire ? repertoireTitle : topPlayer.name}
            detail={repertoire ? repertoireDetail : undefined}
            rating={repertoire ? undefined : topPlayer.rating}
            placeholder={repertoire ? t("GameInfo.UntitledLine") : undefined}
            onNameClick={repertoire ? (viewOnly ? undefined : onRenameLine) : topPlayer.onNameClick}
            height={BAR_HEIGHT}
            placement="above"
          >
            {repertoire && errorText}
            {repertoire && moveInputField}
            <ShowMaterial
              fen={currentNode.fen}
              color={repertoire ? undefined : topColor}
              mode={materialDisplay}
            />
            {hasClock && (
              <Clock color={topColor} turn={turn} whiteTime={whiteTime} blackTime={blackTime} />
            )}
          </BoardBar>
          {/* Gutters can shrink when the square board leaves less than the bars' minimum height. */}
          <Box h={BAR_GUTTER} />
          <Group
            data-board-surface
            style={{
              position: "relative",
              flexWrap: "nowrap",
              columnGap: "var(--board-gap, var(--mantine-spacing-sm))",
              // The wrapper clips horizontally; the eval column leaves room for the grid's focus
              // ring on the left, this padding leaves it on the right.
              paddingRight: FOCUS_RING_EXTENT,
            }}
            gap="sm"
          >
            <Box
              h="100%"
              style={{
                width: evalColumnWidth,
              }}
            >
              {!evalOpen && (
                <Center h="100%" w="100%">
                  <IconAction
                    label={t("Board.Action.ShowEvaluation", { defaultValue: "Show evaluation" })}
                    size={SHOW_EVAL_BUTTON_SIZE}
                    onClick={() => setEvalOpen(true)}
                    onContextMenu={(e: MouseEvent<HTMLButtonElement>) => {
                      setEvalOpen(true);
                      e.preventDefault();
                    }}
                  >
                    <ChevronRight size="0.875rem" />
                  </IconAction>
                </Center>
              )}
              {evalOpen && (
                <EvalBar
                  score={evalBarScore?.score ?? null}
                  engineName={evalBarScore?.engineName ?? null}
                  orientation={orientation}
                />
              )}
            </Box>
            <BoardFrame>
              <Box
                className={classes.chessboard}
                ref={boardRef}
                role="grid"
                tabIndex={0}
                aria-label={t("Board.AccessibleName", {
                  defaultValue: "Chessboard, {{orientation}} orientation",
                  orientation: boardColorLabel(t, orientation),
                })}
                aria-activedescendant={`board-square-${keyboardSquare}`}
                onFocus={(event) => {
                  // Capture focus modality before Space itself can change :focus-visible.
                  keyboardFocus.current = event.currentTarget.matches(":focus-visible");
                }}
                onPointerDown={() => {
                  keyboardFocus.current = false;
                }}
                onKeyDown={keyboardMove}
                onClick={() => {
                  if (nodeDrawables.eraseOnMovablePieceClick) clearShapes();
                }}
                onWheel={(e) => {
                  if (enableBoardScroll) {
                    if (e.deltaY > 0) {
                      goToNext();
                    } else {
                      goToPrevious();
                    }
                  }
                }}
              >
                <PromotionModal
                  pendingMove={pendingMove}
                  cancelMove={() => setPendingMove(null)}
                  confirmMove={(p) => {
                    if (pendingMove) {
                      makeMove({
                        from: pendingMove.from,
                        to: pendingMove.to,
                        promotion: p,
                      });
                    }
                  }}
                  turn={turn}
                  orientation={orientation}
                />
                <div style={VISUALLY_HIDDEN_STYLE}>
                  {accessibleGrid.map((row) => (
                    <div
                      key={row[0]}
                      role="row"
                      aria-label={t("Board.Aria.Rank", { rank: row[0][1] })}
                    >
                      {row.map((square) => (
                        <div
                          id={`board-square-${square}`}
                          key={square}
                          role="gridcell"
                          aria-label={accessibleSquareLabel(
                            t,
                            square,
                            pos?.board.get(parseSquare(square)!),
                            keyboardSource === square,
                          )}
                          aria-selected={keyboardSource === square}
                        />
                      ))}
                    </div>
                  ))}
                </div>

                <Chessground
                  ref={cgRef}
                  overlay={
                    showComments &&
                    annotations.length > 0 &&
                    currentNode.move &&
                    square !== undefined && (
                      <AnnotationHint
                        orientation={orientation}
                        square={square}
                        annotation={annotations[0]}
                      />
                    )
                  }
                  setBoardFen={setBoardFen}
                  orientation={orientation}
                  fen={currentNode.fen}
                  animation={{ enabled: !editingMode }}
                  coordinates={showCoordinates !== "no"}
                  coordinatesOnSquares={showCoordinates === "all"}
                  movable={{
                    free: editingMode,
                    color: movableColor,
                    dests: boardDests,
                    showDests,
                    events: {
                      after(orig, dest, metadata) {
                        if (!editingMode) {
                          const from = parseSquare(orig)!;
                          const to = parseSquare(dest)!;

                          if (pos) {
                            if (
                              pos.board.get(from)?.role === "pawn" &&
                              ((dest[1] === "8" && turn === "white") ||
                                (dest[1] === "1" && turn === "black"))
                            ) {
                              if (autoPromote && !metadata.ctrlKey) {
                                makeMove({
                                  from,
                                  to,
                                  promotion: "queen",
                                });
                              } else {
                                setPendingMove({
                                  from,
                                  to,
                                });
                              }
                            } else {
                              makeMove({
                                from,
                                to,
                              });
                            }
                          }
                        }
                      },
                    },
                  }}
                  events={{
                    select: (key) => {
                      if (editingMode && selectedPiece) {
                        const square = parseSquare(key);
                        if (square) {
                          const setup = parseFen(currentNode.fen).unwrap();
                          setup.board.set(square, selectedPiece);
                          const normalized = normalizeEditedFen(makeFen(setup));
                          if (normalized) setFen(normalized);
                        }
                      }
                    },
                  }}
                  turnColor={turn}
                  check={moveHighlight && pos?.isCheck()}
                  lastMove={moveHighlight && !editingMode ? lastMove : undefined}
                  premovable={{
                    enabled: premovesEnabled,
                  }}
                  draggable={{
                    enabled: true,
                    deleteOnDropOff: editingMode,
                  }}
                  drawable={{
                    enabled: true,
                    visible: true,
                    defaultSnapToValidMove: snapArrows,
                    ...nodeDrawables,
                    autoShapes: shapes,
                    brushes: continuationBrushes,
                  }}
                />
              </Box>
            </BoardFrame>
            <VisuallyHidden aria-live="polite">{keyboardAnnouncement}</VisuallyHidden>
          </Group>
          {!repertoire && (
            <>
              <Box h={BAR_GUTTER} />
              <BoardBar {...playerBar(bottomColor)} height={BAR_HEIGHT} placement="below">
                {errorText}
                {moveInputField}
                <ShowMaterial fen={currentNode.fen} color={bottomColor} mode={materialDisplay} />
                {hasClock && (
                  <Clock
                    color={bottomColor}
                    turn={turn}
                    whiteTime={whiteTime}
                    blackTime={blackTime}
                  />
                )}
              </BoardBar>
            </>
          )}
        </Box>
      </Box>
      {!repertoire && (
        <FidePlayerDialogs
          openColor={fideColor}
          setOpenColor={setFideColor}
          names={{ white: headers.white, black: headers.black }}
        />
      )}
    </>
  );
}

export default memo(Board);
