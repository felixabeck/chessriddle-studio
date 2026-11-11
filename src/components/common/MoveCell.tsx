import { useTabAtom } from "@/state/tabScope";
import { Box, rgba, useMantineTheme } from "@mantine/core";
import { Flag } from "lucide-react";
import { useAtom } from "jotai";
import type { MouseEvent, ReactNode, RefObject } from "react";
import { showCommentsFamily, moveNotationTypeAtom } from "@/state/atoms";
import {
  ANNOTATION_INFO,
  type Annotation,
  addPieceSymbol,
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
  ref?: RefObject<HTMLButtonElement>;
}

function MoveCell(props: MoveCellProps) {
  const [moveNotationType] = useAtom(moveNotationTypeAtom);
  const [showComments] = useAtom(useTabAtom(showCommentsFamily));
  const showAnnotations = props.forceAnnotations || showComments;
  const visualAnnotation = showAnnotations ? props.annotations[0] : "";

  const color = ANNOTATION_INFO[visualAnnotation]?.color || "gray";
  const theme = useMantineTheme();
  const hoverOpacity = props.isCurrentVariation ? 0.25 : 0.1;
  let baseLight = theme.colors.gray[8];
  let hoverLight = rgba(baseLight, hoverOpacity);
  let baseDark = theme.colors.gray[1];
  let hoverDark = rgba(baseDark, hoverOpacity);
  let darkBg = "transparent";
  let lightBg = "transparent";

  if (color !== "gray") {
    baseLight = theme.colors[color][6];
    hoverLight = rgba(baseLight, hoverOpacity);
    baseDark = theme.colors[color][6];
    hoverDark = rgba(baseDark, hoverOpacity);
  }

  if (props.isCurrentVariation) {
    darkBg = rgba(theme.colors[color][6], 0.2);
    lightBg = rgba(theme.colors[color][6], 0.2);
    hoverLight = rgba(lightBg, 0.25);
    hoverDark = rgba(darkBg, 0.25);
  }

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    releasePointerFocus(event);
    props.onClick();
  };

  return (
    <Box
      ref={props.ref}
      component="button"
      className={`${classes.cell} ${props.fullWidth ? classes.cellFullWidth : ""}`}
      data-notation-analysis={props.analysis ? "true" : undefined}
      style={{
        "--light-color":
          color === "gray" ? `var(--notation-unannotated-move-color, ${baseLight})` : baseLight,
        "--light-hover-color": hoverLight,
        "--dark-color":
          color === "gray" ? `var(--notation-unannotated-move-color, ${baseDark})` : baseDark,
        "--dark-hover-color": hoverDark,
        "--dark-bg": darkBg,
        "--light-bg": lightBg,
      }}
      onClick={handleClick}
      onContextMenu={props.onContextMenu}
    >
      <Box component="span" className={classes.moveText}>
        {props.isStart && <Flag style={{ marginRight: 5 }} size="0.875rem" />}
        {moveNotationType === "symbols" ? addPieceSymbol(props.move) : props.move}
        {showAnnotations ? formatNagGlyphs(props.annotations) : ""}
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
