import type { Key } from "@lichess-org/chessground/types";
import { Box } from "@mantine/core";
import { useAtomValue } from "jotai";
import { Chessground } from "@/chessground/Chessground";
import { moveHighlightAtom, showCoordinatesAtom, showDestsAtom } from "@/state/atoms";
import classes from "./SettingsPage.module.css";

/** The opening position after 1.Nf3: the last move and a selectable pawn lie in ranks 1–3. */
const PREVIEW_FEN = "rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1";
/**
 * Chessground reads only the placement from the FEN. White is the side to move here, so the
 * selected white pawn shows its own destinations rather than premove targets on c3 and e3.
 */
const PREVIEW_TURN = "white";
const PREVIEW_LAST_MOVE: Key[] = ["g1", "f3"];
const PREVIEW_SELECTED: Key = "d2";
const PREVIEW_DESTS = new Map<Key, Key[]>([[PREVIEW_SELECTED, ["d3", "d4"]]]);

/**
 * White's first three ranks on the real board, painted with the current Look and Highlights
 * settings, so a change shows on the Settings page itself. Purely decorative: it takes no input.
 */
export default function BoardSettingsPreview() {
  const showCoordinates = useAtomValue(showCoordinatesAtom);
  const showDests = useAtomValue(showDestsAtom);
  const moveHighlight = useAtomValue(moveHighlightAtom);

  return (
    <Box
      className={classes.boardPreview}
      data-testid="board-settings-preview"
      data-deliberate-crop
      aria-hidden
    >
      <Chessground
        fen={PREVIEW_FEN}
        orientation="white"
        turnColor={PREVIEW_TURN}
        viewOnly
        coordinates={showCoordinates !== "no"}
        coordinatesOnSquares={showCoordinates === "all"}
        lastMove={moveHighlight ? PREVIEW_LAST_MOVE : undefined}
        selected={PREVIEW_SELECTED}
        movable={{ color: PREVIEW_TURN, dests: PREVIEW_DESTS, showDests }}
        premovable={{ enabled: false }}
        drawable={{ enabled: false, visible: false }}
      />
    </Box>
  );
}
