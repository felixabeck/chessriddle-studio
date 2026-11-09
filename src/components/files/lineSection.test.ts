import { describe, expect, test } from "vitest";
import { LINE_SECTION_MAX_LENGTH, lineSectionOf, withLineSection } from "./lineSection";

const game = '[Event "A"]\n[White "1.d4"]\n\n1. d4 f5 { [%csl Gd4] keep } *\n\n';

describe("withLineSection", () => {
    test("adds the tag after the last tag and leaves every other byte alone", () => {
        expect(withLineSection(game, "mit g3", 0)).toBe(
            '[Event "A"]\n[White "1.d4"]\n[Section "mit g3"]\n\n1. d4 f5 { [%csl Gd4] keep } *\n\n',
        );
    });

    test("an empty name is a section without a heading", () => {
        expect(withLineSection(game, "", 0)).toContain('[Section ""]\n\n1. d4');
    });

    test("replaces an existing section instead of adding a second one", () => {
        const twice = withLineSection(withLineSection(game, "old", 0), "new", 0);
        expect(twice.match(/\[Section /g)).toHaveLength(1);
        expect(twice).toContain('[Section "new"]');
    });

    test("removing restores the original text", () => {
        expect(withLineSection(withLineSection(game, "x", 2), null, 2)).toBe(game);
        expect(withLineSection(game, null, 2)).toBe(game);
    });

    test("keeps CRLF line endings", () => {
        expect(withLineSection('[Event "A"]\r\n\r\n1. e4 *\r\n', "s", 0)).toBe(
            '[Event "A"]\r\n[Section "s"]\r\n\r\n1. e4 *\r\n',
        );
    });

    test("escapes the name so it cannot end the tag", () => {
        expect(withLineSection(game, 'a"b\\c', 0)).toContain('[Section "a\\"b\\\\c"]');
    });

    test("never treats a tag inside a comment as a tag", () => {
        const moves = '[Event "A"]\n\n1. e4 {\n[Section "inside"]\n} *\n';
        expect(withLineSection(moves, null, 0)).toBe(moves);
        expect(withLineSection(moves, "s", 0)).toBe(
            '[Event "A"]\n[Section "s"]\n\n1. e4 {\n[Section "inside"]\n} *\n',
        );
        const header = '[Event "A"] {\n[Section "keep"]\n}\n1. e4 *\n';
        expect(withLineSection(header, null, 0)).toBe(header);
        expect(withLineSection(header, "s", 0)).toBe(
            '[Event "A"]\n[Section "s"]\n{\n[Section "keep"]\n}\n1. e4 *\n',
        );
    });

    test("keeps the new tag before moves that share the last tag's line", () => {
        expect(withLineSection('[Event "A"]\n[White "Alice"] 1. e4 *\n', "x", 0)).toBe(
            '[Event "A"]\n[White "Alice"]\n[Section "x"]\n1. e4 *\n',
        );
    });

    test("keeps other tags that share a line with the section", () => {
        const leading = '[Section "old"] [White "Alice"]\n[Black "Bob"]\n\n1. e4 *\n';
        expect(withLineSection(leading, null, 0)).toBe(
            '[White "Alice"]\n[Black "Bob"]\n\n1. e4 *\n',
        );
        expect(withLineSection(leading, "new", 0)).toBe(
            '[White "Alice"]\n[Black "Bob"]\n[Section "new"]\n\n1. e4 *\n',
        );
        const trailing = '[White "Alice"] [Section "a\\"b"]\n\n1. e4 *\n';
        expect(withLineSection(trailing, null, 0)).toBe('[White "Alice"]\n\n1. e4 *\n');
    });

    test("finds the section past an escape line between tags", () => {
        const escaped = '[Event "A"]\n% note\n[Section "old"]\n\n1. e4 *\n';
        expect(withLineSection(escaped, null, 0)).toBe('[Event "A"]\n% note\n\n1. e4 *\n');
        const renamed = withLineSection(escaped, "new", 0);
        expect(renamed.match(/\[Section /g)).toHaveLength(1);
        expect(renamed).toContain('[Section "new"]');
    });

    test("a later game never loses its only tag, which marks where it starts", () => {
        expect(withLineSection('[Section "B"]\n\n1. d4 *\n', null, 1)).toBe(
            '[Event "?"]\n\n1. d4 *\n',
        );
    });

    test("a first game without tags gets a header block and can return to none", () => {
        const headerless = "1. e4 *\n";
        const sectioned = withLineSection(headerless, "s", 0);
        expect(sectioned).toBe('[Section "s"]\n\n1. e4 *\n');
        expect(withLineSection(sectioned, null, 0)).toBe(headerless);
    });

    test("renaming a section that is the only tag adds no extra blank line", () => {
        expect(withLineSection('[Section "B"]\n\n1. d4 *\n', "C", 1)).toBe(
            '[Section "C"]\n\n1. d4 *\n',
        );
    });

    test("terminates a final tag line that has no line ending", () => {
        expect(withLineSection('[Event "A"]', "s", 0)).toBe('[Event "A"]\n[Section "s"]\n');
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
