import { expect, test } from "vitest";
import { formatClock } from "./Clock";

test.each([
    [0, "00:00.0"],
    [-100, "00:00.0"],
    [59.96, "00:59.9"],
    [59950 / 1000, "00:59.9"],
    [59.94, "00:59.9"],
    [5.3, "00:05.3"],
    [0.7, "00:00.7"],
    [2.3, "00:02.3"],
    [60, "01:00"],
    [61.9, "01:01"],
    [3600, "1:00:00"],
    [3725.4, "1:02:05"],
] as const)("formatClock(%s) is %s", (seconds, expected) => {
    expect(formatClock(seconds)).toBe(expected);
});

test("never renders :60 for remaining time just under a minute", () => {
    for (let ms = 59000; ms <= 59999; ms++) {
        expect(formatClock(ms / 1000)).toMatch(/^00:59\.\d$/);
    }
});
