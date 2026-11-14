import { Chess, parseUci } from "chessops";
import { makeFen } from "chessops/fen";
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
    test("uses side-specific controls instead of the shared control for progress", () => {
        const info = clockAfterE4({
            time_control: "600+5",
            white_time_control: "120+1",
            black_time_control: "300+2",
        });
        expect(info.white).toEqual({ value: 60, progress: 0.5 });
        expect(info.black).toEqual({ value: 300, progress: 1 });
    });

    test.each([
        { timeControl: undefined, expected: { value: undefined, progress: 0 } },
        { timeControl: "600+5", expected: { value: 600, progress: 1 } },
        { timeControl: "0+1", expected: { value: 0, progress: 0 } },
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
        expect(info.white).toEqual({ value: 300, progress: 1 });
        expect(info.black).toEqual({ value: 900, progress: 1 });
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
        expect(info.white).toEqual({ value: 45, progress: 45 / 120 });
        expect(info.black).toEqual({ value: 90, progress: 90 / 300 });
    });

    test.each(["-", "*", "untimed"])("handles TimeControl %s without throwing", (timeControl) => {
        const info = clockAfterE4({ time_control: timeControl });
        expect(info.white).toEqual({ value: 60, progress: 1 });
        expect(info.black).toEqual({ value: undefined, progress: 0 });
        expect(Number.isFinite(info.white.progress)).toBe(true);
        expect(Number.isFinite(info.black.progress)).toBe(true);
    });

    test.each([
        ["600+5", 600],
        ["40/9000+30", 9000],
    ] as const)("preserves progress for TimeControl %s", (timeControl, seconds) => {
        const info = clockAfterE4({ time_control: timeControl });
        expect(info.white).toEqual({ value: 60, progress: 60 / seconds });
        expect(info.black).toEqual({ value: seconds, progress: 1 });
    });

    test("falls back to the shared control for empty side-specific controls", () => {
        const info = clockAfterE4({
            time_control: "600+5",
            white_time_control: "-",
            black_time_control: "*",
        });
        expect(info.white).toEqual({ value: 60, progress: 0.1 });
        expect(info.black).toEqual({ value: 600, progress: 1 });
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
            expect(info.black).toEqual({ value: 600, progress: 1 });
        },
    );

    test.each([
        { name: "shared", headers: { time_control: "9".repeat(400) } },
        {
            name: "side-specific",
            headers: {
                time_control: "600+5",
                white_time_control: "9".repeat(400),
                black_time_control: "9".repeat(400),
            },
        },
    ])("returns zero progress for non-finite $name control seconds", ({ headers }) => {
        const info = clockAfterE4(headers);
        expect(info.white.progress).toBe(0);
        expect(info.black.progress).toBe(0);
    });

    test.each([0, 1_000])(
        "returns finite zero progress after e4 for 0+1 with live clock %s",
        (whiteTime) => {
            const info = clockAfterE4({ time_control: "0+1" }, { whiteTime });
            expect(info.white).toEqual({ value: whiteTime / 1000, progress: 0 });
            expect(info.black).toEqual({ value: 0, progress: 0 });
            expect(Number.isFinite(info.white.progress)).toBe(true);
            expect(Number.isFinite(info.black.progress)).toBe(true);
        },
    );

    test.each([0, -1_000])(
        "returns zero progress for non-positive fallback clock %s",
        (nodeClock) => {
            const info = clockAfterE4({}, { whiteTime: 1_000 }, nodeClock);
            expect(info.white).toEqual({ value: 1, progress: 0 });
        },
    );

    test("returns zero white clock when the first-move clock is 0 and there is no TimeControl", () => {
        const info = clockAfterE4({}, {}, 0);
        expect(info.white).toEqual({ value: 0, progress: 0 });
    });
});
