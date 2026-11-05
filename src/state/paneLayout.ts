// Mosaic's row divider extends three pixels into each tile.
export const PANE_FLOOR_REM = 20;
export const MOSAIC_DIVIDER_ALLOWANCE_PX = 6;

export function needsTwoPaneStack(width: number, rootFont: number) {
    return width < 2 * PANE_FLOOR_REM * rootFont + MOSAIC_DIVIDER_ALLOWANCE_PX;
}

export function rootFontPx(computedFontSize: string, fontScale: number) {
    return Number.parseFloat(computedFontSize) || (16 * fontScale) / 100;
}
