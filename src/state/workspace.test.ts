import { afterEach, expect, test, vi } from "vitest";
import i18n from "@/i18n";
import enUSCatalogue from "@/translation/en-US.json";
import { errorUnlessCancelled } from "@/platform/errors";
import { denyStorageRemoval, refuseStorageReads } from "@/utils/tests/storageMocks";
import { defaultTree } from "@/utils/treeReducer";
import { getTabTreeKey, type Tab } from "./workspaceTypes";
import { deserializeStorageValue, serializeStorageValue } from "./store/debouncedStorage";
import { tabStorage } from "./store/tabStorage";
import { createTreeStore } from "./store/tree";
import type { Puzzle } from "./puzzleSession";
import {
    defaultWorkspace,
    LEGACY_WORKSPACE_VERSION,
    loadWorkspace,
    readStoredWorkspaceValue,
    saveWorkspace,
    sweepOrphanedTreeKeys,
    sweepLegacyPuzzleKeys,
    MAX_PROTECTED_TREE_KEYS,
    MAX_PROTECTED_TREE_KEY_LENGTH,
    MAX_PENDING_TREE_REMOVALS,
    MAX_WORKSPACE_TABS,
    WORKSPACE_STORAGE_KEY,
    pendingTreeRemovalCapacityError,
    pendingPuzzleRemovalCapacityError,
    reconcileLegacyPuzzleRemovals,
    reconcilePendingTreeRemovals,
    WorkspaceReadError,
} from "./workspace";

const native = vi.hoisted(() => ({ warn: vi.fn().mockResolvedValue(undefined) }));
const persistError = vi.hoisted(() => ({ reportPersistError: vi.fn() }));
vi.mock("@/platform/native", () => native);
vi.mock("./persistError", () => persistError);

const treeOverflowMessage =
    "ChessRiddle Studio could not finish deleting every closed board. The newest deletions were kept. Quit ChessRiddle Studio to discard the leftover saved games.";
const puzzleOverflowMessage =
    "ChessRiddle Studio could not finish deleting every old puzzle session. The newest deletions were kept. Quit ChessRiddle Studio to discard the leftover puzzle sessions.";

const legacyTab = {
    name: "Legacy",
    value: "42",
    type: "analysis",
    gameOrigin: { kind: "none" },
} as const;

function loadStoredWorkspace() {
    return loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY);
}

function expectLegacyContentRefusal(key: "tabs" | "activeTab") {
    sessionStorage.clear();
    const tabs = serializeStorageValue([legacyTab]);
    const active = serializeStorageValue(legacyTab.value);
    sessionStorage.setItem("tabs", tabs);
    sessionStorage.setItem("activeTab", active);
    const failure = new DOMException("legacy content refused", "SecurityError");
    const refusal = refuseStorageReads([key], failure);
    const write = vi.spyOn(Storage.prototype, "setItem");
    const remove = vi.spyOn(Storage.prototype, "removeItem");

    expect(loadStoredWorkspace).toThrow(WorkspaceReadError);
    expect(loadStoredWorkspace).toThrow(
        expect.objectContaining({
            name: "WorkspaceReadError",
            message: "Could not read the saved workspace",
            cause: failure,
        }),
    );
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(persistError.reportPersistError).not.toHaveBeenCalled();
    refusal.mockRestore();
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem("tabs")).toBe(tabs);
    expect(sessionStorage.getItem("activeTab")).toBe(active);
}

test("a refused legacy tabs content read leaves activeTab and every byte untouched", () => {
    expectLegacyContentRefusal("tabs");
});

test("a refused legacy activeTab content read leaves tabs and every byte untouched", () => {
    expectLegacyContentRefusal("activeTab");
});

test.each(["tabs", "activeTab"])(
    "a refused legacy %s presence read keeps both keys beside an authoritative workspace",
    (key) => {
        sessionStorage.clear();
        const workspace = defaultWorkspace();
        sessionStorage.setItem(WORKSPACE_STORAGE_KEY, serializeStorageValue(workspace));
        // With tabs absent, the activeTab presence check is reached independently.
        const legacyKey = key === "tabs" ? "tabs" : "activeTab";
        sessionStorage.setItem(legacyKey, "legacy bytes");
        const refusal = refuseStorageReads([key]);
        const write = vi.spyOn(Storage.prototype, "setItem");
        const remove = vi.spyOn(Storage.prototype, "removeItem");

        expect(loadStoredWorkspace()).toEqual(workspace);
        expect(write).not.toHaveBeenCalled();
        expect(remove.mock.calls.flat()).not.toContain("tabs");
        expect(remove.mock.calls.flat()).not.toContain("activeTab");
        expect(remove).not.toHaveBeenCalledWith("Stryker was here");
        expect(persistError.reportPersistError).toHaveBeenCalledOnce();
        refusal.mockRestore();
        expect(sessionStorage.getItem(legacyKey)).toBe("legacy bytes");
    },
);

test("one unreadable pending id is reported once, retained and excluded while other pending trees and orphans are reclaimed", () => {
    sessionStorage.clear();
    const workspace = defaultWorkspace();
    const [unreadable, readable, orphan] = Array.from({ length: 3 }, () => crypto.randomUUID());
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    for (const id of [unreadable, readable, orphan]) sessionStorage.setItem(id, tree);
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({
            ...workspace,
            treeOwnershipPendingRemovalIds: [unreadable, readable],
        }),
    );
    const refusal = refuseStorageReads([unreadable]);

    const loaded = loadStoredWorkspace();

    expect(loaded.treeOwnershipPendingRemovalIds).toEqual([unreadable, readable]);
    expect(readStoredWorkspaceValue(sessionStorage, WORKSPACE_STORAGE_KEY)).toEqual(loaded);
    expect(refusal.mock.calls.filter(([key]) => key === unreadable)).toHaveLength(1);
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    refusal.mockRestore();
    expect(sessionStorage.getItem(unreadable)).toBe(tree);
    expect(sessionStorage.getItem(readable)).toBeNull();
    expect(sessionStorage.getItem(orphan)).toBeNull();

    expect(loadStoredWorkspace().treeOwnershipPendingRemovalIds).toEqual([unreadable]);
    expect(sessionStorage.getItem(unreadable)).toBeNull();
    expect(readStoredWorkspaceValue(sessionStorage, WORKSPACE_STORAGE_KEY)).toMatchObject({
        treeOwnershipPendingRemovalIds: [unreadable],
    });
    expect(loadStoredWorkspace()).not.toHaveProperty("treeOwnershipPendingRemovalIds");
    expect(readStoredWorkspaceValue(sessionStorage, WORKSPACE_STORAGE_KEY)).not.toHaveProperty(
        "treeOwnershipPendingRemovalIds",
    );
});

test("a fresh ownership snapshot excludes pending ids before their single refused read", () => {
    sessionStorage.clear();
    const workspace = defaultWorkspace();
    const unreadable = crypto.randomUUID();
    const other = crypto.randomUUID();
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    sessionStorage.setItem(unreadable, tree);
    sessionStorage.setItem(other, tree);
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({
            ...workspace,
            treeOwnershipUncertain: true,
            treeOwnershipPendingRemovalIds: [unreadable],
        }),
    );
    const refusal = refuseStorageReads([unreadable]);

    const loaded = loadStoredWorkspace();

    expect(loaded.treeOwnershipProtectedIds).toEqual([other]);
    expect(loaded.treeOwnershipPendingRemovalIds).toEqual([unreadable]);
    expect(refusal.mock.calls.filter(([key]) => key === unreadable)).toHaveLength(1);
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    refusal.mockRestore();
    expect(sessionStorage.getItem(unreadable)).toBe(tree);
    expect(sessionStorage.getItem(other)).toBe(tree);
});

function puzzleRepairFixture() {
    sessionStorage.clear();
    const physical = crypto.randomUUID();
    const logical = "old-puzzle-logical-owner";
    const owner: Tab = { ...legacyTab, value: logical, treeKey: physical, type: "puzzles" };
    const unrelated: Tab = { ...legacyTab, value: crypto.randomUUID() };
    const memory = createTreeStore();
    memory.getState().makeMove({ payload: "e4" });
    memory.getState().setComment("saved played tree");
    const base: Puzzle = {
        id: 7,
        fen: defaultTree().root.fen,
        moves: ["e2e4", "e7e5"],
        rating: 1200,
        rating_deviation: 50,
        popularity: 1,
        nb_plays: 1,
        completion: "incomplete",
    };
    tabStorage.seed(physical, memory.getState());
    tabStorage.seed(unrelated.value, defaultTree());
    sessionStorage.setItem(
        `${logical}-puzzles`,
        JSON.stringify([{ ...base, moves: ["g1f3", "d7d5"] }, null, base]),
    );
    sessionStorage.setItem("foreign-puzzles", "foreign value");
    const envelope = { version: 1, tabs: [owner, unrelated], activeTab: unrelated.value };
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, serializeStorageValue(envelope));
    return { physical, logical, owner, unrelated, envelope, historyKey: `${logical}-puzzles` };
}

test("PR-1 cold document replays logical history cleanup after different physical source retirement", async () => {
    const fixture = puzzleRepairFixture();
    const deny = denyStorageRemoval(fixture.historyKey);
    const loaded = loadStoredWorkspace();
    const repaired = loaded.tabs[0]!;
    expect(repaired.value).not.toBe(fixture.logical);
    expect(loaded.activeTab).toBe(fixture.unrelated.value);
    const tree = tabStorage.read<ReturnType<typeof defaultTree>>(getTabTreeKey(repaired))!.state;
    expect(tree.root.children[0].comment).toBe("saved played tree");
    expect(tree.position).toEqual([0]);
    expect(tree.puzzleSession!.attempts).toHaveLength(2);
    expect(tree.puzzleSession!.selectedAttemptId).toBe(tree.puzzleSession!.attempts[1].attemptId);
    expect(loaded.legacyPuzzleRemovalKeys).toEqual([fixture.historyKey]);
    expect(sessionStorage.getItem(fixture.physical)).toBeNull();
    expect(sessionStorage.getItem(fixture.historyKey)).not.toBeNull();
    deny.mockRestore();
    vi.resetModules();
    const cold = await import("./workspace");
    const restored = cold.loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY);
    expect(restored.tabs).toEqual(loaded.tabs);
    expect(sessionStorage.getItem(fixture.historyKey)).toBeNull();
    expect(restored.legacyPuzzleRemovalKeys).toBeUndefined();
    expect(sessionStorage.getItem("foreign-puzzles")).toBe("foreign value");
    expect(sessionStorage.getItem(fixture.unrelated.value)).not.toBeNull();
});

test("puzzle ID repair save refusal preserves original logical and physical owners", () => {
    const fixture = puzzleRepairFixture();
    const write = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
        if (key === WORKSPACE_STORAGE_KEY)
            throw new DOMException("refused intent", "QuotaExceededError");
        write.call(this, key, value);
    });
    const bytes = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
    const loaded = loadStoredWorkspace();
    expect(loaded.tabs).toEqual(fixture.envelope.tabs);
    expect(loaded.legacyPuzzleRemovalKeys).toBeUndefined();
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(bytes);
    expect(sessionStorage.getItem(fixture.historyKey)).not.toBeNull();
    expect(sessionStorage.getItem(fixture.physical)).not.toBeNull();
    expect(persistError.reportPersistError).toHaveBeenCalled();
});

function preparePuzzleRepairOverflow(failPublish: boolean) {
    const fixture = puzzleRepairFixture();
    const prior = Array.from({ length: 100 }, (_, i) => `retired-${i}-puzzles`);
    for (const key of prior) sessionStorage.setItem(key, "[]");
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({ ...fixture.envelope, legacyPuzzleRemovalKeys: prior }),
    );
    denyStorageRemoval((key) => [...prior, fixture.historyKey].includes(key));
    const bytes = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (failPublish) {
        const write = Storage.prototype.setItem;
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(
            function (this: Storage, key, value) {
                if (key === WORKSPACE_STORAGE_KEY)
                    throw new DOMException("quota", "QuotaExceededError");
                write.call(this, key, value);
            },
        );
    }
    const message = puzzleOverflowMessage;
    const expectedKeys = [...prior.slice(1), fixture.historyKey];
    const reportedWorkspaceBytes: Array<string | null> = [];
    persistError.reportPersistError.mockImplementation((error: Error) => {
        if (error.message === message)
            reportedWorkspaceBytes.push(sessionStorage.getItem(WORKSPACE_STORAGE_KEY));
    });
    return { fixture, prior, bytes, message, expectedKeys, reportedWorkspaceBytes };
}

test("puzzle ID repair publishes bounded cleanup before reporting overflow", () => {
    const { fixture, prior, message, expectedKeys, reportedWorkspaceBytes } =
        preparePuzzleRepairOverflow(false);
    const loaded = loadStoredWorkspace();
    const errors = persistError.reportPersistError.mock.calls
        .map(([error]) => error)
        .filter((error) => error.message === message);

    expect(loaded.tabs[0]!.value).not.toBe(fixture.logical);
    expect(loaded.legacyPuzzleRemovalKeys).toEqual(expectedKeys);
    expect(readStoredWorkspaceValue(sessionStorage, WORKSPACE_STORAGE_KEY)).toEqual(loaded);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe(puzzleOverflowMessage);
    expect(enUSCatalogue.translation["Common.PendingPuzzleRemovalOverflow"]).toBe(
        puzzleOverflowMessage,
    );
    expect(errorUnlessCancelled(errors[0])).toEqual({ category: "unexpected", message });
    expect(errors[0].cause.message).toBe("Pending legacy puzzle removals exceeded 100; dropped 1");
    expect(reportedWorkspaceBytes).toEqual([sessionStorage.getItem(WORKSPACE_STORAGE_KEY)]);
    expect(deserializeStorageValue(reportedWorkspaceBytes[0]!)).toMatchObject({
        legacyPuzzleRemovalKeys: expectedKeys,
    });
    expect(sessionStorage.getItem(prior[0]!)).toBe("[]");
    persistError.reportPersistError.mockReset();
});

test("puzzle ID repair preserves owners and reports no overflow when publication fails", () => {
    const { fixture, prior, bytes, message, reportedWorkspaceBytes } =
        preparePuzzleRepairOverflow(true);
    const loaded = loadStoredWorkspace();
    const errors = persistError.reportPersistError.mock.calls
        .map(([error]) => error)
        .filter((error) => error.message === message);

    expect(loaded.tabs).toEqual(fixture.envelope.tabs);
    expect(loaded.legacyPuzzleRemovalKeys).toEqual(prior);
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(bytes);
    expect(errors).toEqual([]);
    expect(enUSCatalogue.translation["Common.PendingPuzzleRemovalOverflow"]).toBe(
        puzzleOverflowMessage,
    );
    expect(reportedWorkspaceBytes).toEqual([]);
    expect(sessionStorage.getItem(prior[0]!)).toBe("[]");
    persistError.reportPersistError.mockReset();
});

test("legacy cleanup replays absent targets independently of source trees and retains refused reads", () => {
    sessionStorage.clear();
    const workspace = defaultWorkspace();
    const key = "absent-logical-source-puzzles";
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({ ...workspace, legacyPuzzleRemovalKeys: [key] }),
    );
    const read = Storage.prototype.getItem;
    const refusal = vi
        .spyOn(Storage.prototype, "getItem")
        .mockImplementation(function (this: Storage, name) {
            if (name === key) throw new Error("refused exact history read");
            return read.call(this, name);
        });
    expect(loadStoredWorkspace().legacyPuzzleRemovalKeys).toEqual([key]);
    refusal.mockRestore();
    expect(loadStoredWorkspace().legacyPuzzleRemovalKeys).toBeUndefined();
    expect(
        (readStoredWorkspace() as { legacyPuzzleRemovalKeys?: string[] }).legacyPuzzleRemovalKeys,
    ).toBeUndefined();
});

test.each(["read", "tree-save"] as const)(
    "background puzzle repair %s refusal preserves both source owners",
    (failure) => {
        const fixture = puzzleRepairFixture();
        const bytes = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
        if (failure === "read") {
            const read = Storage.prototype.getItem;
            vi.spyOn(Storage.prototype, "getItem").mockImplementation(
                function (this: Storage, key) {
                    if (key === fixture.historyKey) throw new Error("history read refused");
                    return read.call(this, key);
                },
            );
        } else {
            const write = Storage.prototype.setItem;
            vi.spyOn(Storage.prototype, "setItem").mockImplementation(
                function (this: Storage, key, value) {
                    if (
                        ![
                            fixture.physical,
                            fixture.unrelated.value,
                            WORKSPACE_STORAGE_KEY,
                        ].includes(key)
                    )
                        throw new DOMException("combined migration refused", "QuotaExceededError");
                    write.call(this, key, value);
                },
            );
        }
        expect(loadStoredWorkspace().tabs).toEqual(fixture.envelope.tabs);
        expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(bytes);
        expect(sessionStorage.getItem(fixture.physical)).not.toBeNull();
        expect(persistError.reportPersistError).toHaveBeenCalled();
        vi.restoreAllMocks();
        expect(sessionStorage.getItem(fixture.historyKey)).not.toBeNull();
        const loaded = loadStoredWorkspace();
        expect(loaded.tabs[0].value).not.toBe(fixture.logical);
        expect(
            tabStorage.read<ReturnType<typeof defaultTree>>(getTabTreeKey(loaded.tabs[0]))!.state
                .puzzleSession!.attempts,
        ).toHaveLength(2);
    },
);

test.each([false, true])(
    "UUID legacy history sweeping requires authoritative workspace ownership (uncertain: %s)",
    (uncertain) => {
        sessionStorage.clear();
        const workspace = defaultWorkspace();
        const retainedKey = `${workspace.tabs[0].value}-puzzles`;
        const orphanKey = `${crypto.randomUUID()}-puzzles`;
        sessionStorage.setItem(retainedKey, "retained");
        sessionStorage.setItem(orphanKey, "orphan");
        sessionStorage.setItem("unrelated-puzzles", "foreign");
        sessionStorage.setItem(
            WORKSPACE_STORAGE_KEY,
            serializeStorageValue({
                ...workspace,
                ...(uncertain
                    ? { treeOwnershipUncertain: true, treeOwnershipProtectedIds: [] }
                    : {}),
            }),
        );
        const loaded = loadStoredWorkspace();
        expect(sessionStorage.getItem(orphanKey)).toBe(uncertain ? "orphan" : null);
        sweepLegacyPuzzleKeys(loaded);
        expect(sessionStorage.getItem(orphanKey)).toBe(uncertain ? "orphan" : null);
        expect(sessionStorage.getItem(retainedKey)).toBe("retained");
        expect(sessionStorage.getItem("unrelated-puzzles")).toBe("foreign");
    },
);

test("saved cleanup intents reject duplicate and non-history keys and survive canonical workspace publication", () => {
    sessionStorage.clear();
    const workspace = defaultWorkspace();
    const historyKey = "retired-owner-puzzles";
    const saved = saveWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY, {
        ...workspace,
        legacyPuzzleRemovalKeys: [historyKey],
    });
    expect(saved?.legacyPuzzleRemovalKeys).toEqual([historyKey]);
    expect((readStoredWorkspace() as typeof saved)?.legacyPuzzleRemovalKeys).toEqual([historyKey]);
    const bytes = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
    for (const keys of [
        [historyKey, historyKey],
        ["unrelated-storage"],
        [`${"x".repeat(249)}-puzzles`],
    ]) {
        expect(
            saveWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY, {
                ...workspace,
                legacyPuzzleRemovalKeys: keys,
            }),
        ).toBeNull();
        expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(bytes);
    }
});

test("cleanup reconciliation protects retained logical owners and admits exactly 100 proven keys including UUIDs", () => {
    sessionStorage.clear();
    const retained = { ...legacyTab, value: "still-live" };
    const retainedKey = `${retained.value}-puzzles`;
    const uuid = crypto.randomUUID();
    sessionStorage.setItem(retainedKey, "live history");
    expect(
        reconcileLegacyPuzzleRemovals([retainedKey], [retained.value, uuid, "retired"], [retained]),
    ).toEqual({ keys: [`${uuid}-puzzles`, "retired-puzzles"], droppedKeys: [] });
    expect(sessionStorage.getItem(retainedKey)).toBe("live history");
    const retired = Array.from({ length: 100 }, (_, i) => `old-${i}`);
    expect(reconcileLegacyPuzzleRemovals([], retired, [])).toEqual({
        keys: retired.map((id) => `${id}-puzzles`),
        droppedKeys: [],
    });
    expect(reconcileLegacyPuzzleRemovals([], [...retired, "overflow"], [])).toEqual({
        keys: [...retired.slice(1), "overflow"].map((id) => `${id}-puzzles`),
        droppedKeys: ["old-0-puzzles"],
    });
});

test("uncertain persisted workspace replays exact UUID intents without a tree and protects retained and unknown histories", async () => {
    sessionStorage.clear();
    const retained = { ...legacyTab, value: crypto.randomUUID(), type: "puzzles" as const };
    const retired = crypto.randomUUID();
    const retiredKey = `${retired}-puzzles`;
    const retainedKey = `${retained.value}-puzzles`;
    const unknownKey = `${crypto.randomUUID()}-puzzles`;
    for (const key of [retiredKey, retainedKey, unknownKey, "foreign-puzzles"])
        sessionStorage.setItem(key, "preserved until authorized");
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({
            version: 1,
            tabs: [retained],
            activeTab: retained.value,
            treeOwnershipUncertain: true,
            treeOwnershipProtectedIds: [],
            legacyPuzzleRemovalKeys: [retiredKey, retainedKey],
        }),
    );
    const deny = denyStorageRemoval(retiredKey);
    expect(loadStoredWorkspace().legacyPuzzleRemovalKeys).toEqual([retiredKey]);
    expect(sessionStorage.getItem(retired)).toBeNull();
    expect(sessionStorage.getItem(retainedKey)).toBe("preserved until authorized");
    deny.mockRestore();
    vi.resetModules();
    const cold = await import("./workspace");
    const restored = cold.loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY);
    expect(restored.treeOwnershipUncertain).toBe(true);
    expect(restored.legacyPuzzleRemovalKeys).toBeUndefined();
    expect(sessionStorage.getItem(retiredKey)).toBeNull();
    for (const key of [retainedKey, unknownKey, "foreign-puzzles"])
        expect(sessionStorage.getItem(key)).toBe("preserved until authorized");
    expect(readStoredWorkspace()).not.toHaveProperty("legacyPuzzleRemovalKeys");
});

test("legacy cleanup capacity errors keep localized action text and the concrete refusal cause", () => {
    const translate = vi.spyOn(i18n, "t");
    const error = pendingPuzzleRemovalCapacityError(2);
    expect(translate).toHaveBeenCalledExactlyOnceWith("Common.PendingPuzzleRemovalOverflow");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(puzzleOverflowMessage);
    expect(enUSCatalogue.translation["Common.PendingPuzzleRemovalOverflow"]).toBe(
        puzzleOverflowMessage,
    );
    expect(error.cause).toEqual(
        new Error("Pending legacy puzzle removals exceeded 100; dropped 2"),
    );
});

test("history sweeping reports refused enumeration and retries without deleting unrelated UUID-prefixed values", () => {
    sessionStorage.clear();
    const workspace = defaultWorkspace();
    const orphanKey = `${crypto.randomUUID()}-puzzles`;
    const unrelated = `${crypto.randomUUID()}-foreign`;
    sessionStorage.setItem(orphanKey, "orphan");
    sessionStorage.setItem(unrelated, "foreign");
    const failure = new Error("session keys unavailable");
    const refuse = vi.spyOn(Storage.prototype, "key").mockImplementation(() => {
        throw failure;
    });
    sweepLegacyPuzzleKeys(workspace);
    expect(persistError.reportPersistError).toHaveBeenCalledWith(failure);
    expect(sessionStorage.getItem(orphanKey)).toBe("orphan");
    refuse.mockRestore();
    sweepLegacyPuzzleKeys(workspace);
    expect(sessionStorage.getItem(orphanKey)).toBeNull();
    expect(sessionStorage.getItem(unrelated)).toBe("foreign");
});

test("history sweeping skips absent enumerated entries and still reclaims later orphan keys", () => {
    sessionStorage.clear();
    const workspace = defaultWorkspace();
    sessionStorage.setItem("unrelated", "foreign");
    const orphanKey = `${crypto.randomUUID()}-puzzles`;
    sessionStorage.setItem(orphanKey, "orphan");
    const original = Storage.prototype.key;
    vi.spyOn(Storage.prototype, "key").mockImplementation(function (this: Storage, index) {
        return index === 0 ? null : original.call(this, index);
    });
    sweepLegacyPuzzleKeys(workspace);
    expect(sessionStorage.getItem(orphanKey)).toBeNull();
    expect(sessionStorage.getItem("unrelated")).toBe("foreign");
    expect(persistError.reportPersistError).not.toHaveBeenCalled();
});

test.each(["missing", "legacy"] as const)(
    "startup history sweeping requires %s metadata to provide actual ownership authority",
    (source) => {
        sessionStorage.clear();
        const orphanKey = `${crypto.randomUUID()}-puzzles`;
        sessionStorage.setItem(orphanKey, "orphan");
        if (source === "legacy") {
            const owner = { ...legacyTab, value: crypto.randomUUID() };
            sessionStorage.setItem("tabs", serializeStorageValue([owner]));
            sessionStorage.setItem("activeTab", serializeStorageValue(owner.value));
        }
        loadStoredWorkspace();
        expect(sessionStorage.getItem(orphanKey)).toBe(source === "legacy" ? null : "orphan");
    },
);

test("analysis ID repair preserves unrelated logical history and does not invent a puzzle session", () => {
    const fixture = puzzleRepairFixture();
    const owner = { ...fixture.owner, type: "analysis" as const };
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({ ...fixture.envelope, tabs: [owner, fixture.unrelated] }),
    );
    const raw = sessionStorage.getItem(fixture.historyKey);
    const loaded = loadStoredWorkspace();
    const repaired = loaded.tabs[0];
    expect(repaired.value).not.toBe(owner.value);
    expect(
        tabStorage.read<ReturnType<typeof defaultTree>>(getTabTreeKey(repaired))!.state
            .puzzleSession,
    ).toBeUndefined();
    expect(sessionStorage.getItem(fixture.historyKey)).toBe(raw);
    expect(loaded.legacyPuzzleRemovalKeys).toBeUndefined();
});

test("unreadable puzzle repair retains both original owners and reports the ownership failure", () => {
    const fixture = puzzleRepairFixture();
    const raw = "unreadable played puzzle bytes";
    sessionStorage.setItem(fixture.physical, raw);
    const bytes = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
    expect(loadStoredWorkspace().tabs).toEqual(fixture.envelope.tabs);
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(bytes);
    expect(sessionStorage.getItem(fixture.physical)).toBe(raw);
    expect(sessionStorage.getItem(fixture.historyKey)).not.toBeNull();
    expect(persistError.reportPersistError).toHaveBeenCalledWith(
        new Error("Cannot migrate puzzle ownership from an unreadable tree"),
    );
});

test("a copied puzzle target unavailable before combined migration refuses publication with its cause", () => {
    const fixture = puzzleRepairFixture();
    const read = tabStorage.readTree.bind(tabStorage);
    vi.spyOn(tabStorage, "readTree").mockImplementation((id, required) =>
        id !== fixture.physical && id !== fixture.unrelated.value
            ? { kind: "absent" }
            : read(id, required),
    );
    const bytes = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
    expect(loadStoredWorkspace().tabs).toEqual(fixture.envelope.tabs);
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(bytes);
    expect(sessionStorage.getItem(fixture.physical)).not.toBeNull();
    expect(sessionStorage.getItem(fixture.historyKey)).not.toBeNull();
    expect(persistError.reportPersistError).toHaveBeenCalledWith(
        new Error("Puzzle migration target is unavailable"),
    );
});

test.each(["saved", "refused-write", "refused-verification"] as const)(
    "an absent implicit puzzle source transfers logical history only after %s admission",
    (outcome) => {
        sessionStorage.clear();
        const owner: Tab = { ...legacyTab, type: "puzzles", value: "empty-legacy-puzzle" };
        const puzzle: Puzzle = {
            id: 1,
            fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1",
            moves: ["e7e5", "g1f3"],
            rating: 1200,
            rating_deviation: 50,
            popularity: 1,
            nb_plays: 1,
            completion: "incomplete",
        };
        const historyKey = `${owner.value}-puzzles`;
        const historyBytes = JSON.stringify([puzzle]);
        sessionStorage.setItem(historyKey, historyBytes);
        const envelope = { version: 1, tabs: [owner], activeTab: owner.value };
        sessionStorage.setItem(WORKSPACE_STORAGE_KEY, serializeStorageValue(envelope));
        const bytes = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
        let target: string | undefined;
        const write = Storage.prototype.setItem;
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(
            function (this: Storage, key, value) {
                if (key !== WORKSPACE_STORAGE_KEY) {
                    if (outcome === "refused-write")
                        throw new DOMException("combined tree refused", "QuotaExceededError");
                    target = key;
                }
                write.call(this, key, value);
            },
        );
        const read = Storage.prototype.getItem;
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
            if (outcome === "refused-verification" && key === target)
                throw new Error("combined tree verification unavailable");
            return read.call(this, key);
        });
        const loaded = loadStoredWorkspace();
        vi.restoreAllMocks();
        expect(loaded.tabs[0].value === owner.value).toBe(outcome !== "saved");
        expect(sessionStorage.getItem(historyKey)).toBe(outcome === "saved" ? null : historyBytes);
        const tree =
            loaded.tabs[0].value !== owner.value
                ? tabStorage.read<ReturnType<typeof defaultTree>>(getTabTreeKey(loaded.tabs[0]))!
                      .state
                : undefined;
        expect(tree?.root).toEqual(outcome === "saved" ? defaultTree().root : undefined);
        expect(tree?.puzzleSession?.attempts.map((attempt) => attempt.puzzle)).toEqual(
            outcome === "saved" ? [puzzle] : undefined,
        );
        expect(tree?.puzzleSession?.selectedAttemptId).toBe(outcome === "saved" ? null : undefined);
        expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(
            outcome === "saved" ? serializeStorageValue(loaded) : bytes,
        );
    },
);

function readStoredWorkspace() {
    const raw = sessionStorage.getItem(WORKSPACE_STORAGE_KEY)!;
    return deserializeStorageValue<unknown>(raw) ?? JSON.parse(raw);
}

function storeUnownedDirtyTree() {
    const treeId = crypto.randomUUID();
    const tree = defaultTree();
    tree.dirty = true;
    tree.headers.event = "Recoverable edits";
    const storedTree = serializeStorageValue({ version: 1, state: tree });
    sessionStorage.setItem(treeId, storedTree);
    return { treeId, storedTree };
}

afterEach(() => {
    vi.restoreAllMocks();
    native.warn.mockClear();
    persistError.reportPersistError.mockClear();
});

test("default workspace is a complete, current envelope with one active new tab", () => {
    sessionStorage.clear();
    const workspace = defaultWorkspace();

    expect(workspace).toMatchObject({
        version: 1,
        tabs: [{ name: "Tab.NewTab", type: "new", gameOrigin: { kind: "none" } }],
        activeTab: workspace.tabs[0].value,
    });
    expect(workspace.tabs).toHaveLength(1);
    expect(workspace.tabs[0].value).toMatch(/^[0-9a-f]{8}-/i);
    expect(workspace).not.toHaveProperty("treeOwnershipUncertain");
});

test("workspace physical ownership protects referenced trees and repairs colliding keys", () => {
    sessionStorage.clear();
    const treeKey = crypto.randomUUID();
    const first: Tab = { ...legacyTab, value: crypto.randomUUID(), treeKey };
    const second: Tab = { ...first, name: "Second", value: crypto.randomUUID() };
    const tree = defaultTree();
    tree.headers.event = "Shared source generation";
    tabStorage.seed(treeKey, tree);
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({ version: 1, tabs: [first, second], activeTab: second.value }),
    );
    const loaded = loadStoredWorkspace();
    expect(loaded.tabs.map((tab) => tab.value)).toEqual([first.value, second.value]);
    expect(getTabTreeKey(loaded.tabs[0]!)).toBe(treeKey);
    expect(getTabTreeKey(loaded.tabs[1]!)).not.toBe(treeKey);
    expect(loaded.activeTab).toBe(second.value);
    for (const tab of loaded.tabs)
        expect(
            tabStorage.read<ReturnType<typeof defaultTree>>(getTabTreeKey(tab))?.state.headers
                .event,
        ).toBe("Shared source generation");
    expect(sessionStorage.getItem(treeKey)).not.toBeNull();
    expect(
        saveWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY, {
            version: 1,
            tabs: [first, second],
            activeTab: first.value,
        }),
    ).toBeNull();
    expect(
        saveWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY, {
            ...loaded,
            tabs: [{ ...first, treeKey: "invalid" }],
        }),
    ).toBeNull();
});

test("ID repair clones the effective physical source and grants independent ownership", () => {
    sessionStorage.clear();
    const treeKey = crypto.randomUUID();
    const first: Tab = { ...legacyTab, value: crypto.randomUUID(), treeKey };
    const broken: Tab = { ...first, value: "legacy-logical-owner" };
    const tree = defaultTree();
    tree.headers.event = "Referenced repair source";
    tabStorage.seed(treeKey, tree);
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({ version: 1, tabs: [first, broken], activeTab: broken.value }),
    );
    const loaded = loadStoredWorkspace();
    const repaired = loaded.tabs[1]!;
    expect(repaired.value).not.toBe(broken.value);
    expect(repaired.treeKey).toBeUndefined();
    expect(getTabTreeKey(repaired)).not.toBe(treeKey);
    expect(
        tabStorage.read<ReturnType<typeof defaultTree>>(getTabTreeKey(repaired))?.state.headers
            .event,
    ).toBe("Referenced repair source");
    expect(sessionStorage.getItem(treeKey)).not.toBeNull();
    expect(loaded.activeTab).toBe(repaired.value);
});

test("ID repair skips training tree handling while cloning and retiring an ordinary tab source", () => {
    sessionStorage.clear();
    const training: Tab = {
        ...legacyTab,
        value: "legacy-training-owner",
        type: "chessriddleTraining",
    };
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    sessionStorage.setItem(training.value, tree);
    sessionStorage.setItem(legacyTab.value, tree);
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({
            version: LEGACY_WORKSPACE_VERSION,
            tabs: [training, legacyTab],
            activeTab: training.value,
            treeOwnershipUncertain: true,
        }),
    );
    const clone = vi.spyOn(tabStorage, "clone");

    const loaded = loadStoredWorkspace();
    const repairedTraining = loaded.tabs[0]!;
    const repairedOrdinary = loaded.tabs[1]!;

    expect(repairedTraining.value).not.toBe(training.value);
    expect(repairedOrdinary.value).not.toBe(legacyTab.value);
    expect(loaded.activeTab).toBe(repairedTraining.value);
    expect(clone).toHaveBeenCalledExactlyOnceWith(legacyTab.value, repairedOrdinary.value, false);
    expect(sessionStorage.getItem(getTabTreeKey(repairedTraining))).toBeNull();
    expect(tabStorage.getStatus(getTabTreeKey(repairedTraining)).kind).toBe("not-read");
    expect(loaded.treeOwnershipPendingRemovalIds).toEqual([legacyTab.value]);
    expect(loaded.treeOwnershipProtectedIds).toEqual([training.value]);
    expect(readStoredWorkspace()).toEqual(loaded);
    expect(sessionStorage.getItem(training.value)).toBe(tree);
    expect(sessionStorage.getItem(legacyTab.value)).toBeNull();
    expect(tabStorage.read(getTabTreeKey(repairedOrdinary))?.state).toEqual(defaultTree());
});

test("missing explicit-reference ID repair refuses blank admission and retains original ownership", () => {
    sessionStorage.clear();
    const physical = crypto.randomUUID();
    const original: Tab = { ...legacyTab, value: "legacy-logical-owner", treeKey: physical };
    const envelope = {
        version: LEGACY_WORKSPACE_VERSION,
        tabs: [original],
        activeTab: original.value,
    };
    const bytes = serializeStorageValue(envelope);
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, bytes);
    expect(tabStorage.getStatus(physical).kind).toBe("not-read");
    const refused = loadStoredWorkspace();
    expect(refused.tabs).toEqual([original]);
    expect(refused.activeTab).toBe(original.value);
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(bytes);
    expect(sessionStorage.getItem(physical)).toBeNull();
    expect(tabStorage.getStatus(physical)).toMatchObject({ kind: "unavailable" });
    expect(tabStorage.pendingCount()).toBe(0);
    expect(sessionStorage.length).toBe(1);
    const tree = defaultTree();
    tree.headers.event = "Recovered repair source";
    sessionStorage.setItem(physical, serializeStorageValue({ version: 1, state: tree }));
    const repaired = loadStoredWorkspace();
    expect(repaired.tabs[0]!.value).not.toBe(original.value);
    expect(repaired.tabs[0]!.treeKey).toBeUndefined();
    expect(repaired.activeTab).toBe(repaired.tabs[0]!.value);
    expect(
        tabStorage.read<ReturnType<typeof defaultTree>>(repaired.tabs[0]!.value)?.state.headers
            .event,
    ).toBe("Recovered repair source");
});

test("ordinary absent legacy ID repair keeps its legitimate blank semantics", () => {
    sessionStorage.clear();
    sessionStorage.setItem("tabs", serializeStorageValue([legacyTab]));
    sessionStorage.setItem("activeTab", serializeStorageValue(legacyTab.value));
    const repaired = loadStoredWorkspace();
    expect(repaired.tabs[0]!.value).not.toBe(legacyTab.value);
    expect(repaired.tabs[0]!.treeKey).toBeUndefined();
    expect(repaired.activeTab).toBe(repaired.tabs[0]!.value);
    expect(readStoredWorkspace()).toEqual(repaired);
    expect(tabStorage.read(repaired.tabs[0]!.value)).toBeNull();
    expect(tabStorage.getStatus(repaired.tabs[0]!.value).kind).toBe("absent");
    expect(sessionStorage.getItem("tabs")).toBeNull();
});

test("legacy fallback and referenced failed-admission markers retain the current physical owners", () => {
    sessionStorage.clear();
    const legacy: Tab = { ...legacyTab, value: crypto.randomUUID() };
    const physical: Tab = { ...legacy, value: crypto.randomUUID(), treeKey: crypto.randomUUID() };
    tabStorage.seed(legacy.value, defaultTree());
    tabStorage.seed(getTabTreeKey(physical), defaultTree());
    tabStorage.recordFailedAdmission(getTabTreeKey(physical));
    const bytes = sessionStorage.getItem(legacy.value);
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({ version: 1, tabs: [legacy, physical], activeTab: legacy.value }),
    );
    const loaded = loadStoredWorkspace();
    expect(loaded.tabs).toEqual([legacy, physical]);
    expect(sessionStorage.getItem(legacy.value)).toBe(bytes);
    expect(sessionStorage.getItem(getTabTreeKey(physical))).not.toBeNull();
});

test("live validation refuses duplicate logical IDs even when physical keys differ", () => {
    sessionStorage.clear();
    const first: Tab = { ...legacyTab, value: crypto.randomUUID(), treeKey: crypto.randomUUID() };
    const second: Tab = { ...first, treeKey: crypto.randomUUID() };
    const original = saveWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY, {
        version: 1,
        tabs: [first],
        activeTab: first.value,
    });
    const bytes = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
    expect(original).not.toBeNull();
    expect(
        saveWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY, {
            version: 1,
            tabs: [first, second],
            activeTab: first.value,
        }),
    ).toBeNull();
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(bytes);
});

test("repair allocation reserves later logical and physical owners plus earlier fresh repairs", () => {
    sessionStorage.clear();
    const futureLogical = crypto.randomUUID();
    const futurePhysical = crypto.randomUUID();
    const firstFresh = crypto.randomUUID();
    const secondFresh = crypto.randomUUID();
    const third: Tab = { ...legacyTab, value: futureLogical, treeKey: futurePhysical };
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({
            version: 1,
            tabs: [legacyTab, { ...legacyTab, value: "another-legacy" }, third],
            activeTab: third.value,
        }),
    );
    vi.spyOn(crypto, "randomUUID")
        .mockReturnValueOnce(futureLogical)
        .mockReturnValueOnce(futurePhysical)
        .mockReturnValueOnce(firstFresh)
        .mockReturnValueOnce(firstFresh)
        .mockReturnValueOnce(secondFresh);
    const loaded = loadStoredWorkspace();
    expect(loaded.tabs.map((tab) => tab.value)).toEqual([firstFresh, secondFresh, third.value]);
    expect(loaded.tabs[2]).toEqual(third);
    expect(loaded.activeTab).toBe(third.value);
});

test("workspace load operations validate schema boundaries and preserve uncertain trees", async () => {
    const fresh = await import("./workspace");
    const freshStorage = (await import("./store/tabStorage")).tabStorage;
    sessionStorage.clear();
    const unownedId = crypto.randomUUID();
    const unownedTree = serializeStorageValue({ version: 1, state: defaultTree() });
    sessionStorage.setItem(unownedId, unownedTree);
    expect(
        fresh.loadWorkspace(sessionStorage, fresh.WORKSPACE_STORAGE_KEY).treeOwnershipUncertain,
    ).toBe(true);
    expect(sessionStorage.getItem(unownedId)).toBe(unownedTree);
    sessionStorage.clear();
    const valid = { ...legacyTab, value: crypto.randomUUID() };
    sessionStorage.setItem(
        fresh.WORKSPACE_STORAGE_KEY,
        JSON.stringify({ version: 1, tabs: [valid], activeTab: valid.value }),
    );

    const snapshot = vi.spyOn(freshStorage, "snapshotStoredTreeKeys");
    expect(fresh.loadWorkspace(sessionStorage, fresh.WORKSPACE_STORAGE_KEY)).toEqual({
        version: 1,
        tabs: [valid],
        activeTab: valid.value,
    });
    expect(snapshot).not.toHaveBeenCalled();
    snapshot.mockRestore();
    expect(sessionStorage.getItem("workspace")).not.toBeNull();

    const second = { ...valid, name: "Second", value: crypto.randomUUID() };
    sessionStorage.setItem(
        "workspace",
        JSON.stringify({ version: 1, tabs: [valid, second], activeTab: second.value }),
    );
    expect(fresh.loadWorkspace(sessionStorage, fresh.WORKSPACE_STORAGE_KEY).activeTab).toBe(
        second.value,
    );

    sessionStorage.setItem(
        "workspace",
        JSON.stringify({ tabs: Array(101).fill(valid), activeTab: "x".repeat(129) }),
    );
    const repaired = fresh.loadWorkspace(sessionStorage, fresh.WORKSPACE_STORAGE_KEY);
    expect(repaired.tabs).toHaveLength(1);
    expect(repaired.activeTab).toBe(repaired.tabs[0].value);
});

test("migrates separate legacy keys, repairs IDs, and keeps tree state", () => {
    sessionStorage.clear();
    sessionStorage.setItem("tabs", JSON.stringify([legacyTab, legacyTab]));
    sessionStorage.setItem("activeTab", JSON.stringify("42"));
    sessionStorage.setItem("42", serializeStorageValue({ version: 0, state: defaultTree() }));
    const workspace = loadStoredWorkspace();

    expect(workspace.tabs).toHaveLength(2);
    expect(new Set(workspace.tabs.map((tab) => tab.value)).size).toBe(2);
    expect(workspace.tabs.every((tab) => /^[0-9a-f]{8}-/i.test(tab.value))).toBe(true);
    expect(sessionStorage.getItem("tabs")).toBeNull();
    expect(sessionStorage.getItem("activeTab")).toBeNull();
    expect(sessionStorage.getItem("42")).toBeNull();
    expect(workspace.tabs.every((tab) => sessionStorage.getItem(tab.value) !== null)).toBe(true);
    expect(readStoredWorkspace()).toEqual(workspace);
});

test("unreadable legacy-tree migration retains bytes when old-source cleanup is denied", () => {
    sessionStorage.clear();
    sessionStorage.setItem("tabs", serializeStorageValue([legacyTab]));
    sessionStorage.setItem("activeTab", serializeStorageValue(legacyTab.value));
    sessionStorage.setItem(legacyTab.value, "{broken");
    const deny = denyStorageRemoval(legacyTab.value);

    const workspace = loadStoredWorkspace();

    deny.mockRestore();
    expect(workspace.tabs).toHaveLength(1);
    expect(workspace.tabs[0]!.value).not.toBe(legacyTab.value);
    expect(readStoredWorkspace().tabs[0]!.value).toBe(workspace.tabs[0]!.value);
    expect(sessionStorage.getItem(legacyTab.value)).toBe("{broken");
    expect(sessionStorage.getItem(workspace.tabs[0]!.value)).toBe("{broken");
    expect(tabStorage.getStatus(workspace.tabs[0]!.value)).toEqual({
        kind: "unreadable",
        rawValue: "{broken",
    });
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    expect(persistError.reportPersistError).toHaveBeenCalledWith(
        expect.objectContaining({ name: "SecurityError" }),
    );
});

test("keeps the active tab selected when its legacy ID is migrated", () => {
    sessionStorage.clear();
    const first = { ...legacyTab, value: crypto.randomUUID() };
    const second = { ...legacyTab, name: "Active", value: "old-active" };
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({ version: 0, tabs: [first, second], activeTab: second.value }),
    );
    sessionStorage.setItem(
        second.value,
        serializeStorageValue({ version: 0, state: defaultTree() }),
    );

    const workspace = loadStoredWorkspace();

    expect(workspace.tabs[0]).toEqual(first);
    expect(workspace.tabs[1]!.value).not.toBe(second.value);
    expect(workspace.activeTab).toBe(workspace.tabs[1]!.value);
});

test.each([128, 129])("legacy active-tab IDs of length %s keep the repair boundary", (length) => {
    sessionStorage.clear();
    const first = { ...legacyTab, value: crypto.randomUUID() };
    const second = { ...legacyTab, name: "Active", value: "x".repeat(length) };
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({
            version: LEGACY_WORKSPACE_VERSION,
            tabs: [first, second],
            activeTab: second.value,
        }),
    );

    const workspace = loadStoredWorkspace();

    expect(workspace.tabs).toHaveLength(2);
    expect(workspace.tabs[0]).toEqual(first);
    expect(workspace.tabs[1]!.value).not.toBe(second.value);
    expect(workspace.activeTab).toBe(workspace.tabs[length === 128 ? 1 : 0]!.value);
    expect(readStoredWorkspace()).toEqual(workspace);
});

test("sweeps valid orphan trees during the first successful legacy migration", () => {
    sessionStorage.clear();
    sessionStorage.setItem("tabs", JSON.stringify([legacyTab]));
    sessionStorage.setItem("activeTab", JSON.stringify(legacyTab.value));
    sessionStorage.setItem(
        legacyTab.value,
        serializeStorageValue({ version: 0, state: defaultTree() }),
    );
    const orphanTreeKey = "unowned-legacy-tree";
    const unrelatedKey = "app-preference";
    sessionStorage.setItem(
        orphanTreeKey,
        serializeStorageValue({ version: 1, state: defaultTree() }),
    );
    sessionStorage.setItem(unrelatedKey, "keep this value");
    const snapshot = vi.spyOn(tabStorage, "snapshotStoredTreeKeys");

    const workspace = loadStoredWorkspace();

    expect(snapshot).not.toHaveBeenCalled();
    snapshot.mockRestore();
    expect(workspace.tabs[0]!.value).not.toBe(legacyTab.value);
    expect(sessionStorage.getItem(legacyTab.value)).toBeNull();
    expect(sessionStorage.getItem(orphanTreeKey)).toBeNull();
    expect(sessionStorage.getItem(unrelatedKey)).toBe("keep this value");
    expect(sessionStorage.getItem(workspace.tabs[0]!.value)).not.toBeNull();
});

test.each([
    { scenario: "an authoritative orphan sweep", uncertain: false },
    { scenario: "an uncertain-ownership snapshot", uncertain: true },
])("an unowned undecodable UUID without intent survives $scenario", ({ uncertain }) => {
    sessionStorage.clear();
    const retained = { ...legacyTab, value: crypto.randomUUID() };
    const unownedId = crypto.randomUUID();
    sessionStorage.setItem(unownedId, "not a tree");
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({
            version: 1,
            tabs: [retained],
            activeTab: retained.value,
            ...(uncertain ? { treeOwnershipUncertain: true } : {}),
        }),
    );

    const workspace = loadStoredWorkspace();

    expect(sessionStorage.getItem(unownedId)).toBe("not a tree");
    expect(workspace).not.toHaveProperty("treeOwnershipPendingRemovalIds");
    expect(workspace.treeOwnershipUncertain).toBe(uncertain ? true : undefined);
    expect(workspace.treeOwnershipProtectedIds).toEqual(uncertain ? [] : undefined);
    expect(readStoredWorkspace()).toEqual(workspace);
});

test("a failed removal of a legacy non-UUID tree does not abort startup and retries", () => {
    sessionStorage.clear();
    sessionStorage.setItem("tabs", JSON.stringify([legacyTab]));
    sessionStorage.setItem("activeTab", JSON.stringify(legacyTab.value));
    sessionStorage.setItem(
        legacyTab.value,
        serializeStorageValue({ version: 0, state: defaultTree() }),
    );
    const refused = denyStorageRemoval(legacyTab.value);

    let migrated: ReturnType<typeof loadStoredWorkspace> | undefined;
    expect(() => {
        migrated = loadStoredWorkspace();
    }).not.toThrow();
    expect(migrated?.tabs[0]!.value).not.toBe(legacyTab.value);
    expect(sessionStorage.getItem(legacyTab.value)).not.toBeNull();
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    refused.mockRestore();

    loadStoredWorkspace();

    expect(sessionStorage.getItem(legacyTab.value)).toBeNull();
});

test("rolls back staged clones and preserves legacy storage when the envelope write fails", () => {
    sessionStorage.clear();
    sessionStorage.setItem("tabs", JSON.stringify([legacyTab]));
    sessionStorage.setItem("activeTab", JSON.stringify(legacyTab.value));
    const legacyTree = serializeStorageValue({ version: 0, state: defaultTree() });
    sessionStorage.setItem(legacyTab.value, legacyTree);
    const stagedCloneIds: string[] = [];
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
            if (key === WORKSPACE_STORAGE_KEY) {
                throw new DOMException("quota", "QuotaExceededError");
            }
            if (key !== legacyTab.value && key !== "tabs" && key !== "activeTab") {
                stagedCloneIds.push(key);
            }
            return originalSetItem.call(this, key, value);
        });

    try {
        const workspace = loadStoredWorkspace();

        expect(workspace.tabs).toEqual([legacyTab]);
        expect(workspace.activeTab).toBe(legacyTab.value);
        expect(sessionStorage.getItem("tabs")).not.toBeNull();
        expect(sessionStorage.getItem("activeTab")).not.toBeNull();
        expect(tabStorage.read(legacyTab.value)?.state).toMatchObject({ root: defaultTree().root });
        expect(stagedCloneIds).toHaveLength(1);
        expect(sessionStorage.getItem(stagedCloneIds[0]!)).toBeNull();
        expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
        expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    } finally {
        setItem.mockRestore();
    }
});

test("successfully retries migration after a failed envelope write", () => {
    sessionStorage.clear();
    sessionStorage.setItem("tabs", JSON.stringify([legacyTab]));
    sessionStorage.setItem("activeTab", JSON.stringify(legacyTab.value));
    sessionStorage.setItem(
        legacyTab.value,
        serializeStorageValue({ version: 0, state: defaultTree() }),
    );
    const originalSetItem = Storage.prototype.setItem;
    const failedWrite = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
            if (key === WORKSPACE_STORAGE_KEY) {
                throw new DOMException("quota", "QuotaExceededError");
            }
            return originalSetItem.call(this, key, value);
        });
    loadStoredWorkspace();
    failedWrite.mockRestore();

    const workspace = loadStoredWorkspace();

    expect(workspace.tabs[0].value).not.toBe(legacyTab.value);
    expect(tabStorage.read(workspace.tabs[0].value)).not.toBeNull();
    expect(sessionStorage.getItem(legacyTab.value)).toBeNull();
    expect(sessionStorage.getItem("tabs")).toBeNull();
    expect(sessionStorage.getItem("activeTab")).toBeNull();
    expect(readStoredWorkspace()).toEqual(workspace);
});

test("rewrites a pretty-printed JSON envelope in compressed form", () => {
    sessionStorage.clear();
    const valid = { ...legacyTab, value: crypto.randomUUID() };
    const workspace = { version: 1, tabs: [valid], activeTab: valid.value } as const;
    const prettyJson = JSON.stringify(workspace, null, 2);
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, prettyJson);
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    const result = loadStoredWorkspace();

    expect(result).toEqual(workspace);
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(serializeStorageValue(result));
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).not.toBe(prettyJson);
    expect(setItem).toHaveBeenCalledWith(WORKSPACE_STORAGE_KEY, serializeStorageValue(result));
    setItem.mockRestore();
});

test("does not rewrite an already matching compressed envelope", () => {
    sessionStorage.clear();
    const valid = { ...legacyTab, value: crypto.randomUUID() };
    const workspace = { version: 1, tabs: [valid], activeTab: valid.value } as const;
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, serializeStorageValue(workspace));
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    expect(loadStoredWorkspace()).toEqual(workspace);
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
});

test("reclaims an orphaned durable tree while retaining tabs and unrelated UUID keys", () => {
    sessionStorage.clear();
    const retained = { ...legacyTab, value: crypto.randomUUID() };
    const orphan = crypto.randomUUID();
    const unrelated = crypto.randomUUID();
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    const workspace = { version: 1, tabs: [retained], activeTab: retained.value };
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, serializeStorageValue(workspace));
    sessionStorage.setItem(retained.value, tree);
    sessionStorage.setItem(orphan, tree);
    sessionStorage.setItem(unrelated, serializeStorageValue({ other: true }));

    expect(loadStoredWorkspace()).toEqual(workspace);
    expect(sessionStorage.getItem(orphan)).toBeNull();
    expect(sessionStorage.getItem(retained.value)).toBe(tree);
    expect(sessionStorage.getItem(unrelated)).not.toBeNull();
});

test("a stale refused-admission marker never deletes a retained tab tree", () => {
    sessionStorage.clear();
    const retained = { ...legacyTab, value: crypto.randomUUID() };
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    const marker = `chessfable:failed-tab-admission:${retained.value}`;
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({ version: 1, tabs: [retained], activeTab: retained.value }),
    );
    sessionStorage.setItem(retained.value, tree);
    sessionStorage.setItem(marker, "1");

    expect(loadStoredWorkspace().tabs).toEqual([retained]);
    expect(sessionStorage.getItem(retained.value)).toBe(tree);
    expect(sessionStorage.getItem(marker)).toBeNull();
});

test("a refused-admission marker cannot delete a non-tree session value", () => {
    sessionStorage.clear();
    const retained = { ...legacyTab, value: crypto.randomUUID() };
    const unrelatedId = crypto.randomUUID();
    const marker = `chessfable:failed-tab-admission:${unrelatedId}`;
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({ version: 1, tabs: [retained], activeTab: retained.value }),
    );
    sessionStorage.setItem(unrelatedId, "keep me");
    sessionStorage.setItem(marker, "1");

    loadStoredWorkspace();

    expect(sessionStorage.getItem(unrelatedId)).toBe("keep me");
    expect(sessionStorage.getItem(marker)).toBeNull();
});

test("one refused marker cleanup failure does not block later markers", () => {
    sessionStorage.clear();
    const retained = { ...legacyTab, value: crypto.randomUUID() };
    const firstMarker = `chessfable:failed-tab-admission:${crypto.randomUUID()}`;
    const secondMarker = `chessfable:failed-tab-admission:${crypto.randomUUID()}`;
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({ version: 1, tabs: [retained], activeTab: retained.value }),
    );
    sessionStorage.setItem(firstMarker, "1");
    sessionStorage.setItem(secondMarker, "1");
    const deny = denyStorageRemoval(firstMarker);

    loadStoredWorkspace();

    deny.mockRestore();
    expect(sessionStorage.getItem(firstMarker)).toBe("1");
    expect(sessionStorage.getItem(secondMarker)).toBeNull();
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
});

test("one refused marker read failure preserves its tree and replays later markers", () => {
    sessionStorage.clear();
    const retained = { ...legacyTab, value: crypto.randomUUID() };
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const firstMarker = `chessfable:failed-tab-admission:${firstId}`;
    const secondMarker = `chessfable:failed-tab-admission:${secondId}`;
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({ version: 1, tabs: [retained], activeTab: retained.value }),
    );
    sessionStorage.setItem(firstId, tree);
    sessionStorage.setItem(secondId, tree);
    sessionStorage.setItem(firstMarker, "1");
    sessionStorage.setItem(secondMarker, "1");
    const originalGetItem = Storage.prototype.getItem;
    const deny = vi
        .spyOn(Storage.prototype, "getItem")
        .mockImplementation(function (this: Storage, key) {
            if (key === firstMarker) throw new Error("marker unavailable");
            return originalGetItem.call(this, key);
        });

    loadStoredWorkspace();

    deny.mockRestore();
    expect(sessionStorage.getItem(firstId)).toBe(tree);
    expect(sessionStorage.getItem(firstMarker)).toBe("1");
    expect(sessionStorage.getItem(secondId)).toBeNull();
    expect(sessionStorage.getItem(secondMarker)).toBeNull();
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
});

test("a failed refused-tree removal is not retried by the same load's orphan sweep", () => {
    sessionStorage.clear();
    const retained = { ...legacyTab, value: crypto.randomUUID() };
    const refusedId = crypto.randomUUID();
    const marker = `chessfable:failed-tab-admission:${refusedId}`;
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({ version: 1, tabs: [retained], activeTab: retained.value }),
    );
    sessionStorage.setItem(refusedId, tree);
    sessionStorage.setItem(marker, "1");
    const deny = denyStorageRemoval(refusedId);

    loadStoredWorkspace();

    expect(deny.mock.calls.filter(([key]) => key === refusedId)).toHaveLength(1);
    deny.mockRestore();
    expect(sessionStorage.getItem(refusedId)).toBe(tree);
    expect(sessionStorage.getItem(marker)).toBe("1");
});

test("a refused tree stays out of a fresh uncertain-ownership snapshot", () => {
    sessionStorage.clear();
    const older = storeUnownedDirtyTree();
    const refused = storeUnownedDirtyTree();
    const marker = `chessfable:failed-tab-admission:${refused.treeId}`;
    sessionStorage.setItem(marker, "1");
    const deny = denyStorageRemoval(refused.treeId);

    const workspace = loadStoredWorkspace();

    deny.mockRestore();
    expect(workspace.treeOwnershipUncertain).toBe(true);
    expect(workspace.treeOwnershipProtectedIds).toEqual([older.treeId]);
    expect(readStoredWorkspace()).toMatchObject({
        treeOwnershipProtectedIds: [older.treeId],
    });
    expect(sessionStorage.getItem(older.treeId)).toBe(older.storedTree);
    expect(sessionStorage.getItem(refused.treeId)).toBe(refused.storedTree);
    expect(sessionStorage.getItem(marker)).toBe("1");
});

test("an existing ownership snapshot drops a tree with a refused-admission marker", () => {
    sessionStorage.clear();
    const retained = { ...legacyTab, value: crypto.randomUUID() };
    const older = storeUnownedDirtyTree();
    const refused = storeUnownedDirtyTree();
    const marker = `chessfable:failed-tab-admission:${refused.treeId}`;
    sessionStorage.setItem(marker, "1");
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({
            version: 1,
            tabs: [retained],
            activeTab: retained.value,
            treeOwnershipUncertain: true,
            treeOwnershipProtectedIds: [older.treeId, refused.treeId],
        }),
    );
    const deny = denyStorageRemoval(refused.treeId);

    const workspace = loadStoredWorkspace();

    deny.mockRestore();
    expect(workspace.treeOwnershipProtectedIds).toEqual([older.treeId]);
    expect(readStoredWorkspace()).toMatchObject({
        treeOwnershipProtectedIds: [older.treeId],
    });
    expect(sessionStorage.getItem(older.treeId)).toBe(older.storedTree);
    expect(sessionStorage.getItem(refused.treeId)).toBe(refused.storedTree);
    expect(sessionStorage.getItem(marker)).toBe("1");
});

test("malformed refused-admission markers are removed without touching session values", () => {
    sessionStorage.clear();
    const retained = { ...legacyTab, value: crypto.randomUUID() };
    const unrelatedId = crypto.randomUUID();
    const badIdMarker = "chessfable:failed-tab-admission:not-a-uuid";
    const badValueMarker = `chessfable:failed-tab-admission:${unrelatedId}`;
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({ version: 1, tabs: [retained], activeTab: retained.value }),
    );
    sessionStorage.setItem(unrelatedId, "keep me");
    sessionStorage.setItem(badIdMarker, "1");
    sessionStorage.setItem(badValueMarker, "unexpected");

    loadStoredWorkspace();

    expect(sessionStorage.getItem(unrelatedId)).toBe("keep me");
    expect(sessionStorage.getItem(badIdMarker)).toBeNull();
    expect(sessionStorage.getItem(badValueMarker)).toBeNull();
});

test("retries orphan cleanup on the next load after storage refuses removal", () => {
    sessionStorage.clear();
    const retained = { ...legacyTab, value: crypto.randomUUID() };
    const orphan = crypto.randomUUID();
    const workspace = { version: 1, tabs: [retained], activeTab: retained.value };
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, serializeStorageValue(workspace));
    sessionStorage.setItem(orphan, serializeStorageValue({ version: 1, state: defaultTree() }));
    const refused = denyStorageRemoval(orphan);

    expect(loadStoredWorkspace()).toEqual(workspace);
    expect(sessionStorage.getItem(orphan)).not.toBeNull();
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    refused.mockRestore();

    expect(loadStoredWorkspace()).toEqual(workspace);
    expect(sessionStorage.getItem(orphan)).toBeNull();
});

test("preserves valid tree keys through repair, a second load, and a subsequent save", () => {
    sessionStorage.clear();
    const treeId = crypto.randomUUID();
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, "{broken");
    sessionStorage.setItem(treeId, tree);

    const repaired = loadStoredWorkspace();
    expect(repaired.treeOwnershipUncertain).toBe(true);
    expect(sessionStorage.getItem(treeId)).toBe(tree);

    const secondLoad = loadStoredWorkspace();
    expect(secondLoad.treeOwnershipUncertain).toBe(true);
    expect(sessionStorage.getItem(treeId)).toBe(tree);

    const saved = saveWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY, {
        ...secondLoad,
        activeTab: secondLoad.tabs[0]!.value,
    });
    expect(saved?.treeOwnershipUncertain).toBe(true);
    expect(loadStoredWorkspace().treeOwnershipUncertain).toBe(true);

    expect(sessionStorage.getItem(treeId)).toBe(tree);
});

test("preserves a protected old tree and reclaims a later orphan", () => {
    sessionStorage.clear();
    const retained = { ...legacyTab, value: crypto.randomUUID() };
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({
            version: 1,
            tabs: [retained],
            activeTab: retained.value,
            treeOwnershipUncertain: true,
        }),
    );
    const { treeId, storedTree } = storeUnownedDirtyTree();

    const firstLoad = loadStoredWorkspace();
    expect(firstLoad.treeOwnershipUncertain).toBe(true);
    expect(firstLoad.treeOwnershipProtectedIds).toContain(treeId);

    const laterOrphanId = crypto.randomUUID();
    const laterOrphan = serializeStorageValue({ version: 1, state: defaultTree() });
    sessionStorage.setItem(laterOrphanId, laterOrphan);

    const secondLoad = loadStoredWorkspace();

    expect(secondLoad.treeOwnershipUncertain).toBe(true);
    expect(secondLoad.treeOwnershipProtectedIds).toContain(treeId);
    expect(sessionStorage.getItem(treeId)).toBe(storedTree);
    expect(sessionStorage.getItem(laterOrphanId)).toBeNull();
});

test("persists an ownership snapshot after an envelope repair write fails", () => {
    sessionStorage.clear();
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, "{broken");
    const { treeId, storedTree } = storeUnownedDirtyTree();
    const writeError = new DOMException("denied", "SecurityError");
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementationOnce(function (this: Storage, key, value) {
            if (key === WORKSPACE_STORAGE_KEY) throw writeError;
            return originalSetItem.call(this, key, value);
        });

    const repaired = loadStoredWorkspace();

    setItem.mockRestore();
    expect(repaired.treeOwnershipUncertain).toBe(true);
    expect(repaired.treeOwnershipProtectedIds).toContain(treeId);
    expect(saveWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY, repaired)).toMatchObject({
        treeOwnershipUncertain: true,
        treeOwnershipProtectedIds: [treeId],
    });

    const reloaded = loadStoredWorkspace();
    expect(reloaded.treeOwnershipUncertain).toBe(true);
    expect(reloaded.treeOwnershipProtectedIds).toContain(treeId);
    expect(sessionStorage.getItem(treeId)).toBe(storedTree);
    expect(persistError.reportPersistError).toHaveBeenCalledWith(writeError);
});

test("preserves unowned stored trees across loads when the workspace key is absent", () => {
    sessionStorage.clear();
    const { treeId } = storeUnownedDirtyTree();
    const sentinelTree = serializeStorageValue({ version: 1, state: defaultTree() });
    sessionStorage.setItem("Stryker was here", sentinelTree);

    const firstLoad = loadStoredWorkspace();
    expect(firstLoad.treeOwnershipUncertain).toBe(true);
    expect(readStoredWorkspace()).toMatchObject({ treeOwnershipUncertain: true });
    expect(tabStorage.read(treeId)?.state).toMatchObject({
        dirty: true,
        headers: { event: "Recoverable edits" },
    });
    const recoveredTree = sessionStorage.getItem(treeId);
    expect(recoveredTree).not.toBeNull();
    expect(sessionStorage.getItem("Stryker was here")).toBe(sentinelTree);

    const secondLoad = loadStoredWorkspace();
    expect(secondLoad.treeOwnershipUncertain).toBe(true);
    expect(sessionStorage.getItem(treeId)).toBe(recoveredTree);
    expect(sessionStorage.getItem("Stryker was here")).toBe(sentinelTree);
});

test("a failed first ownership scan is not replaced by a second scan in the same load", () => {
    sessionStorage.clear();
    const { treeId, storedTree } = storeUnownedDirtyTree();
    const snapshot = vi
        .spyOn(tabStorage, "snapshotStoredTreeKeys")
        .mockReturnValueOnce(null)
        .mockReturnValueOnce([]);

    const workspace = loadStoredWorkspace();

    expect(snapshot).toHaveBeenCalledOnce();
    snapshot.mockRestore();
    expect(workspace.treeOwnershipUncertain).toBe(true);
    expect(workspace).not.toHaveProperty("treeOwnershipProtectedIds");
    expect(sessionStorage.getItem(treeId)).toBe(storedTree);
});

test("the first uncertain-ownership load does not sweep a tree created after its snapshot", () => {
    sessionStorage.clear();
    const older = storeUnownedDirtyTree();
    const laterId = crypto.randomUUID();
    const laterTree = serializeStorageValue({ version: 1, state: defaultTree() });
    const originalSnapshot = tabStorage.snapshotStoredTreeKeys.bind(tabStorage);
    const snapshot = vi
        .spyOn(tabStorage, "snapshotStoredTreeKeys")
        .mockImplementation((maxTreeKeys, maxKeyLength, excludedKeys) => {
            const keys = originalSnapshot(maxTreeKeys, maxKeyLength, excludedKeys);
            sessionStorage.setItem(laterId, laterTree);
            return keys;
        });

    const workspace = loadStoredWorkspace();

    snapshot.mockRestore();
    expect(workspace.treeOwnershipUncertain).toBe(true);
    expect(workspace.treeOwnershipProtectedIds).toEqual([older.treeId]);
    expect(sessionStorage.getItem(older.treeId)).toBe(older.storedTree);
    expect(sessionStorage.getItem(laterId)).toBe(laterTree);
    loadStoredWorkspace();
    expect(sessionStorage.getItem(laterId)).toBeNull();
});

test("an empty first ownership snapshot preserves a later dirty tree until the next load", () => {
    sessionStorage.clear();
    let later: ReturnType<typeof storeUnownedDirtyTree>;
    const originalSnapshot = tabStorage.snapshotStoredTreeKeys.bind(tabStorage);
    const snapshot = vi
        .spyOn(tabStorage, "snapshotStoredTreeKeys")
        .mockImplementation((maxTreeKeys, maxKeyLength, excludedKeys) => {
            const keys = originalSnapshot(maxTreeKeys, maxKeyLength, excludedKeys);
            expect(keys).toEqual([]);
            later = storeUnownedDirtyTree();
            return keys;
        });

    const workspace = loadStoredWorkspace();

    snapshot.mockRestore();
    expect(workspace).not.toHaveProperty("treeOwnershipUncertain");
    expect(readStoredWorkspace()).toEqual(workspace);
    expect(sessionStorage.getItem(later!.treeId)).toBe(later!.storedTree);
    loadStoredWorkspace();
    expect(sessionStorage.getItem(later!.treeId)).toBeNull();
});

test("an oversized legacy workspace is not authority to sweep stored trees", () => {
    sessionStorage.clear();
    const tabs = Array.from({ length: MAX_WORKSPACE_TABS + 1 }, () => ({
        ...legacyTab,
        value: crypto.randomUUID(),
    }));
    const { treeId, storedTree } = storeUnownedDirtyTree();
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({ version: 0, tabs, activeTab: tabs[0]!.value }),
    );

    const workspace = loadStoredWorkspace();

    expect(workspace.treeOwnershipUncertain).toBe(true);
    expect(sessionStorage.getItem(treeId)).toBe(storedTree);
});

test("preserves unowned stored trees across loads for a parseable unsupported version", () => {
    sessionStorage.clear();
    const { treeId, storedTree } = storeUnownedDirtyTree();
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({ version: 2, tabs: [], activeTab: null }),
    );
    expect(readStoredWorkspaceValue(sessionStorage, WORKSPACE_STORAGE_KEY)).toEqual({
        version: 2,
        tabs: [],
        activeTab: null,
    });

    const firstLoad = loadStoredWorkspace();
    expect(firstLoad.treeOwnershipUncertain).toBe(true);
    expect(readStoredWorkspace()).toMatchObject({ treeOwnershipUncertain: true });
    expect(sessionStorage.getItem(treeId)).toBe(storedTree);

    const secondLoad = loadStoredWorkspace();
    expect(secondLoad.treeOwnershipUncertain).toBe(true);
    expect(sessionStorage.getItem(treeId)).toBe(storedTree);
});

test("leaves a genuinely empty first workspace load without an ownership marker", () => {
    sessionStorage.clear();

    const workspace = loadStoredWorkspace();

    expect(workspace).not.toHaveProperty("treeOwnershipUncertain");
    expect(readStoredWorkspace()).not.toHaveProperty("treeOwnershipUncertain");
});

test.each(["tabs", "activeTab"] as const)(
    "preserves the leftover %s key when cleanup cannot rewrite a matching envelope",
    (leftoverKey) => {
        sessionStorage.clear();
        const valid = { ...legacyTab, value: crypto.randomUUID() };
        const workspace = { version: 1, tabs: [valid], activeTab: valid.value } as const;
        const payload = serializeStorageValue(workspace);
        sessionStorage.setItem(WORKSPACE_STORAGE_KEY, payload);
        sessionStorage.setItem(leftoverKey, JSON.stringify("leftover"));
        const writeError = new DOMException("denied", "SecurityError");
        const originalSetItem = Storage.prototype.setItem;
        const setItem = vi
            .spyOn(Storage.prototype, "setItem")
            .mockImplementation(function (this: Storage, key, value) {
                if (key === WORKSPACE_STORAGE_KEY) throw writeError;
                return originalSetItem.call(this, key, value);
            });

        expect(loadStoredWorkspace()).toEqual(workspace);
        expect(sessionStorage.getItem(leftoverKey)).not.toBeNull();
        expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(payload);
        expect(persistError.reportPersistError).toHaveBeenCalledWith(writeError);
        setItem.mockRestore();
    },
);

test("cleans leftover legacy keys while leaving a matching envelope unchanged", () => {
    sessionStorage.clear();
    const valid = { ...legacyTab, value: crypto.randomUUID() };
    const workspace = { version: 1, tabs: [valid], activeTab: valid.value } as const;
    const payload = serializeStorageValue(workspace);
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, payload);
    sessionStorage.setItem("tabs", JSON.stringify([valid]));
    sessionStorage.setItem("activeTab", JSON.stringify(valid.value));

    expect(loadStoredWorkspace()).toEqual(workspace);
    expect(sessionStorage.getItem("tabs")).toBeNull();
    expect(sessionStorage.getItem("activeTab")).toBeNull();
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(payload);
});

test("returns the durable workspace when a legacy-key removal fails and retries later", () => {
    sessionStorage.clear();
    const valid = { ...legacyTab, value: crypto.randomUUID() };
    sessionStorage.setItem("tabs", JSON.stringify([valid]));
    sessionStorage.setItem("activeTab", JSON.stringify(valid.value));
    const deny = denyStorageRemoval("tabs");

    const workspace = loadStoredWorkspace();

    expect(workspace.tabs).toEqual([valid]);
    expect(readStoredWorkspace()).toEqual(workspace);
    expect(sessionStorage.getItem("tabs")).not.toBeNull();
    expect(sessionStorage.getItem("activeTab")).toBeNull();
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    deny.mockRestore();
    expect(loadStoredWorkspace()).toEqual(workspace);
    expect(sessionStorage.getItem("tabs")).toBeNull();
});

test("corrupt workspace storage recovers to a valid single-tab envelope", () => {
    sessionStorage.clear();
    sessionStorage.setItem("workspace", "{broken");
    const clone = vi.spyOn(tabStorage, "clone");
    const workspace = loadStoredWorkspace();

    expect(workspace.tabs).toHaveLength(1);
    expect(workspace.activeTab).toBe(workspace.tabs[0].value);
    expect(readStoredWorkspace()).toMatchObject({
        version: 1,
    });
    expect(clone).not.toHaveBeenCalled();
});

test("salvages valid version-0 tabs while retaining a dirty tree from a malformed row", () => {
    sessionStorage.clear();
    const validTab = { ...legacyTab, value: crypto.randomUUID() };
    const dirtyTree = defaultTree();
    dirtyTree.dirty = true;
    dirtyTree.headers.event = "Recoverable edits";
    const storedTree = serializeStorageValue({ version: 0, state: dirtyTree });
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({
            version: LEGACY_WORKSPACE_VERSION,
            tabs: [validTab, { value: "orphan-tree", name: 42 }],
            activeTab: "orphan-tree",
        }),
    );
    sessionStorage.setItem("orphan-tree", storedTree);

    const workspace = loadStoredWorkspace();

    expect(workspace.tabs).toEqual([validTab]);
    expect(workspace.activeTab).toBe(validTab.value);
    expect(workspace.treeOwnershipUncertain).toBe(true);
    expect(workspace.treeOwnershipProtectedIds).toContain("orphan-tree");
    expect(tabStorage.read("orphan-tree")?.state).toMatchObject({
        dirty: true,
        headers: { event: "Recoverable edits" },
    });
    expect(sessionStorage.getItem("orphan-tree")).not.toBeNull();
    expect(readStoredWorkspace()).toEqual(workspace);
});

test.each([LEGACY_WORKSPACE_VERSION, undefined])(
    "treats a fully valid legacy envelope with version %s as authority for orphan cleanup",
    (version) => {
        sessionStorage.clear();
        const validTab = { ...legacyTab, value: crypto.randomUUID() };
        const { treeId } = storeUnownedDirtyTree();
        sessionStorage.setItem(
            WORKSPACE_STORAGE_KEY,
            serializeStorageValue({
                version,
                tabs: [validTab],
                activeTab: validTab.value,
            }),
        );

        const workspace = loadStoredWorkspace();

        expect(workspace.tabs).toEqual([validTab]);
        expect(workspace).not.toHaveProperty("treeOwnershipUncertain");
        expect(sessionStorage.getItem(treeId)).toBeNull();
    },
);

test.each([true, false, undefined])(
    "legacy repair preserves unowned trees only for an explicit true uncertainty marker (%s)",
    (marker) => {
        sessionStorage.clear();
        const validTab = { ...legacyTab, value: crypto.randomUUID() };
        const { treeId, storedTree } = storeUnownedDirtyTree();
        sessionStorage.setItem(
            WORKSPACE_STORAGE_KEY,
            serializeStorageValue({
                version: LEGACY_WORKSPACE_VERSION,
                tabs: [validTab],
                activeTab: 42,
                treeOwnershipUncertain: marker,
            }),
        );

        const workspace = loadStoredWorkspace();

        expect(workspace.tabs).toEqual([validTab]);
        expect(workspace.activeTab).toBe(validTab.value);
        expect(workspace.treeOwnershipUncertain).toBe(marker === true ? true : undefined);
        expect(sessionStorage.getItem(treeId)).toBe(marker === true ? storedTree : null);
    },
);

test("uncertain migration reclaims only sources whose own clone is durable", () => {
    sessionStorage.clear();
    const goodSource = "legacy-good-source";
    const missingSource = "legacy-missing-source";
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    sessionStorage.setItem(goodSource, tree);
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({
            version: 2,
            tabs: [
                { ...legacyTab, value: goodSource },
                { ...legacyTab, value: missingSource },
            ],
            activeTab: goodSource,
        }),
    );

    const workspace = loadStoredWorkspace();

    expect(workspace.treeOwnershipUncertain).toBe(true);
    expect(tabStorage.read(workspace.tabs[0]!.value)).not.toBeNull();
    expect(tabStorage.read(workspace.tabs[1]!.value)).toBeNull();
    expect(sessionStorage.getItem(goodSource)).toBeNull();
});

test("failed duplicate clone keeps the unrepaired workspace and source owner", () => {
    sessionStorage.clear();
    const sourceId = "legacy-shared-source";
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    sessionStorage.setItem(sourceId, tree);
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({
            version: 2,
            tabs: [
                { ...legacyTab, value: sourceId },
                { ...legacyTab, value: sourceId },
            ],
            activeTab: sourceId,
        }),
    );
    const originalClone = tabStorage.clone.bind(tabStorage);
    let cloneCount = 0;
    const clone = vi.spyOn(tabStorage, "clone").mockImplementation((source, target) => {
        if (++cloneCount === 1) return originalClone(source, target);
        return { kind: "copy-failed", error: new Error("destination copy refused") };
    });

    const workspace = loadStoredWorkspace();

    clone.mockRestore();
    expect(workspace.treeOwnershipUncertain).toBe(true);
    expect(workspace.tabs.map((tab) => tab.value)).toEqual([sourceId, sourceId]);
    expect(tabStorage.read(sourceId)).not.toBeNull();
    expect(tabStorage.isStoredTree(sourceId)).toBe(true);
    expect(workspace.treeOwnershipProtectedIds).toContain(sourceId);
});

test("reclaims a migrated source tree after its copy and uncertain envelope are durable", () => {
    sessionStorage.clear();
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, "{broken");
    sessionStorage.setItem("tabs", serializeStorageValue([legacyTab]));
    sessionStorage.setItem("activeTab", serializeStorageValue(legacyTab.value));
    const sourceTree = serializeStorageValue({ version: 0, state: defaultTree() });
    sessionStorage.setItem(legacyTab.value, sourceTree);
    const { treeId: recoverableId, storedTree: recoverableTree } = storeUnownedDirtyTree();

    const workspace = loadStoredWorkspace();

    expect(workspace.treeOwnershipUncertain).toBe(true);
    expect(workspace.tabs[0]!.value).not.toBe(legacyTab.value);
    expect(tabStorage.read(workspace.tabs[0]!.value)).not.toBeNull();
    expect(sessionStorage.getItem(legacyTab.value)).toBeNull();
    expect(workspace.treeOwnershipProtectedIds).not.toContain(legacyTab.value);
    expect(workspace.treeOwnershipProtectedIds).toContain(recoverableId);
    expect(sessionStorage.getItem(recoverableId)).toBe(recoverableTree);
});

test("repairing a legacy tab ID that collides with the database view preserves its session state", () => {
    sessionStorage.clear();
    const databaseView = JSON.stringify({
        state: { database: { activeTab: "games" } },
        version: 0,
    });
    sessionStorage.setItem("database-view", databaseView);
    sessionStorage.setItem(
        "tabs",
        serializeStorageValue([{ ...legacyTab, value: "database-view" }]),
    );
    sessionStorage.setItem("activeTab", serializeStorageValue("database-view"));

    const workspace = loadStoredWorkspace();

    expect(workspace.tabs[0]!.value).not.toBe("database-view");
    expect(sessionStorage.getItem("database-view")).toBe(databaseView);
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).not.toBeNull();
    expect(tabStorage.read(workspace.tabs[0]!.value)).toBeNull();
});

test("retries a failed migrated-source removal even when the ownership snapshot overflows", () => {
    sessionStorage.clear();
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, "{broken");
    sessionStorage.setItem("tabs", serializeStorageValue([legacyTab]));
    sessionStorage.setItem("activeTab", serializeStorageValue(legacyTab.value));
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    sessionStorage.setItem(legacyTab.value, tree);
    for (let index = 0; index < MAX_PROTECTED_TREE_KEYS; index++) {
        sessionStorage.setItem(`other-tree-${index}`, tree);
    }
    const deny = denyStorageRemoval(legacyTab.value);

    const first = loadStoredWorkspace();

    expect(first.treeOwnershipUncertain).toBe(true);
    expect(first).not.toHaveProperty("treeOwnershipProtectedIds");
    expect(first.treeOwnershipPendingRemovalIds).toContain(legacyTab.value);
    expect(sessionStorage.getItem(legacyTab.value)).not.toBeNull();
    deny.mockRestore();

    const second = loadStoredWorkspace();
    expect(sessionStorage.getItem(legacyTab.value)).toBeNull();
    expect(second.treeOwnershipPendingRemovalIds).toContain(legacyTab.value);
    expect(loadStoredWorkspace()).not.toHaveProperty("treeOwnershipPendingRemovalIds");
});

function prepareMigrationOverflow(failPublish: boolean) {
    sessionStorage.clear();
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    const pendingIds = Array.from(
        { length: MAX_PENDING_TREE_REMOVALS },
        (_, index) => `pending-tree-${index}`,
    );
    for (const id of pendingIds) sessionStorage.setItem(id, tree);
    sessionStorage.setItem(legacyTab.value, tree);
    const originalEnvelope = serializeStorageValue({
        version: 1,
        tabs: [legacyTab],
        activeTab: legacyTab.value,
        treeOwnershipPendingRemovalIds: pendingIds,
    });
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, originalEnvelope);
    const deny = denyStorageRemoval(
        (id) => id.startsWith("pending-tree-") || id === legacyTab.value,
    );
    if (failPublish) {
        const write = Storage.prototype.setItem;
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(
            function (this: Storage, key, value) {
                if (key === WORKSPACE_STORAGE_KEY)
                    throw new DOMException("quota", "QuotaExceededError");
                write.call(this, key, value);
            },
        );
    }
    const overflowMessage = treeOverflowMessage;
    const reportedWorkspaceBytes: Array<string | null> = [];
    persistError.reportPersistError.mockImplementation((error: Error) => {
        if (error.message === overflowMessage)
            reportedWorkspaceBytes.push(sessionStorage.getItem(WORKSPACE_STORAGE_KEY));
    });
    return { tree, pendingIds, originalEnvelope, deny, overflowMessage, reportedWorkspaceBytes };
}

test("legacy ID migration publishes the newest 100 intents before reporting overflow", () => {
    const { tree, pendingIds, deny, overflowMessage, reportedWorkspaceBytes } =
        prepareMigrationOverflow(false);
    const first = loadStoredWorkspace();
    const overflow = persistError.reportPersistError.mock.calls
        .map(([error]) => error)
        .filter((error) => error.message === overflowMessage);

    expect(first.tabs[0]!.value).not.toBe(legacyTab.value);
    expect(first.treeOwnershipPendingRemovalIds).toEqual([...pendingIds.slice(1), legacyTab.value]);
    expect(readStoredWorkspaceValue(sessionStorage, WORKSPACE_STORAGE_KEY)).toEqual(first);
    expect(overflow).toHaveLength(1);
    expect(overflow[0].message).toBe(treeOverflowMessage);
    expect(enUSCatalogue.translation["Common.PendingTreeRemovalOverflow"]).toBe(
        treeOverflowMessage,
    );
    expect(errorUnlessCancelled(overflow[0])).toEqual({
        category: "unexpected",
        message: overflowMessage,
    });
    expect(overflow[0].cause.message).toBe("Pending tree removals exceeded 100; dropped 1");
    expect(reportedWorkspaceBytes).toEqual([sessionStorage.getItem(WORKSPACE_STORAGE_KEY)]);
    expect(deserializeStorageValue(reportedWorkspaceBytes[0]!)).toMatchObject({
        treeOwnershipPendingRemovalIds: [...pendingIds.slice(1), legacyTab.value],
    });
    expect(sessionStorage.getItem(pendingIds[0]!)).toBe(tree);
    expect(sessionStorage.getItem(legacyTab.value)).not.toBeNull();
    deny.mockRestore();
    vi.restoreAllMocks();
    persistError.reportPersistError.mockReset();

    const repaired = loadStoredWorkspace();
    expect(repaired.tabs[0]!.value).not.toBe(legacyTab.value);
    expect(sessionStorage.getItem(pendingIds[0]!)).toBeNull();
    expect(sessionStorage.getItem(legacyTab.value)).toBeNull();
    expect(loadStoredWorkspace().treeOwnershipPendingRemovalIds).toBeUndefined();
});

test("legacy ID migration preserves its envelope and reports no overflow when publication fails", () => {
    const { tree, pendingIds, originalEnvelope, deny, overflowMessage, reportedWorkspaceBytes } =
        prepareMigrationOverflow(true);
    const first = loadStoredWorkspace();

    expect(first.tabs).toEqual([legacyTab]);
    expect(first.treeOwnershipPendingRemovalIds).toEqual(pendingIds);
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(originalEnvelope);
    expect(persistError.reportPersistError).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: overflowMessage }),
    );
    expect(enUSCatalogue.translation["Common.PendingTreeRemovalOverflow"]).toBe(
        treeOverflowMessage,
    );
    expect(reportedWorkspaceBytes).toEqual([]);
    expect(sessionStorage.getItem(pendingIds[0]!)).toBe(tree);
    expect(sessionStorage.getItem(legacyTab.value)).not.toBeNull();
    deny.mockRestore();
    vi.restoreAllMocks();
    persistError.reportPersistError.mockReset();

    const repaired = loadStoredWorkspace();
    expect(repaired.tabs[0]!.value).not.toBe(legacyTab.value);
    expect(sessionStorage.getItem(pendingIds[0]!)).toBeNull();
    expect(sessionStorage.getItem(legacyTab.value)).toBeNull();
    expect(loadStoredWorkspace().treeOwnershipPendingRemovalIds).toBeUndefined();
});

test("pending-removal overflow reports the count after partial cleanup", () => {
    sessionStorage.clear();
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    const priorIds = Array.from(
        { length: MAX_PENDING_TREE_REMOVALS },
        (_, index) => `pending-tree-${index}`,
    );
    for (const id of priorIds) sessionStorage.setItem(id, tree);
    const deny = denyStorageRemoval((id) => id.startsWith("pending-tree-") && id !== priorIds[0]);

    const result = reconcilePendingTreeRemovals(
        priorIds,
        ["new-tree-1", "new-tree-2", "new-tree-3"],
        new Set(),
    );

    deny.mockRestore();
    expect(result).toEqual({
        ids: [...priorIds.slice(3), "new-tree-1", "new-tree-2", "new-tree-3"],
        droppedIds: priorIds.slice(1, 3),
        unreadableIds: new Set(),
    });
    expect(sessionStorage.getItem(priorIds[0]!)).toBeNull();
    expect(sessionStorage.getItem(priorIds[1]!)).toBe(tree);
});

test("pending-removal capacity errors have a localized user message and exact cause", () => {
    const translate = vi.spyOn(i18n, "t");
    const error = pendingTreeRemovalCapacityError(1);

    expect(translate).toHaveBeenCalledExactlyOnceWith("Common.PendingTreeRemovalOverflow");
    expect(error.message).toBe(treeOverflowMessage);
    expect(enUSCatalogue.translation["Common.PendingTreeRemovalOverflow"]).toBe(
        treeOverflowMessage,
    );
    expect(error.message).not.toBe("");
    expect((error.cause as Error).message).toBe(
        `Pending tree removals exceeded ${MAX_PENDING_TREE_REMOVALS}; dropped 1`,
    );
});

test("pending-removal reconciliation excludes retained IDs and leaves an exact-capacity queue intact", () => {
    sessionStorage.clear();
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    const priorIds = Array.from(
        { length: MAX_PENDING_TREE_REMOVALS },
        (_, index) => `pending-boundary-${index}`,
    );
    for (const id of priorIds) sessionStorage.setItem(id, tree);
    const retainedId = crypto.randomUUID();
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");

    const result = reconcilePendingTreeRemovals(priorIds, [retainedId], new Set([retainedId]));

    expect(result).toEqual({ ids: priorIds, droppedIds: [], unreadableIds: new Set() });
    expect(removeItem).not.toHaveBeenCalled();
    removeItem.mockRestore();
});

test("pending-removal reconciliation excludes retained prior IDs and keeps other stored trees", () => {
    sessionStorage.clear();
    const retainedId = crypto.randomUUID();
    const pendingId = crypto.randomUUID();
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    for (const id of [retainedId, pendingId]) sessionStorage.setItem(id, tree);

    const result = reconcilePendingTreeRemovals([retainedId, pendingId], [], new Set([retainedId]));

    expect(result).toEqual({ ids: [pendingId], droppedIds: [], unreadableIds: new Set() });
    expect(sessionStorage.getItem(retainedId)).toBe(tree);
    expect(sessionStorage.getItem(pendingId)).toBe(tree);
});

test("pending-removal reconciliation reports the first unreadable error and retains both IDs", () => {
    sessionStorage.clear();
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    for (const id of ids) sessionStorage.setItem(id, tree);
    const firstError = new DOMException("first pending read refused", "SecurityError");
    const secondError = new DOMException("second pending read refused", "SecurityError");
    const originalGetItem = Storage.prototype.getItem;
    const read = vi
        .spyOn(Storage.prototype, "getItem")
        .mockImplementation(function (this: Storage, key) {
            if (key === ids[0]) throw firstError;
            if (key === ids[1]) throw secondError;
            return originalGetItem.call(this, key);
        });

    const result = reconcilePendingTreeRemovals(ids, [], new Set());

    expect(result).toEqual({ ids, droppedIds: [], unreadableIds: new Set(ids) });
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    expect(persistError.reportPersistError.mock.calls[0][0]).toBe(firstError);
    expect(persistError.reportPersistError.mock.calls[0][0].message).toBe(
        "first pending read refused",
    );
    read.mockRestore();
    for (const id of ids) expect(sessionStorage.getItem(id)).toBe(tree);
});

test("pending-removal reconciliation accepts exact capacity after one successful retry", () => {
    sessionStorage.clear();
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    const priorIds = Array.from(
        { length: MAX_PENDING_TREE_REMOVALS },
        (_, index) => `pending-retry-${index}`,
    );
    for (const id of priorIds) sessionStorage.setItem(id, tree);
    const deny = denyStorageRemoval((id) => id.startsWith("pending-retry-") && id !== priorIds[0]);

    const result = reconcilePendingTreeRemovals(priorIds, ["new-tree"], new Set());

    deny.mockRestore();
    expect(result).toEqual({
        ids: [...priorIds.slice(1), "new-tree"],
        droppedIds: [],
        unreadableIds: new Set(),
    });
    expect(sessionStorage.getItem(priorIds[0]!)).toBeNull();
});

test.each(["present undecodable", "read throws", "removal throws"] as const)(
    "over-cap retry retains an attempted key when %s instead of confirming absence",
    (failure) => {
        sessionStorage.clear();
        const ids = Array.from({ length: 100 }, (_, index) => `confirmed-absence-${index}`);
        const target = ids[99]!;
        const tree = serializeStorageValue({ version: 1, state: defaultTree() });
        for (const id of ids) sessionStorage.setItem(id, tree);
        const remove = Storage.prototype.removeItem;
        let attempted = false;
        vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key) {
            if (!ids.includes(key)) return remove.call(this, key);
            if (key !== target) return;
            attempted = true;
            if (failure === "present undecodable") sessionStorage.setItem(key, "not a tree");
            else remove.call(this, key);
            if (failure === "removal throws") throw new Error("removal failed after deletion");
        });
        const read = Storage.prototype.getItem;
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
            if (attempted && key === target && failure === "read throws")
                throw new Error("follow-up read failed");
            return read.call(this, key);
        });

        expect(reconcilePendingTreeRemovals(ids, ["new-tree"], new Set())).toEqual({
            ids: [...ids.slice(1), "new-tree"],
            droppedIds: [ids[0]],
            unreadableIds: new Set(),
        });
        expect(attempted).toBe(true);
    },
);

test("does not delete a non-tree session value named by a persisted retry", () => {
    sessionStorage.clear();
    const validTab = { ...legacyTab, value: crypto.randomUUID() };
    sessionStorage.setItem("other-session-value", "keep me");
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({
            version: 1,
            tabs: [validTab],
            activeTab: validTab.value,
            treeOwnershipPendingRemovalIds: ["other-session-value"],
        }),
    );

    const workspace = loadStoredWorkspace();

    expect(sessionStorage.getItem("other-session-value")).toBe("keep me");
    expect(workspace).not.toHaveProperty("treeOwnershipPendingRemovalIds");
});

test("prunes a persisted pending-removal UUID whose key is absent", () => {
    sessionStorage.clear();
    const retained = { ...legacyTab, value: crypto.randomUUID() };
    const absentId = crypto.randomUUID();
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({
            version: 1,
            tabs: [retained],
            activeTab: retained.value,
            treeOwnershipPendingRemovalIds: [absentId],
        }),
    );

    const workspace = loadStoredWorkspace();

    expect(sessionStorage.getItem(absentId)).toBeNull();
    expect(workspace).not.toHaveProperty("treeOwnershipPendingRemovalIds");
    expect(readStoredWorkspace()).not.toHaveProperty("treeOwnershipPendingRemovalIds");
});

test("fails closed when the protected tree snapshot exceeds its documented bound", () => {
    sessionStorage.clear();
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, "{broken");
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    const treeIds = Array.from(
        { length: MAX_PROTECTED_TREE_KEYS + 1 },
        (_, index) => `tree-${index}`,
    );
    for (const treeId of treeIds) sessionStorage.setItem(treeId, tree);

    const workspace = loadStoredWorkspace();

    expect(workspace.treeOwnershipUncertain).toBe(true);
    expect(workspace).not.toHaveProperty("treeOwnershipProtectedIds");
    expect(sessionStorage.getItem(treeIds[0]!)).toBe(tree);
    expect(sessionStorage.getItem(treeIds.at(-1)!)).toBe(tree);
    expect(readStoredWorkspace()).toMatchObject({ treeOwnershipUncertain: true });
    expect(loadStoredWorkspace().treeOwnershipUncertain).toBe(true);
    expect(sessionStorage.getItem(treeIds[0]!)).toBe(tree);
});

test("protects exactly the documented number of stored trees under a broken envelope", () => {
    sessionStorage.clear();
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, "{broken");
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    const treeIds = Array.from({ length: MAX_PROTECTED_TREE_KEYS }, (_, index) => `tree-${index}`);
    for (const treeId of treeIds) sessionStorage.setItem(treeId, tree);

    const workspace = loadStoredWorkspace();

    expect(workspace.treeOwnershipUncertain).toBe(true);
    expect(workspace.treeOwnershipProtectedIds).toEqual(treeIds);
});

test("a present pending tree counts toward the ownership snapshot capacity", () => {
    sessionStorage.clear();
    const pendingId = crypto.randomUUID();
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    const treeIds = Array.from({ length: MAX_PROTECTED_TREE_KEYS }, (_, index) => `tree-${index}`);
    for (const treeId of treeIds) sessionStorage.setItem(treeId, tree);
    sessionStorage.setItem(pendingId, tree);
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({
            ...defaultWorkspace(),
            treeOwnershipUncertain: true,
            treeOwnershipPendingRemovalIds: [pendingId],
        }),
    );

    const workspace = loadStoredWorkspace();

    expect(workspace.treeOwnershipUncertain).toBe(true);
    expect(workspace).not.toHaveProperty("treeOwnershipProtectedIds");
    for (const treeId of treeIds) expect(sessionStorage.getItem(treeId)).toBe(tree);
});

test.each([
    { pendingIdLength: MAX_PROTECTED_TREE_KEY_LENGTH + 1, protectedIds: undefined },
    { pendingIdLength: MAX_PROTECTED_TREE_KEY_LENGTH, protectedIds: ["normal-tree"] },
])(
    "ownership snapshots enforce the pending-id length bound at $pendingIdLength characters",
    ({ pendingIdLength, protectedIds }) => {
        sessionStorage.clear();
        const pendingId = "p".repeat(pendingIdLength);
        const tree = serializeStorageValue({ version: 1, state: defaultTree() });
        sessionStorage.setItem("normal-tree", tree);
        sessionStorage.setItem(pendingId, tree);
        sessionStorage.setItem(
            WORKSPACE_STORAGE_KEY,
            serializeStorageValue({
                ...defaultWorkspace(),
                treeOwnershipUncertain: true,
                treeOwnershipPendingRemovalIds: [pendingId],
            }),
        );

        const workspace = loadStoredWorkspace();

        expect(workspace.treeOwnershipUncertain).toBe(true);
        expect(workspace.treeOwnershipProtectedIds).toEqual(protectedIds);
        expect(Object.hasOwn(workspace, "treeOwnershipProtectedIds")).toBe(
            protectedIds !== undefined,
        );
        expect(sessionStorage.getItem("normal-tree")).toBe(tree);
    },
);

test("keeps a successful snapshot when the workspace storage has no key function", () => {
    sessionStorage.clear();
    const { treeId, storedTree } = storeUnownedDirtyTree();
    const storage = {
        getItem: sessionStorage.getItem.bind(sessionStorage),
        setItem: sessionStorage.setItem.bind(sessionStorage),
        removeItem: sessionStorage.removeItem.bind(sessionStorage),
        get length() {
            return sessionStorage.length;
        },
    };

    const workspace = loadWorkspace(storage, WORKSPACE_STORAGE_KEY);

    expect(workspace.treeOwnershipUncertain).toBe(true);
    expect(workspace.treeOwnershipProtectedIds).toEqual([treeId]);
    expect(sessionStorage.getItem(treeId)).toBe(storedTree);
});

test("the ownership walk reports its own enumeration failure and drops a successful snapshot", () => {
    sessionStorage.clear();
    const { treeId, storedTree } = storeUnownedDirtyTree();
    const scanError = new DOMException("ownership walk denied", "SecurityError");
    const storage = {
        getItem: sessionStorage.getItem.bind(sessionStorage),
        setItem: sessionStorage.setItem.bind(sessionStorage),
        removeItem: sessionStorage.removeItem.bind(sessionStorage),
        get length() {
            return sessionStorage.length;
        },
        key() {
            throw scanError;
        },
    };

    const workspace = loadWorkspace(storage, WORKSPACE_STORAGE_KEY);

    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    expect(persistError.reportPersistError).toHaveBeenCalledWith(scanError);
    expect(workspace.treeOwnershipUncertain).toBe(true);
    expect(workspace).not.toHaveProperty("treeOwnershipProtectedIds");
    expect(sessionStorage.getItem(treeId)).toBe(storedTree);
});

test("an empty ownership walk does not count a pending ID beyond its length", () => {
    sessionStorage.clear();
    const pendingId = crypto.randomUUID();
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    const treeIds = Array.from({ length: MAX_PROTECTED_TREE_KEYS }, (_, index) => `tree-${index}`);
    for (const treeId of treeIds) sessionStorage.setItem(treeId, tree);
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({
            ...defaultWorkspace(),
            treeOwnershipUncertain: true,
            treeOwnershipPendingRemovalIds: [pendingId],
        }),
    );
    const storage = {
        getItem: sessionStorage.getItem.bind(sessionStorage),
        setItem: sessionStorage.setItem.bind(sessionStorage),
        removeItem: sessionStorage.removeItem.bind(sessionStorage),
        length: 0,
        key: vi.fn((_index: number) => pendingId),
    };

    const workspace = loadWorkspace(storage, WORKSPACE_STORAGE_KEY);

    expect(storage.key).not.toHaveBeenCalled();
    expect(workspace.treeOwnershipUncertain).toBe(true);
    expect(workspace.treeOwnershipProtectedIds).toEqual(treeIds);
});

test("fails closed when a protected tree key exceeds the length bound", () => {
    sessionStorage.clear();
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, "{broken");
    const longId = "x".repeat(MAX_PROTECTED_TREE_KEY_LENGTH + 1);
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    sessionStorage.setItem(longId, tree);

    const workspace = loadStoredWorkspace();

    expect(workspace.treeOwnershipUncertain).toBe(true);
    expect(workspace).not.toHaveProperty("treeOwnershipProtectedIds");
    expect(sessionStorage.getItem(longId)).toBe(tree);
    expect(readStoredWorkspace()).toMatchObject({ treeOwnershipUncertain: true });
    expect(loadStoredWorkspace().treeOwnershipUncertain).toBe(true);
    expect(sessionStorage.getItem(longId)).toBe(tree);
});

test("fails closed when stored tree enumeration throws", () => {
    sessionStorage.clear();
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, "{broken");
    const { treeId, storedTree } = storeUnownedDirtyTree();
    const scanError = new DOMException("denied", "SecurityError");
    const key = vi.spyOn(Storage.prototype, "key").mockImplementation(() => {
        throw scanError;
    });

    const workspace = loadStoredWorkspace();

    key.mockRestore();
    expect(workspace.treeOwnershipUncertain).toBe(true);
    expect(workspace).not.toHaveProperty("treeOwnershipProtectedIds");
    expect(sessionStorage.getItem(treeId)).toBe(storedTree);
    expect(persistError.reportPersistError).toHaveBeenCalledWith(scanError);
    expect(readStoredWorkspace()).toMatchObject({ treeOwnershipUncertain: true });
    expect(loadStoredWorkspace().treeOwnershipUncertain).toBe(true);
    expect(sessionStorage.getItem(treeId)).toBe(storedTree);
});

test("keeps a valid current active ID, repairs stale IDs, and never scrubs retained trees", () => {
    sessionStorage.clear();
    const first = { ...legacyTab, value: crypto.randomUUID() };
    const second = { ...legacyTab, name: "Second", value: crypto.randomUUID() };
    sessionStorage.setItem(
        first.value,
        serializeStorageValue({ version: 0, state: defaultTree() }),
    );
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        JSON.stringify({ version: 1, tabs: [first, second], activeTab: second.value }),
    );

    const workspace = loadStoredWorkspace();
    expect(workspace.activeTab).toBe(second.value);
    expect(sessionStorage.getItem(first.value)).not.toBeNull();

    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        JSON.stringify({ version: 1, tabs: [first, second], activeTab: "missing" }),
    );
    expect(loadStoredWorkspace().activeTab).toBe(first.value);
});

test("duplicate UUID migration retains the original tree and creates a copied tree", () => {
    sessionStorage.clear();
    const duplicate = { ...legacyTab, value: crypto.randomUUID() };
    sessionStorage.setItem(
        duplicate.value,
        serializeStorageValue({ version: 0, state: defaultTree() }),
    );
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        JSON.stringify({ version: 1, tabs: [duplicate, duplicate], activeTab: duplicate.value }),
    );

    const workspace = loadStoredWorkspace();
    expect(workspace.tabs).toHaveLength(2);
    expect(workspace.tabs[0].value).toBe(duplicate.value);
    expect(sessionStorage.getItem(duplicate.value)).not.toBeNull();
    expect(tabStorage.read(workspace.tabs[1].value)).not.toBeNull();
});

test("retains a shared source when one duplicate migration clone is absent", () => {
    sessionStorage.clear();
    const sourceId = "legacy-shared-source";
    const sourceTree = serializeStorageValue({ version: 1, state: defaultTree() });
    sessionStorage.setItem(sourceId, sourceTree);
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({
            version: 2,
            tabs: [
                { ...legacyTab, value: sourceId },
                { ...legacyTab, value: sourceId },
            ],
            activeTab: sourceId,
        }),
    );
    const originalClone = tabStorage.clone.bind(tabStorage);
    const cloneTargets: string[] = [];
    const clone = vi.spyOn(tabStorage, "clone").mockImplementation((source, target) => {
        cloneTargets.push(target);
        return cloneTargets.length === 1 ? originalClone(source, target) : { kind: "absent" };
    });

    const workspace = loadStoredWorkspace();

    clone.mockRestore();
    expect(cloneTargets).toHaveLength(2);
    expect(workspace.tabs.map((tab) => tab.value)).toEqual(cloneTargets);
    expect(tabStorage.read(cloneTargets[0]!)).not.toBeNull();
    expect(sessionStorage.getItem(cloneTargets[1]!)).toBeNull();
    expect(tabStorage.read(sourceId)?.state).toMatchObject({ root: defaultTree().root });
    expect(workspace.treeOwnershipProtectedIds).toContain(sourceId);
    expect(readStoredWorkspace()).toEqual(workspace);
});

test("keeps the legacy owner when a readable clone fails verification", () => {
    sessionStorage.clear();
    const sourceTree = serializeStorageValue({ version: 0, state: defaultTree() });
    sessionStorage.setItem("tabs", serializeStorageValue([legacyTab]));
    sessionStorage.setItem("activeTab", serializeStorageValue(legacyTab.value));
    sessionStorage.setItem(legacyTab.value, sourceTree);

    const verificationError = new Error("Could not read the durable clone back.");
    const originalClone = tabStorage.clone.bind(tabStorage);
    const originalReadTree = tabStorage.readTree.bind(tabStorage);
    const originalSetItem = Storage.prototype.setItem;
    let targetId: string | undefined;
    let targetWritten = false;
    const clone = vi.spyOn(tabStorage, "clone").mockImplementation((source, target) => {
        targetId = target;
        return originalClone(source, target);
    });
    const readTree = vi.spyOn(tabStorage, "readTree").mockImplementation((tabId) => {
        if (tabId === targetId && targetWritten) {
            return { kind: "unavailable", error: verificationError };
        }
        return originalReadTree(tabId);
    });
    const setItem = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
            originalSetItem.call(this, key, value);
            if (key === targetId) targetWritten = true;
        });

    const workspace = (() => {
        try {
            return loadStoredWorkspace();
        } finally {
            setItem.mockRestore();
            readTree.mockRestore();
            clone.mockRestore();
        }
    })();

    expect(workspace.tabs).toEqual([legacyTab]);
    expect(workspace.activeTab).toBe(legacyTab.value);
    expect(targetId).toBeDefined();
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
    expect(tabStorage.read(legacyTab.value)?.state).toMatchObject({ root: defaultTree().root });
    expect(sessionStorage.getItem(targetId!)).toBeNull();
    expect(persistError.reportPersistError).toHaveBeenCalledWith(verificationError);
});

test.each([
    { scenario: "absent", readback: { kind: "absent" as const } },
    {
        scenario: "unreadable",
        readback: { kind: "unreadable" as const, rawValue: "unreadable clone bytes" },
    },
])(
    "reports synthesized verification failure and rolls back a readable clone with $scenario readback",
    ({ readback }) => {
        sessionStorage.clear();
        const sourceTree = serializeStorageValue({ version: 0, state: defaultTree() });
        sessionStorage.setItem("tabs", serializeStorageValue([legacyTab]));
        sessionStorage.setItem("activeTab", serializeStorageValue(legacyTab.value));
        sessionStorage.setItem(legacyTab.value, sourceTree);

        const originalClone = tabStorage.clone.bind(tabStorage);
        const originalReadTree = tabStorage.readTree.bind(tabStorage);
        const originalSetItem = Storage.prototype.setItem;
        let targetId: string | undefined;
        let targetWritten = false;
        const clone = vi.spyOn(tabStorage, "clone").mockImplementation((source, target) => {
            targetId = target;
            return originalClone(source, target);
        });
        const readTree = vi.spyOn(tabStorage, "readTree").mockImplementation((tabId) => {
            if (tabId === targetId && targetWritten) return readback;
            return originalReadTree(tabId);
        });
        const setItem = vi
            .spyOn(Storage.prototype, "setItem")
            .mockImplementation(function (this: Storage, key, value) {
                originalSetItem.call(this, key, value);
                if (key === targetId) targetWritten = true;
            });

        let workspace: ReturnType<typeof loadWorkspace>;
        try {
            workspace = loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY);
        } finally {
            setItem.mockRestore();
            readTree.mockRestore();
            clone.mockRestore();
        }

        expect(targetId).toBeDefined();
        expect(targetWritten).toBe(true);
        expect(workspace!.tabs).toEqual([legacyTab]);
        expect(workspace!.activeTab).toBe(legacyTab.value);
        expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
        expect(sessionStorage.getItem("tabs")).not.toBeNull();
        expect(sessionStorage.getItem("activeTab")).not.toBeNull();
        expect(tabStorage.read(legacyTab.value)?.state).toMatchObject({ root: defaultTree().root });
        expect(sessionStorage.getItem(targetId!)).toBeNull();
        expect(persistError.reportPersistError).toHaveBeenCalledOnce();
        expect(persistError.reportPersistError).toHaveBeenCalledWith(
            expect.objectContaining({
                message: `Could not verify the migrated tree at ${targetId}.`,
            }),
        );
    },
);

test("legacy ID repair reclaims unreadable bytes after publishing the verified copy", () => {
    sessionStorage.clear();
    const raw = "legacy tree bytes that cannot be decoded";
    sessionStorage.setItem("tabs", serializeStorageValue([legacyTab]));
    sessionStorage.setItem("activeTab", serializeStorageValue(legacyTab.value));
    sessionStorage.setItem(legacyTab.value, raw);

    const events: string[] = [];
    let sourceBytesBeforeCleanup: string | null = null;
    let metadataBeforeCleanup: string | null = null;
    const originalSetItem = Storage.prototype.setItem;
    const originalRemoveItem = Storage.prototype.removeItem;
    const setItem = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
            originalSetItem.call(this, key, value);
            if (key === WORKSPACE_STORAGE_KEY) events.push("metadata-published");
        });
    const removeItem = vi
        .spyOn(Storage.prototype, "removeItem")
        .mockImplementation(function (this: Storage, key) {
            if (key === legacyTab.value) {
                events.push("source-cleanup");
                sourceBytesBeforeCleanup = this.getItem(key);
                metadataBeforeCleanup = this.getItem(WORKSPACE_STORAGE_KEY);
            }
            originalRemoveItem.call(this, key);
        });
    const workspace = (() => {
        try {
            return loadStoredWorkspace();
        } finally {
            removeItem.mockRestore();
            setItem.mockRestore();
        }
    })();
    const repairedId = workspace.tabs[0]!.value;

    expect(repairedId).not.toBe(legacyTab.value);
    expect(sessionStorage.getItem(repairedId)).toBe(raw);
    expect(sessionStorage.getItem(legacyTab.value)).toBeNull();
    expect(workspace.tabs[0]!.value).toBe(readStoredWorkspace().tabs[0]!.value);
    expect(tabStorage.getStatus(repairedId)).toEqual({ kind: "unreadable", rawValue: raw });
    expect(events).toEqual(["metadata-published", "source-cleanup"]);
    expect(sourceBytesBeforeCleanup).toBe(raw);
    expect(metadataBeforeCleanup).toBe(serializeStorageValue(workspace));
});

test("failed metadata publication preserves the old unreadable owner and rolls back its copy", () => {
    sessionStorage.clear();
    const raw = "legacy unreadable bytes";
    const publicationError = new DOMException("workspace write refused", "QuotaExceededError");
    sessionStorage.setItem("tabs", serializeStorageValue([legacyTab]));
    sessionStorage.setItem("activeTab", serializeStorageValue(legacyTab.value));
    sessionStorage.setItem(legacyTab.value, raw);
    const originalSetItem = Storage.prototype.setItem;
    const originalRemoveItem = Storage.prototype.removeItem;
    let sourceRemovalAttempts = 0;
    const setItem = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
            if (key === WORKSPACE_STORAGE_KEY) throw publicationError;
            return originalSetItem.call(this, key, value);
        });
    const removeItem = vi
        .spyOn(Storage.prototype, "removeItem")
        .mockImplementation(function (this: Storage, key) {
            if (key === legacyTab.value) sourceRemovalAttempts++;
            originalRemoveItem.call(this, key);
        });

    const workspace = (() => {
        try {
            return loadStoredWorkspace();
        } finally {
            removeItem.mockRestore();
            setItem.mockRestore();
        }
    })();
    expect(workspace.tabs).toEqual([legacyTab]);
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(legacyTab.value)).toBe(raw);
    expect(sourceRemovalAttempts).toBe(0);
    const copies = Array.from({ length: sessionStorage.length }, (_, index) =>
        sessionStorage.key(index),
    ).filter((key): key is string => key !== null && sessionStorage.getItem(key) === raw);
    expect(copies).toEqual([legacyTab.value]);
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    expect(persistError.reportPersistError).toHaveBeenCalledWith(
        expect.objectContaining({ cause: publicationError }),
    );
});

test("failed unreadable-copy cleanup reports once and keeps the original source", () => {
    sessionStorage.clear();
    const raw = "source tree cannot be decoded";
    const cleanupError = new DOMException("copy cleanup refused", "SecurityError");
    sessionStorage.setItem("tabs", serializeStorageValue([legacyTab]));
    sessionStorage.setItem("activeTab", serializeStorageValue(legacyTab.value));
    sessionStorage.setItem(legacyTab.value, raw);
    const originalGetItem = Storage.prototype.getItem;
    const originalSetItem = Storage.prototype.setItem;
    const originalRemoveItem = Storage.prototype.removeItem;
    let targetId: string | null = null;
    let targetWritten = false;
    let mismatchedReadReturned = false;
    const setItem = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
            if (
                key !== WORKSPACE_STORAGE_KEY &&
                key !== "tabs" &&
                key !== "activeTab" &&
                key !== legacyTab.value
            ) {
                targetId = key;
                originalSetItem.call(this, key, value);
                targetWritten = true;
                return;
            }
            originalSetItem.call(this, key, value);
        });
    const getItem = vi
        .spyOn(Storage.prototype, "getItem")
        .mockImplementation(function (this: Storage, key) {
            if (key === targetId && targetWritten && !mismatchedReadReturned) {
                mismatchedReadReturned = true;
                return "different bytes";
            }
            return originalGetItem.call(this, key);
        });
    const removeItem = vi
        .spyOn(Storage.prototype, "removeItem")
        .mockImplementation(function (this: Storage, key) {
            if (key === targetId) throw cleanupError;
            originalRemoveItem.call(this, key);
        });

    const workspace = loadStoredWorkspace();

    removeItem.mockRestore();
    getItem.mockRestore();
    setItem.mockRestore();
    expect(workspace.tabs).toEqual([legacyTab]);
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(legacyTab.value)).toBe(raw);
    expect(targetId).not.toBeNull();
    expect(sessionStorage.getItem(targetId!)).toBe(raw);
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
    expect(persistError.reportPersistError).toHaveBeenCalledWith(cleanupError);
});

test("duplicate UUID repair copies undecodable bytes to the repaired tab before publishing", () => {
    sessionStorage.clear();
    const duplicate = { ...legacyTab, value: crypto.randomUUID() };
    const raw = "duplicate tab tree bytes";
    sessionStorage.setItem(duplicate.value, raw);
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        JSON.stringify({ version: 1, tabs: [duplicate, duplicate], activeTab: duplicate.value }),
    );

    const workspace = loadStoredWorkspace();
    const repairedId = workspace.tabs[1]!.value;

    expect(repairedId).not.toBe(duplicate.value);
    expect(sessionStorage.getItem(duplicate.value)).toBe(raw);
    expect(sessionStorage.getItem(repairedId)).toBe(raw);
    expect(readStoredWorkspace().tabs[1]!.value).toBe(repairedId);
    expect(tabStorage.getStatus(repairedId)).toEqual({ kind: "unreadable", rawValue: raw });
});

test("source read refusal keeps legacy metadata and its original recovery owner", () => {
    sessionStorage.clear();
    const raw = "unreadable source bytes";
    sessionStorage.setItem("tabs", serializeStorageValue([legacyTab]));
    sessionStorage.setItem("activeTab", serializeStorageValue(legacyTab.value));
    sessionStorage.setItem(legacyTab.value, raw);
    const failure = new DOMException("source key refused a read", "SecurityError");
    const originalGetItem = Storage.prototype.getItem;
    const getItem = vi
        .spyOn(Storage.prototype, "getItem")
        .mockImplementation(function (this: Storage, key) {
            if (key === legacyTab.value) throw failure;
            return originalGetItem.call(this, key);
        });

    const workspace = loadStoredWorkspace();

    getItem.mockRestore();
    expect(workspace.tabs).toEqual([legacyTab]);
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem("tabs")).not.toBeNull();
    expect(sessionStorage.getItem(legacyTab.value)).toBe(raw);
    expect(tabStorage.getStatus(legacyTab.value)).toEqual({ kind: "unavailable", error: failure });
    expect(persistError.reportPersistError).toHaveBeenCalledWith(failure);
});

test("destination copy refusal keeps the unrepaired workspace and original unreadable bytes", () => {
    sessionStorage.clear();
    const raw = "source tree cannot be decoded";
    sessionStorage.setItem("tabs", serializeStorageValue([legacyTab]));
    sessionStorage.setItem("activeTab", serializeStorageValue(legacyTab.value));
    sessionStorage.setItem(legacyTab.value, raw);
    const failure = new DOMException("destination refused a write", "QuotaExceededError");
    const originalSetItem = Storage.prototype.setItem;
    let refusedTarget: string | undefined;
    const setItem = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
            if (key !== legacyTab.value && key !== "tabs" && key !== "activeTab") {
                refusedTarget = key;
                throw failure;
            }
            return originalSetItem.call(this, key, value);
        });

    const workspace = loadStoredWorkspace();

    setItem.mockRestore();
    expect(workspace.tabs).toEqual([legacyTab]);
    expect(refusedTarget).toBeDefined();
    expect(sessionStorage.getItem(refusedTarget!)).toBeNull();
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem("tabs")).not.toBeNull();
    expect(sessionStorage.getItem(legacyTab.value)).toBe(raw);
    expect(persistError.reportPersistError).toHaveBeenCalledWith(
        expect.objectContaining({ cause: failure }),
    );
});

test("bounds and scrubs malformed workspace shapes without throwing", () => {
    sessionStorage.clear();
    const clone = vi.spyOn(tabStorage, "clone");
    for (const raw of [
        null,
        [],
        "workspace",
        0,
        { tabs: null, activeTab: 1 },
        { tabs: [null], activeTab: null },
        { tabs: [], activeTab: "x".repeat(129) },
    ]) {
        sessionStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(raw));
        const workspace = loadStoredWorkspace();
        expect(workspace.tabs).toHaveLength(1);
        expect(workspace.activeTab).toBe(workspace.tabs[0].value);
    }

    const valid = { ...legacyTab, value: crypto.randomUUID() };
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        JSON.stringify({
            version: 1,
            tabs: [...Array(101).fill(valid)],
            activeTab: valid.value,
        }),
    );
    const bounded = loadStoredWorkspace();
    expect(bounded.tabs).toHaveLength(1);
    expect(bounded.activeTab).toBe(bounded.tabs[0].value);
    expect(clone).not.toHaveBeenCalled();
});

test("does not flush a workspace that needs no tab-ID migration", () => {
    sessionStorage.clear();
    const flush = vi.spyOn(tabStorage, "flush");
    const valid = { ...legacyTab, value: crypto.randomUUID() };
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        JSON.stringify({ version: 1, tabs: [valid], activeTab: valid.value }),
    );

    loadStoredWorkspace();
    expect(flush).not.toHaveBeenCalled();
    flush.mockRestore();
});

test("workspace JSON parsing and orphan-tree sweeping distinguish malformed values", () => {
    sessionStorage.clear();
    sessionStorage.setItem("valid", JSON.stringify({ ok: true }));
    sessionStorage.setItem("invalid", "{");
    expect(readStoredWorkspaceValue(sessionStorage, "missing")).toBeNull();
    expect(readStoredWorkspaceValue(sessionStorage, "valid")).toEqual({ ok: true });
    expect(readStoredWorkspaceValue(sessionStorage, "invalid")).toBeNull();

    const retained = { ...legacyTab, value: crypto.randomUUID() };
    const orphan = "orphan";
    const nonStringValue = 42;
    sessionStorage.setItem(retained.value, "retained");
    sessionStorage.setItem(orphan, serializeStorageValue({ version: 0, state: defaultTree() }));
    const unrelated = "not-a-tree";
    sessionStorage.setItem(unrelated, "orphan");
    sessionStorage.setItem(String(nonStringValue), "must-remain");
    sweepOrphanedTreeKeys([retained]);
    expect(sessionStorage.getItem(retained.value)).toBe("retained");
    expect(sessionStorage.getItem(orphan)).toBeNull();
    expect(sessionStorage.getItem(unrelated)).toBe("orphan");
    expect(sessionStorage.getItem(String(nonStringValue))).toBe("must-remain");
});

test("an empty protection list does not reserve a tree-shaped session key", () => {
    sessionStorage.clear();
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    sessionStorage.setItem("Stryker was here", tree);

    sweepOrphanedTreeKeys([]);

    expect(sessionStorage.getItem("Stryker was here")).toBeNull();
});

test("authoritative startup does not reserve an unrelated tree-shaped key", () => {
    sessionStorage.clear();
    const retained = { ...legacyTab, value: crypto.randomUUID() };
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({ version: 1, tabs: [retained], activeTab: retained.value }),
    );
    sessionStorage.setItem(
        "Stryker was here",
        serializeStorageValue({ version: 1, state: defaultTree() }),
    );

    loadStoredWorkspace();

    expect(sessionStorage.getItem("Stryker was here")).toBeNull();
});

test("a stored-key enumeration failure does not abort authoritative workspace loading", () => {
    sessionStorage.clear();
    const retained = { ...legacyTab, value: crypto.randomUUID() };
    sessionStorage.setItem(
        WORKSPACE_STORAGE_KEY,
        serializeStorageValue({ version: 1, tabs: [retained], activeTab: retained.value }),
    );
    const { treeId, storedTree } = storeUnownedDirtyTree();
    const scanError = new DOMException("denied", "SecurityError");
    const key = vi.spyOn(Storage.prototype, "key").mockImplementation(() => {
        throw scanError;
    });

    expect(loadStoredWorkspace().tabs).toEqual([retained]);

    key.mockRestore();
    expect(sessionStorage.getItem(treeId)).toBe(storedTree);
    expect(persistError.reportPersistError).toHaveBeenCalledWith(scanError);
});

test("orphan sweeping continues after a denied removal and reports once", () => {
    sessionStorage.clear();
    const tree = serializeStorageValue({ version: 1, state: defaultTree() });
    sessionStorage.setItem("orphan-one", tree);
    sessionStorage.setItem("orphan-two", tree);
    const remove = denyStorageRemoval("orphan-one");

    sweepOrphanedTreeKeys([]);

    remove.mockRestore();
    expect(sessionStorage.getItem("orphan-one")).toBe(tree);
    expect(sessionStorage.getItem("orphan-two")).toBeNull();
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
});

test("saveWorkspace preserves tab IDs so a failed load migration can retry", () => {
    sessionStorage.clear();
    saveWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY, {
        version: 1,
        tabs: [legacyTab],
        activeTab: legacyTab.value,
    });
    const stored = readStoredWorkspace() as { tabs: Array<{ value: string }>; activeTab: string };
    expect(stored.tabs[0].value).toBe(legacyTab.value);
    expect(stored.activeTab).toBe(legacyTab.value);

    sessionStorage.removeItem(WORKSPACE_STORAGE_KEY);
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
});

test("saveWorkspace reports storage write failures", () => {
    sessionStorage.clear();
    const writeError = new DOMException("denied", "SecurityError");
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
        throw writeError;
    });

    saveWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY, defaultWorkspace());

    expect(persistError.reportPersistError).toHaveBeenCalledWith(writeError);
    setItem.mockRestore();
});

test("saveWorkspace accepts a 128-character active ID and refuses a 129-character ID", () => {
    sessionStorage.clear();
    const tab = { ...legacyTab, value: "x".repeat(128) };
    const workspace = { version: 1 as const, tabs: [tab], activeTab: tab.value };

    expect(saveWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY, workspace)).toEqual(workspace);
    const storedAtBoundary = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
    expect(readStoredWorkspace()).toEqual(workspace);
    expect(persistError.reportPersistError).not.toHaveBeenCalled();

    expect(
        saveWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY, {
            ...workspace,
            activeTab: "x".repeat(129),
        }),
    ).toBeNull();
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(storedAtBoundary);
    expect(persistError.reportPersistError).toHaveBeenCalledOnce();
});

test("saveWorkspace refuses invalid and 101-tab live writes while preserving durable tabs", () => {
    sessionStorage.clear();
    const tabs = Array.from({ length: 100 }, (_, index) => ({
        ...legacyTab,
        name: `Tab ${index}`,
        value: crypto.randomUUID(),
    }));
    const durable = { version: 1 as const, tabs, activeTab: tabs[99]!.value };
    const firstTree = serializeStorageValue({ version: 0, state: defaultTree() });
    const lastTree = serializeStorageValue({ version: 0, state: defaultTree() });
    sessionStorage.setItem(tabs[0]!.value, firstTree);
    sessionStorage.setItem(tabs[99]!.value, lastTree);
    saveWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY, durable);
    const storedAtBoundary = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);

    saveWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY, {
        ...durable,
        tabs: [...tabs, { ...legacyTab, value: crypto.randomUUID() }],
    });
    saveWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY, "invalid" as never);
    saveWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY, {
        ...durable,
        tabs: [...tabs.slice(0, 99), { ...legacyTab, name: 42 } as never],
    });

    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(storedAtBoundary);
    expect(readStoredWorkspace()).toEqual(durable);
    expect(persistError.reportPersistError).toHaveBeenCalledTimes(3);
    for (const [error] of persistError.reportPersistError.mock.calls) {
        expect(error).toEqual(
            expect.objectContaining({
                message:
                    i18n.t("Common.ConfirmationError.unexpected") ||
                    enUSCatalogue.translation["Common.ConfirmationError.unexpected"],
                cause: expect.objectContaining({
                    message: "Workspace failed live schema validation",
                }),
            }),
        );
    }

    const reloaded = loadStoredWorkspace();
    expect(reloaded).toEqual(durable);
    expect(sessionStorage.getItem(tabs[0]!.value)).toBe(firstTree);
    expect(sessionStorage.getItem(tabs[99]!.value)).toBe(lastTree);
});

test("saveWorkspace preserves an empty live workspace for the replacement-tab effect", () => {
    sessionStorage.clear();

    const saved = saveWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY, {
        version: 1,
        tabs: [],
        activeTab: null,
    });

    expect(saved).toStrictEqual({ version: 1, tabs: [], activeTab: null });

    const stored = readStoredWorkspace() as ReturnType<typeof defaultWorkspace>;
    expect(stored).toEqual({ version: 1, tabs: [], activeTab: null });
});

test("saveWorkspace leaves an uncertain workspace's absent protection field absent", () => {
    sessionStorage.clear();
    const workspace = {
        version: 1 as const,
        tabs: [{ ...legacyTab, value: crypto.randomUUID() }],
        activeTab: null,
        treeOwnershipUncertain: true as const,
    };

    const saved = saveWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY, workspace);

    expect(saved).toStrictEqual({ ...workspace, activeTab: workspace.tabs[0]!.value });
    expect(saved).not.toHaveProperty("treeOwnershipProtectedIds");
    expect(readStoredWorkspace()).not.toHaveProperty("treeOwnershipProtectedIds");
});

test("saveWorkspace falls back from a mismatched active tab to the first tab", () => {
    sessionStorage.clear();
    const first = { ...legacyTab, value: crypto.randomUUID() };
    const second = { ...legacyTab, name: "Second", value: crypto.randomUUID() };

    saveWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY, {
        version: 1,
        tabs: [first, second],
        activeTab: crypto.randomUUID(),
    });

    const stored = readStoredWorkspace() as ReturnType<typeof defaultWorkspace>;
    expect(stored.tabs).toEqual([first, second]);
    expect(stored.activeTab).toBe(stored.tabs[0].value);
});

test("rolls back staged clones when clone flush fails and leaves legacy trees", () => {
    sessionStorage.clear();
    const secondLegacyTab = { ...legacyTab, name: "Second", value: "43" } as const;
    sessionStorage.setItem("tabs", JSON.stringify([legacyTab, secondLegacyTab]));
    sessionStorage.setItem("activeTab", JSON.stringify(secondLegacyTab.value));
    sessionStorage.setItem(
        legacyTab.value,
        serializeStorageValue({ version: 0, state: defaultTree() }),
    );
    sessionStorage.setItem(
        secondLegacyTab.value,
        serializeStorageValue({ version: 0, state: defaultTree() }),
    );
    const cloneWriteError = new DOMException("quota", "QuotaExceededError");
    const cloneIds: string[] = [];
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
            if (
                key !== WORKSPACE_STORAGE_KEY &&
                key !== legacyTab.value &&
                key !== secondLegacyTab.value &&
                key !== "tabs" &&
                key !== "activeTab"
            ) {
                cloneIds.push(key);
                if (cloneIds.length === 2) throw cloneWriteError;
            }
            return originalSetItem.call(this, key, value);
        });

    try {
        const workspace = loadStoredWorkspace();
        expect(workspace.tabs).toEqual([legacyTab, secondLegacyTab]);
        expect(workspace.activeTab).toBe(secondLegacyTab.value);
        expect(tabStorage.read(legacyTab.value)).not.toBeNull();
        expect(tabStorage.read(secondLegacyTab.value)).not.toBeNull();
        expect(cloneIds).toHaveLength(2);
        expect(cloneIds.every((id) => sessionStorage.getItem(id) === null)).toBe(true);
        expect(sessionStorage.getItem("tabs")).not.toBeNull();
        expect(sessionStorage.getItem("activeTab")).not.toBeNull();
        expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
        expect(persistError.reportPersistError).toHaveBeenCalledOnce();
        expect(persistError.reportPersistError).toHaveBeenCalledWith(
            expect.objectContaining({
                message:
                    "Could not open the game: the browser's session storage is full. Close some open tabs and try again.",
                cause: cloneWriteError,
            }),
        );
    } finally {
        setItem.mockRestore();
    }
});

test("reports clone persistence while a failed rollback removal leaves startup running", () => {
    sessionStorage.clear();
    sessionStorage.setItem("tabs", serializeStorageValue([legacyTab]));
    sessionStorage.setItem("activeTab", serializeStorageValue(legacyTab.value));
    sessionStorage.setItem(
        legacyTab.value,
        serializeStorageValue({ version: 0, state: defaultTree() }),
    );
    const cloneWriteError = new DOMException("quota", "QuotaExceededError");
    const stagedCloneIds: string[] = [];
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
            if (key !== legacyTab.value && key !== "tabs" && key !== "activeTab") {
                stagedCloneIds.push(key);
                throw cloneWriteError;
            }
            return originalSetItem.call(this, key, value);
        });
    const refused = denyStorageRemoval(() => stagedCloneIds[0] ?? "");

    try {
        expect(() => loadStoredWorkspace()).not.toThrow();
        expect(stagedCloneIds).toHaveLength(1);
        expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
        expect(persistError.reportPersistError).toHaveBeenCalledWith(
            expect.objectContaining({ cause: cloneWriteError }),
        );
        expect(persistError.reportPersistError).toHaveBeenCalledWith(
            expect.objectContaining({ name: "SecurityError" }),
        );
    } finally {
        refused.mockRestore();
        setItem.mockRestore();
    }
});

test("reports an envelope failure before a denied staged-clone rollback", () => {
    sessionStorage.clear();
    sessionStorage.setItem("tabs", serializeStorageValue([legacyTab]));
    sessionStorage.setItem("activeTab", serializeStorageValue(legacyTab.value));
    sessionStorage.setItem(
        legacyTab.value,
        serializeStorageValue({ version: 0, state: defaultTree() }),
    );
    const envelopeWriteError = new DOMException("quota", "QuotaExceededError");
    const stagedCloneIds: string[] = [];
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(function (this: Storage, key, value) {
            if (key === WORKSPACE_STORAGE_KEY) throw envelopeWriteError;
            if (key !== legacyTab.value && key !== "tabs" && key !== "activeTab") {
                if (!stagedCloneIds.includes(key)) stagedCloneIds.push(key);
            }
            return originalSetItem.call(this, key, value);
        });
    const refused = denyStorageRemoval(() => stagedCloneIds[0] ?? "");

    try {
        expect(() => loadStoredWorkspace()).not.toThrow();
        expect(stagedCloneIds).toHaveLength(1);
        expect(sessionStorage.getItem(stagedCloneIds[0]!)).not.toBeNull();
        expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
        expect(persistError.reportPersistError).toHaveBeenCalledWith(
            expect.objectContaining({ cause: envelopeWriteError }),
        );
        expect(persistError.reportPersistError).toHaveBeenCalledWith(
            expect.objectContaining({ name: "SecurityError" }),
        );
    } finally {
        refused.mockRestore();
        setItem.mockRestore();
    }
});
