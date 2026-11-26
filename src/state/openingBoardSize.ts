import { atomWithStorage } from "jotai/utils";
import { createPositiveRemStorage } from "./remPreference";

export const OPENING_BOARD_SIZE_KEY = "opening-board-size";
export const DEFAULT_OPENING_BOARD_SIZE_REM = 20;
export const MIN_OPENING_BOARD_SIZE_REM = 12;
/**
 * Width the moves table keeps beside the board when both share a row: below it the column
 * headers collide (measured in the opponent card's e2e header-overlap check).
 */
export const OPENING_TABLE_MIN_WIDTH_REM = 24;
/** The `.body` grid gap (`--mantine-spacing-sm`) between board and table. */
const OPENING_BODY_GAP_REM = 0.75;

/** Remembered edge length of the board on the player cards' Openings tab, in rem. */
export const openingBoardSizeAtom = atomWithStorage<number>(
    OPENING_BOARD_SIZE_KEY,
    DEFAULT_OPENING_BOARD_SIZE_REM,
    createPositiveRemStorage(localStorage),
    { getOnInit: true },
);

/**
 * Largest board for a body `bodyWidthRem` wide: beside the table it leaves the table its minimum
 * width, stacked above the table it may use the whole width. An unmeasured body imposes no cap.
 */
export function maxOpeningBoardSizeRem(bodyWidthRem: number, besideTable: boolean): number {
    if (!(bodyWidthRem > 0)) return Number.POSITIVE_INFINITY;
    const available = besideTable
        ? bodyWidthRem - OPENING_TABLE_MIN_WIDTH_REM - OPENING_BODY_GAP_REM
        : bodyWidthRem;
    return Math.max(MIN_OPENING_BOARD_SIZE_REM, available);
}

export function clampOpeningBoardSizeRem(sizeRem: number, maxRem: number): number {
    return Math.min(maxRem, Math.max(MIN_OPENING_BOARD_SIZE_REM, sizeRem));
}
