import { describe, expect, test } from "vitest";
import { LINE_SECTION_MAX_LENGTH, lineSectionOf, withLineSection } from "./lineSection";

const game = '[Event "A"]\n[White "1.d4"]\n\n1. d4 f5 { [%csl Gd4] keep } *\n\n';

describe("withLineSection", () => {
    test("adds the tag after the last tag and leaves every other byte alone", () => {
        expect(withLineSection(game, "mit g3")).toBe(
            '[Event "A"]\n[White "1.d4"]\n[Section "mit g3"]\n\n1. d4 f5 { [%csl Gd4] keep } *\n\n',
        );
    });

    test("an empty name is a section without a heading", () => {
        expect(withLineSection(game, "")).toContain('[Section ""]\n\n1. d4');
    });

    test("replaces an existing section instead of adding a second one", () => {
        const once = withLineSection(game, "old");
        const twice = withLineSection(once, "new");
        expect(twice.match(/\[Section /g)).toHaveLength(1);
        expect(twice).toContain('[Section "new"]');
    });

    test("removing restores the original text", () => {
        expect(withLineSection(withLineSection(game, "x"), null)).toBe(game);
        expect(withLineSection(game, null)).toBe(game);
    });

    test("keeps CRLF line endings and a byte-order mark", () => {
        const bom = String.fromCharCode(0xfeff);
        const crlf = `${bom}[Event "A"]\r\n\r\n1. e4 *\r\n`;
        expect(withLineSection(crlf, "s")).toBe(
            `${bom}[Event "A"]\r\n[Section "s"]\r\n\r\n1. e4 *\r\n`,
        );
    });

    test("escapes the name so it cannot end the tag", () => {
        expect(withLineSection(game, 'a"b\\c')).toContain('[Section "a\\"b\\\\c"]');
    });

    test("never touches a line starting with a bracket inside the moves", () => {
        const comment = '[Event "A"]\n\n1. e4 {\n[Section "inside"]\n} *\n';
        expect(withLineSection(comment, null)).toBe(comment);
        expect(withLineSection(comment, "s")).toContain('{\n[Section "inside"]\n}');
    });

    test("gives a game without tags a header block", () => {
        expect(withLineSection("1. e4 *\n", "s")).toBe('[Section "s"]\n\n1. e4 *\n');
    });

    test("terminates a final tag line that has no line ending", () => {
        expect(withLineSection('[Event "A"]', "s")).toBe('[Event "A"]\n[Section "s"]\n');
    });
});

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
