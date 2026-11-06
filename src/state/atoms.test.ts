import { createStore, type Atom } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import enUSCatalogue from "@/translation/en-US.json";
import { deserializeStorageValue, serializeStorageValue } from "./store/debouncedStorage";
import type { Tab } from "./workspaceTypes";
import { defaultTree } from "@/utils/treeReducer";
import { denyStorageRemoval, refuseStorageReads } from "@/utils/tests/storageMocks";
import "./atoms";

vi.mock("@/platform/native", () => ({ warn: vi.fn() }));
const persistError = vi.hoisted(() => ({ reportPersistError: vi.fn() }));
vi.mock("./persistError", () => persistError);
const sessionNative = vi.hoisted(() => ({
    listLichessAccounts: vi.fn(),
    migrateLegacyLichessToken: vi.fn(),
    revokeLegacyLichessToken: vi.fn(),
}));
vi.mock("@/platform/tauri", () => ({ tauri: sessionNative }));

beforeEach(() => {
    vi.resetModules();
    sessionStorage.clear();
    localStorage.clear();
    persistError.reportPersistError.mockClear();
});

afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    localStorage.clear();
});

async function importAtoms() {
    const workspace = await import("./workspace");
    const load = vi.spyOn(workspace, "loadWorkspace");
    const atoms = await import("./atoms");
    return { atoms, load };
}

test("file deck invalidation evicts every cached ordinal and preserves other files", async () => {
    const { atoms } = await importAtoms();
    const first = atoms.deckAtomFamily({ file: "file-a", game: 0 });
    const later = atoms.deckAtomFamily({ file: "file-a", game: 8 });
    const other = atoms.deckAtomFamily({ file: "file-b", game: 0 });

    atoms.invalidateFileDeckAtoms("file-a");

    expect(atoms.deckAtomFamily({ file: "file-a", game: 0 })).not.toBe(first);
    expect(atoms.deckAtomFamily({ file: "file-a", game: 8 })).not.toBe(later);
    expect(atoms.deckAtomFamily({ file: "file-b", game: 0 })).toBe(other);
    atoms.invalidateFileDeckAtoms("uncached-file");
    expect(atoms.deckAtomFamily({ file: "file-b", game: 0 })).toBe(other);
});

test("the seven eager preferences share declaration-ordered synchronous document initial values", async () => {
    const values = [
        ["download-destination-capability", { id: "download" }],
        ["file-workspace", { id: { id: "workspace" }, kind: "fileWorkspace" }],
        ["show-coordinates-v2", "all"],
        ["sound-collection", "custom"],
        ["sound-volume", 0.25],
        ["lichess-all-options", { color: "black", speeds: ["rapid"], ratings: [1800] }],
        ["lichess-master-options", { moves: 12 }],
    ] as const;
    for (const [key, value] of values) localStorage.setItem(key, JSON.stringify(value));
    const { atoms } = await importAtoms();
    const keys = values.map(([key]) => key);
    const read = vi.spyOn(Storage.prototype, "getItem");
    atoms.initializeRendererState();
    const preferenceReads = read.mock.calls
        .map(([key]) => key)
        .filter((key) => keys.includes(key as (typeof keys)[number]));
    // The first two reads are original owner evidence. Eager hydration follows in declaration order.
    expect(preferenceReads).toEqual([keys[0], keys[1], ...keys]);
    read.mockClear();
    const preferences: Atom<unknown>[] = [
        atoms.downloadDestinationAtom,
        atoms.fileWorkspaceAtom,
        atoms.showCoordinatesAtom,
        atoms.soundCollectionAtom,
        atoms.soundVolumeAtom,
        atoms.lichessOptionsAtom,
        atoms.masterOptionsAtom,
    ];
    const first = createStore();
    expect(preferences.map((preference) => first.get(preference))).toEqual(
        values.map(([, value]) => value),
    );
    localStorage.setItem("sound-collection", JSON.stringify("changed after initialization"));
    localStorage.setItem("sound-volume", "0.9");
    first.set(atoms.soundVolumeAtom, (volume) => volume / 2);
    atoms.initializeRendererState();
    const second = createStore();
    expect(second.get(atoms.soundCollectionAtom)).toBe("custom");
    expect(second.get(atoms.soundVolumeAtom)).toBe(0.25);
    expect(first.get(atoms.soundVolumeAtom)).toBe(0.125);
    expect(read).not.toHaveBeenCalled();
});

test("first eager preference access snapshots every eager initial value before later unrelated reads", async () => {
    localStorage.setItem("sound-volume", "0.3");
    localStorage.setItem(
        "lichess-all-options",
        JSON.stringify({ color: "black", speeds: ["rapid"], ratings: [1800] }),
    );
    const { atoms } = await importAtoms();
    const first = createStore();
    expect(first.get(atoms.soundVolumeAtom)).toBe(0.3);
    localStorage.setItem(
        "lichess-all-options",
        JSON.stringify({ color: "white", speeds: ["blitz"], ratings: [2000] }),
    );
    expect(first.get(atoms.lichessOptionsAtom)).toEqual({
        color: "black",
        speeds: ["rapid"],
        ratings: [1800],
    });
    expect(createStore().get(atoms.lichessOptionsAtom)).toEqual({
        color: "black",
        speeds: ["rapid"],
        ratings: [1800],
    });
});

test.each([
    [null, true],
    ["false", false],
    ["true", true],
    ['"invalid"', true],
    ["{", true],
] as const)("drawing click preference hydrates %s as %s", async (stored, expected) => {
    if (stored !== null) localStorage.setItem("erase-drawables-on-click", stored);
    const { atoms } = await importAtoms();
    const store = createStore();
    const unsubscribe = store.sub(atoms.eraseDrawablesOnClickAtom, () => {});
    try {
        expect(store.get(atoms.eraseDrawablesOnClickAtom)).toBe(expected);
    } finally {
        unsubscribe();
    }
});

function seedWorkspace() {
    const tabs: Tab[] = ["First", "Second"].map((name) => ({
        name,
        value: crypto.randomUUID(),
        type: "new",
        gameOrigin: { kind: "none" },
    }));
    const workspace = { version: 1, tabs, activeTab: tabs[1]!.value };
    const bytes = serializeStorageValue(workspace);
    sessionStorage.setItem("workspace", bytes);
    return { workspace, bytes };
}

test("import leaves workspace hydration for the first synchronous atom read", async () => {
    const { workspace, bytes } = seedWorkspace();
    const { atoms, load } = await importAtoms();

    expect(load).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("workspace")).toBe(bytes);

    const store = createStore();
    expect(store.get(atoms.activeTabAtom)).toBe(workspace.activeTab);
    expect(store.get(atoms.tabsAtom)).toEqual(workspace.tabs);
    expect(load).toHaveBeenCalledExactlyOnceWith(sessionStorage, "workspace");
    expect(atoms.initializeWorkspace()).toEqual(workspace);
    expect(load).toHaveBeenCalledOnce();
});

test("new stores share the original snapshot while later edits and empty state stay local", async () => {
    const { workspace } = seedWorkspace();
    const { atoms, load } = await importAtoms();
    const initial = atoms.initializeWorkspace();
    const first = createStore();
    const second = createStore();
    expect(first.get(atoms.tabsAtom)).toBe(initial.tabs);
    expect(second.get(atoms.tabsAtom)).toBe(initial.tabs);

    expect(
        first.set(atoms.tabsAtom, (tabs) => tabs.map((tab) => ({ ...tab, name: "Edited" }))),
    ).toBe(true);
    expect(first.set(atoms.activeTabAtom, workspace.tabs[0]!.value)).toBe(true);
    expect(second.get(atoms.tabsAtom)).toBe(initial.tabs);
    expect(second.get(atoms.activeTabAtom)).toBe(workspace.activeTab);
    expect(atoms.initializeWorkspace()).toBe(initial);
    expect(first.get(atoms.tabsAtom).every((tab) => tab.name === "Edited")).toBe(true);

    expect(first.set(atoms.tabsAtom, [])).toBe(true);
    expect(first.get(atoms.tabsAtom)).toEqual([]);
    expect(first.get(atoms.activeTabAtom)).toBeNull();
    expect(atoms.initializeWorkspace()).toBe(initial);
    expect(first.get(atoms.tabsAtom)).toEqual([]);
    expect(deserializeStorageValue(sessionStorage.getItem("workspace")!)).toMatchObject({
        tabs: [],
        activeTab: null,
    });
    const third = createStore();
    expect(third.get(atoms.tabsAtom)).toBe(initial.tabs);
    expect(third.get(atoms.activeTabAtom)).toBe(workspace.activeTab);
    expect(load).toHaveBeenCalledOnce();
});

test("the first atom write hydrates and persists selection in the same call", async () => {
    const { workspace } = seedWorkspace();
    const { atoms, load } = await importAtoms();
    const store = createStore();
    const originalSetItem = Storage.prototype.setItem;
    const save = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
            if (this === sessionStorage && key === "workspace") {
                expect(store.get(atoms.activeTabAtom)).toBe(workspace.activeTab);
            }
            return originalSetItem.call(this, key, value);
        });

    expect(store.set(atoms.activeTabAtom, workspace.tabs[0]!.value)).toBe(true);

    expect(store.get(atoms.tabsAtom)).toEqual(workspace.tabs);
    expect(store.get(atoms.activeTabAtom)).toBe(workspace.tabs[0]!.value);
    expect(deserializeStorageValue(sessionStorage.getItem("workspace")!)).toEqual({
        ...workspace,
        activeTab: workspace.tabs[0]!.value,
    });
    expect(load).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
});

test("failed initialization propagates without caching a successful default", async () => {
    const { workspace, bytes } = seedWorkspace();
    const { atoms, load } = await importAtoms();
    const { WorkspaceReadError } = await import("./workspace");
    const failure = new DOMException("workspace read refused", "SecurityError");
    const refusal = refuseStorageReads(["workspace"], failure);

    expect(() => atoms.initializeWorkspace()).toThrow(WorkspaceReadError);
    expect(() => atoms.initializeWorkspace()).toThrow(expect.objectContaining({ cause: failure }));
    expect(() => createStore().set(atoms.tabsAtom, [])).toThrow(
        expect.objectContaining({ cause: failure }),
    );
    expect(persistError.reportPersistError).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(3);
    refusal.mockRestore();
    expect(sessionStorage.getItem("workspace")).toBe(bytes);

    const initial = atoms.initializeWorkspace();
    expect(initial).toEqual(workspace);
    expect(createStore().get(atoms.tabsAtom)).toBe(initial.tabs);
    expect(atoms.initializeWorkspace()).toBe(initial);
    expect(load).toHaveBeenCalledTimes(4);
});

test("a fresh initializer refuses the envelope without changing pending bytes and replays only after a successful read", async () => {
    const { workspace } = seedWorkspace();
    const pending = crypto.randomUUID();
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    const bytes = serializeStorageValue({
        ...workspace,
        treeOwnershipPendingRemovalIds: [pending],
    });
    sessionStorage.setItem("workspace", bytes);
    sessionStorage.setItem(pending, tree);
    const failure = new DOMException("workspace read refused", "SecurityError");
    const refusal = refuseStorageReads(["workspace"], failure);
    vi.resetModules();
    const { atoms, load } = await importAtoms();
    const { WorkspaceReadError } = await import("./workspace");
    const write = vi.spyOn(Storage.prototype, "setItem");
    const remove = vi.spyOn(Storage.prototype, "removeItem");

    expect(() => atoms.initializeWorkspace()).toThrow(WorkspaceReadError);
    expect(() => atoms.initializeWorkspace()).toThrow(expect.objectContaining({ cause: failure }));
    expect(load).toHaveBeenCalledTimes(2);
    expect(write).not.toHaveBeenCalled();
    expect(
        remove.mock.calls.filter((_, index) => remove.mock.contexts[index] === sessionStorage),
    ).toEqual([]);
    expect(persistError.reportPersistError).not.toHaveBeenCalled();
    refusal.mockRestore();
    expect(sessionStorage.getItem("workspace")).toBe(bytes);
    expect(sessionStorage.getItem(pending)).toBe(tree);

    vi.resetModules();
    const fresh = await importAtoms();
    const initial = fresh.atoms.initializeWorkspace();
    expect(initial.treeOwnershipPendingRemovalIds).toEqual([pending]);
    expect(sessionStorage.getItem(pending)).toBeNull();
    expect(deserializeStorageValue(sessionStorage.getItem("workspace")!)).toEqual(initial);
    expect(fresh.atoms.initializeWorkspace()).toBe(initial);
    expect(fresh.load).toHaveBeenCalledOnce();

    vi.resetModules();
    const later = await importAtoms();
    expect(later.atoms.initializeWorkspace()).not.toHaveProperty("treeOwnershipPendingRemovalIds");
    expect(deserializeStorageValue(sessionStorage.getItem("workspace")!)).not.toHaveProperty(
        "treeOwnershipPendingRemovalIds",
    );
});

test("a fresh initializer retains an unreadable pending id, reports once and caches only that completed snapshot", async () => {
    const { workspace } = seedWorkspace();
    const [unreadable, readable] = [crypto.randomUUID(), crypto.randomUUID()];
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    sessionStorage.setItem(unreadable, tree);
    sessionStorage.setItem(readable, tree);
    sessionStorage.setItem(
        "workspace",
        serializeStorageValue({
            ...workspace,
            treeOwnershipPendingRemovalIds: [unreadable, readable],
        }),
    );
    const refusal = refuseStorageReads([unreadable]);
    vi.resetModules();
    const { atoms, load } = await importAtoms();

    const initial = atoms.initializeWorkspace();

    expect(initial.treeOwnershipPendingRemovalIds).toEqual([unreadable, readable]);
    expect(deserializeStorageValue(sessionStorage.getItem("workspace")!)).toEqual(initial);
    expect(refusal.mock.calls.filter(([key]) => key === unreadable)).toHaveLength(1);
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    refusal.mockRestore();
    expect(sessionStorage.getItem(unreadable)).toBe(tree);
    expect(sessionStorage.getItem(readable)).toBeNull();
    expect(atoms.initializeWorkspace()).toBe(initial);
    expect(load).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(unreadable)).toBe(tree);

    vi.resetModules();
    const second = await importAtoms();
    expect(second.atoms.initializeWorkspace().treeOwnershipPendingRemovalIds).toEqual([unreadable]);
    expect(sessionStorage.getItem(unreadable)).toBeNull();
    vi.resetModules();
    const third = await importAtoms();
    expect(third.atoms.initializeWorkspace()).not.toHaveProperty("treeOwnershipPendingRemovalIds");
});

async function prepareCloseWithUnreadablePending(priorCount: number, unreadableCount: number) {
    const { workspace } = seedWorkspace();
    const closed = workspace.tabs[0]!.value;
    const pending = Array.from({ length: priorCount }, () => crypto.randomUUID());
    const pendingIds = new Set<string>(pending);
    const unreadable = pending.slice(0, unreadableCount);
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    for (const id of [...pending, closed]) sessionStorage.setItem(id, tree);
    sessionStorage.setItem(
        "workspace",
        serializeStorageValue({ ...workspace, treeOwnershipPendingRemovalIds: pending }),
    );
    // Preserve prior intents during the initial load, then exercise the later atom commit.
    const deny = denyStorageRemoval((id) => pendingIds.has(id));
    const { atoms } = await importAtoms();
    atoms.initializeWorkspace();
    deny.mockRestore();
    persistError.reportPersistError.mockClear();
    const bytes = sessionStorage.getItem("workspace");
    const refusal = refuseStorageReads(unreadable);
    const store = createStore();
    return { workspace, closed, pending, unreadable, tree, atoms, bytes, refusal, store };
}

test.each([1, 100])(
    "closing succeeds with one unreadable of %s pending targets",
    async (priorCount) => {
        const { workspace, closed, pending, unreadable, tree, atoms, refusal, store } =
            await prepareCloseWithUnreadablePending(priorCount, 1);

        expect(store.set(atoms.closeWorkspaceTabAtom, closed)).toBe(true);

        expect(persistError.reportPersistError).toHaveBeenCalledOnce();
        for (const id of unreadable)
            expect(refusal.mock.calls.filter(([key]) => key === id)).toHaveLength(1);
        refusal.mockRestore();
        for (const id of unreadable) expect(sessionStorage.getItem(id)).toBe(tree);
        expect(deserializeStorageValue(sessionStorage.getItem("workspace")!)).toMatchObject({
            treeOwnershipPendingRemovalIds: [...unreadable, closed],
        });
        expect(sessionStorage.getItem(closed)).toBeNull();
        for (const id of pending.slice(1)) expect(sessionStorage.getItem(id)).toBeNull();
        expect(store.get(atoms.tabsAtom)).toEqual([workspace.tabs[1]]);
    },
);

test("closing keeps the newest 100 intents when all prior targets are unreadable", async () => {
    const { workspace, closed, unreadable, tree, atoms, refusal, store } =
        await prepareCloseWithUnreadablePending(100, 100);
    const remove = vi.spyOn(Storage.prototype, "removeItem");

    expect(store.set(atoms.closeWorkspaceTabAtom, closed)).toBe(true);

    expect(persistError.reportPersistError).toHaveBeenCalledTimes(2);
    for (const id of unreadable)
        expect(refusal.mock.calls.filter(([key]) => key === id)).toHaveLength(1);
    for (const id of unreadable) expect(remove).not.toHaveBeenCalledWith(id);
    refusal.mockRestore();
    for (const id of unreadable) expect(sessionStorage.getItem(id)).toBe(tree);
    expect(deserializeStorageValue(sessionStorage.getItem("workspace")!)).toMatchObject({
        treeOwnershipPendingRemovalIds: [...unreadable.slice(1), closed],
    });
    expect(sessionStorage.getItem(closed)).toBeNull();
    expect(store.get(atoms.tabsAtom)).toEqual([workspace.tabs[1]]);
    const message =
        "ChessRiddle Studio could not finish deleting every closed board. The newest deletions were kept. Quit ChessRiddle Studio to discard the leftover saved games.";
    expect(enUSCatalogue.translation["Common.PendingTreeRemovalOverflow"]).toBe(message);
    expect(persistError.reportPersistError).toHaveBeenLastCalledWith(
        expect.objectContaining({
            message,
            cause: expect.objectContaining({
                message: "Pending tree removals exceeded 100; dropped 1",
            }),
        }),
    );
});

test("original path owners are captured before direct atom access repairs legacy storage", async () => {
    const fileTab: Tab = {
        name: "Legacy file",
        value: "legacy-file",
        type: "analysis",
        gameOrigin: {
            kind: "file",
            gameNumber: 0,
            file: {
                type: "file",
                handle: { id: { id: "original-file-owner" }, kind: "fileWorkspace" },
                name: "game.pgn",
                numGames: 1,
                lastModified: 0,
                metadata: { type: "game", tags: [] },
            },
        },
    };
    const legacyBytes = serializeStorageValue([fileTab]);
    sessionStorage.setItem("tabs", legacyBytes);
    sessionStorage.setItem("activeTab", serializeStorageValue(fileTab.value));
    const { atoms, load } = await importAtoms();
    expect(load).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("tabs")).toBe(legacyBytes);

    const tabs = createStore().get(atoms.tabsAtom);
    const { initializeOriginalPathOwners } = await import("./pathOwners");
    const { pathOwners: originalPathOwnersSnapshot } = initializeOriginalPathOwners();

    expect(tabs[0]!.value).not.toBe(fileTab.value);
    expect(tabs[0]!.gameOrigin).toEqual(fileTab.gameOrigin);
    expect(sessionStorage.getItem("tabs")).toBeNull();
    expect(originalPathOwnersSnapshot.retainedIds).toContainEqual({ id: "original-file-owner" });
    expect(load).toHaveBeenCalledOnce();
});

test("real bootstrap retains the latest safe sessions through atom mount, remount and save recovery", async () => {
    const token = "private-bootstrap-token-sentinel";
    const publicSessions = [
        {
            player: "Lichess alias",
            updatedAt: 123,
            lichess: {
                username: "Player",
                handle: "old-handle",
                account: {
                    id: "player",
                    username: "Player",
                    perfs: { blitz: { rating: 1800, games: 8, rd: 40, prog: 0, prov: false } },
                },
            },
        },
        { player: "Chess.com alias", updatedAt: 456, chessCom: { username: "Other", stats: {} } },
    ] as const;
    localStorage.setItem(
        "sessions",
        JSON.stringify([
            { ...publicSessions[0], lichess: { ...publicSessions[0].lichess, accessToken: token } },
            publicSessions[1],
        ]),
    );
    const write = Storage.prototype.setItem;
    const refusal = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
            if (key === "sessions") throw new DOMException(token, "QuotaExceededError");
            return write.call(this, key, value);
        });
    const diagnostics = vi.spyOn(console, "warn");
    sessionNative.migrateLegacyLichessToken.mockResolvedValue({
        account: { username: "Player", handle: "migrated-handle" },
    });
    sessionNative.listLichessAccounts.mockResolvedValue([
        { username: "PLAYER", handle: "current-handle" },
    ]);
    const { atoms } = await importAtoms();
    const session = await import("../utils/session");
    const startup = await session.initializePersistedSessions();
    const expected = [
        {
            ...publicSessions[0],
            lichess: { ...publicSessions[0].lichess, handle: "current-handle" },
        },
        publicSessions[1],
    ];
    expect(startup).toEqual({ status: "unsaved", sessions: expected });
    expect(localStorage.getItem("sessions")).toBeNull();
    const store = createStore();
    expect(store.get(atoms.sessionsAtom)).toEqual(expected);
    const secondStore = createStore();
    expect(secondStore.get(atoms.sessionsAtom)).toEqual(expected);
    const listener = vi.fn();
    let unmount = store.sub(atoms.sessionsAtom, listener);
    expect(store.get(atoms.sessionsAtom)).toEqual(expected);
    unmount();
    // A stale public key must not replace the document's admitted list on remount.
    write.call(localStorage, "sessions", JSON.stringify([publicSessions[1]]));
    unmount = store.sub(atoms.sessionsAtom, listener);
    expect(store.get(atoms.sessionsAtom)).toEqual(expected);
    store.set(atoms.sessionsAtom, (sessions) =>
        sessions.map((s, index) => (index === 0 ? { ...s, player: "New alias" } : s)),
    );
    store.set(atoms.sessionsAtom, (sessions) => sessions.filter((s) => !s.chessCom));
    const latest = [{ ...expected[0], player: "New alias" }];
    expect(session.retrySessionPersistence()).toEqual({ status: "unsaved", sessions: latest });
    expect(store.get(atoms.sessionsAtom)).toEqual(latest);
    const nativeCalls = sessionNative.listLichessAccounts.mock.calls.length;
    unmount();
    secondStore.set(atoms.sessionsAtom, (sessions) =>
        sessions.map((s) => ({ ...s, player: "Edited while unmounted" })),
    );
    unmount = store.sub(atoms.sessionsAtom, listener);
    expect(store.get(atoms.sessionsAtom)[0]?.player).toBe("Edited while unmounted");
    expect(store.get(atoms.sessionsAtom)).toHaveLength(1);
    refusal.mockRestore();
    const recovered = session.retrySessionPersistence();
    expect(recovered.status).toBe("saved");
    expect(deserializeStorageValue(localStorage.getItem("sessions")!)).toEqual(recovered.sessions);
    expect(sessionNative.listLichessAccounts).toHaveBeenCalledTimes(nativeCalls);
    expect(sessionNative.migrateLegacyLichessToken).toHaveBeenCalledExactlyOnceWith(
        "Player",
        token,
    );
    expect(sessionNative.revokeLegacyLichessToken).not.toHaveBeenCalled();
    for (const value of [
        startup,
        recovered,
        session.getSessionPersistenceSnapshot(),
        diagnostics.mock.calls,
    ]) {
        expect(JSON.stringify(value)).not.toContain(token);
    }
    expect(localStorage.getItem("sessions")).not.toContain(token);
    unmount();
    listener.mockClear();
    session.retrySessionPersistence();
    expect(listener).not.toHaveBeenCalled();
    // Re-executing real bootstrap reads the canonical encoding via the production decoder.
    expect(await session.initializePersistedSessions()).toEqual(recovered);
    const reloadedStore = createStore();
    const unmountReload = reloadedStore.sub(atoms.sessionsAtom, () => {});
    expect(reloadedStore.get(atoms.sessionsAtom)).toEqual(recovered.sessions);
    unmountReload();
});

/** Fresh module, subscribe first, then read: the storage adapter hydrates on subscription. */
async function mountBoardPreference<Value>(
    pick: (module: typeof import("./atoms")) => Atom<Value>,
) {
    const { atoms } = await importAtoms();
    const write = vi.spyOn(Storage.prototype, "setItem");
    const store = createStore();
    const unsubscribe = store.sub(pick(atoms), () => {});
    return { atoms, store, write, unsubscribe };
}

test.each([null, "gray.svg"])(
    "board preference keeps stored %s or uses ChessRiddle maple",
    async (stored) => {
        const { createPreferenceStorage } = await import("./utils");
        if (stored !== null)
            createPreferenceStorage("chessriddle.svg").setItem("board-image", stored);
        const encoded = localStorage.getItem("board-image");
        const { atoms, store, write, unsubscribe } = await mountBoardPreference(
            (module) => module.boardImageAtom,
        );
        try {
            expect(store.get(atoms.boardImageAtom)).toBe(stored ?? "chessriddle.svg");
            expect(localStorage.getItem("board-image")).toBe(encoded);
            expect(write.mock.calls.filter(([key]) => key === "board-image")).toEqual([]);
            expect(store.get(atoms.pieceSetAtom)).toBe("staunty");
        } finally {
            unsubscribe();
        }
    },
);

test.each([
    ["absent", null, true],
    ["stored JSON false", "false", false],
    ["stored JSON true", "true", true],
] as const)(
    "wood texture preference with %s row reads without writing",
    async (_name, raw, expected) => {
        if (raw !== null) localStorage.setItem("board-wood-texture", raw);
        const { atoms, store, write, unsubscribe } = await mountBoardPreference(
            (module) => module.boardWoodTextureAtom,
        );
        try {
            expect(store.get(atoms.boardWoodTextureAtom)).toBe(expected);
            expect(localStorage.getItem("board-wood-texture")).toBe(raw);
            expect(write.mock.calls.filter(([key]) => key === "board-wood-texture")).toEqual([]);
        } finally {
            unsubscribe();
        }
    },
);

test.each([
    ["non-JSON bytes", "not json{"],
    ["JSON string false", JSON.stringify("false")],
    ["JSON number 1", "1"],
])("wood texture preference repairs a corrupt row (%s) to true", async (_name, raw) => {
    localStorage.setItem("board-wood-texture", raw);
    const { atoms, store, write, unsubscribe } = await mountBoardPreference(
        (module) => module.boardWoodTextureAtom,
    );
    try {
        expect(store.get(atoms.boardWoodTextureAtom)).toBe(true);
        expect(localStorage.getItem("board-wood-texture")).toBe("true");
        expect(write).toHaveBeenCalledWith("board-wood-texture", "true");
    } finally {
        unsubscribe();
    }
});
