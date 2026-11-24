import { beforeEach, expect, test, vi } from "vitest";
import type { FileWorkspaceHandle, WorkspaceEntry } from "@/bindings";
import { lex } from "./tests/lexPgn";

const mocks = vi.hoisted(() => ({
    listFileWorkspace: vi.fn(),
    fileRevision: vi.fn(),
    countPgnGames: vi.fn(),
    readGame: vi.fn(),
    lexPgn: vi.fn(),
}));
vi.mock("@/platform/tauri", () => ({ tauri: mocks }));
vi.mock("@/platform/native", () => ({
    platform: vi.fn(() => "linux"),
    warn: vi.fn(() => Promise.resolve()),
    error: vi.fn(() => Promise.resolve()),
}));

const {
    MAX_COACH_REPERTOIRE_BYTES,
    REPERTOIRE_BOUNDS,
    readRepertoireIndex,
    refreshRepertoireIndex,
    repertoireContext,
    resetRepertoireIndexForTests,
} = await import("./repertoireIndex");

const workspace = {
    id: { id: "workspace" },
    kind: "fileWorkspace",
} as unknown as FileWorkspaceHandle;
const AFTER_E4_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function file(name: string, type: "repertoire" | "game", gameCount: number | null): WorkspaceEntry {
    return {
        handle: { id: { id: name }, kind: "file" } as unknown as FileWorkspaceHandle,
        kind: "file",
        name,
        children: [],
        metadata: { type, tags: [] },
        readError: null,
        gameCount,
        // The listing's whole-second time never changes here: the index must not depend on it.
        lastModified: 1n,
    };
}

function folder(name: string, children: WorkspaceEntry[]): WorkspaceEntry {
    return {
        handle: { id: { id: name }, kind: "directory" } as unknown as FileWorkspaceHandle,
        kind: "directory",
        name,
        children,
        metadata: null,
        readError: null,
        gameCount: null,
        lastModified: 0n,
    };
}

/** The games of each file by name; `readGame` serves them by index. */
let games: Record<string, string[]> = {};
/** The native revision of each file by name; a file without one has "r1". */
let revisions: Record<string, string> = {};

function serve(entries: WorkspaceEntry[]) {
    mocks.listFileWorkspace.mockResolvedValue({ entries, unread: [] });
}

beforeEach(() => {
    vi.resetAllMocks();
    resetRepertoireIndexForTests();
    games = {
        "Open games": [
            "1. e4 e5 2. Nf3 {The main move.} Nc6 (2... Nf6 3. Nxe5) 3. Bb5 *",
            "1. d4 d5 *",
        ],
        Vienna: ["1. e4 e5 2. Nc3 Nf6 *"],
        "My games": ["1. e4 e5 2. Ke2 *"],
    };
    mocks.countPgnGames.mockImplementation(
        async (handle: { id: { id: string } }) => games[handle.id.id]?.length ?? 0,
    );
    mocks.readGame.mockImplementation(async (handle: { id: { id: string } }, index: number) => {
        const pgn = games[handle.id.id]?.[index];
        if (pgn === undefined) throw new Error("no such game");
        return {
            pgn,
            stamp: "stamp",
            revision: revisions[handle.id.id] ?? "r1",
            present: true,
        };
    });
    mocks.lexPgn.mockImplementation(async (pgn: string) => lex(pgn));
    revisions = {};
    mocks.fileRevision.mockImplementation(
        async (handle: { id: { id: string } }) => revisions[handle.id.id] ?? "r1",
    );
});

test("repertoire files anywhere in the workspace are indexed; other files are not read", async () => {
    serve([
        file("My games", "game", 1),
        folder("Openings", [file("Open games", "repertoire", 2), file("Vienna", "repertoire", 1)]),
    ]);
    await refreshRepertoireIndex(workspace);
    expect(mocks.readGame.mock.calls.map(([handle]) => handle.id.id)).toEqual([
        "Open games",
        "Open games",
        "Vienna",
    ]);

    mocks.readGame.mockClear();
    const context = await repertoireContext(AFTER_E4_E5.replace("0 2", "7 31"));
    expect(context.partial).toBe(false);
    expect(context.text).toContain('Repertoire file "Open games", game 1:');
    expect(context.text).toContain(
        'Repertoire file "Open games", game 1:\n2. Nf3 {The main move.} Nc6 (2... Nf6 3. Nxe5) 3. Bb5',
    );
    expect(context.text).toContain('Repertoire file "Vienna", game 1:');
    expect(context.text).toContain('Repertoire file "Vienna", game 1:\n2. Nc3 Nf6');
    expect(context.text).not.toContain("Ke2");
    expect(context.text).not.toContain("[FEN");
    // Only the games in which the position occurs are read again for the question.
    expect(mocks.readGame).toHaveBeenCalledTimes(2);
});

test("a position outside the repertoire has no text, and without a workspace nothing is asked", async () => {
    serve([file("Vienna", "repertoire", 1)]);
    await refreshRepertoireIndex(workspace);
    expect(await repertoireContext("8/8/8/8/8/8/8/K6k w - - 0 1")).toEqual({
        text: null,
        partial: false,
    });
    // The end of a line is in the repertoire, but there is nothing below it to tell.
    const end = "rnbqkb1r/pppp1ppp/5n2/4p3/4P3/2N5/PPPP1PPP/R1BQKBNR w KQkq - 2 3";
    expect((await repertoireContext(end)).text).toBeNull();

    await refreshRepertoireIndex(null);
    expect(await repertoireContext(AFTER_E4)).toEqual({ text: null, partial: false });
});

test("a file is read again only when its revision changed", async () => {
    serve([file("Open games", "repertoire", 2), file("Vienna", "repertoire", 1)]);
    await refreshRepertoireIndex(workspace);
    mocks.readGame.mockClear();
    await refreshRepertoireIndex(workspace);
    expect(mocks.readGame).not.toHaveBeenCalled();

    // An edit in the same second with the same number of games: only the native revision tells.
    games.Vienna = ["1. e4 e5 2. Nc3 Nc6 *"];
    revisions.Vienna = "r2";
    await refreshRepertoireIndex(workspace);
    expect(mocks.readGame.mock.calls.map(([handle]) => handle.id.id)).toEqual(["Vienna"]);
    expect((await repertoireContext(AFTER_E4_E5)).text).toContain("2. Nc3 Nc6");

    // A file whose revision cannot be told is read again every time.
    mocks.readGame.mockClear();
    mocks.fileRevision.mockImplementation(async (handle: { id: { id: string } }) => {
        if (handle.id.id === "Vienna") throw new Error("no revision");
        return "r1";
    });
    await refreshRepertoireIndex(workspace);
    await refreshRepertoireIndex(workspace);
    expect(mocks.readGame.mock.calls.map(([handle]) => handle.id.id)).toEqual(["Vienna", "Vienna"]);
    expect((await repertoireContext(AFTER_E4_E5)).partial).toBe(false);

    // A file that left the workspace leaves the index.
    serve([file("Open games", "repertoire", 2)]);
    await refreshRepertoireIndex(workspace);
    expect((await repertoireContext(AFTER_E4_E5)).text).not.toContain("Vienna");
});

test("an unreadable game is skipped and the answer says the repertoire was partly read", async () => {
    games["Open games"][1] = undefined as unknown as string;
    serve([file("Open games", "repertoire", 2)]);
    await refreshRepertoireIndex(workspace);
    const context = await repertoireContext(AFTER_E4_E5);
    expect(context.text).toContain("2. Nf3");
    expect(context.partial).toBe(true);
});

test("more repertoire files than the bound, or a failed listing, leave the index partial", async () => {
    serve(
        Array.from({ length: REPERTOIRE_BOUNDS.files + 1 }, (_, index) =>
            file(`Empty ${index}`, "repertoire", 0),
        ),
    );
    await refreshRepertoireIndex(workspace);
    expect((await repertoireContext(AFTER_E4)).partial).toBe(true);

    resetRepertoireIndexForTests();
    mocks.listFileWorkspace.mockRejectedValue(new Error("workspace is gone"));
    await refreshRepertoireIndex(workspace);
    expect(await repertoireContext(AFTER_E4)).toEqual({ text: null, partial: true });
});

test("a question asked while the index is still being built says so", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    serve([file("Vienna", "repertoire", 1)]);
    mocks.readGame.mockImplementationOnce(async () => {
        await held;
        return { pgn: games.Vienna[0], stamp: "stamp", revision: "r1", present: true };
    });
    const building = refreshRepertoireIndex(workspace);
    // A second call joins the refresh that runs.
    expect(refreshRepertoireIndex(workspace)).toBe(building);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await repertoireContext(AFTER_E4_E5)).toEqual({ text: null, partial: true });
    release();
    await building;
    expect((await repertoireContext(AFTER_E4_E5)).partial).toBe(false);
});

test("the text stays within its bound and says when it was cut", async () => {
    const long = Array.from(
        { length: 400 },
        (_, index) => `{note ${index} ${"x".repeat(40)}}`,
    ).join(" ");
    games.Vienna = [`1. e4 e5 2. Nc3 ${long} Nf6 *`];
    serve([file("Vienna", "repertoire", 1)]);
    await refreshRepertoireIndex(workspace);
    const context = await repertoireContext(AFTER_E4_E5);
    expect(new TextEncoder().encode(context.text!).length).toBeLessThanOrEqual(
        MAX_COACH_REPERTOIRE_BYTES,
    );
    expect(context.text!.endsWith(" …")).toBe(true);
    expect(context.partial).toBe(true);
});

test("a game the native side left out or reports as absent is skipped as unread", async () => {
    serve([file("Open games", "repertoire", 2)]);
    mocks.readGame.mockImplementation(async (_handle: unknown, index: number) => ({
        pgn: index === 0 ? "" : games["Open games"][0],
        stamp: "stamp",
        revision: "r1",
        present: index !== 0,
    }));
    await refreshRepertoireIndex(workspace);
    const context = await repertoireContext(AFTER_E4_E5);
    expect(context.text).toContain('Repertoire file "Open games", game 2:');
    expect(context.partial).toBe(true);
});

test("another workspace starts a new index and the old build stops writing", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    serve([file("Open games", "repertoire", 2)]);
    mocks.readGame.mockImplementationOnce(async () => {
        await held;
        return { pgn: games["Open games"][0], stamp: "stamp", revision: "r1", present: true };
    });
    const first = refreshRepertoireIndex(workspace);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const other = { id: { id: "other" }, kind: "fileWorkspace" } as unknown as FileWorkspaceHandle;
    serve([file("Vienna", "repertoire", 1)]);
    const second = refreshRepertoireIndex(other);
    release();
    await Promise.all([first, second]);
    const context = await repertoireContext(AFTER_E4_E5);
    expect(context.text).toContain("Vienna");
    expect(context.text).not.toContain("Open games");
    expect(context.partial).toBe(false);
});

test("more than three games with the position are named as partly told", async () => {
    games.Vienna = Array.from(
        { length: 5 },
        (_, index) => `1. e4 e5 2. Nc3 Nf6 ${index + 3}. a3 *`,
    );
    serve([file("Vienna", "repertoire", 5)]);
    await refreshRepertoireIndex(workspace);
    const context = await repertoireContext(AFTER_E4_E5);
    expect(context.text!.match(/Repertoire file/g)).toHaveLength(3);
    expect(context.partial).toBe(true);
});

test("the end of one line does not hide the same position where another line goes on", async () => {
    // After 4. Nc3 the main line ends; the side line reaches the same position by 3. Nc3 and
    // 4. Bc4 and plays on.
    games.Italian = ["1. e4 e5 2. Nf3 Nc6 3. Bc4 (3. Nc3 Nf6 4. Bc4 Bc5 5. d3) 3... Nf6 4. Nc3 *"];
    // Three games that only end in the position must not use up the places of one that goes on.
    games.Ends = [
        "1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Nc3 *",
        "1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Bc4 *",
        "1. e4 e5 2. Nc3 Nc6 3. Nf3 Nf6 4. Bc4 *",
        "1. Nf3 Nc6 2. e4 e5 3. Bc4 Nf6 4. Nc3 Bb4 *",
    ];
    serve([file("Ends", "repertoire", 4), file("Italian", "repertoire", 1)]);
    await refreshRepertoireIndex(workspace);
    const context = await repertoireContext(
        "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R b KQkq - 5 4",
    );
    expect(context.text).toContain('Repertoire file "Ends", game 4:\n4... Bb4');
    expect(context.text).toContain('Repertoire file "Italian", game 1:\n4... Bc5 5. d3');
    expect(context.text!.match(/Repertoire file/g)).toHaveLength(2);
    expect(context.partial).toBe(false);
});

test("a file the listing could not read or count is unread, not empty", async () => {
    for (const unreadable of [
        { ...file("Locked", "repertoire", null), readError: "permission" as const },
        file("Uncounted", "repertoire", null),
    ]) {
        resetRepertoireIndexForTests();
        serve([unreadable, file("Vienna", "repertoire", 1)]);
        await refreshRepertoireIndex(workspace);
        const context = await repertoireContext(AFTER_E4_E5);
        expect(context.text).toContain("Vienna");
        expect(context.partial).toBe(true);
        // It stays unread: the next refresh looks again instead of trusting an empty index.
        mocks.fileRevision.mockClear();
        await refreshRepertoireIndex(workspace);
        expect((await repertoireContext("8/8/8/8/8/8/8/K6k w - - 0 1")).partial).toBe(true);
    }
});

test("a game that is gone or left out when the question is asked makes the answer partial", async () => {
    serve([file("Vienna", "repertoire", 1)]);
    await refreshRepertoireIndex(workspace);
    for (const reread of [
        { pgn: "", present: false },
        { pgn: "", present: true, omission: "tooLarge" },
    ]) {
        mocks.readGame.mockResolvedValueOnce({ stamp: "stamp", revision: "revision", ...reread });
        expect(await repertoireContext(AFTER_E4_E5)).toEqual({ text: null, partial: true });
    }
    // A game that was shortened to end in the position has nothing to tell, and that is all.
    mocks.readGame.mockResolvedValueOnce({
        pgn: "1. e4 e5 *",
        stamp: "stamp",
        revision: "revision",
        present: true,
    });
    expect(await repertoireContext(AFTER_E4_E5)).toEqual({ text: null, partial: false });
});

test("each bound of the index stops the reading and leaves it partial", async () => {
    const all = { files: 50, games: 100, bytes: 1_000_000, entries: 10_000 };
    const twoFiles = [file("Open games", "repertoire", 2), file("Vienna", "repertoire", 1)];

    // Games: the first file uses the budget up, the second is not read.
    serve(twoFiles);
    await refreshRepertoireIndex(workspace, { ...all, games: 2 });
    expect(mocks.readGame).toHaveBeenCalledTimes(2);
    let context = await repertoireContext(AFTER_E4_E5);
    expect(context.text).toContain("Open games");
    expect(context.text).not.toContain("Vienna");
    expect(context.partial).toBe(true);

    // Bytes: a game larger than what is left is not parsed; smaller ones after it still are.
    resetRepertoireIndexForTests();
    mocks.lexPgn.mockClear();
    const first = new TextEncoder().encode(games["Open games"][0]).length;
    await refreshRepertoireIndex(workspace, { ...all, bytes: first - 1 });
    expect(mocks.lexPgn).toHaveBeenCalledTimes(2);
    context = await repertoireContext(AFTER_E4_E5);
    expect(context.text).not.toContain("Open games");
    expect(context.text).toContain("Vienna");
    expect(context.partial).toBe(true);

    // Entries: positions are indexed until the budget is spent.
    resetRepertoireIndexForTests();
    await refreshRepertoireIndex(workspace, { ...all, entries: 1 });
    expect((await repertoireContext(AFTER_E4_E5)).text).toBeNull();
    // The one entry is the start position of the first game.
    expect((await repertoireContext(START)).text).toContain("Open games");
    expect((await repertoireContext(START)).partial).toBe(true);

    // With room for everything nothing is partial.
    resetRepertoireIndexForTests();
    await refreshRepertoireIndex(workspace, all);
    expect((await repertoireContext(AFTER_E4_E5)).partial).toBe(false);
});

test("a game the native side marks as left out is not indexed", async () => {
    serve([file("Vienna", "repertoire", 1)]);
    mocks.readGame.mockResolvedValueOnce({
        pgn: games.Vienna[0],
        stamp: "stamp",
        revision: "r1",
        present: true,
        omission: "tooLarge",
    });
    await refreshRepertoireIndex(workspace);
    expect(await repertoireContext(AFTER_E4_E5)).toEqual({ text: null, partial: true });
});

test("readRepertoireIndex returns settled chapters, nodes, FileMetadata, partial and reason", async () => {
    expect(readRepertoireIndex(workspace)).toBeNull();
    expect(readRepertoireIndex(null)).toBeNull();

    games.Sicilian = [
        '[Event "Najdorf"]\n[White "Bg5"]\n[Black "Poisoned Pawn"]\n[Orientation "black"]\n[Start "[0,0]"]\n\n1. e4 c5 2. Nf3 *',
    ];
    serve([file("Sicilian", "repertoire", 1)]);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    mocks.readGame.mockImplementationOnce(async () => {
        await held;
        return { pgn: games.Sicilian[0], stamp: "stamp", revision: "r1", present: true };
    });
    const running = refreshRepertoireIndex(workspace);
    // While a refresh is running the snapshot is not settled yet.
    expect(readRepertoireIndex(workspace)).toBeNull();
    release();
    await running;

    const other = { id: { id: "other" }, kind: "fileWorkspace" } as unknown as FileWorkspaceHandle;
    expect(readRepertoireIndex(other)).toBeNull();

    const snapshot = readRepertoireIndex(workspace);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.partial).toBe(false);
    expect(snapshot!.partialReason).toBeNull();
    expect(snapshot!.files).toHaveLength(1);
    const indexed = snapshot!.files[0];
    expect(indexed.file.name).toBe("Sicilian");
    expect(indexed.file.numGames).toBe(1);
    expect(indexed.file.metadata.type).toBe("repertoire");
    expect(indexed.partial).toBe(false);
    expect(indexed.chapters).toHaveLength(1);
    expect(indexed.chapters[0].chapter).toBe(0);
    expect(indexed.chapters[0].headers).toEqual({
        orientation: "black",
        start: [0, 0],
        white: "Bg5",
        black: "Poisoned Pawn",
        event: "Najdorf",
    });
    expect(
        indexed.chapters[0].nodes.map((node) => ({
            parent: node.parent,
            san: node.san,
            path: node.path,
            halfMoves: node.halfMoves,
            hasContinuation: node.hasContinuation,
        })),
    ).toEqual([
        { parent: -1, san: null, path: [], halfMoves: 0, hasContinuation: true },
        { parent: 0, san: "e4", path: [0], halfMoves: 1, hasContinuation: true },
        { parent: 1, san: "c5", path: [0, 0], halfMoves: 2, hasContinuation: true },
        { parent: 2, san: "Nf3", path: [0, 0, 0], halfMoves: 3, hasContinuation: false },
    ]);
});

test("the entries bound also charges a line's last move", async () => {
    // 1. e4 e5 has 3 nodes: root, e4, and leaf e5.
    games.Short = ["1. e4 e5 *"];
    serve([file("Short", "repertoire", 1)]);

    // Budget of 2 leaves out the leaf move e5 and marks the index partial with bound-reached.
    await refreshRepertoireIndex(workspace, {
        files: 50,
        games: 100,
        bytes: 1_000_000,
        entries: 2,
    });
    const partial = readRepertoireIndex(workspace)!;
    expect(partial.partial).toBe(true);
    expect(partial.partialReason).toBe("bound-reached");
    expect(partial.files[0].chapters[0].nodes).toHaveLength(2);

    // Budget of 3 fits all 3 nodes including the leaf and is complete.
    resetRepertoireIndexForTests();
    await refreshRepertoireIndex(workspace, {
        files: 50,
        games: 100,
        bytes: 1_000_000,
        entries: 3,
    });
    const full = readRepertoireIndex(workspace)!;
    expect(full.partial).toBe(false);
    expect(full.partialReason).toBeNull();
    expect(full.files[0].chapters[0].nodes).toHaveLength(3);
});

test("a file whose game reports another revision is partial and read again on the next refresh", async () => {
    serve([file("Open games", "repertoire", 2)]);
    mocks.readGame
        .mockResolvedValueOnce({
            pgn: games["Open games"][0],
            stamp: "stamp",
            revision: "r1",
            present: true,
        })
        .mockResolvedValueOnce({
            pgn: games["Open games"][1],
            stamp: "stamp",
            revision: "r2",
            present: true,
        });

    await refreshRepertoireIndex(workspace);
    const first = readRepertoireIndex(workspace)!;
    expect(first.partial).toBe(true);
    expect(first.partialReason).toBe("read-failed");
    expect(first.files[0].partial).toBe(true);
    expect(first.files[0].chapters).toHaveLength(1);

    // Next refresh reads the file again even though fileRevision still reports r1.
    mocks.readGame.mockClear();
    await refreshRepertoireIndex(workspace);
    expect(mocks.readGame).toHaveBeenCalledTimes(2);
    const second = readRepertoireIndex(workspace)!;
    expect(second.partial).toBe(false);
    expect(second.partialReason).toBeNull();
    expect(second.files[0].chapters).toHaveLength(2);
});

test("a chapter whose start position cannot be set up is left out alone", async () => {
    games.Mixed = ['[FEN "8/8/8/8/8/8/8/8 w - - 0 1"]\n\n*', "1. e4 e5 *"];
    serve([file("Mixed", "repertoire", 2)]);

    await refreshRepertoireIndex(workspace);
    const snapshot = readRepertoireIndex(workspace)!;
    expect(snapshot.partial).toBe(true);
    expect(snapshot.partialReason).toBe("read-failed");
    expect(snapshot.files[0].partial).toBe(true);
    expect(snapshot.files[0].chapters.map((chapter) => chapter.chapter)).toEqual([1]);
    expect(snapshot.files[0].chapters[0].nodes.map((node) => node.san)).toEqual([null, "e4", "e5"]);
});

test("a failed workspace listing is reported with listing-failed", async () => {
    mocks.listFileWorkspace.mockRejectedValueOnce(new Error("disk offline"));
    await refreshRepertoireIndex(workspace);
    const snapshot = readRepertoireIndex(workspace)!;
    expect(snapshot.partial).toBe(true);
    expect(snapshot.partialReason).toBe("listing-failed");
    expect(snapshot.files).toEqual([]);
});

test("re-indexing an edited earlier file keeps the workspace listing order", async () => {
    games.Alpha = ["1. e4 e5 *"];
    games.Beta = ["1. d4 d5 *"];
    serve([file("Alpha", "repertoire", 1), file("Beta", "repertoire", 1)]);
    await refreshRepertoireIndex(workspace);
    expect(readRepertoireIndex(workspace)!.files.map((entry) => entry.file.name)).toEqual([
        "Alpha",
        "Beta",
    ]);

    games.Alpha = ["1. e4 c5 *"];
    revisions.Alpha = "r2";
    await refreshRepertoireIndex(workspace);
    expect(readRepertoireIndex(workspace)!.files.map((entry) => entry.file.name)).toEqual([
        "Alpha",
        "Beta",
    ]);
});

test("parent pointers stay accurate across variations in a chapter", async () => {
    games.Branching = ["1. e4 (1. d4 d5) 1... e5 2. Nf3 *"];
    serve([file("Branching", "repertoire", 1)]);
    await refreshRepertoireIndex(workspace);
    const nodes = readRepertoireIndex(workspace)!.files[0].chapters[0].nodes;
    expect(
        nodes.map((node) => ({
            parent: node.parent,
            san: node.san,
            path: node.path,
        })),
    ).toEqual([
        { parent: -1, san: null, path: [] },
        { parent: 0, san: "e4", path: [0] },
        { parent: 1, san: "e5", path: [0, 0] },
        { parent: 2, san: "Nf3", path: [0, 0, 0] },
        { parent: 0, san: "d4", path: [1] },
        { parent: 4, san: "d5", path: [1, 0] },
    ]);
});

test("countPgnGames rejection makes the file partial, and its count overrides listing gameCount", async () => {
    games.Counted = ["1. e4 e5 *", "1. d4 d5 *"];
    serve([file("Counted", "repertoire", 1)]);

    // Rejected countPgnGames -> partial with read-failed.
    mocks.countPgnGames.mockRejectedValueOnce(new Error("cannot count"));
    await refreshRepertoireIndex(workspace);
    const failed = readRepertoireIndex(workspace)!;
    expect(failed.partial).toBe(true);
    expect(failed.partialReason).toBe("read-failed");
    expect(failed.files[0].partial).toBe(true);
    expect(failed.files[0].chapters).toHaveLength(0);

    // countPgnGames returns 2 while listing reported gameCount 1 -> numGames and chapters read are 2.
    await refreshRepertoireIndex(workspace);
    const counted = readRepertoireIndex(workspace)!;
    expect(counted.partial).toBe(false);
    expect(counted.partialReason).toBeNull();
    expect(counted.files[0].file.numGames).toBe(2);
    expect(counted.files[0].chapters.map((chapter) => chapter.chapter)).toEqual([0, 1]);
});
