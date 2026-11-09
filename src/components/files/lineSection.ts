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
// One tag pair, not a whole line: PGN allows several tag pairs on a single line.
const SECTION_TAG_PAIR = new RegExp(
    `\\[\\s*${LINE_SECTION_TAG}\\s+"(?:[^"\\\\]|\\\\.)*"\\s*\\]`,
    "g",
);

function isTagLine(line: string) {
    return line.trimStart().startsWith("[");
}

// A % or ; line is an escape or comment the parser also accepts between tags.
function isEscapeLine(line: string) {
    return /^\s*[%;]/.test(line);
}

function withoutSectionTag(line: string): string | null {
    const stripped = line.replace(SECTION_TAG_PAIR, "");
    if (stripped === line) return line;
    if (stripped.trim() === "") return null;
    return stripped.trimStart().replace(/[ \t]+(\r?\n?)$/, "$1");
}

/**
 * Sets or removes (`null`) the section tag in one game's raw text and leaves everything else alone.
 * The text is edited directly because a parse and rewrite could drop content the tree cannot hold.
 */
export function withLineSection(pgn: string, section: string | null): string {
    const bom = pgn.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK : "";
    const eol = pgn.includes("\r\n") ? "\r\n" : "\n";
    const tagOf = (name: string, value: string) => pgnTag(name, value).replace("\n", eol);
    const lines = pgn.slice(bom.length).split(/(?<=\n)/);
    let start = 0;
    while (start < lines.length && lines[start].trim() === "") start += 1;
    let end = start;
    for (let index = start; index < lines.length; index += 1) {
        if (isTagLine(lines[index])) end = index + 1;
        else if (!isEscapeLine(lines[index])) break;
    }
    const hadTags = end > start;

    const block = lines
        .slice(start, end)
        .map((line) => (isTagLine(line) ? withoutSectionTag(line) : line))
        .filter((line) => line !== null);
    if (section !== null) {
        const last = block.length - 1;
        if (last >= 0 && !block[last].endsWith("\n")) block[last] += eol;
        block.push(tagOf(LINE_SECTION_TAG, normalizeLineSection(section)));
        // A game without tags needs the blank line that separates its new tag from the moves.
        if (!hadTags) block.push(eol);
    } else if (hadTags && !block.some(isTagLine)) {
        // The scanner finds a later game by its header, so a game must not lose its only tag.
        block.push(tagOf("Event", "?"));
    }
    return bom + [...lines.slice(0, start), ...block, ...lines.slice(end)].join("");
}
