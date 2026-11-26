import type { MosaicNode } from "react-mosaic-component";
import { atomWithStorage } from "jotai/utils";
import type { SyncStorage, SyncStringStorage } from "jotai/vanilla/utils/atomWithStorage";
import { warn } from "@/platform/native";
import {
    type BaseAreaId,
    type BoardArrangement,
    boardArrangementSchema,
    computeCarryOverArrangement,
    defaultBoardArrangement,
    type LegacyLayoutValues,
    windowsStateSchema,
} from "./boardArrangement";
import {
    createZodStorage,
    parseAndRepairStoredValue,
    reportPreferenceStorageFailure,
} from "./utils";

export type ViewId = BaseAreaId;

export interface WindowsState {
    currentNode: MosaicNode<ViewId> | null;
}

export const WINDOWS_STATE_KEY = "windowsState";
export const ANALYSIS_BOARD_LAYOUT_KEY = "analysis-board-layout";

const LEGACY_LAYOUT_KEY_MAP = {
    panelsBesideNotation: "panels-beside-notation",
    boardBesideSplits: "board-beside-splits",
    detachedExplorer: "detached-explorer",
    detachedExplorerPlacement: "detached-explorer-placement",
    detachedExplorerHeights: "detached-explorer-heights",
} as const;

/** Legacy localStorage keys retired by the analysis board arrangement and removed after carry-over. */
export const LEGACY_LAYOUT_KEYS = [
    LEGACY_LAYOUT_KEY_MAP.panelsBesideNotation,
    LEGACY_LAYOUT_KEY_MAP.boardBesideSplits,
    LEGACY_LAYOUT_KEY_MAP.detachedExplorer,
    LEGACY_LAYOUT_KEY_MAP.detachedExplorerPlacement,
    LEGACY_LAYOUT_KEY_MAP.detachedExplorerHeights,
] as const;

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

export const windowsStateAtom = atomWithStorage<WindowsState>(
    WINDOWS_STATE_KEY,
    defaultWindowsState(),
    createWindowsStateStorage(localStorage),
    { getOnInit: true },
);

export function createBoardArrangementStorage(
    storage: SyncStringStorage = localStorage,
): SyncStorage<BoardArrangement> {
    // Jotai with `getOnInit` calls `getItem` at atom creation and again at first mount; memoize a
    // throwing read, a failed carry-over write, or a failed repair write of an invalid value for
    // this session until a subsequent `setItem` or `removeItem` clears it.
    const sessionFallback = new Map<string, BoardArrangement>();

    return {
        getItem(key, initialValue) {
            const memoized = sessionFallback.get(key);
            if (memoized !== undefined) {
                return memoized;
            }

            let storedValue: string | null;
            try {
                storedValue = storage.getItem(key);
            } catch (error) {
                warn(`Unable to read persisted value for ${key}`);
                reportPreferenceStorageFailure("read", error);
                sessionFallback.set(key, initialValue);
                return initialValue;
            }

            if (storedValue !== null) {
                return parseAndRepairStoredValue(
                    storage,
                    key,
                    storedValue,
                    boardArrangementSchema,
                    initialValue,
                    (fallback) => sessionFallback.set(key, fallback),
                );
            }

            let legacy: LegacyLayoutValues;
            try {
                legacy = {
                    windowsState: storage.getItem(WINDOWS_STATE_KEY),
                    panelsBesideNotation: storage.getItem(
                        LEGACY_LAYOUT_KEY_MAP.panelsBesideNotation,
                    ),
                    boardBesideSplits: storage.getItem(LEGACY_LAYOUT_KEY_MAP.boardBesideSplits),
                    detachedExplorer: storage.getItem(LEGACY_LAYOUT_KEY_MAP.detachedExplorer),
                    detachedExplorerPlacement: storage.getItem(
                        LEGACY_LAYOUT_KEY_MAP.detachedExplorerPlacement,
                    ),
                    detachedExplorerHeights: storage.getItem(
                        LEGACY_LAYOUT_KEY_MAP.detachedExplorerHeights,
                    ),
                };
            } catch (error) {
                warn(`Unable to read legacy layout values for ${key}`);
                reportPreferenceStorageFailure("read", error);
                sessionFallback.set(key, initialValue);
                return initialValue;
            }

            const { arrangement, hasLegacyValues } = computeCarryOverArrangement(legacy);
            if (!hasLegacyValues) {
                return initialValue;
            }

            try {
                storage.setItem(key, JSON.stringify(arrangement));
            } catch (error) {
                reportPreferenceStorageFailure("save", error);
                sessionFallback.set(key, arrangement);
                return arrangement;
            }

            const failedRemovals: string[] = [];
            let firstRemovalError: unknown;
            for (const legacyKey of LEGACY_LAYOUT_KEYS) {
                try {
                    storage.removeItem(legacyKey);
                } catch (error) {
                    if (failedRemovals.length === 0) {
                        firstRemovalError = error;
                    }
                    failedRemovals.push(legacyKey);
                }
            }
            if (failedRemovals.length > 0) {
                warn(`Unable to remove legacy layout keys: ${failedRemovals.join(", ")}`);
                reportPreferenceStorageFailure("save", firstRemovalError);
            }
            return arrangement;
        },
        setItem(key, value) {
            try {
                storage.setItem(key, JSON.stringify(value));
                sessionFallback.delete(key);
            } catch (error) {
                reportPreferenceStorageFailure("save", error);
            }
        },
        removeItem(key) {
            sessionFallback.delete(key);
            try {
                storage.removeItem(key);
            } catch (error) {
                reportPreferenceStorageFailure("save", error);
            }
        },
    };
}

/**
 * The app-wide arrangement of areas on the analysis board. Reads on creation (`getOnInit`) so
 * legacy layout values are carried over and cleaned up before any write (including Reset).
 */
export const boardArrangementAtom = atomWithStorage<BoardArrangement>(
    ANALYSIS_BOARD_LAYOUT_KEY,
    defaultBoardArrangement(),
    createBoardArrangementStorage(localStorage),
    { getOnInit: true },
);
