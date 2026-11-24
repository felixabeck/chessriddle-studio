import type { AssistantTopic } from "@/bindings";

export type RawHelpTopic = {
    readonly id: string;
    readonly title: string;
    readonly summary: string;
    readonly body: string;
};

/** Reference to a translation key inside a help topic, resolved in the active interface language. */
export const LABEL_REF_PATTERN = /\{\{label:([A-Za-z0-9._-]+)\}\}/g;

/** Link target reference inside a help topic body (same double-bracket syntax as model answers). */
export const TARGET_REF_PATTERN = /\[\[([^[\]\n]+)\]\]/g;

/**
 * Parses a shipped help topic file.
 * Format:
 * ```
 * ---
 * id: topic-id
 * title: Topic title
 * summary: One-line summary
 * ---
 * Body text...
 * ```
 */
export function parseHelpTopic(source: string, filename: string): RawHelpTopic {
    const normalized = source.replace(/\r\n/g, "\n");
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(normalized);
    if (!match) {
        throw new Error(`Help topic ${filename} is missing frontmatter delimiters`);
    }
    const [, frontmatter, body] = match;
    const fields = new Map<string, string>();
    for (const rawLine of frontmatter.split("\n")) {
        const line = rawLine.trim();
        if (line === "") continue;
        const colon = line.indexOf(":");
        if (colon === -1) {
            throw new Error(`Invalid frontmatter line in ${filename}: ${line}`);
        }
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        fields.set(key, value);
    }
    const id = fields.get("id");
    const title = fields.get("title");
    const summary = fields.get("summary");
    if (!id || !title || !summary) {
        throw new Error(`Help topic ${filename} must define id, title, and summary`);
    }
    return {
        id,
        title,
        summary,
        body: body.trim(),
    };
}

function replaceLabelRefs(text: string, t: (key: string) => string): string {
    return text.replace(LABEL_REF_PATTERN, (_match, key: string) => t(key));
}

/** Resolves all `{{label:...}}` references in a topic using the current interface translator. */
export function resolveHelpTopic(raw: RawHelpTopic, t: (key: string) => string): AssistantTopic {
    return {
        id: raw.id,
        title: replaceLabelRefs(raw.title, t),
        summary: replaceLabelRefs(raw.summary, t),
        body: replaceLabelRefs(raw.body, t),
    };
}

/** Extracts every translation key referenced via `{{label:...}}` in `text`. */
export function extractLabelRefs(text: string): string[] {
    const keys: string[] = [];
    for (const match of text.matchAll(LABEL_REF_PATTERN)) {
        keys.push(match[1]);
    }
    return keys;
}

/** Extracts every link target id referenced via `[[...]]` in `text`. */
export function extractTargetRefs(text: string): string[] {
    const targets: string[] = [];
    for (const match of text.matchAll(TARGET_REF_PATTERN)) {
        targets.push(match[1]);
    }
    return targets;
}
