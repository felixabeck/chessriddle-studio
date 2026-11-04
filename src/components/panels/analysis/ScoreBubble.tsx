import { Box, Progress, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { Score } from "@/bindings";
import { formatScore } from "@/utils/score";
import classes from "./ScoreBubble.module.css";

function ScoreBubble({
  size,
  score,
  evalDisplay = "cp",
  setEvalDisplay = () => {},
}: {
  size: "sm" | "md";
  score: Score;
  evalDisplay?: "cp" | "wdl";
  setEvalDisplay?: (display: "cp" | "wdl") => void;
}) {
  const { t } = useTranslation();
  if (evalDisplay === "wdl" && score.wdl) {
    const [w, d, l] = score.wdl;
    return (
      <Progress.Root
        size="xl"
        className={`${classes.bubble} ${classes.wdl}`}
        data-size={size}
        onClick={() => setEvalDisplay("cp")}
        fz="0.5rem"
        styles={{
          label: {
            paddingInline: 0,
          },
        }}
      >
        <Progress.Section
          value={w / 10}
          aria-label={t("Board.Analysis.Tablebase.WhiteWins")}
          className={classes.white}
        >
          {w > 200 && (
            <Progress.Label className={classes.label}>{(w / 10).toFixed(0)}</Progress.Label>
          )}
        </Progress.Section>
        <Progress.Section
          value={d / 10}
          aria-label={t("Board.Analysis.Tablebase.Draw")}
          className={classes.equal}
        >
          {d > 200 && (
            <Progress.Label className={classes.label}>{(d / 10).toFixed(0)}</Progress.Label>
          )}
        </Progress.Section>
        <Progress.Section
          value={l / 10}
          aria-label={t("Board.Analysis.Tablebase.BlackWins")}
          className={classes.black}
        >
          {l > 200 && (
            <Progress.Label className={classes.label}>{(l / 10).toFixed(0)}</Progress.Label>
          )}
        </Progress.Section>
      </Progress.Root>
    );
  }
  return (
    <Box
      className={`${classes.bubble} ${score.value.value === 0 ? classes.equal : score.value.value > 0 ? classes.white : classes.black}`}
      data-size={size}
      onClick={() => setEvalDisplay("wdl")}
    >
      <Text
        c="inherit"
        fw={700}
        lh={1.25}
        size={size}
        ta="center"
        style={(theme) => ({
          fontFamily: theme.fontFamilyMonospace,
        })}
      >
        {formatScore(score.value)}
      </Text>
    </Box>
  );
}

export default ScoreBubble;
