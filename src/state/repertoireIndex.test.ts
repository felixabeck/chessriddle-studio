import { beforeEach, expect, test, vi } from "vitest";
import type { FileWorkspaceHandle, Token, WorkspaceEntry } from "@/bindings";

const mocks = vi.hoisted(() => ({
    listFileWorkspace: vi.fn(),
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
    MAX_REPERTOIRE_FILES,
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

function file(
    name: string,
    type: "repertoire" | "game",
    gameCount: number,
    lastModified = 1n,
): WorkspaceEntry {
    return {
        handle: { id: { id: name }, kind: "file" } as unknown as FileWorkspaceHandle,
        kind: "file",
        name,
        children: [],
        metadata: { type, tags: [] },
        readError: null,
        gameCount,
        lastModified,
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

/** The native lexer's tokens for the plain movetext these tests use. */
function lex(pgn: string): Token[] {
    const tokens: Token[] = [];
    for (const [part] of pgn.matchAll(/\{[^}]*\}|[()*]|[^\s(){}]+/g)) {
        if (part.startsWith("{")) tokens.push({ type: "Comment", value: part.slice(1, -1) });
        else if (part === "(") tokens.push({ type: "ParenOpen" });
        else if (part === ")") tokens.push({ type: "ParenClose" });
        else if (part === "*") tokens.push({ type: "Outcome", value: "*" });
        else if (!/^\d+\.+$/.test(part)) tokens.push({ type: "San", value: part });
    }
    return tokens;
}

/** The games of each file by name; `readGame` serves them by index. */
let games: Record<string, string[]> = {};

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
    mocks.readGame.mockImplementation(async (handle: { id: { id: string } }, index: number) => {
        const pgn = games[handle.id.id]?.[index];
        if (pgn === undefined) throw new Error("no such game");
        return { pgn, stamp: "stamp", revision: "revision", present: true };
    });
    mocks.lexPgn.mockImplementation(async (pgn: string) => lex(pgn));
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

    games.Vienna = ["1. e4 e5 2. Nc3 Nc6 *"];
    serve([file("Open games", "repertoire", 2), file("Vienna", "repertoire", 1, 2n)]);
    await refreshRepertoireIndex(workspace);
    expect(mocks.readGame.mock.calls.map(([handle]) => handle.id.id)).toEqual(["Vienna"]);
    expect((await repertoireContext(AFTER_E4_E5)).text).toContain("2. Nc3 Nc6");

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
        Array.from({ length: MAX_REPERTOIRE_FILES + 1 }, (_, index) =>
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
        return { pgn: games.Vienna[0], stamp: "stamp", revision: "revision", present: true };
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
        revision: "revision",
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
        return { pgn: games["Open games"][0], stamp: "stamp", revision: "revision", present: true };
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
