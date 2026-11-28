import { describe, expect, test } from "vitest";
import {
    capitalize,
    formatBytes,
    formatDecimal,
    formatMoveNumber,
    formatNumberedMove,
    MOVE_NUMBER_NO_BREAK,
    formatNodes,
    formatRelativeTime,
    formatReviewInterval,
    formatThemeLabel,
    formatTime,
    getInitials,
    numberMoves,
    roundKeepSum,
} from "./format";

describe("formatRelativeTime", () => {
    const now = Date.UTC(2026, 10, 11, 12);
    test.each([
        [0, "now", "jetzt"],
        [-45, "45 seconds ago", "vor 45 Sekunden"],
        [45, "in 45 seconds", "in 45 Sekunden"],
        [-60, "1 minute ago", "vor 1 Minute"],
        [120, "in 2 minutes", "in 2 Minuten"],
        [-3600, "1 hour ago", "vor 1 Stunde"],
        [3 * 3600, "in 3 hours", "in 3 Stunden"],
        [-24 * 3600, "yesterday", "gestern"],
        [24 * 3600, "tomorrow", "morgen"],
        [-29 * 24 * 3600, "29 days ago", "vor 29 Tagen"],
        [-30 * 24 * 3600, "last month", "letzten Monat"],
        [60 * 24 * 3600, "in 2 months", "in 2 Monaten"],
        [-360 * 24 * 3600, "last year", "letztes Jahr"],
        [720 * 24 * 3600, "in 2 years", "in 2 Jahren"],
    ])("formats offset %i seconds in English and German", (seconds, english, german) => {
        expect(formatRelativeTime(now + seconds * 1000, now, "en-US")).toBe(english);
        expect(formatRelativeTime(now + seconds * 1000, now, "de-DE")).toBe(german);
    });
});

describe("formatReviewInterval", () => {
    const now = Date.UTC(2026, 10, 11, 12);
    test.each([
        [20_000, "< 1 min", "< 1 Min."],
        [59_999, "1 min", "1 Min."],
        [10 * 60_000, "10 min", "10 Min."],
        [5 * 3600_000, "5 hr", "5 Std."],
        [3 * 24 * 3600_000, "3 days", "3 Tg."],
        [90 * 24 * 3600_000, "3 mths", "3 Mon."],
    ])("formats interval %i ms in en-US and de-DE", (ms, english, german) => {
        expect(formatReviewInterval(now + ms, now, "en-US")).toBe(english);
        expect(formatReviewInterval(now + ms, now, "de-DE")).toBe(german);
    });
});

describe("formatDecimal", () => {
    test("formats numbers according to locale", () => {
        expect(formatDecimal(21, "en-US")).toBe("21.0");
        expect(formatDecimal(21, "de-DE")).toBe("21,0");
    });
});

describe("formatTime", () => {
    test.each([
        ["en-US", 2_549, "2.5s"],
        ["de-DE", 2_549, "2,5 Sek."],
    ])("truncates sub-minute elapsed time in %s", (locale, ms, expected) => {
        expect(formatTime(ms, locale)).toBe(expected);
    });

    test.each([
        ["en-US", 65_349, "1:05.3"],
        ["de-DE", 65_349, "1:05,3"],
    ])(
        "formats minute-plus elapsed time in %s with locale decimal separator",
        (locale, ms, expected) => {
            expect(formatTime(ms, locale)).toBe(expected);
        },
    );
});

describe("formatBytes", () => {
    test.each([
        [0, "0 Bytes"],
        [1, "1 Bytes"],
        [1023, "1023 Bytes"],
        [1024, "1 KB"],
        [1536, "1.5 KB"],
        [1024 ** 2 - 1, "1024 KB"],
        [1024 ** 2, "1 MB"],
        [1024 ** 3, "1 GB"],
        [1024 ** 4, "1 TB"],
        [1024 ** 5, "1024 TB"],
    ])("formats %i consistently for number, bigint and decimal string", (bytes, expected) => {
        expect(formatBytes(bytes)).toBe(expected);
        expect(formatBytes(BigInt(bytes))).toBe(expected);
        expect(formatBytes(bytes.toString())).toBe(expected);
    });

    test.each(["9007199254740991", "9007199254740992", "9007199254740993", "18446744073709551615"])(
        "keeps a finite TB label for the native byte count %s",
        (bytes) => {
            const formatted = formatBytes(bytes);
            expect(formatted).toMatch(/^\d+(\.\d+)? TB$/);
            expect(Number.isFinite(Number.parseFloat(formatted))).toBe(true);
            expect(formatted).toBe(formatBytes(BigInt(bytes)));
            expect(formatted).toBe(formatBytes(Number(bytes)));
        },
    );

    test("preserves rounding and the existing decimals argument", () => {
        expect(formatBytes("1264")).toBe("1.23 KB");
        expect(formatBytes("1264", 3)).toBe("1.234 KB");
        expect(formatBytes("1536", -1)).toBe("2 KB");
        expect(formatBytes("18446744073709551615")).toBe("16777216 TB");
    });
});

describe("formatMoveNumber", () => {
    test.each([
        [1, "1."],
        [2, "1..."],
        [3, "2."],
        [40, "20..."],
    ])("formats ply %i as %s", (halfMoves, expected) => {
        expect(formatMoveNumber(halfMoves)).toBe(expected);
    });
});

describe("roundKeepSum", () => {
    test("whole shares that already sum to 100 stay unchanged", () => {
        expect(roundKeepSum([50, 30, 20])).toEqual([50, 30, 20]);
    });

    test("the floored remainder goes to the largest decimal parts", () => {
        expect(roundKeepSum([45.6, 30.3, 24.1])).toEqual([46, 30, 24]);
        expect(roundKeepSum([10.2, 10.9, 78.9])).toEqual([10, 11, 79]);
    });

    test("a decimal tie gives the remainder to the earlier share", () => {
        expect(roundKeepSum([100 / 3, 100 / 3, 100 / 3])).toEqual([34, 33, 33]);
    });

    test("all-zero shares stay zero instead of inventing 100", () => {
        expect(roundKeepSum([0, 0, 0])).toEqual([0, 0, 0]);
    });

    test("a custom target is respected", () => {
        expect(roundKeepSum([0.5, 0.5], 1)).toEqual([1, 0]);
    });

    test("shares whose floored sum already exceeds the target are only floored", () => {
        expect(roundKeepSum([60.7, 50.2])).toEqual([60, 50]);
    });
});

describe("formatNodes", () => {
    test.each([
        [0, 0, "0"],
        [999, 0, "999"],
        [1000, 0, "1k"],
        [999_999, 2, "1000.00k"],
        [1_000_000, 2, "1.00M"],
        [1_500_000, 1, "1.5M"],
        [2_000_000_000, 0, "2B"],
        [3_000_000_000_000, 0, "3T"],
        [5_000_000_000_000_000, 0, "5000T"],
    ])("formats %d nodes with %d decimals as %s", (nodes, decimals, expected) => {
        expect(formatNodes(nodes, decimals)).toBe(expected);
    });

    test("accepts a bigint node count", () => {
        expect(formatNodes(12_345_678n, 2)).toBe("12.35M");
    });
});

describe("formatThemeLabel", () => {
    test.each([
        ["mateIn2", "Mate In 2"],
        ["back_rank-mate", "Back Rank Mate"],
        ["advancedPawn", "Advanced Pawn"],
        ["XMLParser", "Xml Parser"],
        ["mate2moves", "Mate 2 Moves"],
        ["  fork  ", "Fork"],
    ])("formats %j as %j", (theme, expected) => {
        expect(formatThemeLabel(theme)).toBe(expected);
    });

    test("returns the raw slug when nothing is left after normalizing", () => {
        expect(formatThemeLabel("")).toBe("");
        expect(formatThemeLabel("__-")).toBe("__-");
    });
});

describe("capitalize and getInitials", () => {
    test("capitalize uppercases only the first character", () => {
        expect(capitalize("knight")).toBe("Knight");
        expect(capitalize("eN")).toBe("EN");
        expect(capitalize("")).toBe("");
    });

    test("getInitials takes the first letter of every space-separated name", () => {
        expect(getInitials("stockfish")).toBe("S");
        expect(getInitials("magnus carlsen")).toBe("MC");
        expect(getInitials("Jan-Krzysztof duda")).toBe("JD");
    });
});

describe("numberMoves", () => {
    test("numbers the first move and every White move", () => {
        expect(numberMoves(["e4", "c6", "d4", "d5"], 0).map((m) => formatNumberedMove(m))).toEqual([
            "1. e4",
            "c6",
            "2. d4",
            "d5",
        ]);
    });

    test("a line starting with Black's move opens with the ellipsis number", () => {
        expect(numberMoves(["Bd7", "Nc3"], 21).map((m) => formatNumberedMove(m))).toEqual([
            "11... Bd7",
            "12. Nc3",
        ]);
    });

    test("formatNumberedMove applies the piece notation to the move only", () => {
        expect(formatNumberedMove({ moveNumber: "3.", san: "Nf3" }, (san) => `[${san}]`)).toBe(
            "3. [Nf3]",
        );
    });

    test("formatNumberedMove applies the piece notation to a move without a number", () => {
        expect(formatNumberedMove({ san: "Nc6" }, (san) => `[${san}]`)).toBe("[Nc6]");
    });

    test("a no-break separator keeps the number on the move's line", () => {
        expect(
            formatNumberedMove({ moveNumber: "3.", san: "Bb5+" }, undefined, MOVE_NUMBER_NO_BREAK),
        ).toBe("3.\u00a0Bb5+");
    });
});
