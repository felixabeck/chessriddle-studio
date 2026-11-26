import type { MosaicNode } from "react-mosaic-component";
import {
    atom,
    type Atom,
    type getDefaultStore,
    type SetStateAction,
    type WritableAtom,
} from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { SyncStorage, SyncStringStorage } from "jotai/vanilla/utils/atomWithStorage";
import { warn } from "@/platform/native";
import {
    applyRetiredEngineCarryOver,
    type BaseAreaId,
    type BoardArrangement,
    computeCarryOverArrangement,
    type EnginePresence,
    isRecord,
    isValidBoardArrangement,
    type LegacyLayoutValues,
    resolveArrangementEngines,
    type RetiredEngineValues,
    windowsStateSchema,
} from "./boardArrangement";
import {
    BOARD_LAYOUT_KINDS,
    type BoardLayout,
    type BoardLayoutKind,
    cloneBoardLayout,
    defaultKindLayouts,
    defaultLayoutForKind,
    getLayoutPreset,
    LAYOUT_PRESETS,
    type LayoutPreset,
    PRESET_IDS,
} from "./layoutPresets";
import { createZodStorage, reportPreferenceStorageFailure } from "./utils";

export type ViewId = BaseAreaId;

export interface WindowsState {
    currentNode: MosaicNode<ViewId> | null;
}

export const WINDOWS_STATE_KEY = "windowsState";
/** Versioned localStorage key owning per-kind live analysis layouts and saved layouts. */
export const ANALYSIS_BOARD_LAYOUTS_KEY = "analysis-board-layouts";
export const BOARD_LAYOUTS_VERSION = 1 as const;

/** Former single-layout localStorage keys carried over once and removed after write. */
export const ANALYSIS_BOARD_LAYOUT_KEY = "analysis-board-layout";
export const ANALYSIS_TABS_HIDDEN_KEY = "analysis-board-tabs-hidden";

export const MAX_SAVED_LAYOUTS = 20;
export const LAYOUT_NAME_MIN_LENGTH = 1;
export const LAYOUT_NAME_MAX_LENGTH = 40;

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

export interface SavedBoardLayout extends BoardLayout {
    id: string;
    name: string;
}

export interface BoardLayoutsState {
    version: typeof BOARD_LAYOUTS_VERSION;
    kinds: Record<BoardLayoutKind, BoardLayout>;
    saved: SavedBoardLayout[];
}

export type LayoutListEntry =
    | { kind: "preset"; preset: LayoutPreset }
    | { kind: "saved"; saved: SavedBoardLayout };

export type LayoutMutationError =
    | "empty-name"
    | "name-too-long"
    | "duplicate-name"
    | "limit-reached"
    | "not-found"
    | "storage";

export type SavedLayoutMutationResult =
    | { ok: true; layout: SavedBoardLayout }
    | { ok: false; reason: LayoutMutationError; error?: unknown };

export type DeleteLayoutResult =
    | { ok: true }
    | { ok: false; reason: "not-found" | "storage"; error?: unknown };

export type BoardLayoutsStore = ReturnType<typeof getDefaultStore>;

export interface BoardLayoutsStorage extends SyncStorage<BoardLayoutsState> {
    /**
     * Persists `value` fail-closed before updating in-memory state. When it succeeds, the next
     * matching `setItem` from Jotai skips a duplicate write.
     */
    trySetItem(key: string, value: BoardLayoutsState): { ok: true } | { ok: false; error: unknown };
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

export const windowsStateAtom = atomWithStorage<WindowsState>(
    WINDOWS_STATE_KEY,
    defaultWindowsState(),
    createWindowsStateStorage(localStorage),
    { getOnInit: true },
);

export function defaultBoardLayoutsState(): BoardLayoutsState {
    return {
        version: BOARD_LAYOUTS_VERSION,
        kinds: defaultKindLayouts(),
        saved: [],
    };
}

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(["version", "kinds", "saved"]);
const LAYOUT_KEYS: ReadonlySet<string> = new Set(["arrangement", "tabsHidden"]);
const SAVED_LAYOUT_KEYS: ReadonlySet<string> = new Set(["id", "name", "arrangement", "tabsHidden"]);
const KIND_KEY_SET: ReadonlySet<string> = new Set(BOARD_LAYOUT_KINDS);

function validateLayoutName(
    rawName: string,
): { ok: true; name: string } | { ok: false; reason: "empty-name" | "name-too-long" } {
    const name = rawName.trim();
    if (name.length < LAYOUT_NAME_MIN_LENGTH) return { ok: false, reason: "empty-name" };
    if (name.length > LAYOUT_NAME_MAX_LENGTH) return { ok: false, reason: "name-too-long" };
    return { ok: true, name };
}

/**
 * Validates and repairs a parsed persisted `BoardLayoutsState` per entry so one corrupt kind or
 * saved entry never discards valid sibling entries.
 */
export function validateAndRepairBoardLayouts(raw: unknown): {
    state: BoardLayoutsState;
    repaired: boolean;
} {
    if (!isRecord(raw) || raw.version !== BOARD_LAYOUTS_VERSION) {
        return { state: defaultBoardLayoutsState(), repaired: true };
    }

    let repaired = Object.keys(raw).some((key) => !TOP_LEVEL_KEYS.has(key));

    const kinds = {} as Record<BoardLayoutKind, BoardLayout>;
    if (!isRecord(raw.kinds)) {
        repaired = true;
        for (const kind of BOARD_LAYOUT_KINDS) {
            kinds[kind] = defaultLayoutForKind(kind);
        }
    } else {
        if (Object.keys(raw.kinds).some((key) => !KIND_KEY_SET.has(key))) {
            repaired = true;
        }
        for (const kind of BOARD_LAYOUT_KINDS) {
            const entry = raw.kinds[kind];
            if (
                isRecord(entry) &&
                isValidBoardArrangement(entry.arrangement) &&
                typeof entry.tabsHidden === "boolean"
            ) {
                if (Object.keys(entry).some((key) => !LAYOUT_KEYS.has(key))) {
                    repaired = true;
                }
                kinds[kind] = {
                    arrangement: entry.arrangement,
                    tabsHidden: entry.tabsHidden,
                };
            } else {
                repaired = true;
                kinds[kind] = defaultLayoutForKind(kind);
            }
        }
    }

    const saved: SavedBoardLayout[] = [];
    if (!Array.isArray(raw.saved)) {
        repaired = true;
    } else {
        const seenIds = new Set<string>(PRESET_IDS);
        const seenNames = new Set<string>();
        for (const entry of raw.saved) {
            if (saved.length >= MAX_SAVED_LAYOUTS) {
                repaired = true;
                break;
            }
            if (!isRecord(entry)) {
                repaired = true;
                continue;
            }
            const id = entry.id;
            if (typeof id !== "string" || id.trim().length === 0 || seenIds.has(id)) {
                repaired = true;
                continue;
            }
            const rawName = entry.name;
            if (typeof rawName !== "string") {
                repaired = true;
                continue;
            }
            const validatedName = validateLayoutName(rawName);
            if (!validatedName.ok) {
                repaired = true;
                continue;
            }
            const trimmedName = validatedName.name;
            const normalizedName = trimmedName.toLowerCase();
            if (seenNames.has(normalizedName)) {
                repaired = true;
                continue;
            }
            if (
                !isValidBoardArrangement(entry.arrangement) ||
                typeof entry.tabsHidden !== "boolean"
            ) {
                repaired = true;
                continue;
            }
            if (
                rawName !== trimmedName ||
                Object.keys(entry).some((key) => !SAVED_LAYOUT_KEYS.has(key))
            ) {
                repaired = true;
            }
            seenIds.add(id);
            seenNames.add(normalizedName);
            saved.push({
                id,
                name: trimmedName,
                arrangement: entry.arrangement,
                tabsHidden: entry.tabsHidden,
            });
        }
    }

    return {
        state: {
            version: BOARD_LAYOUTS_VERSION,
            kinds,
            saved,
        },
        repaired,
    };
}

function parseStoredArrangement(raw: string | null): BoardArrangement | undefined {
    if (raw === null) return undefined;
    try {
        const parsed: unknown = JSON.parse(raw);
        return isValidBoardArrangement(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function parseStoredBoolean(raw: string | null): boolean {
    if (raw === null) return false;
    try {
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === "boolean" ? parsed : false;
    } catch {
        return false;
    }
}

export function createBoardLayoutsStorage(
    storage: SyncStringStorage = localStorage,
): BoardLayoutsStorage {
    // Jotai with `getOnInit` calls `getItem` at atom creation and again at first mount; memoize a
    // throwing read, a failed carry-over write, a failed repair write, or a failed obsolete-key
    // removal for this session until a subsequent `setItem`, `trySetItem`, or `removeItem` clears it.
    const sessionFallback = new Map<string, BoardLayoutsState>();
    let alreadyPersisted: { key: string; value: BoardLayoutsState } | null = null;

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
                let parsed: unknown = null;
                try {
                    parsed = JSON.parse(storedValue);
                } catch {
                    // Unparseable JSON is repaired through the same path as an invalid value.
                }
                const { state, repaired } = validateAndRepairBoardLayouts(parsed);
                if (repaired) {
                    warn(`Invalid persisted value for ${key}`);
                    try {
                        storage.setItem(key, JSON.stringify(state));
                    } catch (error) {
                        reportPreferenceStorageFailure("repair", error);
                        sessionFallback.set(key, state);
                    }
                }
                return state;
            }

            // New key absent: carry over once from raw reads of current/legacy/retired keys.
            let rawCurrentLayout: string | null;
            let rawTabsHidden: string | null;
            let legacy: LegacyLayoutValues;
            let retiredEngine: RetiredEngineValues;
            try {
                rawCurrentLayout = storage.getItem(ANALYSIS_BOARD_LAYOUT_KEY);
                rawTabsHidden = storage.getItem(ANALYSIS_TABS_HIDDEN_KEY);
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
                warn(`Unable to read legacy layout values for ${key}`);
                reportPreferenceStorageFailure("read", error);
                const fallback = defaultBoardLayoutsState();
                sessionFallback.set(key, fallback);
                return fallback;
            }

            const validCurrentLayout = parseStoredArrangement(rawCurrentLayout);
            const legacyResult = computeCarryOverArrangement(legacy);
            const baseArrangement = validCurrentLayout ?? legacyResult.arrangement;
            const engineCarryOver = applyRetiredEngineCarryOver(baseArrangement, retiredEngine);

            const hasAnyOldKey =
                rawCurrentLayout !== null ||
                rawTabsHidden !== null ||
                legacyResult.hasLegacyValues ||
                engineCarryOver.hasRetiredKeys;

            if (!hasAnyOldKey) {
                const initial = defaultBoardLayoutsState();
                try {
                    storage.setItem(key, JSON.stringify(initial));
                } catch (error) {
                    reportPreferenceStorageFailure("save", error);
                    sessionFallback.set(key, initial);
                }
                return initial;
            }

            const tabsHidden = parseStoredBoolean(rawTabsHidden);
            const seededLayout: BoardLayout = {
                arrangement: engineCarryOver.arrangement,
                tabsHidden,
            };
            const carriedState: BoardLayoutsState = {
                version: BOARD_LAYOUTS_VERSION,
                kinds: {
                    repertoire: cloneBoardLayout(seededLayout),
                    game: cloneBoardLayout(seededLayout),
                    preparation: cloneBoardLayout(seededLayout),
                },
                saved: [],
            };

            try {
                storage.setItem(key, JSON.stringify(carriedState));
            } catch (error) {
                reportPreferenceStorageFailure("save", error);
                sessionFallback.set(key, carriedState);
                return carriedState;
            }

            const keysToRemove: string[] = [];
            if (rawCurrentLayout !== null) keysToRemove.push(ANALYSIS_BOARD_LAYOUT_KEY);
            if (rawTabsHidden !== null) keysToRemove.push(ANALYSIS_TABS_HIDDEN_KEY);
            if (legacy.panelsBesideNotation !== null) {
                keysToRemove.push(LEGACY_LAYOUT_KEY_MAP.panelsBesideNotation);
            }
            if (legacy.boardBesideSplits !== null) {
                keysToRemove.push(LEGACY_LAYOUT_KEY_MAP.boardBesideSplits);
            }
            if (legacy.detachedExplorer !== null) {
                keysToRemove.push(LEGACY_LAYOUT_KEY_MAP.detachedExplorer);
            }
            if (legacy.detachedExplorerPlacement !== null) {
                keysToRemove.push(LEGACY_LAYOUT_KEY_MAP.detachedExplorerPlacement);
            }
            if (legacy.detachedExplorerHeights !== null) {
                keysToRemove.push(LEGACY_LAYOUT_KEY_MAP.detachedExplorerHeights);
            }
            if (retiredEngine.detachedEngine !== null) {
                keysToRemove.push(RETIRED_ENGINE_KEY_MAP.detachedEngine);
            }
            if (retiredEngine.detachedEnginePlacement !== null) {
                keysToRemove.push(RETIRED_ENGINE_KEY_MAP.detachedEnginePlacement);
            }
            if (retiredEngine.detachedEngineLines !== null) {
                keysToRemove.push(RETIRED_ENGINE_KEY_MAP.detachedEngineLines);
            }

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
                    sessionFallback.set(key, carriedState);
                }
            }

            return carriedState;
        },
        setItem(key, value) {
            if (
                alreadyPersisted !== null &&
                alreadyPersisted.key === key &&
                alreadyPersisted.value === value
            ) {
                alreadyPersisted = null;
                return;
            }
            alreadyPersisted = null;
            try {
                storage.setItem(key, JSON.stringify(value));
                sessionFallback.delete(key);
            } catch (error) {
                reportPreferenceStorageFailure("save", error);
            }
        },
        trySetItem(key, value) {
            try {
                storage.setItem(key, JSON.stringify(value));
                sessionFallback.delete(key);
                alreadyPersisted = { key, value };
                return { ok: true };
            } catch (error) {
                return { ok: false, error };
            }
        },
        removeItem(key) {
            alreadyPersisted = null;
            sessionFallback.delete(key);
            try {
                storage.removeItem(key);
            } catch (error) {
                reportPreferenceStorageFailure("save", error);
            }
        },
    };
}

const defaultLayoutsStorage = createBoardLayoutsStorage(localStorage);

/**
 * Per-kind live analysis board layouts and user-saved layouts. Reads on creation (`getOnInit`) so
 * old layout keys are carried over and cleaned up before any write (including Reset).
 */
export const boardLayoutsAtom = atomWithStorage<BoardLayoutsState>(
    ANALYSIS_BOARD_LAYOUTS_KEY,
    defaultBoardLayoutsState(),
    defaultLayoutsStorage,
    { getOnInit: true },
);

/** Lists the three read-only presets first, followed by saved layouts in the order saved. */
export function listBoardLayouts(state: BoardLayoutsState): LayoutListEntry[] {
    return [
        ...LAYOUT_PRESETS.map((preset): LayoutListEntry => ({ kind: "preset", preset })),
        ...state.saved.map((saved): LayoutListEntry => ({ kind: "saved", saved })),
    ];
}

/** Read-only combined list of presets followed by saved layouts for menus and shortcuts. */
export const boardLayoutListAtom: Atom<readonly LayoutListEntry[]> = atom((get) =>
    listBoardLayouts(get(boardLayoutsAtom)),
);

function createKindLayoutAtom(
    kind: BoardLayoutKind,
): WritableAtom<BoardLayout, [SetStateAction<BoardLayout>], void> {
    return atom(
        (get) => get(boardLayoutsAtom).kinds[kind],
        (get, set, update: SetStateAction<BoardLayout>) => {
            const prevState = get(boardLayoutsAtom);
            const prevLayout = prevState.kinds[kind];
            const nextLayout = typeof update === "function" ? update(prevLayout) : update;
            if (nextLayout === prevLayout) return;
            set(boardLayoutsAtom, {
                ...prevState,
                kinds: {
                    ...prevState.kinds,
                    [kind]: nextLayout,
                },
            });
        },
    );
}

const KIND_LAYOUT_ATOMS: Readonly<
    Record<BoardLayoutKind, WritableAtom<BoardLayout, [SetStateAction<BoardLayout>], void>>
> = {
    repertoire: createKindLayoutAtom("repertoire"),
    game: createKindLayoutAtom("game"),
    preparation: createKindLayoutAtom("preparation"),
};

/** Returns the stable read/write atom for one analysis tab kind's live layout. */
export function boardLayoutFamily(
    kind: BoardLayoutKind,
): WritableAtom<BoardLayout, [SetStateAction<BoardLayout>], void> {
    return KIND_LAYOUT_ATOMS[kind];
}

/** Restores all three tab kinds to their presets while keeping all saved layouts. */
export const resetBoardLayoutsAtom = atom(null, (get, set) => {
    const prevState = get(boardLayoutsAtom);
    set(boardLayoutsAtom, {
        ...prevState,
        kinds: defaultKindLayouts(),
    });
});

/** Finds a saved layout matching `name` case-insensitively after trimming. */
export function findSavedLayoutByName(
    state: BoardLayoutsState,
    name: string,
): SavedBoardLayout | undefined {
    const normalized = name.trim().toLowerCase();
    if (normalized.length === 0) return undefined;
    return state.saved.find((entry) => entry.name.toLowerCase() === normalized);
}

function generateSavedLayoutId(existing: readonly SavedBoardLayout[]): string {
    const taken = new Set<string>(PRESET_IDS);
    for (const entry of existing) taken.add(entry.id);
    for (;;) {
        const candidate = crypto.randomUUID();
        if (!taken.has(candidate)) return candidate;
    }
}

function persistBoardLayoutsChange(
    store: BoardLayoutsStore,
    nextState: BoardLayoutsState,
): { ok: true } | { ok: false; reason: "storage"; error: unknown } {
    const written = defaultLayoutsStorage.trySetItem(ANALYSIS_BOARD_LAYOUTS_KEY, nextState);
    if (!written.ok) {
        return { ok: false, reason: "storage", error: written.error };
    }
    store.set(boardLayoutsAtom, nextState);
    return { ok: true };
}

/**
 * Applies a preset or saved layout to `kind`'s live layout, cloning the layout and resolving
 * engine leaves against `engines`. Returns `false` when `layoutId` does not exist.
 */
export function applyBoardLayoutToKind(
    store: BoardLayoutsStore,
    kind: BoardLayoutKind,
    layoutId: string,
    engines: readonly EnginePresence[] | undefined,
): boolean {
    const state = store.get(boardLayoutsAtom);
    const preset = getLayoutPreset(layoutId);
    const source: BoardLayout | undefined =
        preset?.layout ?? state.saved.find((entry) => entry.id === layoutId);
    if (!source) return false;

    const cloned = cloneBoardLayout(source);
    const resolvedArrangement = resolveArrangementEngines(cloned.arrangement, engines, {
        fallbackMissing: true,
    });
    store.set(boardLayoutFamily(kind), {
        arrangement: resolvedArrangement,
        tabsHidden: cloned.tabsHidden,
    });
    return true;
}

/**
 * Saves a copy of `kind`'s current live layout under `name`. With `replace: true`, replaces an
 * existing case-insensitive name match (preserving its id, allowed even at `MAX_SAVED_LAYOUTS`).
 * Fails closed: if writing to storage throws, in-memory state is left unchanged.
 */
export function saveBoardLayout(
    store: BoardLayoutsStore,
    kind: BoardLayoutKind,
    name: string,
    options?: { replace?: boolean },
): SavedLayoutMutationResult {
    const validated = validateLayoutName(name);
    if (!validated.ok) return validated;

    const state = store.get(boardLayoutsAtom);
    const existing = findSavedLayoutByName(state, validated.name);
    const liveCopy = cloneBoardLayout(state.kinds[kind]);

    let nextSaved: SavedBoardLayout[];
    let savedEntry: SavedBoardLayout;

    if (existing) {
        if (!options?.replace) {
            return { ok: false, reason: "duplicate-name" };
        }
        savedEntry = {
            id: existing.id,
            name: validated.name,
            arrangement: liveCopy.arrangement,
            tabsHidden: liveCopy.tabsHidden,
        };
        nextSaved = state.saved.map((entry) => (entry.id === existing.id ? savedEntry : entry));
    } else {
        if (state.saved.length >= MAX_SAVED_LAYOUTS) {
            return { ok: false, reason: "limit-reached" };
        }
        savedEntry = {
            id: generateSavedLayoutId(state.saved),
            name: validated.name,
            arrangement: liveCopy.arrangement,
            tabsHidden: liveCopy.tabsHidden,
        };
        nextSaved = [...state.saved, savedEntry];
    }

    const persisted = persistBoardLayoutsChange(store, { ...state, saved: nextSaved });
    if (!persisted.ok) return persisted;
    return { ok: true, layout: savedEntry };
}

/**
 * Renames a saved layout by id. Presets are read-only (`not-found`). Allows a casing-only rename
 * of the same entry, rejects case-insensitive collisions with other entries, and fails closed on
 * storage write errors.
 */
export function renameBoardLayout(
    store: BoardLayoutsStore,
    id: string,
    newName: string,
): SavedLayoutMutationResult {
    const validated = validateLayoutName(newName);
    if (!validated.ok) return validated;

    const state = store.get(boardLayoutsAtom);
    const existing = state.saved.find((entry) => entry.id === id);
    if (!existing) return { ok: false, reason: "not-found" };

    const normalized = validated.name.toLowerCase();
    const collision = state.saved.some(
        (entry) => entry.id !== id && entry.name.toLowerCase() === normalized,
    );
    if (collision) return { ok: false, reason: "duplicate-name" };

    const renamedEntry: SavedBoardLayout = {
        ...existing,
        name: validated.name,
    };
    const nextState: BoardLayoutsState = {
        ...state,
        saved: state.saved.map((entry) => (entry.id === id ? renamedEntry : entry)),
    };
    const persisted = persistBoardLayoutsChange(store, nextState);
    if (!persisted.ok) return persisted;
    return { ok: true, layout: renamedEntry };
}

/**
 * Deletes a saved layout by id. Presets are read-only (`not-found`). Fails closed on storage
 * write errors.
 */
export function deleteBoardLayout(store: BoardLayoutsStore, id: string): DeleteLayoutResult {
    const state = store.get(boardLayoutsAtom);
    if (!state.saved.some((entry) => entry.id === id)) {
        return { ok: false, reason: "not-found" };
    }

    const nextState: BoardLayoutsState = {
        ...state,
        saved: state.saved.filter((entry) => entry.id !== id),
    };
    return persistBoardLayoutsChange(store, nextState);
}
