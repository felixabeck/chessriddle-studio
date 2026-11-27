import { Chess, parseUci } from "chessops";
import { makeFen, parseFen } from "chessops/fen";
import type { TFunction } from "i18next";
import { describe, expect, test } from "vitest";
import { catalogueI18n, shippedCatalogues } from "@/tests/catalogues";
import {
    formatClockInput,
    formatTimeControl,
    getClockInfo,
    hasTreeClock,
    MAX_CLOCK_SECONDS,
    parseClockInput,
    parseTimeControl,
    resolveTimeControl,
} from "./clock";
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

    function playStandardMoves(count: number, clocks: (number | undefined)[], startFen?: string) {
        const tree = defaultTree(startFen);
        const pos = startFen
            ? Chess.fromSetup(parseFen(startFen).unwrap()).unwrap()
            : Chess.default();
        let parent = tree.root;
        const nodes: { node: ReturnType<typeof createNode>; pos: Chess }[] = [];
        for (let i = 0; i < count; i++) {
            const dests = pos.allDests();
            let chosen: ReturnType<typeof parseUci> | undefined;
            for (const [from, targets] of dests) {
                for (const to of targets) {
                    chosen = { from, to };
                    break;
                }
                if (chosen) break;
            }
            if (!chosen) break;
            // Repeat knight moves to avoid stalemate/checkmate across 80+ plies.
            const knight =
                pos.turn === "white"
                    ? i % 4 === 0
                        ? "g1f3"
                        : "f3g1"
                    : i % 4 === 1
                      ? "g8f6"
                      : "f6g8";
            const move = parseUci(knight)!;
            const legalMove = pos.isLegal(move) ? move : chosen;
            const san = knight;
            pos.play(legalMove);
            const node = createNode({
                fen: makeFen(pos.toSetup()),
                move: legalMove,
                san,
                halfMoves: parent.halfMoves + 1,
                clock: clocks[i],
            });
            parent.children.push(node);
            parent = node;
            nodes.push({ node, pos: pos.clone() });
        }
        return { tree, nodes };
    }

    test("adds the next-period bonus on completing move 40 and uses period 2 afterwards", () => {
        const clocks = Array<number | undefined>(82).fill(undefined);
        // White move 39 (ply 77), White move 40 (ply 79), White move 41 (ply 81).
        clocks[76] = 1_200_000;
        clocks[78] = 2_900_000; // 1200 + 30 + 1800 - 2900 = 130 s spent
        clocks[80] = 2_880_000; // 2900 + 10 - 2880 = 30 s spent (period 2 increment 10 s)
        const built = playStandardMoves(81, clocks);
        const headers = { time_control: "40/5400+30:1800+10" };

        expect(infoAt(built, 79, headers).white.spent).toBe(130);
        expect(infoAt(built, 81, headers).white.spent).toBe(30);
    });

    test("anchors multi-period move numbering to a non-standard start FEN", () => {
        // Start at Black's move 39 (root halfMoves = 77).
        const startFen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 39";
        const clocks = [
            1_000_000, // ply 1: Black 39... (halfMoves = 78 -> move 39)
            2_980_000, // ply 2: White 40. (halfMoves = 79 -> move 40: 5400 + 30 + 1800 - 2980 = 4250 s)
            2_750_000, // ply 3: Black 40... (halfMoves = 80 -> move 40: 1000 + 30 + 1800 - 2750 = 80 s)
            2_950_000, // ply 4: White 41. (halfMoves = 81 -> move 41: 2980 + 10 - 2950 = 40 s)
        ];
        const built = playStandardMoves(4, clocks, startFen);
        const headers = { time_control: "40/5400+30:1800+10" };

        expect(infoAt(built, 1, headers).black.spent).toBe(5400 + 30 - 1000);
        expect(infoAt(built, 2, headers).white.spent).toBe(5400 + 30 + 1800 - 2980);
        expect(infoAt(built, 3, headers).black.spent).toBe(1000 + 30 + 1800 - 2750);
        expect(infoAt(built, 4, headers).white.spent).toBe(2980 + 10 - 2950);
    });
});

describe("parseClockInput and formatClockInput", () => {
    test("formats stored seconds and round-trips through parseClockInput", () => {
        expect(formatClockInput(5160)).toBe("1:26");
        expect(formatClockInput(3900)).toBe("1:05");
        expect(formatClockInput(5190)).toBe("1:26:30");
        expect(formatClockInput(0)).toBe("0:00");
        expect(formatClockInput(MAX_CLOCK_SECONDS)).toBe("10:00");

        for (const seconds of [0, 1, 59, 60, 3540, 3900, 5160, 5190, MAX_CLOCK_SECONDS]) {
            expect(parseClockInput(formatClockInput(seconds))).toEqual({
                kind: "valid",
                seconds,
            });
        }
        expect(formatClockInput(-1)).toBe("");
        expect(formatClockInput(Number.NaN)).toBe("");
    });

    test.each([
        ["86", 5160],
        [" 86 ", 5160],
        ["1:26", 5160],
        ["1:26:30", 5190],
        ["0:59", 3540],
        ["600", 36_000],
        ["10:00", 36_000],
        ["10:00:00", 36_000],
    ] as const)("parses %j to %i seconds", (input, seconds) => {
        expect(parseClockInput(input)).toEqual({ kind: "valid", seconds });
    });

    test.each(["", "   ", "\t\n"])("treats %j as empty", (input) => {
        expect(parseClockInput(input)).toEqual({ kind: "empty" });
    });

    test.each([
        "601",
        "10:00:01",
        "1:60",
        "1:00:60",
        "1:5",
        "1:005",
        "abc",
        "-5",
        "1.5",
        "1:20:30:40",
        "1 : 26",
        "9".repeat(400),
        "0".repeat(400),
    ])("rejects invalid clock input %j", (input) => {
        expect(parseClockInput(input)).toEqual({ kind: "invalid" });
    });
});

describe("parseTimeControl and resolveTimeControl", () => {
    test.each([
        "90 min",
        "5400+30:garbage",
        "0/5400",
        "501/5400",
        "?",
        "-",
        "*1800",
        "0",
        "0+0",
        "86401",
        "5400+86401",
        "",
        "9".repeat(400),
        "0".repeat(400),
    ])("strict parseTimeControl rejects %j as null", (tag) => {
        expect(parseTimeControl(tag)).toBeNull();
    });

    test("keeps valid tags and 0+1 working", () => {
        expect(parseTimeControl("0+1")).toEqual([{ seconds: 0, increment: 1000 }]);
        expect(parseTimeControl("600+5")).toEqual([{ seconds: 600_000, increment: 5000 }]);
        expect(parseTimeControl("40/5400+30:1800+30")).toEqual([
            { moves: 40, seconds: 5_400_000, increment: 30_000 },
            { seconds: 1_800_000, increment: 30_000 },
        ]);
    });

    test("resolveTimeControl falls back to the shared tag when the side tag is unparseable", () => {
        const headers = {
            time_control: "600+5",
            white_time_control: "90 min",
            black_time_control: "300+2",
        };
        expect(resolveTimeControl(headers, "white")).toEqual([
            { seconds: 600_000, increment: 5000 },
        ]);
        expect(resolveTimeControl(headers, "black")).toEqual([
            { seconds: 300_000, increment: 2000 },
        ]);
        expect(
            resolveTimeControl({ time_control: "?", white_time_control: "garbage" }, "white"),
        ).toBeNull();
    });
});

describe("hasTreeClock", () => {
    test("detects clocks on main line and in variations only", () => {
        const empty = defaultTree();
        expect(hasTreeClock(empty.root)).toBe(false);

        const move1 = createNode({
            fen: empty.root.fen,
            move: parseUci("e2e4")!,
            san: "e4",
            halfMoves: 1,
        });
        const variation = createNode({
            fen: empty.root.fen,
            move: parseUci("d2d4")!,
            san: "d4",
            halfMoves: 1,
            clock: 0,
        });
        empty.root.children.push(move1, variation);
        expect(hasTreeClock(empty.root)).toBe(true);
    });
});

describe("formatTimeControl", () => {
    test("formats every time-control shape in English and returns raw text when unparseable", async () => {
        const i18n = await catalogueI18n("en-US");
        const t = i18n.t.bind(i18n) as TFunction;

        expect(formatTimeControl("5400+30", t)).toBe("90 min + 30 s per move");
        expect(formatTimeControl("40/5400+30:1800+30", t)).toBe(
            "40 moves in 90 min, then 30 min, + 30 s per move",
        );
        expect(formatTimeControl("40/5400+30:900+30", t)).toBe(
            "40 moves in 90 min, then 15 min, + 30 s per move",
        );
        expect(formatTimeControl("3600+30", t)).toBe("60 min + 30 s per move");
        expect(formatTimeControl("600", t)).toBe("10 min");
        expect(formatTimeControl("0+1", t)).toBe("0 s + 1 s per move");
        expect(formatTimeControl("45", t)).toBe("45 s");
        expect(formatTimeControl("90", t)).toBe("1 min 30 s");
        expect(formatTimeControl("40/5400+30", t)).toBe("40 moves in 90 min + 30 s per move");
        expect(formatTimeControl("1/60", t)).toBe("1 move in 1 min");
        expect(formatTimeControl("40/5400+30:1800+10", t)).toBe(
            "40 moves in 90 min + 30 s per move, then 30 min + 10 s per move",
        );
        expect(formatTimeControl("40/7200:20/3600:900+30", t)).toBe(
            "40 moves in 120 min, then 20 moves in 60 min, then 15 min + 30 s per move",
        );
        const zeroIncMultiPeriod = formatTimeControl("40/7200:1800", t);
        expect(zeroIncMultiPeriod).toBe("40 moves in 120 min, then 30 min");
        expect(zeroIncMultiPeriod).not.toContain("+ 0 s per move");
        expect(formatTimeControl("?", t)).toBe("?");
        expect(formatTimeControl("90 min", t)).toBe("90 min");
    });

    test("formats every shape against every shipped catalogue with fallback disabled", async () => {
        const samples = [
            "5400+30",
            "40/5400+30:1800+30",
            "40/5400+30:900+30",
            "3600+30",
            "600",
            "0+1",
            "45",
            "90",
            "1/60",
            "40/5400+30:1800+10",
            "40/7200:20/3600:900+30",
        ];

        for (const { locale } of shippedCatalogues()) {
            const instance = await catalogueI18n(locale as Parameters<typeof catalogueI18n>[0]);
            const t = instance.t.bind(instance) as TFunction;
            for (const sample of samples) {
                const text = formatTimeControl(sample, t);
                expect({
                    locale,
                    sample,
                    text,
                    nonEmpty: text.length > 0,
                    noRawKey: !text.includes("TimeControl.") && !text.includes("Common."),
                    noUnresolvedPlaceholder: !/\{\{|\}\}/.test(text),
                }).toMatchObject({
                    nonEmpty: true,
                    noRawKey: true,
                    noUnresolvedPlaceholder: true,
                });
            }
        }
    });
});
