import type { MosaicNode } from "react-mosaic-component";
import { atomWithStorage } from "jotai/utils";
import type { SyncStorage, SyncStringStorage } from "jotai/vanilla/utils/atomWithStorage";
import { z } from "zod";
import { type BaseAreaId, besideSplitsSchema, windowsStateSchema } from "./boardArrangement";
import { createZodStorage } from "./utils";

export type ViewId = BaseAreaId;

export interface WindowsState {
    currentNode: MosaicNode<ViewId> | null;
}

export function defaultWindowsState(): WindowsState {
    return {
        currentNode: {
            direction: "row",
            first: "left",
            second: {
                direction: "column",
                first: "topRight",
                second: "bottomRight",
            },
        },
    };
}

export function createWindowsStateStorage(
    storage: SyncStringStorage = localStorage,
): SyncStorage<WindowsState> {
    return createZodStorage(windowsStateSchema, storage);
}

/**
 * Whether the analysis board shows its panels to the right of the notation instead of above it.
 * The layout applies it only while the window is wide enough; the choice itself is kept.
 */
export const panelsBesideNotationAtom = atomWithStorage<boolean>(
    "panels-beside-notation",
    false,
    createZodStorage(z.boolean(), localStorage),
    { getOnInit: true },
);

/**
 * The divider positions of the beside arrangement: `board` between the board and the right side,
 * `notation` between the notation and the panels. Kept apart from `windowsState`, so each
 * arrangement returns to its own sizes.
 */
export interface BesideSplits {
    board?: number;
    notation?: number;
}

export const besideSplitsAtom = atomWithStorage<BesideSplits>(
    "board-beside-splits",
    {},
    createZodStorage(besideSplitsSchema, localStorage),
    { getOnInit: true },
);
