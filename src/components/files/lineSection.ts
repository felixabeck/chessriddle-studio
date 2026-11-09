import { pgnTag } from "@/utils/chess";
import type { GameHeaders } from "@/utils/treeReducer";

/** PGN tag on the line that starts a section. An empty value is a section without a name: a gap. */
export const LINE_SECTION_TAG = "Section";
export const LINE_SECTION_MAX_LENGTH = 80;

export function normalizeLineSection(value: string): string {
    return value.replace(/\s+/g, " ").trim().slice(0, LINE_SECTION_MAX_LENGTH);
}

export function lineSectionOf(headers: Pick<GameHeaders, "other">): string | undefined {
    const value = headers.other?.[LINE_SECTION_TAG];
    return value === undefined ? undefined : normalizeLineSection(value);
}

type TagPair = { name: string; start: number; end: number };

/** The game's opening tag pairs, skipping what PGN allows between them. Stops at the moves. */
function scanTagPairs(pgn: string): TagPair[] {
    const tagPair = /\[\s*([^\s"\]]+)\s+"(?:[^"\\]|\\.)*"\s*\]/y;
    const tags: TagPair[] = [];
    let at = 0;
    while (at < pgn.length) {
        const character = pgn[at];
        if (/\s/.test(character)) {
            at += 1;
        } else if (character === "{" || character === "%" || character === ";") {
            const end = pgn.indexOf(character === "{" ? "}" : "\n", at);
            if (end < 0) break;
            at = end + 1;
        } else {
            tagPair.lastIndex = at;
            const match = tagPair.exec(pgn);
            if (!match) break;
            tags.push({ name: match[1], start: at, end: tagPair.lastIndex });
            at = tagPair.lastIndex;
        }
    }
    return tags;
}

function withoutTagPair(text: string, { start, end }: TagPair): string {
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const newline = text.indexOf("\n", end);
    const lineEnd = newline < 0 ? text.length : newline + 1;
    const aloneOnLine =
        text.slice(lineStart, start).trim() === "" && text.slice(end, lineEnd).trim() === "";
    if (aloneOnLine) return text.slice(0, lineStart) + text.slice(lineEnd);
    if (text.slice(lineStart, start).trim() === "") {
        return text.slice(0, start) + text.slice(end).replace(/^[ \t]+/, "");
    }
    return text.slice(0, start).replace(/[ \t]+$/, "") + text.slice(end);
}

/**
 * Sets or removes (`null`) the section tag in one game's raw text and leaves everything else alone.
 * The text is edited directly because a parse and rewrite could drop content the tree cannot hold.
 */
export function withLineSection(pgn: string, section: string | null, gameIndex: number): string {
    const eol = pgn.includes("\r\n") ? "\r\n" : "\n";
    const tagText = (name: string, value: string) => pgnTag(name, value).replace("\n", eol);
    const tags = scanTagPairs(pgn);
    const sections = tags.filter((tag) => tag.name === LINE_SECTION_TAG);
    const text = sections.reduceRight(withoutTagPair, pgn);
    const remaining = scanTagPairs(text);

    if (section === null) {
        if (sections.length === 0 || remaining.length > 0) return text;
        // The scanner finds a later game by its header, so only the first game may lose its last tag.
        if (gameIndex > 0) return tagText("Event", "?") + text;
        return text.replace(/^\r?\n/, "");
    }

    const tag = tagText(LINE_SECTION_TAG, normalizeLineSection(section));
    const last = remaining.at(-1);
    if (!last) return tag + (sections.length > 0 ? "" : eol) + text;
    const newline = text.indexOf("\n", last.end);
    const lineEnd = newline < 0 ? text.length : newline;
    if (text.slice(last.end, lineEnd).trim() === "") {
        const head = newline < 0 ? text + eol : text.slice(0, newline + 1);
        return head + tag + (newline < 0 ? "" : text.slice(newline + 1));
    }
    // Moves can follow the last tag on its own line, and the new tag must stay before them.
    return text.slice(0, last.end) + eol + tag + text.slice(last.end).replace(/^[ \t]+/, "");
}
