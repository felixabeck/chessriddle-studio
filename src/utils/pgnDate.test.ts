import { afterEach, describe, expect, test, vi } from "vitest";
import { canonicalPgnDate, formatPgnYearMonth, pgnDateTags } from "./pgnDate";

const fileSystemModule = "node:fs";
const rustSource = await (
    import(fileSystemModule) as Promise<{
        readFileSync(path: string, encoding: "utf8"): string;
    }>
).then((fs) => fs.readFileSync("src-tauri/src/db/pgn_date.rs", "utf8"));

function unescapeRustString(raw: string): string {
    let result = "";
    for (let index = 0; index < raw.length; index++) {
        if (raw[index] !== "\\") {
            result += raw[index];
            continue;
        }
        const next = raw[++index];
        if (next === "0") result += "\0";
        else if (next === "\\") result += "\\";
        else if (next === '"') result += '"';
        else result += next ?? "";
    }
    return result;
}

function rustCanonicalCases(source: string): { cases: [string, string][]; rowCount: number } {
    const block = source.match(/const CASES: &\[\(&str, &str\)\] = &\[([\s\S]*?)\];/)?.[1];
    if (block === undefined) return { cases: [], rowCount: 0 };
    const cases = [...block.matchAll(/\("((?:\\.|[^"\\])*)",\s*"((?:\\.|[^"\\])*)"\)/g)].map(
        (match) => [unescapeRustString(match[1]), unescapeRustString(match[2])] as [string, string],
    );
    const rowCount = block.match(/^\s*\(/gm)?.length ?? 0;
    return { cases, rowCount };
}

describe("canonicalPgnDate", () => {
    test("mirrors src-tauri/src/db/pgn_date.rs canonical cases", () => {
        const { cases, rowCount } = rustCanonicalCases(rustSource);
        expect(cases.length).toBe(rowCount);
        expect(cases.length).toBeGreaterThan(0);
        for (const [input, expected] of cases) {
            expect(canonicalPgnDate(input)).toBe(expected);
        }
    });
});

describe("pgnDateTags", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    // A runtime TZ change is ignored in worker threads (Stryker's runner), so the local
    // calendar fields are stubbed on the instant instead.
    function instant(utc: string, local: [year: number, month: number, day: number]): Date {
        const date = new Date(utc);
        vi.spyOn(date, "getFullYear").mockReturnValue(local[0]);
        vi.spyOn(date, "getMonth").mockReturnValue(local[1] - 1);
        vi.spyOn(date, "getDate").mockReturnValue(local[2]);
        // A local clock that never matches the UTC one, so UTCTime must come from UTC getters.
        vi.spyOn(date, "getHours").mockReturnValue(7);
        vi.spyOn(date, "getMinutes").mockReturnValue(59);
        vi.spyOn(date, "getSeconds").mockReturnValue(58);
        return date;
    }

    test.each([
        // East of UTC after local midnight (Tokyo 08:00 on 15 November).
        ["2026-11-14T23:00:00Z", [2026, 11, 15], "2026.11.15", "2026.11.14", "23:00:00"],
        // West of UTC in the evening (New York 20:30 on 14 November).
        ["2026-11-15T01:30:00Z", [2026, 11, 14], "2026.11.14", "2026.11.15", "01:30:00"],
        ["2026-01-02T03:04:05Z", [2026, 1, 2], "2026.01.02", "2026.01.02", "03:04:05"],
    ] as const)(
        "at %s with local day %j dates the game by the local day",
        (utc, local, date, utcDate, utcTime) => {
            expect(pgnDateTags(instant(utc, [...local]))).toEqual({ date, utcDate, utcTime });
        },
    );
});

describe("formatPgnYearMonth", () => {
    test.each([
        ["2026.09.10", "2026-09"],
        ["2026.12.01", "2026-12"],
        ["2026.??.??", "2026"],
        ["2026.00.00", "2026"],
        ["2026", "2026"],
        [null, "–"],
        [undefined, "–"],
        ["", "–"],
    ] as const)("formats %s as %s", (input, expected) => {
        expect(formatPgnYearMonth(input)).toBe(expected);
    });
});
