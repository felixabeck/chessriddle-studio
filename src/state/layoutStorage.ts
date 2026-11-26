import type { MosaicNode } from "react-mosaic-component";
import { atomWithStorage } from "jotai/utils";
import { z } from "zod";
import type { SyncStorage, SyncStringStorage } from "jotai/vanilla/utils/atomWithStorage";
import { warn } from "@/platform/native";
import {
    applyRetiredEngineCarryOver,
    type BaseAreaId,
    type BoardArrangement,
    boardArrangementSchema,
    computeCarryOverArrangement,
    defaultBoardArrangement,
    type LegacyLayoutValues,
    type RetiredEngineValues,
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
export const ANALYSIS_TABS_HIDDEN_KEY = "analysis-board-tabs-hidden";

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

const RETIRED_ENGINE_KEY_MAP = {
    detachedEngine: "detached-engine",
    detachedEnginePlacement: "detached-engine-placement",
    detachedEngineLines: "detached-engine-lines",
} as const;

/** Retired pinned-engine localStorage keys carried over into the arrangement and removed. */
export const RETIRED_ENGINE_KEYS = [
    RETIRED_ENGINE_KEY_MAP.detachedEngine,
    RETIRED_ENGINE_KEY_MAP.detachedEnginePlacement,
    RETIRED_ENGINE_KEY_MAP.detachedEngineLines,
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
    // throwing read, a failed carry-over write, a failed repair write of an invalid value, or a
    // failed obsolete-key removal for this session until a subsequent `setItem` or `removeItem`
    // clears it.
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

            let baseArrangement: BoardArrangement;
            let hasLegacyLayoutValues = false;

            if (storedValue !== null) {
                let repairFailed = false;
                baseArrangement = parseAndRepairStoredValue(
                    storage,
                    key,
                    storedValue,
                    boardArrangementSchema,
                    initialValue,
                    (fallback) => {
                        repairFailed = true;
                        sessionFallback.set(key, fallback);
                    },
                );
                if (repairFailed) {
                    return baseArrangement;
                }
            } else {
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
                baseArrangement = hasLegacyValues ? arrangement : initialValue;
                hasLegacyLayoutValues = hasLegacyValues;
            }

            let retiredEngine: RetiredEngineValues;
            try {
                retiredEngine = {
                    detachedEngine: storage.getItem(RETIRED_ENGINE_KEY_MAP.detachedEngine),
                    detachedEnginePlacement: storage.getItem(
                        RETIRED_ENGINE_KEY_MAP.detachedEnginePlacement,
                    ),
                    detachedEngineLines: storage.getItem(
                        RETIRED_ENGINE_KEY_MAP.detachedEngineLines,
                    ),
                };
            } catch (error) {
                warn(`Unable to read retired engine layout values for ${key}`);
                reportPreferenceStorageFailure("read", error);
                sessionFallback.set(key, baseArrangement);
                return baseArrangement;
            }

            const engineCarryOver = applyRetiredEngineCarryOver(baseArrangement, retiredEngine);
            const finalArrangement = engineCarryOver.arrangement;
            const needsWrite = hasLegacyLayoutValues || engineCarryOver.changed;

            if (needsWrite) {
                try {
                    storage.setItem(key, JSON.stringify(finalArrangement));
                } catch (error) {
                    reportPreferenceStorageFailure("save", error);
                    sessionFallback.set(key, finalArrangement);
                    return finalArrangement;
                }
            }

            const keysToRemove: string[] = [
                ...(hasLegacyLayoutValues ? LEGACY_LAYOUT_KEYS : []),
                ...(engineCarryOver.hasRetiredKeys ? RETIRED_ENGINE_KEYS : []),
            ];
            if (keysToRemove.length > 0) {
                const failedRemovals: string[] = [];
                let firstRemovalError: unknown;
                for (const obsoleteKey of keysToRemove) {
                    try {
                        storage.removeItem(obsoleteKey);
                    } catch (error) {
                        if (failedRemovals.length === 0) {
                            firstRemovalError = error;
                        }
                        failedRemovals.push(obsoleteKey);
                    }
                }
                if (failedRemovals.length > 0) {
                    warn(`Unable to remove legacy layout keys: ${failedRemovals.join(", ")}`);
                    reportPreferenceStorageFailure("save", firstRemovalError);
                    sessionFallback.set(key, finalArrangement);
                }
            }
            return finalArrangement;
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

/**
 * Whether the analysis board's tab strip is hidden from its arrangement. Kept apart from the
 * arrangement so the strip keeps its place and size in the stored tree while hidden.
 */
export const analysisTabsHiddenAtom = atomWithStorage<boolean>(
    ANALYSIS_TABS_HIDDEN_KEY,
    false,
    createZodStorage(z.boolean(), localStorage),
    { getOnInit: true },
);
