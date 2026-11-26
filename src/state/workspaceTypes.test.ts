import { expect, test, vi } from "vitest";
import {
    canonicalTabExplorerOptions,
    newWorkspaceId,
    storedTabSchema,
    tabSchema,
} from "./workspaceTypes";

test.each([
    [{ type: "chessriddleTraining" }, { type: "puzzles", puzzleSource: "chessriddle" }],
    [{ type: "puzzles" }, { type: "puzzles" }],
    [
        { type: "puzzles", puzzleSource: "future" },
        { type: "puzzles", puzzleSource: undefined },
    ],
    [
        { type: "puzzles", puzzleSource: "offline" },
        { type: "puzzles", puzzleSource: "offline" },
    ],
])("hydrates puzzle metadata %j", (input, expected) => {
    expect(
        tabSchema.parse({ name: "Puzzles", value: "tab", gameOrigin: { kind: "none" }, ...input }),
    ).toEqual({ name: "Puzzles", value: "tab", gameOrigin: { kind: "none" }, ...expected });
});

test("retries a UUID collision against known tabs and stored tree keys", () => {
    sessionStorage.clear();
    const known = "00000000-0000-4000-8000-000000000001";
    const stored = "00000000-0000-4000-8000-000000000002";
    const fresh = "00000000-0000-4000-8000-000000000003";
    sessionStorage.setItem(stored, "tree");
    const randomUUID = vi.spyOn(crypto, "randomUUID");
    randomUUID.mockReturnValueOnce(known).mockReturnValueOnce(stored).mockReturnValueOnce(fresh);

    expect(newWorkspaceId([known])).toBe(fresh);
    randomUUID.mockRestore();
});

test("fileDraft origins round-trip through the tab schema", () => {
    const tab = {
        name: "Caro",
        value: "tab",
        type: "analysis" as const,
        gameOrigin: {
            kind: "fileDraft" as const,
            file: {
                type: "file" as const,
                handle: { kind: "fileWorkspace" as const, id: { id: "repertoire" } },
                name: "Weiß_Caro Kann.pgn",
                numGames: 0,
                metadata: { type: "repertoire" as const, tags: [] },
                lastModified: 1,
            },
        },
    };
    expect(tabSchema.parse(tab)).toEqual(tab);
});

test("file tabs require an opaque capability instead of a renderer path", () => {
    expect(
        tabSchema.safeParse({
            name: "Legacy path",
            value: "tab",
            type: "analysis",
            gameOrigin: {
                kind: "file",
                file: { type: "file", path: "/tmp-sibling/game.pgn", name: "game", numGames: 1 },
                gameNumber: 0,
            },
        }).success,
    ).toBe(false);
});

test("valid tab explorer state round-trips unchanged and invalid explorer fails strict parse", () => {
    const tab = {
        name: "Prep",
        value: "tab",
        type: "analysis" as const,
        gameOrigin: { kind: "none" as const },
        explorer: {
            firstSource: "lch_all" as const,
            pinned: { kind: "database" as const, id: { id: "db-a" } },
            comparison: {
                database: { kind: "database" as const, id: { id: "db-b" } },
                player: 42,
            },
            further: ["reference" as const, "lch_master" as const],
            options: {
                player: 7,
                player_database: "db-a",
                color: "black" as const,
                start_date: "2024.01.01",
                result: "draw" as const,
                elo: [2000, 2600] as [number, number],
                exclude_fast_events: true as const,
            },
        },
    };
    expect(tabSchema.parse(tab)).toEqual(tab);
    expect(storedTabSchema.parse(tab)).toEqual(tab);

    const invalidCases = [
        {},
        { firstSource: "local" },
        { further: [] },
        { further: ["reference", "reference"] },
        { options: { player: null, color: "white", result: "any", exclude_fast_events: false } },
        { unknownKey: true },
    ];
    for (const explorer of invalidCases) {
        const input = { ...tab, explorer };
        expect(tabSchema.safeParse(input).success).toBe(false);
        const restored = storedTabSchema.parse(input);
        expect(restored).toEqual({
            name: "Prep",
            value: "tab",
            type: "analysis",
            gameOrigin: { kind: "none" },
        });
        expect("explorer" in restored).toBe(false);
    }
});

test("canonicalTabExplorerOptions omits player_database when player is null or player_database is empty", () => {
    const withoutPlayer = canonicalTabExplorerOptions({
        player: null,
        player_database: "db-a",
        color: "black",
        result: "draw",
    });
    expect(withoutPlayer).toEqual({
        player: null,
        color: "white",
        result: "draw",
    });
    expect("player_database" in withoutPlayer!).toBe(false);

    const emptyDatabase = canonicalTabExplorerOptions({
        player: 42,
        player_database: "",
        color: "black",
        result: "draw",
    });
    expect(emptyDatabase).toEqual({
        player: 42,
        color: "black",
        result: "draw",
    });
    expect("player_database" in emptyDatabase!).toBe(false);
});
