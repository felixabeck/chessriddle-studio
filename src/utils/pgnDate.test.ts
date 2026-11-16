import { afterEach, describe, expect, test, vi } from "vitest";
import { canonicalPgnDate, pgnDateTags } from "./pgnDate";

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
        vi.unstubAllEnvs();
    });

    test.each([
        // Berlin, 00:30 local on 15 November is still 14 November in UTC.
        ["Europe/Berlin", "2026-11-14T23:30:00Z", "2026.11.15", "2026.11.14", "23:30:00"],
        ["Europe/Berlin", "2026-07-14T23:30:00Z", "2026.07.15", "2026.07.14", "23:30:00"],
        ["Asia/Tokyo", "2026-11-14T23:00:00Z", "2026.11.15", "2026.11.14", "23:00:00"],
        // New York, 20:30 local on 14 November is already 15 November in UTC.
        ["America/New_York", "2026-11-15T01:30:00Z", "2026.11.14", "2026.11.15", "01:30:00"],
        ["UTC", "2026-01-02T03:04:05Z", "2026.01.02", "2026.01.02", "03:04:05"],
    ])("in %s at %s dates the game by the local day", (tz, instant, date, utcDate, utcTime) => {
        vi.stubEnv("TZ", tz);
        expect(pgnDateTags(new Date(instant))).toEqual({ date, utcDate, utcTime });
    });
});
