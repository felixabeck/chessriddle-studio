import { Chess, parseUci } from "chessops";
import { makeFen, parseFen } from "chessops/fen";
import { describe, expect, test } from "vitest";
import { getClockInfo } from "./clock";
import { createNode, defaultTree, type GameHeaders } from "./treeReducer";

function clockAfterE4(
    headers: Partial<GameHeaders>,
    liveTimes: { whiteTime?: number; blackTime?: number } = {},
    nodeClock = 60_000,
) {
    const tree = defaultTree();
    const pos = Chess.default();
    const move = parseUci("e2e4")!;
    pos.play(move);
    const node = createNode({
        fen: makeFen(pos.toSetup()),
        move,
        san: "e4",
        halfMoves: 1,
        clock: nodeClock,
    });
    tree.root.children.push(node);
    return getClockInfo({
        headers: { ...tree.headers, ...headers },
        root: tree.root,
        currentClock: node.clock,
        pos,
        position: [0],
        ...liveTimes,
    });
}

describe("getClockInfo", () => {
    test("uses side-specific controls instead of the shared control", () => {
        const info = clockAfterE4({
            time_control: "600+5",
            white_time_control: "120+1",
            black_time_control: "300+2",
        });
        expect(info.white).toEqual({ value: 60, spent: 61 });
        expect(info.black).toEqual({ value: 300 });
    });

    test.each([
        { timeControl: undefined, expected: { value: undefined } },
        { timeControl: "600+5", expected: { value: 600 } },
        { timeControl: "0+1", expected: { value: 0 } },
    ])("returns start-position defaults for $timeControl", ({ timeControl, expected }) => {
        const tree = defaultTree();
        const info = getClockInfo({
            headers: { ...tree.headers, time_control: timeControl },
            root: tree.root,
            currentClock: undefined,
            pos: Chess.default(),
            position: [],
        });
        expect(info.white).toEqual(expected);
        expect(info.black).toEqual(expected);
    });

    test.each([
        { name: "shared and side-specific", timeControl: "600" },
        { name: "side-specific only", timeControl: undefined },
    ])("uses $name controls at the start", ({ timeControl }) => {
        const tree = defaultTree();
        const info = getClockInfo({
            headers: {
                ...tree.headers,
                time_control: timeControl,
                white_time_control: "300",
                black_time_control: "900",
            },
            root: tree.root,
            currentClock: undefined,
            pos: Chess.default(),
            position: [],
        });
        expect(info.white).toEqual({ value: 300 });
        expect(info.black).toEqual({ value: 900 });
    });

    test("live millisecond values override node clocks and initial defaults for both sides", () => {
        const info = clockAfterE4(
            {
                time_control: "600+5",
                white_time_control: "120+1",
                black_time_control: "300+2",
            },
            { whiteTime: 45_000, blackTime: 90_000 },
        );
        // The move time comes from the recorded clocks, not the running live clock.
        expect(info.white).toEqual({ value: 45, spent: 61 });
        expect(info.black).toEqual({ value: 90 });
    });

    test.each(["-", "*", "untimed"])("handles TimeControl %s without throwing", (timeControl) => {
        const info = clockAfterE4({ time_control: timeControl });
        expect(info.white).toEqual({ value: 60 });
        expect(info.black).toEqual({ value: undefined });
    });

    test.each([
        ["600+5", 600, 5],
        ["40/9000+30", 9000, 30],
    ] as const)("reads the start time from TimeControl %s", (timeControl, seconds, increment) => {
        const info = clockAfterE4({ time_control: timeControl });
        expect(info.white).toEqual({ value: 60, spent: seconds + increment - 60 });
        expect(info.black).toEqual({ value: seconds });
    });

    test("falls back to the shared control for empty side-specific controls", () => {
        const info = clockAfterE4({
            time_control: "600+5",
            white_time_control: "-",
            black_time_control: "*",
        });
        expect(info.white).toEqual({ value: 60, spent: 545 });
        expect(info.black).toEqual({ value: 600 });
    });

    test.each(["*", "-"])(
        "uses the shared control at the start for BlackTimeControl %s",
        (blackTimeControl) => {
            const tree = defaultTree();
            const info = getClockInfo({
                headers: {
                    ...tree.headers,
                    time_control: "600+5",
                    black_time_control: blackTimeControl,
                },
                root: tree.root,
                currentClock: undefined,
                pos: Chess.default(),
                position: [],
            });
            expect(info.black).toEqual({ value: 600 });
        },
    );

    test.each([0, 1_000])(
        "lets a live clock override the node clock after e4 for 0+1: %s",
        (whiteTime) => {
            const info = clockAfterE4({ time_control: "0+1" }, { whiteTime });
            expect(info.white).toEqual({ value: whiteTime / 1000 });
            expect(info.black).toEqual({ value: 0 });
        },
    );

    test("returns zero white clock when the first-move clock is 0 and there is no TimeControl", () => {
        const info = clockAfterE4({}, {}, 0);
        expect(info.white).toEqual({ value: 0 });
    });
});

describe("move time spent", () => {
    // The first plies of a real 2+1 chess.com game: b3 1:59.9, d5 1:59.2, Bb2 2:00.8, Nf6 1:59.4.
    const plies: [string, number][] = [
        ["b2b3", 119_900],
        ["d7d5", 119_200],
        ["c1b2", 120_800],
        ["g8f6", 119_400],
    ];

    function line(clocks: (number | undefined)[]) {
        const tree = defaultTree();
        const pos = Chess.default();
        let parent = tree.root;
        const nodes = clocks.map((clock, i) => {
            const move = parseUci(plies[i][0])!;
            pos.play(move);
            const node = createNode({
                fen: makeFen(pos.toSetup()),
                move,
                san: plies[i][0],
                halfMoves: i + 1,
                clock,
            });
            parent.children.push(node);
            parent = node;
            return { node, pos: pos.clone() };
        });
        return { tree, nodes };
    }

    function infoAt(
        built: ReturnType<typeof line>,
        ply: number,
        headers: Partial<GameHeaders> = { time_control: "120+1" },
    ) {
        const { node, pos } = built.nodes[ply - 1];
        return getClockInfo({
            headers: { ...built.tree.headers, ...headers },
            root: built.tree.root,
            currentClock: node.clock,
            pos,
            position: Array(ply).fill(0),
        });
    }

    test.each([
        [1, "white", 1.1],
        [2, "black", 1.8],
        [3, "white", 0.1],
        [4, "black", 0.8],
    ] as const)("after ply %i only %s has a move time, %f s", (ply, mover, spent) => {
        const info = infoAt(line(plies.map(([, clock]) => clock)), ply);
        const other = mover === "white" ? "black" : "white";
        expect(info[mover].spent).toBe(spent);
        expect(info[other]).not.toHaveProperty("spent");
    });

    test("has no move time when a clock in the pair is missing", () => {
        const built = line([119_900, 119_200, 120_800, undefined]);
        expect(infoAt(built, 4).black.spent).toBeUndefined();
        const gap = line([undefined, 119_200, 120_800]);
        expect(infoAt(gap, 3).white.spent).toBeUndefined();
    });

    test("has no first-move time without a time control", () => {
        expect(infoAt(line([119_900]), 1, {}).white.spent).toBeUndefined();
    });

    test("keeps a move that took no time, such as a premove", () => {
        expect(infoAt(line([119_900, 119_200, 120_900]), 3).white.spent).toBe(0);
    });

    test("reports a live clock's sub-tenth rise as 0, never -0", () => {
        expect(Object.is(infoAt(line([119_900, 119_200, 120_940]), 3).white.spent, 0)).toBe(true);
    });

    test("has no move time when the clock rose by more than the increment", () => {
        expect(infoAt(line([119_900, 119_200, 125_000]), 3).white.spent).toBeUndefined();
    });

    test("uses the starting time for each side's first move from a Black-to-move start", () => {
        const fen = "rnbqkbnr/pppppppp/8/8/8/1P6/P1PPPPPP/RNBQKBNR b KQkq - 0 1";
        const tree = defaultTree(fen);
        const pos = Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
        const moves: [string, number][] = [
            ["d7d5", 118_000],
            ["c1b2", 119_500],
            ["g8f6", 117_000],
        ];
        let parent = tree.root;
        const states = moves.map(([uci, clock], i) => {
            const move = parseUci(uci)!;
            pos.play(move);
            const node = createNode({
                fen: makeFen(pos.toSetup()),
                move,
                san: uci,
                halfMoves: i + 1,
                clock,
            });
            parent.children.push(node);
            parent = node;
            return { node, pos: pos.clone() };
        });
        const at = (ply: number) =>
            getClockInfo({
                headers: { ...tree.headers, time_control: "120+1" },
                root: tree.root,
                currentClock: states[ply - 1].node.clock,
                pos: states[ply - 1].pos,
                position: Array(ply).fill(0),
            });
        expect(at(1).black.spent).toBe(3);
        expect(at(2).white.spent).toBe(1.5);
        expect(at(3).black.spent).toBe(2);
    });
});
