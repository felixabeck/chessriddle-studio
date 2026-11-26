import { useTabAtom } from "@/state/tabScope";
import { Box, rgba, useMantineTheme } from "@mantine/core";
import { Flag } from "lucide-react";
import { useAtom } from "jotai";
import type { MouseEvent, ReactNode, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { showCommentsFamily, moveNotationTypeAtom } from "@/state/atoms";
import {
  ANNOTATION_INFO,
  type Annotation,
  addPieceSymbol,
  annotationTextColor,
  formatNagGlyphs,
} from "@/utils/annotation";
import classes from "./MoveCell.module.css";

/**
 * Drop DOM focus from a notation control after a pointer click that navigates the game.
 *
 * Arrow-key navigation moves the current position elsewhere, and the browser would then
 * draw the keyboard focus ring on the clicked control, which no longer marks the current
 * move. `detail` is 0 for Enter/Space activation, so keyboard focus is kept.
 */
export function releasePointerFocus(event: MouseEvent<HTMLElement>) {
  if (event.detail > 0) event.currentTarget.blur();
}

const RELEASES_FOCUS_ATTRIBUTE = "data-move-key-releases-focus";

/**
 * Marks a focusable row whose focus ends when a move shortcut runs. The row keeps focus after a
 * click, so Enter still acts on it, but the shortcut steps the moves elsewhere and the browser
 * would then draw the keyboard focus ring on the row.
 */
export const moveKeyReleasesFocus = { [RELEASES_FOCUS_ATTRIBUTE]: true };

/** Only the marked element itself lets go: a control nested in it keeps its own focus. */
export function releaseFocusOnMoveKey(event: KeyboardEvent) {
  const { target } = event;
  if (target instanceof HTMLElement && target.hasAttribute(RELEASES_FOCUS_ATTRIBUTE)) {
    target.blur();
  }
}

interface MoveCellProps {
  annotations: Annotation[];
  forceAnnotations?: boolean;
  isStart: boolean;
  isCurrentVariation: boolean;
  move: string;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  fullWidth?: boolean;
  rightAccessory?: ReactNode;
  analysis?: boolean;
  /** A side line one move long: framed with a dashed line until it gets a second move. */
  openVariation?: boolean;
  /** Flagged as unsure during an active scoresheet photo review. */
  unsure?: boolean;
  /** Imported repertoire conflict move awaiting review. */
  reviewMark?: boolean;
  ref?: RefObject<HTMLButtonElement>;
}

function MoveCell(props: MoveCellProps) {
  const { t } = useTranslation();
  const [moveNotationType] = useAtom(moveNotationTypeAtom);
  const [showComments] = useAtom(useTabAtom(showCommentsFamily));
  const showAnnotations = props.forceAnnotations || showComments;
  const visualAnnotation = showAnnotations ? props.annotations[0] : "";

  const color = ANNOTATION_INFO[visualAnnotation]?.color || "gray";
  const theme = useMantineTheme();
  const unannotatedColor = (fallback: string) =>
    `var(--notation-unannotated-move-color, ${fallback})`;

  // An unannotated move takes the warm palette (DESIGN.md), never Mantine's neutral gray: the
  // translucent move hover, which reads on the card and on the surface-inset variation blocks
  // and engine lines alike, and the gold current-move fill when current. Fills are the same in
  // both schemes; only the text colour differs.
  let lightColor = unannotatedColor(theme.colors.gray[8]);
  let darkColor = unannotatedColor(theme.colors.gray[1]);
  let background = "transparent";
  let hover = "var(--cf-move-hover)";

  const annotationText = annotationTextColor(color);
  if (annotationText) {
    // The text takes the mark's readable shade per scheme; the hover tint stays the shade 6 hue.
    lightColor = annotationText;
    darkColor = annotationText;
    hover = rgba(theme.colors[color][6], 0.1);
  }

  // Every current move is gold, annotated or not, as [data-notation-current] .cell draws it.
  if (props.isCurrentVariation) {
    background = "var(--move-current-fill)";
    hover = "var(--move-current-hover)";
  }

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    releasePointerFocus(event);
    props.onClick();
  };

  const formattedMove = moveNotationType === "symbols" ? addPieceSymbol(props.move) : props.move;
  const formattedNags = showAnnotations ? formatNagGlyphs(props.annotations) : "";
  const title = props.unsure
    ? t("Notation.UnsureMove")
    : props.reviewMark
      ? t("Notation.ReviewMove")
      : props.openVariation
        ? t("Notation.OpenVariation")
        : undefined;

  return (
    <Box
      ref={props.ref}
      component="button"
      className={`${classes.cell} ${props.fullWidth ? classes.cellFullWidth : ""}`}
      data-notation-analysis={props.analysis ? "true" : undefined}
      data-notation-open-variation={props.openVariation ? "true" : undefined}
      data-notation-unsure={props.unsure ? "true" : undefined}
      data-notation-review-mark={props.reviewMark ? "true" : undefined}
      title={title}
      aria-label={
        props.unsure
          ? t("Notation.UnsureMoveLabel", { move: `${formattedMove}${formattedNags}` })
          : props.reviewMark
            ? t("Notation.ReviewMoveLabel", { move: `${formattedMove}${formattedNags}` })
            : undefined
      }
      aria-current={props.isCurrentVariation ? "true" : undefined}
      style={{
        "--light-color": lightColor,
        "--dark-color": darkColor,
        "--move-bg": background,
        "--move-hover": hover,
      }}
      onClick={handleClick}
      onContextMenu={props.onContextMenu}
    >
      <Box component="span" className={classes.moveText}>
        {props.isStart && <Flag style={{ marginRight: 5 }} size="0.875rem" />}
        {formattedMove}
        {formattedNags}
      </Box>
      {props.rightAccessory && (
        <Box component="span" className={classes.rightAccessory}>
          {props.rightAccessory}
        </Box>
      )}
    </Box>
  );
}

export default MoveCell;
