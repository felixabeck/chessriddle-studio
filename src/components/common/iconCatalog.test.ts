import { describe, expect, test } from "vitest";
import { HELP_TOPIC_GROUPS } from "@/components/assistant/topics/order";
import chessRiddle from "./chessRiddleIconSnapshot.json";
import {
    ACCEPTED_EMOJI_OVERLAPS,
    EMOJI_IDENTITIES,
    LUCIDE_IDENTITIES,
    type EmojiId,
} from "./iconCatalog";

const emojiEntries = Object.entries(EMOJI_IDENTITIES) as [
    EmojiId,
    { glyph: string; chessRiddle?: string },
][];
const lucideEntries = Object.entries(LUCIDE_IDENTITIES) as [
    string,
    { icon: { displayName?: string }; chessRiddle?: string },
][];
const chessRiddleEmoji = chessRiddle.emoji as Record<string, string[]>;
const chessRiddleLucide = chessRiddle.lucide as Record<string, string[]>;

/** Each Guide topic's concept; `order.ts` cannot name it because the website parses that file. */
const GUIDE_TOPIC_CONCEPTS: Record<string, EmojiId> = {
    "tabs-and-new-tab": "tabsFiles",
    "analysis-board": "analysis",
    "library-and-files": "library",
    "import-game": "importGame",
    "keyboard-shortcuts": "keyboard",
    databases: "database",
    "chessbase-import": "chessbaseImport",
    engines: "engine",
    "game-report": "gameReport",
    "play-against-engine": "play",
    repertoires: "repertoire",
    puzzles: "puzzles",
    "online-accounts": "onlineAccounts",
    "chessriddle-account": "account",
    "ai-connections": "coach",
    "browser-extension": "browserExtension",
    settings: "settings",
    feedback: "bug",
};

function acceptedOverlap(glyph: string, ids: string[]): boolean {
    return ACCEPTED_EMOJI_OVERLAPS.some(
        (overlap) =>
            overlap.glyph === glyph &&
            overlap.ids.length === ids.length &&
            ids.every((id) => (overlap.ids as readonly string[]).includes(id)),
    );
}

describe("emoji identities", () => {
    test("two concepts never share a glyph, apart from the accepted overlaps", () => {
        const byGlyph = new Map<string, string[]>();
        for (const [id, { glyph }] of emojiEntries) {
            byGlyph.set(glyph, [...(byGlyph.get(glyph) ?? []), id]);
        }
        const clashes = [...byGlyph].filter(
            ([glyph, ids]) => ids.length > 1 && !acceptedOverlap(glyph, ids),
        );
        expect(clashes).toEqual([]);
    });

    test("every accepted overlap still exists exactly as recorded", () => {
        for (const { glyph, ids } of ACCEPTED_EMOJI_OVERLAPS) {
            for (const id of ids) expect(EMOJI_IDENTITIES[id].glyph).toBe(glyph);
        }
    });

    test("a glyph ChessRiddle shows means the same here, and names that identity", () => {
        const mismatches = emojiEntries.flatMap(([id, entry]) => {
            const theirs = chessRiddleEmoji[entry.glyph];
            if (theirs === undefined) {
                return entry.chessRiddle === undefined
                    ? []
                    : [`${id}: ${entry.glyph} is not in ChessRiddle`];
            }
            if (entry.chessRiddle !== undefined) {
                return theirs.includes(entry.chessRiddle)
                    ? []
                    : [`${id}: ${entry.glyph} means ${theirs.join(", ")} in ChessRiddle`];
            }
            // Only a member of an accepted overlap may carry no ChessRiddle meaning (tabsFiles: 🗂️).
            if (acceptedOverlap(entry.glyph, [id, ...otherIdsWithGlyph(id, entry.glyph)]))
                return [];
            return [`${id}: ${entry.glyph} means ${theirs.join(", ")} in ChessRiddle`];
        });
        expect(mismatches).toEqual([]);
    });

    test("Guide topic emoji (kept literal for the website reader) show their concept's glyph", () => {
        const topics: readonly { id: string; emoji: string }[] = HELP_TOPIC_GROUPS.flatMap(
            (group): readonly { id: string; emoji: string }[] => group.topics,
        );
        expect(Object.keys(GUIDE_TOPIC_CONCEPTS).sort()).toEqual(
            topics.map((topic) => topic.id).sort(),
        );
        const strays = topics
            .filter(
                (topic) =>
                    topic.emoji !==
                    EMOJI_IDENTITIES[GUIDE_TOPIC_CONCEPTS[topic.id] as EmojiId]?.glyph,
            )
            .map((topic) => topic.id);
        expect(strays).toEqual([]);
    });
});

function otherIdsWithGlyph(id: string, glyph: string): string[] {
    return emojiEntries
        .filter(([other, entry]) => other !== id && entry.glyph === glyph)
        .map(([other]) => other);
}

describe("lucide identities", () => {
    test("two concepts never share an icon", () => {
        const icons = lucideEntries.map(([, { icon }]) => icon);
        expect(new Set(icons).size).toBe(icons.length);
    });

    test("an icon ChessRiddle shows means the same here, and names that identity", () => {
        const mismatches = lucideEntries.flatMap(([id, entry]) => {
            const name = entry.icon.displayName ?? "";
            if (name === "") return [`${id}: lucide icon has no display name`];
            const theirs = chessRiddleLucide[name];
            if (theirs === undefined) {
                return entry.chessRiddle === undefined
                    ? []
                    : [`${id}: ${name} is not in ChessRiddle`];
            }
            return entry.chessRiddle !== undefined && theirs.includes(entry.chessRiddle)
                ? []
                : [`${id}: ${name} means ${theirs.join(", ")} in ChessRiddle`];
        });
        expect(mismatches).toEqual([]);
    });
});
