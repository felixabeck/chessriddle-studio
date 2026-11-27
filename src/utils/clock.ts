import type { Chess } from "chessops";
import type { TFunction } from "i18next";
import { match } from "ts-pattern";
import { type GameHeaders, getNodeAtPath, treeIterator, type TreeNode } from "./treeReducer";

export const MAX_CLOCK_SECONDS = 36_000;

export type TimeControlField = {
    seconds: number;
    increment?: number;
    moves?: number;
};

export type TimeControl = TimeControlField[];

export type ClockInputParseResult =
    | { kind: "empty" }
    | { kind: "valid"; seconds: number }
    | { kind: "invalid" };

type ClockInfo = {
    /** Remaining time in seconds. */
    value: number | undefined;
    /**
     * Seconds the side that just moved spent on the move into the current position: its previous
     * clock plus the increment (and any completed-period bonus) minus its clock now. Set only for
     * that side, only when both clocks are known, and never negative.
     */
    spent?: number;
};

const CLOCK_LEADING_PART_PATTERN = /^\d{1,6}$/;
const CLOCK_TWO_DIGIT_SEXAGESIMAL_PATTERN = /^[0-5]\d$/;
const TIME_CONTROL_FIELD_PATTERN = /^(?:(\d{1,6})\/)?(\d{1,6})(?:\+(\d{1,6}))?$/;
const MAX_TIME_CONTROL_MOVES = 500;
const MAX_TIME_CONTROL_SECONDS = 86_400;

/**
 * Parses a typed clock input into seconds (`"86"` -> 5160, `"1:26"` -> 5160, `"1:26:30"` -> 5190),
 * distinguishing blank input (`empty`) from malformed or out-of-range input (`invalid`).
 */
export function parseClockInput(raw: string): ClockInputParseResult {
    const trimmed = raw.trim();
    if (trimmed === "") return { kind: "empty" };

    const parts = trimmed.split(":");
    if (parts.length === 1) {
        if (!CLOCK_LEADING_PART_PATTERN.test(parts[0])) return { kind: "invalid" };
        const seconds = Number(parts[0]) * 60;
        return seconds <= MAX_CLOCK_SECONDS ? { kind: "valid", seconds } : { kind: "invalid" };
    }

    if (parts.length === 2 || parts.length === 3) {
        if (!CLOCK_LEADING_PART_PATTERN.test(parts[0])) return { kind: "invalid" };
        if (!CLOCK_TWO_DIGIT_SEXAGESIMAL_PATTERN.test(parts[1])) return { kind: "invalid" };
        if (parts.length === 3 && !CLOCK_TWO_DIGIT_SEXAGESIMAL_PATTERN.test(parts[2])) {
            return { kind: "invalid" };
        }
        const hours = Number(parts[0]);
        const minutes = Number(parts[1]);
        const secs = parts.length === 3 ? Number(parts[2]) : 0;
        const total = hours * 3600 + minutes * 60 + secs;
        return total <= MAX_CLOCK_SECONDS ? { kind: "valid", seconds: total } : { kind: "invalid" };
    }

    return { kind: "invalid" };
}

/** Formats a stored clock value (in seconds) as `h:mm`, or `h:mm:ss` when seconds are non-zero. */
export function formatClockInput(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "";
    const whole = Math.floor(seconds);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const secs = whole % 60;
    const base = `${hours}:${String(minutes).padStart(2, "0")}`;
    return secs === 0 ? base : `${base}:${String(secs).padStart(2, "0")}`;
}

/**
 * Parses a PGN `TimeControl` tag strictly. Every `:`-separated period must match
 * `[moves/]seconds[+increment]` within range; any invalid period invalidates the whole control.
 */
export function parseTimeControl(timeControl: string): TimeControl | null {
    const fields = timeControl.split(":");
    const timeControlFields: TimeControl = [];
    for (const field of fields) {
        const matched = field.match(TIME_CONTROL_FIELD_PATTERN);
        if (!matched) return null;

        let moves: number | undefined;
        if (matched[1] !== undefined) {
            moves = Number(matched[1]);
            if (!Number.isInteger(moves) || moves < 1 || moves > MAX_TIME_CONTROL_MOVES) {
                return null;
            }
        }

        const seconds = Number(matched[2]);
        if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_TIME_CONTROL_SECONDS) {
            return null;
        }

        let increment: number | undefined;
        if (matched[3] !== undefined) {
            increment = Number(matched[3]);
            if (
                !Number.isInteger(increment) ||
                increment < 0 ||
                increment > MAX_TIME_CONTROL_SECONDS
            ) {
                return null;
            }
        }

        if (seconds < 1 && (increment ?? 0) < 1) return null;

        const timeControlField: TimeControlField = {
            seconds: seconds * 1000,
        };
        if (increment !== undefined) {
            timeControlField.increment = increment * 1000;
        }
        if (moves !== undefined) {
            timeControlField.moves = moves;
        }
        timeControlFields.push(timeControlField);
    }
    return timeControlFields.length > 0 ? timeControlFields : null;
}

/** Resolves the parsed time control for one side: side-specific tag if valid, else shared tag. */
export function resolveTimeControl(
    headers: Pick<GameHeaders, "time_control" | "white_time_control" | "black_time_control">,
    side: "white" | "black",
): TimeControl | null {
    const sideTag = side === "white" ? headers.white_time_control : headers.black_time_control;
    if (sideTag) {
        const parsedSide = parseTimeControl(sideTag);
        if (parsedSide) return parsedSide;
    }
    return headers.time_control ? parseTimeControl(headers.time_control) : null;
}

/** First period of each side's resolved control (`seconds`/`increment` in milliseconds). */
export function getSideTimeControlFields(
    headers: Pick<GameHeaders, "time_control" | "white_time_control" | "black_time_control">,
): { white: TimeControlField | null; black: TimeControlField | null } {
    return {
        white: resolveTimeControl(headers, "white")?.[0] ?? null,
        black: resolveTimeControl(headers, "black")?.[0] ?? null,
    };
}

/** True when any node in the tree (main line or variation) carries a clock value. */
export function hasTreeClock(root: TreeNode): boolean {
    for (const { node } of treeIterator(root)) {
        if (node.clock !== undefined) return true;
    }
    return false;
}

function formatDuration(seconds: number, t: TFunction): string {
    if (seconds < 60) return t("Common.SecondsShort", { value: seconds });
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    const minutesText = t("TimeControl.MinutesShort", { minutes });
    if (remainingSeconds === 0) return minutesText;
    return `${minutesText} ${t("Common.SecondsShort", { value: remainingSeconds })}`;
}

function formatPeriodBase(field: TimeControlField, index: number, t: TFunction): string {
    const time = formatDuration(field.seconds / 1000, t);
    if (index === 0) {
        return field.moves !== undefined
            ? t("TimeControl.MovesInTime", { count: field.moves, time })
            : time;
    }
    return field.moves !== undefined
        ? t("TimeControl.ThenMovesInTime", { count: field.moves, time })
        : t("TimeControl.ThenTime", { time });
}

/** Formats a parsed or raw PGN time-control tag in plain localized words; unparseable tags stay raw. */
export function formatTimeControl(timeControl: string | TimeControl, t: TFunction): string {
    const fields = typeof timeControl === "string" ? parseTimeControl(timeControl) : timeControl;
    if (!fields || fields.length === 0) {
        return typeof timeControl === "string" ? timeControl : "";
    }

    const increments = fields.map((field) => (field.increment ?? 0) / 1000);
    const allSameIncrement = increments.every((inc) => inc === increments[0]);

    if (fields.length > 1 && allSameIncrement) {
        const periods = fields.map((field, index) => formatPeriodBase(field, index, t)).join(", ");
        if (increments[0] > 0) {
            return t("TimeControl.PeriodsWithIncrement", {
                periods,
                increment: t("Common.SecondsShort", { value: increments[0] }),
            });
        }
        return periods;
    }

    return fields
        .map((field, index) => {
            const base = formatPeriodBase(field, index, t);
            const inc = increments[index];
            return inc > 0
                ? t("TimeControl.WithIncrement", {
                      base,
                      increment: t("Common.SecondsShort", { value: inc }),
                  })
                : base;
        })
        .join(", ");
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
    const whiteTc = resolveTimeControl(headers, "white");
    const blackTc = resolveTimeControl(headers, "black");

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
            whiteSeconds = whiteTc[0].seconds / 1000;
        }
        if (blackSeconds === undefined && blackTc) {
            blackSeconds = blackTc[0].seconds / 1000;
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

function periodTimingForMove(
    tc: TimeControl,
    moveNumber: number,
): { incrementSeconds: number; bonusSeconds: number } {
    let cumulativeMoves = 0;
    for (let i = 0; i < tc.length; i++) {
        const period = tc[i];
        if (period.moves === undefined || i === tc.length - 1) {
            return {
                incrementSeconds: (period.increment ?? 0) / 1000,
                bonusSeconds: 0,
            };
        }
        cumulativeMoves += period.moves;
        if (moveNumber <= cumulativeMoves) {
            return {
                incrementSeconds: (period.increment ?? 0) / 1000,
                bonusSeconds: moveNumber === cumulativeMoves ? tc[i + 1].seconds / 1000 : 0,
            };
        }
    }
    return { incrementSeconds: 0, bonusSeconds: 0 };
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
    tc: TimeControl | null;
}): number | undefined {
    if (position.length === 0 || currentClock === undefined) return undefined;
    const previous =
        position.length > 2
            ? getNodeAtPath(root, position.slice(0, -2)).clock
            : tc
              ? tc[0].seconds / 1000
              : undefined;
    if (previous === undefined) return undefined;

    const node = getNodeAtPath(root, position);
    const moveNumber = Math.max(1, Math.ceil(node.halfMoves / 2));
    const { incrementSeconds, bonusSeconds } = tc
        ? periodTimingForMove(tc, moveNumber)
        : { incrementSeconds: 0, bonusSeconds: 0 };
    const spent = previous + incrementSeconds + bonusSeconds - currentClock;
    // Clocks carry tenths; round away floating-point residue such as 1.0999999. Adding 0 turns a
    // -0 from a live clock's sub-tenth rounding into 0, which would otherwise print as "-0.0".
    const rounded = Math.round(spent * 10) / 10 + 0;
    return rounded >= 0 ? rounded : undefined;
}
