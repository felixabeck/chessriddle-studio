import { Chess, parseUci } from "chessops";
import { makeFen } from "chessops/fen";
import { describe, expect, test } from "vitest";
import { getClockInfo } from "./clock";
import { createNode, defaultTree, type GameHeaders } from "./treeReducer";

function clockAfterE4(headers: Partial<GameHeaders>) {
    const tree = defaultTree();
    const pos = Chess.default();
    const move = parseUci("e2e4")!;
    pos.play(move);
    const node = createNode({
        fen: makeFen(pos.toSetup()),
        move,
        san: "e4",
        halfMoves: 1,
        clock: 60_000,
    });
    tree.root.children.push(node);
    return getClockInfo({
        headers: { ...tree.headers, ...headers },
        root: tree.root,
        currentClock: node.clock,
        pos,
        position: [0],
    });
}

describe("getClockInfo", () => {
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
});
