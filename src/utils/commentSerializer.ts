import type { JSONContent } from "@tiptap/react";

export type CommentFormatting = {
    text: string;
    marks: string[][];
};

export type CommentReparseAdapter = (source: string) => JSONContent;

export type CommentComparison = { saved: true; source: string } | { saved: false };

type Character = {
    text: string;
    marks: string[];
    hardBreak: boolean;
    /** Set by `serializeComment`, which sees the whole paragraph. */
    backslashBreak?: boolean;
};

const DELIMITERS = { bold: "**", italic: "*", strike: "~~", underline: "++" };

function markKey(mark: NonNullable<JSONContent["marks"]>[number]): string {
    if (mark.type === "link") {
        if (typeof mark.attrs?.href !== "string") throw new Error("Invalid comment link");
        const title = mark.attrs.title ?? null;
        if (title !== null && typeof title !== "string") throw new Error("Invalid comment title");
        return JSON.stringify(["link", mark.attrs.href, title]);
    }
    if (!Object.hasOwn(DELIMITERS, mark.type)) throw new Error("Unsupported comment mark");
    return mark.type;
}

function paragraphs(document: JSONContent): Character[][] {
    if (document.type !== "doc") throw new Error("Expected a comment document");
    return (document.content ?? [])
        .map((paragraph) => {
            if (paragraph.type !== "paragraph") throw new Error("Unsupported comment block");
            return (paragraph.content ?? []).flatMap((node): Character[] => {
                const marks = [...new Set((node.marks ?? []).map(markKey))].sort();
                if (node.type === "hardBreak") return [{ text: "\n", marks, hardBreak: true }];
                if (node.type !== "text" || typeof node.text !== "string") {
                    throw new Error("Unsupported comment node");
                }
                return Array.from(node.text, (text) => ({
                    text,
                    marks: [...marks],
                    hardBreak: false,
                }));
            });
        })
        .filter((paragraph) => paragraph.length > 0);
}

function runs(characters: Character[], mark: string): [number, number][] {
    const result: [number, number][] = [];
    for (let start = 0; start < characters.length; start++) {
        if (!characters[start].marks.includes(mark)) continue;
        let end = start + 1;
        while (end < characters.length && characters[end].marks.includes(mark)) end++;
        result.push([start, end]);
        start = end - 1;
    }
    return result;
}

function normalize(paragraph: Character[]): Character[] {
    const characters = paragraph.map((character) => ({
        ...character,
        marks: [...character.marks],
    }));
    const remove = (index: number, mark: string) => {
        characters[index].marks = characters[index].marks.filter((candidate) => candidate !== mark);
    };
    const links = [...new Set(characters.flatMap((character) => character.marks))].filter((mark) =>
        mark.startsWith('["link",'),
    );
    for (const mark of links) {
        for (const [start, end] of runs(characters, mark)) {
            // Link text cannot end in a hard break: the reparse reads the break
            // as literal text. A break there and the whitespace after it leave the link.
            let edge = end;
            while (edge > start && /\s/u.test(characters[edge - 1].text)) edge--;
            if (characters.slice(edge, end).some((character) => character.hardBreak)) {
                for (let index = edge; index < end; index++) remove(index, mark);
            }
        }
    }
    for (const mark of ["bold", "italic", "strike", "underline"]) {
        if (mark === "underline") {
            characters.forEach((character, index) => {
                if (character.text === "\n") remove(index, mark);
            });
        }
        for (const [start, end] of runs(characters, mark)) {
            const canKeepSpace = (index: number) =>
                mark === "underline" &&
                characters[index].marks.some((candidate) => {
                    if (!candidate.startsWith('["link",')) return false;
                    // This character carries the link, so its run is the last one
                    // starting at or before it. Earlier runs may cover other lines.
                    const [first, last] = runs(characters, candidate).findLast(
                        ([first]) => first <= index,
                    )!;
                    return !characters
                        .slice(first, last)
                        .some((character) => character.text === "\n");
                });
            const flanking = characters.slice(start, end).map(
                (character, offset) =>
                    // A hard break at a run edge leaves its delimiter beside
                    // whitespace, so it flanks like a space.
                    (character.hardBreak || /[^\S\n]/u.test(character.text)) &&
                    !canKeepSpace(start + offset),
            );
            const first = flanking.indexOf(false);
            const last = flanking.lastIndexOf(false);
            flanking.forEach((_, offset) => {
                if (offset < first || offset > last) remove(start + offset, mark);
            });
        }
    }
    // A hard break followed only by whitespace has no Markdown spelling:
    // the reparse drops it at the end of the paragraph.
    let content = characters.length;
    while (content > 0 && /\s/u.test(characters[content - 1].text)) content--;
    return characters.filter((character, index) => index < content || !character.hardBreak);
}

function formatting(paragraphs: Character[][]): CommentFormatting {
    const characters = paragraphs.flatMap((paragraph, index) =>
        index === 0
            ? paragraph
            : [{ text: "\n", marks: [] }, { text: "\n", marks: [] }, ...paragraph],
    );
    return {
        text: characters.map((character) => character.text).join(""),
        marks: characters.map((character) => character.marks),
    };
}

export function flattenCommentDocument(document: JSONContent): CommentFormatting {
    return formatting(paragraphs(document));
}

export function normalizeCommentDocument(document: JSONContent): JSONContent {
    return {
        type: "doc",
        content: paragraphs(document).map((paragraph) => ({
            type: "paragraph",
            content: normalize(paragraph).map((character) => ({
                type: character.hardBreak ? "hardBreak" : "text",
                ...(character.hardBreak ? {} : { text: character.text }),
                marks: character.marks.map((key) => {
                    if (!key.startsWith('["link",')) return { type: key };
                    const [, href, title] = JSON.parse(key) as [string, string, string | null];
                    return { type: "link", attrs: { href, title } };
                }),
            })),
        })),
    };
}

// True when only spaces separate `index` from the previous line break.
// The slice start is a delimiter or the paragraph start, never a line start.
function startsLine(index: number, characters: Character[]): boolean {
    for (let previous = index - 1; previous >= 0; previous--) {
        if (characters[previous].text === "\n") return true;
        if (!/[^\S\n]/u.test(characters[previous].text)) return false;
    }
    return false;
}

// The `.` of a line-start digit run would start an ordered list.
function endsLineStartDigits(index: number, characters: Character[]): boolean {
    let first = index;
    while (first > 0 && /\d/u.test(characters[first - 1].text)) first--;
    return first < index && startsLine(first, characters);
}

function literal(character: Character, index: number, characters: Character[]): string {
    if (character.hardBreak) return character.backslashBreak ? "\\\n" : "  \n";
    if (
        // `@` would otherwise form a GFM e-mail autolink.
        /[\\*_[\]~<>:()@]/u.test(character.text) ||
        // A list or heading marker after a line break would end the paragraph.
        (/[-+#]/u.test(character.text) && startsLine(index, characters)) ||
        (character.text === "." && endsLineStartDigits(index, characters)) ||
        (character.text === "+" &&
            [characters[index - 1], characters[index + 1]].some(
                (neighbor) => neighbor?.text === "+",
            )) ||
        (character.text === "!" && characters[index + 1]?.text === "[")
    )
        return `\\${character.text}`;
    if (
        character.text === "." &&
        characters
            .slice(Math.max(0, index - 3), index)
            .map((item) => item.text)
            .join("")
            .toLowerCase() === "www"
    ) {
        return "\\.";
    }
    return character.text;
}

function wrap(mark: string, content: string): string {
    if (!mark.startsWith('["link",')) {
        const delimiter = DELIMITERS[mark as keyof typeof DELIMITERS];
        return delimiter + content + delimiter;
    }
    const [, href, title] = JSON.parse(mark) as [string, string, string | null];
    const destination = /[()]/u.test(href) ? `<${href}>` : href;
    const suffix = title === null ? "" : ` "${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    return `[${content}](${destination}${suffix})`;
}

// Lower priority is wrapped outside a run it does not strictly contain.
// Ranks: underline 1, link 2, italic 3, bold 4, strike 5.
// LINE_BREAK_OUTER_BIAS exceeds strike minus underline, so a mark that
// covers a newline is outside every mark that stays on one line.
// CROSSING_EMPHASIS_BIAS exceeds the gap between adjacent emphasis ranks
// and, subtracted from italic, stays between underline and link.
// WHITESPACE_BOUNDARY_BIAS exceeds strike minus underline and is smaller
// than LINE_BREAK_OUTER_BIAS, so emphasis that splits another run at a
// whitespace boundary is outside underline and link, while a newline-
// spanning mark stays further outside.
const UNDERLINE_PRIORITY = 1;
const EMPHASIS_PRIORITY_ORIGIN = 3;
const LINE_BREAK_OUTER_BIAS = 10;
const CROSSING_EMPHASIS_BIAS = 1.5;
const WHITESPACE_BOUNDARY_BIAS = 6;

function render(characters: Character[]): string {
    const marks = [...new Set(characters.flatMap((character) => character.marks))];
    const priority = (mark: string) => {
        if (mark === "underline") return UNDERLINE_PRIORITY;
        return ["italic", "bold", "strike"].indexOf(mark) + EMPHASIS_PRIORITY_ORIGIN;
    };
    const candidates = marks.flatMap((mark) =>
        runs(characters, mark).map(([start, end]) => ({
            mark,
            start,
            end,
            priority:
                priority(mark) -
                (characters.slice(start, end).some((character) => character.text === "\n")
                    ? LINE_BREAK_OUTER_BIAS
                    : 0),
        })),
    );
    for (const candidate of candidates) {
        if (
            (candidate.mark === "bold" || candidate.mark === "italic") &&
            candidates.some(
                (other) =>
                    (other.mark === "bold" || other.mark === "italic") &&
                    other.start < candidate.start &&
                    candidate.start < other.end,
            )
        ) {
            candidate.priority -= CROSSING_EMPHASIS_BIAS;
        }
        if (!["bold", "italic", "strike"].includes(candidate.mark)) continue;
        const splitsWhitespace = candidates.some((other) =>
            [other.start, other.end].some(
                (boundary) =>
                    candidate.start < boundary &&
                    boundary < candidate.end &&
                    /\s/u.test(characters[boundary - 1].text + characters[boundary].text),
            ),
        );
        if (splitsWhitespace) candidate.priority -= WHITESPACE_BOUNDARY_BIAS;
    }
    candidates.sort((left, right) => left.priority - right.priority);
    const selected = candidates.find(
        (candidate) =>
            !candidates.some(
                (other) =>
                    other.start <= candidate.start &&
                    candidate.end <= other.end &&
                    (other.start < candidate.start || candidate.end < other.end),
            ),
    );
    if (!selected) return characters.map(literal).join("");
    const { mark, start, end } = selected;
    const content = render(
        characters.slice(start, end).map((character) => ({
            ...character,
            marks: character.marks.filter((candidate) => candidate !== mark),
        })),
    );
    return render(characters.slice(0, start)) + wrap(mark, content) + render(characters.slice(end));
}

export function serializeComment(document: JSONContent): string {
    return paragraphs(normalizeCommentDocument(document))
        .map((paragraph) =>
            render(
                paragraph.map((character, index) => ({
                    ...character,
                    // A two-space break is dropped at the paragraph start and loses
                    // the whitespace before it, and a line of only spaces ends the
                    // paragraph. The backslash break keeps all three.
                    backslashBreak:
                        character.hardBreak &&
                        (index === 0 || /\s/u.test(paragraph[index - 1].text)),
                })),
            ),
        )
        .join("\n\n");
}

export function compareCommentDocument(
    document: JSONContent,
    adapters: readonly CommentReparseAdapter[],
): CommentComparison {
    try {
        if (adapters.length === 0) return { saved: false };
        const normalized = normalizeCommentDocument(document);
        const expected = flattenCommentDocument(normalized);
        const source = serializeComment(normalized);
        for (const adapter of adapters) {
            const actual = flattenCommentDocument(adapter(source));
            if (
                actual.text !== expected.text ||
                JSON.stringify(actual.marks) !== JSON.stringify(expected.marks)
            ) {
                return { saved: false };
            }
        }
        return { saved: true, source };
    } catch {
        return { saved: false };
    }
}
