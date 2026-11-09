import { SegmentedControl } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { useTranslation } from "react-i18next";
import type { Tab } from "@/state/workspaceTypes";
import { useRootFontPx } from "@/hooks/useRootFontPx";
import classes from "./PuzzleSourceControl.module.css";

export type PuzzleSource = NonNullable<Tab["puzzleSource"]>;

const SOURCE_CONTROL_MIN_WIDTH_REM = 28;

export default function PuzzleSourceControl({
  source,
  disabled,
  onChange,
}: {
  source: PuzzleSource;
  disabled: boolean;
  onChange: (source: PuzzleSource) => void;
}) {
  const { t } = useTranslation();
  const { ref, width } = useElementSize();
  const rootFont = useRootFontPx();
  return (
    <div ref={ref} className={classes.container}>
      <SegmentedControl
        fullWidth
        size="xs"
        orientation={width >= SOURCE_CONTROL_MIN_WIDTH_REM * rootFont ? "horizontal" : "vertical"}
        className={classes.control}
        aria-label={t("Puzzle.Source.Label")}
        value={source}
        disabled={disabled}
        onChange={(value) => onChange(value as PuzzleSource)}
        data={[
          { value: "chessriddle", label: t("Puzzle.Source.ChessRiddle") },
          { value: "offline", label: t("Puzzle.Source.Offline") },
        ]}
      />
    </div>
  );
}
