import { afterEach, expect, test, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createStore, Provider } from "jotai";
import { tabsAtom, updateTabById } from "@/state/atoms";
import { denyStorageRemoval, refuseStorageReads } from "@/utils/tests/storageMocks";
import type { FileWorkspaceHandle } from "@/bindings";
import { tabStorage, TabStorageRepository } from "@/state/store/tabStorage";
import { serializeStorageValue } from "@/state/store/debouncedStorage";
import { loadWorkspace, MAX_PROTECTED_TREE_KEYS, WORKSPACE_STORAGE_KEY } from "@/state/workspace";
import { closeTreeStore, createTreeStore, retargetTreeStore } from "@/state/store/tree";
import {
    getFileFreshness,
    removeFileFreshness,
    setFileFreshness,
    startFileRevisionPoll,
} from "@/state/fileFreshness";
import { defaultTree } from "./treeReducer";
import i18n, { initializeI18n } from "@/i18n";

const mocks = vi.hoisted(() => ({
    parsePGN: vi.fn(),
    lexPgn: vi.fn(async () => [] as import("@/bindings").Token[]),
    pickPgnFile: vi.fn(),
    reportPersistError: vi.fn(),
    readFileGame: vi.fn(),
    readGame: vi.fn(),
    writeGame: vi.fn(),
    writeDbGame: vi.fn(),
}));

async function importFreshAdmission() {
    vi.resetModules();
    const atoms = await import("@/state/atoms");
    const repository = (await import("@/state/store/tabStorage")).tabStorage;
    return { atoms, repository, tabs: await import("./tabs") };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

vi.mock("@/platform/tauri", () => ({
    tauri: {
        lexPgn: mocks.lexPgn,
        writeGame: mocks.writeGame,
        readGame: mocks.readGame,
        writeDbGame: mocks.writeDbGame,
        resolveLinkedGame: vi.fn(async () => null),
        collectionForDatabase: vi.fn(async () => null),
    },
}));
vi.mock("@/state/persistError", () => ({ reportPersistError: mocks.reportPersistError }));
vi.mock("./files", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./files")>()),
    pickPgnFile: mocks.pickPgnFile,
    readFileGame: mocks.readFileGame,
}));
vi.mock("./chess", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./chess")>()),
    parsePGN: mocks.parsePGN,
}));
vi.mock("@mantine/core", () => ({
    Button: ({ children, onClick, disabled }: React.ComponentProps<"button">) =>
        createElement("button", { onClick, disabled }, children),
    Group: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
    Stack: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
    Text: ({ children }: { children: React.ReactNode }) => createElement("p", null, children),
}));
vi.mock("@/components/common/AppModal", () => ({
    default: ({ opened, children }: { opened: boolean; children: React.ReactNode }) =>
        opened ? createElement("div", { role: "dialog" }, children) : null,
}));
import {
    getTabFile,
    getTabGameNumber,
    isPersistentGameOrigin,
    asksBeforeDiscardingChanges,
    commitNewTab,
    createTab,
    runTabCreation,
    saveToFile,
    appendStoreGame,
    serializeStoreTree,
    sameTabOwner,
    isTabOfFileGame,
    matchesFileGameTab,
    useTabActions,
    replaceFileGame,
    isFileBackedTab,
    type Tab,
} from "./tabs";

test("canonical successor acknowledgement cannot interrupt admitted tree finalization", () => {
    const workspace = createStore();
    const owner = { ...saveFixture().tabs[0]!, value: crypto.randomUUID() };
    if (!isFileBackedTab(owner)) throw new Error("Expected a file owner");
    const oldTree = defaultTree();
    oldTree.root.comment = "Previous page";
    tabStorage.seed(owner.value, oldTree);
    const treeStore = createTreeStore(owner.value);
    expect(workspace.set(tabsAtom, [{ ...owner, name: "Current metadata" }], owner.value)).toBe(
        true,
    );
    const candidate = defaultTree();
    candidate.headers.event = "Acknowledged page";
    candidate.sourceStamp = "b".repeat(64);
    let acknowledged: Tab | undefined;
    const failure = new Error("Acknowledgement follow-up failed");
    try {
        expect(() =>
            replaceFileGame({
                store: workspace,
                owner,
                treeStore,
                snapshot: treeStore.getState(),
                tree: candidate,
                page: 2,
                appendCount: 3,
                isCurrent: () => true,
                onAdmitted: (successor) => {
                    acknowledged = successor;
                    expect(workspace.get(tabsAtom)[0]).toBe(successor);
                    throw failure;
                },
            }),
        ).toThrow(failure);
        expect(acknowledged).toMatchObject({
            name: "Acknowledged page",
            gameOrigin: { gameNumber: 2, file: { numGames: 3 } },
        });
        expect(treeStore.getState()).toMatchObject(candidate);
        const physical = acknowledged!.treeKey!;
        expect(new TabStorageRepository().read(physical, true)?.state).toEqual({
            ...candidate,
            linkedSource: null,
            practicePath: null,
        });
        const bytes = sessionStorage.getItem(physical);
        expect(tabStorage.flush()).toEqual([]);
        expect(sessionStorage.getItem(physical)).toBe(bytes);
        expect(sessionStorage.getItem(owner.value)).not.toBeNull();
    } finally {
        closeTreeStore(owner.value);
        tabStorage.remove(owner.value);
        if (acknowledged?.treeKey) tabStorage.remove(acknowledged.treeKey);
    }
});

test("shared tab owner compares logical identity and effective legacy physical generation", () => {
    expect(sameTabOwner(undefined, fileTab)).toBe(false);
    expect(sameTabOwner({ ...fileTab, treeKey: fileTab.value }, fileTab)).toBe(true);
    expect(sameTabOwner({ ...fileTab, value: "foreign", treeKey: fileTab.value }, fileTab)).toBe(
        false,
    );
    expect(sameTabOwner({ ...fileTab, treeKey: crypto.randomUUID() }, fileTab)).toBe(false);
});

test("isTabOfFileGame matches only the same file and game number", () => {
    const tab = saveFixture({ kind: "temp_file" }).tabs[0]!;
    if (!isFileBackedTab(tab)) throw new Error("Expected a file-backed tab");
    const { file, gameNumber } = tab.gameOrigin;
    const otherFile = { id: { id: "other-file" }, kind: "fileWorkspace" } as const;
    expect(isTabOfFileGame(tab, file.handle, gameNumber)).toBe(true);
    expect(isTabOfFileGame(tab, file.handle, gameNumber + 1)).toBe(false);
    expect(isTabOfFileGame(tab, otherFile, gameNumber)).toBe(false);
    expect(isTabOfFileGame(undefined, file.handle, gameNumber)).toBe(false);
});

test("shared file/page predicate allows file and temp-file while Save retains its stricter origin kind", async () => {
    const fixture = saveFixture({ kind: "temp_file" });
    const captured = fixture.tabs[0]!;
    if (captured.gameOrigin.kind !== "temp_file") throw new Error("Expected temp-file");
    const origin = captured.gameOrigin;
    fixture.updateTab(captured.value, (previous) => ({
        ...previous,
        gameOrigin: { ...origin, kind: "file" },
    }));
    expect(sameTabOwner(fixture.tabs[0], captured)).toBe(true);
    expect(matchesFileGameTab(fixture.tabs[0], captured.gameOrigin)).toBe(true);
    await expect(
        saveToFile({
            tab: captured,
            store: fixture.store,
            getTab: fixture.getTab,
            updateTab: fixture.updateTab,
        }),
    ).resolves.toBe("superseded");
    expect(mocks.writeGame).not.toHaveBeenCalled();
});

test("shared live tab actions remain stable and provider-local and expose durable refusal", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const ownerId = crypto.randomUUID();
    const first = createStore();
    const second = createStore();
    const owner: Tab = {
        name: "First provider",
        value: ownerId,
        type: "analysis",
        gameOrigin: { kind: "none" },
    };
    expect(first.set(tabsAtom, [owner], ownerId)).toBe(true);
    expect(second.set(tabsAtom, [{ ...owner, name: "Second provider" }], ownerId)).toBe(true);
    const actions: Array<ReturnType<typeof useTabActions>> = [];
    function Probe({ slot }: { slot: number }) {
        actions[slot] = useTabActions();
        return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
        await act(async () =>
            root.render(
                createElement(
                    "div",
                    null,
                    createElement(Provider, { store: first }, createElement(Probe, { slot: 0 })),
                    createElement(Provider, { store: second }, createElement(Probe, { slot: 1 })),
                ),
            ),
        );
        const initial = actions[0]!;
        expect(actions[0]!.getTab(ownerId)?.name).toBe("First provider");
        expect(actions[1]!.getTab(ownerId)?.name).toBe("Second provider");
        await act(async () => {
            expect(
                actions[0]!.updateTab(ownerId, (previous) => ({
                    ...previous,
                    name: "Live update",
                })),
            ).toBe(true);
        });
        expect(initial.getTab(ownerId)?.name).toBe("Live update");
        expect(actions[1]!.getTab(ownerId)?.name).toBe("Second provider");
        await act(async () =>
            root.render(
                createElement(Provider, { store: first }, createElement(Probe, { slot: 0 })),
            ),
        );
        const stable = actions[0]!;
        await act(async () =>
            root.render(
                createElement(Provider, { store: first }, createElement(Probe, { slot: 0 })),
            ),
        );
        expect(actions[0]!.getTab).toBe(stable.getTab);
        expect(actions[0]!.updateTab).toBe(stable.updateTab);
        const before = first.get(tabsAtom);
        const bytes = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
        const nativeSet = Storage.prototype.setItem;
        const refuse = vi
            .spyOn(Storage.prototype, "setItem")
            .mockImplementation(function (this: Storage, key, value) {
                if (key === WORKSPACE_STORAGE_KEY)
                    throw new DOMException("refused", "QuotaExceededError");
                return nativeSet.call(this, key, value);
            });
        expect(
            actions[0]!.updateTab(ownerId, (previous) => ({ ...previous, name: "Refused" })),
        ).toBe(false);
        expect(first.get(tabsAtom)).toBe(before);
        expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(bytes);
        expect(actions[0]!.getTab(ownerId)?.name).toBe("Live update");
        expect(actions[1]!.getTab(ownerId)?.name).toBe("Second provider");
        refuse.mockRestore();
    } finally {
        await act(async () => root.unmount());
    }
});

afterEach(() => {
    vi.restoreAllMocks();
    closeTreeStore("save-test");
    closeTreeStore("save-as-test");
    tabStorage.remove("save-test");
    tabStorage.remove("save-as-test");
    removeFileFreshness("save-test");
    removeFileFreshness("save-as-test");
    sessionStorage.clear();
    vi.clearAllMocks();
    mocks.writeGame.mockReset();
    mocks.pickPgnFile.mockReset();
    mocks.readFileGame.mockReset();
    mocks.readGame.mockReset();
    mocks.lexPgn.mockReset().mockResolvedValue([]);
    vi.useRealTimers();
});

const fileTab = {
    value: "tab-1",
    name: "games.pgn",
    type: "analysis",
    gameOrigin: {
        kind: "file",
        gameNumber: 2,
        file: { name: "games.pgn", numGames: 4 },
    },
} as Tab;

test("getTabFile returns the file metadata only for file-backed tabs", () => {
    expect(getTabFile(undefined)).toBeUndefined();
    expect(getTabFile(fileTab)?.name).toBe("games.pgn");
    expect(getTabFile({ ...fileTab, gameOrigin: { kind: "none" } } as Tab)).toBeUndefined();
});

test("getTabGameNumber and persistence follow the game origin kind", () => {
    expect(getTabGameNumber(undefined)).toBe(0);
    expect(getTabGameNumber(fileTab)).toBe(2);
    expect(isPersistentGameOrigin(undefined)).toBe(false);
    expect(isPersistentGameOrigin(fileTab)).toBe(true);
    expect(isPersistentGameOrigin({ ...fileTab, gameOrigin: { kind: "none" } } as Tab)).toBe(false);
});

test("unsaved-changes coverage is persistent origin or analysis, and ignores dirty", () => {
    const none = { kind: "none" } as const;
    const database = {
        kind: "database" as const,
        database: { id: { id: "db" }, kind: "database" as const },
        gameId: 1,
    };
    const draft = {
        kind: "databaseDraft" as const,
        database: { id: { id: "db" }, kind: "database" as const },
    };
    expect(asksBeforeDiscardingChanges(undefined)).toBe(false);
    expect(asksBeforeDiscardingChanges(fileTab)).toBe(true);
    expect(
        asksBeforeDiscardingChanges({ ...fileTab, type: "play", gameOrigin: database } as Tab),
    ).toBe(true);
    expect(
        asksBeforeDiscardingChanges({ ...fileTab, type: "play", gameOrigin: draft } as Tab),
    ).toBe(true);
    expect(
        asksBeforeDiscardingChanges({ ...fileTab, type: "analysis", gameOrigin: none } as Tab),
    ).toBe(true);
    expect(asksBeforeDiscardingChanges({ ...fileTab, type: "play", gameOrigin: none } as Tab)).toBe(
        false,
    );
    expect(
        asksBeforeDiscardingChanges({ ...fileTab, type: "puzzles", gameOrigin: none } as Tab),
    ).toBe(false);
    expect(asksBeforeDiscardingChanges({ ...fileTab, type: "new", gameOrigin: none } as Tab)).toBe(
        false,
    );
});

test("runTabCreation waits, ignores refusal, reports rejection, and completes admitted tabs", async () => {
    let resolve: (value: string | null) => void = () => undefined;
    const pendingCreation = new Promise<string | null>((done) => {
        resolve = done;
    });
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const pending = runTabCreation({ create: () => pendingCreation, onSuccess, onError });
    await Promise.resolve();
    expect(onSuccess).not.toHaveBeenCalled();
    resolve("created");
    await expect(pending).resolves.toBe("created");
    expect(onSuccess).toHaveBeenCalledWith("created");
    expect(onError).not.toHaveBeenCalled();

    onSuccess.mockClear();
    await expect(
        runTabCreation({ create: async () => null, onSuccess, onError }),
    ).resolves.toBeNull();
    expect(onSuccess).not.toHaveBeenCalled();

    const failure = new Error("parse failed");
    await expect(
        runTabCreation({
            create: async () => {
                throw failure;
            },
            onSuccess,
            onError,
        }),
    ).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith(failure);
});

test("commitNewTab commits tab and selection together", () => {
    const previous: Tab[] = [];
    const setTabs = vi.fn((update, activeTab) => {
        expect(typeof update === "function" ? update(previous) : update).toEqual([
            expect.objectContaining({ name: "Created", type: "analysis" }),
        ]);
        expect(activeTab).toMatch(/^[0-9a-f-]+$/i);
        return true;
    });

    const id = commitNewTab({
        tab: { name: "Created", type: "analysis", gameOrigin: { kind: "none" } },
        setTabs,
    });
    expect(id).not.toBeNull();
    expect(setTabs).toHaveBeenCalledOnce();
});

test.each(["commitNewTab", "createTab"] as const)(
    "%s initializes before its first seeded admission and preserves the tree through reload",
    async (operation) => {
        sessionStorage.clear();
        const retained: Tab = {
            name: "Retained",
            value: crypto.randomUUID(),
            type: "analysis",
            gameOrigin: { kind: "none" },
        };
        sessionStorage.setItem(
            WORKSPACE_STORAGE_KEY,
            serializeStorageValue({ version: 1, tabs: [retained], activeTab: retained.value }),
        );
        const { createStore } = await import("jotai");
        const { atoms, repository, tabs } = await importFreshAdmission();
        const workspace = await import("@/state/workspace");
        const hydrate = vi.spyOn(workspace, "loadWorkspace");
        const allocate = vi.spyOn(crypto, "randomUUID");
        const seed = vi.spyOn(repository, "seed");
        const store = createStore();
        const setTabs = vi.fn((update: Tab[] | ((previous: Tab[]) => Tab[]), active?: string) =>
            store.set(atoms.tabsAtom, update, active),
        );
        const tree = defaultTree();
        tree.headers.event = "First operation seeded tree";
        tree.dirty = true;

        const id =
            operation === "commitNewTab"
                ? tabs.commitNewTab({
                      tab: { name: "Seeded", type: "analysis", gameOrigin: { kind: "none" } },
                      seed: (id) => repository.seed(id, tree),
                      setTabs,
                  })
                : await tabs.createTab({
                      tab: { name: "Seeded", type: "analysis" },
                      initialTree: tree,
                      setTabs,
                  });

        expect(id).not.toBeNull();
        expect(hydrate).toHaveBeenCalledOnce();
        expect(allocate).toHaveBeenCalledOnce();
        expect(hydrate.mock.invocationCallOrder[0]).toBeLessThan(
            allocate.mock.invocationCallOrder[0]!,
        );
        expect(allocate.mock.invocationCallOrder[0]).toBeLessThan(
            seed.mock.invocationCallOrder[0]!,
        );
        expect(seed.mock.invocationCallOrder[0]).toBeLessThan(setTabs.mock.invocationCallOrder[0]!);
        expect(store.get(atoms.tabsAtom).map((tab) => tab.value)).toEqual([retained.value, id]);
        expect(store.get(atoms.activeTabAtom)).toBe(id);
        expect(repository.read(id!)?.state).toMatchObject({
            dirty: true,
            headers: { event: tree.headers.event },
        });

        const reload = await importFreshAdmission();
        const reloadedStore = createStore();
        expect(reloadedStore.get(reload.atoms.tabsAtom).map((tab) => tab.value)).toEqual([
            retained.value,
            id,
        ]);
        expect(reloadedStore.get(reload.atoms.activeTabAtom)).toBe(id);
        expect(reload.repository.read(id!)?.state).toMatchObject({
            dirty: true,
            headers: { event: tree.headers.event },
        });
    },
);

test("a refused initialization precedes ID allocation, seed and caller-supplied admission", async () => {
    sessionStorage.clear();
    const { tabs, repository } = await importFreshAdmission();
    const { WorkspaceReadError } = await import("@/state/workspace");
    const failure = new DOMException("workspace read refused", "SecurityError");
    const refusal = refuseStorageReads([WORKSPACE_STORAGE_KEY], failure);
    const allocate = vi.spyOn(crypto, "randomUUID");
    const seed = vi.fn((id: string) => repository.seed(id, defaultTree()));
    const setTabs = vi.fn(() => true);

    let caught: unknown;
    try {
        tabs.commitNewTab({
            tab: { name: "Never staged", type: "analysis", gameOrigin: { kind: "none" } },
            seed,
            setTabs,
        });
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(WorkspaceReadError);
    expect((caught as Error).cause).toBe(failure);

    expect(allocate).not.toHaveBeenCalled();
    expect(seed).not.toHaveBeenCalled();
    expect(setTabs).not.toHaveBeenCalled();
    expect(repository.pendingCount()).toBe(0);
    refusal.mockRestore();
    expect(sessionStorage.length).toBe(0);
});

test("commitNewTab reports a seed failure once without attempting admission", () => {
    const setTabs = vi.fn(() => true);
    const failure = new Error("seed failed");
    let stagedId = "";

    const result = commitNewTab({
        tab: { name: "Failed", type: "analysis", gameOrigin: { kind: "none" } },
        seed: (id) => {
            stagedId = id;
            tabStorage.seed(id, defaultTree());
            throw failure;
        },
        setTabs,
    });

    expect(result).toBeNull();
    expect(setTabs).not.toHaveBeenCalled();
    expect(mocks.reportPersistError).toHaveBeenCalledOnce();
    expect(mocks.reportPersistError).toHaveBeenCalledWith(failure);
    expect(sessionStorage.getItem(stagedId)).toBeNull();
});

test("commitNewTab rolls back only its staged tree on refused admission", () => {
    sessionStorage.setItem("existing", "keep");
    let stagedId = "";
    const result = commitNewTab({
        tab: { name: "Refused", type: "analysis", gameOrigin: { kind: "none" } },
        seed: (id) => {
            stagedId = id;
            tabStorage.seed(id, defaultTree());
        },
        setTabs: () => false,
    });

    expect(result).toBeNull();
    expect(sessionStorage.getItem(stagedId)).toBeNull();
    expect(sessionStorage.getItem("existing")).toBe("keep");
});

test("commitNewTab admits a duplicate whose blank source has no stored tree", () => {
    const setTabs = vi.fn(() => true);
    const result = commitNewTab({
        tab: { name: "Blank copy", type: "new", gameOrigin: { kind: "none" } },
        seed: (id) => {
            tabStorage.cloneDurable("blank-source", id);
        },
        setTabs,
    });

    expect(result).not.toBeNull();
    expect(setTabs).toHaveBeenCalledOnce();
});

test("refused duplicate preserves its pending source and removes the durable target", () => {
    const source = defaultTree();
    source.dirty = true;
    tabStorage.write("source", { version: 0, state: source });
    let target = "";

    const result = commitNewTab({
        tab: { name: "Copy", type: "analysis", gameOrigin: { kind: "none" } },
        seed: (id) => {
            target = id;
            tabStorage.cloneDurable("source", id);
        },
        setTabs: () => false,
    });

    expect(result).toBeNull();
    expect(tabStorage.read("source")?.state).toMatchObject({ dirty: true });
    expect(tabStorage.read(target)).toBeNull();
    expect(tabStorage.pendingCount()).toBe(1);
    tabStorage.remove("source");
    expect(tabStorage.pendingCount()).toBe(0);
});

test("keeps a refused creation unacknowledged when rollback removal is rejected", () => {
    const retained: Tab = {
        name: "Retained",
        value: crypto.randomUUID(),
        type: "analysis",
        gameOrigin: { kind: "none" },
    };
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({ version: 1, tabs: [retained], activeTab: retained.value }),
    );
    let stagedId = "";
    const removeItem = denyStorageRemoval(() => stagedId);

    const result = commitNewTab({
        tab: { name: "Refused", type: "analysis", gameOrigin: { kind: "none" } },
        seed: (id) => {
            stagedId = id;
            tabStorage.seed(id, defaultTree());
        },
        setTabs: () => false,
    });

    expect(result).toBeNull();
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).not.toBeNull();
    expect(sessionStorage.getItem(stagedId)).not.toBeNull();
    expect(mocks.reportPersistError).toHaveBeenCalledOnce();
    removeItem.mockRestore();
    expect(loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY).tabs).toEqual([retained]);
    expect(sessionStorage.getItem(stagedId)).toBeNull();
});

test("retries a refused seed rollback through snapshot overflow", () => {
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, "{broken");
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    for (let index = 0; index <= MAX_PROTECTED_TREE_KEYS; index++) {
        sessionStorage.setItem(`older-tree-${index}`, tree);
    }
    let stagedId = "";
    const deny = denyStorageRemoval(() => stagedId);

    expect(
        commitNewTab({
            tab: { name: "Refused", type: "analysis", gameOrigin: { kind: "none" } },
            seed: (id) => {
                stagedId = id;
                tabStorage.seed(id, defaultTree());
            },
            setTabs: () => false,
        }),
    ).toBeNull();
    const marker = `chessfable:failed-tab-admission:${stagedId}`;
    expect(sessionStorage.getItem(marker)).toBe("1");

    mocks.reportPersistError.mockClear();
    const first = loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY);
    expect(first.treeOwnershipUncertain).toBe(true);
    expect(first.treeOwnershipProtectedIds).toBeUndefined();
    expect(mocks.reportPersistError).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(stagedId)).not.toBeNull();
    expect(sessionStorage.getItem(marker)).toBe("1");
    deny.mockRestore();

    expect(loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY).treeOwnershipUncertain).toBe(true);
    expect(sessionStorage.getItem(stagedId)).toBeNull();
    expect(sessionStorage.getItem(marker)).toBeNull();
    expect(sessionStorage.getItem("older-tree-0")).toBe(tree);
});

test("a throwing admission preserves a potentially committed tree without a failed-admission marker", () => {
    let stagedId = "";
    const dispatchError = new Error("listener failed after commit");

    expect(() =>
        commitNewTab({
            tab: { name: "Committed", type: "analysis", gameOrigin: { kind: "none" } },
            seed: (id) => {
                stagedId = id;
                tabStorage.seed(id, defaultTree());
            },
            setTabs: (update) => {
                const tabs = typeof update === "function" ? update([]) : update;
                sessionStorage.setItem(
                    WORKSPACE_STORAGE_KEY,
                    serializeStorageValue({ version: 1, tabs, activeTab: stagedId }),
                );
                throw dispatchError;
            },
        }),
    ).toThrow(dispatchError);

    expect(sessionStorage.getItem(`chessfable:failed-tab-admission:${stagedId}`)).toBeNull();
    expect(loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY).tabs[0]!.value).toBe(stagedId);
    expect(sessionStorage.getItem(stagedId)).not.toBeNull();
    expect(mocks.reportPersistError).not.toHaveBeenCalled();
});

test("a full storage origin reports that a failed rollback marker could not be written", () => {
    let stagedId = "";
    const deny = denyStorageRemoval(() => stagedId);
    const originalSetItem = Storage.prototype.setItem;
    const quota = new DOMException("full", "QuotaExceededError");
    const setItem = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
            if (key.startsWith("chessfable:failed-tab-admission:")) throw quota;
            return originalSetItem.call(this, key, value);
        });

    expect(
        commitNewTab({
            tab: { name: "Refused", type: "analysis", gameOrigin: { kind: "none" } },
            seed: (id) => {
                stagedId = id;
                tabStorage.seed(id, defaultTree());
            },
            setTabs: () => false,
        }),
    ).toBeNull();

    setItem.mockRestore();
    deny.mockRestore();
    expect(sessionStorage.getItem(`chessfable:failed-tab-admission:${stagedId}`)).toBeNull();
    expect(sessionStorage.getItem(stagedId)).not.toBeNull();
    expect(mocks.reportPersistError).toHaveBeenCalledWith(
        expect.objectContaining({ cause: quota }),
    );
});

test("saveToFile refuses the native write when the selected origin was not durable", async () => {
    const save = vi.fn();
    const store = {
        getState: () => ({ ...defaultTree(), save }),
    } as never;

    await expect(
        saveToFile({
            tab: undefined,
            updateTab: () => false,
            getTab: () => undefined,
            store,
            isUserSave: true,
        }),
    ).resolves.toMatchObject({
        status: "failed",
        error: { message: "There is no active tab to save." },
    });
    expect(mocks.writeGame).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
});

test("concurrent parses commit against the latest tabs when they finish out of order", async () => {
    let resolveFirst: (tree: ReturnType<typeof defaultTree>) => void = () => undefined;
    let resolveSecond: (tree: ReturnType<typeof defaultTree>) => void = () => undefined;
    mocks.parsePGN
        .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
        .mockReturnValueOnce(new Promise((resolve) => (resolveSecond = resolve)));
    let tabs: Tab[] = [];
    const setTabs = (update: Tab[] | ((previous: Tab[]) => Tab[])) => {
        tabs = typeof update === "function" ? update(tabs) : update;
        return true;
    };
    const first = createTab({ tab: { name: "First", type: "analysis" }, pgn: "first", setTabs });
    const second = createTab({
        tab: { name: "Second", type: "analysis" },
        pgn: "second",
        setTabs,
    });

    resolveSecond(defaultTree());
    await second;
    resolveFirst(defaultTree());
    await first;

    expect(tabs.map((tab) => tab.name)).toEqual(["Second", "First"]);
});

const fileHandle = { id: { id: "save-file" }, kind: "fileWorkspace" } as const;
const destinationHandle = { id: { id: "save-destination" }, kind: "fileWorkspace" } as const;
const stampA = "a".repeat(64);
const stampB = "b".repeat(64);
const stampC = "c".repeat(64);

test.each(
    [true, false].flatMap((linked) => [true, false].map((isUserSave) => ({ linked, isUserSave }))),
)(
    "in-place loss guard for linked=$linked user-save=$isUserSave",
    async ({ linked, isUserSave }) => {
        const fixture = saveFixture();
        if (linked)
            fixture.store.getState().setLinkedSource({
                collection: "22222222-2222-4222-8222-222222222222",
                generation: "source-generation",
                ordinal: 2,
                stamp: stampA,
            });
        mocks.readFileGame.mockResolvedValueOnce({ pgn: "1. e4 * ;use } to close", stamp: stampA });
        mocks.lexPgn.mockResolvedValueOnce([
            { type: "San", value: "e4" },
            { type: "Outcome", value: "*" },
            { type: "Unparsed", value: "use } to close" },
        ]);
        // A removed guard would execute a successful native overwrite.
        mocks.writeGame.mockResolvedValueOnce({ stamp: stampB, revision: "written" });
        await expect(
            saveToFile({
                tab: fixture.tabs[0],
                updateTab: fixture.updateTab,
                getTab: fixture.getTab,
                store: fixture.store,
                isUserSave,
            }),
        ).resolves.toBe("conflict");
        expect(mocks.writeGame).not.toHaveBeenCalled();
        expect(mocks.lexPgn).toHaveBeenCalledWith("1. e4 * ;use } to close", undefined);
        expect(getFileFreshness("save-test")).toMatchObject({
            state: "conflict",
            conflictReason: "lossy-source",
        });
        expect(fixture.store.getState()).toMatchObject({ dirty: true, sourceStamp: stampA });
    },
);

test("changed source stamp refuses before parsing or writing", async () => {
    const fixture = saveFixture();
    mocks.readFileGame.mockResolvedValueOnce({ pgn: "1. e4 *", stamp: stampB });
    mocks.writeGame.mockResolvedValueOnce({ stamp: stampC, revision: "written" });
    await expect(
        saveToFile({
            tab: fixture.tabs[0],
            updateTab: fixture.updateTab,
            getTab: fixture.getTab,
            store: fixture.store,
        }),
    ).resolves.toBe("conflict");
    expect(mocks.lexPgn).not.toHaveBeenCalled();
    expect(mocks.writeGame).not.toHaveBeenCalled();
    expect(getFileFreshness("save-test")).toMatchObject({
        state: "conflict",
        conflictReason: "save-refused",
    });
});

test.each(["read", "parse"])("in-place %s failure never writes", async (boundary) => {
    const fixture = saveFixture();
    if (boundary === "read") mocks.readFileGame.mockRejectedValueOnce(new Error("read failed"));
    else mocks.lexPgn.mockRejectedValueOnce(new Error("parse failed"));
    mocks.writeGame.mockResolvedValueOnce({ stamp: stampB, revision: "written" });
    await expect(
        saveToFile({
            tab: fixture.tabs[0],
            updateTab: fixture.updateTab,
            getTab: fixture.getTab,
            store: fixture.store,
        }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(mocks.writeGame).not.toHaveBeenCalled();
});

function saveFixture({
    id = "save-test",
    kind = "file",
    stamp = stampA,
}: {
    id?: string;
    kind?: "file" | "temp_file" | "none";
    stamp?: string | null;
} = {}) {
    const tree = { ...defaultTree(), dirty: true, sourceStamp: stamp };
    tree.headers.event = "Unsaved version";
    // Keep the former read-then-replace route executable so regression proof detects
    // its actual game-zero write rather than a missing mock response.
    if (kind === "none") {
        mocks.readFileGame.mockResolvedValue({
            pgn: '[Event "Existing destination game"]\n\n1. d4 *',
            stamp: stampA,
            revision: "destination-before-save",
            present: true,
        });
    }
    const store = createTreeStore(kind === "none" ? id : undefined, tree);
    if (kind !== "none")
        mocks.readFileGame.mockImplementation(async () => ({
            pgn: "1. e4 *",
            stamp: store.getState().sourceStamp,
            present: true,
        }));
    let tabs: Tab[] = [
        {
            value: id,
            name: "Save game",
            type: "analysis",
            gameOrigin:
                kind === "none"
                    ? { kind: "none" }
                    : {
                          kind,
                          gameNumber: 2,
                          file: {
                              type: "file",
                              handle: fileHandle,
                              name: "source.pgn",
                              numGames: 4,
                              metadata: { type: "game", tags: [] },
                              lastModified: 1,
                          },
                      },
        } as Tab,
    ];
    const updateTab = (
        tabId: string,
        update: React.SetStateAction<Tab>,
        onAdmitted?: (successor: Tab) => void,
    ) => {
        const found = tabs.some((tab) => tab.value === tabId);
        tabs = tabs.map((tab) =>
            tab.value === tabId ? (typeof update === "function" ? update(tab) : update) : tab,
        );
        if (found) onAdmitted?.(tabs.find((tab) => tab.value === tabId)!);
        return found;
    };
    const getTab = (tabId: string) => tabs.find((tab) => tab.value === tabId);
    return {
        get tabs() {
            return tabs;
        },
        getTab,
        updateTab,
        store,
        tree,
    };
}

test.each([true, false])(
    "linked save uses the admitted source generation for user-save=%s and close-save",
    async (isUserSave) => {
        const fixture = saveFixture();
        const locator = {
            collection: "22222222-2222-4222-8222-222222222222",
            generation: "admitted-generation",
            ordinal: 2,
            stamp: stampA,
        };
        fixture.store.getState().setLinkedSource(locator);
        mocks.writeGame.mockResolvedValueOnce({ stamp: stampB, revision: "saved-generation" });
        const result = await saveToFile({
            tab: fixture.tabs[0],
            updateTab: fixture.updateTab,
            getTab: fixture.getTab,
            store: fixture.store,
            isUserSave,
        });
        expect(result).toBe("saved");
        expect(mocks.writeGame).toHaveBeenLastCalledWith(fileHandle, 2, expect.any(String), {
            kind: "linkedGame",
            stamp: stampA,
            revision: locator.generation,
        });
        expect(fixture.store.getState()).toMatchObject({
            dirty: false,
            sourceStamp: stampB,
            linkedSource: { ...locator, stamp: stampB, generation: "saved-generation" },
        });
    },
);

test.each(
    (["Add Game", "page replacement"] as const).flatMap((producer) =>
        [false, true].map((providedLocator) => ({ producer, providedLocator })),
    ),
)(
    "$producer replaces old linked provenance with provided-locator=$providedLocator through reload, Save and close-save",
    async ({ producer, providedLocator }) => {
        Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
        const { atoms, repository, tabs } = await importFreshAdmission();
        const trees = await import("@/state/store/tree");
        const { loadFileGame } = await import("./files");
        const { default: ConfirmChangesModal } =
            await import("@/components/tabs/ConfirmChangesModal");
        const workspace = createStore();
        const id = crypto.randomUUID();
        const previousLocator = {
            collection: "22222222-2222-4222-8222-222222222222",
            generation: "previous-linked-generation",
            ordinal: 2,
            stamp: stampA,
        };
        const oldTree = {
            ...defaultTree(),
            linkedSource: previousLocator,
            sourceStamp: stampA,
        };
        oldTree.root.comment = "Previous linked game";
        const owner: Tab = {
            value: id,
            name: "Collection purpose changed",
            type: "analysis",
            gameOrigin: {
                kind: "file",
                gameNumber: 2,
                file: {
                    type: "file",
                    handle: fileHandle,
                    name: "source.pgn",
                    numGames: 4,
                    metadata: { type: "game", tags: [] },
                    lastModified: 1,
                },
            },
        };
        repository.seed(id, oldTree);
        expect(workspace.set(atoms.tabsAtom, [owner], id)).toBe(true);
        const store = trees.createTreeStore(id);
        const getTab = (tabId: string) =>
            workspace.get(atoms.tabsAtom).find((tab) => tab.value === tabId);
        const updateTab: import("./tabs").UpdateTab = (tabId, update, onAdmitted) =>
            atoms.updateTabById(
                (next, active, saved) => workspace.set(atoms.tabsAtom, next, active, saved),
                tabId,
                update,
                onAdmitted,
            );
        expect(
            updateTab(id, (tab) => ({
                ...tab,
                gameOrigin: {
                    ...(tab as import("./tabs").FileBackedTab).gameOrigin,
                    file: {
                        ...(tab as import("./tabs").FileBackedTab).gameOrigin.file,
                        metadata: { type: providedLocator ? "game" : "repertoire", tags: [] },
                    },
                },
            })),
        ).toBe(true);
        const captured = getTab(id)!;
        if (!tabs.isFileBackedTab(captured)) throw new Error("Expected file owner");
        const page = producer === "Add Game" ? 4 : 1;
        const locator = {
            ...previousLocator,
            generation: "replacement-linked-generation",
            ordinal: page,
            stamp: stampB,
        };
        const linkedSource = providedLocator ? locator : null;
        const parsed = defaultTree();
        parsed.headers.event = "Native replacement";
        mocks.parsePGN.mockResolvedValueOnce(parsed);
        const onError = vi.fn();
        const host = document.createElement("div");
        const root = createRoot(host);
        let physical = "";
        let pageReplacement: import("./tabs").ReplaceFileGameResult | undefined;
        try {
            if (producer === "Add Game") {
                mocks.writeGame.mockResolvedValueOnce({
                    stamp: stampB,
                    revision: "replacement-revision",
                    ...(providedLocator ? { linked: locator } : {}),
                });
                await tabs.appendBlankGame({
                    captured,
                    store,
                    workspace,
                    getTab,
                    updateTab,
                    onError,
                    uncertainMessage: "Append uncertain",
                    changedMessage: "Append changed",
                });
            } else {
                mocks.readGame.mockResolvedValueOnce({
                    pgn: '[Event "Native replacement"]\n\n*',
                    stamp: stampB,
                    revision: "replacement-revision",
                    present: true,
                    ...(providedLocator ? { linked: locator } : {}),
                });
                const loaded = await loadFileGame(fileHandle, page);
                pageReplacement = tabs.replaceFileGame({
                    store: workspace,
                    owner: captured,
                    treeStore: store,
                    snapshot: store.getState(),
                    tree: loaded.tree,
                    page,
                    isCurrent: () => true,
                });
            }
            expect(onError).not.toHaveBeenCalled();
            const anyPgn = expect.any(String);
            expect(mocks.writeGame.mock.calls).toEqual(
                producer === "Add Game" ? [[fileHandle, page, anyPgn, { kind: "append" }]] : [],
            );
            expect(mocks.readGame.mock.calls).toEqual(
                producer === "page replacement" ? [[fileHandle, page, undefined]] : [],
            );
            expect(pageReplacement?.kind).toBe(
                producer === "page replacement" ? "committed" : undefined,
            );
            const successor = getTab(id)!;
            expect(successor.name).toBe("Native replacement");
            physical = tabs.getTabTreeKey(successor);
            expect(physical).not.toBe(id);
            expect(successor.gameOrigin).toMatchObject({
                gameNumber: page,
                file: { handle: fileHandle, numGames: producer === "Add Game" ? 5 : 4 },
            });
            expect(store.getState().linkedSource).toEqual(linkedSource);
            const coldRepository = new TabStorageRepository();
            expect(coldRepository.read(physical, true)?.state).toMatchObject({
                linkedSource,
                sourceStamp: stampB,
            });
            trees.closeTreeStore(id);
            const cold = trees.createTreeStore(id, undefined, physical);
            mocks.readFileGame.mockImplementation(async () => ({
                pgn: "1. e4 *",
                stamp: cold.getState().sourceStamp,
                present: true,
            }));
            expect(cold.getState().linkedSource).toEqual(linkedSource);
            cold.getState().setComment("Edit after replacement restart");
            expect(repository.flush()).toEqual([]);
            mocks.writeGame.mockResolvedValueOnce({ stamp: stampC, revision: "saved-revision" });
            await expect(
                tabs.saveToFile({
                    tab: getTab(id),
                    store: cold,
                    getTab,
                    updateTab,
                    isUserSave: true,
                }),
            ).resolves.toBe("saved");
            expect(mocks.writeGame).toHaveBeenLastCalledWith(
                fileHandle,
                page,
                expect.stringContaining("Edit after replacement restart"),
                providedLocator
                    ? { kind: "linkedGame", stamp: stampB, revision: locator.generation }
                    : { kind: "game", stamp: stampB },
            );
            cold.getState().setComment("Edit for actual close-save");
            const finalStamp = "d".repeat(64);
            mocks.writeGame.mockResolvedValueOnce({
                stamp: finalStamp,
                revision: "closed-revision",
            });
            const onSaved = vi.fn(() => {
                expect(cold.getState().dirty).toBe(false);
                expect(workspace.set(atoms.closeWorkspaceTabAtom, id)).toBe(true);
            });
            await act(async () =>
                root.render(
                    createElement(
                        Provider,
                        { store: workspace },
                        createElement(ConfirmChangesModal, {
                            pendingClose: { tabId: id, store: cold },
                            tab: getTab(id),
                            updateTab,
                            onSaved,
                        }),
                    ),
                ),
            );
            const saveButton = host.querySelector<HTMLButtonElement>("button:last-of-type");
            expect(saveButton).not.toBeNull();
            await act(async () => saveButton!.click());
            expect(onSaved).toHaveBeenCalledOnce();
            expect(mocks.writeGame).toHaveBeenLastCalledWith(
                fileHandle,
                page,
                expect.stringContaining("Edit for actual close-save"),
                providedLocator
                    ? { kind: "linkedGame", stamp: stampC, revision: "saved-revision" }
                    : { kind: "game", stamp: stampC },
            );
            expect(cold.getState().sourceStamp).toBe(finalStamp);
            expect(getTab(id)).toBeUndefined();
        } finally {
            await act(async () => root.unmount());
            trees.closeTreeStore(id);
            repository.remove(id);
            if (physical) repository.remove(physical);
        }
    },
);

function databaseSaveFixture() {
    const fixture = saveFixture();
    const database = { id: { id: "retired-copy" }, kind: "database" as const };
    fixture.updateTab(fixture.tabs[0].value, (tab) => ({
        ...tab,
        gameOrigin: { kind: "database", database, gameId: 42 },
    }));
    return { fixture, database };
}

test.each(
    (["physical-replacement", "closed", "rebound"] as const).flatMap((ownership) =>
        ([false, true] as const).map((linked) => ({ ownership, linked })),
    ),
)(
    "database save after $ownership during the collection lookup stays silent for linked=$linked",
    async ({ ownership, linked }) => {
        const { tauri } = await import("@/platform/tauri");
        const { fixture, database } = databaseSaveFixture();
        const lookup = deferred<import("@/bindings").CollectionDescriptor | null>();
        vi.mocked(tauri.collectionForDatabase).mockReturnValueOnce(lookup.promise);
        const owner = fixture.tabs[0];
        let closed = false;
        const pending = saveToFile({
            tab: owner,
            updateTab: fixture.updateTab,
            getTab: (id) => (closed ? undefined : fixture.getTab(id)),
            store: fixture.store,
        });
        expect(tauri.collectionForDatabase).toHaveBeenCalledExactlyOnceWith(database);
        expect(mocks.writeDbGame).not.toHaveBeenCalled();
        if (ownership === "closed") closed = true;
        else
            fixture.updateTab(owner.value, (tab) => ({
                ...tab,
                ...(ownership === "physical-replacement"
                    ? { treeKey: crypto.randomUUID() }
                    : { gameOrigin: { kind: "none" as const } }),
            }));
        fixture.store.getState().setComment("Replacement owner's unsaved annotation");
        const replacement = fixture.store.getState();
        setFileFreshness(owner.value, "conflict");
        const freshness = getFileFreshness(owner.value);
        lookup.resolve(
            linked
                ? ({
                      id: "22222222-2222-4222-8222-222222222222",
                  } as import("@/bindings").CollectionDescriptor)
                : null,
        );
        await expect(pending).resolves.toBe("superseded");
        expect(mocks.writeDbGame).not.toHaveBeenCalled();
        expect(fixture.store.getState()).toBe(replacement);
        expect(fixture.store.getState().dirty).toBe(true);
        expect(getFileFreshness(owner.value)).toBe(freshness);
    },
);

test("a current standalone owner saves after the deferred collection lookup", async () => {
    const { tauri } = await import("@/platform/tauri");
    const { fixture, database } = databaseSaveFixture();
    const lookup = deferred<import("@/bindings").CollectionDescriptor | null>();
    vi.mocked(tauri.collectionForDatabase).mockReturnValueOnce(lookup.promise);
    mocks.writeDbGame.mockResolvedValueOnce(stampB);
    const pgn = serializeStoreTree(fixture.store);
    const pending = saveToFile({
        tab: fixture.tabs[0],
        updateTab: fixture.updateTab,
        getTab: fixture.getTab,
        store: fixture.store,
    });
    expect(tauri.collectionForDatabase).toHaveBeenCalledExactlyOnceWith(database);
    expect(mocks.writeDbGame).not.toHaveBeenCalled();
    lookup.resolve(null);
    await expect(pending).resolves.toBe("saved");
    expect(mocks.writeDbGame).toHaveBeenCalledExactlyOnceWith(database, 42, pgn, stampA);
    expect(fixture.store.getState().dirty).toBe(false);
});

test("a dirty pre-link database tree is preserved and cannot write a retired copy", async () => {
    await initializeI18n();
    const { tauri } = await import("@/platform/tauri");
    const { fixture } = databaseSaveFixture();
    const lookup = deferred<import("@/bindings").CollectionDescriptor | null>();
    vi.mocked(tauri.collectionForDatabase).mockReturnValueOnce(lookup.promise);
    const before = serializeStoreTree(fixture.store);
    const state = fixture.store.getState();
    const pending = saveToFile({
        tab: fixture.tabs[0],
        updateTab: fixture.updateTab,
        getTab: fixture.getTab,
        store: fixture.store,
    });
    expect(mocks.writeDbGame).not.toHaveBeenCalled();
    lookup.resolve({
        id: "22222222-2222-4222-8222-222222222222",
    } as import("@/bindings").CollectionDescriptor);
    await expect(pending).resolves.toMatchObject({
        status: "failed",
        error: { category: "validation", message: i18n.t("Collections.RetiredTab") },
    });
    expect(mocks.writeDbGame).not.toHaveBeenCalled();
    expect(serializeStoreTree(fixture.store)).toBe(before);
    expect(fixture.store.getState()).toBe(state);
    expect(fixture.store.getState().dirty).toBe(true);
});

function targetFile() {
    return {
        type: "file" as const,
        handle: destinationHandle,
        name: "destination.pgn",
        numGames: 8,
        metadata: { type: "game" as const, tags: [] },
        lastModified: 1,
    };
}

function saveFresh(fixture: ReturnType<typeof saveFixture>, store = fixture.store) {
    return saveToFile({
        tab: fixture.tabs[0],
        store,
        getTab: fixture.getTab,
        updateTab: fixture.updateTab,
        isUserSave: true,
    });
}

test.each([0, 8])(
    "fresh first save appends at count %i without reading or replacing a game",
    async (count) => {
        const fixture = saveFixture({ kind: "none", stamp: null });
        fixture.store.getState().makeMoves({ payload: ["e4", "e5"] });
        fixture.store.getState().setComment("First saved comment");
        const pgn = serializeStoreTree(fixture.store);
        mocks.pickPgnFile.mockResolvedValueOnce({ ...targetFile(), numGames: count });
        const pending = deferred<{ stamp: string; revision: string }>();
        mocks.writeGame.mockImplementationOnce(() => {
            expect(new TabStorageRepository().read("save-test")?.state).toMatchObject({
                appendAttempted: true,
            });
            return pending.promise;
        });
        const saving = saveFresh(fixture);
        await vi.waitFor(() => expect(mocks.writeGame).toHaveBeenCalledOnce());
        expect(fixture.tabs[0].gameOrigin).toEqual({ kind: "none" });
        expect(fixture.store.getState().dirty).toBe(true);
        pending.resolve({ stamp: stampB, revision: "fresh-write" });
        await expect(saving).resolves.toBe("saved");
        expect(mocks.pickPgnFile).toHaveBeenCalledExactlyOnceWith("export");
        expect(mocks.readFileGame).not.toHaveBeenCalled();
        expect(mocks.writeGame).toHaveBeenCalledExactlyOnceWith(destinationHandle, count, pgn, {
            kind: "append",
        });
        expect(pgn).toContain("1. e4 e5");
        expect(pgn).toContain("First saved comment");
        expect(fixture.tabs[0].gameOrigin).toMatchObject({
            kind: "file",
            gameNumber: count,
            file: { numGames: count + 1 },
        });
        expect(fixture.store.getState()).toMatchObject({
            dirty: false,
            sourceStamp: stampB,
            appendAttempted: false,
        });
        expect(getFileFreshness("save-test")).toMatchObject({
            state: "verified",
            verifiedRevision: "fresh-write",
        });
    },
);

async function appendWithJotaiSuccessor(
    originKind: "none" | "file",
    completion: "ordinary" | "physical-replacement" | "origin-replacement",
) {
    const id = crypto.randomUUID();
    const workspace = createStore();
    const tree = { ...defaultTree(), dirty: true, sourceStamp: stampA };
    tree.root.comment = "Captured append";
    tabStorage.seed(id, tree);
    const store = createTreeStore(id);
    const owner: Tab = {
        value: id,
        name: "Append owner",
        type: "analysis",
        gameOrigin:
            originKind === "none"
                ? { kind: "none" }
                : {
                      kind: "file",
                      gameNumber: 2,
                      file: { ...targetFile(), handle: fileHandle, numGames: 4 },
                  },
    };
    expect(workspace.set(tabsAtom, [owner], id)).toBe(true);
    const getTab = (tabId: string) => workspace.get(tabsAtom).find((tab) => tab.value === tabId);
    const selected = targetFile();
    let admitted = false;
    let replacementKey = id;
    let replacementState: ReturnType<typeof store.getState> | undefined;
    let replacementFreshness: ReturnType<typeof getFileFreshness> | undefined;
    const unsubscribe = workspace.sub(tabsAtom, () => {
        const current = getTab(id);
        if (
            admitted ||
            !isFileBackedTab(current) ||
            current.gameOrigin.gameNumber !== selected.numGames
        )
            return;
        admitted = true;
        if (completion === "ordinary") return;
        const replacement = {
            ...defaultTree(),
            dirty: true,
            sourceStamp: stampC,
            appendAttempted: true,
        };
        replacement.root.comment = "Reentrant foreign owner";
        replacementKey = completion === "physical-replacement" ? crypto.randomUUID() : id;
        tabStorage.seed(replacementKey, replacement);
        expect(
            workspace.set(
                tabsAtom,
                [
                    {
                        ...current,
                        treeKey: replacementKey,
                        gameOrigin:
                            completion === "physical-replacement"
                                ? current.gameOrigin
                                : {
                                      ...current.gameOrigin,
                                      gameNumber: selected.numGames + 2,
                                  },
                    },
                ],
                undefined,
                () => retargetTreeStore(id, replacementKey, replacement),
            ),
        ).toBe(true);
        setFileFreshness(id, "conflict", { conflictReason: "changed" });
        replacementState = store.getState();
        replacementFreshness = getFileFreshness(id);
    });
    try {
        mocks.writeGame.mockResolvedValueOnce({
            stamp: stampB,
            revision: "admitted-append",
        });
        const result = await appendStoreGame({
            tab: owner,
            store,
            selected,
            pgn: serializeStoreTree(store),
            getTab,
            isCurrent: () => {
                const current = getTab(id);
                return (
                    sameTabOwner(current, owner) &&
                    (owner.gameOrigin.kind === "none"
                        ? current.gameOrigin.kind === "none"
                        : isFileBackedTab(owner) && matchesFileGameTab(current, owner.gameOrigin))
                );
            },
            updateTab: (tabId, update, onAdmitted) =>
                updateTabById(
                    (tabs, active, saved) => workspace.set(tabsAtom, tabs, active, saved),
                    tabId,
                    update,
                    onAdmitted,
                ),
            prepareMessage: "Could not prepare append",
        });
        expect(admitted).toBe(true);
        return {
            result,
            state: store.getState(),
            origin: getTab(id)?.gameOrigin,
            freshness: getFileFreshness(id),
            selected,
            replacementState,
            replacementFreshness,
            storedState: new TabStorageRepository().read(replacementKey)?.state,
        };
    } finally {
        unsubscribe();
        closeTreeStore(id);
        tabStorage.remove(id);
        if (replacementKey !== id) tabStorage.remove(replacementKey);
    }
}

test.each(["none", "file"] as const)(
    "%s-origin append completion follows its exact Jotai-admitted successor after ordinary admission",
    async (originKind) => {
        const { result, state, origin, freshness, selected } = await appendWithJotaiSuccessor(
            originKind,
            "ordinary",
        );
        expect(result).toBe("saved");
        expect(state).toMatchObject({ dirty: false, sourceStamp: stampB, appendAttempted: false });
        expect(origin).toMatchObject({ kind: "file", gameNumber: selected.numGames });
        expect(freshness).toMatchObject({ state: "verified", verifiedRevision: "admitted-append" });
    },
);

test.each(
    (["none", "file"] as const).flatMap((originKind) =>
        (["physical-replacement", "origin-replacement"] as const).map((completion) => ({
            originKind,
            completion,
        })),
    ),
)(
    "$originKind-origin append completion follows its exact Jotai-admitted successor after $completion",
    async ({ originKind, completion }) => {
        const { result, state, freshness, replacementState, replacementFreshness, storedState } =
            await appendWithJotaiSuccessor(originKind, completion);
        expect(result).toBe("superseded");
        expect(state).toBe(replacementState);
        expect(freshness).toBe(replacementFreshness);
        expect(storedState).toMatchObject({
            dirty: true,
            sourceStamp: stampC,
            appendAttempted: true,
            root: { comment: "Reentrant foreign owner" },
        });
    },
);

function expectForeignFirstSave(
    result: Awaited<ReturnType<typeof saveToFile>>,
    store: ReturnType<typeof createTreeStore>,
    replacement: ReturnType<typeof store.getState> | undefined,
    id: string,
) {
    expect(result).toBe("superseded");
    expect(store.getState()).toBe(replacement);
    expect(getFileFreshness(id).state).toBe("conflict");
}

async function expectRefusedFirstSave(
    result: Awaited<ReturnType<typeof saveToFile>>,
    observed: boolean,
    actions: ReturnType<typeof useTabActions>,
    store: ReturnType<typeof createTreeStore>,
    id: string,
) {
    expect(result).toMatchObject({ status: "failed" });
    expect(observed).toBe(false);
    expect(actions.getTab(id)?.gameOrigin).toEqual({ kind: "none" });
    expect(store.getState().appendAttempted).toBe(true);
    tabStorage.flush();
    expect(new TabStorageRepository().read(id)?.state).toMatchObject({
        appendAttempted: true,
        dirty: true,
    });
    await expect(saveToFile({ tab: actions.getTab(id), store, ...actions })).resolves.toMatchObject(
        { status: "failed" },
    );
    expect(mocks.writeGame).toHaveBeenCalledOnce();
}

test.each([
    "snapshot",
    "newer-edit",
    "physical-replacement",
    "origin-replacement",
    "refusal",
] as const)("first-save provider preserves admitted subscriber failure for %s", async (outcome) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const id = crypto.randomUUID();
    const workspace = createStore();
    const tree = { ...defaultTree(), dirty: true };
    tree.root.comment = "Captured first save";
    tabStorage.seed(id, tree);
    const store = createTreeStore(id);
    const owner: Tab = {
        value: id,
        name: "Keep settings owner",
        type: "analysis",
        gameOrigin: { kind: "none" },
    };
    workspace.set(tabsAtom, [owner], id);
    let actions!: ReturnType<typeof useTabActions>;
    function Probe() {
        actions = useTabActions();
        return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    let replacement: ReturnType<typeof store.getState> | undefined;
    let unsubscribe = () => {};
    const failure = new Error("First-save workspace subscriber failed");
    try {
        await act(async () =>
            root.render(createElement(Provider, { store: workspace }, createElement(Probe))),
        );
        let observed = false;
        unsubscribe = workspace.sub(tabsAtom, () => {
            if (observed) return;
            observed = true;
            const admitted = actions.getTab(id)!;
            expect(admitted.gameOrigin).toMatchObject({ kind: "file", gameNumber: 8 });
            expect(loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY).tabs[0]).toEqual(admitted);
            if (outcome === "physical-replacement" || outcome === "origin-replacement") {
                workspace.set(tabsAtom, [
                    {
                        ...admitted,
                        ...(outcome === "physical-replacement"
                            ? { treeKey: crypto.randomUUID() }
                            : { gameOrigin: { kind: "none" as const } }),
                    },
                ]);
                store.getState().setComment("Foreign owner edit");
                replacement = store.getState();
                setFileFreshness(id, "conflict");
            }
            throw failure;
        });
        mocks.pickPgnFile.mockResolvedValueOnce(targetFile());
        const pending = deferred<{ stamp: string; revision: string }>();
        mocks.writeGame.mockReturnValueOnce(pending.promise);
        const saving = saveToFile({ tab: owner, store, ...actions, isUserSave: true });
        await vi.waitFor(() => expect(mocks.writeGame).toHaveBeenCalledOnce());
        if (outcome === "newer-edit") store.getState().setComment("Newer first-save edit");
        const original = Storage.prototype.setItem;
        const refusal =
            outcome === "refusal"
                ? vi
                      .spyOn(Storage.prototype, "setItem")
                      .mockImplementation(function (this: Storage, key, value) {
                          if (key === WORKSPACE_STORAGE_KEY)
                              throw new DOMException("workspace refused", "QuotaExceededError");
                          original.call(this, key, value);
                      })
                : undefined;
        pending.resolve({ stamp: stampB, revision: "first-admitted" });
        const result = await saving;
        refusal?.mockRestore();
        unsubscribe();
        if (outcome === "physical-replacement" || outcome === "origin-replacement") {
            expectForeignFirstSave(result, store, replacement, id);
            return;
        }
        if (outcome === "refusal") {
            await expectRefusedFirstSave(result, observed, actions, store, id);
            return;
        }
        expect(result).toMatchObject({
            status: "failed",
            error: { message: expect.stringContaining(failure.message) },
        });
        expect(actions.getTab(id)).toMatchObject({
            value: id,
            name: owner.name,
            gameOrigin: { kind: "file", gameNumber: 8 },
        });
        expect(store.getState()).toMatchObject({
            sourceStamp: stampB,
            appendAttempted: false,
            dirty: outcome === "newer-edit",
            root: {
                comment: outcome === "newer-edit" ? "Newer first-save edit" : "Captured first save",
            },
        });
        tabStorage.flush();
        expect(new TabStorageRepository().read(id)?.state).toMatchObject({
            sourceStamp: stampB,
            appendAttempted: false,
            dirty: outcome === "newer-edit",
        });
        expect(getFileFreshness(id)).toMatchObject({
            state: "verified",
            verifiedRevision: "first-admitted",
        });
        store.getState().setComment("Deliberate later Save");
        mocks.readFileGame.mockResolvedValueOnce({ pgn: "1. e4 *", stamp: stampB, present: true });
        mocks.writeGame.mockResolvedValueOnce({ stamp: stampC, revision: "later-cas" });
        await expect(
            saveToFile({ tab: actions.getTab(id), store, ...actions, isUserSave: true }),
        ).resolves.toBe("saved");
        expect(mocks.writeGame).toHaveBeenLastCalledWith(destinationHandle, 8, expect.any(String), {
            kind: "game",
            stamp: stampB,
        });
        expect(mocks.pickPgnFile).toHaveBeenCalledOnce();
    } finally {
        unsubscribe();
        await act(async () => root.unmount());
        closeTreeStore(id);
        tabStorage.remove(id);
        removeFileFreshness(id);
    }
});

test.each(["none", "file"] as const)(
    "%s-origin append rechecks no-throw subscriber edits before reporting saved",
    async (kind) => {
        Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
        const id = crypto.randomUUID();
        const workspace = createStore();
        const owner: Tab = {
            value: id,
            name: "Subscriber owner",
            type: "analysis",
            gameOrigin:
                kind === "none"
                    ? { kind: "none" }
                    : { kind: "file", file: targetFile(), gameNumber: 2 },
        };
        const tree = { ...defaultTree(), dirty: true };
        tree.root.comment = "Written snapshot";
        tabStorage.seed(id, tree);
        const store = createTreeStore(id);
        workspace.set(tabsAtom, [owner], id);
        let actions!: ReturnType<typeof useTabActions>;
        function Probe() {
            actions = useTabActions();
            return null;
        }
        const host = document.createElement("div");
        const root = createRoot(host);
        let unsubscribe = () => {};
        try {
            await act(async () =>
                root.render(createElement(Provider, { store: workspace }, createElement(Probe))),
            );
            unsubscribe = workspace.sub(tabsAtom, () =>
                store.getState().setComment("No-throw subscriber edit"),
            );
            const pgn = serializeStoreTree(store);
            mocks.pickPgnFile.mockResolvedValueOnce(targetFile());
            mocks.writeGame.mockResolvedValueOnce({ stamp: stampB, revision: "subscriber-edited" });
            const saving =
                kind === "none"
                    ? saveToFile({ tab: owner, store, ...actions, isUserSave: true })
                    : appendStoreGame({
                          tab: owner,
                          store,
                          ...actions,
                          selected: targetFile(),
                          pgn,
                          isCurrent: () => sameTabOwner(actions.getTab(id), owner),
                          prepareMessage: "Could not prepare append",
                      });
            await expect(saving).resolves.toBe(kind === "none" ? "superseded" : "edited");
            unsubscribe();
            expect(store.getState()).toMatchObject({
                dirty: true,
                sourceStamp: stampB,
                appendAttempted: false,
                root: { comment: "No-throw subscriber edit" },
            });
            expect(actions.getTab(id)?.gameOrigin).toMatchObject({ kind: "file", gameNumber: 8 });
            tabStorage.flush();
            expect(new TabStorageRepository().read(id)?.state).toMatchObject({
                dirty: true,
                sourceStamp: stampB,
                appendAttempted: false,
                root: { comment: "No-throw subscriber edit" },
            });
            closeTreeStore(id);
            const cold = createTreeStore(id);
            expect(cold.getState()).toMatchObject({
                dirty: true,
                sourceStamp: stampB,
                appendAttempted: false,
                root: { comment: "No-throw subscriber edit" },
            });
            mocks.readFileGame.mockResolvedValueOnce({
                pgn: "1. e4 *",
                stamp: stampB,
                present: true,
            });
            mocks.writeGame.mockResolvedValueOnce({
                stamp: stampC,
                revision: "subscriber-edit-saved",
            });
            await expect(
                saveToFile({ tab: actions.getTab(id), store: cold, ...actions, isUserSave: true }),
            ).resolves.toBe("saved");
            expect(mocks.writeGame).toHaveBeenLastCalledWith(
                destinationHandle,
                8,
                expect.stringContaining("No-throw subscriber edit"),
                { kind: "game", stamp: stampB },
            );
            expect(
                mocks.writeGame.mock.calls.filter((call) => call[3].kind === "append"),
            ).toHaveLength(1);
        } finally {
            unsubscribe();
            await act(async () => root.unmount());
            closeTreeStore(id);
            tabStorage.remove(id);
            removeFileFreshness(id);
        }
    },
);

test("fresh picker cancellation leaves the board unchanged", async () => {
    const fixture = saveFixture({ kind: "none", stamp: null });
    const before = fixture.store.getState();
    mocks.pickPgnFile.mockResolvedValueOnce(null);
    await expect(saveFresh(fixture)).resolves.toBe("cancelled");
    expect(fixture.store.getState()).toBe(before);
    expect(fixture.tabs[0].gameOrigin).toEqual({ kind: "none" });
    expect(mocks.writeGame).not.toHaveBeenCalled();
});

test("fresh picker failure leaves the board unchanged", async () => {
    const fixture = saveFixture({ kind: "none", stamp: null });
    const before = fixture.store.getState();
    mocks.pickPgnFile.mockRejectedValueOnce(new Error("Picker failed"));
    await expect(saveFresh(fixture)).resolves.toMatchObject({
        status: "failed",
        error: { message: "Picker failed" },
    });
    expect(fixture.store.getState()).toBe(before);
    expect(fixture.tabs[0].gameOrigin).toEqual({ kind: "none" });
    expect(mocks.writeGame).not.toHaveBeenCalled();
});

test("fresh append queues a concurrent save and supersedes it after rebinding", async () => {
    const fixture = saveFixture({ kind: "none", stamp: null });
    mocks.pickPgnFile.mockResolvedValue(targetFile());
    const pending = deferred<{ stamp: string; revision: string }>();
    mocks.writeGame.mockReturnValueOnce(pending.promise);
    const first = saveFresh(fixture);
    const second = saveFresh(fixture);
    await vi.waitFor(() => expect(mocks.writeGame).toHaveBeenCalledOnce());
    pending.resolve({ stamp: stampB, revision: "fresh-write" });
    await expect(first).resolves.toBe("saved");
    await expect(second).resolves.toBe("superseded");
    expect(mocks.writeGame).toHaveBeenCalledOnce();
});

test("fresh append queues a concurrent save and blocks it after an uncertain failure", async () => {
    await initializeI18n();
    const fixture = saveFixture({ kind: "none", stamp: null });
    mocks.pickPgnFile.mockResolvedValue(targetFile());
    const pending = deferred<{ stamp: string; revision: string }>();
    mocks.writeGame.mockReturnValueOnce(pending.promise);
    const first = saveFresh(fixture);
    await vi.waitFor(() => expect(mocks.writeGame).toHaveBeenCalledOnce());
    const second = saveFresh(fixture);
    pending.reject({
        tag: "backend-error",
        category: "durability",
        message: "Committed but durability uncertain: follow-up",
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(mocks.writeGame).toHaveBeenCalledOnce();
    expect(firstResult).toMatchObject({
        status: "failed",
        error: { category: "applied-despite-error", backendCategory: "durability" },
    });
    expect(secondResult).toMatchObject({
        status: "failed",
        error: {
            category: "applied-despite-error",
            message: i18n.t("FileFreshness.AppendMayHaveBeenAdded"),
        },
    });
    expect(fixture.store.getState().appendAttempted).toBe(true);
    tabStorage.flush();
    expect(new TabStorageRepository().read("save-test")?.state).toMatchObject({
        appendAttempted: true,
    });
});

test("fresh stale-count refusal clears only its marker and permits a counted retry", async () => {
    const fixture = saveFixture({ kind: "none", stamp: null });
    mocks.pickPgnFile
        .mockResolvedValueOnce(targetFile())
        .mockResolvedValueOnce({ ...targetFile(), numGames: 9 });
    mocks.writeGame.mockRejectedValueOnce({
        tag: "backend-error",
        category: "stale-game",
        message: "Concurrent append",
    });
    await expect(saveFresh(fixture)).resolves.toMatchObject({
        status: "failed",
        error: { backendCategory: "stale-game" },
    });
    expect(fixture.store.getState()).toMatchObject({ dirty: true, appendAttempted: false });
    expect(new TabStorageRepository().read("save-test")?.state).toMatchObject({
        appendAttempted: false,
    });
    mocks.writeGame.mockResolvedValueOnce({ stamp: stampB, revision: "retry" });
    await expect(saveFresh(fixture)).resolves.toBe("saved");
    expect(mocks.writeGame).toHaveBeenLastCalledWith(destinationHandle, 9, expect.any(String), {
        kind: "append",
    });
});

test.each(["picker", "write"])(
    "fresh completion after owner replacement at %s changes nothing",
    async (boundary) => {
        const fixture = saveFixture({ kind: "none", stamp: null });
        const selected = deferred<ReturnType<typeof targetFile>>();
        const written = deferred<{ stamp: string; revision: string }>();
        mocks.pickPgnFile.mockReturnValueOnce(
            boundary === "picker" ? selected.promise : Promise.resolve(targetFile()),
        );
        mocks.writeGame.mockReturnValueOnce(written.promise);
        const saving = saveFresh(fixture);
        await vi.waitFor(() =>
            expect(mocks.writeGame).toHaveBeenCalledTimes(boundary === "write" ? 1 : 0),
        );
        fixture.updateTab("save-test", (previous) => ({
            ...previous,
            treeKey: crypto.randomUUID(),
        }));
        fixture.store.getState().setComment("Replacement generation");
        const replacement = fixture.store.getState();
        setFileFreshness("save-test", "unverified");
        const freshness = getFileFreshness("save-test");
        selected.resolve(targetFile());
        written.resolve({ stamp: stampB, revision: "late-write" });
        await expect(saving).resolves.toBe("superseded");
        expect(fixture.store.getState()).toBe(replacement);
        expect(getFileFreshness("save-test")).toBe(freshness);
        expect(fixture.tabs[0].gameOrigin).toEqual({ kind: "none" });
        expect(mocks.writeGame).toHaveBeenCalledTimes(boundary === "write" ? 1 : 0);
    },
);

test("fresh append refuses a guard that cannot be persisted to the physical tree key", async () => {
    const fixture = saveFixture({ kind: "none", stamp: null });
    const physical = crypto.randomUUID();
    fixture.updateTab("save-test", (previous) => ({ ...previous, treeKey: physical }));
    tabStorage.seed(physical, fixture.tree);
    closeTreeStore("save-test");
    const store = createTreeStore("save-test", undefined, physical);
    mocks.pickPgnFile.mockResolvedValueOnce(targetFile());
    const original = Storage.prototype.setItem;
    const refuse = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
            if (key === physical) throw new DOMException("quota", "QuotaExceededError");
            original.call(this, key, value);
        });
    await expect(saveFresh(fixture, store)).resolves.toMatchObject({ status: "failed" });
    expect(mocks.writeGame).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ dirty: true, appendAttempted: false });
    refuse.mockRestore();
    tabStorage.remove(physical);
});

test("a newly appended linked game keeps its generation across tree restart and the next Save", async () => {
    const fixture = saveFixture({ kind: "none", stamp: null });
    const locator = {
        collection: "22222222-2222-4222-8222-222222222222",
        generation: "appended-generation",
        ordinal: 8,
        stamp: stampB,
    };
    mocks.pickPgnFile.mockResolvedValueOnce(targetFile());
    mocks.writeGame.mockResolvedValueOnce({
        stamp: stampB,
        revision: locator.generation,
        linked: locator,
    });
    await expect(saveFresh(fixture)).resolves.toBe("saved");
    expect(fixture.store.getState().linkedSource).toEqual(locator);
    tabStorage.flush();
    expect(new TabStorageRepository().read("save-test")?.state).toMatchObject({
        linkedSource: locator,
    });
    closeTreeStore("save-test");
    const cold = createTreeStore("save-test");
    cold.getState().setComment("Edit after restart");
    mocks.readFileGame.mockResolvedValueOnce({ pgn: "1. e4 *", stamp: stampB, present: true });
    mocks.writeGame.mockResolvedValueOnce({
        stamp: stampC,
        revision: "saved-generation",
        linked: { ...locator, stamp: stampC, generation: "saved-generation" },
    });
    await expect(saveFresh(fixture, cold)).resolves.toBe("saved");
    expect(mocks.writeGame).toHaveBeenLastCalledWith(targetFile().handle, 8, expect.any(String), {
        kind: "linkedGame",
        stamp: stampB,
        revision: locator.generation,
    });
    expect(cold.getState().linkedSource).toMatchObject({
        generation: "saved-generation",
        stamp: stampC,
    });
});

test.each(["null-stamp", "null-revision", "applied-error", "admission-refused"])(
    "fresh %s preserves dirty edits and refuses retry through a cold reload",
    async (outcome) => {
        await initializeI18n();
        const fixture = saveFixture({ kind: "none", stamp: null });
        mocks.pickPgnFile.mockResolvedValueOnce(targetFile());
        if (outcome === "applied-error")
            mocks.writeGame.mockRejectedValueOnce({
                tag: "backend-error",
                category: "durability",
                message: "Committed but durability uncertain: follow-up",
            });
        else
            mocks.writeGame.mockResolvedValueOnce({
                stamp: outcome === "null-stamp" ? null : stampB,
                revision: outcome === "null-revision" ? null : "write",
            });
        const save = (store = fixture.store) =>
            saveToFile({
                tab: fixture.tabs[0],
                store,
                getTab: fixture.getTab,
                updateTab: outcome === "admission-refused" ? () => false : fixture.updateTab,
            });
        await expect(save()).resolves.toMatchObject({
            status: "failed",
            error: {
                message: expect.stringContaining(i18n.t("FileFreshness.AppendMayHaveBeenAdded")),
            },
        });
        expect(fixture.tabs[0].gameOrigin).toEqual({ kind: "none" });
        expect(fixture.store.getState()).toMatchObject({
            dirty: true,
            sourceStamp: null,
            appendAttempted: true,
            headers: { event: "Unsaved version" },
        });
        await expect(save()).resolves.toMatchObject({
            status: "failed",
            error: { message: i18n.t("FileFreshness.AppendMayHaveBeenAdded") },
        });
        expect(tabStorage.flush()).toEqual([]);
        expect(new TabStorageRepository().read("save-test")?.state).toMatchObject({
            dirty: true,
            appendAttempted: true,
        });
        closeTreeStore("save-test");
        const cold = createTreeStore("save-test");
        expect(cold).not.toBe(fixture.store);
        expect(cold.getState()).toMatchObject({
            dirty: true,
            appendAttempted: true,
            headers: { event: "Unsaved version" },
        });
        await expect(save(cold)).resolves.toMatchObject({ status: "failed" });
        expect(mocks.writeGame).toHaveBeenCalledOnce();
        expect(mocks.pickPgnFile).toHaveBeenCalledOnce();
    },
);

test("fresh adoption retains edits made during its append and clears the admitted marker", async () => {
    const fixture = saveFixture({ kind: "none", stamp: null });
    mocks.pickPgnFile.mockResolvedValueOnce(targetFile());
    const pending = deferred<{ stamp: string; revision: string }>();
    mocks.writeGame.mockReturnValueOnce(pending.promise);
    const saving = saveFresh(fixture);
    await vi.waitFor(() => expect(mocks.writeGame).toHaveBeenCalledOnce());
    fixture.store.getState().setComment("Later edit");
    pending.resolve({ stamp: stampB, revision: "write" });
    await expect(saving).resolves.toBe("superseded");
    expect(fixture.store.getState()).toMatchObject({
        dirty: true,
        sourceStamp: stampB,
        appendAttempted: false,
        root: { comment: "Later edit" },
    });
    expect(fixture.tabs[0].gameOrigin).toMatchObject({ kind: "file", gameNumber: 8 });
});

test("file saves send the source stamp as a required CAS and persist the returned stamp", async () => {
    const fixture = saveFixture();
    mocks.lexPgn.mockResolvedValueOnce([
        { type: "San", value: "e4" },
        { type: "Outcome", value: "*" },
    ]);
    mocks.writeGame.mockResolvedValueOnce({ stamp: stampB, revision: "r-new" });

    await expect(
        saveToFile({
            tab: fixture.tabs[0],
            updateTab: fixture.updateTab,
            getTab: fixture.getTab,
            store: fixture.store,
        }),
    ).resolves.toBe("saved");

    expect(mocks.writeGame).toHaveBeenCalledWith(fileHandle, 2, expect.any(String), {
        kind: "game",
        stamp: stampA,
    });
    expect(mocks.readFileGame).toHaveBeenCalledWith(fileHandle, 2);
    expect(mocks.lexPgn).toHaveBeenCalledWith("1. e4 *", undefined);
    expect(fixture.store.getState()).toMatchObject({ dirty: false, sourceStamp: stampB });
    expect(getFileFreshness("save-test")).toMatchObject({
        state: "verified",
        verifiedRevision: "r-new",
    });
});

test("a save ignores a conflicting poll outcome that resolves during its write", async () => {
    vi.useFakeTimers();
    const fixture = saveFixture();
    setFileFreshness("save-test", "verified", { verifiedRevision: "r-old" });
    const epoch = getFileFreshness("save-test").epoch;
    const pollOutcome = deferred<string>();
    const pendingWrite = deferred<{ stamp: string | null; revision: string | null }>();
    let revisionCalls = 0;
    const fileRevision = vi.fn((_handle: FileWorkspaceHandle, _options: { signal: AbortSignal }) =>
        ++revisionCalls === 1 ? pollOutcome.promise : Promise.resolve("r-written"),
    );
    let focus!: () => void;
    const stop = startFileRevisionPoll({
        getTabs: () => fixture.tabs,
        fileRevision,
        subscribeFocus: (callback) => {
            focus = callback;
            return () => undefined;
        },
    });

    try {
        focus();
        for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
        expect(fileRevision).toHaveBeenCalledOnce();

        mocks.writeGame.mockReturnValueOnce(pendingWrite.promise);
        const saving = saveToFile({
            tab: fixture.tabs[0],
            updateTab: fixture.updateTab,
            getTab: fixture.getTab,
            store: fixture.store,
        });
        await Promise.resolve();
        pollOutcome.reject({
            tag: "backend-error",
            category: "conflict",
            message: "path authority changed during the poll",
        });
        for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();

        expect(getFileFreshness("save-test")).toMatchObject({
            state: "verified",
            verifiedRevision: "r-old",
            epoch,
        });

        pendingWrite.resolve({ stamp: stampB, revision: "r-written" });
        await expect(saving).resolves.toBe("saved");
        for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();

        expect(fileRevision).toHaveBeenCalledTimes(2);
        expect(getFileFreshness("save-test")).toMatchObject({
            state: "verified",
            verifiedRevision: "r-written",
        });
    } finally {
        stop();
    }
});

test("a save without a read-back stamp stays unverified", async () => {
    const fixture = saveFixture();
    mocks.writeGame.mockResolvedValueOnce({ stamp: null, revision: null });

    await expect(
        saveToFile({
            tab: fixture.tabs[0],
            updateTab: fixture.updateTab,
            getTab: fixture.getTab,
            store: fixture.store,
        }),
    ).resolves.toBe("conflict");

    expect(fixture.store.getState()).toMatchObject({ dirty: true, sourceStamp: null });
    expect(getFileFreshness("save-test").state).toBe("unverified");
});

test("file saves with a missing stamp conflict without calling the native writer", async () => {
    const fixture = saveFixture({ stamp: null });

    await expect(
        saveToFile({
            tab: fixture.tabs[0],
            updateTab: fixture.updateTab,
            getTab: fixture.getTab,
            store: fixture.store,
        }),
    ).resolves.toBe("conflict");

    expect(mocks.writeGame).not.toHaveBeenCalled();
    expect(fixture.store.getState().dirty).toBe(true);
});

test("a stale-game rejection becomes a conflict without clearing edits", async () => {
    const fixture = saveFixture();
    const stale = Object.assign(new Error("The game changed on disk"), {
        details: {
            category: "validation",
            backendCategory: "stale-game",
            message: "The game changed on disk",
        },
    });
    mocks.writeGame.mockRejectedValueOnce(stale);

    await expect(
        saveToFile({
            tab: fixture.tabs[0],
            updateTab: fixture.updateTab,
            getTab: fixture.getTab,
            store: fixture.store,
        }),
    ).resolves.toBe("conflict");

    expect(fixture.store.getState()).toMatchObject({ dirty: true, sourceStamp: stampA });
    expect(getFileFreshness("save-test").state).toBe("conflict");
});

test.each(["missing-resource", "invalid-input"] as const)(
    "a current-owner %s save rejection marks its source unavailable",
    async (category) => {
        const fixture = saveFixture();
        mocks.writeGame.mockRejectedValueOnce({ tag: "backend-error", category, message: "gone" });
        await expect(
            saveToFile({
                tab: fixture.tabs[0],
                updateTab: fixture.updateTab,
                getTab: fixture.getTab,
                store: fixture.store,
            }),
        ).resolves.toBe("conflict");
        expect(getFileFreshness("save-test").state).toBe("unavailable");
        expect(fixture.store.getState()).toMatchObject({ dirty: true, sourceStamp: stampA });
    },
);

test.each(["stale-game", "conflict", "missing-resource", "invalid-input", "durability"] as const)(
    "a pending save then actual durable replacement ignores its late %s rejection",
    async (category) => {
        const { createStore } = await import("jotai");
        const { atoms, repository, tabs } = await importFreshAdmission();
        const trees = await import("@/state/store/tree");
        const freshness = await import("@/state/fileFreshness");
        const jotai = createStore();
        const fixture = saveFixture();
        const owner = { ...fixture.tabs[0]!, value: crypto.randomUUID() };
        if (!tabs.isFileBackedTab(owner)) throw new Error("Expected a file owner.");
        repository.seed(owner.value, fixture.tree);
        expect(jotai.set(atoms.tabsAtom, [owner], owner.value)).toBe(true);
        const treeStore = trees.createTreeStore(owner.value);
        const write = deferred<{ stamp: string | null; revision: string | null }>();
        mocks.writeGame.mockReturnValueOnce(write.promise);
        try {
            const pending = tabs.saveToFile({
                tab: owner,
                updateTab: () => false,
                getTab: (id) => jotai.get(atoms.tabsAtom).find((tab) => tab.value === id),
                store: treeStore,
            });
            await vi.waitFor(() => expect(mocks.writeGame).toHaveBeenCalledOnce());
            const candidate = defaultTree();
            candidate.headers.event = "Durable replacement";
            candidate.sourceStamp = stampC;
            const result = tabs.replaceFileGame({
                store: jotai,
                owner,
                treeStore,
                snapshot: treeStore.getState(),
                tree: candidate,
                page: 2,
                isCurrent: () => true,
            });
            expect(result.kind).toBe("committed");
            if (result.kind !== "committed") throw new Error("Expected durable replacement.");
            expect(result.treeKey).not.toBe(owner.value);
            expect(trees.createTreeStore(owner.value)).toBe(treeStore);
            freshness.setFileFreshness(owner.value, "verified", {
                verifiedRevision: "replacement",
            });
            const current = treeStore.getState();
            const currentFreshness = freshness.getFileFreshness(owner.value);
            const bytes = sessionStorage.getItem(result.treeKey);
            expect(bytes).not.toBeNull();
            write.reject({
                tag: "backend-error",
                category,
                message:
                    category === "durability"
                        ? "Committed but durability uncertain: follow-up failed"
                        : "Old save rejected",
            });
            const saveResult = await pending;
            expect(treeStore.getState()).toBe(current);
            expect(freshness.getFileFreshness(owner.value)).toBe(currentFreshness);
            expect(saveResult).toBe("superseded");
            expect(sessionStorage.getItem(result.treeKey)).toBe(bytes);
            expect(jotai.get(atoms.tabsAtom)[0]).toMatchObject({
                value: owner.value,
                treeKey: result.treeKey,
            });
        } finally {
            trees.closeTreeStore(owner.value);
            freshness.removeFileFreshness(owner.value);
        }
    },
);

test("a committed save whose follow-up failed is verified by text instead of by its old stamp", async () => {
    const fixture = saveFixture();
    setFileFreshness("save-test", "verified", { verifiedRevision: "r1" });
    mocks.writeGame.mockRejectedValueOnce({
        tag: "backend-error",
        category: "durability",
        message:
            "Committed but durability uncertain: PGN file capability rebind after a committed edit",
    });

    const result = await saveToFile({
        tab: fixture.tabs[0],
        updateTab: fixture.updateTab,
        getTab: fixture.getTab,
        store: fixture.store,
    });

    expect(result).toMatchObject({
        status: "failed",
        error: { category: "applied-despite-error", backendCategory: "durability" },
    });
    expect(fixture.store.getState()).toMatchObject({ dirty: true, sourceStamp: null });
    expect(getFileFreshness("save-test").state).toBe("unverified");
});

test("a generic native conflict stays unverified and returns its typed save failure", async () => {
    const fixture = saveFixture();
    mocks.writeGame.mockRejectedValueOnce({
        tag: "backend-error",
        category: "conflict",
        message: "Conflict: PGN changed after scan",
    });

    const result = await saveToFile({
        tab: fixture.tabs[0],
        updateTab: fixture.updateTab,
        getTab: fixture.getTab,
        store: fixture.store,
    });

    expect(result).toMatchObject({
        status: "failed",
        error: {
            backendCategory: "conflict",
            message: "Conflict: PGN changed after scan",
        },
    });
    expect(getFileFreshness("save-test")).toMatchObject({
        state: "unverified",
        errorMessage: "Conflict: PGN changed after scan",
    });
    expect(fixture.store.getState()).toMatchObject({ dirty: true, sourceStamp: stampA });
});

test.each(["header-only edit", "tree edit"] as const)(
    "an in-flight save with a %s stores the new stamp but stays dirty",
    async (edit) => {
        const fixture = saveFixture();
        let resolveWrite: (result: {
            stamp: string | null;
            revision: string | null;
        }) => void = () => undefined;
        mocks.writeGame.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveWrite = resolve;
            }),
        );
        const pending = saveToFile({
            tab: fixture.tabs[0],
            updateTab: fixture.updateTab,
            getTab: fixture.getTab,
            store: fixture.store,
        });
        await Promise.resolve();
        fixture.store.getState().setHeaders({
            ...fixture.store.getState().headers,
            event:
                edit === "header-only edit" ? "Header changed during save" : "Changed during save",
        });
        if (edit === "tree edit") {
            fixture.store.getState().setComment("Move comment changed during save");
        }
        resolveWrite({ stamp: stampB, revision: "r-new" });

        await expect(pending).resolves.toBe("superseded");
        expect(fixture.store.getState()).toMatchObject({ dirty: true, sourceStamp: stampB });
    },
);

test("a save completing after a game switch applies nothing and returns superseded", async () => {
    const fixture = saveFixture();
    let resolveWrite: (result: { stamp: string | null; revision: string | null }) => void = () =>
        undefined;
    mocks.writeGame.mockReturnValueOnce(
        new Promise((resolve) => {
            resolveWrite = resolve;
        }),
    );
    const pending = saveToFile({
        tab: fixture.tabs[0],
        updateTab: fixture.updateTab,
        getTab: fixture.getTab,
        store: fixture.store,
    });
    await Promise.resolve();
    fixture.updateTab("save-test", (tab) => ({
        ...tab,
        gameOrigin:
            tab.gameOrigin.kind === "file" ? { ...tab.gameOrigin, gameNumber: 3 } : tab.gameOrigin,
    }));
    resolveWrite({ stamp: stampB, revision: "r-new" });

    await expect(pending).resolves.toBe("superseded");
    expect(fixture.tabs[0].gameOrigin).toMatchObject({ gameNumber: 3 });
    expect(fixture.store.getState()).toMatchObject({ dirty: true, sourceStamp: stampA });
});

test("a save completing after physical generation replacement leaves the live candidate unchanged", async () => {
    const fixture = saveFixture();
    const write = deferred<{ stamp: string | null; revision: string | null }>();
    mocks.writeGame.mockReturnValueOnce(write.promise);
    const pending = saveToFile({
        tab: fixture.tabs[0],
        updateTab: fixture.updateTab,
        getTab: fixture.getTab,
        store: fixture.store,
    });
    await Promise.resolve();
    fixture.updateTab("save-test", (tab) => ({ ...tab, treeKey: crypto.randomUUID() }));
    write.resolve({ stamp: stampB, revision: "r-new" });
    await expect(pending).resolves.toBe("superseded");
    expect(fixture.store.getState()).toMatchObject({ dirty: true, sourceStamp: stampA });
});

test("temp-file Save-As rechecks the source and CAS-writes the same target slot", async () => {
    const fixture = saveFixture({ kind: "temp_file" });
    mocks.pickPgnFile.mockResolvedValueOnce(targetFile());
    mocks.readFileGame
        .mockResolvedValueOnce({ stamp: stampA, pgn: "source", revision: "r1", present: true })
        .mockResolvedValueOnce({ stamp: stampA, pgn: "source", revision: "r1", present: true })
        .mockResolvedValueOnce({
            stamp: stampC,
            pgn: "existing destination",
            revision: "r2",
            present: true,
        });
    mocks.writeGame.mockResolvedValueOnce({ stamp: stampB, revision: "r-new" });

    await expect(
        saveToFile({
            tab: fixture.tabs[0],
            updateTab: fixture.updateTab,
            getTab: fixture.getTab,
            store: fixture.store,
            isUserSave: true,
        }),
    ).resolves.toBe("saved");

    expect(mocks.writeGame).toHaveBeenCalledWith(destinationHandle, 2, expect.any(String), {
        kind: "game",
        stamp: stampC,
    });
    expect(fixture.tabs[0].gameOrigin).toMatchObject({
        kind: "file",
        gameNumber: 2,
        file: { handle: destinationHandle },
    });
    expect(getFileFreshness("save-test")).toMatchObject({
        state: "verified",
        verifiedRevision: "r-new",
    });
});

test.each([
    ["first-source", stampB],
    ["first-source", stampA],
    ["post-picker-source", stampB],
    ["post-picker-source", stampA],
    ["picker", "selected"],
    ["picker", "cancelled"],
    ["destination", stampC],
] as const)(
    "Save As %s fulfilled with %s after durable replacement preserves the new generation",
    async (boundary, returned) => {
        const { createStore } = await import("jotai");
        const { atoms, repository, tabs } = await importFreshAdmission();
        const trees = await import("@/state/store/tree");
        const freshness = await import("@/state/fileFreshness");
        const jotai = createStore();
        const fixture = saveFixture({ kind: "temp_file" });
        const owner = { ...fixture.tabs[0]!, value: crypto.randomUUID() };
        if (!tabs.isFileBackedTab(owner)) throw new Error("Expected a temp-file owner.");
        repository.seed(owner.value, fixture.tree);
        expect(jotai.set(atoms.tabsAtom, [owner], owner.value)).toBe(true);
        const treeStore = trees.createTreeStore(owner.value);
        const read = deferred<{ stamp: string; pgn: string; revision: string; present: boolean }>();
        const picker = deferred<ReturnType<typeof targetFile> | null>();
        const source = { stamp: stampA, pgn: "source", revision: "r1", present: true };
        mocks.readFileGame.mockReset();
        mocks.pickPgnFile.mockReset();
        mocks.writeGame.mockReset();
        if (boundary === "first-source") mocks.readFileGame.mockReturnValueOnce(read.promise);
        else {
            mocks.readFileGame.mockResolvedValueOnce(source);
            if (boundary === "post-picker-source")
                mocks.readFileGame.mockReturnValueOnce(read.promise);
            if (boundary === "destination")
                mocks.readFileGame.mockResolvedValueOnce(source).mockReturnValueOnce(read.promise);
        }
        mocks.pickPgnFile.mockReturnValueOnce(
            boundary === "picker" ? picker.promise : Promise.resolve(targetFile()),
        );
        try {
            const pending = tabs.saveToFile({
                tab: owner,
                updateTab: () => false,
                getTab: (id) => jotai.get(atoms.tabsAtom).find((tab) => tab.value === id),
                store: treeStore,
                isUserSave: true,
            });
            for (let turn = 0; turn < 10; turn++) await Promise.resolve();
            const readsBefore = mocks.readFileGame.mock.calls.length;
            expect(readsBefore).toBe(
                boundary === "post-picker-source" ? 2 : boundary === "destination" ? 3 : 1,
            );
            const candidate = defaultTree();
            candidate.headers.event = "Durable replacement during Save As";
            candidate.sourceStamp = stampC;
            const replacement = tabs.replaceFileGame({
                store: jotai,
                owner,
                treeStore,
                snapshot: treeStore.getState(),
                tree: candidate,
                page: 2,
                isCurrent: () => true,
            });
            expect(replacement.kind).toBe("committed");
            if (replacement.kind !== "committed") throw new Error("Expected durable replacement.");
            expect(replacement.treeKey).not.toBe(owner.value);
            expect(jotai.get(atoms.tabsAtom)[0]).toMatchObject({
                value: owner.value,
                gameOrigin: owner.gameOrigin,
            });
            expect(trees.createTreeStore(owner.value)).toBe(treeStore);
            freshness.setFileFreshness(owner.value, "verified", {
                verifiedRevision: "replacement",
            });
            const current = treeStore.getState();
            const currentFreshness = freshness.getFileFreshness(owner.value);
            const bytes = sessionStorage.getItem(replacement.treeKey);
            expect(bytes).not.toBeNull();
            if (boundary === "picker")
                picker.resolve(returned === "cancelled" ? null : targetFile());
            else read.resolve({ ...source, stamp: returned });
            const result = await pending;
            expect(freshness.getFileFreshness(owner.value)).toBe(currentFreshness);
            expect(treeStore.getState()).toBe(current);
            expect(result).toBe("superseded");
            expect(mocks.readFileGame).toHaveBeenCalledTimes(readsBefore);
            expect(mocks.pickPgnFile).toHaveBeenCalledTimes(boundary === "first-source" ? 0 : 1);
            expect(mocks.writeGame).not.toHaveBeenCalled();
            expect(sessionStorage.getItem(replacement.treeKey)).toBe(bytes);
        } finally {
            trees.closeTreeStore(owner.value);
            freshness.removeFileFreshness(owner.value);
        }
    },
);

test.each(["unchanged", "comment", "header", "owner"] as const)(
    "database completion preserves captured PGN and %s content ownership",
    async (change) => {
        const fixture = saveFixture();
        const database = { id: { id: "save-database" }, kind: "database" } as const;
        fixture.updateTab("save-test", (tab) => ({
            ...tab,
            gameOrigin: { kind: "database", database, gameId: 42 },
        }));
        fixture.store.getState().setComment("Captured comment");
        const captured = serializeStoreTree(fixture.store);
        expect(captured).toContain("Captured comment");
        expect(captured).toContain("Unsaved version");
        const write = deferred<string>();
        mocks.writeDbGame.mockReturnValueOnce(write.promise);
        const pending = saveToFile({
            tab: fixture.tabs[0],
            updateTab: fixture.updateTab,
            getTab: fixture.getTab,
            store: fixture.store,
        });
        await Promise.resolve();
        expect(mocks.writeDbGame).toHaveBeenCalledWith(database, 42, captured, stampA);
        if (change === "comment") fixture.store.getState().setComment("Newer unsaved comment");
        if (change === "header")
            fixture.store
                .getState()
                .setHeaders({ ...fixture.store.getState().headers, event: "Newer unsaved header" });
        if (change === "owner")
            fixture.updateTab("save-test", (tab) => ({ ...tab, treeKey: crypto.randomUUID() }));
        const current = serializeStoreTree(fixture.store);
        const freshness = getFileFreshness("save-test");
        write.resolve(stampB);
        const result = await pending;
        expect(fixture.store.getState().dirty).toBe(change !== "unchanged");
        expect(result).toBe(change === "unchanged" ? "saved" : "superseded");
        expect(serializeStoreTree(fixture.store)).toBe(current);
        expect(fixture.store.getState().sourceStamp).toBe(change === "owner" ? stampA : stampB);
        const finalFreshness = getFileFreshness("save-test");
        expect(
            change === "owner"
                ? finalFreshness === freshness
                : finalFreshness.state === "verified" && finalFreshness.verifiedRevision === null,
        ).toBe(true);
        expect(mocks.writeDbGame).toHaveBeenCalledOnce();
    },
);

test("an active first-source mismatch conflicts before the Save As picker", async () => {
    const fixture = saveFixture({ kind: "temp_file" });
    mocks.readFileGame.mockResolvedValueOnce({ stamp: stampB });
    await expect(
        saveToFile({
            tab: fixture.tabs[0],
            updateTab: fixture.updateTab,
            getTab: fixture.getTab,
            store: fixture.store,
            isUserSave: true,
        }),
    ).resolves.toBe("conflict");
    expect(getFileFreshness("save-test").state).toBe("conflict");
    expect(mocks.pickPgnFile).not.toHaveBeenCalled();
    expect(mocks.writeGame).not.toHaveBeenCalled();
});

test("temp-file user Save refuses a missing source stamp before opening the picker", async () => {
    const fixture = saveFixture({ kind: "temp_file", stamp: null });

    await expect(
        saveToFile({
            tab: fixture.tabs[0],
            updateTab: fixture.updateTab,
            getTab: fixture.getTab,
            store: fixture.store,
            isUserSave: true,
        }),
    ).resolves.toBe("conflict");

    expect(mocks.pickPgnFile).not.toHaveBeenCalled();
    expect(mocks.writeGame).not.toHaveBeenCalled();
});

test("a temp-file source changed while its Save-As picker was open is not written", async () => {
    const fixture = saveFixture({ kind: "temp_file" });
    const selected = deferred<ReturnType<typeof targetFile> | null>();
    mocks.pickPgnFile.mockReturnValueOnce(selected.promise);
    mocks.readFileGame
        .mockResolvedValueOnce({ stamp: stampA, pgn: "source", revision: "r1", present: true })
        .mockResolvedValueOnce({
            stamp: stampB,
            pgn: "changed source",
            revision: "r2",
            present: true,
        });
    const pending = saveToFile({
        tab: fixture.tabs[0],
        updateTab: fixture.updateTab,
        getTab: fixture.getTab,
        store: fixture.store,
        isUserSave: true,
    });
    await Promise.resolve();
    selected.resolve(targetFile());

    await expect(pending).resolves.toBe("conflict");
    expect(mocks.writeGame).not.toHaveBeenCalled();
    expect(fixture.tabs[0].gameOrigin.kind).toBe("temp_file");
});

test("a failed Save-As leaves the tab origin and tree stamp untouched", async () => {
    const fixture = saveFixture({ kind: "temp_file" });
    mocks.pickPgnFile.mockResolvedValueOnce(targetFile());
    mocks.readFileGame
        .mockResolvedValueOnce({ stamp: stampA, pgn: "source", revision: "r1", present: true })
        .mockResolvedValueOnce({ stamp: stampA, pgn: "source", revision: "r1", present: true })
        .mockResolvedValueOnce({ stamp: stampC, pgn: "target", revision: "r2", present: true });
    mocks.writeGame.mockRejectedValueOnce(new Error("write failed"));

    const result = await saveToFile({
        tab: fixture.tabs[0],
        updateTab: fixture.updateTab,
        getTab: fixture.getTab,
        store: fixture.store,
        isUserSave: true,
    });

    expect(result).toMatchObject({ status: "failed" });
    expect(fixture.tabs[0].gameOrigin.kind).toBe("temp_file");
    expect(fixture.store.getState()).toMatchObject({ dirty: true, sourceStamp: stampA });
});

test.each([
    ["none", "missing-resource"],
    ["none", "invalid-input"],
    ["temp_file", "missing-resource"],
    ["temp_file", "invalid-input"],
] as const)(
    "a %s tab whose Save-As destination write fails with %s is an ordinary failure, not an unavailable source",
    async (kind, backendCategory) => {
        const fixture = saveFixture({ kind });
        mocks.pickPgnFile.mockResolvedValueOnce(targetFile());
        if (kind === "temp_file") {
            mocks.readFileGame
                .mockResolvedValueOnce({
                    stamp: stampA,
                    pgn: "source",
                    revision: "r1",
                    present: true,
                })
                .mockResolvedValueOnce({
                    stamp: stampA,
                    pgn: "source",
                    revision: "r1",
                    present: true,
                });
        }
        mocks.readFileGame.mockResolvedValueOnce({
            stamp: stampC,
            pgn: "destination game",
            revision: "r2",
            present: true,
        });
        mocks.writeGame.mockRejectedValueOnce({
            tag: "backend-error",
            category: backendCategory,
            message: "The destination is gone",
        });

        const result = await saveToFile({
            tab: fixture.tabs[0],
            updateTab: fixture.updateTab,
            getTab: fixture.getTab,
            store: fixture.store,
            isUserSave: true,
        });

        expect(result).toMatchObject({ status: "failed", error: { backendCategory } });
        expect(getFileFreshness("save-test").state).not.toBe("unavailable");
        expect(fixture.tabs[0].gameOrigin.kind).toBe(kind);
        expect(fixture.store.getState()).toMatchObject({ dirty: true, sourceStamp: stampA });
    },
);

test("a stale Save-As destination is a visible typed failure without changing the tab origin", async () => {
    const fixture = saveFixture({ id: "save-as-test", kind: "none" });
    mocks.pickPgnFile.mockResolvedValueOnce(targetFile());
    mocks.readFileGame.mockResolvedValueOnce({
        stamp: stampC,
        pgn: "destination game",
        revision: "r2",
        present: true,
    });
    mocks.writeGame.mockRejectedValueOnce(
        Object.assign(new Error("The game changed on disk"), {
            details: {
                category: "validation",
                backendCategory: "stale-game",
                message: "The game changed on disk",
            },
        }),
    );

    const result = await saveToFile({
        tab: fixture.tabs[0],
        updateTab: fixture.updateTab,
        getTab: fixture.getTab,
        store: fixture.store,
        isUserSave: true,
    });

    expect(result).toMatchObject({
        status: "failed",
        error: { backendCategory: "stale-game", message: "The game changed on disk" },
    });
    expect(fixture.tabs[0].gameOrigin).toEqual({ kind: "none" });
    expect(fixture.store.getState()).toMatchObject({ dirty: true, sourceStamp: stampA });
});

test("a file save writes an unmodeled comment command back", () => {
    const tree = defaultTree();
    tree.root.comment = "note";
    tree.root.commands = "[%evp 0,34,61]";
    const store = createTreeStore(undefined, tree);

    expect(serializeStoreTree(store)).toContain("{[%evp 0,34,61] note}");
});
