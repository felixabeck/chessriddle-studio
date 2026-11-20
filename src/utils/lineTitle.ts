import type { GameHeaders } from "@/utils/treeReducer";

export type LineTitle = { name?: string; idea?: string };

/** A header value as a title: trimmed, with the PGN unknown marker "?" read as empty. */
export function titleValue(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed && trimmed !== "?" ? trimmed : undefined;
}

export function lineTitleOf(
    headers: Partial<Pick<GameHeaders, "white" | "black" | "event">>,
): LineTitle {
    return {
        name: titleValue(headers.white) ?? titleValue(headers.event),
        idea: titleValue(headers.black),
    };
}
