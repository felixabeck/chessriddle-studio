import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createStore } from "jotai";
import { deckAtomFamily, tabsAtom } from "@/state/atoms";
import { getFileFreshness, removeFileFreshness } from "@/state/fileFreshness";
import { afterFileStructureChange, beginFileOpen } from "@/state/fileStructureChange";
import { loadWorkspace, WORKSPACE_STORAGE_KEY } from "@/state/workspace";
import { closeTreeStore, createTreeStore } from "@/state/store/tree";
import { tabStorage } from "@/state/store/tabStorage";
import { defaultTree } from "@/utils/treeReducer";
import type { PgnLineMove, GameMoveResult } from "@/bindings";
import type { Tab } from "@/utils/tabs";
import type { FileMetadata } from "./file";
import { affectedMoveSpan, reorderFileLines } from "./reorderLines";

const mocks = vi.hoisted(() => ({
    move: vi.fn(),
    ready: vi.fn(),
    clear: vi.fn(),
}));
vi.mock("@/platform/tauri", async (original) => ({
    ...(await original<typeof import("@/platform/tauri")>()),
    tauri: { moveGames: mocks.move },
}));
vi.mock("@/state/practiceStorage", async (original) => ({
    ...(await original<typeof import("@/state/practiceStorage")>()),
    ensurePracticeFileReorderReady: mocks.ready,
    clearPracticeFileMigrationFailures: mocks.clear,
}));
vi.mock("@/i18n", async (original) => ({
    ...(await original<typeof import("@/i18n")>()),
    default: { t: (key: string) => key },
}));

const file: FileMetadata = {
    type: "file",
    handle: { kind: "fileWorkspace", id: { id: "move-file" } },
    name: "Repertoire",
    numGames: 6,
    metadata: { type: "repertoire", tags: [] },
    lastModified: 1,
};
const rows = new Map([
    [0, { name: "A", section: "A" }],
    [1, { name: "a" }],
    [2, { name: "B", section: "B" }],
    [3, { name: "b" }],
    [4, { name: "C", section: "C" }],
    [5, { name: "c" }],
]);
function tab(index: number): Tab {
    return {
        value: `00000000-0000-4000-8000-00000000000${index}`,
        name: `Line ${index}`,
        type: "analysis",
        gameOrigin: { kind: "file", file, gameNumber: index },
    };
}
function setup(movement: PgnLineMove = { kind: "line", source: 0, before: 2, belowHeading: true }) {
    const workspace = createStore();
    workspace.set(
        tabsAtom,
        Array.from({ length: 6 }, (_, i) => tab(i)),
    );
    let selection = 0;
    const reload = vi.fn();
    const select = vi.fn((index: number) => {
        selection = index;
    });
    const args = {
        file,
        movement,
        revision: "list-revision",
        rows,
        workspace,
        setTabs: (update: Tab[] | ((tabs: Tab[]) => Tab[])) => workspace.set(tabsAtom, update),
        getSelection: () => selection,
        select,
        reload,
    };
    return { args, workspace, reload, select };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    for (let i = 0; i < 6; i += 1) {
        closeTreeStore(tab(i).value);
        removeFileFreshness(tab(i).value);
        tabStorage.seed(tab(i).value, defaultTree());
    }
    mocks.move.mockReset().mockResolvedValue({ changed: true, start: 0, order: [1, 0, 2] });
    mocks.ready.mockReset().mockResolvedValue(undefined);
    mocks.clear.mockReset();
});
afterEach(() => {
    for (let i = 0; i < 6; i += 1) closeTreeStore(tab(i).value);
});

test("moves tab ordinals and persists them, follows the current selection, and evicts practice atoms", async () => {
    const { args, workspace, reload, select } = setup();
    const oldDeck = deckAtomFamily({ file: "move-file", game: 0 });
    await reorderFileLines(args);
    expect(mocks.move).toHaveBeenCalledExactlyOnceWith(file.handle, args.movement, "list-revision");
    expect(workspace.get(tabsAtom).map((tab) => tab.gameOrigin)).toEqual(
        [1, 0, 2, 3, 4, 5].map((gameNumber) => ({ kind: "file", file, gameNumber })),
    );
    expect(
        loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY).tabs.map((tab) => tab.gameOrigin),
    ).toEqual(workspace.get(tabsAtom).map((tab) => tab.gameOrigin));
    expect(select).toHaveBeenCalledWith(1);
    expect(reload).toHaveBeenCalledExactlyOnceWith(false);
    expect(getFileFreshness(tab(0).value).state).toBe("unverified");
    expect(deckAtomFamily({ file: "move-file", game: 0 })).not.toBe(oldDeck);
    expect(mocks.clear).toHaveBeenCalledWith("move-file");
});

test.each([
    ["source", { kind: "line", source: 0, before: 2, belowHeading: true }, 0],
    ["heading's new owner", { kind: "line", source: 0, before: 2, belowHeading: true }, 1],
    ["below-heading destination", { kind: "line", source: 0, before: 2, belowHeading: true }, 2],
    [
        "downward section displacement",
        { kind: "section", source: 0, before: 6, belowHeading: false },
        5,
    ],
] as const)(
    "refuses a blocked tab on the %s before invoking native",
    async (_name, movement, dirty) => {
        const { args } = setup(movement);
        createTreeStore(tab(dirty).value, defaultTree()).setState({ dirty: true });
        await expect(reorderFileLines(args)).rejects.toThrow("Files.LineSection.UnsavedTab");
        expect(mocks.move).not.toHaveBeenCalled();
    },
);

test("refuses an open that starts during readiness checks and permits reorder after release", async () => {
    const { args, reload, select } = setup();
    const readiness = deferred<void>();
    mocks.ready.mockReturnValueOnce(readiness.promise);
    const pending = reorderFileLines(args);
    const endOpen = beginFileOpen("move-file");
    try {
        readiness.resolve();
        await expect(pending).rejects.toThrow("Files.LineSection.Stale");
        expect(mocks.move).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        expect(select).not.toHaveBeenCalled();
    } finally {
        endOpen();
    }
    await reorderFileLines(args);
    expect(mocks.move).toHaveBeenCalledExactlyOnceWith(file.handle, args.movement, "list-revision");
});

test.each(["untrusted migration scan", "global practice write block", "file migration failure"])(
    "refuses %s before invoking native",
    async (message) => {
        const { args } = setup();
        mocks.ready.mockRejectedValueOnce(new Error(message));
        await expect(reorderFileLines(args)).rejects.toThrow(message);
        expect(mocks.move).not.toHaveBeenCalled();
    },
);

test("a missing section end conservatively blocks through the end of the file", () => {
    expect(
        affectedMoveSpan(
            { kind: "section", source: 0, before: 2, belowHeading: false },
            6,
            new Map([[0, rows.get(0)!]]),
        ),
    ).toEqual([0, 5]);
});

test("one file owns one move until completion and holds the structure gate through tab publication", async () => {
    const { args } = setup();
    const flight = deferred<GameMoveResult>();
    mocks.move.mockReturnValueOnce(flight.promise);
    const first = reorderFileLines(args);
    await vi.waitFor(() => expect(mocks.move).toHaveBeenCalledOnce());
    expect(await reorderFileLines(args)).toBeUndefined();
    const later = vi.fn();
    const blocked = afterFileStructureChange("move-file", async () => {
        later();
    });
    await Promise.resolve();
    expect(later).not.toHaveBeenCalled();
    flight.resolve({ changed: true, start: 0, order: [1, 0, 2] });
    await first;
    await blocked;
    expect(later).toHaveBeenCalledOnce();
});

test.each(["durability", "stale-game"])(
    "%s marks conflicts, resets the list and invalidates practice",
    async (category) => {
        const { args, reload } = setup();
        mocks.move.mockRejectedValueOnce({ tag: "backend-error", category, message: "refused" });
        await expect(reorderFileLines(args)).rejects.toBeDefined();
        expect(getFileFreshness(tab(2).value).state).toBe("conflict");
        expect(reload).toHaveBeenCalledWith(true);
        expect(mocks.clear).toHaveBeenCalledWith("move-file");
    },
);

test("a refused metadata write after publication reports uncertainty and marks conflicts", async () => {
    const { args, reload } = setup();
    await expect(
        reorderFileLines({
            ...args,
            setTabs: (update) => {
                if (typeof update === "function") update(args.workspace.get(tabsAtom));
                return false;
            },
        }),
    ).rejects.toMatchObject({
        category: "applied-despite-error",
        message: "Common.DurabilityUncertain",
    });
    expect(getFileFreshness(tab(0).value).state).toBe("conflict");
    expect(reload).toHaveBeenCalledWith(true);
});

test("a no-op keeps metadata, selection, list and practice intact", async () => {
    const { args, reload, select } = setup();
    mocks.move.mockResolvedValueOnce({ changed: false, start: 0, order: [] });
    await reorderFileLines(args);
    expect(reload).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
});
