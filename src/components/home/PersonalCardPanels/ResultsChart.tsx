import { Progress } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { ResultBar } from "@/components/common/ResultBar";

const LABEL_STYLE = { textOverflow: "clip" } as const;

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
  const total = won + draw + lost;
  if (total === 0) return <Progress.Root size={size} />;
  const formatLabel = (count: number) =>
    count / total > labelThreshold ? `${((count / total) * 100).toFixed(1)}%` : "";

  return (
    <ResultBar
      size={size}
      segments={[
        {
          value: (won / total) * 100,
          color: "success",
          label: formatLabel(won),
          labelStyle: LABEL_STYLE,
          tooltip: `${won} ${t("Databases.OpeningTree.Wins")}`,
        },
        {
          value: (draw / total) * 100,
          color: "gray",
          label: formatLabel(draw),
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
