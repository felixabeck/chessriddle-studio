import { describe, expect, test } from "vitest";
import { canonicalPgnDate } from "./pgnDate";

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
