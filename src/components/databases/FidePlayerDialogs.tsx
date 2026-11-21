import { COLORS, type Color } from "chessops";
import FideInfo from "./FideInfo";

/**
 * The FIDE cards for a game's two players. At most one is open, so the caller keeps a single
 * `Color | null`. Each colour keeps its own dialog, so a closing card keeps its player's name
 * through the close transition.
 */
export function FidePlayerDialogs({
  openColor,
  setOpenColor,
  names,
}: {
  openColor: Color | null;
  setOpenColor: (color: Color | null) => void;
  names: Record<Color, string>;
}) {
  return COLORS.map((color) => (
    <FideInfo
      key={color}
      opened={openColor === color}
      setOpened={(opened) => setOpenColor(opened ? color : null)}
      name={names[color]}
    />
  ));
}
