import { Flex, rem, Table, Text, Tooltip } from "@mantine/core";
import { IconAction } from "@/components/common/IconAction";
import { Check, ChevronDown, Copy } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useClipboardCopy } from "@/hooks/useClipboardCopy";
import type { Score } from "@/bindings";
import type { ChessDBLine } from "@/utils/chessdb/api";
import { formatScore } from "@/utils/score";
import { EngineLinePreviewMoves, useEngineLinePreview } from "./EngineLinePreview";
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
  const { copied, copy } = useClipboardCopy(t("Board.Analysis.CopyLineFailed"));

  const ref = useRef<HTMLTableRowElement>(null);
  const preview = useEngineLinePreview({
    fen,
    moves,
    visibleCount: open ? Infinity : 12,
    orientation,
    anchor: ref,
    inert,
  });
  const allMoves = preview.moves;
  const engineOutput = [engineName, formatScore(score.value), allMoves.join(" ")]
    .filter(Boolean)
    .join(" ");

  const mark = chessdb?.note.match(/^[^\p{L}\p{N}\s()]+/u)?.[0];
  const winrate = chessdb?.winrate?.trim() ? Number(chessdb.winrate) : Number.NaN;
  const scoreBubble = (
    <EngineScoreBubble engineId={engineId} size="sm" score={score} inert={inert} />
  );

  return (
    <Table.Tr
      ref={ref}
      className={classes.line}
      inert={inert}
      opacity={inert ? 0.5 : 1}
      style={{ verticalAlign: "top" }}
    >
      <Table.Td width={chessdb ? undefined : 62}>
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
            height: open ? "100%" : 28,
            overflow: "hidden",
            alignItems: "center",
          }}
          onMouseLeave={preview.close}
        >
          <EngineLinePreviewMoves
            preview={preview}
            halfMoves={halfMoves}
            threat={threat}
            inert={inert}
          />
        </Flex>
        {preview.board}
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
            <IconAction
              label={copied ? t("Common.Copied") : t("Menu.Edit.Copy")}
              color={copied ? "success" : undefined}
              variant="subtle"
              disabled={inert}
              onClick={() => void copy(engineOutput)}
            >
              {copied ? <Check style={{ width: rem(16) }} /> : <Copy style={{ width: rem(16) }} />}
            </IconAction>
          )}
        </Flex>
      </Table.Th>
    </Table.Tr>
  );
}

export default AnalysisRow;
