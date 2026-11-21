import { Chessground } from "@lichess-org/chessground";
import type { DrawShape } from "@lichess-org/chessground/draw";
import { expect, test } from "vitest";
import { DRAWING_MODIFIERS, makePgnDrawings, pgnDrawingBrushes } from "@/utils/drawings";
import { SQUARE, installPatchedChessgroundHarness } from "@/tests/patchedChessground";

// Drives the real, patched chessground (patches/@lichess-org__chessground@10.1.1.patch).
const flushFrame = installPatchedChessgroundHarness();

/** Center of a square from White's point of view. */
function point(file: number, rank: number) {
    return { clientX: file * SQUARE + SQUARE / 2, clientY: (8 - rank) * SQUARE + SQUARE / 2 };
}

function drawE2E4(modifiers: MouseEventInit): DrawShape[] {
    const element = document.createElement("div");
    document.body.append(element);
    let shapes: DrawShape[] = [];
    const api = Chessground(element, {
        drawable: { brushes: pgnDrawingBrushes, onChange: (next) => (shapes = next) },
    });
    const board = element.querySelector("cg-board");
    if (!board) throw new Error("chessground rendered no board");
    board.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 2, ...point(4, 2), ...modifiers }),
    );
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, ...point(4, 4) }));
    flushFrame();
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 2 }));
    api.destroy();
    return shapes;
}

const MODIFIER_EVENTS = { shift: "shiftKey", ctrl: "ctrlKey", alt: "altKey" } as const;

test.each(DRAWING_MODIFIERS)(
    "right-click with $modifiers draws $color and exports its PGN code",
    ({ color, modifiers }) => {
        const init = Object.fromEntries(modifiers.map((key) => [MODIFIER_EVENTS[key], true]));
        const shapes = drawE2E4(init);
        expect(shapes).toEqual([{ orig: "e2", dest: "e4", brush: color }]);
        expect(makePgnDrawings(shapes)).toMatch(/^\[%cal [GRBYOC]e2e4\]$/);
    },
);

test("Cmd counts as Ctrl and Ctrl takes precedence over Shift", () => {
    expect(drawE2E4({ metaKey: true })[0]?.brush).toBe("orange");
    expect(drawE2E4({ metaKey: true, altKey: true })[0]?.brush).toBe("cyan");
    expect(drawE2E4({ ctrlKey: true, shiftKey: true })[0]?.brush).toBe("orange");
});

test("every drawable colour has a brush, and yellow stays distinct from orange", () => {
    for (const { color } of DRAWING_MODIFIERS) expect(pgnDrawingBrushes[color]).toBeDefined();
    expect(pgnDrawingBrushes.yellow.color).not.toBe(pgnDrawingBrushes.orange.color);
    expect(pgnDrawingBrushes.yellow.color).toBe("#e8c500");
});
