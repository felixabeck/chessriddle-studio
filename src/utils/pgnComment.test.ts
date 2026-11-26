import { expect, test } from "vitest";
import { extractDiagramMarker, replacePgnCommentText, splitPgnComment } from "./pgnComment";

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
        reviewMark: false,
        shapes: [{ color: "green" }],
    });
    expect(splitPgnComment("Plan").diagram).toBe(false);
    expect(splitPgnComment("Plan").reviewMark).toBe(false);
});

test("splitPgnComment extracts [%crreview] into reviewMark and never keeps it in commands", () => {
    expect(splitPgnComment("[%crreview]")).toEqual({
        text: "",
        commands: "",
        evaluation: undefined,
        shapes: [],
        clock: undefined,
        gameEnds: [],
        diagram: false,
        reviewMark: true,
    });
    expect(
        splitPgnComment("[%cal Ge2e4] [%crreview] [#] Check this [%evp 0,34] [%crreview]"),
    ).toMatchObject({
        text: "Check this",
        commands: "[%evp 0,34]",
        diagram: true,
        reviewMark: true,
        shapes: [{ color: "green" }],
    });
});

test.each([
    { comment: "", text: "new", expected: "new" },
    { comment: "old", text: "new", expected: "new" },
    {
        comment: "[%cal Ge2e4] old [%emt 0:00:05]",
        text: "new",
        expected: "[%cal Ge2e4] [%emt 0:00:05] new",
    },
    { comment: "[#] old", text: "new", expected: "[#] new" },
    { comment: "[%cal Ge2e4] old", text: "  ", expected: "[%cal Ge2e4]" },
    { comment: "old", text: "", expected: "" },
])("replacePgnCommentText($comment, $text) keeps every command", ({ comment, text, expected }) => {
    const replaced = replacePgnCommentText(comment, text);
    expect(replaced).toBe(expected);
    expect(splitPgnComment(replaced).text).toBe(text.trim());
});
