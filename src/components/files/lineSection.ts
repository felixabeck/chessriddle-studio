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
