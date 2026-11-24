import type { AssistantTopic } from "@/bindings";
import { resolveHelpTopic, type RawHelpTopic } from "./topics/format";

export {
    LABEL_REF_PATTERN,
    TARGET_REF_PATTERN,
    extractLabelRefs,
    extractTargetRefs,
    parseHelpTopic,
    resolveHelpTopic,
    type RawHelpTopic,
} from "./topics/format";

type TopicBundleLoader = () => Promise<readonly RawHelpTopic[]>;

const defaultLoader: TopicBundleLoader = async () => {
    const module = await import("./topics/bundle");
    return module.rawHelpTopics;
};

let bundleLoader: TopicBundleLoader = defaultLoader;
let cachedTopics: Promise<readonly RawHelpTopic[]> | undefined;

/**
 * Loads the shipped help topics lazily on first Assistant use and resolves UI label references
 * into the active interface language. A failed load clears the cache so the next attempt retries.
 */
export async function loadHelpTopics(t: (key: string) => string): Promise<AssistantTopic[]> {
    cachedTopics ??= bundleLoader().catch((cause: unknown) => {
        cachedTopics = undefined;
        throw cause;
    });
    const raw = await cachedTopics;
    return raw.map((topic) => resolveHelpTopic(topic, t));
}

/** Test seam: replaces the topic bundle loader and clears the cached promise. */
export function setHelpTopicsLoaderForTests(loader: TopicBundleLoader | null): void {
    bundleLoader = loader ?? defaultLoader;
    cachedTopics = undefined;
}
