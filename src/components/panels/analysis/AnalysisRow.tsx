import type { Key } from "@lichess-org/chessground/types";
import { Box, CopyButton, Flex, Portal, rem, Table, Text, Tooltip } from "@mantine/core";
import { useForceUpdate } from "@mantine/hooks";
import { IconAction } from "@/components/common/IconAction";
import { Check, ChevronDown, Copy } from "lucide-react";
import { chessgroundMove } from "chessops/compat";
import { makeFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import { useAtom, useAtomValue } from "jotai";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Score } from "@/bindings";
import { Chessground } from "@/chessground/Chessground";
import { moveHighlightAtom, previewBoardOnHoverAtom, scoreTypeFamily } from "@/state/atoms";
import { positionFromFen } from "@/utils/chessops";
import type { ChessDBLine } from "@/utils/chessdb/api";
import { formatScore } from "@/utils/score";
import EngineLineMove, { engineLineMoveNumber } from "./EngineLineMove";
import ScoreBubble from "./ScoreBubble";
import classes from "./BestMoves.module.css";

function AnalysisRow({
  engineId,
  engineName,
  score,
  moves,
  halfMoves,
  threat,
  fen,
  orientation,
  inert = false,
  chessdb,
}: {
  engineId: string;
  engineName: string;
  score: Score;
  moves: string[];
  halfMoves: number;
  threat: boolean;
  fen: string;
  orientation: "white" | "black";
  inert?: boolean;
  chessdb?: ChessDBLine["chessdb"];
}) {
  const [open, setOpen] = useState<boolean>(false);
  const { t } = useTranslation();

  const allMoves = moves;
  const visibleMoves = open ? allMoves : allMoves.slice(0, 12);
  const engineOutput = [engineName, formatScore(score.value), allMoves.join(" ")]
    .filter(Boolean)
    .join(" ");

  const [pos] = positionFromFen(fen);
  const moveInfo = [];
  if (pos) {
    for (const san of visibleMoves) {
      const move = parseSan(pos, san);
      if (!move) break;
      pos.play(move);
      const fen = makeFen(pos.toSetup());
      const lastMove = chessgroundMove(move);
      const isCheck = pos.isCheck();
      moveInfo.push({ fen, san, lastMove, isCheck });
    }
  }

  const ref = useRef<HTMLTableRowElement>(null);
  const reset = useForceUpdate();
  useLayoutEffect(() => {
    document.addEventListener("analysis-panel-scroll", reset);
    return () => {
      document.removeEventListener("analysis-panel-scroll", reset);
    };
  }, [reset]);

  useEffect(() => reset(), [open, reset]);

  const [evalDisplay, setEvalDisplay] = useAtom(scoreTypeFamily(engineId));
  const mark = chessdb?.note.match(/^[^\p{L}\p{N}\s()]+/u)?.[0];
  const winrate = chessdb?.winrate?.trim() ? Number(chessdb.winrate) : Number.NaN;
  const scoreBubble = (
    <ScoreBubble
      size="md"
      score={score}
      evalDisplay={evalDisplay}
      setEvalDisplay={inert ? undefined : setEvalDisplay}
    />
  );

  return (
    <>
      <Table.Tr
        className={classes.line}
        inert={inert}
        opacity={inert ? 0.5 : 1}
        style={{ verticalAlign: "top" }}
      >
        <Table.Td width={chessdb ? undefined : 70}>
          {chessdb ? (
            <Tooltip label={chessdb.note}>
              <Flex align="center" gap="xs" wrap="nowrap">
                {scoreBubble}
                {mark && <Text fw={700}>{mark}</Text>}
                {Number.isFinite(winrate) && <Text size="sm">{winrate.toFixed(1)}%</Text>}
              </Flex>
            </Tooltip>
          ) : (
            scoreBubble
          )}
        </Table.Td>
        <Table.Td>
          <Flex
            direction="row"
            wrap="wrap"
            style={{
              height: open ? "100%" : 35,
              overflow: "hidden",
              alignItems: "center",
            }}
          >
            {moveInfo.map(({ san, fen, lastMove, isCheck }, index) => (
              <BoardPopover
                position={{
                  left: ref.current?.getClientRects()[0]?.left ?? 0,
                  top: ref.current?.getClientRects()[0]?.top ?? 0,
                }}
                key={index}
                san={san}
                index={index}
                moves={allMoves}
                halfMoves={halfMoves}
                threat={threat}
                fen={fen}
                orientation={orientation}
                lastMove={lastMove}
                isCheck={isCheck}
                inert={inert}
              />
            ))}
          </Flex>
        </Table.Td>
        <Table.Th>
          <Flex direction="column" align="center" gap={4}>
            <IconAction
              label={open ? t("Board.Analysis.Collapse") : t("Board.Analysis.Expand")}
              pressed={open}
              disabled={inert}
              style={{
                transition: "transform 200ms ease",
                transform: open ? "rotate(180deg)" : "none",
              }}
              onClick={() => setOpen(!open)}
            >
              <ChevronDown size={16} />
            </IconAction>
            {open && (
              <CopyButton value={engineOutput} timeout={2000}>
                {({ copied, copy }) => (
                  <IconAction
                    label={copied ? t("Common.Copied") : t("Menu.Edit.Copy")}
                    color={copied ? "success" : undefined}
                    variant="subtle"
                    disabled={inert}
                    onClick={copy}
                  >
                    {copied ? (
                      <Check style={{ width: rem(16) }} />
                    ) : (
                      <Copy style={{ width: rem(16) }} />
                    )}
                  </IconAction>
                )}
              </CopyButton>
            )}
          </Flex>
        </Table.Th>
      </Table.Tr>
      <Table.Tr ref={ref} />
    </>
  );
}

function BoardPopover({
  san,
  lastMove,
  isCheck,
  index,
  moves,
  halfMoves,
  threat,
  fen,
  orientation,
  position,
  inert,
}: {
  san: string;
  lastMove: Key[];
  isCheck: boolean;
  index: number;
  moves: string[];
  halfMoves: number;
  threat: boolean;
  fen: string;
  orientation: "white" | "black";
  position: { left: number; top: number };
  inert: boolean;
}) {
  const { isWhite } = engineLineMoveNumber(halfMoves, index, threat);
  const preview = useAtomValue(previewBoardOnHoverAtom);
  const moveHighlight = useAtomValue(moveHighlightAtom);

  const [hovering, setHovering] = useState(false);

  return (
    <>
      <Box
        onMouseEnter={() => {
          if (!inert) setHovering(true);
        }}
        onMouseLeave={() => setHovering(false)}
      >
        <EngineLineMove
          san={san}
          index={index}
          moves={moves}
          halfMoves={halfMoves}
          threat={threat}
          inert={inert}
        />
      </Box>
      {!inert && preview && hovering && (
        <Portal>
          <Box
            w={200}
            style={{
              top: position.top,
              left: position.left,
            }}
            pos="fixed"
          >
            <Chessground
              fen={fen}
              coordinates={false}
              viewOnly
              orientation={orientation}
              lastMove={moveHighlight ? lastMove : undefined}
              turnColor={isWhite ? "black" : "white"}
              check={moveHighlight && isCheck}
              drawable={{
                enabled: true,
                visible: true,
                defaultSnapToValidMove: true,
                eraseOnMovablePieceClick: true,
              }}
            />
          </Box>
        </Portal>
      )}
    </>
  );
}

export default AnalysisRow;
