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

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const SECTION_TAG_LINE = new RegExp(`^\\s*\\[\\s*${LINE_SECTION_TAG}\\s+"`);

/**
 * Sets or removes (`null`) the section tag in one game's raw text and leaves every other byte alone.
 * The text is edited directly because a parse and rewrite could drop content the tree cannot hold.
 */
export function withLineSection(pgn: string, section: string | null): string {
    const bom = pgn.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK : "";
    const eol = pgn.includes("\r\n") ? "\r\n" : "\n";
    const lines = pgn.slice(bom.length).split(/(?<=\n)/);
    let start = 0;
    while (start < lines.length && lines[start].trim() === "") start += 1;
    let end = start;
    while (end < lines.length && lines[end].trimStart().startsWith("[")) end += 1;

    const tags = lines.slice(start, end).filter((line) => !SECTION_TAG_LINE.test(line));
    if (section !== null) {
        const last = tags.length - 1;
        if (last >= 0 && !tags[last].endsWith("\n")) tags[last] += eol;
        tags.push(pgnTag(LINE_SECTION_TAG, normalizeLineSection(section)).replace("\n", eol));
        // A game without tags needs the blank line that separates its new tag from the moves.
        if (last < 0) tags.push(eol);
    }
    return bom + [...lines.slice(0, start), ...tags, ...lines.slice(end)].join("");
}
