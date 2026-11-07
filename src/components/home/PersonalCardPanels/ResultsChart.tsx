import { Tooltip as MTTooltip, Progress } from "@mantine/core";
import { useTranslation } from "react-i18next";

function ResultsChart({
  won,
  draw,
  lost,
  size,
  playerPerspective = false,
}: {
  won: number;
  draw: number;
  lost: number;
  size: string;
  playerPerspective?: boolean;
}) {
  const { t } = useTranslation();
  const total = won + draw + lost;
  if (playerPerspective && total === 0) return <Progress.Root size={size} />;
  return (
    <Progress.Root size={size}>
      <MTTooltip
        label={`${won} ${playerPerspective ? t("Databases.OpeningTree.Wins", { defaultValue: "Wins" }) : t("Board.Database.Local.Result.WhiteWon")}`}
      >
        <Progress.Section value={(won / total) * 100} color="success">
          <Progress.Label style={{ textOverflow: "clip" }}>
            {won / total > 0.15 ? `${((won / total) * 100).toFixed(1)}%` : undefined}
          </Progress.Label>
        </Progress.Section>
      </MTTooltip>

      <MTTooltip label={`${draw} ${t("Board.Analysis.Tablebase.Draw")}`}>
        <Progress.Section value={(draw / total) * 100} color="gray">
          <Progress.Label style={{ textOverflow: "clip" }}>
            {draw / total > 0.15 ? `${((draw / total) * 100).toFixed(1)}%` : undefined}
          </Progress.Label>
        </Progress.Section>
      </MTTooltip>

      <MTTooltip
        label={`${lost} ${playerPerspective ? t("Databases.OpeningTree.Losses", { defaultValue: "Losses" }) : t("Board.Database.Local.Result.BlackWon")}`}
      >
        <Progress.Section value={(lost / total) * 100} color="danger">
          <Progress.Label style={{ textOverflow: "clip" }}>
            {lost / total > 0.15 ? `${((lost / total) * 100).toFixed(1)}%` : undefined}
          </Progress.Label>
        </Progress.Section>
      </MTTooltip>
    </Progress.Root>
  );
}

export default ResultsChart;
