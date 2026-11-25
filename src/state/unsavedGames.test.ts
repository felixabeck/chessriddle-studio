import { createStore as createJotaiStore } from "jotai";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import i18n from "@/i18n";
import enUSCatalogue from "@/translation/en-US.json";
import type { UnsavedGameInventory } from "@/bindings";
import { tabsAtom } from "@/state/atoms";
import { prepareTreeForStorage, TREE_STORAGE_VERSION, tabStorage } from "@/state/store/tabStorage";
import type { Tab } from "@/state/workspaceTypes";
import type { SetTabs } from "@/utils/tabs";
import { defaultTree, type TreeState } from "@/utils/treeReducer";
import {
    decodeUnsavedGame,
    resetUnsavedGamesForTests,
    restoreUnsavedGames,
    UNSAVED_GAME_NAME_MAX,
    UNSAVED_GAME_VERSION,
    type LegacyMigrationObserver,
    type UnsavedGameNative,
} from "./unsavedGames";

vi.mock("@/platform/native", () => ({
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
}));

function legacyRecord(name: string, comment = "kept"): string {
    const tree = defaultTree();
    tree.root.comment = comment;
    return JSON.stringify({
        version: UNSAVED_GAME_VERSION,
        tab: { name, type: "analysis" },
        tree: { version: TREE_STORAGE_VERSION, state: prepareTreeForStorage(tree) },
    });
}

function fakeNative(initial: Array<[string, string]> = []) {
    const records = new Map<string, string>(initial);
    const calls: string[] = [];
    const native: UnsavedGameNative & { failRemove: number; listError?: unknown } = {
        failRemove: 0,
        list: async (): Promise<UnsavedGameInventory> => {
            calls.push("list");
            if (native.listError) throw native.listError;
            return {
                records: [...records].map(([id, document]) => ({ id, document })),
                skipped: [],
                omitted: 0,
            };
        },
        remove: async (id) => {
            calls.push(`remove:${id}`);
            if (native.failRemove > 0) {
                native.failRemove -= 1;
                throw new Error("remove refused");
            }
            records.delete(id);
        },
        clear: async () => {
            calls.push("clear");
            records.clear();
            return [];
        },
    };
    return { native, records, calls };
}

function fakeObserver() {
    const confirmed = new Set<string>();
    const listeners = new Set<() => void>();
    const observer: LegacyMigrationObserver = {
        isConfirmed: (id) => confirmed.has(id),
        onConfirmedChange: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
    return {
        observer,
        confirm(id: string) {
            confirmed.add(id);
            for (const listener of listeners) listener();
        },
    };
}

let jotai: ReturnType<typeof createJotaiStore>;
let notify: ReturnType<typeof vi.fn<(message: string) => void>>;

beforeAll(async () => {
    await i18n.init({
        lng: "en-US",
        resources: { "en-US": { translation: enUSCatalogue.translation } },
    });
});

beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    resetUnsavedGamesForTests();
    jotai = createJotaiStore();
    notify = vi.fn();
});

afterEach(() => {
    resetUnsavedGamesForTests();
    vi.useRealTimers();
});

test("decodeUnsavedGame parses a valid legacy record and rejects corrupt or oversized names", () => {
    const decoded = decodeUnsavedGame(legacyRecord("Kasparov - Topalov", "1. e4"));
    expect(decoded.name).toBe("Kasparov - Topalov");
    expect(decoded.tree.root.comment).toBe("1. e4");

    expect(() => decodeUnsavedGame("not json")).toThrow(/JSON|Unexpected/);
    expect(() =>
        decodeUnsavedGame(
            JSON.stringify({
                version: UNSAVED_GAME_VERSION,
                tab: { name: "x".repeat(UNSAVED_GAME_NAME_MAX + 1), type: "analysis" },
                tree: { version: TREE_STORAGE_VERSION, state: defaultTree() },
            }),
        ),
    ).toThrow(/1024|too_big|at most/);
});

test("restoreUnsavedGames skips on reload (startedFresh=false)", async () => {
    const { native, calls } = fakeNative([[crypto.randomUUID(), legacyRecord("Reload game")]]);
    const setTabs: SetTabs = (...args) => jotai.set(tabsAtom, ...args);
    const result = await restoreUnsavedGames({
        native,
        jotaiStore: jotai,
        setTabs,
        notify,
        warn: () => undefined,
        startedFresh: () => false,
    });
    expect(result).toEqual({ kind: "skipped" });
    expect(calls).toEqual([]);
});

test("restoreUnsavedGames admits legacy records, dedupes open tabs, and removes once confirmed or closed", async () => {
    const idAdmit = crypto.randomUUID();
    const idOpen = crypto.randomUUID();
    const idClose = crypto.randomUUID();

    // idOpen is already open in workspace (e.g. restored from workspace-session).
    const existingTab: Tab = {
        value: idOpen,
        name: "Already Open",
        type: "analysis",
        gameOrigin: { kind: "none" },
    };
    jotai.set(tabsAtom, [existingTab]);

    const { native, records } = fakeNative([
        [idAdmit, legacyRecord("Migrated Game", "move comment")],
        [idOpen, legacyRecord("Duplicate Game")],
        [idClose, legacyRecord("Closed Before Confirm")],
    ]);
    const obs = fakeObserver();
    const setTabs: SetTabs = (...args) => jotai.set(tabsAtom, ...args);

    const result = await restoreUnsavedGames({
        native,
        jotaiStore: jotai,
        setTabs,
        notify,
        warn: () => undefined,
        startedFresh: () => true,
        sessionMirror: obs.observer,
    });

    expect(result).toEqual({ kind: "done", restored: 2, kept: 0 });
    const tabs = jotai.get(tabsAtom);
    expect(tabs.filter((t) => t.value === idOpen)).toHaveLength(1);
    expect(tabs.some((t) => t.value === idAdmit && t.gameOrigin.kind === "none")).toBe(true);
    const inspected = tabStorage.inspectTree(idAdmit, false);
    expect(inspected.kind).toBe("available");
    if (inspected.kind !== "available") throw new Error("expected available tree");
    const state = inspected.value.state as TreeState;
    expect(state.dirty).toBe(true);
    expect(state.sourceStamp).toBeNull();
    expect(state.root.comment).toBe("move comment");

    // Still on disk until confirmed or closed.
    expect(records.has(idAdmit)).toBe(true);
    expect(records.has(idOpen)).toBe(true);
    expect(records.has(idClose)).toBe(true);

    // Confirm idAdmit and idOpen -> legacy copies removed.
    obs.confirm(idAdmit);
    obs.confirm(idOpen);
    await vi.advanceTimersByTimeAsync(0);
    expect(records.has(idAdmit)).toBe(false);
    expect(records.has(idOpen)).toBe(false);
    expect(records.has(idClose)).toBe(true);

    // Close idClose without ever confirming -> legacy copy removed.
    jotai.set(tabsAtom, (current) => current.filter((t) => t.value !== idClose));
    await vi.advanceTimersByTimeAsync(0);
    expect(records.has(idClose)).toBe(false);
});

test("legacy removal retries with exponential backoff on failure and notifies once", async () => {
    const id = crypto.randomUUID();
    const { native, records } = fakeNative([[id, legacyRecord("Retry Game")]]);
    native.failRemove = 2;
    const obs = fakeObserver();
    const setTabs: SetTabs = (...args) => jotai.set(tabsAtom, ...args);

    await restoreUnsavedGames({
        native,
        jotaiStore: jotai,
        setTabs,
        notify,
        warn: () => undefined,
        startedFresh: () => true,
        sessionMirror: obs.observer,
    });

    notify.mockClear();
    obs.confirm(id);
    await vi.advanceTimersByTimeAsync(0);
    expect(records.has(id)).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);

    // First retry after 1000ms also fails, stays silent.
    await vi.advanceTimersByTimeAsync(1000);
    expect(records.has(id)).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);

    // Second retry after 2000ms succeeds.
    await vi.advanceTimersByTimeAsync(2000);
    expect(records.has(id)).toBe(false);
});

test("corrupt, skipped, and omitted legacy records stay on disk with a notice", async () => {
    const corruptId = crypto.randomUUID();
    const skippedId = crypto.randomUUID();
    const native: UnsavedGameNative = {
        list: async () => ({
            records: [{ id: corruptId, document: "{bad" }],
            skipped: [{ id: skippedId, reason: "not UTF-8" }],
            omitted: 2,
        }),
        remove: vi.fn().mockResolvedValue(null),
        clear: vi.fn().mockResolvedValue([]),
    };
    const setTabs: SetTabs = (...args) => jotai.set(tabsAtom, ...args);
    const result = await restoreUnsavedGames({
        native,
        jotaiStore: jotai,
        setTabs,
        notify,
        warn: () => undefined,
        startedFresh: () => true,
    });
    expect(result).toEqual({ kind: "done", restored: 0, kept: 4 });
    expect(native.remove).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
        enUSCatalogue.translation["UnsavedGames.KeptOnDisk_other"].replace("{{count}}", "4"),
    );
});
