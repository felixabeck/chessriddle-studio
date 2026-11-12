import { useTabAtom, useOwnerTabId } from "@/state/tabScope";
import type { DrawShape } from "@lichess-org/chessground/draw";
import { Box, Center, Group, Text, useMantineTheme, VisuallyHidden } from "@mantine/core";
import { ChevronRight } from "lucide-react";
import {
  isNormal,
  kingCastlesTo,
  makeSquare,
  makeUci,
  type NormalMove,
  type Piece,
  parseSquare,
  parseUci,
  squareRank,
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
} from "@/state/atoms";
import { keyMapAtom } from "@/state/keybinds";
import classes from "@/styles/Chessboard.module.css";
import { ANNOTATION_INFO, isBasicAnnotation, nagGlyphs } from "@/utils/annotation";
import { getVariationLine } from "@/utils/chess";
import { normalizeEditedFen, positionFromFen, translateChessopsError } from "@/utils/chessops";
import { backgroundHotkeyOptions } from "@/utils/keyboardOwnership";
import ShowMaterial from "../common/ShowMaterial";
import { TreeStateContext, useVariationChooser } from "@/components/common/TreeStateContext";
import BoardFrame from "@/components/boards/BoardFrame";
import {
  childMoveArrow,
  chooserArrows,
  continuationBrushes,
} from "@/components/boards/continuationArrows";
import FideInfo from "../databases/FideInfo";
import { lineTitleOf } from "../files/lineTitle";
import { arrowColors } from "../panels/analysis/BestMoves";
import AnnotationHint from "./AnnotationHint";
import IconAction from "../common/IconAction";
import { accessibleBoardGrid, accessibleSquareLabel, boardColorLabel } from "./boardAccessibility";
import { BoardBar } from "./BoardBar";
import Clock from "./Clock";
import EvalBar from "./EvalBar";
import MoveInput from "./MoveInput";
import PromotionModal from "./PromotionModal";

const LARGE_BRUSH = 11;
const MEDIUM_BRUSH = 7.5;
const SMALL_BRUSH = 4;
const BAR_HEIGHT = "1.9rem";
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

  const tabId = useOwnerTabId();
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
                    defaultSettings: engine.settings ?? undefined,
                    defaultGo: engine.go ?? undefined,
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
  const [whiteFideOpen, setWhiteFideOpen] = useState(false);
  const [blackFideOpen, setBlackFideOpen] = useState(false);

  const moveInput = useAtomValue(moveInputAtom);
  const showDests = useAtomValue(showDestsAtom);
  const moveHighlight = useAtomValue(moveHighlightAtom);
  const showArrows = useAtomValue(showArrowsAtom);
  const showVariationArrows = useAtomValue(showVariationArrowsAtom);
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
    if (!isPractice && !choice && showVariationArrows && currentNode.children.length > 1) {
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

  const theme = useMantineTheme();
  const annotations = nagGlyphs(currentNode.nags);
  const color = ANNOTATION_INFO[annotations[0]]?.color || "gray";
  const lightColor = theme.colors[color][6];
  const darkColor = theme.colors[color][8];

  const [enableBoardScroll] = useAtom(enableBoardScrollAtom);
  const [snapArrows] = useAtom(snapArrowsAtom);
  const showComments = useAtomValue(useTabAtom(showCommentsFamily));
  const visualAnnotation = showComments ? annotations[0] : "";

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

  let square = currentNode.move?.to;
  if (currentNode.move && isNormal(currentNode.move)) {
    const color = squareRank(currentNode.move.from) === 0 ? "white" : "black";
    if (currentNode.san?.startsWith("O-O-O")) {
      square = kingCastlesTo(color, "a");
    } else if (currentNode.san?.startsWith("O-O")) {
      square = kingCastlesTo(color, "h");
    }
  }

  const lastMove =
    currentNode.move && square !== undefined
      ? [chessgroundMove(currentNode.move)[0], makeSquare(square)!]
      : undefined;

  const topPlayer = orientation === "white" ? headers.black : headers.white;
  const bottomPlayer = orientation === "white" ? headers.white : headers.black;
  const lineTitle = repertoire ? lineTitleOf(headers) : undefined;
  const accessibleGrid = accessibleBoardGrid(orientation);

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
              //            topbar   bottompadding                tabs                                  bottomb    topbar   evalbar                                gaps    ???
              `var(--board-max-width, calc(100vh - 2.25rem - var(--mantine-spacing-sm) - 2.5rem - var(--mantine-spacing-sm) - ${BAR_HEIGHT} - ${BAR_HEIGHT} + 1.563rem + var(--mantine-spacing-md) - 1rem  - 0.2rem))`,
          }}
        >
          <BoardBar
            name={repertoire ? (lineTitle?.idea ?? "") : topPlayer}
            rating={
              repertoire
                ? undefined
                : orientation === "white"
                  ? headers.black_elo
                  : headers.white_elo
            }
            onNameClick={
              repertoire
                ? undefined
                : () => {
                    if (orientation === "white") {
                      setBlackFideOpen(true);
                    } else {
                      setWhiteFideOpen(true);
                    }
                  }
            }
            height={BAR_HEIGHT}
          >
            <ShowMaterial
              fen={currentNode.fen}
              color={orientation === "white" ? "black" : "white"}
              mode={materialDisplay}
            />
            {hasClock && (
              <Clock
                color={orientation === "black" ? "white" : "black"}
                turn={turn}
                whiteTime={whiteTime}
                blackTime={blackTime}
              />
            )}
          </BoardBar>
          {/* Gutters can shrink when the square board leaves less than the bars' minimum height. */}
          <Box h="0.5rem" />
          <Group
            data-board-surface
            style={{
              position: "relative",
              flexWrap: "nowrap",
              columnGap: "var(--board-gap, var(--mantine-spacing-sm))",
            }}
            gap="sm"
          >
            {showComments && annotations.length > 0 && currentNode.move && square !== undefined && (
              <Box
                style={{ paddingLeft: "var(--board-annotation-offset, 2.5rem)" }}
                w="100%"
                h="100%"
                pos="absolute"
              >
                <Box pos="relative" w="100%" h="100%">
                  <AnnotationHint
                    orientation={orientation}
                    square={square}
                    annotation={annotations[0]}
                  />
                </Box>
              </Box>
            )}
            <Box
              h="100%"
              style={{
                width: "var(--board-eval-width, 25px)",
              }}
            >
              {!evalOpen && (
                <Center h="100%" w="100%">
                  <IconAction
                    label={t("Board.Action.ShowEvaluation", { defaultValue: "Show evaluation" })}
                    size="1rem"
                    onClick={() => setEvalOpen(true)}
                    onContextMenu={(e: MouseEvent<HTMLButtonElement>) => {
                      setEvalOpen(true);
                      e.preventDefault();
                    }}
                  >
                    <ChevronRight />
                  </IconAction>
                </Center>
              )}
              {evalOpen && <EvalBar score={currentNode.score || null} orientation={orientation} />}
            </Box>
            <BoardFrame>
              <Box
                style={
                  isBasicAnnotation(visualAnnotation)
                    ? {
                        "--light-color": lightColor,
                        "--dark-color": darkColor,
                      }
                    : undefined
                }
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
          <Box h="0.5rem" />
          <BoardBar
            name={repertoire ? (lineTitle?.name ?? "") : bottomPlayer}
            rating={
              repertoire
                ? undefined
                : orientation === "white"
                  ? headers.white_elo
                  : headers.black_elo
            }
            onNameClick={
              repertoire
                ? undefined
                : () => {
                    if (orientation === "white") {
                      setWhiteFideOpen(true);
                    } else {
                      setBlackFideOpen(true);
                    }
                  }
            }
            height={BAR_HEIGHT}
          >
            {error && (
              <Text ta="center" c="danger">
                {translateChessopsError(t, error)}
              </Text>
            )}

            {moveInput && (
              <MoveInput
                currentNode={currentNode}
                onMove={(move) => {
                  if (!boardAllows(makeSquare(move.from), makeSquare(move.to))) return false;
                  void makeMove(move);
                  return true;
                }}
              />
            )}

            <ShowMaterial fen={currentNode.fen} color={orientation} mode={materialDisplay} />
            {hasClock && (
              <Clock color={orientation} turn={turn} whiteTime={whiteTime} blackTime={blackTime} />
            )}
          </BoardBar>
        </Box>
      </Box>
      {!repertoire && (
        <>
          <FideInfo opened={whiteFideOpen} setOpened={setWhiteFideOpen} name={headers.white} />
          <FideInfo opened={blackFideOpen} setOpened={setBlackFideOpen} name={headers.black} />
        </>
      )}
    </>
  );
}

export default memo(Board);
