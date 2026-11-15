import { createStore } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { activeTabAtom, tabsAtom } from "@/state/atoms";
import { serializeStorageValue } from "@/state/store/debouncedStorage";
import { TREE_STORAGE_VERSION } from "@/state/store/tabStorage";
import { closeTreeStore } from "@/state/store/tree";
import type { Tab } from "@/state/workspaceTypes";
import { defaultTree } from "@/utils/treeReducer";
import { createQuitTabSaver } from "./quitSave";

const mocks = vi.hoisted(() => ({ saveToFile: vi.fn() }));

vi.mock("@/platform/native", () => ({
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/utils/tabs", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/utils/tabs")>()),
    saveToFile: mocks.saveToFile,
}));

const draft: Tab = {
    name: "New game",
    value: "11111111-1111-4111-8111-111111111111",
    type: "analysis",
    gameOrigin: { kind: "databaseDraft", database: { id: { id: "db" }, kind: "database" } },
};
const analysis: Tab = {
    name: "Analysis",
    value: "22222222-2222-4222-8222-222222222222",
    type: "analysis",
    gameOrigin: { kind: "none" },
};
const retargetedKey = "33333333-3333-4333-8333-333333333333";

function seedDirtyTree(key: string) {
    const tree = defaultTree();
    tree.dirty = true;
    sessionStorage.setItem(
        key,
        serializeStorageValue({ version: TREE_STORAGE_VERSION, state: tree }),
    );
}

let jotaiStore: ReturnType<typeof createStore>;

beforeEach(() => {
    sessionStorage.clear();
    mocks.saveToFile.mockReset().mockResolvedValue("saved");
    jotaiStore = createStore();
    jotaiStore.set(tabsAtom, [draft, analysis], draft.value);
});

afterEach(() => {
    closeTreeStore(draft.value);
    closeTreeStore(analysis.value);
    sessionStorage.clear();
});

test("a tab with a save target is saved as a user save without changing the view", async () => {
    const showWorkspace = vi.fn();
    await expect(createQuitTabSaver(jotaiStore, showWorkspace)(draft)).resolves.toBe("saved");
    expect(mocks.saveToFile).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ tab: draft, isUserSave: true }),
    );
    expect(showWorkspace).not.toHaveBeenCalled();
    expect(jotaiStore.get(activeTabAtom)).toBe(draft.value);
});

const tempFile: Tab = {
    ...analysis,
    gameOrigin: {
        kind: "temp_file",
        gameNumber: 0,
        file: {
            type: "file",
            handle: { id: { id: "scratch" }, kind: "fileWorkspace" },
            name: "scratch.pgn",
            numGames: 1,
            metadata: { type: "game", tags: [] },
            lastModified: 1,
        },
    },
};

test.each([
    ["without a save target", analysis],
    ["in a temporary file", tempFile],
])("a tab %s is shown before its file picker opens", async (_case, picked) => {
    jotaiStore.set(tabsAtom, [draft, picked], draft.value);
    const showWorkspace = vi.fn();
    mocks.saveToFile.mockImplementation(async () => {
        expect(showWorkspace).toHaveBeenCalledOnce();
        expect(jotaiStore.get(activeTabAtom)).toBe(picked.value);
        return "cancelled";
    });
    await expect(createQuitTabSaver(jotaiStore, showWorkspace)(picked)).resolves.toBe("cancelled");
    expect(mocks.saveToFile).toHaveBeenCalledOnce();
});

test("a never-mounted retargeted tab is saved from the tree stored under its tree key", async () => {
    const retargeted: Tab = { ...draft, treeKey: retargetedKey };
    jotaiStore.set(tabsAtom, [retargeted, analysis], analysis.value);
    seedDirtyTree(retargetedKey);
    await createQuitTabSaver(jotaiStore, vi.fn())(retargeted);
    expect(mocks.saveToFile.mock.calls[0]?.[0].store.getState().dirty).toBe(true);
});

test("the save reads and updates the live workspace", async () => {
    await createQuitTabSaver(jotaiStore, vi.fn())(draft);
    const { getTab, updateTab } = mocks.saveToFile.mock.calls[0]![0];
    expect(getTab(analysis.value)).toEqual(analysis);
    expect(updateTab(draft.value, (tab: Tab) => ({ ...tab, name: "Saved game" }))).toBe(true);
    expect(jotaiStore.get(tabsAtom).find((tab) => tab.value === draft.value)?.name).toBe(
        "Saved game",
    );
    expect(getTab(draft.value)?.name).toBe("Saved game");
});
