import { describe, expect, test } from "vitest";
import { LINE_SECTION_MAX_LENGTH, lineSectionOf } from "./lineSection";

describe("lineSectionOf", () => {
    test("distinguishes no section from an unnamed one", () => {
        expect(lineSectionOf({})).toBeUndefined();
        expect(lineSectionOf({ other: { Site: "x" } })).toBeUndefined();
        expect(lineSectionOf({ other: { Section: "" } })).toBe("");
    });

    test("bounds and normalizes a value from the file", () => {
        const value = `  a\t b ${"c".repeat(200)}`;
        const section = lineSectionOf({ other: { Section: value } });
        expect(section?.startsWith("a b c")).toBe(true);
        expect(section).toHaveLength(LINE_SECTION_MAX_LENGTH);
    });
});
