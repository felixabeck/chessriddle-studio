import { createContext } from "react";
import type { MosaicNode } from "react-mosaic-component";

// Mosaic's row divider extends three pixels into each tile.
export const PANE_FLOOR_REM = 20;
export const MOSAIC_DIVIDER_ALLOWANCE_PX = 6;

/** The least width that gives each of `panes` side-by-side panes its floor. */
function paneFloorWidth(panes: number, rootFont: number) {
    return panes * PANE_FLOOR_REM * rootFont + (panes - 1) * MOSAIC_DIVIDER_ALLOWANCE_PX;
}

/** How many side-by-side panes an arrangement needs across its widest row. */
export function widthInPanes(node: MosaicNode<string>): number {
    if (typeof node === "string") return 1;
    const first = widthInPanes(node.first);
    const second = widthInPanes(node.second);
    return node.direction === "row" ? first + second : Math.max(first, second);
}

/** Whether an arrangement fits inside `width` pixels at `rootFont` pixels per rem. */
export function arrangementFitsWidth(
    node: MosaicNode<string>,
    width: number,
    rootFont: number,
): boolean {
    return width >= paneFloorWidth(widthInPanes(node), rootFont);
}

export function needsTwoPaneStack(width: number, rootFont: number) {
    return width < paneFloorWidth(2, rootFont);
}

/** Whether board, notation and panels each get their floor side by side. */
export function fitsThreePanes(width: number, rootFont: number) {
    return width >= paneFloorWidth(3, rootFont);
}

/** What one side of a pane gives up to a divider next to it. */
const DIVIDER_SIDE_PX = MOSAIC_DIVIDER_ALLOWANCE_PX / 2;

function clampPercentage(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value));
}

/**
 * The beside arrangement's divider positions in percent: `board` across the whole layout,
 * `notation` across the right side. Each is the wanted position (the middle when none is given),
 * moved only as far as the board, the notation and the panels need to keep their floor. Meant for
 * widths where `fitsThreePanes` holds.
 */
export function besideSplitPositions(
    width: number,
    rootFont: number,
    wanted: { board?: number; notation?: number },
) {
    const floor = PANE_FLOOR_REM * rootFont;
    // The least room each pane's share must hold: its floor and one divider side per divider it
    // touches. The board and the panels touch one divider, the notation between them both.
    const boardRoom = floor + DIVIDER_SIDE_PX;
    const notationRoom = floor + 2 * DIVIDER_SIDE_PX;
    const panelsRoom = floor + DIVIDER_SIDE_PX;
    const board = clampPercentage(
        wanted.board ?? 50,
        (boardRoom / width) * 100,
        100 - ((notationRoom + panelsRoom) / width) * 100,
    );
    const rightSide = width * (1 - board / 100);
    const notation = clampPercentage(
        wanted.notation ?? 50,
        (notationRoom / rightSide) * 100,
        100 - (panelsRoom / rightSide) * 100,
    );
    return { board, notation };
}

/**
 * How the board tab lays out its tiles: `stacked` in a narrow window, `mosaic` with the panels
 * above the notation, `beside` with the panels to the right of the notation.
 */
export type BoardLayoutMode = "stacked" | "mosaic" | "beside";

export const BoardLayoutModeContext = createContext<BoardLayoutMode>("mosaic");

export function rootFontPx(computedFontSize: string, fontScale: number) {
    return Number.parseFloat(computedFontSize) || (16 * fontScale) / 100;
}
