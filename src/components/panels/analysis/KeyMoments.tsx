import { Button, Group, Paper, SegmentedControl, Stack, Text, UnstyledButton } from "@mantine/core";
import type { Color } from "chessops";
import cx from "clsx";
import equal from "fast-deep-equal";
import type { TFunction } from "i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type CSSProperties, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AiChatIcon } from "@/components/common/iconCatalog";
import { ANNOTATION_INFO, annotationTextColor, type BasicAnnotation } from "@/utils/annotation";
import type { KeyMoment } from "@/utils/chess";
import { formatMoveNumber } from "@/utils/format";
import type { GameSummary, GameTimeUsage, MistakeKind, ReviewFact } from "@/utils/gameReview";
import { formatScore } from "@/utils/score";
import type { TreeNode } from "@/utils/treeReducer";
import classes from "./AnalysisPanel.module.css";
import { ExplainedLabel } from "./ExplainedLabel";

const NO_VALUE = "–";

export type SideFilter = "both" | "white" | "black";

export interface KeyMomentItem {
  moment: KeyMoment;
  /** 1-based mainline index (`moment.path.length`). */
  mainlineIndex: number;
  /** Mover colour derived from root-anchored `moment.halfMoves` (never `path.length % 2`). */
  color: Color;
  /** Path to the position before the move (D4). */
  beforePath: number[];
  /** Full FEN of the position before the move. */
  beforeFen: string;
  /** Mistake kind from a current summary's review fact, or `null`. */
  mistakeKind: MistakeKind | null;
  /** Better line in SAN (from review fact when usable, else tree's `reportLine` sibling). */
  betterLine: string[];
  /** Path to the child of `beforeNode` matching `betterLine[0]`, when present. */
  betterChildPath: number[] | null;
  /** Whether this move is `summarizeGame`'s turning point. */
  isTurningPoint: boolean;
  /** Whether this move was played in time trouble. */
  inTimeTrouble: boolean;
}

function isMistakeAnnotation(annotation: BasicAnnotation): boolean {
  return annotation === "?!" || annotation === "?" || annotation === "??";
}

/**
 * Joins `getGameStats`'s key moments with the mainline nodes, current review facts (O1), turning
 * point (O3) and time trouble (O4).
 */
export function buildKeyMomentItems({
  root,
  moments,
  facts,
  summaryCurrent,
  gameSummary,
  timeUsage,
}: {
  root: TreeNode;
  moments: readonly KeyMoment[];
  facts: readonly ReviewFact[] | undefined;
  summaryCurrent: boolean;
  gameSummary: GameSummary | null;
  timeUsage: GameTimeUsage;
}): KeyMomentItem[] {
  const mainlineNodes: TreeNode[] = [root];
  let cursor = root;
  while (cursor.children.length > 0) {
    cursor = cursor.children[0];
    mainlineNodes.push(cursor);
  }

  const factsByIndex = new Map<number, ReviewFact>();
  if (summaryCurrent && facts) {
    for (const fact of facts) {
      factsByIndex.set(fact.mainlineIndex, fact);
    }
  }

  const timeTroubleByIndex = new Map<number, boolean>();
  for (const entry of timeUsage.moves) {
    timeTroubleByIndex.set(entry.mainlineIndex, entry.inTimeTrouble);
  }

  const items: KeyMomentItem[] = [];
  for (const moment of moments) {
    const mainlineIndex = moment.path.length;
    const beforeNode = mainlineNodes[mainlineIndex - 1];
    if (!beforeNode) continue;

    const beforePath = moment.path.slice(0, -1);
    const color: Color = moment.halfMoves % 2 === 1 ? "white" : "black";
    const fact =
      summaryCurrent && isMistakeAnnotation(moment.annotation)
        ? (factsByIndex.get(mainlineIndex) ?? null)
        : null;
    const betterLine =
      fact && fact.betterLine.length > 0
        ? fact.betterLine
        : moment.betterMove
          ? [moment.betterMove]
          : [];
    const firstBetter = betterLine[0] ?? null;
    const betterChildIndex = firstBetter
      ? beforeNode.children.findIndex((child) => child.san === firstBetter)
      : -1;

    items.push({
      moment,
      mainlineIndex,
      color,
      beforePath,
      beforeFen: beforeNode.fen,
      mistakeKind: fact?.kind ?? null,
      betterLine,
      betterChildPath: betterChildIndex >= 0 ? [...beforePath, betterChildIndex] : null,
      isTurningPoint: gameSummary?.turningPoint === mainlineIndex,
      inTimeTrouble: timeTroubleByIndex.get(mainlineIndex) ?? false,
    });
  }
  return items;
}

function formatBetterLine(betterLine: readonly string[], startHalfMoves: number): string {
  if (betterLine.length === 0) return "";
  const parts = [betterLine[0]];
  for (let i = 1; i < betterLine.length; i++) {
    const halfMoves = startHalfMoves + i;
    if (halfMoves % 2 === 1) {
      parts.push(`${Math.ceil(halfMoves / 2)}. ${betterLine[i]}`);
    } else {
      parts.push(betterLine[i]);
    }
  }
  return parts.join(" ");
}

function formatMistakeKind(t: TFunction, kind: MistakeKind): string {
  switch (kind) {
    case "allowsMate":
      return t("Board.Analysis.Report.MistakeKind.AllowsMate");
    case "missesMate":
      return t("Board.Analysis.Report.MistakeKind.MissesMate");
    case "losesMaterial":
      return t("Board.Analysis.Report.MistakeKind.LosesMaterial");
    case "missesMaterial":
      return t("Board.Analysis.Report.MistakeKind.MissesMaterial");
    case "missesWin":
      return t("Board.Analysis.Report.MistakeKind.MissesWin");
    case "decisive":
      return t("Board.Analysis.Report.MistakeKind.Decisive");
  }
}

/**
 * Builds the translated Coach explanation question for a marked key moment (O7).
 * Uses literal keys so i18next extraction retains every sentence variant.
 */
export function buildExplainQuestion(t: TFunction, item: KeyMomentItem): string {
  const { moment } = item;
  const move = `${formatMoveNumber(moment.halfMoves)} ${moment.san}${moment.annotation}`;
  const before = moment.before ? formatScore(moment.before.value) : NO_VALUE;
  const after = moment.after ? formatScore(moment.after.value) : NO_VALUE;
  const played = item.mistakeKind
    ? t("Board.Analysis.Report.ExplainQuestion.PlayedWithKind", {
        move,
        kind: formatMistakeKind(t, item.mistakeKind),
        before,
        after,
      })
    : t("Board.Analysis.Report.ExplainQuestion.Played", {
        move,
        before,
        after,
      });
  const better = formatBetterLine(item.betterLine, moment.halfMoves);
  const ask = better
    ? t("Board.Analysis.Report.ExplainQuestion.AskWithBetter", { better })
    : t("Board.Analysis.Report.ExplainQuestion.Ask");
  return `${played} ${ask}`;
}

interface KeyMomentsProps {
  items: readonly KeyMomentItem[];
  focusedBeforePath: number[] | null;
  chartHoveredPath: number[] | null;
  canExplain?: boolean;
  onSelectMoment: (item: KeyMomentItem) => void;
  onSelectBetterLine: (path: number[]) => void;
  onExplainMoment?: (item: KeyMomentItem) => void;
  onHoverMoment: (movePath: number[] | null) => void;
}

/** Marked mainline moves in game order with side filter and board walkthrough (O5). */
export function KeyMoments({
  items,
  focusedBeforePath,
  chartHoveredPath,
  canExplain = false,
  onSelectMoment,
  onSelectBetterLine,
  onExplainMoment,
  onHoverMoment,
}: KeyMomentsProps) {
  const { t } = useTranslation();
  const [sideFilter, setSideFilter] = useState<SideFilter>("both");

  const filteredItems = useMemo(
    () => (sideFilter === "both" ? items : items.filter((item) => item.color === sideFilter)),
    [items, sideFilter],
  );

  const currentIndex = focusedBeforePath
    ? filteredItems.findIndex((item) => equal(item.beforePath, focusedBeforePath))
    : -1;

  const canGoPrevious = filteredItems.length > 0 && currentIndex !== 0;
  const canGoNext = filteredItems.length > 0 && currentIndex !== filteredItems.length - 1;

  const handlePrevious = () => {
    if (filteredItems.length === 0) return;
    if (currentIndex === -1) {
      onSelectMoment(filteredItems[filteredItems.length - 1]);
    } else if (currentIndex > 0) {
      onSelectMoment(filteredItems[currentIndex - 1]);
    }
  };

  const handleNext = () => {
    if (filteredItems.length === 0) return;
    if (currentIndex === -1) {
      onSelectMoment(filteredItems[0]);
    } else if (currentIndex < filteredItems.length - 1) {
      onSelectMoment(filteredItems[currentIndex + 1]);
    }
  };

  const formatEval = (score: KeyMoment["before"]) => (score ? formatScore(score.value) : NO_VALUE);

  return (
    <Paper withBorder p="md">
      <Group justify="space-between" align="baseline" gap="xs" mb="xs" wrap="wrap">
        <Text fw={600} id="report-key-moments">
          {t("Board.Analysis.Report.KeyMoments")}
        </Text>
        <ExplainedLabel
          label={t("Board.Analysis.Report.EvalDirectionLabel")}
          explanation={t("Board.Analysis.Report.EvalDirectionDesc")}
          size="xs"
          dimmed
        />
      </Group>

      <div className={classes.keyMomentsToolbar}>
        <SegmentedControl
          aria-label={t("Board.Analysis.Report.FilterSide")}
          size="xs"
          value={sideFilter}
          onChange={(value) => setSideFilter(value as SideFilter)}
          data={[
            { value: "both", label: t("Board.Analysis.Report.FilterBoth") },
            { value: "white", label: t("Board.Analysis.Report.FilterWhite") },
            { value: "black", label: t("Board.Analysis.Report.FilterBlack") },
          ]}
        />
        <div className={classes.walkthroughButtons}>
          <Button
            variant="default"
            size="xs"
            leftSection={<ChevronLeft size="0.875rem" />}
            onClick={handlePrevious}
            disabled={!canGoPrevious}
          >
            {t("Board.Analysis.Report.PreviousMoment")}
          </Button>
          <Button
            variant="default"
            size="xs"
            rightSection={<ChevronRight size="0.875rem" />}
            onClick={handleNext}
            disabled={!canGoNext}
          >
            {t("Board.Analysis.Report.NextMoment")}
          </Button>
        </div>
      </div>

      {filteredItems.length === 0 ? (
        <Text fz="sm" c="dimmed">
          {t("Board.Analysis.Report.NoMomentsForSide")}
        </Text>
      ) : (
        <Stack
          gap={4}
          component="ul"
          aria-labelledby="report-key-moments"
          className={classes.keyMoments}
        >
          {filteredItems.map((item) => {
            const { moment } = item;
            const isCurrent =
              focusedBeforePath !== null && equal(focusedBeforePath, item.beforePath);
            const isHighlighted = chartHoveredPath !== null && equal(chartHoveredPath, moment.path);
            const markHue = ANNOTATION_INFO[moment.annotation].color;
            const formattedBetter = formatBetterLine(item.betterLine, moment.halfMoves);
            const hasMeta = item.mistakeKind !== null || item.isTurningPoint || item.inTimeTrouble;
            const showExplain =
              Boolean(canExplain && onExplainMoment) && isMistakeAnnotation(moment.annotation);

            return (
              <li
                key={moment.halfMoves}
                className={cx(
                  classes.keyMomentRow,
                  isCurrent && classes.keyMomentCurrent,
                  isHighlighted && classes.keyMomentHighlighted,
                )}
                // The bar uses the raw NAG hue; the mark glyph uses annotationTextColor for contrast.
                style={
                  {
                    "--key-moment-color": `var(--mantine-color-${markHue}-6)`,
                  } as CSSProperties
                }
                data-testid="report-key-moment"
                data-current={isCurrent || undefined}
                data-highlighted={isHighlighted || undefined}
                onMouseEnter={() => onHoverMoment(moment.path)}
                onMouseLeave={() => onHoverMoment(null)}
                onFocus={() => onHoverMoment(moment.path)}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    onHoverMoment(null);
                  }
                }}
              >
                <UnstyledButton
                  type="button"
                  className={classes.keyMomentMain}
                  aria-current={isCurrent ? "true" : undefined}
                  onClick={() => onSelectMoment(item)}
                >
                  <span className={classes.keyMomentNumber}>
                    {formatMoveNumber(moment.halfMoves)}{" "}
                  </span>
                  <span className={classes.keyMomentMove}>
                    {moment.san}
                    <span style={{ color: annotationTextColor(markHue) }}>{moment.annotation}</span>
                  </span>
                  <span className={classes.evalChange}>
                    {formatEval(moment.before)} → {formatEval(moment.after)}
                  </span>
                  {hasMeta && (
                    <span className={classes.keyMomentMeta}>
                      {item.mistakeKind && (
                        <span className={classes.mistakeKind}>
                          {formatMistakeKind(t, item.mistakeKind)}
                        </span>
                      )}
                      {item.isTurningPoint && (
                        <span className={classes.momentTag}>
                          {t("Board.Analysis.Report.Tag.TurningPoint")}
                        </span>
                      )}
                      {item.inTimeTrouble && (
                        <span className={cx(classes.momentTag, classes.momentTagTrouble)}>
                          {t("Board.Analysis.Report.Tag.TimeTrouble")}
                        </span>
                      )}
                    </span>
                  )}
                </UnstyledButton>
                {(formattedBetter || showExplain) && (
                  <div className={classes.keyMomentFooter}>
                    {formattedBetter && (
                      <div className={classes.betterLineRow}>
                        {item.betterChildPath ? (
                          <UnstyledButton
                            type="button"
                            className={classes.betterLineLink}
                            onClick={() => onSelectBetterLine(item.betterChildPath!)}
                          >
                            {t("Board.Analysis.Report.BetterMove", { move: formattedBetter })}
                          </UnstyledButton>
                        ) : (
                          <Text
                            component="span"
                            fz="xs"
                            c="dimmed"
                            className={classes.betterLineText}
                          >
                            {t("Board.Analysis.Report.BetterMove", { move: formattedBetter })}
                          </Text>
                        )}
                      </div>
                    )}
                    {showExplain && (
                      <Button
                        type="button"
                        variant="subtle"
                        size="compact-xs"
                        className={classes.explainButton}
                        leftSection={<AiChatIcon size="0.875rem" aria-hidden />}
                        onClick={(event) => {
                          event.stopPropagation();
                          onExplainMoment?.(item);
                        }}
                      >
                        {t("Board.Analysis.Report.Explain")}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </Stack>
      )}
    </Paper>
  );
}
