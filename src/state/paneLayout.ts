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

export function rootFontPx(computedFontSize: string, fontScale: number) {
    return Number.parseFloat(computedFontSize) || (16 * fontScale) / 100;
}
