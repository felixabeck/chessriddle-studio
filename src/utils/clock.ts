import type { Chess } from "chessops";
import { match } from "ts-pattern";
import { type GameHeaders, getNodeAtPath, type TreeNode } from "./treeReducer";

export type TimeControlField = {
    seconds: number;
    increment?: number;
    moves?: number;
};

type TimeControl = TimeControlField[];

type ClockInfo = {
    /** Remaining time in seconds. */
    value: number | undefined;
    /**
     * Seconds the side that just moved spent on the move into the current position: its previous
     * clock plus the increment minus its clock now. Set only for that side, only when both clocks
     * are known, and never negative (a clock that rose by more than the increment is not a move time).
     */
    spent?: number;
};

function parseTimeControl(timeControl: string): TimeControl | null {
    const fields = timeControl.split(":");
    const timeControlFields: TimeControl = [];
    for (const field of fields) {
        const match = field.match(/(?:(\d+)\/)?(\d+)(?:\+(\d+))?/);
        if (!match) {
            continue;
        }
        const moves = match[1];
        const seconds = match[2];
        const increment = match[3];
        const timeControlField: TimeControlField = {
            seconds: Number.parseInt(seconds) * 1000,
        };
        if (increment) {
            timeControlField.increment = Number.parseInt(increment) * 1000;
        }
        if (moves) {
            timeControlField.moves = Number.parseInt(moves);
        }
        timeControlFields.push(timeControlField);
    }
    return timeControlFields.length > 0 ? timeControlFields : null;
}

export function getClockInfo({
    headers,
    root,
    currentClock,
    pos,
    position,
    whiteTime,
    blackTime,
}: {
    headers: GameHeaders;
    root: TreeNode;
    currentClock: number | undefined;
    pos: Chess | null;
    position: number[];
    whiteTime?: number;
    blackTime?: number;
}): {
    white: ClockInfo;
    black: ClockInfo;
} {
    const timeControl = headers.time_control ? parseTimeControl(headers.time_control) : null;

    const whiteTc =
        (headers.white_time_control
            ? parseTimeControl(headers.white_time_control)?.[0]
            : undefined) ??
        timeControl?.[0] ??
        null;
    const blackTc =
        (headers.black_time_control
            ? parseTimeControl(headers.black_time_control)?.[0]
            : undefined) ??
        timeControl?.[0] ??
        null;

    let { whiteSeconds, blackSeconds } = match(pos?.turn)
        .with("white", () => ({
            whiteSeconds: getNodeAtPath(root, position.slice(0, -1))?.clock,
            blackSeconds: currentClock,
        }))
        .with("black", () => ({
            whiteSeconds: currentClock,
            blackSeconds: getNodeAtPath(root, position.slice(0, -1))?.clock,
        }))
        .otherwise(() => {
            return {
                whiteSeconds: undefined,
                blackSeconds: undefined,
            };
        });
    if (position.length <= 1) {
        if (whiteSeconds === undefined && whiteTc) {
            whiteSeconds = whiteTc.seconds / 1000;
        }
        if (blackSeconds === undefined && blackTc) {
            blackSeconds = blackTc.seconds / 1000;
        }
    }
    const spent = moveTimeSpent({
        root,
        position,
        currentClock,
        tc: pos?.turn === "white" ? blackTc : whiteTc,
    });
    if (whiteTime !== undefined) {
        whiteSeconds = whiteTime / 1000;
    }
    if (blackTime !== undefined) {
        blackSeconds = blackTime / 1000;
    }

    return {
        white: {
            value: whiteSeconds,
            ...(pos?.turn === "black" && spent !== undefined ? { spent } : {}),
        },
        black: {
            value: blackSeconds,
            ...(pos?.turn === "white" && spent !== undefined ? { spent } : {}),
        },
    };
}

/**
 * The mover's time on the move into `position`. Its previous clock sits two plies up the path; for
 * each side's first move (the first two plies from any start FEN, whichever colour moves first) it is
 * the control's starting time instead.
 */
function moveTimeSpent({
    root,
    position,
    currentClock,
    tc,
}: {
    root: TreeNode;
    position: number[];
    currentClock: number | undefined;
    tc: TimeControlField | null;
}): number | undefined {
    if (position.length === 0 || currentClock === undefined) return undefined;
    const previous =
        position.length > 2
            ? getNodeAtPath(root, position.slice(0, -2)).clock
            : tc
              ? tc.seconds / 1000
              : undefined;
    if (previous === undefined) return undefined;
    const spent = previous + (tc?.increment ?? 0) / 1000 - currentClock;
    // Clocks carry tenths; round away floating-point residue such as 1.0999999. Adding 0 turns a
    // -0 from a live clock's sub-tenth rounding into 0, which would otherwise print as "-0.0".
    const rounded = Math.round(spent * 10) / 10 + 0;
    return rounded >= 0 ? rounded : undefined;
}
