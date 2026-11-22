import { ListPlus } from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { IconAction } from "@/components/common/IconAction";
import { halfMovesOfFen } from "@/utils/coachContext";
import { EngineLinePreviewMoves, useEngineLinePreview } from "../analysis/EngineLinePreview";
import classes from "./CoachPanel.module.css";

/**
 * One checked line of an answer. Its moves only preview: hovering or clicking shows the position
 * on a small board and never touches the game. The button at its end is the single way a line
 * gets into the game, as a variation at the position the question was asked about.
 */
export function CoachLine({
  fen,
  san,
  orientation,
  onInsert,
}: {
  /** The position the line starts from. */
  fen: string;
  san: string[];
  orientation: "white" | "black";
  /** Inserts the line; absent when its starting position is no longer in the game. */
  onInsert?: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLSpanElement>(null);
  const preview = useEngineLinePreview({
    fen,
    moves: san,
    visibleCount: Infinity,
    orientation,
    anchor: ref,
    inert: false,
    previewOnly: true,
  });
  return (
    <span ref={ref} className={classes.line} data-testid="coach-line" onMouseLeave={preview.close}>
      <EngineLinePreviewMoves
        preview={preview}
        halfMoves={halfMovesOfFen(fen)}
        threat={false}
        inert={false}
      />
      <IconAction
        size="sm"
        variant="subtle"
        label={onInsert ? t("Coach.InsertLine") : t("Coach.InsertUnavailable")}
        disabled={!onInsert}
        onClick={onInsert}
      >
        <ListPlus size="0.9rem" />
      </IconAction>
      {preview.board}
    </span>
  );
}
