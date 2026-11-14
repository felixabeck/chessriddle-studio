import { describe, expect, test } from "vitest";
import {
    formatBytes,
    formatDecimal,
    formatMoveNumber,
    formatRelativeTime,
    formatReviewInterval,
    formatTime,
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
