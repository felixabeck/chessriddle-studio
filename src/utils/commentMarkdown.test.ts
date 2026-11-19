import { Markdown } from "@tiptap/markdown";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { marked } from "marked";
import { expect, test } from "vitest";
import { createCommentMarkdown, type CommentMarkdownToken } from "./commentMarkdown";

function inline(source: string, instance = createCommentMarkdown()) {
    const tokens: CommentMarkdownToken[] = instance.lexer(source);
    return tokens[0].tokens!;
}

test("D1-2 consumes the full underline pair and recursively retains strong tokens", () => {
    expect(inline("++**x**++")).toEqual([
        {
            type: "underline",
            raw: "++**x**++",
            text: "**x**",
            tokens: [
                {
                    type: "strong",
                    raw: "**x**",
                    text: "x",
                    tokens: [{ type: "text", raw: "x", text: "x", escaped: false }],
                },
            ],
        },
    ]);
});

test.each(["a++ b ++c", "++ x++", "++x ++", "Qh7++ Kh8 Qg8++ wins"])(
    "D2-1 keeps %j in an untrimmed text token",
    (source) => {
        expect(inline(source)).toEqual([
            { type: "text", raw: source, text: source, escaped: false },
        ]);
    },
);

test("D3-1 leaves plus delimiters around a strong token containing a newline", () => {
    expect(inline("++**a\nb**++")).toEqual([
        { type: "text", raw: "++", text: "++", escaped: false },
        {
            type: "strong",
            raw: "**a\nb**",
            text: "a\nb",
            tokens: [{ type: "text", raw: "a\nb", text: "a\nb", escaped: false }],
        },
        { type: "text", raw: "++", text: "++", escaped: false },
    ]);
});

test("nested underline uses the active dialect and leaves escapes distinct", () => {
    expect(inline("++`x` 1\\.++")).toEqual([
        {
            type: "underline",
            raw: "++`x` 1\\.++",
            text: "`x` 1\\.",
            tokens: [
                { type: "text", raw: "`x` 1", text: "`x` 1", escaped: false },
                { type: "escape", raw: "\\.", text: "." },
            ],
        },
    ]);
});

test.each([
    { source: '<img src=x onerror="alert(1)">', expected: ["text"] },
    { source: "<script>**x**</script>", expected: ["text", "strong"] },
    { source: "<a>https://x.y</a>", expected: ["text", "link"] },
    { source: "![**a**](https://x.y/i)", expected: ["text"] },
    { source: "&nbsp;", expected: ["text"] },
])("never emits HTML or image tokens for $source", ({ source, expected }) => {
    const types: string[] = [];
    const visit = (tokens: CommentMarkdownToken[]) => {
        for (const token of tokens) {
            types.push(token.type);
            if (token.tokens) visit(token.tokens);
        }
    };
    visit(createCommentMarkdown().lexer(source));
    expect(types).not.toContain("html");
    expect(types).not.toContain("image");
    expect(types).toEqual(expect.arrayContaining(expected));
});

function counts(instance: ReturnType<typeof createCommentMarkdown>) {
    return {
        inline: instance.defaults.extensions?.inline?.length ?? 0,
        block: instance.defaults.extensions?.block?.length ?? 0,
        starts: instance.defaults.extensions?.startInline?.length ?? 0,
    };
}

test("fresh factories isolate tokenizer registrations and nested parsing", () => {
    const first = createCommentMarkdown();
    const second = createCommentMarkdown();
    const initial = counts(second);
    first.use({
        extensions: [
            {
                name: "ownerOnly",
                level: "inline",
                start: (source) => source.indexOf("@"),
                tokenizer(source) {
                    if (!source.startsWith("@")) return undefined;
                    return { type: "text", raw: "@", text: "registered" };
                },
            },
        ],
    });
    expect(counts(first).inline).toBe(initial.inline + 1);
    expect(counts(second)).toEqual(initial);
    expect(inline("++@++", first)[0].tokens?.[0].text).toBe("registered");
    expect(inline("++@++", second)[0].tokens?.[0].text).toBe("@");
});

test("editor recreation leaves registrations constant on all prior factory instances", () => {
    const untouched = createCommentMarkdown();
    const initial = counts(untouched);
    const instances: ReturnType<typeof createCommentMarkdown>[] = [];
    const registered: ReturnType<typeof counts>[] = [];
    for (let index = 0; index < 5; index++) {
        const instance = createCommentMarkdown();
        const editor = new Editor({
            extensions: [
                StarterKit.configure({ underline: false }),
                Markdown.configure({ marked: instance as unknown as typeof marked }),
            ],
            content: "plain comment",
            contentType: "markdown",
        });
        try {
            instances.push(instance);
            registered.push(counts(instance));
        } finally {
            editor.destroy();
        }
    }
    expect(new Set(instances).size).toBe(instances.length);
    expect(registered).toEqual(instances.map(() => registered[0]));
    expect(instances.map(counts)).toEqual(registered);
    expect(counts(untouched)).toEqual(initial);
});
