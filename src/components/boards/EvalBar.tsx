import { useTabAtom } from "@/state/tabScope";
import type { Color } from "@lichess-org/chessground/types";
import { Box, Text, Tooltip } from "@mantine/core";
import { useAtom } from "jotai";
import type { Score } from "@/bindings";
import { evalBarDisplayFamily, evalOpenFamily } from "@/state/atoms";
import { formatScore, getWinChance } from "@/utils/score";

function EvalBar({
  score,
  engineName = null,
  orientation,
}: {
  score: Score | null;
  /** The engine the score comes from, named in the tooltip. */
  engineName?: string | null;
  orientation: Color;
}) {
  const [evalDisplay, setEvalDisplay] = useAtom(useTabAtom(evalBarDisplayFamily));
  const [, setEvalOpen] = useAtom(useTabAtom(evalOpenFamily));

  const handleClick = () => {
    if (setEvalDisplay) {
      setEvalDisplay(evalDisplay === "cp" ? "wdl" : "cp");
    }
  };

  let ScoreBars = null;
  if (score) {
    const scoreValue = score.value;
    const wdl = score.wdl;

    if (evalDisplay === "wdl" && wdl) {
      const [w, d, l] = wdl;
      const whiteWin = w / 10;
      const draw = d / 10;
      const blackWin = l / 10;

      const sections = [
        {
          key: "black",
          height: blackWin,
          bg: "var(--cf-eval-bar-dark)",
          textColor: "var(--cf-eval-bar-light)",
          label: blackWin >= 20 ? blackWin.toFixed(0) : "",
        },
        {
          key: "draw",
          height: draw,
          bg: "var(--cf-chart-4)",
          textColor: "var(--cf-eval-bar-dark)",
          label: draw >= 20 ? draw.toFixed(0) : "",
        },
        {
          key: "white",
          height: whiteWin,
          bg: "var(--cf-eval-bar-light)",
          textColor: "var(--cf-eval-bar-dark)",
          label: whiteWin >= 20 ? whiteWin.toFixed(0) : "",
        },
      ];

      if (orientation === "black") {
        sections.reverse();
      }

      ScoreBars = sections.map((section) => (
        <Box
          key={section.key}
          style={{
            height: `${section.height}%`,
            backgroundColor: section.bg,
            transition: "height 0.2s ease",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
          }}
        >
          <Text fz="xs" c={section.textColor} ta="center">
            {section.label}
          </Text>
        </Box>
      ));
    } else {
      const progress =
        scoreValue.type === "cp" ? getWinChance(scoreValue.value) : scoreValue.value > 0 ? 100 : 0;

      ScoreBars = [
        <Box
          key="black"
          style={{
            height: `${100 - progress}%`,
            backgroundColor: "var(--cf-eval-bar-dark)",
            transition: "height 0.2s ease",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <Text
            fz="xs"
            c={"var(--cf-eval-bar-light)"}
            ta="center"
            py={3}
            mt={orientation === "black" ? "auto" : undefined}
          >
            {scoreValue.value <= 0 && formatScore(scoreValue, 1).replace(/\+|-/, "")}
          </Text>
        </Box>,
        <Box
          key="white"
          style={{
            height: `${progress}%`,
            backgroundColor: "var(--cf-eval-bar-light)",
            transition: "height 0.2s ease",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <Text
            fz="xs"
            py={3}
            c={"var(--cf-eval-bar-dark)"}
            ta="center"
            mt={orientation === "white" ? "auto" : undefined}
          >
            {scoreValue.value > 0 && formatScore(scoreValue, 1).slice(1)}
          </Text>
        </Box>,
      ];

      if (orientation === "black") {
        ScoreBars = ScoreBars.reverse();
      }
    }
  }

  return (
    <Tooltip
      position="right"
      color="var(--cf-popover)"
      label={score ? [formatScore(score.value), engineName].filter(Boolean).join(" · ") : undefined}
      disabled={!score}
    >
      <Box
        onClick={handleClick}
        onContextMenu={(e) => {
          setEvalOpen(false);
          e.preventDefault();
        }}
        style={{
          width: 25,
          height: "100%",
          borderRadius: "var(--mantine-radius-xs)",
          overflow: "hidden",
        }}
      >
        {ScoreBars}
      </Box>
    </Tooltip>
  );
}

export default EvalBar;
