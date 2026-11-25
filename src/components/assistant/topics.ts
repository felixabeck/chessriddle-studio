import type { AssistantTopic } from "@/bindings";
import { fallbackLocale, resolveSupportedLocale, type SupportedLocale } from "@/i18n";
import { parseHelpTopic, resolveHelpTopic, type RawHelpTopic } from "./topics/format";
import { orderHelpTopics } from "./topics/order";

export {
    LABEL_REF_PATTERN,
    TARGET_REF_PATTERN,
    extractLabelRefs,
    extractTargetRefs,
    parseHelpTopic,
    resolveHelpTopic,
    type RawHelpTopic,
} from "./topics/format";
export {
    HELP_TOPIC_GROUPS,
    HELP_TOPIC_ORDER,
    orderHelpTopics,
    type HelpTopicAccent,
    type HelpTopicGroupId,
    type HelpTopicId,
} from "./topics/order";

export type TopicBundleLoader = (locale: SupportedLocale) => Promise<readonly RawHelpTopic[]>;
export type LocalizedTopicFileMap = Record<string, () => Promise<string>>;

const localizedTopicFiles = import.meta.glob("./topics/*/*.md", {
    query: "?raw",
    import: "default",
}) as LocalizedTopicFileMap;

/**
 * Resolves and parses all topic files for a non-English locale from a Vite `import.meta.glob`
 * file map. Rejects when no files exist for `locale` instead of falling back to English.
 */
export async function loadLocalizedTopicFiles(
    files: LocalizedTopicFileMap,
    locale: SupportedLocale,
): Promise<readonly RawHelpTopic[]> {
    const prefix = `./topics/${locale}/`;
    const entries = Object.entries(files).filter(([path]) => path.startsWith(prefix));
    if (entries.length === 0) {
        throw new Error(`Help topics are not available for locale ${locale}`);
    }
    const parsed = await Promise.all(
        entries.map(async ([path, load]) => parseHelpTopic(await load(), path)),
    );
    return orderHelpTopics(parsed);
}

const defaultLoader: TopicBundleLoader = async (locale) => {
    if (locale === "en-US" || locale === "en-GB") {
        const module = await import("./topics/bundle");
        return module.rawHelpTopics;
    }
    return loadLocalizedTopicFiles(localizedTopicFiles, locale);
};

let bundleLoader: TopicBundleLoader = defaultLoader;
// Bounded by the 16 entries of `SupportedLocale`.
const cachedTopics = new Map<SupportedLocale, Promise<readonly RawHelpTopic[]>>();

/**
 * Loads the shipped help topics lazily for the requested interface locale (defaulting to English
 * for the Assistant) and resolves UI label references through `t`.
 * A rejected load or parse evicts that locale's cache entry so the next attempt retries.
 */
export async function loadHelpTopics(
    t: (key: string) => string,
    locale?: string | null,
): Promise<AssistantTopic[]> {
    const resolvedLocale = resolveSupportedLocale(locale ?? fallbackLocale);
    let pending = cachedTopics.get(resolvedLocale);
    if (!pending) {
        pending = bundleLoader(resolvedLocale).catch((cause: unknown) => {
            if (cachedTopics.get(resolvedLocale) === pending) {
                cachedTopics.delete(resolvedLocale);
            }
            throw cause;
        });
        cachedTopics.set(resolvedLocale, pending);
    }
    const raw = await pending;
    return raw.map((topic) => resolveHelpTopic(topic, t));
}

/** Test seam: replaces the topic bundle loader and clears all cached locale promises. */
export function setHelpTopicsLoaderForTests(loader: TopicBundleLoader | null): void {
    bundleLoader = loader ?? defaultLoader;
    cachedTopics.clear();
}
