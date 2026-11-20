import { beforeAll, describe, expect, test, vi } from "vitest";
import { initializeI18n } from "@/i18n";
import { createTreeStore } from "@/state/store/tree";
import type { Tab } from "@/utils/tabs";
import { defaultTree, type GameHeaders } from "@/utils/treeReducer";
import { applyGameNames, initialGameNames, withGameNames } from "./gameNames";

const file = (type: "repertoire" | "game") => ({
    type: "file" as const,
    handle: { id: { id: "workspace-token" }, kind: "fileWorkspace" as const },
    name: "Weiß_Caro Kann.pgn",
    numGames: 8,
    metadata: { type, tags: [] },
    lastModified: 1,
});

function headersWith(values: Partial<GameHeaders>): GameHeaders {
    return { ...defaultTree().headers, ...values };
}

function apply(tab: Tab, before: Partial<GameHeaders>, next: Partial<GameHeaders>) {
    const tree = defaultTree();
    tree.headers = headersWith(before);
    const store = createTreeStore(undefined, tree);
    let updated = tab;
    const updateTab = vi.fn((_id: string, update: React.SetStateAction<Tab>) => {
        updated = typeof update === "function" ? update(updated) : update;
        return true;
    });
    applyGameNames({ store, tab, updateTab, next: headersWith(next) });
    return { tab: updated, headers: store.getState().headers, dirty: store.getState().dirty };
}

const tab = (name: string, gameOrigin: Tab["gameOrigin"]): Tab => ({
    name,
    value: "11111111-1111-4111-8111-111111111111",
    type: "analysis",
    gameOrigin,
});

describe("game names", () => {
    test("a line's name field edits White, or the Event it is named by", () => {
        expect(initialGameNames(headersWith({ white: "Main", event: "Caro" })).lineNameKey).toBe(
            "white",
        );
        expect(initialGameNames(headersWith({ white: "?", event: "Caro" })).lineNameKey).toBe(
            "event",
        );
        expect(initialGameNames(headersWith({})).lineNameKey).toBe("white");
    });

    test("untouched fields keep their spelling and edited ones are trimmed", () => {
        const headers = headersWith({ white: "?", black: " Idea ", event: "" });
        const names = initialGameNames(headers);
        expect(withGameNames(headers, names)).toEqual(headers);
        expect(withGameNames(headers, { ...names, white: "  Two Knights " })).toEqual({
            ...headers,
            white: "Two Knights",
        });
    });

    test("unchanged names leave the game clean", () => {
        const result = apply(tab("Main", { kind: "fileDraft", file: file("repertoire") }), {}, {});
        expect(result.dirty).toBe(false);
    });

    test("a named new line retitles its New game tab", () => {
        const draft = tab("New game", { kind: "fileDraft", file: file("repertoire") });
        expect(apply(draft, {}, { white: "Two Knights" }).tab.name).toBe("Two Knights");
    });

    test("an unnamed new game keeps its New game title", () => {
        const draft = tab("New game", { kind: "fileDraft", file: file("repertoire") });
        expect(apply(draft, {}, { black: "Only an idea" }).tab.name).toBe("New game");
        const database = tab("New game", {
            kind: "databaseDraft",
            database: { id: { id: "database-token" }, kind: "database" },
        });
        expect(apply(database, {}, { event: "" }).tab.name).toBe("New game");
        expect(apply(database, {}, { white: "Carlsen", black: "Nakamura" }).tab.name).toBe(
            "Carlsen - Nakamura",
        );
    });

    test("a stored line's tab follows a changed name, like Info panel title editing", () => {
        const stored = tab("My tab", { kind: "file", gameNumber: 1, file: file("repertoire") });
        expect(apply(stored, { white: "Old" }, { white: "New" }).tab.name).toBe("New");
        // A changed idea leaves the derived title, and so a hand-chosen tab name, alone.
        expect(apply(stored, { white: "Old" }, { white: "Old", black: "Idea" }).tab.name).toBe(
            "My tab",
        );
        // Clearing a stored line's name falls back to the file's name, as its title does.
        expect(apply(stored, { white: "Old" }, { white: "" }).tab.name).toBe("Weiß_Caro Kann");
    });
});

describe("a new game already named in the Info panel", () => {
    // The New game tab title is the translated default, as NewGameButton creates it.
    beforeAll(() => initializeI18n());

    test("takes that name when it is saved unchanged", () => {
        const draft = tab("New game", { kind: "fileDraft", file: file("repertoire") });
        expect(apply(draft, { white: "Two Knights" }, { white: "Two Knights" }).tab.name).toBe(
            "Two Knights",
        );
    });

    test("stays New game when its names are the PGN unknown marker", () => {
        const database = tab("New game", {
            kind: "databaseDraft",
            database: { id: { id: "database-token" }, kind: "database" },
        });
        // Headers parsed from a PGN carry "?" for unknown names, which are no name either.
        expect(
            apply(
                database,
                { white: "?", black: "?", event: "?" },
                { white: "?", black: "?", event: "?" },
            ).tab.name,
        ).toBe("New game");
    });

    test("keeps a tab title the user chose", () => {
        const draft = tab("My tab", { kind: "fileDraft", file: file("repertoire") });
        expect(apply(draft, { white: "Two Knights" }, { white: "Two Knights" }).tab.name).toBe(
            "My tab",
        );
    });
});
