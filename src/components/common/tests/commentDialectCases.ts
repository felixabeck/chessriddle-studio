// Shared reader/editor fixtures. Production code must not import this module.
export type CommentDialectCase = {
    name: string;
    input: string;
    text: string;
    edited?: string;
    formatting: { selector: string; text: string }[];
    absent: string[];
};

type CaseInput = Omit<CommentDialectCase, "text" | "formatting" | "absent"> &
    Partial<Pick<CommentDialectCase, "text" | "formatting" | "absent">>;

const cases: CaseInput[] = [
    { name: "move-like prose", input: "59. Olvidé mi preparación." },
    { name: "bullet", input: "- a" },
    { name: "heading", input: "# a" },
    { name: "quote", input: "> a", edited: "\\> a!" },
    { name: "rule", input: "---" },
    { name: "setext heading", input: "a\n---", text: "a\n\n---", edited: "a\n\n---!" },
    { name: "indented code", input: "    indented" },
    { name: "fenced code", input: "```\nfenced text\n```", edited: "```\nfenced text\n\\```!" },
    { name: "inline code", input: "`x`" },
    {
        name: "table",
        input: "| a | b |\n| --- | --- |\n| c | d |",
        edited: "| a | b |\n\\| --- | --- |\n\\| c | d |!",
    },
    { name: "footnote", input: "call[^1]\n\n[^1]: x", edited: "call\\[^1\\]\n\n\\[^1\\]\\: x!" },
    {
        name: "reference definition",
        input: "[a]: https://x.y",
        edited: "\\[a\\]\\: [https\\://x.y](https://x.y)!",
        formatting: [{ selector: 'a[href="https://x.y"]', text: "https://x.y" }],
    },
    {
        name: "escaped marker",
        input: "1\\. escaped",
        text: "1. escaped",
        edited: "1. escaped!",
    },
    { name: "paragraphs", input: "a\n\nb" },
    { name: "soft break", input: "a\nb" },
    { name: "unpaired emphasis", input: "plain *star text", edited: "plain \\*star text!" },
    {
        name: "empty underline stays literal",
        input: "++++",
        text: "++++",
        edited: "\\+\\+\\+\\+!",
        absent: ["u"],
    },
    {
        name: "single-plus underline",
        input: "+++++",
        edited: "+++++!",
        text: "+",
        formatting: [{ selector: "u", text: "+" }],
    },
    {
        name: "double-check notation",
        input: "Qh7++ Kh8 Qg8++ wins",
        edited: "Qh7\\+\\+ Kh8 Qg8\\+\\+ wins!",
        text: "Qh7++ Kh8 Qg8++ wins",
        absent: ["u"],
    },
    {
        name: "whitespace-flanked underline stays literal",
        input: "a++ b ++c",
        edited: "a\\+\\+ b \\+\\+c!",
        text: "a++ b ++c",
        absent: ["u"],
    },
    {
        name: "underline with leading whitespace stays literal",
        input: "++ x++",
        edited: "\\+\\+ x\\+\\+!",
        text: "++ x++",
        absent: ["u"],
    },
    {
        name: "underline with trailing whitespace stays literal",
        input: "++x ++",
        edited: "\\+\\+x \\+\\+!",
        text: "++x ++",
        absent: ["u"],
    },
    {
        name: "underline across a newline stays literal",
        input: "++a\nb++",
        edited: "\\+\\+a\nb\\+\\+!",
        text: "++a\nb++",
        absent: ["u"],
    },
    {
        name: "single-character underline",
        input: "++x++",
        text: "x",
        formatting: [{ selector: "u", text: "x" }],
    },
    {
        name: "word underline",
        input: "++critical++",
        text: "critical",
        formatting: [{ selector: "u", text: "critical" }],
    },
    {
        name: "underline with internal whitespace",
        input: "a ++b c++ d",
        text: "a b c d",
        formatting: [{ selector: "u", text: "b c" }],
    },
    {
        name: "bold with underline",
        input: "++**x**++",
        text: "x",
        formatting: [{ selector: "u strong", text: "x" }],
    },
    {
        name: "italic with underline",
        input: "++*x*++",
        text: "x",
        formatting: [{ selector: "u em", text: "x" }],
    },
    {
        name: "link with underline",
        input: "++[x](https://x.y)++",
        text: "x",
        formatting: [{ selector: 'u a[href="https://x.y"]', text: "x" }],
    },
    {
        name: "unmatched underline before strong",
        input: "++a **b**",
        edited: "\\+\\+a **b**!",
        text: "++a b",
        formatting: [{ selector: "strong", text: "b" }],
        absent: ["u"],
    },
    {
        name: "inline formatting",
        input: "**b** *i* ++u++ ~~s~~ [l](https://x.y) https://lichess.org",
        text: "b i u s l https://lichess.org",
        edited: "**b** *i* ++u++ ~~s~~ [l](https://x.y) [https\\://lichess.org](https://lichess.org)!",
        formatting: [
            { selector: "strong", text: "b" },
            { selector: "em", text: "i" },
            { selector: "u", text: "u" },
            { selector: "del", text: "s" },
            { selector: 'a[href="https://x.y"]', text: "l" },
            { selector: 'a[href="https://lichess.org"]', text: "https://lichess.org" },
        ],
    },
    {
        name: "adjacent links with distinct destinations",
        input: "[a](https://a.test)[b](https://b.test)",
        text: "ab",
        formatting: [
            { selector: 'a[href="https://a.test"]', text: "a" },
            { selector: 'a[href="https://b.test"]', text: "b" },
        ],
    },
    {
        name: "adjacent links with distinct titles",
        input: '[a](https://x.y "first")[b](https://x.y "second")',
        text: "ab",
        formatting: [
            { selector: 'a[title="first"]', text: "a" },
            { selector: 'a[title="second"]', text: "b" },
        ],
    },
    {
        name: "formatting in block-looking prose",
        input: "59. **x**",
        text: "59. x",
        formatting: [{ selector: "strong", text: "x" }],
    },
    {
        name: "underline between backticks",
        input: "`++literal++` and ++underlined++",
        text: "`literal` and underlined",
        formatting: [
            { selector: "u:first-of-type", text: "literal" },
            { selector: "u:last-of-type", text: "underlined" },
        ],
    },
    { name: "raw HTML", input: "<b>x</b>", edited: "\\<b\\>x\\</b\\>!" },
    {
        name: "strike with underline",
        input: "++~~x~~++",
        text: "x",
        formatting: [{ selector: "u del", text: "x" }],
    },
    {
        name: "mixed underline siblings",
        input: "before ++a **b** *c* ~~d~~ [e](https://x.y) f++ after",
        text: "before a b c d e f after",
        formatting: [
            { selector: "u", text: "a b c d e f" },
            { selector: "u strong", text: "b" },
            { selector: "u em", text: "c" },
            { selector: "u del", text: "d" },
            { selector: 'u a[href="https://x.y"]', text: "e" },
        ],
    },
    ...["\n", "\n\n"].flatMap((separator) => [
        {
            name: `D3-1 strong across ${JSON.stringify(separator)}`,
            input: `++**a${separator}b**++`,
            edited:
                separator === "\n" ? "\\+\\+**a\nb**\\+\\+!" : "\\+\\+\\*\\*a\n\nb\\*\\*\\+\\+!",
            text: separator === "\n" ? `++a${separator}b++` : `++**a${separator}b**++`,
            formatting: separator === "\n" ? [{ selector: "strong", text: `a${separator}b` }] : [],
            absent: ["u"],
        },
        {
            name: `D3-1 emphasis across ${JSON.stringify(separator)}`,
            input: `++*a${separator}b*++`,
            edited: separator === "\n" ? "\\+\\+*a\nb*\\+\\+!" : "\\+\\+\\*a\n\nb\\*\\+\\+!",
            text: separator === "\n" ? `++a${separator}b++` : `++*a${separator}b*++`,
            formatting: separator === "\n" ? [{ selector: "em", text: `a${separator}b` }] : [],
            absent: ["u"],
        },
        {
            name: `D3-1 strike across ${JSON.stringify(separator)}`,
            input: `++~~a${separator}b~~++`,
            edited:
                separator === "\n" ? "\\+\\+~~a\nb~~\\+\\+!" : "\\+\\+\\~\\~a\n\nb\\~\\~\\+\\+!",
            text: separator === "\n" ? `++a${separator}b++` : `++~~a${separator}b~~++`,
            formatting: separator === "\n" ? [{ selector: "del", text: `a${separator}b` }] : [],
            absent: ["u"],
        },
        {
            name: `D3-1 link label across ${JSON.stringify(separator)}`,
            input: `++[a${separator}b](https://x.y)++`,
            text: separator === "\n" ? `++a${separator}b++` : `++[a${separator}b](https://x.y)++`,
            edited:
                separator === "\n"
                    ? "\\+\\+[a\nb](https://x.y)\\+\\+!"
                    : "\\+\\+\\[a\n\nb\\]\\([https\\://x.y\\)\\+\\+](<https://x.y)++>)!",
            formatting:
                separator === "\n"
                    ? [{ selector: 'a[href="https://x.y"]', text: `a${separator}b` }]
                    : [{ selector: 'a[href="https://x.y)++"]', text: "https://x.y)++" }],
            absent: ["u"],
        },
    ]),
    {
        name: "underline autolink boundary",
        input: "++https://x.y/p++",
        text: "https://x.y/p",
        edited: "++[https\\://x.y/p](https://x.y/p)++!",
        formatting: [{ selector: 'u a[href="https://x.y/p"]', text: "https://x.y/p" }],
    },
    {
        name: "underline inside strong",
        input: "**++x++**",
        text: "x",
        edited: "++**x**++!",
        formatting: [{ selector: "strong u", text: "x" }],
    },
    {
        name: "crossing strong boundary",
        input: "++**x++**",
        edited: "++\\*\\*x++\\*\\*!",
        text: "**x**",
        formatting: [{ selector: "u", text: "**x" }],
        absent: ["strong"],
    },
    {
        name: "repeated underline pairs",
        input: "++a++++b++",
        text: "ab",
        edited: "++ab++!",
        formatting: [{ selector: "u", text: "ab" }],
    },
    { name: "unmatched underline", input: "++x", edited: "\\+\\+x!" },
    {
        name: "backticks inside underline",
        input: "++`x`++",
        text: "`x`",
        formatting: [{ selector: "u", text: "`x`" }],
    },
    {
        name: "escape inside underline",
        input: "++1\\.++",
        text: "1.",
        edited: "++1.++!",
        formatting: [{ selector: "u", text: "1." }],
    },
    {
        name: "escaped underline delimiters",
        input: "\\+\\+x\\+\\+",
        text: "++x++",
    },
    {
        name: "Markdown image",
        input: "![a](https://x.y/i)",
        edited: "\\!\\[a\\]\\(https\\://x.y/i\\)!",
    },
    {
        name: "formatted image label stays literal",
        input: "![**a**](u)",
        edited: "\\!\\[\\*\\*a\\*\\*\\]\\(u\\)!",
    },
    { name: "literal entity", input: "&nbsp;" },
    { name: "literal entities in paragraphs", input: "&nbsp;\n\n&nbsp;" },
    { name: "entity among text", input: "a &nbsp; &amp; b" },
    {
        name: "formatting inside table-looking prose",
        input: "| **a** | b |\n| --- | --- |\n| c | d |",
        edited: "| **a** | b |\n\\| --- | --- |\n\\| c | d |!",
        text: "| a | b |\n| --- | --- |\n| c | d |",
        formatting: [{ selector: "strong", text: "a" }],
    },
    {
        name: "HTML tags do not change nested configuration",
        input: "++<script>**x**</script>++",
        edited: "++\\<script\\>**x**\\</script\\>++!",
        text: "<script>x</script>",
        formatting: [
            { selector: "u", text: "<script>x</script>" },
            { selector: "u strong", text: "x" },
        ],
    },
    {
        name: "emphasis delimiter normalization",
        input: "_x_ __y__",
        text: "x y",
        edited: "*x* **y**!",
        formatting: [
            { selector: "em", text: "x" },
            { selector: "strong", text: "y" },
        ],
    },
    {
        name: "link title normalization",
        input: "[x](https://x.y 'title')",
        text: "x",
        edited: '[x](https://x.y "title")!',
        formatting: [{ selector: 'a[href="https://x.y"]', text: "x" }],
    },
    { name: "blank line normalization", input: "a\n\n\n\nb", text: "a\n\nb", edited: "a\n\nb!" },
    {
        name: "quoted link title",
        input: `[x](https://x.y 'a "b"')`,
        text: "x",
        edited: '[x](https://x.y "a \\"b\\"")!',
        formatting: [{ selector: 'a[href="https://x.y"]', text: "x" }],
    },
    {
        name: "hard break",
        input: "a  \nb",
        text: "a\nb",
    },
];

export const commentDialectCases: CommentDialectCase[] = cases.map((fixture) => ({
    ...fixture,
    text: fixture.text ?? fixture.input,
    formatting: fixture.formatting ?? [],
    absent:
        fixture.absent ??
        ["strong", "em", "del", "u", "a"].filter(
            (selector) =>
                !(fixture.formatting ?? []).some((mark) => mark.selector.includes(selector)),
        ),
}));

/** Include breaks and paragraph boundaries, independent of each adapter's DOM nesting. */
export function commentDomText(element: Element): string {
    const inlineText = (node: Node): string => {
        if (node instanceof Element && node.tagName === "BR") return "\n";
        if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
        return [...node.childNodes].map(inlineText).join("");
    };
    const paragraphs = [...element.querySelectorAll("p")];
    return paragraphs.length ? paragraphs.map(inlineText).join("\n\n") : inlineText(element);
}

/** Mark coverage is independent of whether Tiptap nests strong inside u or u inside strong. */
export function commentMarkedText(element: Element, selector: string): string {
    const selectors = commentMarkSelector(selector).split(" ");
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text = "";
    while (walker.nextNode()) {
        const node = walker.currentNode;
        if (
            selectors.every((part) => {
                const ancestor = node.parentElement?.closest(part);
                return ancestor && element.contains(ancestor);
            })
        )
            text += node.textContent;
    }
    return text;
}

export function commentMarkSelector(selector: string): string {
    // Tiptap's strike mark uses s, while the reader uses del.
    return selector
        .split(" ")
        .map((part) => (part === "del" ? ":is(del,s)" : part))
        .join(" ");
}

export const forbiddenCommentElements =
    "ol, ul, li, h1, h2, h3, h4, h5, h6, blockquote, hr, pre, code, table, sup, section, [data-footnotes]";
