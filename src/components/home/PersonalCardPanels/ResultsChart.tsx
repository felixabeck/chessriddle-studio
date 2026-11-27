import { Progress, useComputedColorScheme } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { ResultBar } from "@/components/common/ResultBar";

const LABEL_STYLE = { textOverflow: "clip" } as const;
/** Success fills are mid-green in both schemes; black is the AA foreground. */
const WIN_LABEL_COLOR = "var(--mantine-color-black)";

function ResultsChart({
  won,
  draw,
  lost,
  size,
  labelThreshold = 0.15,
}: {
  won: number;
  draw: number;
  lost: number;
  size: string;
  labelThreshold?: number;
}) {
  const { t } = useTranslation();
  const colorScheme = useComputedColorScheme("dark");
  const total = won + draw + lost;
  if (total === 0) return <Progress.Root size={size} />;
  const formatLabel = (count: number) =>
    count / total > labelThreshold ? `${((count / total) * 100).toFixed(1)}%` : "";
  // Mantine gray-filled is gray[8] in light (dark bar) and gray[4] in dark (light bar).
  const drawLabelColor =
    colorScheme === "light" ? "var(--mantine-color-white)" : "var(--mantine-color-black)";

  return (
    <ResultBar
      size={size}
      segments={[
        {
          value: (won / total) * 100,
          color: "success",
          label: formatLabel(won),
          labelColor: WIN_LABEL_COLOR,
          labelStyle: LABEL_STYLE,
          tooltip: `${won} ${t("Databases.OpeningTree.Wins")}`,
        },
        {
          value: (draw / total) * 100,
          color: "gray",
          label: formatLabel(draw),
          labelColor: drawLabelColor,
          labelStyle: LABEL_STYLE,
          tooltip: `${draw} ${t("Board.Analysis.Tablebase.Draw")}`,
        },
        {
          value: (lost / total) * 100,
          color: "danger",
          label: formatLabel(lost),
          labelStyle: LABEL_STYLE,
          tooltip: `${lost} ${t("Databases.OpeningTree.Losses")}`,
        },
      ]}
    />
  );
}

export default ResultsChart;
