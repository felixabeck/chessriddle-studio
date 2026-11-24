/**
 * Fixed reading order for all shipped help topics. Every topic id in `topics/*.md` appears here
 * exactly once.
 */
export const HELP_TOPIC_ORDER = [
    "tabs-and-new-tab",
    "analysis-board",
    "library-and-files",
    "databases",
    "import-game",
    "chessbase-import",
    "engines",
    "game-report",
    "play-against-engine",
    "repertoires",
    "puzzles",
    "online-accounts",
    "chessriddle-account",
    "ai-connections",
    "browser-extension",
    "keyboard-shortcuts",
    "settings",
    "feedback",
] as const;

const topicOrderIndex = new Map<string, number>(HELP_TOPIC_ORDER.map((id, index) => [id, index]));

/** Orders topics according to `HELP_TOPIC_ORDER`, with alphabetical fallback for unknown ids. */
export function orderHelpTopics<T extends { readonly id: string }>(topics: readonly T[]): T[] {
    return [...topics].sort((a, b) => {
        const indexA = topicOrderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const indexB = topicOrderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        if (indexA !== indexB) return indexA - indexB;
        return a.id.localeCompare(b.id);
    });
}
