/** Ordered sidebar groups and emoji identities for help topics, shared with the ChessRiddle website. */
export const HELP_TOPIC_GROUPS = [
    {
        id: "basics",
        accent: "chart-6",
        topics: [
            { id: "tabs-and-new-tab", emoji: "🗂️" },
            { id: "analysis-board", emoji: "🔍" },
            { id: "library-and-files", emoji: "🗃️" },
            { id: "import-game", emoji: "📥" },
            { id: "keyboard-shortcuts", emoji: "⌨️" },
        ],
    },
    {
        id: "databases",
        accent: "chart-8",
        topics: [
            { id: "databases", emoji: "🗄️" },
            { id: "chessbase-import", emoji: "📦" },
            { id: "engines", emoji: "🧠" },
            { id: "game-report", emoji: "📊" },
        ],
    },
    {
        id: "training",
        accent: "chart-2",
        topics: [
            { id: "play-against-engine", emoji: "🤺" },
            { id: "repertoires", emoji: "📖" },
            { id: "puzzles", emoji: "🧩" },
        ],
    },
    {
        id: "accounts",
        accent: "chart-7",
        topics: [
            { id: "online-accounts", emoji: "🌐" },
            { id: "chessriddle-account", emoji: "👤" },
            { id: "ai-connections", emoji: "💬" },
            { id: "browser-extension", emoji: "🔗" },
        ],
    },
    {
        id: "app",
        accent: "chart-4",
        topics: [
            { id: "settings", emoji: "⚙️" },
            { id: "feedback", emoji: "🐛" },
        ],
    },
] as const;

export type HelpTopicGroup = (typeof HELP_TOPIC_GROUPS)[number];
export type HelpTopicGroupId = HelpTopicGroup["id"];
export type HelpTopicAccent = HelpTopicGroup["accent"];
export type HelpTopicEntry = HelpTopicGroup["topics"][number];
export type HelpTopicId = HelpTopicEntry["id"];

/**
 * Fixed reading order for all shipped help topics (flattened from `HELP_TOPIC_GROUPS`).
 * Every topic id in `topics/*.md` appears here exactly once.
 */
export const HELP_TOPIC_ORDER: readonly HelpTopicId[] = HELP_TOPIC_GROUPS.flatMap((group) =>
    group.topics.map((topic) => topic.id),
);

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
