import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    createWorkspaceFile: vi.fn(),
    createTab: vi.fn(),
    listFileWorkspace: vi.fn(),
    issuePgnWorkspace: vi.fn(),
    issuePgnExportDestination: vi.fn(),
    countPgnGames: vi.fn(),
    readGame: vi.fn(),
    qualifyFileGame: vi.fn(async () => null),
    writeGame: vi.fn(),
    issueFileWorkspace: vi.fn(),
    parsePGN: vi.fn(),
    storeGet: vi.fn(),
    storeSet: vi.fn(),
}));

vi.mock("@/platform/tauri", async () => {
    const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
    return { ...actual, tauri: mocks };
});

vi.mock("jotai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("jotai")>();
    return {
        ...actual,
        getDefaultStore: () => ({
            get: mocks.storeGet,
            set: mocks.storeSet,
        }),
    };
});

vi.mock("@/utils/chess", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/utils/chess")>();
    return { ...actual, parsePGN: mocks.parsePGN };
});

vi.mock("./tabs", () => ({ createTab: mocks.createTab }));

import { TauriCommandError } from "@/platform/tauri";
import type { FileWorkspaceHandle, WriteStamp } from "@/bindings";
import { defaultGame, makePgn } from "chessops/pgn";
import {
    addRecentFileAtom,
    tabFamily,
    fileWorkspaceAtom,
    fileWorkspaceDisplayNameAtom,
} from "@/state/atoms";
import {
    getFileFreshness,
    removeFileFreshness,
    setFileFreshness,
    startFileRevisionPoll,
} from "@/state/fileFreshness";
import type { Tab } from "@/utils/tabs";
import { createFile, ensureFileWorkspace, openFile, pickPgnFile, writeFileGame } from "./files";

const listingCache = { cache: new Map(), mutate: vi.fn() };

afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    removeFileFreshness("files-write-helper");
});

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

async function flushPromises() {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

const freshPgn =
    '[Event "Fresh from disk"]\n[White "Fresh White"]\n[Black "Fresh Black"]\n\n1. e4 e5 *';
const freshStamp = "a".repeat(64);

describe("openFile tab admission", () => {
    const file = {
        type: "file" as const,
        name: "white.pgn",
        handle: { id: { id: "white" }, kind: "fileWorkspace" as const },
        numGames: 1,
        metadata: { type: "repertoire" as const, tags: [] },
        lastModified: 1,
    };
    const setTabs = vi.fn();

    beforeEach(() => {
        mocks.parsePGN.mockImplementation(async (pgn: string) => {
            const tree = (await import("@/utils/treeReducer")).defaultTree();
            tree.headers.event = pgn.match(/\[Event "([^"]+)"\]/)?.[1] ?? "";
            tree.headers.white = pgn.match(/\[White "([^"]+)"\]/)?.[1] ?? "";
            tree.headers.black = pgn.match(/\[Black "([^"]+)"\]/)?.[1] ?? "";
            return tree;
        });
        mocks.readGame.mockResolvedValue({
            pgn: freshPgn,
            stamp: freshStamp,
            revision: "device:inode:revision",
            present: true,
        });
    });

    test("does not acknowledge practice or recent metadata when admission is refused", async () => {
        mocks.createTab.mockResolvedValueOnce(null);

        await expect(openFile(file, setTabs)).resolves.toBeNull();

        expect(mocks.readGame).toHaveBeenCalledWith(file.handle, 0, undefined);
        expect(mocks.storeSet).not.toHaveBeenCalled();
    });

    test("returns the admitted id and records an ordinary repertoire without selecting Practice", async () => {
        mocks.createTab.mockResolvedValueOnce("tab-id");

        await expect(openFile(file, setTabs)).resolves.toBe("tab-id");

        expect(mocks.createTab).toHaveBeenCalledWith(
            expect.objectContaining({
                initialTree: expect.objectContaining({ sourceStamp: freshStamp }),
                gameOrigin: { kind: "file", file, gameNumber: 0 },
            }),
        );
        expect(mocks.storeSet).toHaveBeenCalledTimes(1);
        expect(mocks.storeSet).toHaveBeenCalledWith(
            addRecentFileAtom,
            expect.objectContaining({ handle: file.handle }),
        );
        expect(mocks.storeSet).not.toHaveBeenCalledWith(tabFamily("tab-id"), "practice");
    });

    test("passes the owner through full preparation and selects Practice only on request", async () => {
        mocks.createTab.mockResolvedValueOnce("practice-id");
        await openFile(file, setTabs, { ownerId: "home", panel: "practice" });
        expect(mocks.createTab).toHaveBeenCalledWith(
            expect.objectContaining({
                ownerId: "home",
                initialTree: expect.objectContaining({ sourceStamp: freshStamp }),
            }),
        );
        expect(mocks.storeSet).toHaveBeenCalledWith(tabFamily("practice-id"), "practice");
    });

    test("an owner without an admitted id leaves freshness and all metadata untouched", async () => {
        mocks.createTab.mockResolvedValueOnce(null);
        const before = getFileFreshness("failed-owner");
        await expect(
            openFile(file, setTabs, { ownerId: "failed-owner", panel: "practice" }),
        ).resolves.toBeNull();
        expect(mocks.createTab).toHaveBeenCalledWith(
            expect.objectContaining({ ownerId: "failed-owner" }),
        );
        expect(mocks.storeSet).not.toHaveBeenCalled();
        expect(getFileFreshness("failed-owner")).toEqual(before);
    });

    test.each([
        { pgn: "*", name: "Example" },
        { pgn: '[White "White"]\n[Black "Black"]\n\n*', name: "White - Black" },
    ])("uses the informative name $name for the tab and recent entry", async ({ pgn, name }) => {
        mocks.readGame.mockResolvedValueOnce({
            pgn,
            stamp: freshStamp,
            revision: "r1",
            present: true,
        });
        mocks.createTab.mockResolvedValueOnce("tab-id");
        await openFile({ ...file, name: "Example.pgn" }, setTabs);
        expect(mocks.createTab).toHaveBeenCalledWith(
            expect.objectContaining({ tab: { name, type: "analysis" } }),
        );
        expect(mocks.storeSet).toHaveBeenCalledWith(
            addRecentFileAtom,
            expect.objectContaining({ name }),
        );
    });

    test("loads current disk text rather than accepting a preview supplied by the caller", async () => {
        mocks.readGame.mockResolvedValueOnce({
            pgn: '[Event "Fresh from disk"]\n\n1. e4 e5 *',
            stamp: freshStamp,
            revision: "new-revision",
            present: true,
        });
        mocks.createTab.mockResolvedValueOnce("tab-id");

        await openFile(file, setTabs, { gameNumber: 0 });

        expect(mocks.createTab).toHaveBeenCalledWith(
            expect.objectContaining({
                tab: { name: "Fresh from disk", type: "analysis" },
                initialTree: expect.objectContaining({
                    sourceStamp: freshStamp,
                    headers: expect.objectContaining({ event: "Fresh from disk" }),
                }),
            }),
        );
        // The tab starts verified at the revision it was read at, so the gate does not re-read it.
        expect(getFileFreshness("tab-id")).toMatchObject({
            state: "verified",
            verifiedRevision: "new-revision",
        });
    });
});

test.each([
    {
        path: "structured backend-error",
        listedName: "game",
        rejection: new TauriCommandError({
            tag: "backend-error",
            category: "durability",
            message: "Committed but durability uncertain: registry replacement",
        }),
    },
    {
        path: "structured backend-error",
        listedName: "game.pgn",
        rejection: new TauriCommandError({
            tag: "backend-error",
            category: "durability",
            message: "Committed but durability uncertain: registry replacement",
        }),
    },
    {
        path: "string fallback",
        listedName: "game.pgn",
        // Fallback-path coverage: classify() still matches this owned Display literal.
        rejection: new Error("Committed but durability uncertain: registry replacement"),
    },
])(
    "recovers a created PGN listed as $listedName after an uncertain commit via the $path",
    async ({ listedName, rejection }) => {
        const workspace = { id: { id: "workspace" }, kind: "fileWorkspace" } as const;
        const parent = { id: { id: "parent" }, kind: "fileWorkspace" } as const;
        const handle = { id: { id: "created" }, kind: "fileWorkspace" };
        mocks.createWorkspaceFile.mockRejectedValueOnce(rejection);
        mocks.listFileWorkspace.mockResolvedValueOnce({
            entries: [
                {
                    handle,
                    kind: "file",
                    name: listedName,
                    children: [],
                    metadata: { type: "game", tags: [] },
                    gameCount: 1,
                    lastModified: 42,
                },
            ],
            unread: [{ name: listedName, kind: "file", category: "permission", parent: null }],
        });

        const result = await createFile({
            listingCache,
            filename: "game.pgn",
            filetype: "game",
            workspace,
            parent,
        });

        expect(result.isOk).toBe(true);
        expect(result.unwrap()).toMatchObject({ handle, name: listedName, numGames: 1 });
        expect(mocks.listFileWorkspace).toHaveBeenCalledWith(parent);
    },
);

describe("createFile content", () => {
    const workspace: FileWorkspaceHandle = {
        id: { id: "create-file-workspace" },
        kind: "fileWorkspace",
    };
    const created = {
        handle: { id: { id: "created-file" }, kind: "fileWorkspace" },
        name: "created",
        metadata: { type: "game", tags: [] },
        gameCount: 1,
        lastModified: 1,
    };

    test("forwards copy content", async () => {
        const content = {
            kind: "copy" as const,
            source: workspace,
            revision: "source-revision",
        };
        mocks.createWorkspaceFile.mockResolvedValueOnce(created);

        await createFile({
            listingCache,
            filename: "created",
            filetype: "game",
            content,
            workspace,
            parent: workspace,
        });

        expect(mocks.createWorkspaceFile).toHaveBeenCalledWith(
            workspace,
            workspace,
            "created",
            { type: "game", tags: [] },
            content,
        );
    });

    test("defaults to a text content from the default game", async () => {
        mocks.createWorkspaceFile.mockResolvedValueOnce(created);

        await createFile({
            listingCache,
            filename: "created",
            filetype: "game",
            workspace,
            parent: workspace,
        });

        expect(mocks.createWorkspaceFile).toHaveBeenCalledWith(
            workspace,
            workspace,
            "created",
            { type: "game", tags: [] },
            { kind: "text", pgn: makePgn(defaultGame()) },
        );
    });
});

describe("pickPgnFile", () => {
    const handle = { id: { id: "pgn" }, kind: "fileWorkspace" } as const;

    test.each([0, 4])("uses the native save destination and counts %i games", async (count) => {
        mocks.issuePgnExportDestination.mockResolvedValueOnce({ handle, displayName: "new.PGN" });
        mocks.countPgnGames.mockResolvedValueOnce(count);
        await expect(pickPgnFile("export")).resolves.toMatchObject({
            type: "file",
            handle,
            name: "new",
            numGames: count,
            metadata: { type: "game", tags: [] },
        });
        expect(mocks.issuePgnExportDestination).toHaveBeenCalledOnce();
        expect(mocks.issuePgnWorkspace).not.toHaveBeenCalled();
        expect(mocks.countPgnGames).toHaveBeenCalledWith(handle);
    });

    test("handles save picker cancellation", async () => {
        mocks.issuePgnExportDestination.mockRejectedValueOnce(new Error("Cancellation"));
        await expect(pickPgnFile("export")).resolves.toBeNull();
        expect(mocks.countPgnGames).not.toHaveBeenCalled();
    });

    test("propagates a save picker permission failure", async () => {
        const error = new Error("permission denied");
        mocks.issuePgnExportDestination.mockRejectedValueOnce(error);
        await expect(pickPgnFile("export")).rejects.toBe(error);
        expect(mocks.countPgnGames).not.toHaveBeenCalled();
    });

    test("propagates a destination count failure", async () => {
        mocks.issuePgnExportDestination.mockResolvedValueOnce({ handle, displayName: "new.pgn" });
        const error = new Error("count failed");
        mocks.countPgnGames.mockRejectedValueOnce(error);
        await expect(pickPgnFile("export")).rejects.toBe(error);
    });

    test("returns null on Cancellation without counting games", async () => {
        mocks.issuePgnWorkspace.mockRejectedValueOnce(new Error("Cancellation"));
        await expect(pickPgnFile()).resolves.toBeNull();
        expect(mocks.countPgnGames).not.toHaveBeenCalled();
    });

    test("rejects a permission-denied picker failure without counting games", async () => {
        const error = new Error("permission denied");
        mocks.issuePgnWorkspace.mockRejectedValueOnce(error);
        await expect(pickPgnFile()).rejects.toBe(error);
        expect(mocks.countPgnGames).not.toHaveBeenCalled();
    });

    test("does not treat connection aborted as cancel", async () => {
        const error = new Error("connection aborted");
        mocks.issuePgnWorkspace.mockRejectedValueOnce(error);
        await expect(pickPgnFile()).rejects.toBe(error);
        expect(mocks.countPgnGames).not.toHaveBeenCalled();
    });

    test("returns metadata and counts games on success", async () => {
        mocks.issuePgnWorkspace.mockResolvedValueOnce({
            handle,
            displayName: "games.pgn",
        });
        mocks.countPgnGames.mockResolvedValueOnce(3);
        await expect(pickPgnFile()).resolves.toMatchObject({
            type: "file",
            handle,
            name: "games",
            numGames: 3,
            metadata: { type: "game", tags: [] },
        });
        expect(mocks.countPgnGames).toHaveBeenCalledWith(handle);
    });
});

test.each(["success", "rejection"] as const)(
    "writeFileGame tracks the write through %s and releases it afterward",
    async (outcome) => {
        const handle: FileWorkspaceHandle = {
            id: { id: "files-write-helper-handle" },
            kind: "fileWorkspace",
        };
        const tab: Tab = {
            value: "files-write-helper",
            name: "Write helper",
            type: "analysis",
            gameOrigin: { kind: "file", file: { handle }, gameNumber: 0 },
        } as Tab;
        setFileFreshness(tab.value, "verified", { verifiedRevision: "r1" });
        const pendingWrite = deferred<WriteStamp>();
        mocks.writeGame.mockReturnValueOnce(pendingWrite.promise);
        const fileRevision = vi.fn(async () => "r1");
        let focus: () => void = () => undefined;
        const stop = startFileRevisionPoll({
            getTabs: () => [tab],
            fileRevision,
            subscribeFocus: (callback) => {
                focus = callback;
                return () => undefined;
            },
        });

        try {
            const write = writeFileGame(handle, 0, "game", { kind: "append" });
            const failure = new Error("write failed");
            const observedWrite = write.then(
                (result) => ({ status: "resolved" as const, result }),
                (error: unknown) => ({ status: "rejected" as const, error }),
            );
            focus();
            await flushPromises();
            expect(mocks.writeGame).toHaveBeenCalledOnce();
            expect(fileRevision).not.toHaveBeenCalled();

            let expectedOutcome:
                | { status: "resolved"; result: WriteStamp }
                | { status: "rejected"; error: Error };
            if (outcome === "success") {
                const written = { stamp: "a".repeat(64), revision: "r1" };
                pendingWrite.resolve(written);
                expectedOutcome = { status: "resolved", result: written };
            } else {
                pendingWrite.reject(failure);
                expectedOutcome = { status: "rejected", error: failure };
            }
            await expect(observedWrite).resolves.toEqual(expectedOutcome);
            await flushPromises();

            expect(fileRevision).toHaveBeenCalledOnce();
            expect(getFileFreshness(tab.value).state).toBe("verified");
        } finally {
            stop();
        }
    },
);

describe("ensureFileWorkspace", () => {
    const handle = { id: { id: "workspace" }, kind: "fileWorkspace" } as const;

    beforeEach(() => {
        mocks.storeGet.mockReturnValue(null);
    });

    test("returns null on Cancellation without storing a handle", async () => {
        mocks.issueFileWorkspace.mockRejectedValueOnce(new Error("Cancellation"));
        await expect(ensureFileWorkspace()).resolves.toBeNull();
        expect(mocks.storeSet).not.toHaveBeenCalled();
    });

    test("rejects a permission-denied picker failure", async () => {
        const error = new Error("permission denied");
        mocks.issueFileWorkspace.mockRejectedValueOnce(error);
        await expect(ensureFileWorkspace()).rejects.toBe(error);
        expect(mocks.storeSet).not.toHaveBeenCalled();
    });

    test("stores the issued handle on success", async () => {
        mocks.issueFileWorkspace.mockResolvedValueOnce({
            handle,
            displayName: "My Files",
        });
        await expect(ensureFileWorkspace()).resolves.toBe(handle);
        expect(mocks.storeSet).toHaveBeenCalledWith(fileWorkspaceAtom, handle);
        expect(mocks.storeSet).toHaveBeenCalledWith(fileWorkspaceDisplayNameAtom, "My Files");
    });
});
