import { afterEach, describe, expect, test, vi } from "vitest";
import { createStore } from "jotai";
import type { SyncStringStorage } from "jotai/vanilla/utils/atomWithStorage";
import {
    ANALYSIS_BOARD_LAYOUT_KEY,
    ANALYSIS_BOARD_LAYOUTS_KEY,
    ANALYSIS_TABS_HIDDEN_KEY,
    applyBoardLayoutToKind,
    BOARD_LAYOUTS_VERSION,
    boardLayoutFamily,
    boardLayoutListAtom,
    boardLayoutsAtom,
    type BoardLayoutsState,
    createBoardLayoutsStorage,
    createWindowsStateStorage,
    defaultBoardLayoutsState,
    defaultWindowsState,
    deleteBoardLayout,
    findSavedLayoutByName,
    LEGACY_LAYOUT_KEYS,
    listBoardLayouts,
    MAX_SAVED_LAYOUTS,
    renameBoardLayout,
    resetBoardLayoutsAtom,
    RETIRED_ENGINE_KEYS,
    saveBoardLayout,
    validateAndRepairBoardLayouts,
    WINDOWS_STATE_KEY,
} from "./layoutStorage";
import {
    arrangementEngineAreas,
    type BoardArrangement,
    defaultBoardArrangement,
    engineAreaId,
    enginePlaceholderAreaId,
    hiddenEngineAreas,
    isEnginePlaceholderArea,
    placeArea,
} from "./boardArrangement";
import { defaultKindLayouts, defaultLayoutForKind, LAYOUT_PRESETS } from "./layoutPresets";

const native = vi.hoisted(() => ({ warn: vi.fn() }));
const persistError = vi.hoisted(() => ({ reportPersistError: vi.fn() }));
vi.mock("@/platform/native", () => native);
vi.mock("./persistError", () => persistError);

afterEach(() => {
    localStorage.clear();
    native.warn.mockClear();
    persistError.reportPersistError.mockClear();
    vi.restoreAllMocks();
});

/** In-memory storage double whose individual operations can be made to throw. */
function memoryStorage(
    initial: Record<string, string | undefined> = {},
    failures: {
        get?: (key: string) => Error | null;
        set?: (key: string) => Error | null;
        remove?: (key: string) => Error | null;
    } = {},
) {
    const map = new Map<string, string>(
        Object.entries(initial).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
        ),
    );
    const reads: string[] = [];
    const writes: Array<[string, string]> = [];
    const removals: string[] = [];
    const storage: SyncStringStorage = {
        getItem(key) {
            reads.push(key);
            const error = failures.get?.(key);
            if (error) throw error;
            return map.get(key) ?? null;
        },
        setItem(key, value) {
            writes.push([key, value]);
            const error = failures.set?.(key);
            if (error) throw error;
            map.set(key, value);
        },
        removeItem(key) {
            removals.push(key);
            const error = failures.remove?.(key);
            if (error) throw error;
            map.delete(key);
        },
    };
    return { storage, map, reads, writes, removals };
}

function seededAllKinds(arrangement: BoardArrangement, tabsHidden = false): BoardLayoutsState {
    return {
        version: BOARD_LAYOUTS_VERSION,
        kinds: {
            repertoire: { arrangement, tabsHidden },
            game: { arrangement, tabsHidden },
            preparation: { arrangement, tabsHidden },
        },
        saved: [],
    };
}

describe("windowsState storage", () => {
    test("round-trips a valid bounded Mosaic layout", () => {
        const storage = createWindowsStateStorage(localStorage);
        const layout = {
            currentNode: {
                direction: "column" as const,
                first: "bottomRight" as const,
                second: {
                    direction: "row" as const,
                    first: "left" as const,
                    second: "topRight" as const,
                    splitPercentage: 35,
                },
            },
        };

        storage.setItem(WINDOWS_STATE_KEY, layout);
        expect(storage.getItem(WINDOWS_STATE_KEY, defaultWindowsState())).toEqual(layout);
    });

    test.each([
        { currentNode: "obsoletePane" },
        { currentNode: "database" },
        { currentNode: { direction: "row", first: "left", second: "left" } },
        { currentNode: { direction: "row", first: "left", second: "topRight", obsolete: true } },
        {
            currentNode: {
                direction: "row",
                first: "left",
                second: "topRight",
                splitPercentage: 101,
            },
        },
    ])("repairs corrupt or obsolete hydration to the safe layout", (stored) => {
        localStorage.setItem(WINDOWS_STATE_KEY, JSON.stringify(stored));
        const storage = createWindowsStateStorage(localStorage);

        expect(storage.getItem(WINDOWS_STATE_KEY, defaultWindowsState())).toEqual(
            defaultWindowsState(),
        );
        expect(JSON.parse(localStorage.getItem(WINDOWS_STATE_KEY)!)).toEqual(defaultWindowsState());
        expect(native.warn).toHaveBeenCalledWith("Invalid persisted value for windowsState");
    });

    test("reports a quota-failed write and preserves the last valid layout for reload", () => {
        const storage = createWindowsStateStorage(localStorage);
        const durable = { currentNode: "left" as const };
        storage.setItem(WINDOWS_STATE_KEY, durable);
        const originalSetItem = Storage.prototype.setItem;
        const quotaError = new DOMException("quota", "QuotaExceededError");
        const setItem = vi
            .spyOn(Storage.prototype, "setItem")
            .mockImplementation(function (this: Storage, key, value) {
                if (key === WINDOWS_STATE_KEY) throw quotaError;
                return originalSetItem.call(this, key, value);
            });

        storage.setItem(WINDOWS_STATE_KEY, { currentNode: "topRight" });
        setItem.mockRestore();

        expect(persistError.reportPersistError).toHaveBeenCalledOnce();
        expect(
            createWindowsStateStorage(localStorage).getItem(
                WINDOWS_STATE_KEY,
                defaultWindowsState(),
            ),
        ).toEqual(durable);
    });
});

describe("boardLayouts carry-over and cleanup", () => {
    test("fresh install writes default presets to analysis-board-layouts so a later windowsState write never overwrites them", () => {
        const double = memoryStorage();
        const storage = createBoardLayoutsStorage(double.storage);

        const result = storage.getItem(ANALYSIS_BOARD_LAYOUTS_KEY, defaultBoardLayoutsState());
        expect(result).toEqual(defaultBoardLayoutsState());
        expect(double.writes).toHaveLength(1);
        expect(JSON.parse(double.map.get(ANALYSIS_BOARD_LAYOUTS_KEY)!)).toEqual(
            defaultBoardLayoutsState(),
        );
        expect(double.removals).toEqual([]);
        expect(persistError.reportPersistError).not.toHaveBeenCalled();

        // Play/puzzle board later writes windowsState; a fresh storage read keeps the presets.
        double.map.set(WINDOWS_STATE_KEY, JSON.stringify({ currentNode: "left" }));
        const freshSession = createBoardLayoutsStorage(double.storage);
        expect(
            freshSession.getItem(ANALYSIS_BOARD_LAYOUTS_KEY, defaultBoardLayoutsState()),
        ).toEqual(defaultBoardLayoutsState());
    });

    test("fresh install write failure reports once and memoizes default presets for the session", () => {
        const double = memoryStorage(
            {},
            {
                set: (key) =>
                    key === ANALYSIS_BOARD_LAYOUTS_KEY
                        ? new DOMException("quota", "QuotaExceededError")
                        : null,
            },
        );
        const storage = createBoardLayoutsStorage(double.storage);

        expect(storage.getItem(ANALYSIS_BOARD_LAYOUTS_KEY, defaultBoardLayoutsState())).toEqual(
            defaultBoardLayoutsState(),
        );
        expect(storage.getItem(ANALYSIS_BOARD_LAYOUTS_KEY, defaultBoardLayoutsState())).toEqual(
            defaultBoardLayoutsState(),
        );
        expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    });

    test("carries over from analysis-board-layout and analysis-board-tabs-hidden into all three kinds, removing both old keys", () => {
        const custom = placeArea(defaultBoardArrangement(), "database", "left", "bottom");
        const double = memoryStorage({
            [ANALYSIS_BOARD_LAYOUT_KEY]: JSON.stringify(custom),
            [ANALYSIS_TABS_HIDDEN_KEY]: "true",
            [WINDOWS_STATE_KEY]: JSON.stringify(defaultWindowsState()),
        });
        const storage = createBoardLayoutsStorage(double.storage);

        const result = storage.getItem(ANALYSIS_BOARD_LAYOUTS_KEY, defaultBoardLayoutsState());
        const expected = seededAllKinds(custom, true);
        expect(result).toEqual(expected);
        expect(JSON.parse(double.map.get(ANALYSIS_BOARD_LAYOUTS_KEY)!)).toEqual(expected);
        expect(double.map.has(ANALYSIS_BOARD_LAYOUT_KEY)).toBe(false);
        expect(double.map.has(ANALYSIS_TABS_HIDDEN_KEY)).toBe(false);
        expect(double.map.has(WINDOWS_STATE_KEY)).toBe(true);
        expect(persistError.reportPersistError).not.toHaveBeenCalled();
    });

    test("carry-over applies retired engine key on top of an existing analysis-board-layout and carries analysis-board-tabs-hidden", () => {
        const base = placeArea(defaultBoardArrangement(), "database", "topRight", "top");
        const double = memoryStorage({
            [ANALYSIS_BOARD_LAYOUT_KEY]: JSON.stringify(base),
            [ANALYSIS_TABS_HIDDEN_KEY]: "true",
            "detached-engine": JSON.stringify("eng-sf"),
            "detached-engine-placement": JSON.stringify("board"),
            "detached-engine-lines": JSON.stringify(3),
        });
        const storage = createBoardLayoutsStorage(double.storage);

        const result = storage.getItem(ANALYSIS_BOARD_LAYOUTS_KEY, defaultBoardLayoutsState());
        const expectedArrangement = placeArea(base, engineAreaId("eng-sf"), "left", "bottom");
        expect(result).toEqual(seededAllKinds(expectedArrangement, true));
        expect(double.map.has(ANALYSIS_BOARD_LAYOUT_KEY)).toBe(false);
        expect(double.map.has(ANALYSIS_TABS_HIDDEN_KEY)).toBe(false);
        for (const key of RETIRED_ENGINE_KEYS) {
            expect(double.map.has(key)).toBe(false);
        }
    });

    test("carries over from legacy keys only (plus tabs-hidden) and removes legacy keys while keeping windowsState", () => {
        const windowsRaw = JSON.stringify(defaultWindowsState());
        const double = memoryStorage({
            [WINDOWS_STATE_KEY]: windowsRaw,
            "panels-beside-notation": "true",
            "board-beside-splits": JSON.stringify({ board: 42, notation: 60 }),
            "detached-explorer": "true",
            "detached-explorer-placement": JSON.stringify("tabs"),
            "detached-explorer-heights": JSON.stringify({ tabs: 240 }),
            [ANALYSIS_TABS_HIDDEN_KEY]: "true",
        });
        const storage = createBoardLayoutsStorage(double.storage);

        const expectedArrangement: BoardArrangement = {
            direction: "row",
            first: "left",
            splitPercentage: 42,
            second: {
                direction: "column",
                first: "database",
                splitPercentage: 30,
                second: {
                    direction: "row",
                    first: "bottomRight",
                    second: "topRight",
                    splitPercentage: 60,
                },
            },
        };
        const result = storage.getItem(ANALYSIS_BOARD_LAYOUTS_KEY, defaultBoardLayoutsState());
        expect(result).toEqual(seededAllKinds(expectedArrangement, true));
        for (const key of LEGACY_LAYOUT_KEYS) {
            expect(double.map.has(key)).toBe(false);
        }
        expect(double.map.has(ANALYSIS_TABS_HIDDEN_KEY)).toBe(false);
        expect(double.map.get(WINDOWS_STATE_KEY)).toBe(windowsRaw);
    });

    test("carries over analysis-board-tabs-hidden alone when no layout key is present", () => {
        const double = memoryStorage({
            [ANALYSIS_TABS_HIDDEN_KEY]: "true",
        });
        const storage = createBoardLayoutsStorage(double.storage);

        const result = storage.getItem(ANALYSIS_BOARD_LAYOUTS_KEY, defaultBoardLayoutsState());
        expect(result).toEqual(seededAllKinds(defaultBoardArrangement(), true));
        expect(double.map.has(ANALYSIS_TABS_HIDDEN_KEY)).toBe(false);
    });

    test("carry-over write failure keeps every old key, returns computed state and reports once across repeated reads", () => {
        const custom = placeArea(defaultBoardArrangement(), "database", "left", "bottom");
        const initial = {
            [ANALYSIS_BOARD_LAYOUT_KEY]: JSON.stringify(custom),
            [ANALYSIS_TABS_HIDDEN_KEY]: "true",
            "panels-beside-notation": "true",
            "detached-engine": JSON.stringify("eng-1"),
            [WINDOWS_STATE_KEY]: JSON.stringify(defaultWindowsState()),
        };
        let failWrites = true;
        const double = memoryStorage(initial, {
            set: (key) =>
                failWrites && key === ANALYSIS_BOARD_LAYOUTS_KEY
                    ? new DOMException("quota", "QuotaExceededError")
                    : null,
        });
        const storage = createBoardLayoutsStorage(double.storage);

        const expected = seededAllKinds(
            placeArea(custom, engineAreaId("eng-1"), "topRight", "top"),
            true,
        );
        expect(storage.getItem(ANALYSIS_BOARD_LAYOUTS_KEY, defaultBoardLayoutsState())).toEqual(
            expected,
        );
        expect(storage.getItem(ANALYSIS_BOARD_LAYOUTS_KEY, defaultBoardLayoutsState())).toEqual(
            expected,
        );
        expect(double.removals).toEqual([]);
        for (const [key, value] of Object.entries(initial)) {
            expect(double.map.get(key)).toBe(value);
        }
        expect(persistError.reportPersistError).toHaveBeenCalledOnce();

        // Once a write succeeds, the session memo clears.
        failWrites = false;
        const fresh = defaultBoardLayoutsState();
        storage.setItem(ANALYSIS_BOARD_LAYOUTS_KEY, fresh);
        expect(storage.getItem(ANALYSIS_BOARD_LAYOUTS_KEY, expected)).toEqual(fresh);
    });

    test.each([
        ANALYSIS_BOARD_LAYOUTS_KEY,
        ANALYSIS_BOARD_LAYOUT_KEY,
        ANALYSIS_TABS_HIDDEN_KEY,
        "detached-explorer",
        "detached-engine",
        WINDOWS_STATE_KEY,
    ])(
        "throwing read of %s yields presets, keeps every old key, writes nothing and reports once",
        (failingKey) => {
            const initial = {
                [ANALYSIS_BOARD_LAYOUT_KEY]: JSON.stringify(defaultBoardArrangement()),
                [ANALYSIS_TABS_HIDDEN_KEY]: "true",
                "detached-explorer": "true",
                "detached-engine": JSON.stringify("eng-1"),
                [WINDOWS_STATE_KEY]: JSON.stringify(defaultWindowsState()),
            };
            const double = memoryStorage(initial, {
                get: (key) => (key === failingKey ? new Error("blocked") : null),
            });
            const storage = createBoardLayoutsStorage(double.storage);

            expect(storage.getItem(ANALYSIS_BOARD_LAYOUTS_KEY, defaultBoardLayoutsState())).toEqual(
                defaultBoardLayoutsState(),
            );
            expect(storage.getItem(ANALYSIS_BOARD_LAYOUTS_KEY, defaultBoardLayoutsState())).toEqual(
                defaultBoardLayoutsState(),
            );
            expect(double.writes).toEqual([]);
            expect(double.removals).toEqual([]);
            for (const [key, value] of Object.entries(initial)) {
                expect(double.map.get(key)).toBe(value);
            }
            expect(persistError.reportPersistError).toHaveBeenCalledOnce();
        },
    );

    test("Reset as the first action on a profile with old keys removes all old keys and keeps windowsState", async () => {
        localStorage.setItem(WINDOWS_STATE_KEY, JSON.stringify(defaultWindowsState()));
        localStorage.setItem(ANALYSIS_BOARD_LAYOUT_KEY, JSON.stringify(defaultBoardArrangement()));
        localStorage.setItem(ANALYSIS_TABS_HIDDEN_KEY, "true");
        localStorage.setItem("panels-beside-notation", "true");
        localStorage.setItem("detached-engine", JSON.stringify("eng-1"));

        vi.resetModules();
        const fresh = await import("./layoutStorage");
        const store = createStore();
        store.set(fresh.resetBoardLayoutsAtom);

        expect(JSON.parse(localStorage.getItem(ANALYSIS_BOARD_LAYOUTS_KEY)!)).toEqual(
            defaultBoardLayoutsState(),
        );
        expect(localStorage.getItem(ANALYSIS_BOARD_LAYOUT_KEY)).toBeNull();
        expect(localStorage.getItem(ANALYSIS_TABS_HIDDEN_KEY)).toBeNull();
        expect(localStorage.getItem("panels-beside-notation")).toBeNull();
        expect(localStorage.getItem("detached-engine")).toBeNull();
        expect(localStorage.getItem(WINDOWS_STATE_KEY)).not.toBeNull();
    });
});

describe("per-entry validation and repair", () => {
    test("repairs invalid kind entries and drops bad saved entries while keeping valid siblings and writing once", () => {
        const validGameArrangement = placeArea(
            defaultBoardArrangement(),
            "annotate",
            "left",
            "bottom",
        );
        const validSaved1 = {
            id: "saved-1",
            name: "  Opening  ",
            arrangement: validGameArrangement,
            tabsHidden: true,
        };
        const validSaved2 = {
            id: "saved-2",
            name: "Endgame",
            arrangement: defaultBoardArrangement(),
            tabsHidden: false,
        };
        const raw = {
            version: BOARD_LAYOUTS_VERSION,
            kinds: {
                repertoire: { arrangement: "not-a-valid-tree", tabsHidden: false },
                game: { arrangement: validGameArrangement, tabsHidden: true },
                preparation: { arrangement: defaultBoardArrangement(), tabsHidden: "yes" },
            },
            saved: [
                validSaved1,
                {
                    id: "",
                    name: "EmptyId",
                    arrangement: defaultBoardArrangement(),
                    tabsHidden: false,
                },
                {
                    id: "saved-1",
                    name: "DupId",
                    arrangement: defaultBoardArrangement(),
                    tabsHidden: false,
                },
                {
                    id: LAYOUT_PRESETS[0].id,
                    name: "PresetIdCollision",
                    arrangement: defaultBoardArrangement(),
                    tabsHidden: false,
                },
                {
                    id: "bad-empty-name",
                    name: "   ",
                    arrangement: defaultBoardArrangement(),
                    tabsHidden: false,
                },
                {
                    id: "bad-long-name",
                    name: "a".repeat(41),
                    arrangement: defaultBoardArrangement(),
                    tabsHidden: false,
                },
                {
                    id: "dup-name",
                    name: "OPENING",
                    arrangement: defaultBoardArrangement(),
                    tabsHidden: false,
                },
                {
                    id: "bad-layout",
                    name: "BadTree",
                    arrangement: { direction: "row", first: "left", second: "left" },
                    tabsHidden: false,
                },
                validSaved2,
            ],
        };

        const double = memoryStorage({ [ANALYSIS_BOARD_LAYOUTS_KEY]: JSON.stringify(raw) });
        const storage = createBoardLayoutsStorage(double.storage);
        const result = storage.getItem(ANALYSIS_BOARD_LAYOUTS_KEY, defaultBoardLayoutsState());

        expect(result).toEqual({
            version: BOARD_LAYOUTS_VERSION,
            kinds: {
                repertoire: defaultLayoutForKind("repertoire"),
                game: { arrangement: validGameArrangement, tabsHidden: true },
                preparation: defaultLayoutForKind("preparation"),
            },
            saved: [{ ...validSaved1, name: "Opening" }, validSaved2],
        });
        expect(double.writes).toHaveLength(1);
        expect(JSON.parse(double.map.get(ANALYSIS_BOARD_LAYOUTS_KEY)!)).toEqual(result);
    });

    test("drops saved entries beyond 20 and keeps the first 20 valid ones", () => {
        const entries = Array.from({ length: 21 }, (_, index) => ({
            id: `id-${index + 1}`,
            name: `Layout ${index + 1}`,
            arrangement: defaultBoardArrangement(),
            tabsHidden: false,
        }));
        const { state, repaired } = validateAndRepairBoardLayouts({
            version: BOARD_LAYOUTS_VERSION,
            kinds: defaultKindLayouts(),
            saved: entries,
        });
        expect(repaired).toBe(true);
        expect(state.saved).toHaveLength(MAX_SAVED_LAYOUTS);
        expect(state.saved.at(-1)?.id).toBe("id-20");
    });

    test("unparseable JSON or wrong version falls back to presets with no saved layouts", () => {
        const corrupt = memoryStorage({ [ANALYSIS_BOARD_LAYOUTS_KEY]: "{bad-json" });
        expect(
            createBoardLayoutsStorage(corrupt.storage).getItem(
                ANALYSIS_BOARD_LAYOUTS_KEY,
                defaultBoardLayoutsState(),
            ),
        ).toEqual(defaultBoardLayoutsState());
        expect(corrupt.writes).toHaveLength(1);

        const wrongVersion = memoryStorage({
            [ANALYSIS_BOARD_LAYOUTS_KEY]: JSON.stringify({
                version: 99,
                kinds: defaultKindLayouts(),
                saved: [],
            }),
        });
        expect(
            createBoardLayoutsStorage(wrongVersion.storage).getItem(
                ANALYSIS_BOARD_LAYOUTS_KEY,
                defaultBoardLayoutsState(),
            ),
        ).toEqual(defaultBoardLayoutsState());
        expect(wrongVersion.writes).toHaveLength(1);
    });

    test("storage error paths: carry-over removeItem failure, repair write failure, live-layout setItem failure, and removeItem", () => {
        // 1. Throwing removeItem during carry-over still attempts all other obsolete keys, warns once, reports once.
        const removeDouble = memoryStorage(
            {
                [ANALYSIS_BOARD_LAYOUT_KEY]: JSON.stringify(defaultBoardArrangement()),
                [ANALYSIS_TABS_HIDDEN_KEY]: "true",
                "panels-beside-notation": "true",
                "detached-engine": JSON.stringify("eng-1"),
            },
            {
                remove: (key) =>
                    key === ANALYSIS_TABS_HIDDEN_KEY || key === "detached-engine"
                        ? new Error(`locked: ${key}`)
                        : null,
            },
        );
        const removeStorage = createBoardLayoutsStorage(removeDouble.storage);
        const carried = removeStorage.getItem(
            ANALYSIS_BOARD_LAYOUTS_KEY,
            defaultBoardLayoutsState(),
        );
        expect(removeDouble.removals).toEqual([
            ANALYSIS_BOARD_LAYOUT_KEY,
            ANALYSIS_TABS_HIDDEN_KEY,
            "panels-beside-notation",
            "detached-engine",
        ]);
        expect(removeDouble.map.has(ANALYSIS_BOARD_LAYOUT_KEY)).toBe(false);
        expect(removeDouble.map.has("panels-beside-notation")).toBe(false);
        expect(removeDouble.map.has(ANALYSIS_TABS_HIDDEN_KEY)).toBe(true);
        expect(removeDouble.map.has("detached-engine")).toBe(true);
        expect(native.warn).toHaveBeenCalledWith(
            `Unable to remove legacy layout keys: ${ANALYSIS_TABS_HIDDEN_KEY}, detached-engine`,
        );
        expect(persistError.reportPersistError).toHaveBeenCalledOnce();
        // Memoized across repeated reads in the same session.
        expect(
            removeStorage.getItem(ANALYSIS_BOARD_LAYOUTS_KEY, defaultBoardLayoutsState()),
        ).toEqual(carried);
        expect(persistError.reportPersistError).toHaveBeenCalledOnce();

        // 2. Throwing setItem on a repair write memoizes the session fallback and reports once.
        persistError.reportPersistError.mockClear();
        let failRepairWrite = true;
        const repairDouble = memoryStorage(
            { [ANALYSIS_BOARD_LAYOUTS_KEY]: "{not-json" },
            {
                set: (key) =>
                    failRepairWrite && key === ANALYSIS_BOARD_LAYOUTS_KEY
                        ? new DOMException("quota", "QuotaExceededError")
                        : null,
            },
        );
        const repairStorage = createBoardLayoutsStorage(repairDouble.storage);
        expect(
            repairStorage.getItem(ANALYSIS_BOARD_LAYOUTS_KEY, defaultBoardLayoutsState()),
        ).toEqual(defaultBoardLayoutsState());
        expect(
            repairStorage.getItem(ANALYSIS_BOARD_LAYOUTS_KEY, defaultBoardLayoutsState()),
        ).toEqual(defaultBoardLayoutsState());
        expect(persistError.reportPersistError).toHaveBeenCalledOnce();

        // 3. removeItem clears the session fallback and catches storage errors without throwing.
        persistError.reportPersistError.mockClear();
        failRepairWrite = false;
        const freshState = seededAllKinds(
            placeArea(defaultBoardArrangement(), "info", "left", "bottom"),
            true,
        );
        repairDouble.map.set(ANALYSIS_BOARD_LAYOUTS_KEY, JSON.stringify(freshState));
        repairStorage.removeItem(ANALYSIS_BOARD_LAYOUTS_KEY);
        expect(repairDouble.map.has(ANALYSIS_BOARD_LAYOUTS_KEY)).toBe(false);
        expect(persistError.reportPersistError).not.toHaveBeenCalled();
        // Now getItem reads fresh storage instead of the old memoized fallback.
        repairDouble.map.set(ANALYSIS_BOARD_LAYOUTS_KEY, JSON.stringify(freshState));
        expect(
            repairStorage.getItem(ANALYSIS_BOARD_LAYOUTS_KEY, defaultBoardLayoutsState()),
        ).toEqual(freshState);

        const throwingRemove = memoryStorage(
            { [ANALYSIS_BOARD_LAYOUTS_KEY]: JSON.stringify(freshState) },
            { remove: () => new Error("remove-blocked") },
        );
        expect(() =>
            createBoardLayoutsStorage(throwingRemove.storage).removeItem(
                ANALYSIS_BOARD_LAYOUTS_KEY,
            ),
        ).not.toThrow();
        expect(persistError.reportPersistError).toHaveBeenCalledOnce();

        // 4. Throwing setItem on a live-layout write reports and keeps the in-memory value.
        persistError.reportPersistError.mockClear();
        const store = createStore();
        const edited = {
            arrangement: placeArea(defaultBoardArrangement(), "annotate", "left", "bottom"),
            tabsHidden: true,
        };
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new DOMException("quota", "QuotaExceededError");
        });
        expect(() => store.set(boardLayoutFamily("game"), edited)).not.toThrow();
        expect(store.get(boardLayoutFamily("game"))).toEqual(edited);
        expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    });
});

describe("per-kind live state, apply, CRUD, fail-closed writes, and Reset", () => {
    test("editing one kind leaves the other two kinds untouched", () => {
        const store = createStore();
        const beforeRep = store.get(boardLayoutFamily("repertoire"));
        const beforePrep = store.get(boardLayoutFamily("preparation"));
        const editedGame = {
            arrangement: placeArea(defaultBoardArrangement(), "annotate", "left", "bottom"),
            tabsHidden: true,
        };

        store.set(boardLayoutFamily("game"), editedGame);

        expect(store.get(boardLayoutFamily("game"))).toEqual(editedGame);
        expect(store.get(boardLayoutFamily("repertoire"))).toEqual(beforeRep);
        expect(store.get(boardLayoutFamily("preparation"))).toEqual(beforePrep);
    });

    test("listBoardLayouts lists the three presets first, then saved layouts in order saved", () => {
        const store = createStore();
        expect(saveBoardLayout(store, "game", "First").ok).toBe(true);
        expect(saveBoardLayout(store, "repertoire", "Second").ok).toBe(true);

        const list = store.get(boardLayoutListAtom);
        expect(list.slice(0, 3).map((e) => (e.kind === "preset" ? e.preset.id : null))).toEqual(
            LAYOUT_PRESETS.map((p) => p.id),
        );
        expect(list.slice(3).map((e) => (e.kind === "saved" ? e.saved.name : null))).toEqual([
            "First",
            "Second",
        ]);
        expect(listBoardLayouts(store.get(boardLayoutsAtom))).toEqual(list);
    });

    test("apply copies layout so later edits leave the saved copy unchanged, and resolves missing engine ids", () => {
        const store = createStore();
        const removedEngine = engineAreaId("deleted-engine-uuid");
        const withRemovedEngine = placeArea(
            defaultBoardArrangement(),
            removedEngine,
            "left",
            "bottom",
        );
        store.set(boardLayoutFamily("game"), {
            arrangement: withRemovedEngine,
            tabsHidden: true,
        });

        const saved = saveBoardLayout(store, "game", "Engine Study");
        expect(saved.ok).toBe(true);
        if (!saved.ok) return;

        // Applying with an enabled engine substitutes the first enabled unused engine.
        expect(
            applyBoardLayoutToKind(store, "preparation", saved.layout.id, [
                { id: "disabled-1", loaded: false },
                { id: "enabled-1", loaded: true },
            ]),
        ).toBe(true);
        const appliedPrep = store.get(boardLayoutFamily("preparation"));
        expect(arrangementEngineAreas(appliedPrep.arrangement)).toEqual([
            engineAreaId("enabled-1"),
        ]);
        expect(appliedPrep.tabsHidden).toBe(true);

        // Editing the live layout afterwards never mutates the saved copy.
        store.set(boardLayoutFamily("preparation"), {
            arrangement: defaultBoardArrangement(),
            tabsHidden: false,
        });
        const storedSaved = findSavedLayoutByName(store.get(boardLayoutsAtom), "engine study");
        expect(arrangementEngineAreas(storedSaved!.arrangement)).toEqual([removedEngine]);
        expect(storedSaved!.tabsHidden).toBe(true);

        // Applying when no enabled engine exists keeps a hidden placeholder in the live layout.
        expect(
            applyBoardLayoutToKind(store, "repertoire", saved.layout.id, [
                { id: "disabled-1", loaded: false },
            ]),
        ).toBe(true);
        const appliedRep = store.get(boardLayoutFamily("repertoire"));
        const repEngines = arrangementEngineAreas(appliedRep.arrangement);
        expect(repEngines).toEqual([enginePlaceholderAreaId(1)]);
        expect(isEnginePlaceholderArea(repEngines[0])).toBe(true);
        expect(
            hiddenEngineAreas(appliedRep.arrangement, [{ id: "disabled-1", loaded: false }]),
        ).toEqual([enginePlaceholderAreaId(1)]);
    });

    test("applyBoardLayoutToKind copies a preset with placeholders resolved and returns false without changing state for an unknown id", () => {
        const store = createStore();
        const beforeGame = store.get(boardLayoutFamily("game"));

        // Unknown id returns false and leaves state untouched.
        expect(applyBoardLayoutToKind(store, "game", "does-not-exist", [])).toBe(false);
        expect(store.get(boardLayoutFamily("game"))).toBe(beforeGame);

        // Preset id copies preset:repertoire and resolves its engine:@1 placeholder to the enabled engine.
        expect(
            applyBoardLayoutToKind(store, "game", "preset:repertoire", [
                { id: "sf-enabled", loaded: true },
            ]),
        ).toBe(true);
        const applied = store.get(boardLayoutFamily("game"));
        expect(arrangementEngineAreas(applied.arrangement)).toEqual([engineAreaId("sf-enabled")]);
        expect(applied.tabsHidden).toBe(false);
    });

    test("save, replace (including at cap 20), rename (including casing-only), and delete enforce rules", () => {
        const store = createStore();

        expect(saveBoardLayout(store, "game", "   ")).toEqual({ ok: false, reason: "empty-name" });
        expect(saveBoardLayout(store, "game", "x".repeat(41))).toEqual({
            ok: false,
            reason: "name-too-long",
        });

        for (let i = 1; i <= MAX_SAVED_LAYOUTS; i++) {
            const res = saveBoardLayout(store, "game", `Layout ${i}`);
            expect(res.ok).toBe(true);
        }
        // At 20 saved layouts, a new name is rejected.
        expect(saveBoardLayout(store, "game", "Layout 21")).toEqual({
            ok: false,
            reason: "limit-reached",
        });
        // Duplicate without replace is rejected.
        expect(saveBoardLayout(store, "game", "layout 1")).toEqual({
            ok: false,
            reason: "duplicate-name",
        });
        // Replacing an existing name at cap 20 succeeds and preserves its id.
        const firstId = store.get(boardLayoutsAtom).saved[0].id;
        store.set(boardLayoutFamily("game"), {
            arrangement: placeArea(defaultBoardArrangement(), "info", "left", "bottom"),
            tabsHidden: true,
        });
        const replaced = saveBoardLayout(store, "game", "LAYOUT 1", { replace: true });
        expect(replaced.ok).toBe(true);
        if (!replaced.ok) return;
        expect(replaced.layout.id).toBe(firstId);
        expect(replaced.layout.name).toBe("LAYOUT 1");
        expect(replaced.layout.tabsHidden).toBe(true);
        expect(store.get(boardLayoutsAtom).saved).toHaveLength(MAX_SAVED_LAYOUTS);

        // Casing-only rename of the same entry is allowed; colliding with another entry is rejected.
        expect(renameBoardLayout(store, firstId, "layout 1").ok).toBe(true);
        expect(renameBoardLayout(store, firstId, "Layout 2")).toEqual({
            ok: false,
            reason: "duplicate-name",
        });
        // Presets cannot be renamed or deleted.
        expect(renameBoardLayout(store, LAYOUT_PRESETS[0].id, "New Name")).toEqual({
            ok: false,
            reason: "not-found",
        });
        expect(deleteBoardLayout(store, LAYOUT_PRESETS[0].id)).toEqual({
            ok: false,
            reason: "not-found",
        });

        // Delete removes the saved entry.
        expect(deleteBoardLayout(store, firstId)).toEqual({ ok: true });
        expect(store.get(boardLayoutsAtom).saved).toHaveLength(MAX_SAVED_LAYOUTS - 1);
    });

    test("save, replace, rename, and delete all fail closed on a throwing setItem without changing in-memory state", () => {
        const store = createStore();
        const seeded = saveBoardLayout(store, "game", "Baseline");
        expect(seeded.ok).toBe(true);
        if (!seeded.ok) return;
        const snapshot = store.get(boardLayoutsAtom);

        const quotaError = new DOMException("quota", "QuotaExceededError");
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw quotaError;
        });

        // Save new
        const saveRes = saveBoardLayout(store, "game", "Will Fail");
        expect(saveRes).toEqual({ ok: false, reason: "storage", error: quotaError });
        expect(store.get(boardLayoutsAtom)).toBe(snapshot);

        // Replace existing
        const replaceRes = saveBoardLayout(store, "repertoire", "baseline", { replace: true });
        expect(replaceRes).toEqual({ ok: false, reason: "storage", error: quotaError });
        expect(store.get(boardLayoutsAtom)).toBe(snapshot);

        // Rename existing
        const renameRes = renameBoardLayout(store, seeded.layout.id, "Renamed");
        expect(renameRes).toEqual({ ok: false, reason: "storage", error: quotaError });
        expect(store.get(boardLayoutsAtom)).toBe(snapshot);

        // Delete existing
        const deleteRes = deleteBoardLayout(store, seeded.layout.id);
        expect(deleteRes).toEqual({ ok: false, reason: "storage", error: quotaError });
        expect(store.get(boardLayoutsAtom)).toBe(snapshot);
    });

    test("resetBoardLayoutsAtom restores all three kinds to their presets and keeps saved layouts", () => {
        const store = createStore();
        const custom = {
            arrangement: placeArea(defaultBoardArrangement(), "info", "left", "bottom"),
            tabsHidden: true,
        };
        store.set(boardLayoutFamily("game"), custom);
        store.set(boardLayoutFamily("repertoire"), custom);
        store.set(boardLayoutFamily("preparation"), custom);
        const saved = saveBoardLayout(store, "game", "Keep Me");
        expect(saved.ok).toBe(true);

        store.set(resetBoardLayoutsAtom);

        expect(store.get(boardLayoutsAtom).kinds).toEqual(defaultKindLayouts());
        expect(store.get(boardLayoutsAtom).saved).toHaveLength(1);
        expect(store.get(boardLayoutsAtom).saved[0].name).toBe("Keep Me");
    });
});
