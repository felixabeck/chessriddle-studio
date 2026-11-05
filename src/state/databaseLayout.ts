import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { createContext } from "react";
import { z } from "zod";
import { createZodStorage } from "./utils";
import { needsTwoPaneStack, PANE_FLOOR_REM, MOSAIC_DIVIDER_ALLOWANCE_PX } from "./paneLayout";

export const DATABASE_SPLIT_KEY = "database-table-percentage";
export const DATABASE_SPLIT_STEP_PERCENT = 5;
const DATABASE_SPLIT_MIN_PERCENT = 20;
const PREVIEW_NOTATION_WIDTH_REM = 12;
const PREVIEW_NOTATION_HEIGHT_REM = 8;
const PREVIEW_COMPACT_NOTATION_HEIGHT_REM = 12;
const PREVIEW_CONTROLS_WRAP_WIDTH_REM = 14;
const PREVIEW_CONTROLS_ROW_HEIGHT_REM = 3;
const PREVIEW_MIN_BESIDE_BOARD_REM = 8;

export const databaseSplitSchema = z
    .number()
    .finite()
    .min(DATABASE_SPLIT_MIN_PERCENT)
    .max(100 - DATABASE_SPLIT_MIN_PERCENT);

export function createDatabaseSplitAtoms(storage: Storage) {
    const preferred = atomWithStorage(
        DATABASE_SPLIT_KEY,
        50,
        createZodStorage(databaseSplitSchema, storage),
        { getOnInit: true },
    );
    const transient = atom<number | null>(null);
    const displayed = atom((get) => get(transient) ?? get(preferred));
    const commit = atom(null, (_get, set, percentage: number) => {
        const value = databaseSplitSchema.parse(percentage);
        set(transient, null);
        set(preferred, value);
    });
    return { preferred, transient, displayed, commit };
}

export const databaseSplitAtoms = createDatabaseSplitAtoms(localStorage);

// Mosaic's row divider extends three pixels into each tile.
export function databasePaneGeometry(width: number, rootFont: number) {
    const floor = PANE_FLOOR_REM * rootFont;
    const compact = needsTwoPaneStack(width, rootFont);
    const minimum = compact
        ? 50
        : Math.max(
              DATABASE_SPLIT_MIN_PERCENT,
              ((floor + MOSAIC_DIVIDER_ALLOWANCE_PX / 2) / width) * 100,
          );
    return { compact, minimum };
}

export function clampDatabasePercentage(value: number, minimum: number) {
    return Math.max(minimum, Math.min(100 - minimum, value));
}

export const DatabaseLayoutContext = createContext({
    compact: false,
    minimum: DATABASE_SPLIT_MIN_PERCENT,
    rootFont: 16,
});

export function fitPreviewSquare(width: number, height: number) {
    return Math.max(0, Math.min(width, height));
}

export function adaptivePreviewGeometry(
    width: number,
    height: number,
    rootFont: number,
    compact: boolean,
) {
    const gap = rootFont;
    const notationWidth = PREVIEW_NOTATION_WIDTH_REM * rootFont;
    const notationHeight = PREVIEW_NOTATION_HEIGHT_REM * rootFont;
    // Four large actions and their gaps can wrap to two rows in a narrow frame.
    const controlsHeight =
        (width < PREVIEW_CONTROLS_WRAP_WIDTH_REM * rootFont ? 2 : 1) *
        PREVIEW_CONTROLS_ROW_HEIGHT_REM *
        rootFont;
    const beside = fitPreviewSquare(width - notationWidth - gap, height);
    const below = fitPreviewSquare(width, height - notationHeight - controlsHeight - 2 * gap);
    const stacked =
        compact ||
        width < notationWidth + PREVIEW_MIN_BESIDE_BOARD_REM * rootFont ||
        below > beside;
    return {
        stacked,
        boardSide: compact ? width : stacked ? below : beside,
        notationHeight: compact ? PREVIEW_COMPACT_NOTATION_HEIGHT_REM * rootFont : notationHeight,
    };
}
