import { Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { PositionStats } from "@/bindings";
import classes from "./PlayerOpeningTree.module.css";

const VISIBLE_YEAR_COUNT = 8;
const MINIMUM_COLOUR_SHARE = 25;

export default function PlayerOpeningRecency({ row }: { row: PositionStats }) {
  // The compiler otherwise caches Date construction for the lifetime of this mount.
  "use no memo";

  const { t } = useTranslation();
  const currentYear = new Date().getFullYear();
  const firstYear = currentYear - VISIBLE_YEAR_COUNT + 1;
  const counts = Array<number>(VISIBLE_YEAR_COUNT + 1).fill(0);
  for (const { year, count } of row.year_counts) {
    if (year > 0 && year <= currentYear) {
      counts[year < firstYear ? 0 : year - firstYear + 1] += count;
    }
  }
  const total = row.white + row.draw + row.black + row.unknown;
  const unplaced = total - counts.reduce((sum, count) => sum + count, 0);
  const maximum = Math.max(...counts);
  const labels = counts.map((count, index) =>
    index === 0
      ? t("Databases.OpeningTree.Recency.Older", {
          defaultValue: "Before {{year}}: {{count}} games",
          year: firstYear,
          count,
        })
      : t("Databases.OpeningTree.Recency.Year", {
          defaultValue: "{{year}}: {{count}} games",
          year: firstYear + index - 1,
          count,
        }),
  );
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
  const date = row.last_played;
  const month = date?.slice(5, 7);
  const displayDate = date
    ? month && /^(0[1-9]|1[0-2])$/.test(month)
      ? `${date.slice(0, 4)}-${month}`
      : date.slice(0, 4)
    : "–";

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
        {counts.map((count, index) => (
          <Tooltip key={index} label={labels[index]}>
            <span
              aria-hidden="true"
              className={classes.yearCell}
              data-count={count}
              style={{
                background:
                  count > 0
                    ? `color-mix(in srgb, var(--cf-primary) ${MINIMUM_COLOUR_SHARE + (count / maximum) * (100 - MINIMUM_COLOUR_SHARE)}%, var(--cf-interactive))`
                    : "var(--cf-interactive)",
              }}
            />
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
