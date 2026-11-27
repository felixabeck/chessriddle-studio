import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initializeI18n } from "@/i18n";
import { createStore } from "jotai";
import type { CollectionDescriptor, InsertedDbGame, NormalizedGame } from "@/bindings";
import { tabsAtom, updateTabById } from "@/state/atoms";
import { collectOriginalPathOwners } from "@/state/pathOwners";
import { loadWorkspace, saveWorkspace, WORKSPACE_STORAGE_KEY } from "@/state/workspace";
import { closeTreeStore, createTreeStore } from "@/state/store/tree";
import { tabStorage, TREE_STORAGE_VERSION } from "@/state/store/tabStorage";
import { serializeStorageValue } from "@/state/store/debouncedStorage";
import { getFileFreshness, removeFileFreshness } from "@/state/fileFreshness";
import { defaultTree, getNodeAtPath } from "./treeReducer";
import type { FileMetadata } from "@/components/files/file";
import {
    createTab,
    commitNewTab,
    isCurrentOriginDestination,
    saveToDatabase,
    saveToFile,
    saveToLibraryFile,
    sameOrigin,
    serializeStoreTree,
    type GameOrigin,
    type Tab,
} from "./tabs";

const native = vi.hoisted(() => ({
    collectionForDatabase: vi.fn(),
    insertDbGame: vi.fn(),
    writeDbGame: vi.fn(),
    writeGame: vi.fn(),
    readGame: vi.fn(),
    lexPgn: vi.fn(),
    countPgnGames: vi.fn(),
    resolveLinkedGame: vi.fn(),
    getDbGame: vi.fn(),
}));
const files = vi.hoisted(() => ({ pickPgnFile: vi.fn() }));
vi.mock("@/platform/tauri", () => ({ tauri: native }));
vi.mock("@/utils/files", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/utils/files")>()),
    pickPgnFile: files.pickPgnFile,
}));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("@/state/persistError", () => ({ reportPersistError: vi.fn() }));

const database = { id: { id: "draft-database" }, kind: "database" } as const;
const otherDatabase = { id: { id: "other-database" }, kind: "database" } as const;
const file = { id: { id: "linked-file" }, kind: "fileWorkspace" } as const;
const repertoireFile: FileMetadata = {
    type: "file",
    handle: { id: { id: "repertoire-file" }, kind: "fileWorkspace" },
    name: "Weiß_Caro Kann.pgn",
    numGames: 2,
    metadata: { type: "repertoire", tags: [] },
    lastModified: 1,
};
const linkedCollectionFile: FileMetadata = {
    type: "file",
    handle: file,
    name: "Linked.pgn",
    numGames: 3,
    metadata: { type: "repertoire", tags: [] },
    lastModified: 1,
};
function readyCollection(name = "Linked"): CollectionDescriptor {
    return {
        id: "collection",
        name,
        file,
        database: null,
        account: null,
        status: "ready",
        generation: "",
        omitted: 0,
        retiredDatabase: null,
        fetchSinceMs: null,
    };
}
const ids: string[] = [];
const stampA = "a".repeat(64);
const stampB = "b".repeat(64);
const inserted = (id: number): InsertedDbGame => ({ id, stamp: stampA });
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}
function fixture(origin: GameOrigin = { kind: "databaseDraft", database }, moves = true) {
    const id = crypto.randomUUID();
    ids.push(id);
    const workspace = createStore();
    const tab: Tab = { value: id, type: "analysis", name: "Draft", gameOrigin: origin };
    workspace.set(tabsAtom, [tab], id);
    const store = createTreeStore(id, {
        ...defaultTree(),
        sourceStamp: origin.kind === "database" ? stampA : null,
    });
    if (moves) store.getState().makeMove({ payload: "e4" });
    const getTab = (key: string) => workspace.get(tabsAtom).find((item) => item.value === key);
    const updateTab: Parameters<typeof saveToFile>[0]["updateTab"] = (key, update, acknowledge) =>
        updateTabById((...args) => workspace.set(tabsAtom, ...args), key, update, acknowledge);
    return {
        id,
        workspace,
        store,
        getTab,
        updateTab,
        args: () => ({ tab: getTab(id), store, getTab, updateTab, isUserSave: true }),
    };
}
beforeEach(async () => {
    await initializeI18n();
    native.collectionForDatabase.mockReset().mockResolvedValue(null);
    native.insertDbGame.mockReset().mockResolvedValue(inserted(42));
    native.writeDbGame.mockReset().mockResolvedValue(stampB);
    native.writeGame.mockReset().mockResolvedValue({ stamp: "b".repeat(64), revision: "saved" });
    native.countPgnGames.mockReset().mockResolvedValue(3);
    native.getDbGame.mockReset();
    native.resolveLinkedGame.mockReset().mockResolvedValue(null);
    files.pickPgnFile.mockReset().mockResolvedValue(null);
});
afterEach(() => {
    ids.splice(0).forEach((id) => {
        closeTreeStore(id);
        removeFileFreshness(id);
    });
    tabStorage.flush();
    sessionStorage.clear();
    localStorage.clear();
    vi.restoreAllMocks();
});

test("draft workspace round-trips, retains its handle and scrubs only a corrupt neighbour", () => {
    const f = fixture();
    const valid = f.getTab(f.id)!;
    saveWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY, {
        version: 1,
        tabs: [valid],
        activeTab: f.id,
    });
    expect(loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY).tabs).toEqual([valid]);
    expect(collectOriginalPathOwners(localStorage, sessionStorage).retainedIds).toContainEqual(
        database.id,
    );
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({
            version: 1,
            tabs: [
                valid,
                {
                    ...valid,
                    value: crypto.randomUUID(),
                    gameOrigin: { kind: "databaseDraft", database: { kind: "database" } },
                },
            ],
            activeTab: f.id,
        }),
    );
    expect(loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY).tabs).toEqual([valid]);
});

test("creating and duplicating a draft admits no database row", async () => {
    const f = fixture();
    const setTabs: Parameters<typeof createTab>[0]["setTabs"] = (...args) =>
        f.workspace.set(tabsAtom, ...args);
    const id = await createTab({
        tab: { name: "Draft", type: "analysis" },
        gameOrigin: { kind: "databaseDraft", database },
        setTabs,
    });
    expect(f.getTab(id!)?.gameOrigin).toEqual({ kind: "databaseDraft", database });
    const duplicate = commitNewTab({
        tab: { ...f.getTab(f.id)! },
        setTabs,
        seed: (target) => tabStorage.cloneDurable(f.id, target),
        existingTabIds: f.workspace.get(tabsAtom).map((tab) => tab.value),
    });
    expect(f.getTab(duplicate!)?.gameOrigin).toEqual({ kind: "databaseDraft", database });
    const copied = createTreeStore(duplicate!);
    ids.push(duplicate!);
    expect(serializeStoreTree(copied)).toEqual(serializeStoreTree(f.store));
    expect(native.insertDbGame).not.toHaveBeenCalled();
});

test.each([true, false])(
    "an aborted database creation neither seeds nor admits a tab, owned=%s",
    async (owned) => {
        const f = fixture();
        f.workspace.set(tabsAtom, [{ ...f.getTab(f.id)!, type: "new" }], f.id);
        const before = f.workspace.get(tabsAtom);
        const controller = new AbortController();
        const pending = deferred<{ kind: "found"; game: NormalizedGame }>();
        native.getDbGame.mockReturnValueOnce(pending.promise);
        const setTabs = vi.fn((...args: Parameters<Parameters<typeof createTab>[0]["setTabs"]>) =>
            f.workspace.set(tabsAtom, ...args),
        );
        const seed = vi.spyOn(tabStorage, "seed");
        const initialTree = defaultTree();
        initialTree.headers.orientation = "white";
        const opening = createTab({
            tab: { name: "Pending", type: "analysis" },
            gameOrigin: { kind: "database", database, gameId: 42 },
            initialTree,
            setTabs,
            ownerId: owned ? f.id : undefined,
            store: f.workspace,
            signal: controller.signal,
        });
        expect(native.getDbGame).toHaveBeenCalledExactlyOnceWith(database, 42, null, {
            signal: controller.signal,
        });
        controller.abort();
        pending.resolve({
            kind: "found",
            game: { id: 42, white: "White", black: "Black", moves: "*" } as NormalizedGame,
        });
        expect(await opening).toBeNull();
        expect(native.resolveLinkedGame).toHaveBeenCalledExactlyOnceWith(database, 42, null, {
            signal: controller.signal,
        });
        expect(f.workspace.get(tabsAtom)).toBe(before);
        expect(setTabs).not.toHaveBeenCalled();
        expect(seed).not.toHaveBeenCalled();
    },
);

test("explicit draft save inserts once and subsequent edited save updates the returned ID", async () => {
    const f = fixture();
    expect(await saveToFile({ ...f.args(), isUserSave: false })).toBe("cancelled");
    expect(native.collectionForDatabase).not.toHaveBeenCalled();
    expect(native.insertDbGame).not.toHaveBeenCalled();
    expect(await saveToFile(f.args())).toBe("saved");
    expect(f.getTab(f.id)?.gameOrigin).toEqual({ kind: "database", database, gameId: 42 });
    expect(f.store.getState().sourceStamp).toBe(stampA);
    f.store.getState().makeMove({ payload: "e5" });
    expect(await saveToFile(f.args())).toBe("saved");
    expect(native.insertDbGame).toHaveBeenCalledOnce();
    expect(native.writeDbGame).toHaveBeenCalledWith(
        database,
        42,
        expect.stringContaining("e5"),
        stampA,
    );
});

test("linked draft appends at the current file count and adopts the file origin", async () => {
    const f = fixture();
    native.collectionForDatabase.mockResolvedValue({
        file,
        name: "Linked",
        status: "ready",
    } as CollectionDescriptor);
    expect(await saveToFile(f.args())).toBe("saved");
    expect(native.writeGame).toHaveBeenCalledWith(file, 3, expect.stringContaining("e4"), {
        kind: "append",
    });
    expect(native.insertDbGame).not.toHaveBeenCalled();
    expect(f.getTab(f.id)?.gameOrigin).toMatchObject({
        kind: "file",
        gameNumber: 3,
        file: { handle: file },
    });
    expect(f.store.getState().storeAttempts).toEqual([]);
});

test("empty-board and confirmed native no-write rejection permit a corrected save", async () => {
    const f = fixture(undefined, false);
    expect(await saveToFile(f.args())).toMatchObject({ status: "failed" });
    expect(f.store.getState().storeAttempts ?? []).toEqual([]);
    f.store.getState().makeMove({ payload: "e4" });
    native.insertDbGame.mockRejectedValueOnce({
        tag: "backend-error",
        category: "chess-data",
        message: "No moves found",
    });
    expect(await saveToFile(f.args())).toMatchObject({ status: "failed" });
    expect(f.store.getState().storeAttempts).toEqual([]);
    expect(await saveToFile(f.args())).toBe("saved");
    expect(native.insertDbGame).toHaveBeenCalledTimes(2);
});

test("uncertain store survives ordinary saves and rehydration and refuses the same destination", async () => {
    const f = fixture({ kind: "database", database, gameId: 7 });
    native.insertDbGame.mockRejectedValueOnce(new Error("IPC disconnected"));
    expect(await saveToDatabase({ ...f.args(), database: otherDatabase })).toMatchObject({
        status: "failed",
    });
    const attempts = f.store.getState().storeAttempts;
    expect(attempts).toEqual(["database:other-database"]);
    expect(await saveToFile(f.args())).toBe("saved");
    expect(f.store.getState().storeAttempts).toEqual(attempts);
    tabStorage.flush();
    closeTreeStore(f.id);
    const cold = createTreeStore(f.id);
    expect(cold.getState().storeAttempts).toEqual(attempts);
    expect(
        await saveToDatabase({ ...f.args(), store: cold, database: otherDatabase }),
    ).toMatchObject({ status: "failed", error: { category: "applied-despite-error" } });
    expect(native.insertDbGame).toHaveBeenCalledOnce();
    expect(await saveToDatabase({ ...f.args(), store: cold, database })).toBe("saved");
    expect(cold.getState().storeAttempts).toEqual(attempts);
});

test.each([
    { linked: false, failure: "flush" },
    { linked: false, failure: "read-back" },
    { linked: true, failure: "flush" },
    { linked: true, failure: "read-back" },
])(
    "store marker $failure failure blocks native writes for linked=$linked",
    async ({ linked, failure }) => {
        const f = fixture();
        if (linked) {
            native.collectionForDatabase.mockResolvedValue({
                file,
                name: "Linked",
                status: "ready",
            } as CollectionDescriptor);
        }
        if (failure === "flush") {
            vi.spyOn(tabStorage, "flush").mockReturnValueOnce([f.id]);
        } else {
            vi.spyOn(tabStorage, "read").mockReturnValueOnce({
                version: TREE_STORAGE_VERSION,
                state: { ...f.store.getState(), storeAttempts: [] },
            });
        }
        expect(await saveToFile(f.args())).toMatchObject({
            status: "failed",
            error: { category: "unexpected" },
        });
        expect(native.insertDbGame).not.toHaveBeenCalled();
        expect(native.writeGame).not.toHaveBeenCalled();
        expect(native.writeDbGame).not.toHaveBeenCalled();
        expect(native.countPgnGames).not.toHaveBeenCalled();
        expect(f.store.getState().storeAttempts).toEqual([]);
        expect(tabStorage.read<{ storeAttempts: string[] }>(f.id)?.state.storeAttempts).toEqual([]);
        expect(f.getTab(f.id)?.gameOrigin).toEqual({ kind: "databaseDraft", database });
    },
);

test.each(["missing-stamp", "missing-revision", "transport"])(
    "uncertain linked append (%s) survives an ordinary save and rehydration and blocks retry",
    async (outcome) => {
        const f = fixture({ kind: "database", database, gameId: 7 });
        native.collectionForDatabase.mockImplementation(async (target) =>
            target === otherDatabase
                ? ({ file, name: "Linked", status: "ready" } as CollectionDescriptor)
                : null,
        );
        if (outcome === "transport") {
            native.writeGame.mockRejectedValueOnce(new Error("IPC disconnected"));
        } else {
            native.writeGame.mockResolvedValueOnce({
                stamp: outcome === "missing-stamp" ? null : "b".repeat(64),
                revision: outcome === "missing-revision" ? null : "saved",
            });
        }
        expect(await saveToDatabase({ ...f.args(), database: otherDatabase })).toMatchObject({
            status: "failed",
        });
        expect(native.writeGame).toHaveBeenCalledExactlyOnceWith(
            file,
            3,
            expect.stringContaining("e4"),
            { kind: "append" },
        );
        const attempts = ["file:linked-file"];
        expect(f.store.getState().storeAttempts).toEqual(attempts);
        expect(f.getTab(f.id)?.gameOrigin).toEqual({ kind: "database", database, gameId: 7 });
        f.store.getState().makeMove({ payload: "e5" });
        expect(await saveToFile(f.args())).toBe("saved");
        expect(native.writeDbGame).toHaveBeenCalledExactlyOnceWith(
            database,
            7,
            expect.stringContaining("e5"),
            stampA,
        );
        expect(f.store.getState().storeAttempts).toEqual(attempts);
        tabStorage.flush();
        closeTreeStore(f.id);
        const cold = createTreeStore(f.id);
        expect(cold.getState().storeAttempts).toEqual(attempts);
        expect(
            await saveToDatabase({ ...f.args(), store: cold, database: otherDatabase }),
        ).toMatchObject({ status: "failed", error: { category: "applied-despite-error" } });
        expect(native.writeGame).toHaveBeenCalledOnce();
        expect(native.countPgnGames).toHaveBeenCalledOnce();
        expect(native.insertDbGame).not.toHaveBeenCalled();
        expect(cold.getState().storeAttempts).toEqual(attempts);
    },
);

test("overlapping store submissions perform exactly one native insert and rebind", async () => {
    const f = fixture({ kind: "database", database, gameId: 7 });
    const pending = deferred<InsertedDbGame>();
    native.insertDbGame.mockReturnValueOnce(pending.promise);
    const first = saveToDatabase({ ...f.args(), database: otherDatabase });
    const second = saveToDatabase({ ...f.args(), database: otherDatabase });
    await vi.waitFor(() => expect(native.insertDbGame).toHaveBeenCalledOnce());
    pending.resolve(inserted(99));
    expect(await first).toBe("saved");
    expect(await second).toBe("saved");
    expect(f.getTab(f.id)?.gameOrigin).toEqual({
        kind: "database",
        database: otherDatabase,
        gameId: 99,
    });
    f.store.getState().setComment("Later edit");
    await saveToFile(f.args());
    expect(native.writeDbGame).toHaveBeenLastCalledWith(
        otherDatabase,
        99,
        expect.stringContaining("Later edit"),
        stampA,
    );
});

test.each([true, false])(
    "store waits for an ordinary save and blocks a subsequent user-save=%s",
    async (isUserSave) => {
        const f = fixture({ kind: "database", database, gameId: 7 });
        const order: string[] = [];
        const ordinary = deferred<string>();
        const insertion = deferred<InsertedDbGame>();
        native.writeDbGame.mockImplementationOnce(() => {
            order.push("old-save");
            return ordinary.promise;
        });
        native.insertDbGame.mockImplementationOnce(() => {
            order.push("insert");
            return insertion.promise;
        });
        const saving = saveToFile(f.args());
        const storing = saveToDatabase({ ...f.args(), database: otherDatabase });
        const queued = saveToFile({ ...f.args(), isUserSave });
        await vi.waitFor(() => expect(order).toEqual(["old-save"]));
        expect(native.insertDbGame).not.toHaveBeenCalled();
        ordinary.resolve(stampB);
        await saving;
        await vi.waitFor(() => expect(order).toEqual(["old-save", "insert"]));
        expect(native.writeDbGame).toHaveBeenCalledOnce();
        insertion.resolve(inserted(99));
        await storing;
        expect(await queued).toBe("saved");
        expect(native.writeDbGame).toHaveBeenCalledTimes(2);
        expect(native.writeDbGame).toHaveBeenLastCalledWith(
            otherDatabase,
            99,
            expect.any(String),
            stampA,
        );
    },
);

test("ownership loss after native commit retains the destination marker", async () => {
    const f = fixture();
    native.insertDbGame.mockImplementationOnce(async () => {
        f.updateTab(f.id, (previous) => ({ ...previous, gameOrigin: { kind: "none" } }));
        return inserted(99);
    });
    expect(await saveToFile(f.args())).toBe("superseded");
    expect(f.store.getState().storeAttempts).toEqual(["database:draft-database"]);
});

test("autosave queued during a draft insert preserves later edits and updates the admitted row", async () => {
    const f = fixture();
    const insertion = deferred<InsertedDbGame>();
    native.insertDbGame.mockReturnValueOnce(insertion.promise);
    const storing = saveToFile(f.args());
    await vi.waitFor(() => expect(native.insertDbGame).toHaveBeenCalledOnce());
    f.store.getState().makeMove({ payload: "e5" });
    const saving = saveToFile({ ...f.args(), isUserSave: false });
    expect(native.writeDbGame).not.toHaveBeenCalled();
    insertion.resolve(inserted(42));
    expect(await storing).toBe("superseded");
    expect(await saving).toBe("saved");
    expect(native.writeDbGame).toHaveBeenCalledWith(
        database,
        42,
        expect.stringContaining("e5"),
        stampA,
    );
    expect(f.store.getState().dirty).toBe(false);
});

test("draft saves queued behind an uncertain insert retain its marker and never insert again", async () => {
    const f = fixture();
    const insertion = deferred<InsertedDbGame>();
    native.insertDbGame.mockReturnValueOnce(insertion.promise);
    const first = saveToFile(f.args());
    await vi.waitFor(() => expect(native.insertDbGame).toHaveBeenCalledOnce());
    const autoSave = saveToFile({ ...f.args(), isUserSave: false });
    const second = saveToFile(f.args());
    insertion.reject(new Error("IPC disconnected"));
    const [firstResult, autoSaveResult, secondResult] = await Promise.all([
        first,
        autoSave,
        second,
    ]);
    expect(native.insertDbGame).toHaveBeenCalledOnce();
    expect(firstResult).toMatchObject({ status: "failed" });
    expect(autoSaveResult).toBe("cancelled");
    expect(secondResult).toEqual(firstResult);
    expect(f.store.getState().storeAttempts).toEqual(["database:draft-database"]);
    tabStorage.flush();
    expect(tabStorage.read<{ storeAttempts: string[] }>(f.id)?.state.storeAttempts).toEqual([
        "database:draft-database",
    ]);
});

test("concurrent different destinations wait for one another and each rebinds to its own target", async () => {
    const f = fixture();
    const insertion = deferred<InsertedDbGame>();
    native.insertDbGame.mockReturnValueOnce(insertion.promise).mockResolvedValueOnce(inserted(99));
    const first = saveToDatabase({ ...f.args(), database });
    const second = saveToDatabase({ ...f.args(), database: otherDatabase });
    await vi.waitFor(() => expect(native.insertDbGame).toHaveBeenCalledOnce());
    insertion.resolve(inserted(42));
    expect(await first).toBe("saved");
    expect(await second).toBe("saved");
    expect(native.insertDbGame).toHaveBeenNthCalledWith(2, otherDatabase, expect.any(String));
    expect(f.getTab(f.id)?.gameOrigin).toEqual({
        kind: "database",
        database: otherDatabase,
        gameId: 99,
    });
});

test("draft save A, store B, draft save A inserts each once then updates the current admitted row", async () => {
    const f = fixture();
    const firstInsert = deferred<InsertedDbGame>();
    const secondInsert = deferred<InsertedDbGame>();
    const finalWrite = deferred<string>();
    native.insertDbGame
        .mockReturnValueOnce(firstInsert.promise)
        .mockReturnValueOnce(secondInsert.promise);
    native.writeDbGame.mockReturnValueOnce(finalWrite.promise);
    const first = saveToFile(f.args());
    expect(saveToFile(f.args())).toBe(first);
    await vi.waitFor(() => expect(native.insertDbGame).toHaveBeenCalledOnce());
    const second = saveToDatabase({ ...f.args(), database: otherDatabase });
    expect(saveToDatabase({ ...f.args(), database: otherDatabase })).toBe(second);
    const final = saveToFile(f.args());
    expect(native.insertDbGame).toHaveBeenCalledExactlyOnceWith(
        database,
        expect.stringContaining("e4"),
    );
    expect(native.writeDbGame).not.toHaveBeenCalled();
    firstInsert.resolve(inserted(42));
    expect(await first).toBe("saved");
    await vi.waitFor(() => expect(native.insertDbGame).toHaveBeenCalledTimes(2));
    expect(native.insertDbGame).toHaveBeenNthCalledWith(2, otherDatabase, expect.any(String));
    expect(f.getTab(f.id)?.gameOrigin).toEqual({ kind: "database", database, gameId: 42 });
    expect(native.writeDbGame).not.toHaveBeenCalled();
    secondInsert.resolve(inserted(99));
    expect(await second).toBe("saved");
    await vi.waitFor(() => expect(native.writeDbGame).toHaveBeenCalledOnce());
    expect(native.insertDbGame).toHaveBeenCalledTimes(2);
    expect(native.writeDbGame).toHaveBeenCalledExactlyOnceWith(
        otherDatabase,
        99,
        expect.stringContaining("e4"),
        stampA,
    );
    finalWrite.resolve(stampB);
    expect(await final).toBe("saved");
    expect(f.getTab(f.id)?.gameOrigin).toEqual({
        kind: "database",
        database: otherDatabase,
        gameId: 99,
    });
    expect(f.store.getState().storeAttempts).toEqual([]);
});

test("acknowledged insert finalizes its exact successor before a workspace observer throws", async () => {
    const f = fixture();
    const failure = new Error("workspace observer failed");
    const unsubscribe = f.workspace.sub(tabsAtom, () => {
        throw failure;
    });
    const pgn = serializeStoreTree(f.store);
    const result = await saveToFile(f.args());
    unsubscribe();
    expect(result).toMatchObject({
        status: "failed",
        error: { message: expect.stringContaining("workspace observer failed") },
    });
    expect(f.getTab(f.id)?.gameOrigin).toEqual({ kind: "database", database, gameId: 42 });
    expect(f.store.getState().dirty).toBe(false);
    expect(f.store.getState().storeAttempts).toEqual([]);
    expect(serializeStoreTree(f.store)).toBe(pgn);
});

test("duplicate database trees retain their stamp and the second save refuses stale edits", async () => {
    const f = fixture({ kind: "database", database, gameId: 812 });
    tabStorage.flush();
    const duplicate = commitNewTab({
        tab: { ...f.getTab(f.id)! },
        setTabs: (...args) => f.workspace.set(tabsAtom, ...args),
        seed: (target) => tabStorage.cloneDurable(f.id, target),
        existingTabIds: [f.id],
    })!;
    ids.push(duplicate);
    const second = createTreeStore(duplicate);
    expect(tabStorage.read<{ sourceStamp: string }>(duplicate)?.state.sourceStamp).toBe(stampA);
    f.store.getState().makeMove({ payload: "e5" });
    f.store.getState().goToPrevious();
    f.store.getState().makeMove({ payload: "c5" });
    second.getState().setComment("Second tab comments");
    const refusedPgn = serializeStoreTree(second);
    native.writeDbGame.mockResolvedValueOnce(stampB).mockRejectedValueOnce({
        tag: "backend-error",
        category: "stale-game",
        message: "stale game",
    });
    expect(await saveToFile(f.args())).toBe("saved");
    expect(f.store.getState()).toMatchObject({ sourceStamp: stampB, dirty: false });
    expect(getFileFreshness(f.id)).toMatchObject({ state: "verified", verifiedRevision: null });
    expect(await saveToFile({ ...f.args(), tab: f.getTab(duplicate), store: second })).toBe(
        "conflict",
    );
    expect(native.writeDbGame).toHaveBeenNthCalledWith(2, database, 812, refusedPgn, stampA);
    expect(second.getState()).toMatchObject({ sourceStamp: stampA, dirty: true });
    expect(serializeStoreTree(second)).toBe(refusedPgn);
    expect(getFileFreshness(duplicate)).toMatchObject({
        state: "conflict",
        conflictReason: "save-refused",
    });
    tabStorage.flush();
    expect(
        tabStorage.read<{ sourceStamp: string; dirty: boolean }>(duplicate)?.state,
    ).toMatchObject({ sourceStamp: stampA, dirty: true });
});

test("a pre-change persisted database tree hydrates without a stamp and refuses without writing", async () => {
    const f = fixture({ kind: "database", database, gameId: 812 });
    const legacy = { ...f.store.getState() };
    delete (legacy as Partial<typeof legacy>).sourceStamp;
    tabStorage.flush();
    closeTreeStore(f.id);
    sessionStorage.setItem(f.id, serializeStorageValue({ version: 0, state: legacy }));
    const cold = createTreeStore(f.id);
    expect(cold.getState().sourceStamp).toBeNull();
    const pgn = serializeStoreTree(cold);
    expect(await saveToFile({ ...f.args(), store: cold })).toBe("conflict");
    expect(native.writeDbGame).not.toHaveBeenCalled();
    expect(cold.getState().dirty).toBe(true);
    expect(serializeStoreTree(cold)).toBe(pgn);
    expect(getFileFreshness(f.id)).toMatchObject({
        state: "conflict",
        conflictReason: "save-refused",
    });
});

test("database saves advance the persisted stamp and preserve edits made during a write", async () => {
    const f = fixture({ kind: "database", database, gameId: 812 });
    expect(await saveToFile(f.args())).toBe("saved");
    f.store.getState().setComment("Before write");
    const write = deferred<string>();
    native.writeDbGame.mockReturnValueOnce(write.promise);
    const pending = saveToFile(f.args());
    await vi.waitFor(() => expect(native.writeDbGame).toHaveBeenCalledTimes(2));
    expect(native.writeDbGame).toHaveBeenLastCalledWith(database, 812, expect.any(String), stampB);
    f.store.getState().setComment("Edited during write");
    write.resolve("c".repeat(64));
    expect(await pending).toBe("superseded");
    expect(f.store.getState()).toMatchObject({ sourceStamp: "c".repeat(64), dirty: true });
    tabStorage.flush();
    expect(tabStorage.read<{ sourceStamp: string; dirty: boolean }>(f.id)?.state).toMatchObject({
        sourceStamp: "c".repeat(64),
        dirty: true,
    });
    expect(await saveToFile(f.args())).toBe("saved");
    expect(native.writeDbGame).toHaveBeenLastCalledWith(
        database,
        812,
        expect.stringContaining("Edited during write"),
        "c".repeat(64),
    );
});

test("an explicit database save waits for autosave and uses its returned stamp", async () => {
    const f = fixture({ kind: "database", database, gameId: 812 });
    const write = deferred<string>();
    native.writeDbGame.mockReturnValueOnce(write.promise);
    const autoSave = saveToFile({ ...f.args(), isUserSave: false });
    const explicitSave = saveToFile(f.args());
    await vi.waitFor(() => expect(native.writeDbGame).toHaveBeenCalledOnce());
    expect(native.writeDbGame).toHaveBeenLastCalledWith(database, 812, expect.any(String), stampA);
    write.resolve(stampB);
    expect(await autoSave).toBe("saved");
    expect(await explicitSave).toBe("saved");
    expect(native.writeDbGame).toHaveBeenCalledTimes(2);
    expect(native.writeDbGame).toHaveBeenLastCalledWith(database, 812, expect.any(String), stampB);
    expect(getFileFreshness(f.id).state).toBe("verified");
});

test("an explicit file save waits for autosave and uses its returned stamp", async () => {
    const f = fixture({
        kind: "file",
        gameNumber: 0,
        file: {
            type: "file",
            handle: file,
            name: "Games",
            numGames: 1,
            metadata: { type: "game", tags: [] },
            lastModified: 0,
        },
    });
    f.store.getState().setSourceStamp(stampA);
    native.readGame
        .mockResolvedValueOnce({ pgn: "*", stamp: stampA, present: true })
        .mockResolvedValueOnce({ pgn: "*", stamp: stampB, present: true });
    native.lexPgn.mockResolvedValue([{ type: "Outcome", value: "*" }]);
    const write = deferred<{ stamp: string; revision: string }>();
    native.writeGame.mockReturnValueOnce(write.promise);
    const autoSave = saveToFile({ ...f.args(), isUserSave: false });
    const explicitSave = saveToFile(f.args());
    await vi.waitFor(() => expect(native.writeGame).toHaveBeenCalledOnce());
    expect(native.writeGame).toHaveBeenLastCalledWith(file, 0, expect.any(String), {
        kind: "game",
        stamp: stampA,
    });
    write.resolve({ stamp: stampB, revision: "saved" });
    expect(await autoSave).toBe("saved");
    expect(await explicitSave).toBe("saved");
    expect(native.writeGame).toHaveBeenCalledTimes(2);
    expect(native.readGame.mock.calls).toEqual([
        [file, 0, undefined],
        [file, 0, undefined],
    ]);
    expect(native.lexPgn).toHaveBeenCalledTimes(2);
    expect(native.writeGame).toHaveBeenLastCalledWith(file, 0, expect.any(String), {
        kind: "game",
        stamp: stampB,
    });
    expect(getFileFreshness(f.id).state).toBe("verified");
});

test("a missing database game makes the tab unavailable and preserves dirty edits", async () => {
    const f = fixture({ kind: "database", database, gameId: 812 });
    const pgn = serializeStoreTree(f.store);
    const root = f.store.getState().root;
    native.writeDbGame.mockRejectedValueOnce({
        tag: "backend-error",
        category: "missing-resource",
        message: "Game not found",
    });
    expect(await saveToFile(f.args())).toBe("conflict");
    expect(getFileFreshness(f.id).state).toBe("unavailable");
    expect(f.store.getState()).toMatchObject({ dirty: true, sourceStamp: stampA });
    expect(f.store.getState().root).toBe(root);
    expect(serializeStoreTree(f.store)).toBe(pgn);
});

test("fileDraft workspace round-trips, retains its handle and scrubs only a corrupt neighbour", () => {
    const f = fixture({ kind: "fileDraft", file: repertoireFile });
    const valid = f.getTab(f.id)!;
    saveWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY, {
        version: 1,
        tabs: [valid],
        activeTab: f.id,
    });
    expect(loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY).tabs).toEqual([valid]);
    const owners = collectOriginalPathOwners(localStorage, sessionStorage);
    expect(owners.retainedIds).toContainEqual(repertoireFile.handle.id);
    expect(owners.trustedFamilies).toContain("sessionWorkspace");
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({
            version: 1,
            tabs: [
                valid,
                {
                    ...valid,
                    value: crypto.randomUUID(),
                    gameOrigin: { kind: "fileDraft", file: { type: "file" } },
                },
            ],
            activeTab: f.id,
        }),
    );
    expect(loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY).tabs).toEqual([valid]);
});

test("sameOrigin matches fileDrafts of one file and distinguishes different files", () => {
    const left: GameOrigin = { kind: "fileDraft", file: repertoireFile };
    const sameFile: GameOrigin = {
        kind: "fileDraft",
        file: { ...repertoireFile, numGames: 9, name: "other-name.pgn" },
    };
    const other: GameOrigin = { kind: "fileDraft", file: linkedCollectionFile };
    expect(sameOrigin(left, left)).toBe(true);
    expect(sameOrigin(left, sameFile)).toBe(true);
    expect(sameOrigin(left, other)).toBe(false);
    expect(sameOrigin(left, { kind: "databaseDraft", database })).toBe(false);
});

test("isCurrentOriginDestination matches only the tab's persisted database or file origin", () => {
    const tabWith = (gameOrigin: GameOrigin): Tab => ({
        value: "tab-id",
        type: "analysis",
        name: "Game",
        gameOrigin,
    });
    const dbTab = tabWith({ kind: "database", database, gameId: 7 });
    const fileTab = tabWith({ kind: "file", file: repertoireFile, gameNumber: 1 });
    const linkedFileTab = tabWith({ kind: "file", file: linkedCollectionFile, gameNumber: 2 });
    const tempFileTab = tabWith({ kind: "temp_file", file: repertoireFile, gameNumber: 0 });
    const dbDraftTab = tabWith({ kind: "databaseDraft", database });
    const fileDraftTab = tabWith({ kind: "fileDraft", file: repertoireFile });
    const noneTab = tabWith({ kind: "none" });

    expect(isCurrentOriginDestination(dbTab, { kind: "database", database })).toBe(true);
    const reloadedDatabase = { id: { id: "draft-database" }, kind: "database" } as const;
    expect(reloadedDatabase).not.toBe(database);
    expect(
        isCurrentOriginDestination(dbTab, { kind: "database", database: reloadedDatabase }),
    ).toBe(true);
    expect(isCurrentOriginDestination(dbTab, { kind: "database", database: otherDatabase })).toBe(
        false,
    );
    expect(isCurrentOriginDestination(dbTab, { kind: "file", file })).toBe(false);

    expect(isCurrentOriginDestination(fileTab, { kind: "file", file: repertoireFile.handle })).toBe(
        true,
    );
    const reloadedFileHandle = { id: { id: "repertoire-file" }, kind: "fileWorkspace" } as const;
    expect(reloadedFileHandle).not.toBe(repertoireFile.handle);
    expect(isCurrentOriginDestination(fileTab, { kind: "file", file: reloadedFileHandle })).toBe(
        true,
    );
    expect(isCurrentOriginDestination(fileTab, { kind: "file", file })).toBe(false);
    expect(isCurrentOriginDestination(fileTab, { kind: "database", database })).toBe(false);

    expect(
        isCurrentOriginDestination(linkedFileTab, { kind: "file", file: readyCollection().file }),
    ).toBe(true);

    expect(
        isCurrentOriginDestination(tempFileTab, { kind: "file", file: repertoireFile.handle }),
    ).toBe(false);
    expect(isCurrentOriginDestination(dbDraftTab, { kind: "database", database })).toBe(false);
    expect(
        isCurrentOriginDestination(fileDraftTab, { kind: "file", file: repertoireFile.handle }),
    ).toBe(false);
    expect(isCurrentOriginDestination(noneTab, { kind: "database", database })).toBe(false);
    expect(isCurrentOriginDestination(noneTab, { kind: "file", file: repertoireFile.handle })).toBe(
        false,
    );
    expect(isCurrentOriginDestination(undefined, { kind: "database", database })).toBe(false);
    expect(isCurrentOriginDestination(null, { kind: "file", file: repertoireFile.handle })).toBe(
        false,
    );
});

test("fileDraft user save appends at the re-counted index and rebinds with real metadata", async () => {
    const f = fixture({ kind: "fileDraft", file: repertoireFile });
    native.countPgnGames.mockResolvedValue(5);
    expect(await saveToFile(f.args())).toBe("saved");
    expect(native.writeGame).toHaveBeenCalledExactlyOnceWith(
        repertoireFile.handle,
        5,
        expect.stringContaining("e4"),
        { kind: "append" },
    );
    expect(files.pickPgnFile).not.toHaveBeenCalled();
    expect(f.getTab(f.id)?.gameOrigin).toEqual({
        kind: "file",
        gameNumber: 5,
        file: { ...repertoireFile, numGames: 6 },
    });
    expect(f.store.getState().storeAttempts).toEqual([]);
});

test("a non-user save of a fileDraft never writes", async () => {
    const f = fixture({ kind: "fileDraft", file: repertoireFile });
    expect(await saveToFile({ ...f.args(), isUserSave: false })).toBe("cancelled");
    expect(native.writeGame).not.toHaveBeenCalled();
    expect(native.countPgnGames).not.toHaveBeenCalled();
    expect(files.pickPgnFile).not.toHaveBeenCalled();
    expect(f.getTab(f.id)?.gameOrigin).toEqual({ kind: "fileDraft", file: repertoireFile });
});

test("a non-flight draft save writes nothing", async () => {
    const f = fixture({ kind: "fileDraft", file: repertoireFile });
    const write = deferred<{ stamp: string; revision: string }>();
    native.writeGame.mockReturnValueOnce(write.promise);
    const storing = saveToFile(f.args());
    await vi.waitFor(() => expect(native.writeGame).toHaveBeenCalledOnce());
    const autoSave = saveToFile({ ...f.args(), isUserSave: false });
    write.reject(new Error("IPC disconnected"));
    expect(await storing).toMatchObject({ status: "failed" });
    expect(await autoSave).toBe("cancelled");
    expect(native.writeGame).toHaveBeenCalledOnce();
    expect(files.pickPgnFile).not.toHaveBeenCalled();
    expect(f.getTab(f.id)?.gameOrigin).toEqual({ kind: "fileDraft", file: repertoireFile });
});

test("a rejecting store to file A does not fail a later store to file B", async () => {
    const f = fixture({ kind: "none" });
    const otherFile: FileMetadata = {
        ...repertoireFile,
        handle: { id: { id: "other-repertoire" }, kind: "fileWorkspace" },
        name: "other.pgn",
    };
    let flushes = 0;
    vi.spyOn(tabStorage, "flush").mockImplementation(() => {
        flushes += 1;
        if (flushes === 2) throw new Error("first store exploded");
        return [];
    });
    const countA = deferred<number>();
    native.countPgnGames.mockReturnValueOnce(countA.promise).mockResolvedValue(4);
    const first = saveToLibraryFile({ ...f.args(), file: repertoireFile });
    await vi.waitFor(() => expect(native.countPgnGames).toHaveBeenCalledOnce());
    const second = saveToLibraryFile({ ...f.args(), file: otherFile });
    expect(native.writeGame).not.toHaveBeenCalled();
    countA.reject(new Error("count A failed"));
    await expect(first).rejects.toThrow("first store exploded");
    expect(await second).toBe("saved");
    expect(native.writeGame).toHaveBeenCalledExactlyOnceWith(
        otherFile.handle,
        4,
        expect.stringContaining("e4"),
        { kind: "append" },
    );
});

test("saveToLibraryFile appends, rebinds as Save-As, and keeps the file's real type", async () => {
    const f = fixture({ kind: "none" });
    native.countPgnGames.mockResolvedValue(4);
    expect(await saveToLibraryFile({ ...f.args(), file: repertoireFile })).toBe("saved");
    expect(native.writeGame).toHaveBeenCalledExactlyOnceWith(
        repertoireFile.handle,
        4,
        expect.stringContaining("e4"),
        { kind: "append" },
    );
    expect(f.getTab(f.id)?.gameOrigin).toMatchObject({
        kind: "file",
        gameNumber: 4,
        file: { handle: repertoireFile.handle, metadata: { type: "repertoire" }, numGames: 5 },
    });
});

test("a repeat submission to the same Library file joins one write", async () => {
    const f = fixture({ kind: "none" });
    const pending = deferred<{ stamp: string; revision: string }>();
    native.writeGame.mockReturnValueOnce(pending.promise);
    const first = saveToLibraryFile({ ...f.args(), file: repertoireFile });
    const second = saveToLibraryFile({ ...f.args(), file: repertoireFile });
    expect(second).toBe(first);
    await vi.waitFor(() => expect(native.writeGame).toHaveBeenCalledOnce());
    pending.resolve({ stamp: stampB, revision: "saved" });
    expect(await first).toBe("saved");
    expect(await second).toBe("saved");
    expect(native.writeGame).toHaveBeenCalledOnce();
});

test("collection draft Ctrl+S, collection database store and Library file store join one write", async () => {
    const f = fixture();
    native.collectionForDatabase.mockResolvedValue(readyCollection());
    const pending = deferred<{ stamp: string; revision: string }>();
    native.writeGame.mockReturnValueOnce(pending.promise);
    const ctrlS = saveToFile(f.args());
    const saveDb = saveToDatabase({ ...f.args(), database });
    const saveFile = saveToLibraryFile({ ...f.args(), file: linkedCollectionFile });
    expect(saveDb).toBe(ctrlS);
    await vi.waitFor(() => expect(native.writeGame).toHaveBeenCalledOnce());
    pending.resolve({ stamp: stampB, revision: "saved" });
    expect(await ctrlS).toBe("saved");
    expect(await saveDb).toBe("saved");
    expect(await saveFile).toBe("saved");
    expect(native.writeGame).toHaveBeenCalledExactlyOnceWith(
        file,
        3,
        expect.stringContaining("e4"),
        {
            kind: "append",
        },
    );
    expect(native.insertDbGame).not.toHaveBeenCalled();
});

test("the same three stores join one write while collection lookup is still pending", async () => {
    const f = fixture();
    const lookup = deferred<CollectionDescriptor>();
    native.collectionForDatabase.mockReturnValue(lookup.promise);
    const ctrlS = saveToFile(f.args());
    const saveDb = saveToDatabase({ ...f.args(), database });
    const saveFile = saveToLibraryFile({ ...f.args(), file: linkedCollectionFile });
    expect(saveDb).toBe(ctrlS);
    expect(native.writeGame).not.toHaveBeenCalled();
    expect(native.countPgnGames).not.toHaveBeenCalled();
    lookup.resolve(readyCollection());
    await vi.waitFor(() => expect(native.writeGame).toHaveBeenCalledOnce());
    expect(await ctrlS).toBe("saved");
    expect(await saveDb).toBe("saved");
    expect(await saveFile).toBe("saved");
    expect(native.writeGame).toHaveBeenCalledOnce();
    expect(native.insertDbGame).not.toHaveBeenCalled();
});

test("a rejected collection lookup is a typed failure with no write and no marker", async () => {
    const f = fixture();
    native.collectionForDatabase.mockRejectedValueOnce(new Error("lookup failed"));
    expect(await saveToFile(f.args())).toMatchObject({
        status: "failed",
        error: { message: expect.stringContaining("lookup failed") },
    });
    expect(native.insertDbGame).not.toHaveBeenCalled();
    expect(native.writeGame).not.toHaveBeenCalled();
    expect(native.countPgnGames).not.toHaveBeenCalled();
    expect(f.store.getState().storeAttempts ?? []).toEqual([]);
    expect(f.getTab(f.id)?.gameOrigin).toEqual({ kind: "databaseDraft", database });
});

test.each([
    {
        name: "file draft",
        run: (f: ReturnType<typeof fixture>) => saveToFile(f.args()),
        origin: { kind: "fileDraft" as const, file: repertoireFile },
    },
    {
        name: "file target",
        run: (f: ReturnType<typeof fixture>) =>
            saveToLibraryFile({ ...f.args(), file: repertoireFile }),
        origin: { kind: "none" as const },
    },
    {
        name: "database",
        run: (f: ReturnType<typeof fixture>) => saveToDatabase({ ...f.args(), database }),
        origin: { kind: "databaseDraft" as const, database },
    },
])("empty tree is refused with no write and no marker for $name", async ({ run, origin }) => {
    const f = fixture(origin, false);
    const result = await run(f);
    expect(result).toMatchObject({
        status: "failed",
        error: { category: "validation", message: "Add at least one move before saving." },
    });
    expect(native.writeGame).not.toHaveBeenCalled();
    expect(native.insertDbGame).not.toHaveBeenCalled();
    expect(native.countPgnGames).not.toHaveBeenCalled();
    expect(f.store.getState().storeAttempts ?? []).toEqual([]);
});

test("a countPgnGames rejection is a no-write and clears the marker", async () => {
    const f = fixture({ kind: "fileDraft", file: repertoireFile });
    native.countPgnGames.mockRejectedValueOnce({
        tag: "backend-error",
        category: "io",
        message: "count failed",
    });
    const result = await saveToFile(f.args());
    expect(result).toMatchObject({
        status: "failed",
        error: { message: "count failed" },
    });
    expect(native.writeGame).not.toHaveBeenCalled();
    expect(f.store.getState().storeAttempts ?? []).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("may already have been added");
});

test("fileDraft stale-game and uncertain append keep their messages", async () => {
    const f = fixture({ kind: "fileDraft", file: repertoireFile });
    native.writeGame.mockRejectedValueOnce({
        tag: "backend-error",
        category: "stale-game",
        message: "stale game",
    });
    expect(await saveToFile(f.args())).toMatchObject({
        status: "failed",
        error: { message: "stale game" },
    });
    expect(f.store.getState().storeAttempts ?? []).toEqual([]);
    native.writeGame.mockResolvedValueOnce({ stamp: null, revision: null });
    expect(await saveToFile(f.args())).toMatchObject({
        status: "failed",
        error: { category: "applied-despite-error" },
    });
    expect(f.store.getState().storeAttempts).toEqual(["file:repertoire-file"]);
});

test.each([
    { name: "the reached position", target: [0, 0], expected: [0, 0] },
    { name: "the start without a match", target: null, expected: [] },
])("createTab with a target position opens at $name", async ({ target, expected }) => {
    const sourceId = crypto.randomUUID();
    ids.push(sourceId);
    const source = createTreeStore(sourceId, defaultTree());
    for (const san of ["e4", "e5", "Nf3"]) source.getState().makeMove({ payload: san });
    const initialTree = { ...defaultTree(), root: source.getState().root };
    const targetFen = target
        ? getNodeAtPath(initialTree.root, target).fen
        : "8/8/8/8/8/8/8/K6k w - - 0 1";
    const workspace = createStore();
    const id = await createTab({
        tab: { name: "Game", type: "analysis" },
        setTabs: (...args) => workspace.set(tabsAtom, ...args),
        initialTree,
        targetFens: [targetFen],
    });
    expect(id).not.toBeNull();
    ids.push(id!);
    expect(tabStorage.read<{ position: number[] }>(id!)?.state.position).toEqual(expected);
});
