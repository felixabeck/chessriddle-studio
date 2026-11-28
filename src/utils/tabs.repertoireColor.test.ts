import { createStore } from "jotai";
import { beforeEach, expect, test, vi } from "vitest";
import type { FileMetadata } from "@/components/files/file";
import { tabsAtom, updateTabById } from "@/state/atoms";
import type { IndexedRepertoireChapter, RepertoireSnapshot } from "@/state/repertoireIndex";
import { createTreeStore } from "@/state/store/tree";
import { tabStorage } from "@/state/store/tabStorage";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { getDefaultStore } from "jotai";
import { fileWorkspaceAtom } from "@/state/atoms";
import { setFileFreshness } from "@/state/fileFreshness";
import {
    appendBlankGame,
    appendStoreGame,
    type FileBackedTab,
    saveToFile,
    serializeStoreTree,
    type Tab,
} from "./tabs";
import { defaultTree } from "./treeReducer";

const mocks = vi.hoisted(() => ({
    writeGame: vi.fn(),
    readGame: vi.fn(),
    pickPgnFile: vi.fn(),
    refreshRepertoireIndex: vi.fn(async () => undefined),
    readRepertoireIndex: vi.fn(),
}));

vi.mock("@/platform/tauri", () => ({
    tauri: {
        writeGame: mocks.writeGame,
        readGame: mocks.readGame,
        countPgnGames: vi.fn(async () => 3),
        lexPgn: vi.fn(async () => []),
        resolveLinkedGame: vi.fn(async () => null),
        collectionForDatabase: vi.fn(async () => null),
    },
}));
vi.mock("./files", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./files")>()),
    pickPgnFile: mocks.pickPgnFile,
}));
// The native PGN lexer is absent here; a parsed game is an empty tree.
vi.mock("./chess", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./chess")>()),
    parsePGN: vi.fn(async () => defaultTree()),
}));
vi.mock("@/state/repertoireIndex", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/state/repertoireIndex")>()),
    refreshRepertoireIndex: mocks.refreshRepertoireIndex,
    readRepertoireIndex: mocks.readRepertoireIndex,
}));

const handle = { id: { id: "black-repertoire" }, kind: "fileWorkspace" } as const;

function repertoireFile(type: "repertoire" | "game" = "repertoire"): FileMetadata {
    return {
        type: "file",
        handle,
        name: "Black.pgn",
        numGames: 2,
        metadata: { type, tags: [] },
        lastModified: 1,
    };
}

function chapter(index: number, orientation?: "white" | "black"): IndexedRepertoireChapter {
    return {
        chapter: index,
        headers: { white: "", black: "", event: "", ...(orientation ? { orientation } : {}) },
        nodes: [],
    };
}

function indexWith(chapters: IndexedRepertoireChapter[]): RepertoireSnapshot {
    return {
        files: [
            {
                workspaceKey: fileWorkspaceKey(handle),
                file: repertoireFile(),
                chapters,
                partial: false,
            },
        ],
        partial: false,
        partialReason: null,
    };
}

/** Appends a fresh analysis game to `file` and returns the PGN that reached the backend. */
async function appendTo(file: FileMetadata, orientation?: "white" | "black") {
    const id = crypto.randomUUID();
    const tree = { ...defaultTree(), dirty: true };
    if (orientation) tree.headers.orientation = orientation;
    tabStorage.seed(id, tree);
    const store = createTreeStore(id);
    const workspace = createStore();
    const owner: Tab = { value: id, name: "Line", type: "analysis", gameOrigin: { kind: "none" } };
    workspace.set(tabsAtom, [owner], id);
    const getTab = (tabId: string) => workspace.get(tabsAtom).find((tab) => tab.value === tabId);
    await appendStoreGame({
        tab: owner,
        store,
        selected: file,
        pgn: serializeStoreTree(store),
        getTab,
        isCurrent: () => getTab(id) !== undefined,
        updateTab: (tabId, update, onAdmitted) =>
            updateTabById(
                (tabs, active, saved) => workspace.set(tabsAtom, tabs, active, saved),
                tabId,
                update,
                onAdmitted,
            ),
        prepareMessage: "Could not prepare append",
    });
    expect(mocks.writeGame).toHaveBeenCalledTimes(1);
    return { pgn: mocks.writeGame.mock.calls[0][2] as string, store };
}

beforeEach(() => {
    vi.clearAllMocks();
    // A write without a readable result ends the append right after it; the PGN is what counts.
    mocks.writeGame.mockResolvedValue({ stamp: null, revision: null });
});

test("a game appended to a Black repertoire is written and shown as Black", async () => {
    mocks.readRepertoireIndex.mockReturnValue(indexWith([chapter(0, "black"), chapter(1)]));

    const { pgn, store } = await appendTo(repertoireFile());

    expect(pgn).toContain('[Orientation "black"]');
    expect(store.getState().headers.orientation).toBe("black");
});

test("a game that already has a color keeps it", async () => {
    mocks.readRepertoireIndex.mockReturnValue(indexWith([chapter(0, "black")]));

    const { pgn } = await appendTo(repertoireFile(), "white");

    expect(pgn).toContain('[Orientation "white"]');
    expect(pgn).not.toContain('[Orientation "black"]');
});

test("chapters that disagree leave the color unset", async () => {
    mocks.readRepertoireIndex.mockReturnValue(
        indexWith([chapter(0, "black"), chapter(1, "white")]),
    );

    const { pgn, store } = await appendTo(repertoireFile());

    expect(pgn).not.toContain("[Orientation");
    expect(store.getState().headers.orientation).toBeUndefined();
});

test("a game file is never colored and never reads the repertoire index", async () => {
    const { pgn } = await appendTo(repertoireFile("game"));

    expect(pgn).not.toContain("[Orientation");
    expect(mocks.refreshRepertoireIndex).not.toHaveBeenCalled();
});

/** A tab holding game 1 of the Black repertoire, with `orientation` on its game. */
function fileTab(orientation?: "white" | "black", kind: "file" | "temp_file" = "file") {
    const id = crypto.randomUUID();
    const tree = { ...defaultTree(), dirty: true, sourceStamp: "a".repeat(64) };
    if (orientation) tree.headers.orientation = orientation;
    tabStorage.seed(id, tree);
    const store = createTreeStore(id);
    const workspace = createStore();
    const owner: FileBackedTab = {
        value: id,
        name: "Chapter",
        type: "analysis",
        gameOrigin: { kind, gameNumber: 1, file: repertoireFile() },
    };
    workspace.set(tabsAtom, [owner], id);
    setFileFreshness(id, "verified", { verifiedRevision: "before" });
    const getTab = (tabId: string) => workspace.get(tabsAtom).find((tab) => tab.value === tabId);
    const updateTab = (
        tabId: string,
        update: Parameters<typeof updateTabById>[2],
        onAdmitted?: (successor: Tab) => void,
    ) =>
        updateTabById(
            (tabs, active, saved) => workspace.set(tabsAtom, tabs, active, saved),
            tabId,
            update,
            onAdmitted,
        );
    return { owner, store, workspace, getTab, updateTab };
}

test("saving an uncoloured chapter of a Black repertoire writes and shows it as Black", async () => {
    mocks.readRepertoireIndex.mockReturnValue(indexWith([chapter(0, "black"), chapter(1)]));
    const { owner, store, getTab, updateTab } = fileTab();
    mocks.readGame.mockImplementation(async () => ({
        pgn: "1. e4 *",
        stamp: store.getState().sourceStamp,
        revision: "before",
        present: true,
    }));

    await saveToFile({ tab: owner, store, getTab, updateTab, isUserSave: true });

    expect(mocks.writeGame).toHaveBeenCalledTimes(1);
    expect(mocks.writeGame.mock.calls[0][2]).toContain('[Orientation "black"]');
    expect(store.getState().headers.orientation).toBe("black");
});

test("a blank game added inside a Black repertoire tab is written as Black", async () => {
    mocks.readRepertoireIndex.mockReturnValue(indexWith([chapter(0, "black")]));
    const { owner, store, workspace, getTab, updateTab } = fileTab("black");

    await appendBlankGame({
        captured: owner,
        store,
        workspace,
        getTab,
        updateTab,
        onError: vi.fn(),
        uncertainMessage: "uncertain",
        changedMessage: "changed",
    });

    expect(mocks.writeGame).toHaveBeenCalledTimes(1);
    const written = mocks.writeGame.mock.calls[0][2] as string;
    expect(written).toContain('[Orientation "black"]');
});

test("the color comes from the current workspace's index entry for this file", async () => {
    const workspaceHandle = { id: { id: "ws" }, kind: "fileWorkspace" } as const;
    getDefaultStore().set(fileWorkspaceAtom, workspaceHandle);
    mocks.readRepertoireIndex.mockImplementation((workspace) =>
        workspace === workspaceHandle ? indexWith([chapter(0, "black")]) : null,
    );
    try {
        const { pgn } = await appendTo(repertoireFile());
        expect(pgn).toContain('[Orientation "black"]');
        expect(mocks.refreshRepertoireIndex).toHaveBeenCalledWith(workspaceHandle);
    } finally {
        getDefaultStore().set(fileWorkspaceAtom, null);
    }
});

test("a file missing from the index is left uncoloured", async () => {
    mocks.readRepertoireIndex.mockReturnValue({ files: [], partial: true, partialReason: null });
    const { pgn } = await appendTo(repertoireFile());
    expect(pgn).not.toContain("[Orientation");
});

test("an append superseded during the color lookup writes nothing and clears its store attempt", async () => {
    mocks.readRepertoireIndex.mockReturnValue(indexWith([chapter(0, "black")]));
    const id = crypto.randomUUID();
    tabStorage.seed(id, { ...defaultTree(), dirty: true });
    const store = createTreeStore(id);
    let current = true;
    mocks.refreshRepertoireIndex.mockImplementationOnce(async () => {
        current = false;
    });
    const clear = vi.fn();
    const owner: Tab = { value: id, name: "Line", type: "analysis", gameOrigin: { kind: "none" } };

    const result = await appendStoreGame({
        tab: owner,
        store,
        selected: repertoireFile(),
        pgn: serializeStoreTree(store),
        getTab: () => owner,
        isCurrent: () => current,
        updateTab: () => true,
        prepareMessage: "Could not prepare append",
        storeAttempt: { clear },
    });

    expect(result).toBe("superseded");
    expect(mocks.writeGame).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(store.getState().headers.orientation).toBeUndefined();
});

test("a file save superseded during the color lookup writes nothing", async () => {
    mocks.readRepertoireIndex.mockReturnValue(indexWith([chapter(0, "black")]));
    const { owner, store, workspace, getTab, updateTab } = fileTab();
    mocks.refreshRepertoireIndex.mockImplementationOnce(async () => {
        workspace.set(tabsAtom, [], undefined);
    });

    const result = await saveToFile({ tab: owner, store, getTab, updateTab, isUserSave: true });

    expect(result).toBe("superseded");
    expect(mocks.writeGame).not.toHaveBeenCalled();
    expect(store.getState().headers.orientation).toBeUndefined();
});

test("a blank game superseded during the color lookup writes nothing", async () => {
    mocks.readRepertoireIndex.mockReturnValue(indexWith([chapter(0, "black")]));
    const { owner, store, workspace, getTab, updateTab } = fileTab("black");
    mocks.refreshRepertoireIndex.mockImplementationOnce(async () => {
        workspace.set(tabsAtom, [], undefined);
    });

    await appendBlankGame({
        captured: owner,
        store,
        workspace,
        getTab,
        updateTab,
        onError: vi.fn(),
        uncertainMessage: "uncertain",
        changedMessage: "changed",
    });

    expect(mocks.writeGame).not.toHaveBeenCalled();
});

test("Save As from a temporary repertoire file does not take that file's color", async () => {
    mocks.readRepertoireIndex.mockReturnValue(indexWith([chapter(0, "black")]));
    const { owner, store, getTab, updateTab } = fileTab(undefined, "temp_file");
    mocks.pickPgnFile.mockResolvedValueOnce({
        ...repertoireFile("game"),
        handle: { id: { id: "elsewhere" }, kind: "fileWorkspace" },
        name: "Elsewhere.pgn",
    });

    await saveToFile({ tab: owner, store, getTab, updateTab, isUserSave: true });

    expect(mocks.refreshRepertoireIndex).not.toHaveBeenCalled();
    expect(store.getState().headers.orientation).toBeUndefined();
    for (const call of mocks.writeGame.mock.calls) expect(call[2]).not.toContain("[Orientation");
});

test("the blank game a Black repertoire tab moves to shows Black", async () => {
    mocks.readRepertoireIndex.mockReturnValue(indexWith([chapter(0, "black")]));
    mocks.writeGame.mockResolvedValueOnce({ stamp: "b".repeat(64), revision: "added" });
    // The tab starts uncolored, so a Black board can only come from the added game.
    const { owner, store, workspace, getTab, updateTab } = fileTab();

    await appendBlankGame({
        captured: owner,
        store,
        workspace,
        getTab,
        updateTab,
        onError: vi.fn(),
        uncertainMessage: "uncertain",
        changedMessage: "changed",
    });

    const current = getTab(owner.value);
    expect(current?.gameOrigin).toMatchObject({ kind: "file", gameNumber: 2 });
    expect(store.getState().headers.orientation).toBe("black");
});
