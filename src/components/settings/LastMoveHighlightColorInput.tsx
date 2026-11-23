import { Box, ColorInput, Group } from "@mantine/core";
import { useAtom, useAtomValue } from "jotai";
import { useContext, useEffect, useState } from "react";
import {
  boardImageAtom,
  lastMoveHighlightColorAtom,
  lastMoveHighlightOpacityAtom,
} from "@/state/atoms";
import {
  LAST_MOVE_HIGHLIGHT_PRESETS,
  lastMoveHighlightBackground,
  parseLastMoveHighlightColor,
} from "@/state/lastMoveHighlight";
import { SettingLabelContext } from "./SettingsLayout";

const PREVIEW_SQUARE_PX = 24;

/** Two squares of the selected board (a light and a dark one) under the chosen highlight. */
function HighlightPreview({ background }: { background: string }) {
  const boardImage = useAtomValue(boardImageAtom);
  return (
    <Box
      data-testid="last-move-highlight-preview"
      aria-hidden
      style={{
        width: PREVIEW_SQUARE_PX * 2,
        height: PREVIEW_SQUARE_PX,
        flexShrink: 0,
        borderRadius: "var(--mantine-radius-xs)",
        overflow: "hidden",
        backgroundImage: `linear-gradient(${background}, ${background}), url('/board/${boardImage}')`,
        backgroundSize: `100% 100%, ${PREVIEW_SQUARE_PX * 8}px ${PREVIEW_SQUARE_PX * 8}px`,
        backgroundPosition: "0 0, 0 0",
      }}
    />
  );
}

export default function LastMoveHighlightColorInput() {
  const label = useContext(SettingLabelContext);
  const [color, setColor] = useAtom(lastMoveHighlightColorAtom);
  const opacity = useAtomValue(lastMoveHighlightOpacityAtom);
  // Typed text stays local until it is a complete colour, so a half-typed value never paints the board.
  const [draft, setDraft] = useState(color);

  useEffect(() => {
    setDraft(color);
  }, [color]);

  return (
    <Group gap="sm" wrap="nowrap">
      <HighlightPreview background={lastMoveHighlightBackground(color, opacity)} />
      <ColorInput
        aria-label={label}
        format="hex"
        value={draft}
        swatches={[...LAST_MOVE_HIGHLIGHT_PRESETS]}
        swatchesPerRow={LAST_MOVE_HIGHLIGHT_PRESETS.length}
        withEyeDropper={false}
        w="10rem"
        onChange={(next) => {
          setDraft(next);
          const parsed = parseLastMoveHighlightColor(next);
          if (parsed !== null && parsed !== color) setColor(parsed);
        }}
        onBlur={() => setDraft(color)}
      />
    </Group>
  );
}
