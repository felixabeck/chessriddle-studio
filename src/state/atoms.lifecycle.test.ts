import { createStore, getDefaultStore } from "jotai";
import { afterEach, expect, test, vi } from "vitest";
import { defaultTree } from "@/utils/treeReducer";
import { denyStorageRemoval } from "@/utils/tests/storageMocks";
import { errorUnlessCancelled } from "@/platform/errors";
import enUSCatalogue from "@/translation/en-US.json";
import {
    activeTabAtom,
    closeWorkspaceTabAtom,
    closingTabsAtom,
    disposeTabAtoms,
    engineMovesFamily,
    engineProgressFamily,
    gameIdFamily,
    pendingGameStartFamily,
    tabsAtom,
    tabEngineSettingsFamily,
    tabFamily,
} from "./atoms";
import { tabStorage, TabStorageRepository } from "./store/tabStorage";
import {
    captureReportOwner,
    closeTreeStore,
    createTreeStore,
    retryTreeStoreStorage,
    type TreeStoreState,
} from "./store/tree";
import {
    commitNewTab,
    createTab,
    getTabTreeKey,
    replaceFileGame,
    replaceNewTab,
    type Tab,
} from "@/utils/tabs";
import {
    loadWorkspace,
    MAX_PENDING_TREE_REMOVALS,
    MAX_PROTECTED_TREE_KEYS,
    readStoredWorkspaceValue,
    WORKSPACE_STORAGE_KEY,
} from "./workspace";
import { deserializeStorageValue, serializeStorageValue } from "./store/debouncedStorage";
import { getFileFreshness, setFileFreshness } from "./fileFreshness";

const persistError = vi.hoisted(() => ({ reportPersistError: vi.fn() }));
vi.mock("./persistError", () => persistError);

const treeOverflowMessage =
    "ChessRiddle Studio could not finish deleting every closed board. The newest deletions were kept. Quit ChessRiddle Studio to discard the leftover saved games.";
const puzzleOverflowMessage =
    "ChessRiddle Studio could not finish deleting every old puzzle session. The newest deletions were kept. Quit ChessRiddle Studio to discard the leftover puzzle sessions.";

const replacementTabIds = new Set<string>();

async function importFreshAtoms() {
    const atoms = await import("./atoms");
    return atoms;
}

afterEach(() => {
    persistError.reportPersistError.mockClear();
    vi.restoreAllMocks();
    for (const tabId of replacementTabIds) {
        closeTreeStore(tabId);
        tabStorage.remove(tabId);
    }
    replacementTabIds.clear();
});

function refuseWorkspaceWrites() {
    const originalSetItem = Storage.prototype.setItem;
    return vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
            if (key === WORKSPACE_STORAGE_KEY) {
                throw new DOMException("quota", "QuotaExceededError");
            }
            return originalSetItem.call(this, key, value);
        });
}

function backgroundPuzzleCloseFixture(treePresent = true) {
    sessionStorage.clear();
    const owner: Tab = {
        name: "Unvisited puzzle",
        value: crypto.randomUUID(),
        treeKey: crypto.randomUUID(),
        type: "puzzles",
        gameOrigin: { kind: "none" },
    };
    const retained: Tab = { ...owner, name: "Retained puzzle", value: crypto.randomUUID() };
    delete retained.treeKey;
    const historyKey = `${owner.value}-puzzles`;
    const retainedHistoryKey = `${retained.value}-puzzles`;
    const unknownHistoryKey = `${crypto.randomUUID()}-puzzles`;
    const physicalHistoryKey = `${owner.treeKey}-puzzles`;
    const history = JSON.stringify([
        {
            id: 7,
            fen: defaultTree().root.fen,
            moves: ["e2e4", "e7e5"],
            rating: 1200,
            rating_deviation: 50,
            popularity: 1,
            nb_plays: 1,
            completion: "incomplete",
        },
    ]);
    sessionStorage.setItem(historyKey, history);
    sessionStorage.setItem(retainedHistoryKey, history);
    sessionStorage.setItem(unknownHistoryKey, "unknown UUID history");
    sessionStorage.setItem(physicalHistoryKey, "unidentified physical suffix value");
    sessionStorage.setItem("foreign-puzzles", "unidentified suffix value");
    if (treePresent) tabStorage.seed(owner.treeKey!, defaultTree());
    tabStorage.seed(retained.value, defaultTree());
    const envelope = {
        version: 1,
        tabs: [retained, owner],
        activeTab: retained.value,
        treeOwnershipUncertain: true,
        treeOwnershipProtectedIds: [owner.treeKey!, retained.value],
    };
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, serializeStorageValue(envelope));
    return {
        owner,
        retained,
        historyKey,
        retainedHistoryKey,
        unknownHistoryKey,
        physicalHistoryKey,
        history,
        envelope,
    };
}

test.each([true, false])(
    "closing an unvisited background UUID puzzle persists exact authority with physical tree present: %s",
    async (treePresent) => {
        const fixture = backgroundPuzzleCloseFixture(treePresent);
        vi.resetModules();
        const fresh = await importFreshAtoms();
        const store = createStore();
        expect(store.get(fresh.tabsAtom)).toEqual(fixture.envelope.tabs);
        expect(store.get(fresh.activeTabAtom)).toBe(fixture.retained.value);
        const removalWorkspaces: unknown[] = [];
        const remove = Storage.prototype.removeItem;
        vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key) {
            if (key === fixture.historyKey || key === fixture.owner.treeKey) {
                removalWorkspaces.push(
                    readStoredWorkspaceValue(sessionStorage, WORKSPACE_STORAGE_KEY),
                );
            }
            if (key === fixture.historyKey) throw new DOMException("denied", "SecurityError");
            return remove.call(this, key);
        });

        expect(store.set(fresh.closeWorkspaceTabAtom, fixture.owner.value)).toBe(true);
        expect(removalWorkspaces.length).toBeGreaterThan(0);
        for (const workspace of removalWorkspaces)
            expect(workspace).toMatchObject({
                tabs: [fixture.retained],
                legacyPuzzleRemovalKeys: [fixture.historyKey],
            });
        expect(store.get(fresh.tabsAtom)).toEqual([fixture.retained]);
        expect(store.get(fresh.activeTabAtom)).toBe(fixture.retained.value);
        expect(sessionStorage.getItem(fixture.owner.treeKey!)).toBeNull();
        expect(sessionStorage.getItem(fixture.historyKey)).toBe(fixture.history);
        expect(readStoredWorkspaceValue(sessionStorage, WORKSPACE_STORAGE_KEY)).toMatchObject({
            legacyPuzzleRemovalKeys: [fixture.historyKey],
        });
        expect(persistError.reportPersistError).toHaveBeenCalled();

        vi.resetModules();
        const refusedCold = await importFreshAtoms();
        expect(refusedCold.initializeWorkspace().legacyPuzzleRemovalKeys).toEqual([
            fixture.historyKey,
        ]);
        expect(sessionStorage.getItem(fixture.historyKey)).toBe(fixture.history);
        vi.restoreAllMocks();
        vi.resetModules();
        const cold = await importFreshAtoms();
        const reloaded = cold.initializeWorkspace();
        expect(reloaded.tabs).toEqual([fixture.retained]);
        expect(reloaded.treeOwnershipUncertain).toBe(true);
        expect(reloaded.legacyPuzzleRemovalKeys).toBeUndefined();
        expect(sessionStorage.getItem(fixture.historyKey)).toBeNull();
        expect(sessionStorage.getItem(fixture.retained.value)).not.toBeNull();
        expect(sessionStorage.getItem(fixture.retainedHistoryKey)).toBe(fixture.history);
        expect(sessionStorage.getItem(fixture.unknownHistoryKey)).toBe("unknown UUID history");
        expect(sessionStorage.getItem(fixture.physicalHistoryKey)).toBe(
            "unidentified physical suffix value",
        );
        expect(sessionStorage.getItem("foreign-puzzles")).toBe("unidentified suffix value");
    },
);

test.each([
    { failure: "workspace-write", causeMessage: "quota" },
    { failure: "capacity-and-workspace-write", causeMessage: "quota" },
] as const)(
    "background UUID puzzle close preserves its owners on $failure refusal and retries",
    async ({ failure, causeMessage }) => {
        const fixture = backgroundPuzzleCloseFixture();
        const pending = Array.from({ length: 100 }, () => `${crypto.randomUUID()}-puzzles`);
        if (failure === "capacity-and-workspace-write") {
            for (const key of pending) sessionStorage.setItem(key, "refused history");
            sessionStorage.setItem(
                WORKSPACE_STORAGE_KEY,
                serializeStorageValue({ ...fixture.envelope, legacyPuzzleRemovalKeys: pending }),
            );
            denyStorageRemoval((key) => pending.includes(key));
        }
        vi.resetModules();
        const fresh = await importFreshAtoms();
        const store = createStore();
        fresh.initializeWorkspace();
        refuseWorkspaceWrites();
        const workspaceBytes = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
        const treeBytes = sessionStorage.getItem(fixture.owner.treeKey!);
        persistError.reportPersistError.mockClear();

        expect(store.set(fresh.closeWorkspaceTabAtom, fixture.owner.value)).toBe(false);
        expect(store.get(fresh.tabsAtom)).toEqual(fixture.envelope.tabs);
        expect(store.get(fresh.activeTabAtom)).toBe(fixture.retained.value);
        expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(workspaceBytes);
        expect(sessionStorage.getItem(fixture.owner.treeKey!)).toBe(treeBytes);
        expect(sessionStorage.getItem(fixture.historyKey)).toBe(fixture.history);
        expect(persistError.reportPersistError).toHaveBeenCalled();
        expect(persistError.reportPersistError).not.toHaveBeenCalledWith(
            expect.objectContaining({
                message: puzzleOverflowMessage,
            }),
        );
        expect(enUSCatalogue.translation["Common.PendingPuzzleRemovalOverflow"]).toBe(
            puzzleOverflowMessage,
        );
        expect(persistError.reportPersistError).toHaveBeenCalledWith(
            expect.objectContaining({
                cause: expect.objectContaining({ message: causeMessage }),
            }),
        );

        vi.restoreAllMocks();
        expect(store.set(fresh.closeWorkspaceTabAtom, fixture.owner.value)).toBe(true);
        expect(store.get(fresh.tabsAtom)).toEqual([fixture.retained]);
        expect(sessionStorage.getItem(fixture.owner.treeKey!)).toBeNull();
        expect(sessionStorage.getItem(fixture.historyKey)).toBeNull();
        expect(sessionStorage.getItem(fixture.retainedHistoryKey)).toBe(fixture.history);
        expect(readStoredWorkspaceValue(sessionStorage, WORKSPACE_STORAGE_KEY)).toMatchObject({
            legacyPuzzleRemovalKeys: [fixture.historyKey],
        });
    },
);

test("background puzzle close publishes the newest 100 cleanup keys before reporting overflow", async () => {
    const fixture = backgroundPuzzleCloseFixture();
    const prior = Array.from({ length: 100 }, () => `${crypto.randomUUID()}-puzzles`);
    for (const key of prior) sessionStorage.setItem(key, "refused history");
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({ ...fixture.envelope, legacyPuzzleRemovalKeys: prior }),
    );
    denyStorageRemoval((key) => [...prior, fixture.historyKey].includes(key));
    vi.resetModules();
    const fresh = await importFreshAtoms();
    fresh.initializeWorkspace();
    const store = createStore();
    const expectedKeys = [...prior.slice(1), fixture.historyKey];
    const message = puzzleOverflowMessage;
    persistError.reportPersistError.mockClear();
    const reportedWorkspaceBytes: Array<string | null> = [];
    persistError.reportPersistError.mockImplementation((error: Error) => {
        if (error.message === message)
            reportedWorkspaceBytes.push(sessionStorage.getItem(WORKSPACE_STORAGE_KEY));
    });

    expect(store.set(fresh.closeWorkspaceTabAtom, fixture.owner.value)).toBe(true);
    expect(store.get(fresh.tabsAtom)).toEqual([fixture.retained]);
    expect(readStoredWorkspaceValue(sessionStorage, WORKSPACE_STORAGE_KEY)).toMatchObject({
        legacyPuzzleRemovalKeys: expectedKeys,
    });
    expect(sessionStorage.getItem(prior[0]!)).toBe("refused history");
    const errors = persistError.reportPersistError.mock.calls
        .map(([error]) => error)
        .filter((error) => error.message === message);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe(puzzleOverflowMessage);
    expect(enUSCatalogue.translation["Common.PendingPuzzleRemovalOverflow"]).toBe(
        puzzleOverflowMessage,
    );
    expect(reportedWorkspaceBytes).toEqual([sessionStorage.getItem(WORKSPACE_STORAGE_KEY)]);
    expect(deserializeStorageValue(reportedWorkspaceBytes[0]!)).toMatchObject({
        tabs: [fixture.retained],
        legacyPuzzleRemovalKeys: expectedKeys,
    });
    expect(errorUnlessCancelled(errors[0])).toEqual({ category: "unexpected", message });
    expect(errors[0].cause.message).toBe("Pending legacy puzzle removals exceeded 100; dropped 1");
    expect(message).not.toMatch(/try again|reload/i);
    persistError.reportPersistError.mockReset();
});

type ReplacementFixture = {
    store: ReturnType<typeof createStore>;
    owner: Tab;
    second: Tab;
    secondTree: ReturnType<typeof defaultTree>;
    ownerTreeStore: ReturnType<typeof createTreeStore>;
    secondTreeStore: ReturnType<typeof createTreeStore>;
    ownerRoot: TreeStoreState["root"];
    ownerHeaders: TreeStoreState["headers"];
    secondRoot: TreeStoreState["root"];
    secondHeaders: TreeStoreState["headers"];
    ownerAtom: ReturnType<typeof tabFamily>;
    secondAtom: ReturnType<typeof tabFamily>;
    workspaceBytes: string | null;
    ownerDurableBytes: string | null;
    ownerPendingEntry: ReturnType<typeof tabStorage.readTree>;
    secondDurableBytes: string | null;
};

function makeReplacementFixture({
    ownerType = "new",
    ownerActive = true,
}: {
    ownerType?: Tab["type"];
    ownerActive?: boolean;
} = {}): ReplacementFixture {
    sessionStorage.clear();
    const store = createStore();
    const initialTab = store.get(tabsAtom)[0]!;
    const ownerId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    replacementTabIds.add(ownerId);
    replacementTabIds.add(secondId);
    const owner: Tab = {
        ...initialTab,
        name: "Tab.NewTab",
        value: ownerId,
        type: ownerType,
        gameOrigin: { kind: "none" },
    };
    const second: Tab = {
        ...initialTab,
        name: "Second tab",
        value: secondId,
        type: "analysis",
        gameOrigin: { kind: "none" },
    };
    const ownerTree = defaultTree();
    ownerTree.headers.event = "Owner durable tree";
    const pendingOwnerTree = structuredClone(ownerTree);
    pendingOwnerTree.headers.event = "Owner pending tree";
    const secondTree = defaultTree();
    secondTree.headers.event = "Second tab tree";

    tabStorage.seed(ownerId, ownerTree);
    tabStorage.write(ownerId, { version: 1, state: pendingOwnerTree });
    tabStorage.seed(secondId, secondTree);
    expect(store.set(tabsAtom, [second, owner], ownerActive ? ownerId : secondId)).toBe(true);

    const ownerAtom = tabFamily(ownerId);
    const secondAtom = tabFamily(secondId);
    store.set(ownerAtom, "practice");
    store.set(secondAtom, "info");
    const ownerTreeStore = createTreeStore(ownerId);
    const secondTreeStore = createTreeStore(secondId);
    const ownerPendingEntry = tabStorage.readTree(ownerId);
    expect(ownerPendingEntry.kind).toBe("available");

    return {
        store,
        owner,
        second,
        secondTree,
        ownerTreeStore,
        secondTreeStore,
        ownerRoot: ownerTreeStore.getState().root,
        ownerHeaders: ownerTreeStore.getState().headers,
        secondRoot: secondTreeStore.getState().root,
        secondHeaders: secondTreeStore.getState().headers,
        ownerAtom,
        secondAtom,
        workspaceBytes: sessionStorage.getItem(WORKSPACE_STORAGE_KEY),
        ownerDurableBytes: sessionStorage.getItem(ownerId),
        ownerPendingEntry,
        secondDurableBytes: sessionStorage.getItem(secondId),
    };
}

function expectReplacementOwnerUnchanged(fixture: ReplacementFixture) {
    expect(fixture.store.get(tabsAtom)).toEqual([fixture.second, fixture.owner]);
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(fixture.workspaceBytes);
    expectReplacementResourcesUnchanged(fixture);
}

function availableTree(entry: ReturnType<typeof tabStorage.readTree>) {
    if (entry.kind !== "available")
        throw new Error(`Expected an available tree, got ${entry.kind}.`);
    return entry.value;
}

function expectReplacementResourcesUnchanged(fixture: ReplacementFixture) {
    expect(sessionStorage.getItem(fixture.owner.value)).toBe(fixture.ownerDurableBytes);
    expect(availableTree(tabStorage.readTree(fixture.owner.value))).toBe(
        availableTree(fixture.ownerPendingEntry),
    );
    expect(createTreeStore(fixture.owner.value)).toBe(fixture.ownerTreeStore);
    expect(fixture.ownerTreeStore.getState().root).toBe(fixture.ownerRoot);
    expect(fixture.ownerTreeStore.getState().headers).toBe(fixture.ownerHeaders);
    expect(tabFamily(fixture.owner.value)).toBe(fixture.ownerAtom);
    expect(fixture.store.get(fixture.ownerAtom)).toBe("practice");
    expect(fixture.store.get(fixture.secondAtom)).toBe("info");
    expect(fixture.store.get(tabsAtom)[0]).toStrictEqual(fixture.second);
    expect(sessionStorage.getItem(fixture.second.value)).toBe(fixture.secondDurableBytes);
    expect(tabStorage.read(fixture.second.value)?.state).toEqual(fixture.secondTree);
    expect(createTreeStore(fixture.second.value)).toBe(fixture.secondTreeStore);
    expect(fixture.secondTreeStore.getState().root).toBe(fixture.secondRoot);
    expect(fixture.secondTreeStore.getState().headers).toBe(fixture.secondHeaders);
    expect(tabFamily(fixture.second.value)).toBe(fixture.secondAtom);
}

function makeThrowingCommitStore(
    fixture: ReplacementFixture,
    error: unknown,
    writeBeforeThrow: boolean,
): ReturnType<typeof createStore> {
    return {
        get: fixture.store.get.bind(fixture.store),
        set: (atom: unknown, update?: unknown, activeTab?: string) => {
            if (atom !== tabsAtom) throw new Error("Unexpected atom write in transaction test.");
            if (writeBeforeThrow) {
                fixture.store.set(tabsAtom, update as Tab[] | ((tabs: Tab[]) => Tab[]), activeTab);
            }
            throw error;
        },
    } as unknown as ReturnType<typeof createStore>;
}

function fileReplacementFixture(ownerActive = true) {
    const fixture = makeReplacementFixture({ ownerType: "analysis", ownerActive });
    const owner = {
        ...fixture.owner,
        gameOrigin: {
            kind: "file" as const,
            gameNumber: 1,
            file: {
                type: "file" as const,
                handle: { kind: "fileWorkspace" as const, id: { id: "file-owner" } },
                name: "games.pgn",
                numGames: 2,
                metadata: { type: "game" as const, tags: [] },
                lastModified: 1,
            },
        },
    };
    fixture.owner = owner;
    expect(fixture.store.set(tabsAtom, [fixture.second, owner])).toBe(true);
    fixture.workspaceBytes = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
    const candidate = createTreeStore(undefined);
    candidate.getState().makeMoves({ payload: ["e4", "e5", "Nf3"] });
    candidate.getState().save("b".repeat(64));
    candidate.getState().setHeaders({ ...candidate.getState().headers, event: "Replacement game" });
    candidate.getState().save();
    const tree = deserializeStorageValue<ReturnType<typeof defaultTree>>(
        serializeStorageValue(candidate.getState()),
    )!;
    const replace = (store = fixture.store, isCurrent = () => true) =>
        replaceFileGame({
            store,
            owner,
            treeStore: fixture.ownerTreeStore,
            snapshot: { root: fixture.ownerRoot, headers: fixture.ownerHeaders },
            tree,
            page: 0,
            isCurrent,
        });
    return { fixture, owner, tree, replace };
}

test.each(["tree", "workspace"] as const)(
    "durable page replacement refuses %s without altering either old generation and retries",
    (stage) => {
        const { fixture, tree, replace } = fileReplacementFixture();
        const setItem = Storage.prototype.setItem;
        let candidate = "";
        const refusal = vi
            .spyOn(Storage.prototype, "setItem")
            .mockImplementation(function (this: Storage, key, value) {
                if (key !== WORKSPACE_STORAGE_KEY) candidate = key;
                if ((key === WORKSPACE_STORAGE_KEY) === (stage === "workspace"))
                    throw new DOMException("full", "QuotaExceededError");
                return setItem.call(this, key, value);
            });
        expect(replace()).toEqual({
            kind: "refused",
            stage,
        });
        expectReplacementOwnerUnchanged(fixture);
        expect(fixture.store.get(activeTabAtom)).toBe(fixture.owner.value);
        expect(sessionStorage.getItem(candidate)).toBeNull();
        refusal.mockRestore();
        const result = replace();
        expect(result.kind).toBe("committed");
        if (result.kind !== "committed") throw new Error("Expected durable retry.");
        replacementTabIds.add(result.treeKey);
        expect(tabStorage.read(result.treeKey)?.state).toMatchObject({ headers: tree.headers });
    },
);

test.each(["tree", "workspace", "superseded-after-seed"] as const)(
    "plain replacement preserves the exact old linked generation after %s",
    (outcome) => {
        const { fixture, owner, tree } = fileReplacementFixture();
        const locator = {
            collection: "22222222-2222-4222-8222-222222222222",
            generation: "old-linked-generation",
            ordinal: owner.gameOrigin.gameNumber,
            stamp: "a".repeat(64),
        };
        fixture.ownerTreeStore.getState().setLinkedSource(locator);
        fixture.ownerTreeStore.getState().setSourceStamp(locator.stamp);
        expect(tabStorage.flush()).toEqual([]);
        setFileFreshness(owner.value, "verified", { verifiedRevision: locator.generation });
        const oldState = fixture.ownerTreeStore.getState();
        const oldTabs = fixture.store.get(tabsAtom);
        const freshness = getFileFreshness(owner.value);
        const workspaceBytes = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
        const treeBytes = sessionStorage.getItem(owner.value);
        const setItem = Storage.prototype.setItem;
        let staged = "";
        const writes = vi
            .spyOn(Storage.prototype, "setItem")
            .mockImplementation(function (this: Storage, key, value) {
                if (key !== WORKSPACE_STORAGE_KEY) staged = key;
                if (
                    (outcome === "workspace" && key === WORKSPACE_STORAGE_KEY) ||
                    (outcome === "tree" && key !== WORKSPACE_STORAGE_KEY)
                )
                    throw new DOMException("refused", "QuotaExceededError");
                return setItem.call(this, key, value);
            });
        let checks = 0;
        expect(
            replaceFileGame({
                store: fixture.store,
                owner,
                treeStore: fixture.ownerTreeStore,
                snapshot: oldState,
                tree,
                page: 0,
                appendCount: 3,
                isCurrent: () => outcome !== "superseded-after-seed" || ++checks === 1,
            }),
        ).toEqual(
            outcome === "superseded-after-seed"
                ? { kind: "superseded" }
                : { kind: "refused", stage: outcome },
        );
        writes.mockRestore();
        expect(staged).not.toBe("");
        expect(sessionStorage.getItem(staged)).toBeNull();
        expect(fixture.store.get(tabsAtom)).toBe(oldTabs);
        expect(fixture.ownerTreeStore.getState()).toBe(oldState);
        expect(fixture.ownerTreeStore.getState().linkedSource).toBe(locator);
        expect(getFileFreshness(owner.value)).toBe(freshness);
        expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(workspaceBytes);
        expect(sessionStorage.getItem(owner.value)).toBe(treeBytes);
        expect(tabStorage.flush()).toEqual([]);
        closeTreeStore(owner.value);
        const cold = createTreeStore(owner.value);
        expect(cold.getState()).toMatchObject({
            linkedSource: locator,
            sourceStamp: locator.stamp,
            root: oldState.root,
            headers: oldState.headers,
        });
        expect(fixture.store.get(tabsAtom)).toBe(oldTabs);
    },
);

test.each([true, false])(
    "durable page replacement preserves logical ownership and cold reload (active: %s)",
    (ownerActive) => {
        const { fixture, owner, tree, replace } = fileReplacementFixture(ownerActive);
        const reportOwner = captureReportOwner(owner.value);
        fixture.store.set(gameIdFamily(owner.value), "native-game");
        const settingsAtom = tabEngineSettingsFamily({
            tab: owner.value,
            engineId: "engine",
            defaultSettings: [],
            defaultGo: { t: "Infinite" },
        });
        const settings = {
            enabled: true,
            settings: [],
            go: { t: "Infinite" as const },
            synced: true,
        };
        fixture.store.set(settingsAtom, settings);
        const result = replace();
        expect(result.kind).toBe("committed");
        if (result.kind !== "committed") throw new Error("Expected durable replacement.");
        replacementTabIds.add(result.treeKey);
        const published = fixture.store.get(tabsAtom)[1]!;
        expect(published).toEqual({
            ...owner,
            treeKey: result.treeKey,
            gameOrigin: { ...owner.gameOrigin, gameNumber: 0 },
        });
        expect(fixture.store.get(tabsAtom).map((tab) => tab.value)).toEqual([
            fixture.second.value,
            owner.value,
        ]);
        expect(fixture.store.get(activeTabAtom)).toBe(
            ownerActive ? owner.value : fixture.second.value,
        );
        expect(createTreeStore(owner.value)).toBe(fixture.ownerTreeStore);
        expect(tabFamily(owner.value)).toBe(fixture.ownerAtom);
        expect(fixture.store.get(fixture.ownerAtom)).toBe("practice");
        expect(fixture.store.get(settingsAtom)).toBe(settings);
        expect(fixture.store.get(gameIdFamily(owner.value))).toBe("native-game");
        expect(captureReportOwner(owner.value)).toBe(reportOwner);
        expect(sessionStorage.getItem(owner.value)).toBeNull();
        expect(
            deserializeStorageValue<{ state: TreeStoreState }>(
                sessionStorage.getItem(result.treeKey)!,
            )?.state.headers.event,
        ).toBe("Replacement game");
        fixture.ownerTreeStore.getState().setComment("subsequent edit");
        expect(tabStorage.flush()).toEqual([]);
        expect(sessionStorage.getItem(owner.value)).toBeNull();
        closeTreeStore(owner.value);
        const workspace = loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY);
        const reloaded = createTreeStore(owner.value, undefined, getTabTreeKey(workspace.tabs[1]!));
        expect(reloaded.getState().headers).toEqual(tree.headers);
        expect(reloaded.getState().root.children[0]?.san).toBe("e4");
        expect(reloaded.getState().currentNode().comment).toBe("subsequent edit");
        expect(reloaded.getState().sourceStamp).toBe("b".repeat(64));
    },
);

test.each(["tree", "workspace"] as const)(
    "admitted %s subscriber errors escape only after exact acknowledgement and matching live ownership",
    (subscriber) => {
        const { fixture, owner, tree } = fileReplacementFixture();
        let acknowledged: Tab | undefined;
        const failure = new Error("Admitted subscriber failed");
        const observe = () => {
            const current = fixture.store.get(tabsAtom).find((tab) => tab.value === owner.value)!;
            expect(current).toEqual(acknowledged);
            expect(current.gameOrigin).toMatchObject({ gameNumber: 0 });
            expect(fixture.ownerTreeStore.getState()).toMatchObject(tree);
            throw failure;
        };
        const unsubscribe =
            subscriber === "tree"
                ? fixture.ownerTreeStore.subscribe(observe)
                : fixture.store.sub(tabsAtom, observe);
        let escaped: unknown;
        try {
            replaceFileGame({
                store: fixture.store,
                owner,
                treeStore: fixture.ownerTreeStore,
                snapshot: fixture.ownerTreeStore.getState(),
                tree,
                page: 0,
                isCurrent: () => true,
                onAdmitted: (successor) => {
                    acknowledged = successor;
                    expect(
                        fixture.store.get(tabsAtom).find((tab) => tab.value === owner.value),
                    ).toBe(successor);
                },
            });
        } catch (error) {
            escaped = error;
        }
        unsubscribe();
        expect(escaped).toBeInstanceOf(subscriber === "tree" ? Error : AggregateError);
        expect(
            subscriber === "workspace" ? (escaped as AggregateError).errors : [escaped],
        ).toContain(failure);
        expect(acknowledged).toBeDefined();
        const candidate = getTabTreeKey(acknowledged!);
        replacementTabIds.add(candidate);
        expect(
            (
                readStoredWorkspaceValue(sessionStorage, WORKSPACE_STORAGE_KEY) as ReturnType<
                    typeof loadWorkspace
                >
            ).tabs[1],
        ).toEqual(acknowledged);
        expect(new TabStorageRepository().read(candidate, true)?.state).toMatchObject(tree);
        expect(sessionStorage.getItem(owner.value)).toBe(fixture.ownerDurableBytes);
        expect(availableTree(tabStorage.readTree(owner.value))).toBe(
            availableTree(fixture.ownerPendingEntry),
        );
        expect(tabStorage.flush()).toEqual([]);
        expect(new TabStorageRepository().read(candidate, true)?.state).toMatchObject(tree);
    },
);

test("page replacement preserves file metadata refreshed while its read was pending", () => {
    const { fixture, owner, replace } = fileReplacementFixture();
    const current = {
        ...owner,
        name: "Renamed owner",
        gameOrigin: {
            ...owner.gameOrigin,
            file: { ...owner.gameOrigin.file, numGames: 5, lastModified: 2 },
        },
    };
    expect(fixture.store.set(tabsAtom, [fixture.second, current])).toBe(true);
    const result = replace();
    expect(result.kind).toBe("committed");
    if (result.kind !== "committed") throw new Error("Expected metadata-preserving replacement.");
    replacementTabIds.add(result.treeKey);
    expect(fixture.store.get(tabsAtom)[1]).toEqual({
        ...current,
        treeKey: result.treeKey,
        gameOrigin: { ...current.gameOrigin, gameNumber: 0 },
    });
});

test("post-write application failure retains both physical generations and cold reload follows the candidate", () => {
    const { fixture, owner, replace } = fileReplacementFixture();
    const failure = new Error("application dispatch failed after workspace save");
    const throwing = {
        get: fixture.store.get,
        sub: fixture.store.sub,
        set: (...args: Parameters<typeof fixture.store.set>) => {
            fixture.store.set(...args);
            throw failure;
        },
    } as typeof fixture.store;
    expect(() => replace(throwing)).toThrow(failure);
    const durable = readStoredWorkspaceValue(sessionStorage, WORKSPACE_STORAGE_KEY) as ReturnType<
        typeof loadWorkspace
    >;
    const candidate = getTabTreeKey(durable.tabs[1]!);
    replacementTabIds.add(candidate);
    expect(candidate).not.toBe(owner.value);
    expect(sessionStorage.getItem(candidate)).not.toBeNull();
    expect(sessionStorage.getItem(owner.value)).toBe(fixture.ownerDurableBytes);
    tabStorage.flush();
    closeTreeStore(owner.value);
    const loaded = loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY);
    expect(loaded.tabs[1]).toMatchObject({
        value: owner.value,
        treeKey: candidate,
        gameOrigin: { gameNumber: 0 },
    });
    const recovered = createTreeStore(owner.value, undefined, getTabTreeKey(loaded.tabs[1]!));
    expect(recovered.getState().headers.event).toBe("Replacement game");
    expect(recovered.getState().dirty).toBe(false);
});

test("committed replacement retains refused old-key cleanup intent through a later commit and reload", () => {
    const { fixture, owner, replace } = fileReplacementFixture();
    const deny = denyStorageRemoval(owner.value);
    const result = replace();
    expect(result.kind).toBe("committed");
    if (result.kind !== "committed") throw new Error("Cleanup refusal must be applied success.");
    replacementTabIds.add(result.treeKey);
    expect(sessionStorage.getItem(owner.value)).toBe(fixture.ownerDurableBytes);
    expect(
        fixture.store.set(tabsAtom, (tabs) => tabs.map((tab) => ({ ...tab, name: "Renamed" }))),
    ).toBe(true);
    expect(readStoredWorkspaceValue(sessionStorage, WORKSPACE_STORAGE_KEY)).toMatchObject({
        treeOwnershipPendingRemovalIds: [owner.value],
    });
    deny.mockRestore();
    const loaded = loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY);
    expect(sessionStorage.getItem(owner.value)).toBeNull();
    expect(sessionStorage.getItem(result.treeKey)).not.toBeNull();
    expect(getTabTreeKey(loaded.tabs[1]!)).toBe(result.treeKey);
    expect(fixture.store.set(closeWorkspaceTabAtom, owner.value)).toBe(true);
    expect(sessionStorage.getItem(result.treeKey)).toBeNull();
    expect([...tabFamily.getParams()]).not.toContain(owner.value);
});

test("duplication durably clones the physical owner into an independent fresh key", () => {
    const { fixture, owner, replace } = fileReplacementFixture();
    const result = replace();
    expect(result.kind).toBe("committed");
    if (result.kind !== "committed") throw new Error("Expected replacement.");
    replacementTabIds.add(result.treeKey);
    fixture.ownerTreeStore.getState().setComment("latest queued clone source");
    const published = fixture.store.get(tabsAtom)[1]!;
    const duplicate = commitNewTab({
        tab: published,
        setTabs: (tabs, active) => fixture.store.set(tabsAtom, tabs, active),
        seed: (id) =>
            tabStorage.cloneDurable(getTabTreeKey(published), id, published.treeKey !== undefined),
    });
    expect(duplicate).not.toBeNull();
    replacementTabIds.add(duplicate!);
    const cloned = fixture.store.get(tabsAtom)[2]!;
    expect(cloned.treeKey).toBeUndefined();
    expect(getTabTreeKey(cloned)).toBe(duplicate);
    expect(cloned.gameOrigin).toEqual(published.gameOrigin);
    expect(tabStorage.read<TreeStoreState>(duplicate!)?.state.root.children[0]?.san).toBe("e4");
    expect(
        tabStorage.read<TreeStoreState>(duplicate!)?.state.root.children[0]?.children[0]
            ?.children[0]?.comment,
    ).toBe("latest queued clone source");
    expect(fixture.store.set(closeWorkspaceTabAtom, owner.value)).toBe(true);
    expect(sessionStorage.getItem(result.treeKey)).toBeNull();
    expect(sessionStorage.getItem(duplicate!)).not.toBeNull();
});

test("migrated puzzle duplication shares the tree clone path and close preserves its independent session", () => {
    const fixture = makeReplacementFixture({ ownerType: "puzzles" });
    const source = fixture.ownerTreeStore;
    source.getState().makeMove({ payload: "e4" });
    expect(
        source.getState().transitionPuzzleSession((draft) => {
            const puzzle = {
                id: 1,
                fen: defaultTree().root.fen,
                moves: ["e2e4", "e7e5"],
                rating: 1200,
                rating_deviation: 50,
                popularity: 1,
                nb_plays: 1,
                completion: "incomplete" as const,
            };
            draft.puzzleSession = {
                version: 1,
                attempts: [{ attemptId: "selected-owner", puzzle }],
                selectedAttemptId: "selected-owner",
            };
        }).success,
    ).toBe(true);
    source.getState().setComment("latest puzzle annotation");
    const copyId = commitNewTab({
        tab: fixture.owner,
        setTabs: (tabs, active) => fixture.store.set(tabsAtom, tabs, active),
        seed: (id) => tabStorage.cloneDurable(getTabTreeKey(fixture.owner), id),
    })!;
    replacementTabIds.add(copyId);
    const copy = createTreeStore(copyId);
    expect(copy.getState().puzzleSession).toEqual(source.getState().puzzleSession);
    expect(copy.getState().currentNode().comment).toBe("latest puzzle annotation");
    copy.getState().transitionPuzzleSession((draft) => {
        draft.puzzleSession!.attempts[0].puzzle.completion = "incorrect";
    });
    expect(source.getState().puzzleSession!.attempts[0].puzzle.completion).toBe("incomplete");
    sessionStorage.setItem(`${fixture.owner.value}-puzzles`, "[]");
    const unrelatedBytes = sessionStorage.getItem(fixture.second.value);
    const previous = sessionStorage.getItem(fixture.owner.value);
    const refuse = refuseWorkspaceWrites();
    expect(fixture.store.set(closeWorkspaceTabAtom, fixture.owner.value)).toBe(false);
    expect(sessionStorage.getItem(fixture.owner.value)).toBe(previous);
    expect(sessionStorage.getItem(`${fixture.owner.value}-puzzles`)).toBe("[]");
    refuse.mockRestore();
    expect(fixture.store.set(closeWorkspaceTabAtom, fixture.owner.value)).toBe(true);
    closeTreeStore(fixture.owner.value);
    tabStorage.flush();
    expect(sessionStorage.getItem(fixture.owner.value)).toBeNull();
    expect(sessionStorage.getItem(`${fixture.owner.value}-puzzles`)).toBeNull();
    expect(sessionStorage.getItem(copyId)).not.toBeNull();
    expect(copy.getState().puzzleSession!.attempts[0].puzzle.completion).toBe("incorrect");
    expect(sessionStorage.getItem(fixture.second.value)).toBe(unrelatedBytes);
});

test.each(["transient-read", "missing-reference"] as const)(
    "duplication retains the %s hydration gate until explicit recovery",
    async (scenario) => {
        sessionStorage.clear();
        const store = createStore();
        const id = crypto.randomUUID();
        const treeKey = crypto.randomUUID();
        replacementTabIds.add(id);
        replacementTabIds.add(treeKey);
        const owner: Tab = {
            value: id,
            treeKey,
            name: "Recoverable original",
            type: "analysis",
            gameOrigin: { kind: "none" },
        };
        const tree = defaultTree();
        tree.headers.event = "Saved original game";
        if (scenario === "transient-read") tabStorage.seed(treeKey, tree);
        expect(store.set(tabsAtom, [owner], id)).toBe(true);
        const get = Storage.prototype.getItem;
        const refusal = vi
            .spyOn(Storage.prototype, "getItem")
            .mockImplementation(function (this: Storage, key) {
                if (scenario === "transient-read" && key === treeKey)
                    throw new DOMException("read refused", "SecurityError");
                return get.call(this, key);
            });
        const cached = createTreeStore(id, undefined, treeKey);
        refusal.mockRestore();
        const status = tabStorage.getStatus(treeKey);
        expect(status.kind).toBe("unavailable");
        expect(cached.getState().headers.event).not.toBe(tree.headers.event);
        const bytes = sessionStorage.getItem(treeKey);
        const workspaceBytes = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
        expect(new TabStorageRepository().read<TreeStoreState>(treeKey)?.state.headers.event).toBe(
            scenario === "transient-read" ? tree.headers.event : undefined,
        );
        const admission = vi.fn(() => false);
        expect(
            commitNewTab({
                tab: owner,
                setTabs: admission,
                seed: (target) => tabStorage.cloneDurable(treeKey, target, true),
            }),
        ).toBeNull();
        expect(tabStorage.getStatus(treeKey)).toBe(status);
        expect(admission).not.toHaveBeenCalled();
        expect(store.get(tabsAtom)).toEqual([owner]);
        expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(workspaceBytes);
        // The cached blank tree cannot become editable through a duplication status publication.
        cached.getState().setPracticePath([]);
        expect(tabStorage.pendingCount()).toBe(0);
        expect(sessionStorage.getItem(treeKey)).toBe(bytes);
        expect(createTreeStore(id, undefined, treeKey)).toBe(cached);
        const recoveredStatus = await retryTreeStoreStorage(id);
        expect(recoveredStatus?.kind).toBe(
            scenario === "missing-reference" ? "unavailable" : "available",
        );
        expect(sessionStorage.getItem(treeKey)).toBe(bytes);
        if (scenario === "missing-reference") {
            sessionStorage.setItem(treeKey, serializeStorageValue({ version: 1, state: tree }));
        }
        expect((await retryTreeStoreStorage(id))?.kind).toBe("available");
        expect(cached.getState().headers.event).toBe(tree.headers.event);
        const recoveredBytes = sessionStorage.getItem(treeKey);
        let target = "";
        expect(
            commitNewTab({
                tab: owner,
                setTabs: admission,
                seed: (key) => {
                    target = key;
                    tabStorage.cloneDurable(treeKey, key, true);
                },
            }),
        ).toBeNull();
        expect(admission).toHaveBeenCalledOnce();
        expect(sessionStorage.getItem(target)).toBeNull();
        expect(sessionStorage.getItem(treeKey)).toBe(recoveredBytes);
        expect(store.get(tabsAtom)).toEqual([owner]);
    },
);

test.each(["closing", "origin", "key", "store", "edit", "generation", "removed"] as const)(
    "page replacement supersedes changed %s ownership before staging",
    (change) => {
        const { fixture, owner, replace } = fileReplacementFixture();
        if (change === "closing") fixture.store.set(closingTabsAtom, new Set([owner.value]));
        if (change === "origin")
            fixture.store.set(tabsAtom, [
                fixture.second,
                { ...owner, gameOrigin: { ...owner.gameOrigin, gameNumber: 0 } },
            ]);
        if (change === "key")
            fixture.store.set(tabsAtom, [
                fixture.second,
                { ...owner, treeKey: crypto.randomUUID() },
            ]);
        if (change === "store") closeTreeStore(owner.value);
        if (change === "edit") fixture.ownerTreeStore.getState().setComment("new edit");
        if (change === "removed") fixture.store.set(tabsAtom, [fixture.second]);
        const write = vi.spyOn(Storage.prototype, "setItem");
        expect(replace(fixture.store, () => change !== "generation")).toEqual({
            kind: "superseded",
        });
        expect(write).not.toHaveBeenCalled();
    },
);

test.each([true, false])(
    "replaces the owner in place and preserves selection (owner active: %s)",
    (ownerActive) => {
        const fixture = makeReplacementFixture({ ownerActive });
        const importedTree = defaultTree();
        importedTree.headers.event = "Imported tree";
        const importedTab = {
            name: "Imported game",
            type: "analysis" as const,
            gameOrigin: { kind: "none" as const },
        };
        let workspaceWrites = 0;
        const originalSetItem = Storage.prototype.setItem;
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
            this: Storage,
            key: string,
            value: string,
        ) {
            if (key === WORKSPACE_STORAGE_KEY) workspaceWrites++;
            return originalSetItem.call(this, key, value);
        });

        const result = replaceNewTab({
            store: fixture.store,
            ownerId: fixture.owner.value,
            tab: importedTab,
            tree: importedTree,
        });

        expect(result.kind).toBe("committed");
        if (result.kind !== "committed") throw new Error("Expected the replacement to commit.");
        replacementTabIds.add(result.id);
        expect(workspaceWrites).toBe(1);
        expect(fixture.store.get(tabsAtom)).toHaveLength(2);
        expect(fixture.store.get(tabsAtom)[0]).toStrictEqual(fixture.second);
        expect(fixture.store.get(tabsAtom)[1]).toEqual({ ...importedTab, value: result.id });
        expect(fixture.store.get(activeTabAtom)).toBe(
            ownerActive ? result.id : fixture.second.value,
        );
        expect(tabStorage.read(result.id)?.state).toEqual(importedTree);
        expect(sessionStorage.getItem(fixture.owner.value)).toBeNull();
        expect(tabStorage.readTree(fixture.owner.value).kind).toBe("absent");
        expect(createTreeStore(fixture.owner.value)).not.toBe(fixture.ownerTreeStore);
        expect([...tabFamily.getParams()]).not.toContain(fixture.owner.value);
        expect(fixture.store.get(fixture.secondAtom)).toBe("info");
        expect(sessionStorage.getItem(fixture.second.value)).toBe(fixture.secondDurableBytes);
        expect(tabStorage.read(fixture.second.value)?.state).toEqual(fixture.secondTree);
        expect(createTreeStore(fixture.second.value)).toBe(fixture.secondTreeStore);
        expect(fixture.secondTreeStore.getState().root).toBe(fixture.secondRoot);
        expect(fixture.secondTreeStore.getState().headers).toBe(fixture.secondHeaders);
        expect(tabFamily(fixture.second.value)).toBe(fixture.secondAtom);

        const reloaded = loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY);
        expect(reloaded.tabs[1]).toEqual({ ...importedTab, value: result.id });
        expect(tabStorage.read(result.id)?.state).toEqual(importedTree);
    },
);

test.each(["tree", "workspace"] as const)(
    "refuses a %s write without changing the owner and retries successfully",
    (stage) => {
        const fixture = makeReplacementFixture();
        const importedTree = defaultTree();
        importedTree.headers.event = "Imported after retry";
        persistError.reportPersistError.mockClear();
        const quota = new DOMException("full", "QuotaExceededError");
        let stagedId = "";
        const originalSetItem = Storage.prototype.setItem;
        const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
            this: Storage,
            key: string,
            value: string,
        ) {
            const isWorkspace = key === WORKSPACE_STORAGE_KEY;
            if (!isWorkspace) stagedId = key;
            if (isWorkspace === (stage === "workspace")) throw quota;
            return originalSetItem.call(this, key, value);
        });

        expect(
            replaceNewTab({
                store: fixture.store,
                ownerId: fixture.owner.value,
                tab: { name: "Imported game", type: "analysis", gameOrigin: { kind: "none" } },
                tree: importedTree,
            }),
        ).toEqual({ kind: "refused", stage });
        replacementTabIds.add(stagedId);
        expectReplacementOwnerUnchanged(fixture);
        expect(stagedId).not.toBe("");
        expect(sessionStorage.getItem(stagedId)).toBeNull();
        expect(persistError.reportPersistError).toHaveBeenCalledOnce();
        expect(loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY).tabs).toEqual([
            fixture.second,
            fixture.owner,
        ]);

        setItem.mockRestore();
        const retry = replaceNewTab({
            store: fixture.store,
            ownerId: fixture.owner.value,
            tab: { name: "Imported game", type: "analysis", gameOrigin: { kind: "none" } },
            tree: importedTree,
        });
        expect(retry.kind).toBe("committed");
        if (retry.kind === "committed") replacementTabIds.add(retry.id);
    },
);

/** Runs replaceNewTab against a commit that throws, and checks what both outcomes share. */
function replaceWithThrowingCommit(writeBeforeThrow: boolean) {
    const fixture = makeReplacementFixture();
    const dispatchError = new Error("workspace listener failed");
    const importedTree = defaultTree();
    importedTree.headers.event = "Imported tree";
    persistError.reportPersistError.mockClear();
    let stagedId = "";
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
        this: Storage,
        key: string,
        value: string,
    ) {
        if (key !== WORKSPACE_STORAGE_KEY) stagedId = key;
        return originalSetItem.call(this, key, value);
    });

    expect(() =>
        replaceNewTab({
            store: makeThrowingCommitStore(fixture, dispatchError, writeBeforeThrow),
            ownerId: fixture.owner.value,
            tab: { name: "Imported game", type: "analysis", gameOrigin: { kind: "none" } },
            tree: importedTree,
        }),
    ).toThrow(dispatchError);
    replacementTabIds.add(stagedId);
    expect(stagedId).not.toBe("");
    expect(sessionStorage.getItem(stagedId)).not.toBeNull();
    expect(sessionStorage.getItem(`chessfable:failed-tab-admission:${stagedId}`)).toBeNull();
    expectReplacementResourcesUnchanged(fixture);
    expect(persistError.reportPersistError).not.toHaveBeenCalled();
    return { fixture, stagedId, importedTree };
}

test("preserves staged ownership and owner resources when the commit throws after the write lands", () => {
    const { fixture, stagedId, importedTree } = replaceWithThrowingCommit(true);

    expect(fixture.store.get(tabsAtom)[1]).toEqual({
        name: "Imported game",
        type: "analysis",
        gameOrigin: { kind: "none" },
        value: stagedId,
    });
    const loaded = loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY);
    expect(loaded.tabs[1]?.value).toBe(stagedId);
    expect(loaded.treeOwnershipPendingRemovalIds).toContain(fixture.owner.value);
    expect(tabStorage.read(stagedId)?.state).toEqual(importedTree);
});

test("preserves staged ownership and owner resources when the commit throws before the write lands", () => {
    const { fixture, stagedId } = replaceWithThrowingCommit(false);

    expect(fixture.store.get(tabsAtom)).toEqual([fixture.second, fixture.owner]);
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(fixture.workspaceBytes);
    // Loading an authoritative workspace sweeps the unreferenced staged tree.
    const loaded = loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY);
    expect(loaded.tabs).toEqual([fixture.second, fixture.owner]);
    expect(sessionStorage.getItem(stagedId)).toBeNull();
});

test("supersedes an owner that is no longer in the workspace without writing", () => {
    const fixture = makeReplacementFixture();
    expect(fixture.store.set(tabsAtom, [fixture.second], fixture.second.value)).toBe(true);
    const workspaceBytes = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
    const ownerBytes = sessionStorage.getItem(fixture.owner.value);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");

    expect(
        replaceNewTab({
            store: fixture.store,
            ownerId: fixture.owner.value,
            tab: { name: "Imported game", type: "analysis", gameOrigin: { kind: "none" } },
            tree: defaultTree(),
        }),
    ).toEqual({ kind: "superseded" });

    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(workspaceBytes);
    expect(sessionStorage.getItem(fixture.owner.value)).toBe(ownerBytes);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
});

test.each(["not-new", "closing"] as const)(
    "supersedes an existing owner when it is %s without changing its resources",
    (reason) => {
        const fixture = makeReplacementFixture({
            ownerType: reason === "not-new" ? "analysis" : "new",
        });
        if (reason === "closing") {
            fixture.store.set(closingTabsAtom, new Set([fixture.owner.value]));
        }
        const setItem = vi.spyOn(Storage.prototype, "setItem");
        const removeItem = vi.spyOn(Storage.prototype, "removeItem");

        expect(
            replaceNewTab({
                store: fixture.store,
                ownerId: fixture.owner.value,
                tab: { name: "Imported game", type: "analysis", gameOrigin: { kind: "none" } },
                tree: defaultTree(),
            }),
        ).toEqual({ kind: "superseded" });

        expectReplacementOwnerUnchanged(fixture);
        expect(setItem).not.toHaveBeenCalled();
        expect(removeItem).not.toHaveBeenCalled();
    },
);

test("closing a tab removes all cached tab and per-engine atom-family entries", () => {
    const tabId = "closing-tab";
    const store = getDefaultStore();
    store.set(tabFamily(tabId), "practice");
    store.set(gameIdFamily(tabId), "native-game");
    store.set(pendingGameStartFamily(tabId), Promise.resolve());
    store.set(engineMovesFamily({ tab: tabId, engine: "engine" }), new Map());
    store.set(engineProgressFamily({ tab: tabId, engine: "engine" }), 42);
    store.set(
        tabEngineSettingsFamily({
            tab: tabId,
            engineId: "engine",
            defaultSettings: [],
            defaultGo: { t: "Infinite" },
        }),
        { enabled: true, settings: [], go: { t: "Infinite" }, synced: true },
    );

    disposeTabAtoms(tabId);

    expect([...tabFamily.getParams()]).not.toContain(tabId);
    expect([...gameIdFamily.getParams()]).not.toContain(tabId);
    expect([...pendingGameStartFamily.getParams()]).not.toContain(tabId);
    expect([...engineMovesFamily.getParams()]).not.toContainEqual({ tab: tabId, engine: "engine" });
    expect([...engineProgressFamily.getParams()]).not.toContainEqual({
        tab: tabId,
        engine: "engine",
    });
    expect([...tabEngineSettingsFamily.getParams()]).not.toContainEqual(
        expect.objectContaining({ tab: tabId }),
    );
});

test("close intent is transient and explicitly reclaimed", () => {
    const store = createStore();
    sessionStorage.clear();
    const before = { ...sessionStorage };
    store.set(closingTabsAtom, new Set(["closing-tab"]));
    expect(store.get(closingTabsAtom).has("closing-tab")).toBe(true);
    expect({ ...sessionStorage }).toEqual(before);
    store.set(closingTabsAtom, new Set());
    expect(store.get(closingTabsAtom)).toEqual(new Set());
    expect({ ...sessionStorage }).toEqual(before);
});

test("immediate close removes tab metadata and its pending tree in one lifecycle operation", () => {
    const tabId = "immediate-close";
    const store = createStore();
    sessionStorage.clear();
    tabStorage.seed(tabId, defaultTree());
    store.set(tabsAtom, [
        { name: "Close", value: tabId, type: "analysis", gameOrigin: { kind: "none" } },
    ]);
    store.set(activeTabAtom, tabId);

    store.set(closeWorkspaceTabAtom, tabId);

    expect(store.get(tabsAtom)).toEqual([]);
    expect(store.get(activeTabAtom)).toBeNull();
    expect(sessionStorage.getItem(tabId)).toBeNull();
});

test("refuses a 101st tab without changing the active tab or acknowledged workspace", async () => {
    sessionStorage.clear();
    const store = createStore();
    const tabs = Array.from({ length: 100 }, (_, index) => ({
        name: `Tab ${index}`,
        value: crypto.randomUUID(),
        type: "analysis" as const,
        gameOrigin: { kind: "none" as const },
    }));
    store.set(tabsAtom, tabs);
    store.set(activeTabAtom, tabs[0]!.value);

    const result = await createTab({
        tab: { name: "Refused", type: "analysis" },
        setTabs: (update, activeTab) => store.set(tabsAtom, update, activeTab),
        existingTabIds: tabs.map((tab) => tab.value),
    });

    expect(result).toBeNull();
    expect(store.get(tabsAtom)).toEqual(tabs);
    expect(store.get(activeTabAtom)).toBe(tabs[0]!.value);
});

test("returns the admitted tab id and activates it for a valid create", async () => {
    sessionStorage.clear();
    const store = createStore();
    store.set(tabsAtom, []);
    store.set(activeTabAtom, null);

    const result = await createTab({
        tab: { name: "Admitted", type: "analysis" },
        setTabs: (update, activeTab) => store.set(tabsAtom, update, activeTab),
    });

    expect(result).not.toBeNull();
    expect(store.get(tabsAtom)).toEqual([
        expect.objectContaining({ value: result, name: "Admitted", type: "analysis" }),
    ]);
    expect(store.get(activeTabAtom)).toBe(result);
});

test("rolls back a seeded tree when the workspace envelope write is refused", async () => {
    sessionStorage.clear();
    const store = createStore();
    const originalTabs = store.get(tabsAtom);
    const originalActive = store.get(activeTabAtom);
    tabStorage.seed(originalTabs[0]!.value, defaultTree());
    expect(store.set(tabsAtom, originalTabs, originalActive ?? undefined)).toBe(true);
    const durableEnvelope = sessionStorage.getItem("workspace");
    const setItem = refuseWorkspaceWrites();

    let stagedId = "";
    const result = commitNewTab({
        tab: { name: "Seeded", type: "analysis", gameOrigin: { kind: "none" } },
        seed: (id) => {
            stagedId = id;
            tabStorage.seed(id, defaultTree());
        },
        setTabs: (update, activeTab) => store.set(tabsAtom, update, activeTab),
    });

    expect(result).toBeNull();
    expect(store.get(tabsAtom)).toEqual(originalTabs);
    expect(store.get(activeTabAtom)).toBe(originalActive);
    expect(sessionStorage.getItem("workspace")).toBe(durableEnvelope);
    expect(sessionStorage.getItem(stagedId)).toBeNull();
    expect(tabStorage.read(originalTabs[0]!.value)).not.toBeNull();
    expect(tabStorage.pendingCount()).toBe(0);
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    expect(loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY)).toEqual({
        version: 1,
        tabs: originalTabs,
        activeTab: originalActive,
    });

    setItem.mockRestore();
    const retry = commitNewTab({
        tab: { name: "Seeded", type: "analysis", gameOrigin: { kind: "none" } },
        seed: (id) => tabStorage.seed(id, defaultTree()),
        setTabs: (update, activeTab) => store.set(tabsAtom, update, activeTab),
    });
    expect(retry).not.toBeNull();
    expect(store.get(activeTabAtom)).toBe(retry);
});

test.each(["play", "analysis", "puzzles"] as const)(
    "refuses the immutable %s home conversion without changing acknowledged state",
    (type) => {
        sessionStorage.clear();
        const store = createStore();
        const originalTab = {
            ...store.get(tabsAtom)[0]!,
            value: crypto.randomUUID(),
            name: "Tab.NewTab",
            type: "new" as const,
        };
        expect(store.set(tabsAtom, [originalTab], originalTab.value)).toBe(true);
        const durable = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
        refuseWorkspaceWrites();

        const receipt = store.set(tabsAtom, (tabs) =>
            tabs.map((tab) =>
                tab.value === originalTab.value ? { ...tab, name: `Home.${type}`, type } : tab,
            ),
        );

        expect(receipt).toBe(false);
        expect(originalTab).toMatchObject({ name: "Tab.NewTab", type: "new" });
        expect(store.get(tabsAtom)).toEqual([originalTab]);
        expect(store.get(activeTabAtom)).toBe(originalTab.value);
        expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(durable);
    },
);

test("refuses an existing-tab selection durably and succeeds after retry", () => {
    sessionStorage.clear();
    const store = createStore();
    const first = { ...store.get(tabsAtom)[0], value: crypto.randomUUID() };
    const second = { ...first, name: "Second", value: crypto.randomUUID() };
    expect(store.set(tabsAtom, [first, second], first.value)).toBe(true);
    const durable = sessionStorage.getItem("workspace");
    const setItem = refuseWorkspaceWrites();

    expect(store.set(activeTabAtom, second.value)).toBe(false);
    expect(store.get(activeTabAtom)).toBe(first.value);
    expect(sessionStorage.getItem("workspace")).toBe(durable);

    setItem.mockRestore();
    expect(store.set(activeTabAtom, second.value)).toBe(true);
    expect(store.get(activeTabAtom)).toBe(second.value);
});

test("preserves close resources on envelope failure and reclaims them on retry", () => {
    sessionStorage.clear();
    const store = createStore();
    const tabId = crypto.randomUUID();
    const tab = { ...store.get(tabsAtom)[0], value: tabId, type: "analysis" as const };
    const durableTree = defaultTree();
    tabStorage.seed(tabId, durableTree);
    const pendingTree = structuredClone(durableTree);
    pendingTree.headers.event = "Latest pending edit";
    tabStorage.write(tabId, { version: 1, state: pendingTree });
    store.set(tabFamily(tabId), "practice");
    expect(store.set(tabsAtom, [tab], tabId)).toBe(true);
    const setItem = refuseWorkspaceWrites();

    expect(store.set(closeWorkspaceTabAtom, tabId)).toBe(false);
    expect(store.get(tabsAtom)).toEqual([tab]);
    expect(tabStorage.read<ReturnType<typeof defaultTree>>(tabId)?.state.headers.event).toBe(
        "Latest pending edit",
    );
    expect(tabStorage.pendingCount()).toBe(1);
    expect([...tabFamily.getParams()]).toContain(tabId);

    setItem.mockRestore();
    expect(store.set(closeWorkspaceTabAtom, tabId)).toBe(true);
    expect(store.get(tabsAtom)).toEqual([]);
    expect(tabStorage.read(tabId)).toBeNull();
    expect(tabStorage.pendingCount()).toBe(0);
    expect(sessionStorage.getItem(tabId)).toBeNull();
    expect([...tabFamily.getParams()]).not.toContain(tabId);
});

test("keeps committed close metadata and attempts atom cleanup when tree removal fails", () => {
    sessionStorage.clear();
    const store = createStore();
    const tabId = crypto.randomUUID();
    const tab = { ...store.get(tabsAtom)[0]!, value: tabId, type: "analysis" as const };
    tabStorage.seed(tabId, defaultTree());
    store.set(tabFamily(tabId), "practice");
    expect(store.set(tabsAtom, [tab], tabId)).toBe(true);
    const removeItem = denyStorageRemoval(tabId);

    expect(store.set(closeWorkspaceTabAtom, tabId)).toBe(true);
    expect(store.get(tabsAtom)).toEqual([]);
    expect(store.get(activeTabAtom)).toBeNull();
    expect([...tabFamily.getParams()]).not.toContain(tabId);
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(tabId)).not.toBeNull();
    removeItem.mockRestore();
    tabStorage.remove(tabId);
});

test("a failed close removal is retried after uncertain workspace ownership", async () => {
    sessionStorage.clear();
    const tabId = crypto.randomUUID();
    const tab = {
        name: "Close",
        value: tabId,
        type: "analysis" as const,
        gameOrigin: { kind: "none" as const },
    };
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({
            version: 1,
            tabs: [tab],
            activeTab: tabId,
            treeOwnershipUncertain: true,
            treeOwnershipProtectedIds: [tabId],
        }),
    );
    tabStorage.seed(tabId, defaultTree());
    vi.resetModules();
    const freshAtoms = await importFreshAtoms();
    freshAtoms.initializeWorkspace();
    const store = createStore();
    const deny = denyStorageRemoval(tabId);

    expect(store.set(freshAtoms.closeWorkspaceTabAtom, tabId)).toBe(true);
    expect(sessionStorage.getItem(tabId)).not.toBeNull();
    deny.mockRestore();

    const reloaded = loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY);
    expect(reloaded.treeOwnershipProtectedIds).not.toContain(tabId);
    expect(sessionStorage.getItem(tabId)).toBeNull();
});

test.each([
    { scenario: "a later commit", deniedAtReload: false },
    { scenario: "another denied removal at reload", deniedAtReload: true },
])(
    "an undecodable closed UUID keeps its removal intent through $scenario",
    async ({ deniedAtReload }) => {
        sessionStorage.clear();
        const tabId = crypto.randomUUID();
        const otherId = crypto.randomUUID();
        const tab: Tab = {
            name: "Close",
            value: tabId,
            type: "new",
            gameOrigin: { kind: "none" },
        };
        const other: Tab = { ...tab, name: "Other", value: otherId };
        sessionStorage.setItem(tabId, "not a tree");
        sessionStorage.setItem(
            WORKSPACE_STORAGE_KEY,
            serializeStorageValue({ version: 1, tabs: [tab, other], activeTab: tabId }),
        );
        vi.resetModules();
        const freshAtoms = await importFreshAtoms();
        freshAtoms.initializeWorkspace();
        const store = createStore();
        const deny = denyStorageRemoval(tabId);

        expect(store.set(freshAtoms.closeWorkspaceTabAtom, tabId)).toBe(true);
        expect(store.get(freshAtoms.tabsAtom)).toEqual([other]);
        expect(sessionStorage.getItem(tabId)).toBe("not a tree");
        expect(readStoredWorkspaceValue(sessionStorage, WORKSPACE_STORAGE_KEY)).toMatchObject({
            treeOwnershipPendingRemovalIds: [tabId],
        });

        let laterCommitSucceeded = true;
        if (deniedAtReload) {
            loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY);
            deny.mockRestore();
        } else {
            deny.mockRestore();
            laterCommitSucceeded = store.set(freshAtoms.tabsAtom, [{ ...other, name: "Renamed" }]);
        }
        expect(laterCommitSucceeded).toBe(true);
        expect(sessionStorage.getItem(tabId)).toBe("not a tree");
        expect(readStoredWorkspaceValue(sessionStorage, WORKSPACE_STORAGE_KEY)).toMatchObject({
            treeOwnershipPendingRemovalIds: [tabId],
        });

        loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY);
        expect(sessionStorage.getItem(tabId)).toBeNull();
        expect(loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY)).not.toHaveProperty(
            "treeOwnershipPendingRemovalIds",
        );
        expect(readStoredWorkspaceValue(sessionStorage, WORKSPACE_STORAGE_KEY)).not.toHaveProperty(
            "treeOwnershipPendingRemovalIds",
        );
    },
);

test("a refused close save preserves protected ownership through reload", async () => {
    sessionStorage.clear();
    const tabId = crypto.randomUUID();
    const tab = {
        name: "Protected",
        value: tabId,
        type: "analysis" as const,
        gameOrigin: { kind: "none" as const },
    };
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({
            version: 1,
            tabs: [tab],
            activeTab: tabId,
            treeOwnershipUncertain: true,
            treeOwnershipProtectedIds: [tabId],
        }),
    );
    tabStorage.seed(tabId, defaultTree());
    vi.resetModules();
    const freshAtoms = await importFreshAtoms();
    freshAtoms.initializeWorkspace();
    const store = createStore();
    const deny = refuseWorkspaceWrites();

    expect(store.set(freshAtoms.closeWorkspaceTabAtom, tabId)).toBe(false);

    deny.mockRestore();
    const reloaded = loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY);
    expect(reloaded.tabs).toEqual([tab]);
    expect(reloaded.treeOwnershipProtectedIds).toContain(tabId);
    expect(sessionStorage.getItem(tabId)).not.toBeNull();
});

test("a failed close removal retries even when the ownership snapshot overflows", async () => {
    sessionStorage.clear();
    const tabId = crypto.randomUUID();
    const tab = {
        name: "Close",
        value: tabId,
        type: "analysis" as const,
        gameOrigin: { kind: "none" as const },
    };
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    sessionStorage.setItem(tabId, tree);
    for (let index = 0; index < MAX_PROTECTED_TREE_KEYS; index++) {
        sessionStorage.setItem(`other-tree-${index}`, tree);
    }
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({
            version: 1,
            tabs: [tab],
            activeTab: tabId,
            treeOwnershipUncertain: true,
        }),
    );
    vi.resetModules();
    const freshAtoms = await importFreshAtoms();
    freshAtoms.initializeWorkspace();
    const store = createStore();
    const deny = denyStorageRemoval(tabId);

    expect(store.set(freshAtoms.closeWorkspaceTabAtom, tabId)).toBe(true);
    expect(sessionStorage.getItem(tabId)).not.toBeNull();
    deny.mockRestore();

    const reloaded = loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY);
    expect(reloaded.treeOwnershipUncertain).toBe(true);
    expect(reloaded).not.toHaveProperty("treeOwnershipProtectedIds");
    expect(reloaded.treeOwnershipPendingRemovalIds).toContain(tabId);
    expect(sessionStorage.getItem(tabId)).toBeNull();
});

async function prepareTreeRemovalOverflow(failure: "throws" | "silent") {
    sessionStorage.clear();
    const tabId = crypto.randomUUID();
    const tab = {
        name: "Close",
        value: tabId,
        type: "analysis" as const,
        gameOrigin: { kind: "none" as const },
    };
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    const pendingIds = Array.from(
        { length: MAX_PENDING_TREE_REMOVALS },
        (_, index) => `pending-tree-${index}`,
    );
    for (const id of pendingIds) sessionStorage.setItem(id, tree);
    sessionStorage.setItem(tabId, tree);
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({
            version: 1,
            tabs: [tab],
            activeTab: tabId,
            treeOwnershipUncertain: true,
            treeOwnershipProtectedIds: [],
            treeOwnershipPendingRemovalIds: pendingIds,
        }),
    );
    const deniedIds = new Set([...pendingIds, tabId]);
    const remove = Storage.prototype.removeItem;
    const deny =
        failure === "silent"
            ? vi
                  .spyOn(Storage.prototype, "removeItem")
                  .mockImplementation(function (this: Storage, key) {
                      if (!deniedIds.has(key)) remove.call(this, key);
                  })
            : denyStorageRemoval((id) => deniedIds.has(id));
    vi.resetModules();
    const freshAtoms = await importFreshAtoms();
    freshAtoms.initializeWorkspace();
    const store = createStore();
    persistError.reportPersistError.mockClear();
    const workspaceBytes = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
    const expectedIds = [...pendingIds.slice(1), tabId];
    const message = treeOverflowMessage;
    const reportedWorkspaceBytes: Array<string | null> = [];
    persistError.reportPersistError.mockImplementation((error: Error) => {
        if (error.message === message)
            reportedWorkspaceBytes.push(sessionStorage.getItem(WORKSPACE_STORAGE_KEY));
    });
    return {
        tabId,
        tab,
        tree,
        pendingIds,
        deny,
        freshAtoms,
        store,
        workspaceBytes,
        expectedIds,
        message,
        reportedWorkspaceBytes,
    };
}

test.each(["throws", "silent"] as const)(
    "closing bounds unfinished tree removals when storage %s",
    async (failure) => {
        const {
            tabId,
            tree,
            pendingIds,
            deny,
            freshAtoms,
            store,
            expectedIds,
            message,
            reportedWorkspaceBytes,
        } = await prepareTreeRemovalOverflow(failure);

        expect(store.set(freshAtoms.closeWorkspaceTabAtom, tabId)).toBe(true);
        const overflowErrors = persistError.reportPersistError.mock.calls
            .map(([error]) => error)
            .filter((error) => error.message === message);
        expect(store.get(freshAtoms.tabsAtom)).toEqual([]);
        expect(overflowErrors).toHaveLength(1);
        expect(overflowErrors[0].message).toBe(treeOverflowMessage);
        expect(enUSCatalogue.translation["Common.PendingTreeRemovalOverflow"]).toBe(
            treeOverflowMessage,
        );
        expect(errorUnlessCancelled(overflowErrors[0])).toEqual({
            category: "unexpected",
            message,
        });
        expect(overflowErrors[0].cause.message).toBe(
            "Pending tree removals exceeded 100; dropped 1",
        );
        expect(message).not.toMatch(/try again|reload/i);
        expect(readStoredWorkspaceValue(sessionStorage, WORKSPACE_STORAGE_KEY)).toMatchObject({
            treeOwnershipPendingRemovalIds: expectedIds,
        });
        expect(reportedWorkspaceBytes).toEqual([sessionStorage.getItem(WORKSPACE_STORAGE_KEY)]);
        expect(deserializeStorageValue(reportedWorkspaceBytes[0]!)).toMatchObject({
            tabs: [],
            treeOwnershipPendingRemovalIds: expectedIds,
        });
        expect(sessionStorage.getItem(pendingIds[0]!)).toBe(tree);
        expect(sessionStorage.getItem(tabId)).toBe(tree);
        deny.mockRestore();
        vi.restoreAllMocks();
        persistError.reportPersistError.mockReset();

        loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY);
        expect(sessionStorage.getItem(pendingIds[0]!)).toBeNull();
        expect(sessionStorage.getItem(tabId)).toBeNull();
        expect(loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY)).not.toHaveProperty(
            "treeOwnershipPendingRemovalIds",
        );
    },
);

test("closing preserves the workspace and reports no overflow when the bounded publish fails", async () => {
    const {
        tabId,
        tab,
        tree,
        pendingIds,
        deny,
        freshAtoms,
        store,
        workspaceBytes,
        message,
        reportedWorkspaceBytes,
    } = await prepareTreeRemovalOverflow("throws");
    refuseWorkspaceWrites();

    expect(store.set(freshAtoms.closeWorkspaceTabAtom, tabId)).toBe(false);
    const overflowErrors = persistError.reportPersistError.mock.calls
        .map(([error]) => error)
        .filter((error) => error.message === message);
    expect(store.get(freshAtoms.tabsAtom)).toEqual([tab]);
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(workspaceBytes);
    expect(overflowErrors).toEqual([]);
    expect(enUSCatalogue.translation["Common.PendingTreeRemovalOverflow"]).toBe(
        treeOverflowMessage,
    );
    expect(reportedWorkspaceBytes).toEqual([]);
    expect(sessionStorage.getItem(pendingIds[0]!)).toBe(tree);
    expect(sessionStorage.getItem(tabId)).toBe(tree);
    deny.mockRestore();
    vi.restoreAllMocks();
    persistError.reportPersistError.mockReset();

    expect(store.set(freshAtoms.closeWorkspaceTabAtom, tabId)).toBe(true);
    loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY);
    expect(sessionStorage.getItem(pendingIds[0]!)).toBeNull();
    expect(sessionStorage.getItem(tabId)).toBeNull();
    expect(loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY)).not.toHaveProperty(
        "treeOwnershipPendingRemovalIds",
    );
});

test("closes inactive, active, and last tabs and ignores a stale close id", () => {
    sessionStorage.clear();
    const store = createStore();
    const tabs = ["First", "Second", "Third"].map((name) => ({
        ...store.get(tabsAtom)[0]!,
        name,
        value: crypto.randomUUID(),
        type: "analysis" as const,
    }));
    for (const tab of tabs) tabStorage.seed(tab.value, defaultTree());
    expect(store.set(tabsAtom, tabs, tabs[0]!.value)).toBe(true);

    expect(store.set(closeWorkspaceTabAtom, tabs[2]!.value)).toBe(true);
    expect(store.get(tabsAtom)).toEqual(tabs.slice(0, 2));
    expect(store.get(activeTabAtom)).toBe(tabs[0]!.value);
    expect(tabStorage.read(tabs[2]!.value)).toBeNull();

    expect(store.set(closeWorkspaceTabAtom, tabs[0]!.value)).toBe(true);
    expect(store.get(tabsAtom)).toEqual([tabs[1]]);
    expect(store.get(activeTabAtom)).toBe(tabs[1]!.value);
    expect(readStoredWorkspaceValue(sessionStorage, WORKSPACE_STORAGE_KEY)).toMatchObject({
        treeOwnershipPendingRemovalIds: [tabs[0]!.value],
    });
    expect(loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY)).toEqual({
        version: 1,
        tabs: [tabs[1]],
        activeTab: tabs[1]!.value,
    });

    const durable = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
    expect(store.set(closeWorkspaceTabAtom, "stale-id")).toBe(false);
    expect(store.get(tabsAtom)).toEqual([tabs[1]]);
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(durable);

    expect(store.set(closeWorkspaceTabAtom, tabs[1]!.value)).toBe(true);
    expect(store.get(tabsAtom)).toEqual([]);
    expect(store.get(activeTabAtom)).toBeNull();
    expect(tabStorage.read(tabs[1]!.value)).toBeNull();
});
