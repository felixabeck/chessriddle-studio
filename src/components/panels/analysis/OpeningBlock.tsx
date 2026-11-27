import { Paper, Stack, Text, UnstyledButton } from "@mantine/core";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useOpeningName } from "@/hooks/useOpeningName";
import { useRepertoireNote } from "@/hooks/useRepertoireNote";
import { getLastMainlinePosition } from "@/utils/chess";
import { formatMoveNumber } from "@/utils/format";
import type { ReviewFact } from "@/utils/gameReview";
import { findMainlineNovelty } from "@/utils/gameReviewRepertoire";
import type { GameHeaders, TreeNode } from "@/utils/treeReducer";
import classes from "./AnalysisPanel.module.css";

export interface ReviewFocusRequest {
  beforePath: number[];
  beforeFen: string;
  playedSan: string | null;
  betterSan: string | null;
}

interface OpeningBlockProps {
  root: TreeNode;
  headers: GameHeaders;
  fingerprint: string;
  facts?: readonly ReviewFact[];
  summaryCurrent: boolean;
  onFocusPosition: (target: ReviewFocusRequest) => void;
}

/**
 * Compact report block showing the mainline-end opening name, the novelty move (if any), and
 * the repertoire comparison note (O6). Renders nothing when none of the three has anything to say.
 */
export function OpeningBlock({
  root,
  headers,
  fingerprint,
  facts,
  summaryCurrent,
  onFocusPosition,
}: OpeningBlockProps) {
  const { t } = useTranslation();

  const mainlineEndPath = useMemo(() => getLastMainlinePosition(root), [root]);
  const openingName = useOpeningName(root, mainlineEndPath).trim();
  const novelty = useMemo(
    () => findMainlineNovelty(root, facts, summaryCurrent),
    [root, facts, summaryCurrent],
  );
  const repertoireNote = useRepertoireNote({ root, headers, fingerprint });

  const hasOpening = openingName.length > 0;
  const hasNovelty = novelty !== null;
  const hasRepertoire = repertoireNote !== null && repertoireNote.kind !== "none";

  if (!hasOpening && !hasNovelty && !hasRepertoire) {
    return null;
  }

  return (
    <Paper withBorder p="md" className={classes.openingBlock} data-testid="report-opening-block">
      <Stack gap="xs">
        {hasOpening && (
          <Text fz="sm" className={classes.openingText} data-testid="report-opening">
            {t("Board.Analysis.Report.Opening", { opening: openingName })}
          </Text>
        )}

        {novelty && (
          <div>
            <UnstyledButton
              type="button"
              className={classes.openingLink}
              data-testid="report-novelty"
              onClick={() =>
                onFocusPosition({
                  beforePath: novelty.beforePath,
                  beforeFen: novelty.beforeFen,
                  playedSan: novelty.san,
                  betterSan: novelty.betterSan,
                })
              }
            >
              {t("Board.Analysis.Report.Novelty", {
                move: `${formatMoveNumber(novelty.halfMoves)} ${novelty.san}`,
              })}
            </UnstyledButton>
          </div>
        )}

        {repertoireNote?.kind === "deviation" && (
          <div>
            <UnstyledButton
              type="button"
              className={classes.openingLink}
              data-testid="report-repertoire-note"
              data-repertoire-kind="deviation"
              onClick={() =>
                onFocusPosition({
                  beforePath: repertoireNote.move.beforePath,
                  beforeFen: repertoireNote.move.beforeFen,
                  playedSan: repertoireNote.move.san,
                  betterSan: repertoireNote.repertoireMoves[0] ?? null,
                })
              }
            >
              {t("Board.Analysis.Report.RepertoireLeft", {
                move: Math.ceil(repertoireNote.move.halfMoves / 2),
                played: repertoireNote.move.san,
                repertoire: repertoireNote.repertoireMoves.join(", "),
                file: repertoireNote.fileName,
              })}
            </UnstyledButton>
          </div>
        )}

        {repertoireNote?.kind === "followed" && (
          <div>
            <UnstyledButton
              type="button"
              className={classes.openingLink}
              data-testid="report-repertoire-note"
              data-repertoire-kind="followed"
              onClick={() =>
                onFocusPosition({
                  beforePath: repertoireNote.lastMove.beforePath,
                  beforeFen: repertoireNote.lastMove.beforeFen,
                  playedSan: repertoireNote.lastMove.san,
                  betterSan: null,
                })
              }
            >
              {t("Board.Analysis.Report.RepertoireFollowed", {
                move: Math.ceil(repertoireNote.lastMove.halfMoves / 2),
              })}
            </UnstyledButton>
          </div>
        )}

        {repertoireNote?.kind === "partial" && (
          <Text
            fz="xs"
            c="dimmed"
            className={classes.openingText}
            data-testid="report-repertoire-note"
            data-repertoire-kind="partial"
          >
            {t("Board.Analysis.Report.RepertoireIncomplete")}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
