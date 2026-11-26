import { atomWithStorage } from "jotai/utils";
import { createPositiveRemStorage } from "./remPreference";

export const ASSISTANT_DOCK_WIDTH_KEY = "assistant-dock-width";
export const DEFAULT_ASSISTANT_DOCK_WIDTH_REM = 24;
export const MIN_ASSISTANT_DOCK_WIDTH_REM = 20;
const MAX_ASSISTANT_DOCK_VIEWPORT_FRACTION = 0.42;

/** Remembered width of the docked Assistant panel in rem. */
export const assistantDockWidthAtom = atomWithStorage<number>(
    ASSISTANT_DOCK_WIDTH_KEY,
    DEFAULT_ASSISTANT_DOCK_WIDTH_REM,
    createPositiveRemStorage(localStorage),
    { getOnInit: true },
);

export function maxAssistantDockWidthRem(viewportWidthPx: number, rootFont: number): number {
    if (viewportWidthPx <= 0 || rootFont <= 0) return DEFAULT_ASSISTANT_DOCK_WIDTH_REM;
    return Math.max(
        MIN_ASSISTANT_DOCK_WIDTH_REM,
        (viewportWidthPx * MAX_ASSISTANT_DOCK_VIEWPORT_FRACTION) / rootFont,
    );
}

export function clampAssistantDockWidthRem(
    widthRem: number,
    viewportWidthPx: number,
    rootFont: number,
): number {
    const maxRem = maxAssistantDockWidthRem(viewportWidthPx, rootFont);
    return Math.min(maxRem, Math.max(MIN_ASSISTANT_DOCK_WIDTH_REM, widthRem));
}
