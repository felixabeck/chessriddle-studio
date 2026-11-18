import type { JSONContent } from "@tiptap/react";
import { expect, test } from "vitest";
import { createCommentMarkdown, type CommentMarkdownToken } from "./commentMarkdown";
import {
    compareCommentDocument,
    flattenCommentDocument,
    normalizeCommentDocument,
    serializeComment,
    type CommentFormatting,
} from "./commentSerializer";

type Span = { text: string; marks?: string[]; hardBreak?: boolean };

const link = (href: string, title: string | null = null) => JSON.stringify(["link", href, title]);
const url = link("https://x.y");

function mark(key: string) {
    if (!key.startsWith("[")) return { type: key };
    const [, href, title] = JSON.parse(key);
    return { type: "link", attrs: { href, title } };
}

function document(spans: Span[]): JSONContent {
    return {
        type: "doc",
        content: [
            {
                type: "paragraph",
                content: spans.map((span) => ({
                    type: span.hardBreak ? "hardBreak" : "text",
                    ...(span.hardBreak ? {} : { text: span.text }),
                    marks: (span.marks ?? []).map(mark),
                })),
            },
        ],
    };
}

function expected(spans: Span[]): CommentFormatting {
    return {
        text: spans.map((span) => span.text).join(""),
        marks: spans.flatMap((span) =>
            Array.from(span.text, () => [...new Set(span.marks ?? [])].sort()),
        ),
    };
}

function reparse(source: string): JSONContent {
    const inline = (tokens: CommentMarkdownToken[], marks: string[] = []): JSONContent[] =>
        tokens.flatMap((token) => {
            const type = { strong: "bold", em: "italic", del: "strike", underline: "underline" }[
                token.type
            ];
            if (type || token.type === "link") {
                return inline(token.tokens ?? [], [
                    ...marks,
                    type ?? link(token.href!, token.title ?? null),
                ]);
            }
            if (token.type === "br") return [{ type: "hardBreak", marks: marks.map(mark) }];
            if (token.tokens) return inline(token.tokens, marks);
            if (token.type !== "text" && token.type !== "escape")
                throw new Error(`Unexpected token ${token.type}`);
            return [{ type: "text", text: token.text ?? "", marks: marks.map(mark) }];
        });
    return {
        type: "doc",
        content: (createCommentMarkdown().lexer(source) as CommentMarkdownToken[])
            .filter((token) => token.type !== "space")
            .map((token) => {
                if (token.type !== "paragraph") throw new Error(`Unexpected block ${token.type}`);
                return { type: "paragraph", content: inline(token.tokens ?? []) };
            }),
    };
}

function roundTrip(input: Span[], wanted: Span[] = input, source?: string) {
    const oracle = expected(wanted);
    const json = document(input);
    const serialized = serializeComment(json);
    const anySource = expect.any(String);
    expect(serialized).toEqual(source ?? anySource);
    expect(flattenCommentDocument(reparse(serialized))).toEqual(oracle);
    expect(compareCommentDocument(json, [reparse])).toEqual({ saved: true, source: serialized });
    return serialized;
}

test("escapes literal delimiters independently of authored formatting", () => {
    expect.hasAssertions();
    roundTrip([{ text: "a++b" }, { text: "c", marks: ["underline"] }], undefined, "a\\+\\+b++c++");
    roundTrip([{ text: "**x**" }], undefined, "\\*\\*x\\*\\*");
    roundTrip([{ text: "a++b", marks: ["underline"] }], undefined, "++a\\+\\+b++");
    roundTrip(
        [
            { text: "a", marks: ["underline"] },
            { text: "b", marks: ["underline"] },
        ],
        undefined,
        "++ab++",
    );
});

test("keeps an isolated underlined plus before an unmarked edit", () => {
    expect.hasAssertions();
    roundTrip([{ text: "+", marks: ["underline"] }, { text: "!" }], undefined, "+++++!");
});

test("refuses an underline ending in a plus after another character", () => {
    const input = document([{ text: "x+", marks: ["underline"] }]);
    expect(compareCommentDocument(input, [reparse])).toEqual({ saved: false });
});

test("keeps adjacent link destinations and titles distinct beside unmarked edits", () => {
    expect.hasAssertions();
    for (const edit of ["", "!"]) {
        roundTrip(
            [
                { text: "a", marks: [link("https://a.test")] },
                { text: "b", marks: [link("https://b.test")] },
                ...(edit ? [{ text: edit }] : []),
            ],
            undefined,
            `[a](https://a.test)[b](https://b.test)${edit}`,
        );
    }
    roundTrip(
        [
            { text: "a", marks: [link("https://x.y", "first")] },
            { text: "b", marks: [link("https://x.y", "second")] },
        ],
        undefined,
        '[a](https://x.y "first")[b](https://x.y "second")',
    );
    roundTrip(
        [{ text: "a", marks: [link("https://x.y/a(b)", 'a "quote" and \\ slash')] }],
        undefined,
        '[a](<https://x.y/a(b)> "a \\"quote\\" and \\\\ slash")',
    );
});

test("prevents autolinking after a URL link is removed", () => {
    expect.hasAssertions();
    roundTrip([{ text: "https://a.test" }], undefined, "https\\://a.test");
    roundTrip([{ text: "www.a.test" }], undefined, "www\\.a.test");
});

test("keeps underline on linked edge spaces and moves plain flanking whitespace out", () => {
    expect.hasAssertions();
    roundTrip(
        [{ text: " x ", marks: ["underline", link("https://a.test")] }],
        undefined,
        "++[ x ](https://a.test)++",
    );
    roundTrip([{ text: "   ", marks: ["underline", url] }], undefined, "++[   ](https://x.y)++");
    roundTrip(
        [{ text: "a" }, { text: "   ", marks: ["underline"] }, { text: "b" }],
        [{ text: "a   b" }],
        "a   b",
    );
    for (const type of ["underline", "bold", "italic", "strike"]) {
        const delimiter = { underline: "++", bold: "**", italic: "*", strike: "~~" }[type];
        roundTrip(
            [{ text: " x ", marks: [type] }],
            [{ text: " " }, { text: "x", marks: [type] }, { text: " " }],
            ` ${delimiter}x${delimiter} `,
        );
    }
});

test("keeps expressible whitespace inside a crossing emphasis run", () => {
    expect.hasAssertions();
    roundTrip(
        [
            { text: "a ", marks: ["bold"] },
            { text: "b", marks: ["bold", "underline"] },
        ],
        undefined,
        "**a ++b++**",
    );
    roundTrip(
        [
            { text: "a", marks: ["bold", "underline"] },
            { text: " b", marks: ["bold"] },
        ],
        undefined,
        "**++a++ b**",
    );
});

test("refuses a whitespace-only paragraph when the lexer discards its text", () => {
    const input = document([{ text: "   ", marks: ["underline"] }]);
    const oracle = expected([{ text: "   " }]);
    expect(flattenCommentDocument(normalizeCommentDocument(input))).toEqual(oracle);
    expect(serializeComment(input)).toBe("   ");
    expect(compareCommentDocument(input, [reparse])).toEqual({ saved: false });
});

test("refuses an empty title when the lexer changes it to null", () => {
    const input = document([{ text: "a", marks: [link("https://x.y", "")] }]);
    expect(serializeComment(input)).toBe('[a](https://x.y "")');
    expect(compareCommentDocument(input, [reparse])).toEqual({ saved: false });
});

test.each([false, true])(
    "closes underline at a break and preserves each spanning mark, hard=%s",
    (hardBreak) => {
        expect.hasAssertions();
        const newline = hardBreak ? "  \n" : "\n";
        roundTrip(
            [
                { text: "a", marks: ["underline"] },
                { text: "\n", hardBreak, marks: ["underline"] },
                { text: "b", marks: ["underline"] },
            ],
            [
                { text: "a", marks: ["underline"] },
                { text: "\n" },
                { text: "b", marks: ["underline"] },
            ],
            `++a++${newline}++b++`,
        );
        for (const type of ["bold", "italic", "strike", url]) {
            const input = [
                { text: "a", marks: [type, "underline"] },
                { text: "\n", hardBreak, marks: [type, "underline"] },
                { text: "b", marks: [type, "underline"] },
            ];
            const wanted = [input[0], { text: "\n", marks: [type] }, input[2]];
            const delimiter = { bold: "**", italic: "*", strike: "~~" }[type];
            const source =
                type === url
                    ? `[++a++${newline}++b++](https://x.y)`
                    : `${delimiter}++a++${newline}++b++${delimiter}`;
            roundTrip(input, wanted, source);
        }
        const marks = [url, "bold", "italic", "strike"];
        roundTrip(
            [
                { text: "a", marks: [...marks, "underline"] },
                { text: "\n", hardBreak, marks: [...marks, "underline"] },
                { text: "b", marks: [...marks, "underline"] },
            ],
            [
                { text: "a", marks: [...marks, "underline"] },
                { text: "\n", marks },
                { text: "b", marks: [...marks, "underline"] },
            ],
        );
    },
);

test("uses decoded escape text as the expectation before serializing an edit", () => {
    for (const [source, decoded] of [
        ["1\\. escaped", "1. escaped"],
        ["\\+\\+x\\+\\+", "++x++"],
    ]) {
        const oracle = expected([{ text: decoded }]);
        expect(flattenCommentDocument(reparse(source))).toEqual(oracle);
        roundTrip([{ text: `${decoded}!` }]);
    }
});

test("omits empty paragraphs and joins nonempty paragraphs with one boundary", () => {
    const oracle = expected([{ text: "a\n\nb" }]);
    const json: JSONContent = {
        type: "doc",
        content: [
            { type: "paragraph" },
            document([{ text: "a" }]).content![0],
            { type: "paragraph", content: [] },
            document([{ text: "b" }]).content![0],
            { type: "paragraph" },
        ],
    };
    expect(serializeComment(json)).toBe("a\n\nb");
    expect(flattenCommentDocument(reparse(serializeComment(json)))).toEqual(oracle);
    expect(compareCommentDocument(json, [reparse])).toEqual({ saved: true, source: "a\n\nb" });
    expect(
        compareCommentDocument({ type: "doc", content: [{ type: "paragraph" }] }, [reparse]),
    ).toEqual({ saved: true, source: "" });
});

test("semantic comparison ignores mark order, node splits and absent versus null titles", () => {
    const oracle = expected([{ text: "ab", marks: ["bold", url] }]);
    const input = document([{ text: "ab", marks: [url, "bold"] }]);
    const adapter = () => ({
        type: "doc",
        content: [
            {
                type: "paragraph",
                content: ["a", "b"].map((text) => ({
                    type: "text",
                    text,
                    marks: [{ type: "bold" }, { type: "link", attrs: { href: "https://x.y" } }],
                })),
            },
        ],
    });
    expect(flattenCommentDocument(adapter())).toEqual(oracle);
    expect(compareCommentDocument(input, [reparse, adapter])).toEqual({
        saved: true,
        source: serializeComment(input),
    });
});

test("refuses text, formatting and link attribute mismatches from any adapter", () => {
    const input = document([{ text: "a", marks: [url] }]);
    for (const mismatch of [
        document([{ text: "b", marks: [url] }]),
        document([{ text: "a" }]),
        document([{ text: "a", marks: [link("https://other.test")] }]),
        document([{ text: "a", marks: [link("https://x.y", "changed")] }]),
    ]) {
        expect(compareCommentDocument(input, [reparse, () => mismatch])).toEqual({ saved: false });
    }
    expect(compareCommentDocument(input, [])).toEqual({ saved: false });
    expect(
        compareCommentDocument(document([{ text: "a\nb", marks: [url, "underline"] }]), [
            () => reparse("++[a](https://x.y)++\n++[b](https://x.y)++"),
        ]),
    ).toEqual({ saved: false });
});

test("refuses adapter and serialization exceptions without throwing or returning saved source", () => {
    const input = document([{ text: "draft" }]);
    const before = structuredClone(input);
    expect(
        compareCommentDocument(input, [
            reparse,
            () => {
                throw new Error("Reparse failed");
            },
        ]),
    ).toEqual({ saved: false });
    expect(input).toEqual(before);
    expect(
        compareCommentDocument({ type: "doc", content: [{ type: "unsupported" }] }, [reparse]),
    ).toEqual({ saved: false });
    expect(
        compareCommentDocument(document([{ text: "x", marks: ["unsupported"] }]), [reparse]),
    ).toEqual({ saved: false });
});

test.each([
    {
        name: "linked break beside trailing emphasis space",
        input: [
            { text: "a", marks: ["bold"] },
            { text: "a", marks: ["italic", "strike"] },
            { text: "a" },
            { text: "\n", marks: [url] },
            { text: " ", marks: ["italic"] },
        ],
        wanted: [
            { text: "a", marks: ["bold"] },
            { text: "a", marks: ["italic", "strike"] },
            { text: "a" },
            { text: "\n", marks: [url] },
            { text: " " },
        ],
        source: "**a***~~a~~*a[\n](https://x.y) ",
    },
    {
        name: "linked whitespace in separate runs",
        input: [
            { text: " ", marks: [url] },
            { text: " ", marks: ["strike", url] },
            { text: "\n" },
            { text: " ", marks: [url] },
        ],
        wanted: [
            { text: " ", marks: [url] },
            { text: " ", marks: [url] },
            { text: "\n" },
            { text: " ", marks: [url] },
        ],
        source: "[  ](https://x.y)\n[ ](https://x.y)",
    },
    {
        name: "outer strike around nested linked underline",
        input: [
            { text: " ", marks: ["bold", "italic", url] },
            { text: " ", marks: ["italic"] },
            { text: "a", marks: ["strike", "underline"] },
            { text: "a", marks: ["bold", "italic", "strike", "underline", url] },
            { text: "a", marks: ["italic", "strike"] },
        ],
        wanted: [
            { text: " ", marks: [url] },
            { text: " " },
            { text: "a", marks: ["strike", "underline"] },
            { text: "a", marks: [url, "bold", "italic", "strike", "underline"] },
            { text: "a", marks: ["italic", "strike"] },
        ],
        source: "[ ](https://x.y) ~~++a[***a***](https://x.y)++*a*~~",
    },
    {
        name: "separate link runs across a plain gap",
        input: [
            { text: "b", marks: ["italic"] },
            { text: "b", marks: ["underline"] },
            { text: "a", marks: ["strike", url] },
            { text: " ", marks: [url] },
            { text: "b", marks: ["italic", url] },
            { text: " ", marks: ["strike", "underline"] },
            { text: "b", marks: ["bold", "italic", url] },
        ],
        wanted: [
            { text: "b", marks: ["italic"] },
            { text: "b", marks: ["underline"] },
            { text: "a", marks: [url, "strike"] },
            { text: " ", marks: [url] },
            { text: "b", marks: [url, "italic"] },
            { text: " " },
            { text: "b", marks: [url, "bold", "italic"] },
        ],
        source: "*b*++b++[~~a~~ *b*](https://x.y) [***b***](https://x.y)",
    },
    {
        name: "crossing emphasis around whitespace",
        input: [
            { text: "a", marks: ["bold", "italic"] },
            { text: "b", marks: ["bold"] },
            { text: " ", marks: ["bold", "italic", "strike"] },
            { text: "b", marks: ["bold", "italic", url] },
            { text: "a", marks: ["italic", "underline"] },
        ],
        wanted: [
            { text: "a", marks: ["bold", "italic"] },
            { text: "b", marks: ["bold"] },
            { text: " ", marks: ["bold"] },
            { text: "b", marks: [url, "bold", "italic"] },
            { text: "a", marks: ["italic", "underline"] },
        ],
        source: "***a*b [*b*](https://x.y)**++*a*++",
    },
    {
        name: "outer emphasis spanning a linked break",
        input: [
            { text: "\n", marks: ["bold", "italic", url] },
            { text: "a", marks: ["bold", "italic", "underline", url] },
            { text: "a", marks: ["bold", "italic"] },
            { text: "a", marks: ["italic", "underline"] },
            { text: "b", marks: ["bold", "strike", "underline", url] },
        ],
        wanted: [
            { text: "\n", marks: [url, "bold", "italic"] },
            { text: "a", marks: [url, "bold", "italic", "underline"] },
            { text: "a", marks: ["bold", "italic"] },
            { text: "a", marks: ["italic", "underline"] },
            { text: "b", marks: [url, "bold", "strike", "underline"] },
        ],
        source: "***[\n++a++](https://x.y)a**++a++*++[**~~b~~**](https://x.y)++",
    },
    {
        name: "same link attributes on separate lines",
        input: [
            { text: "\n", marks: [url] },
            { text: " ", marks: [url] },
            { text: "b", marks: ["bold"] },
            { text: " " },
            { text: " ", marks: ["bold", "underline", url] },
        ],
        wanted: [
            { text: "\n", marks: [url] },
            { text: " ", marks: [url] },
            { text: "b", marks: ["bold"] },
            { text: " " },
            { text: " ", marks: [url, "underline"] },
        ],
        source: "[\n ](https://x.y)**b** ++[ ](https://x.y)++",
    },
    {
        name: "outer strike crossing a linked underline",
        input: [
            { text: "b", marks: ["strike"] },
            { text: "b", marks: ["strike", "underline", url] },
            { text: "a", marks: ["italic", "underline", url] },
            { text: " ", marks: ["strike"] },
            { text: "a", marks: ["strike", url] },
            { text: "a", marks: ["bold", "strike", "underline"] },
        ],
        wanted: [
            { text: "b", marks: ["strike"] },
            { text: "b", marks: [url, "strike", "underline"] },
            { text: "a", marks: [url, "italic", "underline"] },
            { text: " " },
            { text: "a", marks: [url, "strike"] },
            { text: "a", marks: ["bold", "strike", "underline"] },
        ],
        source: "~~b~~++[~~b~~*a*](https://x.y)++ ~~[a](https://x.y)++**a**++~~",
    },
    {
        name: "italic crossing bold into a longer link",
        input: [
            { text: "a", marks: ["bold", "italic"] },
            { text: "a", marks: ["italic", "underline", url] },
            { text: "a", marks: ["strike", url] },
        ],
        wanted: [
            { text: "a", marks: ["bold", "italic"] },
            { text: "a", marks: [url, "italic", "underline"] },
            { text: "a", marks: [url, "strike"] },
        ],
        source: "***a***[++*a*++~~a~~](https://x.y)",
    },
    {
        name: "nested emphasis beside an adjacent link",
        input: [
            { text: "a", marks: ["bold", "italic"] },
            { text: "a", marks: ["bold", "strike"] },
            { text: "b", marks: ["bold", "italic", "strike", "underline"] },
            { text: "b", marks: ["bold", url] },
            { text: "b", marks: ["strike", url] },
        ],
        wanted: [
            { text: "a", marks: ["bold", "italic"] },
            { text: "a", marks: ["bold", "strike"] },
            { text: "b", marks: ["bold", "italic", "strike", "underline"] },
            { text: "b", marks: [url, "bold"] },
            { text: "b", marks: [url, "strike"] },
        ],
        source: "***a*~~a++*b*++~~**[**b**~~b~~](https://x.y)",
    },
    {
        name: "separate emphasis runs",
        input: [
            { text: "a", marks: ["bold"] },
            { text: "b" },
            { text: "a", marks: ["italic", url] },
        ],
        wanted: [
            { text: "a", marks: ["bold"] },
            { text: "b" },
            { text: "a", marks: [url, "italic"] },
        ],
        source: "**a**b[*a*](https://x.y)",
    },
    {
        name: "trailing linked whitespace across a break",
        input: [
            { text: "b", marks: ["italic", url] },
            { text: " ", marks: ["bold"] },
            { text: "\n", marks: [url] },
            { text: " ", marks: ["strike", "underline", url] },
        ],
        wanted: [
            { text: "b", marks: [url, "italic"] },
            { text: " " },
            { text: "\n", marks: [url] },
            { text: " ", marks: [url] },
        ],
        source: "[*b*](https://x.y) [\n ](https://x.y)",
    },
    {
        name: "emphasis ending before a second link",
        input: [
            { text: "\n", marks: ["italic", "strike", url] },
            { text: "a", marks: ["italic", "strike"] },
            { text: "\n", marks: ["underline", url] },
        ],
        wanted: [
            { text: "\n", marks: [url, "italic", "strike"] },
            { text: "a", marks: ["italic", "strike"] },
            { text: "\n", marks: [url] },
        ],
        source: "*~~[\n](https://x.y)a~~*[\n](https://x.y)",
    },
    {
        name: "adjacent disjoint emphasis",
        input: [
            { text: "b", marks: ["bold"] },
            { text: "b", marks: ["italic", url] },
        ],
        wanted: [
            { text: "b", marks: ["bold"] },
            { text: "b", marks: [url, "italic"] },
        ],
        source: "**b**[*b*](https://x.y)",
    },
    {
        name: "crossing emphasis at a link edge",
        input: [
            { text: "a", marks: ["bold", url] },
            { text: "a", marks: ["bold", "strike", "underline", url] },
            { text: "a", marks: ["bold", "italic", "strike", "underline", url] },
            { text: "a", marks: ["italic"] },
            { text: "b", marks: ["strike"] },
            { text: " ", marks: [url] },
            { text: "a", marks: ["bold", "underline"] },
        ],
        wanted: [
            { text: "a", marks: [url, "bold"] },
            { text: "a", marks: [url, "bold", "strike", "underline"] },
            { text: "a", marks: [url, "bold", "italic", "strike", "underline"] },
            { text: "a", marks: ["italic"] },
            { text: "b", marks: ["strike"] },
            { text: " ", marks: [url] },
            { text: "a", marks: ["bold", "underline"] },
        ],
        source: "[**a++~~a~~++**](https://x.y)*++[**~~a~~**](https://x.y)++a*~~b~~[ ](https://x.y)++**a**++",
    },
    {
        name: "strike across separate linked lines",
        input: [
            { text: "a", marks: ["italic", "strike"] },
            { text: "b" },
            { text: "b", marks: ["bold", "strike"] },
            { text: "\n", marks: ["strike", "underline", url] },
            { text: " ", marks: ["bold", url] },
        ],
        wanted: [
            { text: "a", marks: ["italic", "strike"] },
            { text: "b" },
            { text: "b", marks: ["bold", "strike"] },
            { text: "\n", marks: [url, "strike"] },
            { text: " ", marks: [url] },
        ],
        source: "*~~a~~*b~~**b**[\n](https://x.y)~~[ ](https://x.y)",
    },
    {
        name: "crossing italic and bold at whitespace edges",
        input: [
            { text: "b", marks: ["italic", "underline"] },
            { text: "b", marks: ["bold", "italic", url] },
            { text: "a", marks: ["bold"] },
            { text: " ", marks: ["bold", "strike", "underline"] },
        ],
        wanted: [
            { text: "b", marks: ["italic", "underline"] },
            { text: "b", marks: [url, "bold", "italic"] },
            { text: "a", marks: ["bold"] },
            { text: " " },
        ],
        source: "++*b*++**[*b*](https://x.y)a** ",
    },
    {
        name: "link spanning a break through underline",
        input: [
            { text: "b", marks: ["underline", url] },
            { text: "\n", marks: ["underline", url] },
            { text: "b", marks: ["bold", "underline", url] },
            { text: "a", marks: ["bold", "italic", "strike", "underline"] },
            { text: "b", marks: ["italic", "underline"] },
        ],
        wanted: [
            { text: "b", marks: [url, "underline"] },
            { text: "\n", marks: [url] },
            { text: "b", marks: [url, "bold", "underline"] },
            { text: "a", marks: ["bold", "italic", "strike", "underline"] },
            { text: "b", marks: ["italic", "underline"] },
        ],
        source: "[++b++\n++**b**++](https://x.y)++***~~a~~**b*++",
    },
    {
        name: "several disjoint emphasis and link runs",
        input: [
            { text: "a", marks: ["bold", "underline"] },
            { text: "b", marks: ["strike"] },
            { text: "b", marks: ["italic", "strike", url] },
            { text: "a", marks: ["bold", "italic", url] },
            { text: "b", marks: ["strike"] },
            { text: "a", marks: ["bold", "underline", url] },
            { text: "a", marks: ["bold"] },
        ],
        wanted: [
            { text: "a", marks: ["bold", "underline"] },
            { text: "b", marks: ["strike"] },
            { text: "b", marks: [url, "italic", "strike"] },
            { text: "a", marks: [url, "bold", "italic"] },
            { text: "b", marks: ["strike"] },
            { text: "a", marks: [url, "bold", "underline"] },
            { text: "a", marks: ["bold"] },
        ],
        source: "++**a**++~~b~~[*~~b~~**a***](https://x.y)~~b~~**++[a](https://x.y)++a**",
    },
    {
        name: "shifted bold and italic runs",
        input: [
            { text: "b", marks: ["bold"] },
            { text: "a", marks: ["bold", "italic", url] },
            { text: "a", marks: ["italic", "strike", url] },
            { text: " " },
        ],
        wanted: [
            { text: "b", marks: ["bold"] },
            { text: "a", marks: [url, "bold", "italic"] },
            { text: "a", marks: [url, "italic", "strike"] },
            { text: " " },
        ],
        source: "**b***[**a**~~a~~](https://x.y)* ",
    },
    {
        name: "leading linked underline whitespace across a break",
        input: [
            { text: " ", marks: ["underline", url] },
            { text: "\n", marks: [url] },
            { text: "a", marks: ["bold", "strike", "underline"] },
            { text: "a" },
            { text: "a", marks: ["bold", "underline", url] },
            { text: " ", marks: ["italic"] },
            { text: " " },
        ],
        wanted: [
            { text: " ", marks: [url] },
            { text: "\n", marks: [url] },
            { text: "a", marks: ["bold", "strike", "underline"] },
            { text: "a" },
            { text: "a", marks: [url, "bold", "underline"] },
            { text: " " },
            { text: " " },
        ],
        source: "[ \n](https://x.y)++**~~a~~**++a++[**a**](https://x.y)++  ",
    },
])("keeps canonical text and coverage for $name", ({ input, wanted, source }) => {
    expect.hasAssertions();
    roundTrip(input, wanted, source);
});

test("fixed-seed strings and overlapping layouts survive independently of text node splits", () => {
    let state = 0x20261018;
    const random = (limit: number) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return (state >>> 8) % limit;
    };
    const atoms = [
        "++",
        "**",
        "*",
        "~~",
        "_",
        "!?.,:;()[]",
        " ",
        "\n",
        "\\",
        "&nbsp;",
        "&amp;",
        "https://a.test",
        "www.a.test",
        "<b>",
        "![x](https://i.test)",
    ];
    for (let iteration = 0; iteration < 160; iteration++) {
        const text = `a${atoms[iteration % atoms.length]}b${atoms[random(atoms.length)]}c`;
        const spanning = ["bold", "italic", "strike", url].filter(() => random(2) === 0);
        const underlined = random(2) === 0;
        const input = [{ text, marks: [...spanning, ...(underlined ? ["underline"] : [])] }];
        const wanted = Array.from(text, (character) => ({
            text: character,
            marks: [...spanning, ...(underlined && character !== "\n" ? ["underline"] : [])],
        }));
        const source = roundTrip(input, wanted);
        expect(
            serializeComment(
                document(
                    Array.from(text, (character) => ({ text: character, marks: input[0].marks })),
                ),
            ),
        ).toBe(source);

        const overlap = [
            { text: "a", marks: ["bold"] },
            { text: `b${atoms[iteration % atoms.length]}c`, marks: ["bold", "italic"] },
            { text: "d", marks: ["italic", "strike"] },
            { text: "e", marks: ["strike", url] },
            { text: "f", marks: [url] },
        ];
        roundTrip(overlap);
    }
});

test("normalization keeps the input document intact", () => {
    const input = document([{ text: " x\ny ", marks: ["underline", "bold"] }]);
    const before = structuredClone(input);
    const oracle = expected([
        { text: " " },
        { text: "x", marks: ["underline", "bold"] },
        { text: "\n", marks: ["bold"] },
        { text: "y", marks: ["underline", "bold"] },
        { text: " " },
    ]);
    expect(flattenCommentDocument(normalizeCommentDocument(input))).toEqual(oracle);
    expect(input).toEqual(before);
});

test.each([
    { input: { type: "notDoc" }, error: "Expected a comment document" },
    { input: { type: "doc", content: [{ type: "heading" }] }, error: "Unsupported comment block" },
    {
        input: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "image", text: "x" }] }],
        },
        error: "Unsupported comment node",
    },
    {
        input: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text" }] }] },
        error: "Unsupported comment node",
    },
    { input: document([{ text: "x", marks: ["unsupported"] }]), error: "Unsupported comment mark" },
    {
        input: document([{ text: "x", marks: [JSON.stringify(["link", 42, null])] }]),
        error: "Invalid comment link",
    },
    {
        input: document([{ text: "x", marks: [JSON.stringify(["link", "https://x.y", 42])] }]),
        error: "Invalid comment title",
    },
    {
        input: {
            type: "doc",
            content: [
                {
                    type: "paragraph",
                    content: [{ type: "text", text: "x", marks: [{ type: "link" }] }],
                },
            ],
        },
        error: "Invalid comment link",
    },
])("rejects malformed comment input: $error", ({ input, error }) => {
    expect(() => serializeComment(input)).toThrow(error);
    expect(compareCommentDocument(input, [reparse])).toEqual({ saved: false });
});

test("an absent document content is an empty comment", () => {
    expect(serializeComment({ type: "doc" })).toBe("");
    expect(flattenCommentDocument({ type: "doc" })).toEqual({ text: "", marks: [] });
});

test("does not replace the character after a www prefix unless it is a dot", () => {
    expect.hasAssertions();
    roundTrip([{ text: "wwwx" }], undefined, "wwwx");
    roundTrip([{ text: "WWW.a.test" }], undefined, "WWW\\.a.test");
});

test("normalization never drops emphasis or link coverage on a covered break", () => {
    const marks = ["bold", "italic", "strike", url];
    const soft = document([{ text: "\n", marks: [...marks, "underline"] }]);
    expect(flattenCommentDocument(normalizeCommentDocument(soft))).toEqual(
        expected([{ text: "\n", marks }]),
    );
    const hard = document([
        { text: "a", marks },
        { text: "\n", hardBreak: true, marks: [...marks, "underline"] },
        { text: "b", marks },
    ]);
    expect(flattenCommentDocument(normalizeCommentDocument(hard))).toEqual(
        expected([
            { text: "a", marks },
            { text: "\n", marks },
            { text: "b", marks },
        ]),
    );
});

const BR: Span = { text: "\n", hardBreak: true };

test.each([
    { line: "1. e4 e5 2. Nf3", source: "Main idea  \n1\\. e4 e5 2. Nf3" },
    { line: "1) e4", source: "Main idea  \n1\\) e4" },
    { line: "12. Nf3", source: "Main idea  \n12\\. Nf3" },
    { line: "- a", source: "Main idea  \n\\- a" },
    { line: "+ a", source: "Main idea  \n\\+ a" },
    { line: "# h", source: "Main idea  \n\\# h" },
    { line: "---", source: "Main idea  \n\\---" },
    { line: "- - -", source: "Main idea  \n\\- - -" },
    { line: "   - a", source: "Main idea  \n   \\- a" },
])("escapes a paragraph-interrupting marker after a hard break: $line", ({ line, source }) => {
    expect.hasAssertions();
    roundTrip([{ text: "Main idea" }, BR, { text: line }], undefined, source);
});

test("leaves markers that do not start a line unescaped", () => {
    expect.hasAssertions();
    roundTrip([{ text: "1. e4 e5 is best - # 2." }], undefined, "1. e4 e5 is best - # 2.");
    roundTrip([{ text: "a" }, BR, { text: "b 1. - #" }], undefined, "a  \nb 1. - #");
    roundTrip(
        [{ text: "a" }, BR, { text: "-", marks: ["bold"] }, { text: " b" }],
        undefined,
        "a  \n**-** b",
    );
});

test("escapes every at sign so an address stays plain text", () => {
    expect.hasAssertions();
    roundTrip([{ text: "Write to foo@bar.com" }], undefined, "Write to foo\\@bar.com");
    roundTrip([{ text: "mail foo@bar.com then Nf3" }], undefined, "mail foo\\@bar.com then Nf3");
    roundTrip([{ text: "mailto:x@y.z" }], undefined, "mailto\\:x\\@y.z");
    const mailto = link("mailto:foo@bar.com");
    roundTrip(
        [{ text: "foo@bar.com", marks: [mailto] }],
        undefined,
        "[foo\\@bar.com](mailto:foo@bar.com)",
    );
});

test("spells a hard break with a backslash where the two-space break is lost", () => {
    expect.hasAssertions();
    roundTrip([{ text: "Idea " }, BR, { text: "next" }], undefined, "Idea \\\nnext");
    roundTrip([{ text: "a" }, BR, BR, { text: "b" }], undefined, "a  \n\\\nb");
    roundTrip([{ text: "a" }, BR, { text: " " }, BR, { text: "b" }], undefined, "a  \n \\\nb");
    roundTrip([BR, { text: "b" }], undefined, "\\\nb");
    roundTrip([{ text: "Idea" }, BR, { text: " next" }], undefined, "Idea  \n next");
});

test("drops a hard break that only whitespace follows to the paragraph end", () => {
    expect.hasAssertions();
    roundTrip([{ text: "Line" }, BR], [{ text: "Line" }], "Line");
    roundTrip([{ text: "Line" }, BR, { text: " " }, BR], [{ text: "Line " }], "Line ");
    roundTrip([BR], [], "");
});

test.each(["bold", "italic", "strike"])(
    "keeps %s off a hard break at either edge of its run",
    (type) => {
        expect.hasAssertions();
        const delimiter = { bold: "**", italic: "*", strike: "~~" }[type];
        roundTrip(
            [{ text: "ab", marks: [type] }, { ...BR, marks: [type] }, { text: "cd" }],
            [{ text: "ab", marks: [type] }, BR, { text: "cd" }],
            `${delimiter}ab${delimiter}  \ncd`,
        );
        roundTrip(
            [{ text: "ab" }, { ...BR, marks: [type] }, { text: "cd", marks: [type] }],
            [{ text: "ab" }, BR, { text: "cd", marks: [type] }],
            `ab  \n${delimiter}cd${delimiter}`,
        );
    },
);

test("keeps a link off a hard break that ends its text and on one that starts it", () => {
    expect.hasAssertions();
    roundTrip(
        [
            { text: "ab", marks: [url] },
            { ...BR, marks: [url] },
            { text: " ", marks: [url] },
            { text: "cd" },
        ],
        [{ text: "ab", marks: [url] }, BR, { text: " cd" }],
        "[ab](https://x.y)  \n cd",
    );
    roundTrip(
        [{ text: "ab" }, { ...BR, marks: [url] }, { text: "cd", marks: [url] }],
        undefined,
        "ab[  \ncd](https://x.y)",
    );
});
