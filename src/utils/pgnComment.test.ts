import { expect, test } from "vitest";
import { extractDiagramMarker, splitPgnComment } from "./pgnComment";

test.each([
    ["[#]", ""],
    ["[#] Nice", "Nice"],
    ["Nice [#]", "Nice"],
    ["foo [#] bar", "foo bar"],
    ["foo[#]bar", "foo bar"],
    ["[#] one [#] two", "one two"],
])("extractDiagramMarker lifts the marker out of %j", (comment, text) => {
    expect(extractDiagramMarker(comment)).toEqual({ text, diagram: true });
});

test("extractDiagramMarker returns text without a marker untouched", () => {
    expect(extractDiagramMarker("  spaced  prose ")).toEqual({
        text: "  spaced  prose ",
        diagram: false,
    });
});

test("splitPgnComment reports the marker apart from prose, commands and drawings", () => {
    expect(splitPgnComment("[%cal Ge2e4] [#] Plan [%evp 0,34]")).toMatchObject({
        text: "Plan",
        commands: "[%evp 0,34]",
        diagram: true,
        shapes: [{ color: "green" }],
    });
    expect(splitPgnComment("Plan").diagram).toBe(false);
});
