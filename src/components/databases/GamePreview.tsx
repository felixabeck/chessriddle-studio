import { EphemeralTabScope } from "@/state/tabScope";
import { Box, Group, Stack } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { useContext, useMemo } from "react";
import useSWRImmutable from "swr/immutable";
import { useStore } from "zustand";
import BoardFrame from "@/components/boards/BoardFrame";
import { chooserArrows, continuationBrushes } from "@/components/boards/continuationArrows";
import { useVariationChooser } from "@/components/common/TreeStateContext";
import { Chessground } from "@/chessground/Chessground";
import { useTranslation } from "react-i18next";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import {
  adaptivePreviewGeometry,
  DatabaseLayoutContext,
  fitPreviewSquare,
} from "@/state/databaseLayout";
import { parsePGN, parseStartHeader } from "@/utils/chess";
import {
  applyGameEndLoadDefault,
  type GameHeaders,
  getNodeAtPath,
  type TreeState,
} from "@/utils/treeReducer";
import GameNotation from "../common/GameNotation";
import MoveControls from "../common/MoveControls";
import OpeningName from "../common/OpeningName";
import { TreeStateContext, TreeStateProvider } from "../common/TreeStateContext";
import classes from "./GridLayout.module.css";

type PreviewLayout = {
  hideControls?: boolean;
  showOpening?: boolean;
  /** The parent gives the preview a definite height and the board must fit inside it. */
  fitHeight?: boolean;
  /** Database layout only. Files retains its fitHeight contract. */
  adaptive?: boolean;
};

function GamePreviewWrapper({
  pgn,
  headers,
  ...layout
}: {
  pgn: string;
  headers?: GameHeaders;
} & PreviewLayout) {
  const { t } = useTranslation();
  const requestKey = [pgn, headers?.fen] as const;
  const requestOwner = useNativeRequestOwner(requestKey);
  const { data: parsedGame } = useSWRImmutable(requestKey, async ([p, fen]) => {
    return await requestOwner!.run(async (signal) => {
      try {
        return await parsePGN(p, fen, { signal });
      } catch (error) {
        if (!signal.aborted) {
          notifyUnlessCancelled(t("Common.Error"), error);
        }
        throw error;
      }
    });
  });

  // Record identity includes metadata, while the parser cache only needs movetext and FEN.
  // Sort object keys at every level so replacing equivalent headers preserves navigation.
  const gameKey = JSON.stringify([pgn, headers ?? null], (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
  // Read merged header inputs, including Start, from gameKey so equivalent objects reuse the clone.
  const game = useMemo(() => {
    if (!parsedGame) return undefined;
    const [, keyedHeaders] = JSON.parse(gameKey) as [string, GameHeaders | null];
    const start =
      keyedHeaders?.start === undefined
        ? parsedGame.position
        : parseStartHeader(keyedHeaders.start, parsedGame.root);
    return applyGameEndLoadDefault(
      structuredClone({
        ...parsedGame,
        headers: {
          ...parsedGame.headers,
          ...keyedHeaders,
          fen: parsedGame.root.fen,
          start,
        },
        position: start,
      }),
    );
  }, [parsedGame, gameKey]);

  return <>{game && <GamePreview key={gameKey} game={game} {...layout} />}</>;
}

function GamePreview({
  game,
  hideControls,
  showOpening,
  fitHeight,
  adaptive,
}: { game: TreeState } & PreviewLayout) {
  const { compact, rootFont } = useContext(DatabaseLayoutContext);
  const { ref: boardRef, height } = useElementSize();
  const { ref: frameRef, width: frameWidth, height: frameHeight } = useElementSize();
  // The board is square, so sized by its width alone it overflows a short frame, and the frame's
  // `overflow: hidden` then cuts off the lower ranks and the move controls beside it.
  const geometry = adaptivePreviewGeometry(frameWidth, frameHeight, rootFont, compact);
  const stacked = !!adaptive && geometry.stacked;
  const boardSide = adaptive
    ? geometry.boardSide
    : fitPreviewSquare(hideControls ? frameWidth : frameWidth / 2, frameHeight);

  return (
    <TreeStateProvider initial={game}>
      <EphemeralTabScope>
        <Box
          className={adaptive ? classes.previewShell : undefined}
          style={
            adaptive && compact ? { flex: "none" } : adaptive ? undefined : { display: "contents" }
          }
        >
          {showOpening && <OpeningName />}
          <Group
            ref={frameRef}
            // Top-aligned when fitting: a board limited by a narrow width then sits under the list
            // instead of below an empty band.
            align={fitHeight || adaptive ? "start" : "end"}
            grow={!fitHeight && !adaptive}
            wrap={fitHeight || adaptive ? "nowrap" : undefined}
            className={adaptive ? classes.adaptiveFrame : undefined}
            data-preview-arrangement={adaptive ? (stacked ? "below" : "beside") : undefined}
            style={{
              overflow: adaptive ? "visible" : "hidden",
              height: adaptive ? (compact ? "auto" : undefined) : "100%",
              flex: adaptive && compact ? "none" : undefined,
              flexDirection: stacked ? "column" : undefined,
            }}
          >
            <Box
              ref={boardRef}
              // A measured px width, not Mantine's `w`, which reads a number as rem and so doubles it
              // at a 200% font scale.
              style={fitHeight || adaptive ? { width: boardSide, flex: "none" } : undefined}
            >
              <PreviewBoard />
            </Box>
            {!hideControls && (
              <Stack
                style={{
                  height: adaptive
                    ? compact
                      ? "auto"
                      : stacked
                        ? Math.max(0, frameHeight - boardSide - rootFont)
                        : frameHeight
                    : height,
                }}
                w={stacked ? "100%" : undefined}
                className={
                  adaptive
                    ? `${classes.adaptiveControls} ${stacked ? classes.stackedPreviewControls : ""}`
                    : undefined
                }
                gap="xs"
                flex={fitHeight || adaptive ? 1 : undefined}
                miw={fitHeight || adaptive ? 0 : undefined}
              >
                <Box
                  className={adaptive ? classes.adaptiveNotation : classes.previewNotation}
                  style={
                    adaptive && compact
                      ? { height: geometry.notationHeight, flex: "none" }
                      : undefined
                  }
                >
                  <GameNotation />
                </Box>
                <MoveControls readOnly />
              </Stack>
            )}
          </Group>
        </Box>
      </EphemeralTabScope>
    </TreeStateProvider>
  );
}

function PreviewBoard() {
  const store = useContext(TreeStateContext)!;
  const goToNext = useStore(store, (s) => s.goToNext);
  const goToPrevious = useStore(store, (s) => s.goToPrevious);
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);
  const headers = useStore(store, (s) => s.headers);
  const node = getNodeAtPath(root, position);
  const fen = node.fen;
  const { choice } = useVariationChooser();

  return (
    <BoardFrame>
      <Box
        w="100%"
        onWheel={(e) => {
          if (e.deltaY > 0) {
            goToNext();
          } else {
            goToPrevious();
          }
        }}
      >
        <Chessground
          coordinates={false}
          viewOnly={true}
          drawable={{
            autoShapes: [...chooserArrows(choice), ...node.shapes],
            brushes: continuationBrushes,
          }}
          fen={fen}
          orientation={headers.orientation || "white"}
        />
      </Box>
    </BoardFrame>
  );
}

export default GamePreviewWrapper;
