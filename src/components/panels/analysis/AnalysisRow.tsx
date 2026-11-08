import { CopyButton, Flex, rem, Table, Text, Tooltip } from "@mantine/core";
import { IconAction } from "@/components/common/IconAction";
import { Check, ChevronDown, Copy } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Score } from "@/bindings";
import type { ChessDBLine } from "@/utils/chessdb/api";
import { formatScore } from "@/utils/score";
import { engineLinePositions, PreviewEngineLineMove } from "./EngineLinePreview";
import { EngineScoreBubble } from "./ScoreBubble";
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

  const moveInfo = engineLinePositions(fen, visibleMoves);
  const ref = useRef<HTMLTableRowElement>(null);

  const mark = chessdb?.note.match(/^[^\p{L}\p{N}\s()]+/u)?.[0];
  const winrate = chessdb?.winrate?.trim() ? Number(chessdb.winrate) : Number.NaN;
  const scoreBubble = (
    <EngineScoreBubble engineId={engineId} size="md" score={score} inert={inert} />
  );

  return (
    <Table.Tr
      ref={ref}
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
          {moveInfo.map((move, index) => (
            <PreviewEngineLineMove
              key={index}
              move={move}
              index={index}
              moves={allMoves}
              halfMoves={halfMoves}
              threat={threat}
              orientation={orientation}
              anchor={ref}
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
  );
}

export default AnalysisRow;
