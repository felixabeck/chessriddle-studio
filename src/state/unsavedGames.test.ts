import { createStore as createJotaiStore } from "jotai";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import i18n from "@/i18n";
import enUSCatalogue from "@/translation/en-US.json";
import { createStore } from "zustand/vanilla";
import type { UnsavedGameInventory } from "@/bindings/generated";
import { tabsAtom } from "@/state/atoms";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import type { Tab } from "@/state/workspaceTypes";
import type { SetTabs } from "@/utils/tabs";
import { defaultTree, type TreeState } from "@/utils/treeReducer";
import {
    clearUnsavedGamesBeforeWipe,
    decodeUnsavedGame,
    encodeUnsavedGame,
    resetUnsavedGamesForTests,
    restoreUnsavedGames,
    UnsavedGameMirror,
    UNSAVED_GAME_NAME_MAX,
    UNSAVED_GAME_WRITE_DELAY_MS,
    type UnsavedGameNative,
} from "./unsavedGames";

vi.mock("@/platform/native", () => ({
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
}));

type Deferred = { resolve: () => void; reject: (error: unknown) => void };

/** An in-memory native store whose writes can be held to simulate an operation in flight. */
function fakeNative() {
    const records = new Map<string, string>();
    const held: Deferred[] = [];
    let holdWrites = false;
    const calls: string[] = [];
    const native: UnsavedGameNative & { failRemove: number; failWrite: unknown } = {
        failRemove: 0,
        failWrite: undefined,
        write: async (id, document) => {
            calls.push(`write:${id}`);
            if (native.failWrite) throw native.failWrite;
            if (holdWrites) {
                await new Promise<void>((resolve, reject) => held.push({ resolve, reject }));
            }
            records.set(id, document);
        },
        list: async (): Promise<UnsavedGameInventory> => ({
            records: [...records].map(([id, document]) => ({ id, document })),
            skipped: [],
            omitted: 0,
        }),
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
    return {
        native,
        records,
        calls,
        hold: () => {
            holdWrites = true;
        },
        release: () => {
            holdWrites = false;
            for (const deferred of held.splice(0)) deferred.resolve();
        },
    };
}

function treeStore(dirty = false): TreeStore {
    return createStore(() => ({ ...defaultTree(), dirty })) as unknown as TreeStore;
}

/** A change that edits the game the way a move or comment does: a new root and dirty. */
function edit(store: TreeStore, comment: string) {
    const state = store.getState();
    store.setState({ root: { ...state.root, comment }, dirty: true } as never);
}

function analysisTab(id = crypto.randomUUID(), name = "Beck - Boos"): Tab {
    return { value: id, name, type: "analysis", gameOrigin: { kind: "none" } };
}

let jotai: ReturnType<typeof createJotaiStore>;
let notify: ReturnType<typeof vi.fn<(message: string) => void>>;
const stores = new Map<string, TreeStore>();

function mirrorWith(native: UnsavedGameNative) {
    return new UnsavedGameMirror({
        native,
        jotaiStore: jotai,
        notify,
        warn: () => undefined,
        treeStoreFor: (tab) => stores.get(tab.value) ?? null,
    });
}

function openTab(tab: Tab, store: TreeStore) {
    stores.set(tab.value, store);
    jotai.set(tabsAtom, (tabs) => [...tabs, tab]);
}

function closeTab(id: string) {
    jotai.set(tabsAtom, (tabs) => tabs.filter((tab) => tab.value !== id));
}

beforeAll(async () => {
    await i18n.init({
        lng: "en-US",
        resources: { "en-US": { translation: enUSCatalogue.translation } },
    });
});

beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    jotai = createJotaiStore();
    notify = vi.fn<(message: string) => void>();
    stores.clear();
    resetUnsavedGamesForTests();
});

afterEach(() => {
    vi.useRealTimers();
    resetUnsavedGamesForTests();
});

test("a record round-trips moves, comments and clock times", async () => {
    const game = createTreeStore();
    game.getState().setHeaders({ ...game.getState().headers, black: "Boos, Michael" });
    game.getState().makeMove({ payload: "e4", clock: 5_390_000 });
    game.getState().setComment("Mein Plan");
    game.getState().makeMove({ payload: "c5", clock: 5_370_000 });
    const tree = game.getState();
    expect(tree.root.children[0].clock).toBeDefined();
    const decoded = decodeUnsavedGame(
        encodeUnsavedGame({ name: "Beck - Boos", type: "analysis" }, { ...tree, dirty: true }),
    );
    expect(decoded.name).toBe("Beck - Boos");
    expect(decoded.tree.headers.black).toBe("Boos, Michael");
    const e4 = decoded.tree.root.children[0];
    expect(e4.san).toBe("e4");
    expect(e4.comment).toContain("Mein Plan");
    expect(e4.clock).toBe(tree.root.children[0].clock);
    expect(e4.children[0].clock).toBe(tree.root.children[0].children[0].clock);
    expect(decoded.tree.dirty).toBe(true);
});

test("a record is UTF-8 JSON with the plain tree envelope, never the compressed string", () => {
    const document = encodeUnsavedGame({ name: "x", type: "analysis" }, defaultTree());
    const parsed = JSON.parse(document);
    expect(parsed.version).toBe(1);
    expect(parsed.tree.state.root).toBeTypeOf("object");
    expect(() => decodeUnsavedGame("{not json")).toThrow(SyntaxError);
    expect(() => decodeUnsavedGame(JSON.stringify({ ...parsed, version: 99 }))).toThrow(/version/);
});

test("the first change that dirties a protected tab is written immediately, without quit", async () => {
    const { native, records } = fakeNative();
    const mirror = mirrorWith(native);
    const tab = analysisTab();
    const store = treeStore();
    openTab(tab, store);
    mirror.start();

    edit(store, "first");
    await vi.advanceTimersByTimeAsync(0);
    expect(records.has(tab.value)).toBe(true);
    expect(mirror.isConfirmed(tab.value)).toBe(true);

    edit(store, "second");
    expect(mirror.isConfirmed(tab.value)).toBe(false);
    await vi.advanceTimersByTimeAsync(UNSAVED_GAME_WRITE_DELAY_MS);
    expect(decodeUnsavedGame(records.get(tab.value)!).tree.root.comment).toBe("second");
    expect(mirror.isConfirmed(tab.value)).toBe(true);
});

test("a remove issued while a write is in flight leaves no record", async () => {
    const fake = fakeNative();
    const mirror = mirrorWith(fake.native);
    const tab = analysisTab();
    const store = treeStore();
    openTab(tab, store);
    mirror.start();

    fake.hold();
    edit(store, "typed");
    await vi.advanceTimersByTimeAsync(0);
    closeTab(tab.value);
    fake.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.records.has(tab.value)).toBe(false);
    expect(fake.calls).toEqual([`write:${tab.value}`, `remove:${tab.value}`]);
});

test("saving removes the record and later edits are written again", async () => {
    const { native, records } = fakeNative();
    const mirror = mirrorWith(native);
    const tab = analysisTab();
    const store = treeStore();
    openTab(tab, store);
    mirror.start();

    edit(store, "before save");
    await vi.advanceTimersByTimeAsync(0);
    expect(records.has(tab.value)).toBe(true);

    store.setState({ dirty: false } as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(records.has(tab.value)).toBe(false);

    edit(store, "after save");
    await vi.advanceTimersByTimeAsync(0);
    expect(decodeUnsavedGame(records.get(tab.value)!).tree.root.comment).toBe("after save");
});

test("closing a tab removes its record", async () => {
    const { native, records } = fakeNative();
    const mirror = mirrorWith(native);
    const tab = analysisTab();
    const store = treeStore();
    openTab(tab, store);
    mirror.start();
    edit(store, "x");
    await vi.advanceTimersByTimeAsync(0);
    closeTab(tab.value);
    await vi.advanceTimersByTimeAsync(0);
    expect(records.has(tab.value)).toBe(false);
});

test("the mirror never removes a record it did not observe", async () => {
    const { native, records, calls } = fakeNative();
    const orphan = crypto.randomUUID();
    records.set(orphan, "{}");
    const mirror = mirrorWith(native);
    openTab(analysisTab(), treeStore());
    mirror.start();
    closeTab(jotai.get(tabsAtom)[0].value);
    await mirror.drain();
    expect(records.has(orphan)).toBe(true);
    expect(calls.some((call) => call === `remove:${orphan}`)).toBe(false);
});

test("a failed remove retries without its backoff when drained", async () => {
    const fake = fakeNative();
    const mirror = mirrorWith(fake.native);
    const tab = analysisTab();
    const store = treeStore();
    openTab(tab, store);
    mirror.start();
    edit(store, "x");
    await vi.advanceTimersByTimeAsync(0);
    fake.native.failRemove = 1;
    closeTab(tab.value);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.records.has(tab.value)).toBe(true);
    expect(notify).toHaveBeenCalledOnce();
    const drained = mirror.drain();
    await vi.advanceTimersByTimeAsync(0);
    await expect(drained).resolves.toEqual({ finished: true });
    expect(fake.records.has(tab.value)).toBe(false);
});

test("a failed write marks the tab failed and notifies once with the category", async () => {
    const fake = fakeNative();
    fake.native.failWrite = { tag: "backend-error", category: "io", message: "disk full" };
    const mirror = mirrorWith(fake.native);
    const tab = analysisTab();
    const store = treeStore();
    openTab(tab, store);
    mirror.start();
    edit(store, "a");
    await vi.advanceTimersByTimeAsync(0);
    edit(store, "b");
    await vi.advanceTimersByTimeAsync(UNSAVED_GAME_WRITE_DELAY_MS);
    expect(mirror.isConfirmed(tab.value)).toBe(false);
    expect(notify).toHaveBeenCalledOnce();
    expect(String(notify.mock.calls[0][0])).toContain("io");
});

function restoreDeps(native: UnsavedGameNative, startedFresh = true) {
    return {
        native,
        jotaiStore: jotai,
        setTabs: ((...args: Parameters<SetTabs>) => jotai.set(tabsAtom, ...args)) as SetTabs,
        notify,
        warn: () => undefined,
        startedFresh: () => startedFresh,
    };
}

function recordFor(name: string, comment: string): string {
    const tree: TreeState = { ...defaultTree(), dirty: true };
    tree.root = { ...tree.root, comment };
    return encodeUnsavedGame({ name, type: "play" }, tree);
}

test("restore admits each record under its own id as a dirty analysis tab", async () => {
    const { native, records } = fakeNative();
    const id = crypto.randomUUID();
    records.set(id, recordFor("Beck - Boos", "Kommentar"));
    const result = await restoreUnsavedGames(restoreDeps(native));
    expect(result).toEqual({ kind: "done", restored: 1, kept: 0 });
    const restored = jotai.get(tabsAtom).find((tab) => tab.value === id);
    expect(restored).toMatchObject({ name: "Beck - Boos", type: "analysis" });
    expect(restored?.gameOrigin).toEqual({ kind: "none" });
    const { tabStorage } = await import("@/state/store/tabStorage");
    const stored = tabStorage.readTree(id);
    expect(stored.kind).toBe("available");
    const state = (stored as { value: { state: TreeState } }).value.state;
    expect(state.dirty).toBe(true);
    expect(state.root.comment).toBe("Kommentar");
    expect(records.has(id)).toBe(true);
});

test("restore isolates a failing record, keeps it on disk and skips open ids", async () => {
    const { native, records, calls } = fakeNative();
    const good = crypto.randomUUID();
    const broken = crypto.randomUUID();
    records.set(broken, "{broken");
    records.set(good, recordFor("good", ""));
    const result = await restoreUnsavedGames(restoreDeps(native));
    expect(result).toEqual({ kind: "done", restored: 1, kept: 1 });
    expect(records.has(broken)).toBe(true);
    expect(calls.filter((call) => call.startsWith("remove"))).toEqual([]);
    expect(jotai.get(tabsAtom).some((tab) => tab.value === good)).toBe(true);

    resetUnsavedGamesForTests();
    const again = await restoreUnsavedGames(restoreDeps(native));
    expect(again).toEqual({ kind: "done", restored: 0, kept: 2 });
});

test("restore runs once and only after a fresh start", async () => {
    const { native, records } = fakeNative();
    records.set(crypto.randomUUID(), recordFor("x", ""));
    expect(await restoreUnsavedGames(restoreDeps(native, false))).toEqual({ kind: "skipped" });
    resetUnsavedGamesForTests();
    expect((await restoreUnsavedGames(restoreDeps(native, true))).kind).toBe("done");
    expect(await restoreUnsavedGames(restoreDeps(native, true))).toEqual({ kind: "skipped" });
});

test("a failed listing restores nothing and notifies with the category", async () => {
    const { native } = fakeNative();
    native.list = () =>
        Promise.reject({ tag: "backend-error", category: "permission", message: "denied" });
    const result = await restoreUnsavedGames(restoreDeps(native));
    expect(result).toEqual({ kind: "failed", category: "permission" });
    expect(String(notify.mock.calls[0][0])).toContain("permission");
});

function fakeMirror(drain: () => Promise<{ finished: boolean }>) {
    return { pause: vi.fn(), resume: vi.fn(), drain: vi.fn(drain) };
}

test("clear deletes native records before wiping and resumes nothing on success", async () => {
    const order: string[] = [];
    const mirror = fakeMirror(async () => ({ finished: true }));
    await clearUnsavedGamesBeforeWipe({
        mirror,
        native: {
            clear: async () => {
                order.push("clear");
                return [];
            },
        },
        wipe: () => order.push("wipe"),
    });
    expect(order).toEqual(["clear", "wipe"]);
    expect(mirror.pause).toHaveBeenCalledOnce();
    expect(mirror.resume).not.toHaveBeenCalled();
});

test.each([
    ["leftover ids", async () => ({ finished: true }), async () => ["a", "b"], "2"],
    ["an incomplete drain", async () => ({ finished: false }), async () => [], "still"],
    [
        "a thrown drain",
        async () => {
            throw new Error("boom");
        },
        async () => [],
        "unexpected",
    ],
    [
        "a thrown clear",
        async () => ({ finished: true }),
        async () => {
            throw { tag: "backend-error", category: "io", message: "x" };
        },
        "io",
    ],
])(
    "clear with %s keeps the session, resumes and shows its own notice",
    async (_, drain, clear, text) => {
        const mirror = fakeMirror(drain);
        const wipe = vi.fn();
        const error = await clearUnsavedGamesBeforeWipe({
            mirror,
            native: { clear: clear as () => Promise<string[]> },
            wipe,
        }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        expect(String((error as Error).message)).toContain(text);
        expect(wipe).not.toHaveBeenCalled();
        expect(mirror.resume).toHaveBeenCalledOnce();
    },
);

test("resume after an aborted clear rewrites every dirty tab", async () => {
    const { native, records } = fakeNative();
    const mirror = mirrorWith(native);
    const tab = analysisTab();
    const store = treeStore();
    openTab(tab, store);
    mirror.start();
    edit(store, "x");
    await vi.advanceTimersByTimeAsync(0);
    mirror.pause();
    await native.clear();
    expect(mirror.isConfirmed(tab.value)).toBe(true);
    mirror.resume();
    expect(mirror.isConfirmed(tab.value)).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(records.has(tab.value)).toBe(true);
});

test("a write queued behind an in-flight write is dropped when the tab is closed", async () => {
    const fake = fakeNative();
    const mirror = mirrorWith(fake.native);
    const tab = analysisTab();
    const store = treeStore();
    openTab(tab, store);
    mirror.start();

    fake.hold();
    edit(store, "first");
    await vi.advanceTimersByTimeAsync(0);
    edit(store, "second");
    await vi.advanceTimersByTimeAsync(UNSAVED_GAME_WRITE_DELAY_MS);
    closeTab(tab.value);
    fake.release();
    await vi.advanceTimersByTimeAsync(0);
    await mirror.drain();
    expect(fake.calls).toEqual([`write:${tab.value}`, `remove:${tab.value}`]);
    expect(fake.records.has(tab.value)).toBe(false);
});

test("a save whose delete failed never deletes the copy of later edits", async () => {
    const fake = fakeNative();
    const mirror = mirrorWith(fake.native);
    const tab = analysisTab();
    const store = treeStore();
    openTab(tab, store);
    mirror.start();
    edit(store, "before save");
    await vi.advanceTimersByTimeAsync(0);

    fake.native.failRemove = 1;
    store.setState({ dirty: false } as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.records.has(tab.value)).toBe(true);

    edit(store, "after save");
    await vi.advanceTimersByTimeAsync(0);
    expect(mirror.isConfirmed(tab.value)).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await mirror.drain();
    expect(decodeUnsavedGame(fake.records.get(tab.value)!).tree.root.comment).toBe("after save");
    expect(mirror.isConfirmed(tab.value)).toBe(true);
});

test("a failed delete notifies with the error category", async () => {
    const fake = fakeNative();
    fake.native.remove = () =>
        Promise.reject({ tag: "backend-error", category: "permission", message: "denied" });
    const mirror = mirrorWith(fake.native);
    const tab = analysisTab();
    const store = treeStore();
    openTab(tab, store);
    mirror.start();
    edit(store, "x");
    await vi.advanceTimersByTimeAsync(0);
    closeTab(tab.value);
    await vi.advanceTimersByTimeAsync(0);
    expect(notify).toHaveBeenCalledOnce();
    expect(String(notify.mock.calls[0][0])).toContain("permission");
});

test("a record refused as too large is not retried until the game changes", async () => {
    const fake = fakeNative();
    fake.native.failWrite = { tag: "backend-error", category: "resource-limit", message: "big" };
    const mirror = mirrorWith(fake.native);
    const tab = analysisTab();
    const store = treeStore();
    openTab(tab, store);
    mirror.start();
    edit(store, "huge");
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls).toEqual([`write:${tab.value}`]);

    await mirror.drain();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.calls).toEqual([`write:${tab.value}`]);

    fake.native.failWrite = undefined;
    edit(store, "smaller");
    await vi.advanceTimersByTimeAsync(UNSAVED_GAME_WRITE_DELAY_MS);
    expect(fake.calls).toEqual([`write:${tab.value}`, `write:${tab.value}`]);
    expect(mirror.isConfirmed(tab.value)).toBe(true);
});

test("long tab names are cut on write so the record still restores", () => {
    const long = "x".repeat(5000);
    const decoded = decodeUnsavedGame(
        encodeUnsavedGame({ name: long, type: "analysis" }, defaultTree()),
    );
    expect(decoded.name).toHaveLength(UNSAVED_GAME_NAME_MAX);
});

test("restore clears the stale source stamp and linked source", async () => {
    const { native, records } = fakeNative();
    const id = crypto.randomUUID();
    const tree: TreeState = {
        ...defaultTree(),
        dirty: true,
        sourceStamp: "a".repeat(64),
        appendAttempted: true,
    };
    records.set(id, encodeUnsavedGame({ name: "file game", type: "analysis" }, tree));
    await restoreUnsavedGames(restoreDeps(native));
    const { tabStorage } = await import("@/state/store/tabStorage");
    const stored = tabStorage.readTree(id) as { value: { state: TreeState } };
    expect(stored.value.state.sourceStamp).toBeNull();
    expect(stored.value.state.appendAttempted).toBe(false);
    expect((stored.value.state as { linkedSource?: unknown }).linkedSource ?? null).toBeNull();
});
