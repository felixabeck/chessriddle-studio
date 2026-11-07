import { parseUci } from "chessops";
import { describe, expect, test, vi } from "vitest";
import * as chessops from "@/utils/chessops";
import {
    boardStateMapBuilder,
    countMainPly,
    createNode,
    defaultTree,
    findFen,
    getBoardState,
    getGameName,
    getMemoizedBoardStateMap,
    getNodeAtPath,
    getResolvedPathLength,
    normalizeTreeHalfMoves,
    rootHalfMoves,
    treeIterator,
    treeIteratorMainLine,
    type TreeNode,
} from "@/utils/treeReducer";

const child = (fen: string, halfMoves: number): TreeNode =>
    createNode({
        fen,
        move: parseUci("e2e4")!,
        san: "e4",
        halfMoves,
    });

test("findFen distinguishes the root from a removed practice card", () => {
    const tree = defaultTree().root;
    expect(findFen(tree.fen, tree)).toEqual([]);
    expect(findFen("removed-card", tree)).toBeUndefined();
});

test("preserves a zero [%clk 0:00:00] clock as a numeric zero", () => {
    const node = createNode({
        fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
        move: parseUci("e2e4")!,
        san: "e4",
        halfMoves: 1,
        clock: 0,
    });
    expect(node.clock).toBe(0);
});

test("converts nonzero clocks from milliseconds and omits an absent clock", () => {
    expect(
        createNode({
            fen: "clocked",
            move: parseUci("e2e4")!,
            san: "e4",
            halfMoves: 1,
            clock: 5_000,
        }).clock,
    ).toBe(5);
    expect(child("without-clock", 1).clock).toBeUndefined();
});

test("tree iterators preserve depth-first sibling positions and the exact main line", () => {
    const root = defaultTree().root;
    const first = child("first", 1);
    const firstReply = child("first-reply", 2);
    const second = child("second", 1);
    first.children.push(firstReply);
    root.children.push(first, second);

    expect([...treeIterator(root)].map(({ position, node }) => [position, node.fen])).toEqual([
        [[], root.fen],
        [[0], "first"],
        [[0, 0], "first-reply"],
        [[1], "second"],
    ]);
    expect(
        [...treeIteratorMainLine(root)].map(({ position, node }) => [position, node.fen]),
    ).toEqual([
        [[], root.fen],
        [[0], "first"],
        [[0, 0], "first-reply"],
    ]);
    expect(countMainPly(root)).toBe(2);
    expect(countMainPly(second)).toBe(0);
});

test("defaultTree normalizes the root while preserving complete deterministic defaults", () => {
    const fen = "  4k3/8/8/8/8/8/8/4K3 b - - 0 1  ";
    const tree = defaultTree(fen);
    expect(tree).toMatchObject({
        dirty: false,
        position: [],
        report: { inProgress: false },
        headers: {
            id: 0,
            fen: fen.trim(),
            white: "",
            black: "",
            result: "*",
            event: "",
            site: "",
        },
        root: {
            fen: fen.trim(),
            halfMoves: 1,
            children: [],
            shapes: [],
            nags: [],
            comment: "",
        },
    });
    expect(defaultTree().root.halfMoves).toBe(0);
});

test("root move numbering derives from the FEN fullmove and side to move", () => {
    const white = "8/8/8/8/8/8/8/K6k w - - 0 23";
    const black = "8/8/8/8/8/8/8/K6k b - - 0 23";

    expect(rootHalfMoves(white)).toBe(44);
    expect(rootHalfMoves(black)).toBe(45);
    expect(defaultTree(white).root.halfMoves).toBe(44);
    expect(defaultTree(black).root.halfMoves).toBe(45);
});

test("root move numbering has a deterministic fallback for a malformed FEN", () => {
    expect(rootHalfMoves("not a FEN")).toBe(0);
    expect(defaultTree("not a FEN").root.halfMoves).toBe(0);
});

test("normalizing a branched tree completes and derives every ply from its depth", () => {
    const root = defaultTree("8/8/8/8/8/8/8/K6k b - - 0 23").root;
    const first = child("first", 1);
    const reply = child("reply", 2);
    const sibling = child("sibling", 99);
    first.children.push(reply);
    root.children.push(first, sibling);

    expect(() => normalizeTreeHalfMoves(root)).not.toThrow();
    expect([root.halfMoves, first.halfMoves, reply.halfMoves, sibling.halfMoves]).toEqual([
        45, 46, 47, 46,
    ]);
});

describe("game display name", () => {
    const headers = defaultTree().headers;

    test("uses player names when either real player is present", () => {
        expect(getGameName({ ...headers, white: "Alice", black: "Bob" })).toBe("Alice - Bob");
        expect(getGameName({ ...headers, white: "Alice", black: "" })).toBe("Alice - ");
        expect(getGameName({ ...headers, white: "?", black: "Bob" })).toBe("? - Bob");
    });

    test("falls back to event and then Unknown for placeholder players", () => {
        expect(getGameName({ ...headers, white: "?", black: "?", event: "Candidates" })).toBe(
            "Candidates",
        );
        expect(getGameName({ ...headers, white: "?", black: "?", event: "" })).toBe("Unknown");
    });
});

test("path lookup stops at the last valid node instead of crossing a missing child", () => {
    const root = defaultTree().root;
    const first = child("first", 1);
    const reply = child("reply", 2);
    first.children.push(reply);
    root.children.push(first);
    expect(getNodeAtPath(root, [0, 0])).toBe(reply);
    expect(getNodeAtPath(root, [0, 1])).toBe(first);
    expect(getNodeAtPath(root, [1])).toBe(root);
});

test.each([
    { description: "a fully resolved path", path: [0, 0], expected: 2 },
    { description: "an index equal to the child count", path: [2], expected: 0 },
    { description: "an index past the child count", path: [3], expected: 0 },
    { description: "a negative index", path: [-1], expected: 0 },
    { description: "a fractional index", path: [1.5], expected: 0 },
    { description: "a non-number index", path: ["0"], expected: 0 },
    { description: "an empty path", path: [], expected: 0 },
    { description: "an invalid index in the middle", path: [0, 1, 0], expected: 1 },
])("counts resolved indices for $description", ({ path, expected }) => {
    const root = defaultTree().root;
    const first = child("first", 1);
    first.children.push(child("reply", 2));
    root.children.push(first, child("second", 1));

    expect(getResolvedPathLength(root, path)).toBe(expected);
});

test("transposition maps retain duplicate paths and respect a non-root start path", () => {
    const root = defaultTree("root w - - 0 1").root;
    const first = child("same b - - 0 1", 1);
    const duplicate = child("same b - - 7 9", 1);
    const reply = child("reply w - - 0 2", 2);
    first.children.push(reply);
    root.children.push(first, duplicate);

    const complete = getMemoizedBoardStateMap(root);
    expect(complete["same b - -"].map(({ path }) => path)).toEqual([[0], [1]]);
    expect(complete["root w - -"][0].path).toEqual([]);

    const subtree = getMemoizedBoardStateMap(root, [0]);
    expect(Object.keys(subtree).sort()).toEqual(["reply w - -", "same b - -"]);
    expect(subtree["same b - -"][0].path).toEqual([0]);
    expect(subtree["reply w - -"][0].path).toEqual([0, 0]);
});

test("the memoized map is keyed by the whole start path, not its concatenated digits", () => {
    const root = defaultTree().root;
    const build = vi
        .spyOn(boardStateMapBuilder, "build")
        .mockImplementation(() => ({}) as ReturnType<typeof boardStateMapBuilder.build>);
    try {
        const nested = getMemoizedBoardStateMap(root, [1, 1]);
        const eleventh = getMemoizedBoardStateMap(root, [11]);

        expect(eleventh).not.toBe(nested);
        expect(build.mock.calls.map(([, start]) => start)).toEqual([[1, 1], [11]]);
    } finally {
        build.mockRestore();
    }
});

test.each([
    { board: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR", rights: "HAha" },
    { board: "rkr5/8/8/8/8/8/8/RKR5", rights: "CAca" },
])(
    "castling maps preserve occurrence order, subtree bounds and root ownership for $rights",
    ({ board, rights }) => {
        const raw = `${board} b ${rights} - 0 1`;
        const canonical = `${board} b KQkq - 4 3`;
        const root = defaultTree(raw).root;
        root.children.push(child(canonical, 2), child(raw, 2));
        const key = `${board} b KQkq -`;
        const complete = getMemoizedBoardStateMap(root);
        expect(complete[key].map(({ path }) => path)).toEqual([[], [0], [1]]);
        expect(complete[key].map(({ node }) => node.fen)).toEqual([raw, canonical, raw]);
        expect(getMemoizedBoardStateMap(root)).toBe(complete);
        expect(getMemoizedBoardStateMap(root, [1])[key].map(({ path }) => path)).toEqual([[1]]);
        const replacement = { ...root, children: [root.children[1]] };
        const rebuilt = getMemoizedBoardStateMap(replacement);
        expect(rebuilt).not.toBe(complete);
        expect(rebuilt[key].map(({ path }) => path)).toEqual([[], [0]]);
        expect(root.fen).toBe(raw);
    },
);

test("board-state identity excludes clocks even for incomplete positions", () => {
    expect(getBoardState("8/8/8/8/8/8/8/8 w - - 17 42")).toBe("8/8/8/8/8/8/8/8 w - -");
});

test("board-state identity tokenizes FEN fields the same way chessops does", () => {
    const single = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 17";
    const key = getBoardState(single);
    expect(getBoardState("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR  b KQkq - 0 17")).toBe(key);
    expect(getBoardState("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR\tb KQkq - 0 17")).toBe(key);
    expect(getBoardState("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR_b_KQkq_-_0_17")).toBe(key);
});

test("board-state identity skips construction only when castling and EP are both absent", () => {
    const parse = vi.spyOn(chessops, "positionFromFen");
    try {
        for (const [fen, expectedKey] of [
            [
                "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1",
                "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - -",
            ],
            ["4k3/8/8/8/8/8/8/4K3 b - - 0 1", "4k3/8/8/8/8/8/8/4K3 b - -"],
            ["8/8/8/8/8/8/8/8 w - - 17 42", "8/8/8/8/8/8/8/8 w - -"],
            ["synthetic w - - 0 1", "synthetic w - -"],
            ["synthetic w -", "synthetic w -"],
            ["not a", "not a"],
            ["", ""],
        ]) {
            expect(getBoardState(fen)).toBe(expectedKey);
        }
        expect(parse).not.toHaveBeenCalled();

        // Ordinary KQ claims also need interpretation, even without EP (d-20261026-08).
        for (const [fen, expected] of [
            [
                "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",
            ],
            [
                "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 17 42",
                "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",
            ],
            [
                "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w HAha - 17 42",
                "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",
            ],
            ["4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2", "4k3/8/8/3pP3/8/8/8/4K3 w - d6"],
            ["4k3/8/8/3pP3/8/8/8/4K2R w H d6 0 2", "4k3/8/8/3pP3/8/8/8/4K2R w K d6"],
            [
                "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b HAha e3 0 1",
                "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -",
            ],
            ["synthetic w KQ", "synthetic w KQ"],
            ["synthetic w KQ - 0 1", "synthetic w KQ -"],
            ["not a FEN", "not a FEN"],
        ]) {
            parse.mockClear();
            expect(getBoardState(fen)).toBe(expected);
            expect(parse).toHaveBeenCalledExactlyOnceWith(fen);
        }
    } finally {
        parse.mockRestore();
    }
});

test.each([
    {
        name: "absent capturer",
        fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
        captures: [],
        rejected: [],
    },
    {
        name: "legal capture",
        fen: "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2",
        captures: ["e5d6"],
        rejected: [],
    },
    {
        name: "file pin",
        fen: "k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 2",
        captures: [],
        rejected: ["e5d6"],
    },
    {
        name: "horizontal discovered check",
        fen: "7k/8/8/r4pPK/8/8/8/8 w - f6 0 2",
        captures: [],
        rejected: ["g5f6"],
    },
    {
        name: "one pinned and one legal capturer",
        fen: "k3r3/8/8/2PpP3/8/8/8/4K3 w - d6 0 2",
        captures: ["c5d6"],
        rejected: ["e5d6"],
    },
])("board-state EP identity follows library legality for $name", ({ fen, captures, rejected }) => {
    const [position, error] = chessops.positionFromFen(fen);
    expect(error).toBeNull();
    for (const uci of captures) expect(position!.isLegal(parseUci(uci)!)).toBe(true);
    for (const uci of rejected) expect(position!.isLegal(parseUci(uci)!)).toBe(false);
    const withoutEp = fen.replace(/ [a-h][36] /, " - ");
    const expectedKey = (captures.length ? fen : withoutEp)
        .split(/[\s_]+/)
        .slice(0, 4)
        .join(" ");
    expect(getBoardState(fen) === getBoardState(withoutEp)).toBe(captures.length === 0);
    expect(getBoardState(fen)).toBe(expectedKey);
});

test("rights correction preserves board and turn while canonicalizing castling aliases", () => {
    const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b HAha e3 17 42";
    expect(chessops.positionFromFen(fen)[1]).toBeNull();
    expect(getBoardState(fen)).toBe("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -");
    expect(getBoardState(fen)).not.toBe(getBoardState(fen.replace(" b ", " w ")));
    expect(getBoardState(fen)).toBe(getBoardState(fen.replace(" HAha ", " KQkq ")));
    expect(getBoardState(fen)).not.toBe(getBoardState(fen.replace(" HAha ", " - ")));
    const alternateBoard = "4k3/8/8/8/8/8/8/4K11R w H - 17 42";
    expect(chessops.positionFromFen(alternateBoard)[1]).toBeNull();
    expect(getBoardState(alternateBoard)).toBe("4k3/8/8/8/8/8/8/4K11R w K -");
});

test.each([
    {
        name: "Chess960 both colours",
        board: "rkr5/8/8/8/8/8/8/RKR5",
        turn: "w",
        alias: "CAca",
        canonical: "KQkq",
    },
    {
        name: "inner queenside rook",
        board: "4k3/8/8/8/8/8/8/RR2K2R",
        turn: "w",
        alias: "HB",
        canonical: "KB",
    },
    {
        name: "inner kingside rook",
        board: "4k3/8/8/8/8/8/8/3K1R1R",
        turn: "w",
        alias: "F",
        canonical: "F",
    },
    {
        name: "absent rooks with ordinary claims",
        board: "4k3/8/8/8/8/8/8/4K3",
        turn: "w",
        alias: "KQkq",
        canonical: "-",
    },
    {
        name: "absent rooks with file claims",
        board: "4k3/8/8/8/8/8/8/4K3",
        turn: "w",
        alias: "HAha",
        canonical: "-",
    },
    {
        name: "off-rank king",
        board: "4k3/8/8/8/8/8/4K3/R6R",
        turn: "w",
        alias: "KQ",
        canonical: "-",
    },
])(
    "castling identity uses actual library rights for $name",
    ({ board, turn, alias, canonical }) => {
        const fen = `${board} ${turn} ${alias} - 17 42`;
        expect(chessops.positionFromFen(fen)[1]).toBeNull();
        expect(getBoardState(fen)).toBe(`${board} ${turn} ${canonical} -`);
        expect(getBoardState(fen)).toBe(getBoardState(`${board} ${turn} ${canonical} - 0 1`));
    },
);

test.each([
    ["4k3/8/8/8/8/8/8/RR2K2R w HB - 0 1", "KQ"],
    ["4k3/8/8/8/8/8/8/3K1R1R w F - 0 1", "K"],
    ["rr2k2r/8/8/8/8/8/8/4K3 b hb - 0 1", "kq"],
])("castling identity distinguishes actual rook squares in %s", (fen, otherRights) => {
    const other = fen.replace(/ [A-Za-z]+ - /, ` ${otherRights} - `);
    expect(chessops.positionFromFen(fen)[1]).toBeNull();
    expect(chessops.positionFromFen(other)[1]).toBeNull();
    expect(getBoardState(fen)).not.toBe(getBoardState(other));
});

test.each([
    {
        name: "blocked paths",
        fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w HAha - 0 1",
        castle: "e1h1",
        rights: "KQkq",
    },
    { name: "current check", fen: "k3r3/8/8/8/8/8/8/4K2R w H - 0 1", castle: "e1h1", rights: "K" },
    {
        name: "attacked transit",
        fen: "k4r2/8/8/8/8/8/8/4K2R w H - 0 1",
        castle: "e1h1",
        rights: "K",
    },
])("castling possession survives unavailable moves from $name", ({ fen, castle, rights }) => {
    const [position, error] = chessops.positionFromFen(fen);
    expect(error).toBeNull();
    expect(position!.isLegal(parseUci(castle)!)).toBe(false);
    expect(getBoardState(fen)).toBe(fen.replace(/ [A-Za-z]+ - 0 1$/, ` ${rights} -`));
    expect(getBoardState(fen)).not.toBe(getBoardState(fen.replace(/ [A-Za-z]+ - /, " - - ")));
});

test.each([
    "8/8/8/8/8/8/8/8 w - e3 17 42",
    "8/8/8/8/8/8/8/8 w H - 17 42",
    "4k3/8/8/8/8/8/8/8 w K - 0 1",
    "4k3/8/8/8/8/8/8/8 w - e3 0 1",
    "4k3/8/8/8/8/8/8/4K3 w - invalid 0 1",
    "synthetic w KQ e3 0 1",
    "not a FEN",
    "",
])("board-state identity tolerates rejected positions without rewriting %s", (fen) => {
    expect(chessops.positionFromFen(fen)[0]).toBeNull();
    expect(getBoardState(fen)).toBe(
        fen
            .split(/[\s_]+/)
            .slice(0, 4)
            .join(" "),
    );
});
