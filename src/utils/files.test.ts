import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    createWorkspaceFile: vi.fn(),
    listFileWorkspace: vi.fn(),
    issuePgnWorkspace: vi.fn(),
    issuePgnExportDestination: vi.fn(),
    countPgnGames: vi.fn(),
    readGame: vi.fn(),
    qualifyFileGame: vi.fn(async () => null),
    writeGame: vi.fn(),
    setGameSection: vi.fn(),
    setGameOrientation: vi.fn(),
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

import { TauriCommandError } from "@/platform/tauri";
import type { FileWorkspaceHandle, WorkspaceUnread, WriteStamp } from "@/bindings";
import { defaultGame, makePgn } from "chessops/pgn";
import { fileWorkspaceAtom, fileWorkspaceDisplayNameAtom } from "@/state/atoms";
import {
    getFileFreshness,
    removeFileFreshness,
    setFileFreshness,
    startFileRevisionPoll,
} from "@/state/fileFreshness";
import type { Tab } from "@/utils/tabs";
import { defaultTree } from "./treeReducer";
import {
    createFile,
    ensureFileWorkspace,
    getFileGameName,
    loadFileGame,
    pickPgnFile,
    sameGameIdentity,
    setFileGameOrientation,
    writeFileGame,
} from "./files";

const otherStart = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

test.each([
    { field: "white", a: "", b: "?" },
    { field: "white", a: "Unknown", b: "" },
    { field: "date", a: "", b: "????.??.??" },
    { field: "round", a: "?", b: "" },
    { field: "event", a: "", b: "fertig" },
    { field: "site", a: "Berlin", b: "Moscow" },
] as const)("sameGameIdentity keeps a game whose $field reads $a then $b", ({ field, a, b }) => {
    const headers = defaultTree().headers;
    expect(sameGameIdentity({ ...headers, [field]: a }, { ...headers, [field]: b })).toBe(true);
});

test.each([
    { field: "white", a: "Kasparov", b: "Carlsen" },
    { field: "black", a: "Topalov", b: "" },
    { field: "date", a: "1999.01.20", b: "????.??.??" },
    { field: "round", a: "4", b: "5" },
    { field: "fen", a: defaultTree().headers.fen, b: otherStart },
] as const)("sameGameIdentity tells games apart by $field", ({ field, a, b }) => {
    const headers = defaultTree().headers;
    expect(sameGameIdentity({ ...headers, [field]: a }, { ...headers, [field]: b })).toBe(false);
});

test.each([
    { white: "Dragon", black: "plan", event: "fertig", expected: "Dragon" },
    { white: "Dragon", black: "?", event: "fertig", expected: "Dragon" },
    { white: "?", black: "?", event: "Legacy", expected: "Legacy" },
    { white: "?", black: "?", event: "?", expected: "Repertoire" },
    { white: " ", black: "plan", event: "", expected: "Repertoire" },
])("getFileGameName names a repertoire tab $expected", ({ expected, ...headers }) => {
    expect(
        getFileGameName(
            { ...defaultTree().headers, ...headers },
            {
                name: "Repertoire.PGN",
                metadata: { type: "repertoire", tags: [] },
            },
        ),
    ).toBe(expected);
});

test.each([
    { white: "White", black: "Black", event: "Event", expected: "White - Black" },
    { white: "White", black: "?", event: "Event", expected: "White - ?" },
    { white: "?", black: "?", event: "Event", expected: "Event" },
    { white: "?", black: "?", event: "?", expected: "Games" },
    { white: "", black: "", event: "", expected: "Games" },
])("getFileGameName keeps the game tab rule for $expected", ({ expected, ...headers }) => {
    expect(
        getFileGameName(
            { ...defaultTree().headers, ...headers },
            {
                name: "Games.pgn",
                metadata: { type: "game", tags: [] },
            },
        ),
    ).toBe(expected);
});

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

test("loadFileGame rejects with Cancellation when aborted after parsing resolves", async () => {
    const handle: FileWorkspaceHandle = { id: { id: "cancelled" }, kind: "fileWorkspace" };
    const controller = new AbortController();
    const parsed = deferred<ReturnType<typeof defaultTree>>();
    mocks.readGame.mockResolvedValueOnce({
        pgn: freshPgn,
        stamp: freshStamp,
        revision: "revision",
        present: true,
    });
    mocks.parsePGN.mockReturnValueOnce(parsed.promise);

    const pending = loadFileGame(handle, 0, controller.signal);
    await vi.waitFor(() => expect(mocks.parsePGN).toHaveBeenCalledOnce());
    expect(mocks.readGame).toHaveBeenCalledExactlyOnceWith(handle, 0, {
        signal: controller.signal,
    });
    expect(mocks.parsePGN).toHaveBeenCalledWith(freshPgn, undefined, {
        signal: controller.signal,
    });
    expect(controller.signal.aborted).toBe(false);
    parsed.resolve(defaultTree());
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(DOMException);
    await expect(pending).rejects.toMatchObject({
        name: "AbortError",
        message: "Cancellation",
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
            unread: [{ name: "blocked.pgn", kind: "file", category: "permission", parent: null }],
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

test.each([
    { filename: " game ", listedName: "game" },
    { filename: "\u0085game\u0085", listedName: "game" },
    { filename: " Foo.PGN ", listedName: "Foo.PGN" },
    { filename: "Foo.pgn.pgn", listedName: "Foo" },
])(
    "recovers $filename using its native listed name $listedName",
    async ({ filename, listedName }) => {
        const workspace = { id: { id: "workspace" }, kind: "fileWorkspace" } as const;
        const handle = { id: { id: "created" }, kind: "fileWorkspace" };
        mocks.createWorkspaceFile.mockRejectedValueOnce(
            new TauriCommandError({
                tag: "backend-error",
                category: "durability",
                message: "Committed but durability uncertain: registry replacement",
            }),
        );
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
            unread: [],
        });

        const result = await createFile({
            listingCache,
            filename,
            filetype: "game",
            workspace,
            parent: workspace,
        });

        expect(result.isOk).toBe(true);
        expect(result.unwrap()).toMatchObject({ handle, name: listedName });
    },
);

test.each<{
    scenario: string;
    filename?: string;
    entries: { name: string; kind: "file" | "directory"; id: string }[];
    unread?: WorkspaceUnread[];
    recovered: boolean;
}>([
    {
        scenario: "selects FEFF-prefixed Foo after a pre-existing Foo listed first",
        filename: "\uFEFFFoo.pgn",
        entries: [
            { name: "Foo", kind: "file", id: "pre-existing" },
            { name: "\uFEFFFoo", kind: "file", id: "created" },
        ],
        recovered: true,
    },
    {
        scenario: "rejects a pre-existing Foo without FEFF-prefixed Foo",
        filename: "\uFEFFFoo.pgn",
        entries: [{ name: "Foo", kind: "file", id: "pre-existing" }],
        recovered: false,
    },
    {
        scenario: "selects Foo after a pre-existing foo listed first",
        entries: [
            { name: "foo", kind: "file", id: "pre-existing" },
            { name: "Foo", kind: "file", id: "created" },
        ],
        recovered: true,
    },
    {
        scenario: "rejects a pre-existing foo without Foo",
        entries: [{ name: "foo", kind: "file", id: "pre-existing" }],
        recovered: false,
    },
    {
        scenario: "rejects a directory named Foo",
        entries: [{ name: "Foo", kind: "directory", id: "directory" }],
        recovered: false,
    },
    {
        scenario: "rejects multiple accepted file names",
        entries: [
            { name: "Foo", kind: "file", id: "created" },
            { name: "Foo.pgn", kind: "file", id: "ambiguous" },
        ],
        recovered: false,
    },
    {
        scenario: "rejects a pre-existing Foo when Foo.pgn is unreadable",
        entries: [{ name: "Foo", kind: "file", id: "pre-existing" }],
        unread: [{ name: "Foo.pgn", kind: "file", category: "permission", parent: null }],
        recovered: false,
    },
    {
        scenario: "rejects a pre-existing Foo when unreadable Foo has unknown kind",
        entries: [{ name: "Foo", kind: "file", id: "pre-existing" }],
        unread: [{ name: "Foo", kind: null, category: "permission", parent: null }],
        recovered: false,
    },
    {
        scenario: "selects Foo with an unreadable nested Foo.pgn",
        entries: [{ name: "Foo", kind: "file", id: "created" }],
        unread: [
            {
                name: "Foo.pgn",
                kind: "file",
                category: "permission",
                parent: { id: { id: "nested" }, kind: "fileWorkspace" },
            },
        ],
        recovered: true,
    },
])(
    "createFile recovery $scenario",
    async ({ filename = "Foo.pgn", entries, unread = [], recovered }) => {
        const workspace = { id: { id: "workspace" }, kind: "fileWorkspace" } as const;
        const parent = { id: { id: "parent" }, kind: "fileWorkspace" } as const;
        const rejection = new TauriCommandError({
            tag: "backend-error",
            category: "durability",
            message: "Committed but durability uncertain: registry replacement",
        });
        mocks.createWorkspaceFile.mockRejectedValueOnce(rejection);
        mocks.listFileWorkspace.mockResolvedValueOnce({
            entries: entries.map(({ id, name, kind }) => ({
                handle: { id: { id }, kind: "fileWorkspace" },
                kind,
                name,
                children: [],
                metadata: kind === "file" ? { type: "game", tags: [] } : null,
                gameCount: kind === "file" ? 1 : null,
                lastModified: 42,
            })),
            unread,
        });

        const result = await createFile({
            listingCache,
            filename,
            filetype: "game",
            workspace,
            parent,
        });

        expect(result.isOk).toBe(recovered);
        expect(result.isErr).toBe(!recovered);
        expect(
            result.unwrap(
                (file) => file.handle.id.id,
                (error) => error,
            ),
        ).toBe(recovered ? "created" : rejection);
        expect(mocks.listFileWorkspace).toHaveBeenCalledExactlyOnceWith(parent);
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

test.each(["success", "rejection"] as const)(
    "setFileGameOrientation tracks the write through %s and releases it afterward",
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
        mocks.setGameOrientation.mockReturnValueOnce(pendingWrite.promise);
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
            const write = setFileGameOrientation(handle, 0, "black", "stamp", "r1");
            const failure = new Error("write failed");
            const observedWrite = write.then(
                (result) => ({ status: "resolved" as const, result }),
                (error: unknown) => ({ status: "rejected" as const, error }),
            );
            focus();
            await flushPromises();
            expect(mocks.setGameOrientation).toHaveBeenCalledExactlyOnceWith(
                handle,
                0,
                "black",
                "stamp",
                "r1",
            );
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
        expect(mocks.issueFileWorkspace).toHaveBeenCalledWith(null);
        expect(mocks.storeSet).toHaveBeenCalledWith(fileWorkspaceAtom, handle);
        expect(mocks.storeSet).toHaveBeenCalledWith(fileWorkspaceDisplayNameAtom, "My Files");
    });
});
