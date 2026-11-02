import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initializeI18n } from "@/i18n";
import { createStore } from "jotai";
import type { CollectionDescriptor, InsertedDbGame } from "@/bindings";
import { tabsAtom, updateTabById } from "@/state/atoms";
import { collectOriginalPathOwners } from "@/state/pathOwners";
import { loadWorkspace, saveWorkspace, WORKSPACE_STORAGE_KEY } from "@/state/workspace";
import { closeTreeStore, createTreeStore } from "@/state/store/tree";
import { tabStorage, TREE_STORAGE_VERSION } from "@/state/store/tabStorage";
import { serializeStorageValue } from "@/state/store/debouncedStorage";
import { getFileFreshness, removeFileFreshness } from "@/state/fileFreshness";
import { defaultTree } from "./treeReducer";
import {
    createTab,
    commitNewTab,
    saveToDatabase,
    saveToFile,
    serializeStoreTree,
    type GameOrigin,
    type Tab,
} from "./tabs";

const native = vi.hoisted(() => ({
    collectionForDatabase: vi.fn(),
    insertDbGame: vi.fn(),
    writeDbGame: vi.fn(),
    writeGame: vi.fn(),
    countPgnGames: vi.fn(),
    resolveLinkedGame: vi.fn(),
}));
vi.mock("@/platform/tauri", () => ({ tauri: native }));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("@/state/persistError", () => ({ reportPersistError: vi.fn() }));

const database = { id: { id: "draft-database" }, kind: "database" } as const;
const otherDatabase = { id: { id: "other-database" }, kind: "database" } as const;
const file = { id: { id: "linked-file" }, kind: "fileWorkspace" } as const;
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
