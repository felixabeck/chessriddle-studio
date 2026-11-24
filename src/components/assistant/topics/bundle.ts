import { parseHelpTopic, type RawHelpTopic } from "./format";

const topicFiles = import.meta.glob("./*.md", {
    query: "?raw",
    import: "default",
    eager: true,
}) as Record<string, string>;

/** All shipped help topics, parsed once when this lazy chunk loads, ordered by id. */
export const rawHelpTopics: readonly RawHelpTopic[] = Object.entries(topicFiles)
    .map(([path, source]) => parseHelpTopic(source, path))
    .sort((a, b) => a.id.localeCompare(b.id));
