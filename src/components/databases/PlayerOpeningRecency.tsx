import { Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { PositionStats } from "@/bindings";
import { formatPgnYearMonth } from "@/utils/pgnDate";
import { yearBuckets } from "./openingRecency";
import classes from "./PlayerOpeningTree.module.css";

const MINIMUM_COLOUR_SHARE = 25;

export default function PlayerOpeningRecency({
  row,
  currentYear,
  sectionTotals,
}: {
  row: PositionStats;
  currentYear: number;
  sectionTotals: readonly number[];
}) {
  const { t } = useTranslation();
  const { firstYear, counts } = yearBuckets(row.year_counts, currentYear);
  const total = row.white + row.draw + row.black + row.unknown;
  const unplaced = total - counts.reduce((sum, count) => sum + count, 0);
  const labels = counts.map((count, index) => {
    const year = index === 0 ? firstYear : firstYear + index - 1;
    const bucketTotal = sectionTotals[index] ?? 0;
    if (bucketTotal === 0) {
      return index === 0
        ? t("Databases.OpeningTree.Recency.OlderEmpty", {
            defaultValue: "Before {{year}}: no games",
            year,
          })
        : t("Databases.OpeningTree.Recency.YearEmpty", {
            defaultValue: "{{year}}: no games",
            year,
          });
    }
    const percent = Math.round((count / bucketTotal) * 100);
    return index === 0
      ? t("Databases.OpeningTree.Recency.Older", {
          defaultValue: "Before {{year}}: {{played}} of {{count}} games ({{percent}}%)",
          year,
          played: count,
          count: bucketTotal,
          percent,
        })
      : t("Databases.OpeningTree.Recency.Year", {
          defaultValue: "{{year}}: {{played}} of {{count}} games ({{percent}}%)",
          year,
          played: count,
          count: bucketTotal,
          percent,
        });
  });
  const summary = t("Databases.OpeningTree.Recency.Summary", {
    defaultValue: "Games by year: {{years}}",
    years: labels.join(", "),
  });
  const missing =
    unplaced > 0
      ? t("Databases.OpeningTree.Recency.Unplaced", {
          defaultValue: "{{count}} without a usable year",
          count: unplaced,
        })
      : "";
  const displayDate = formatPgnYearMonth(row.last_played);

  return (
    <div className={classes.recency} data-opening-recency>
      <span data-opening-last-played>
        <span className={classes.compactRecencyLabel}>
          {t("Databases.OpeningTree.LastPlayed", { defaultValue: "Last played" })}{" "}
        </span>
        {displayDate}
      </span>
      <div
        className={classes.yearStrip}
        role="img"
        aria-label={missing ? `${summary}, ${missing}` : summary}
      >
        {counts.map((count, index) => {
          const bucketTotal = sectionTotals[index] ?? 0;
          const share = bucketTotal > 0 ? count / bucketTotal : 0;
          return (
            <Tooltip key={index} label={labels[index]}>
              <span
                aria-hidden="true"
                className={classes.yearCell}
                data-count={count}
                style={{
                  background:
                    count > 0 && bucketTotal > 0
                      ? `color-mix(in srgb, var(--cf-primary) ${MINIMUM_COLOUR_SHARE + share * (100 - MINIMUM_COLOUR_SHARE)}%, var(--cf-interactive))`
                      : "var(--cf-interactive)",
                }}
              />
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
