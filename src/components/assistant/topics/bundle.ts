import { parseHelpTopic, type RawHelpTopic } from "./format";
import { orderHelpTopics } from "./order";

const topicFiles = import.meta.glob("./*.md", {
    query: "?raw",
    import: "default",
    eager: true,
}) as Record<string, string>;

/** All shipped help topics, parsed once when this lazy chunk loads, in fixed reading order. */
export const rawHelpTopics: readonly RawHelpTopic[] = orderHelpTopics(
    Object.entries(topicFiles).map(([path, source]) => parseHelpTopic(source, path)),
);
