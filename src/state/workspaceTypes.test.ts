import { expect, test, vi } from "vitest";
import { newWorkspaceId, tabSchema } from "./workspaceTypes";

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
