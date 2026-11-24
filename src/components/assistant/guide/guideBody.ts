import { TARGET_REF_PATTERN } from "../topics/format";
import type { AssistantTargetEntry } from "../targets";

export type GuideBlock =
    | { kind: "paragraph"; text: string }
    | { kind: "unordered-list"; items: string[] }
    | { kind: "ordered-list"; items: string[] };

export type GuideInlineSegment =
    | { kind: "text"; text: string }
    | { kind: "code"; text: string }
    | { kind: "link"; entry: AssistantTargetEntry }
    | { kind: "plain"; text: string };

const UNORDERED_ITEM = /^- (.*)$/;
const ORDERED_ITEM = /^\d+\. (.*)$/;
const DUPLICATE_PARENTHETICAL = /^(\s*)\(([^()]+)\)([\s\S]*)$/;
const INLINE_CODE_SPLIT = /(`[^`\n]+`)/g;

/**
 * Parses a shipped help topic body into paragraphs, unordered lists, and ordered lists.
 * Only those three block constructs exist in `topics/*.md`.
 */
export function parseGuideBlocks(body: string): GuideBlock[] {
    const lines = body.replace(/\r\n/g, "\n").split("\n");
    const blocks: GuideBlock[] = [];
    let current: GuideBlock | null = null;

    const flush = () => {
        if (current) {
            blocks.push(current);
            current = null;
        }
    };

    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (trimmed === "") {
            flush();
            continue;
        }

        const unordered = UNORDERED_ITEM.exec(rawLine);
        if (unordered) {
            if (current?.kind !== "unordered-list") {
                flush();
                current = { kind: "unordered-list", items: [] };
            }
            current.items.push(unordered[1]);
            continue;
        }

        const ordered = ORDERED_ITEM.exec(rawLine);
        if (ordered) {
            if (current?.kind !== "ordered-list") {
                flush();
                current = { kind: "ordered-list", items: [] };
            }
            current.items.push(ordered[1]);
            continue;
        }

        if (current?.kind === "paragraph") {
            current.text = `${current.text} ${trimmed}`;
        } else {
            flush();
            current = { kind: "paragraph", text: trimmed };
        }
    }

    flush();
    return blocks;
}

type RawInlineToken = { kind: "text"; text: string } | { kind: "target"; target: string };

function tokenizeTargets(text: string): RawInlineToken[] {
    const tokens: RawInlineToken[] = [];
    let cursor = 0;

    for (const match of text.matchAll(TARGET_REF_PATTERN)) {
        const index = match.index ?? 0;
        if (index > cursor) {
            tokens.push({ kind: "text", text: text.slice(cursor, index) });
        }
        tokens.push({ kind: "target", target: match[1] });
        cursor = index + match[0].length;
    }

    if (cursor < text.length) {
        tokens.push({ kind: "text", text: text.slice(cursor) });
    }

    return tokens;
}

/**
 * Splits inline text into plain segments (for `CoachText`), inline code spans, clickable target
 * links, and non-clickable plain labels for targets unavailable in the current build facts.
 * Suppresses an immediately following parenthetical that only repeats the link's own label.
 */
export function parseGuideInline(
    text: string,
    targets: ReadonlyMap<string, AssistantTargetEntry>,
    fallbackTargets: ReadonlyMap<string, AssistantTargetEntry>,
): GuideInlineSegment[] {
    const tokens = tokenizeTargets(text);
    const segments: GuideInlineSegment[] = [];

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.kind === "target") {
            const entry = targets.get(token.target);
            const label = entry?.label ?? fallbackTargets.get(token.target)?.label ?? "";

            const next = tokens[i + 1];
            if (next?.kind === "text" && label !== "") {
                const match = DUPLICATE_PARENTHETICAL.exec(next.text);
                if (match && match[2].trim() === label.trim()) {
                    next.text = match[3];
                }
            }

            if (entry) {
                segments.push({ kind: "link", entry });
            } else if (label !== "") {
                segments.push({ kind: "plain", text: label });
            }
            continue;
        }

        if (token.text === "") continue;
        for (const part of token.text.split(INLINE_CODE_SPLIT)) {
            if (part === "") continue;
            if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
                segments.push({ kind: "code", text: part.slice(1, -1) });
            } else {
                segments.push({ kind: "text", text: part });
            }
        }
    }

    return segments;
}
