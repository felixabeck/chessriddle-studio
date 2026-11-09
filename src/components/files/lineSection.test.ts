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
        const twice = withLineSection(withLineSection(game, "old"), "new");
        expect(twice.match(/\[Section /g)).toHaveLength(1);
        expect(twice).toContain('[Section "new"]');
    });

    test("removing restores the original text", () => {
        expect(withLineSection(withLineSection(game, "x"), null)).toBe(game);
        expect(withLineSection(game, null)).toBe(game);
    });

    test("keeps CRLF line endings", () => {
        expect(withLineSection('[Event "A"]\r\n\r\n1. e4 *\r\n', "s")).toBe(
            '[Event "A"]\r\n[Section "s"]\r\n\r\n1. e4 *\r\n',
        );
    });

    test("escapes the name so it cannot end the tag", () => {
        expect(withLineSection(game, 'a"b\\c')).toContain('[Section "a\\"b\\\\c"]');
    });

    test("never treats a tag inside a comment as a tag", () => {
        const moves = '[Event "A"]\n\n1. e4 {\n[Section "inside"]\n} *\n';
        expect(withLineSection(moves, null)).toBe(moves);
        expect(withLineSection(moves, "s")).toBe(
            '[Event "A"]\n[Section "s"]\n\n1. e4 {\n[Section "inside"]\n} *\n',
        );
        const header = '[Event "A"] {\n[Section "keep"]\n}\n1. e4 *\n';
        expect(withLineSection(header, null)).toBe(header);
        expect(withLineSection(header, "s")).toBe(
            '[Event "A"]\n[Section "s"]\n{\n[Section "keep"]\n}\n1. e4 *\n',
        );
    });

    test("keeps the new tag before moves that share the last tag's line", () => {
        expect(withLineSection('[Event "A"]\n[White "Alice"] 1. e4 *\n', "x")).toBe(
            '[Event "A"]\n[White "Alice"]\n[Section "x"]\n1. e4 *\n',
        );
    });

    test("keeps other tags that share a line with the section", () => {
        const leading = '[Section "old"] [White "Alice"]\n[Black "Bob"]\n\n1. e4 *\n';
        expect(withLineSection(leading, null)).toBe('[White "Alice"]\n[Black "Bob"]\n\n1. e4 *\n');
        expect(withLineSection(leading, "new")).toBe(
            '[White "Alice"]\n[Black "Bob"]\n[Section "new"]\n\n1. e4 *\n',
        );
        const trailing = '[White "Alice"] [Section "a\\"b"]\n\n1. e4 *\n';
        expect(withLineSection(trailing, null)).toBe('[White "Alice"]\n\n1. e4 *\n');
    });

    test("finds the section past an escape line between tags", () => {
        const escaped = '[Event "A"]\n% note\n[Section "old"]\n\n1. e4 *\n';
        expect(withLineSection(escaped, null)).toBe('[Event "A"]\n% note\n\n1. e4 *\n');
        const renamed = withLineSection(escaped, "new");
        expect(renamed.match(/\[Section /g)).toHaveLength(1);
        expect(renamed).toContain('[Section "new"]');
    });

    test("a game never loses its only tag, which marks where it starts", () => {
        expect(withLineSection('[Section "B"]\n\n1. d4 *\n', null)).toBe(
            '[Event "?"]\n\n1. d4 *\n',
        );
        expect(withLineSection('[Section "x"]\n', null)).toBe('[Event "?"]\n');
    });

    test("a game without tags gets a header block", () => {
        expect(withLineSection("1. e4 *\n", "s")).toBe('[Section "s"]\n\n1. e4 *\n');
        expect(withLineSection("1. e4 *\n", null)).toBe("1. e4 *\n");
    });

    test("renaming a section that is the only tag adds no extra blank line", () => {
        expect(withLineSection('[Section "B"]\n\n1. d4 *\n', "C")).toBe(
            '[Section "C"]\n\n1. d4 *\n',
        );
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
