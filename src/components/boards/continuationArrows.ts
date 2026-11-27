import type { DrawBrushes, DrawShape } from "@lichess-org/chessground/draw";
import { defaults } from "@lichess-org/chessground/state";
import { makeSquare, type NormalMove } from "chessops";
import type { Chess } from "chessops/chess";
import { chessgroundMove } from "chessops/compat";
import { parseSan } from "chessops/san";
import type { VariationChoice } from "@/state/store/variationChooser";
import type { TreeNode } from "@/utils/treeReducer";
import { pgnDrawingBrushes } from "@/utils/drawings";

export const REVIEW_PLAYED_BRUSH = "reviewPlayed";
export const REVIEW_BETTER_BRUSH = "reviewBetter";

export const continuationBrushes: DrawBrushes = {
    ...defaults().drawable.brushes,
    ...pgnDrawingBrushes,
    variation: { key: "v", color: "#9b59b6", opacity: 0.8, lineWidth: 10 },
    continuationSelected: { key: "cs", color: "#9b59b6", opacity: 1, lineWidth: 11 },
    continuationOther: { key: "co", color: "#9b59b6", opacity: 0.25, lineWidth: 7.5 },
    [REVIEW_PLAYED_BRUSH]: { key: "rp", color: "#d9480f", opacity: 0.85, lineWidth: 9 },
    [REVIEW_BETTER_BRUSH]: { key: "rb", color: "#0ca678", opacity: 0.95, lineWidth: 11 },
};

export function reviewFocusArrows(
    pos: Chess,
    playedSan: string | null,
    betterSan: string | null,
): DrawShape[] {
    const shapes: DrawShape[] = [];
    const toShape = (san: string | null, brush: string): DrawShape | null => {
        if (!san) return null;
        const move = parseSan(pos, san);
        if (!move || !("from" in move)) return null;
        const [orig, dest] = chessgroundMove(move);
        return { orig, dest, brush };
    };
    const played = toShape(playedSan, REVIEW_PLAYED_BRUSH);
    const better = toShape(betterSan, REVIEW_BETTER_BRUSH);
    if (played && (!better || played.orig !== better.orig || played.dest !== better.dest)) {
        shapes.push(played);
    }
    if (better) {
        shapes.push(better);
    }
    return shapes;
}

export function childMoveArrow(
    child: TreeNode,
    brush: string,
    lineWidth?: number,
): DrawShape | null {
    if (!child.move) return null;
    const move = child.move as NormalMove;
    return {
        orig: makeSquare(move.from),
        dest: makeSquare(move.to),
        brush,
        ...(lineWidth === undefined ? {} : { modifiers: { lineWidth } }),
    };
}

export function chooserArrows(choice: VariationChoice): DrawShape[] {
    return choice
        ? choice.children.flatMap((child, index) => {
              const arrow = childMoveArrow(
                  child,
                  index === choice.selected ? "continuationSelected" : "continuationOther",
              );
              return arrow ? [arrow] : [];
          })
        : [];
}
