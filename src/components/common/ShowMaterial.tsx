import { Group, Text } from "@mantine/core";
import { type Color, opposite } from "chessops";
import PieceComponent from "@/components/common/Piece";
import type { MaterialDisplay } from "@/state/atoms";
import { getMaterialDiff, MATERIAL_ROLES } from "@/utils/chess";
import classes from "@/components/common/ShowMaterial.module.css";

const PIECE_SIZE = "1.5rem";
/** Repeated pieces of one kind overlap, so a row of pawns stays compact. */
const PIECE_OVERLAP = "-0.7rem";

/**
 * The material balance in the board's own piece set.
 *
 * `diff` shows the pieces a side has more of, in that side's colour. `all` shows every piece a
 * side has captured, in the captured pieces' colour. The leading side gets the point lead.
 * `none` renders nothing.
 * Without `color`, both sides render in one group, White first.
 */
export default function ShowMaterial({
  fen,
  color,
  mode = "diff",
}: {
  fen: string;
  color?: Color;
  mode?: MaterialDisplay;
}) {
  if (mode === "none") return null;
  const materialDiff = getMaterialDiff(fen);
  if (!materialDiff) return null;

  const sides: Color[] = color ? [color] : ["white", "black"];
  const groups = sides.flatMap((side) => {
    const sign = side === "white" ? 1 : -1;
    const counts =
      mode === "all"
        ? materialDiff[side === "white" ? "whiteCaptured" : "blackCaptured"]
        : materialDiff.pieces;
    const pieceColor = mode === "all" ? opposite(side) : side;
    const lead = sign * materialDiff.diff;
    const kinds = MATERIAL_ROLES.map(({ key, role }) => ({
      role,
      count: mode === "all" ? counts[key] : Math.max(0, sign * counts[key]),
    })).filter(({ count }) => count > 0);
    if (kinds.length === 0 && lead <= 0) return [];
    return [
      <Group key={side} gap={6} wrap="nowrap" data-material-side={side}>
        {kinds.map(({ role, count }) => (
          <Group key={role} gap={0} wrap="nowrap">
            {Array.from({ length: count }, (_, index) => (
              <div
                key={index}
                className={classes.piece}
                data-material-piece={`${pieceColor}-${role}`}
                style={{ marginLeft: index === 0 ? 0 : PIECE_OVERLAP }}
              >
                <PieceComponent piece={{ color: pieceColor, role }} size={PIECE_SIZE} />
              </div>
            ))}
          </Group>
        ))}
        {lead > 0 && (
          <Text fz="sm" lh={1}>
            +{lead}
          </Text>
        )}
      </Group>,
    ];
  });

  if (groups.length === 0) return null;
  return (
    <Group gap="md" wrap="nowrap" data-material>
      {groups}
    </Group>
  );
}
