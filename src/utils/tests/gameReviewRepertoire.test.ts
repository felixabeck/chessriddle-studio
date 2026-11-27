import { describe, expect, test } from "vitest";
import type { FileWorkspaceHandle } from "@/bindings";
import type {
    IndexedRepertoireChapter,
    IndexedRepertoireFile,
    RepertoireChapterNode,
    RepertoirePartialReason,
    RepertoireSnapshot,
} from "@/state/repertoireIndex";
import { createTreeStore } from "@/state/store/tree";
import type { ChessComStats } from "@/utils/chess.com/api";
import {
    compareGameToRepertoire,
    findMainlineNovelty,
    resolveUserSide,
} from "@/utils/gameReviewRepertoire";
import type { LichessAccount } from "@/utils/lichess/api";
import type { Session } from "@/utils/session";
import { defaultTree, getBoardState } from "@/utils/treeReducer";

const workspaceHandle: FileWorkspaceHandle = { id: { id: "ws-1" }, kind: "fileWorkspace" };

function buildRepertoireChapter(
    movesList: string[][],
    orientation?: "white" | "black",
    startFen?: string,
    chapter = 0,
): IndexedRepertoireChapter {
    const store = createTreeStore(undefined, startFen ? defaultTree(startFen) : undefined);
    for (const moves of movesList) {
        store.getState().goToStart();
        store.getState().makeMoves({ payload: moves });
    }
    const nodes: RepertoireChapterNode[] = [];
    function visit(
        node: ReturnType<typeof store.getState>["root"],
        parent: number,
        path: number[],
    ) {
        const index = nodes.length;
        nodes.push({
            boardState: getBoardState(node.fen),
            parent,
            san: node.san,
            path,
            halfMoves: node.halfMoves,
            hasContinuation: node.children.length > 0,
        });
        node.children.forEach((child, i) => visit(child, index, [...path, i]));
    }
    visit(store.getState().root, -1, []);
    return {
        chapter,
        headers: {
            orientation,
            start: undefined,
            white: "",
            black: "",
            event: "",
        },
        nodes,
    };
}

function makeRepertoireFile(
    name: string,
    chapters: IndexedRepertoireChapter[],
    partial = false,
): IndexedRepertoireFile {
    return {
        workspaceKey: "ws-1",
        file: {
            type: "file",
            name,
            numGames: chapters.length,
            lastModified: 0,
            handle: workspaceHandle,
            metadata: { type: "repertoire", tags: [] },
        },
        chapters,
        partial,
    };
}

function makeSnapshot(
    files: IndexedRepertoireFile[],
    partial = false,
    partialReason: RepertoirePartialReason | null = null,
): RepertoireSnapshot {
    return { files, partial, partialReason };
}

function makeLichessSession(username: string, alias?: string): Session {
    return {
        updatedAt: 1,
        alias,
        lichess: { username, account: {} as LichessAccount },
    };
}

function makeChessComSession(username: string, alias?: string): Session {
    return {
        updatedAt: 1,
        alias,
        chessCom: { username, stats: {} as ChessComStats },
    };
}

describe("resolveUserSide", () => {
    test("matches Lichess, Chess.com, or alias ignoring case and outer whitespace on either side", () => {
        const sessions = [
            makeLichessSession("LichessUser"),
            makeChessComSession("ChessComUser", "  My Alias  "),
        ];

        expect(
            resolveUserSide(
                { white: "  lichessuser ", black: "Opponent", orientation: "black" },
                sessions,
            ),
        ).toBe("white");
        expect(
            resolveUserSide(
                { white: "Opponent", black: "CHESSCOMUSER", orientation: "white" },
                sessions,
            ),
        ).toBe("black");
        expect(
            resolveUserSide(
                { white: "Opponent", black: "my alias", orientation: "white" },
                sessions,
            ),
        ).toBe("black");
    });

    test("falls back to headers.orientation (White when absent) when both or neither match", () => {
        const sessions = [makeLichessSession("Me", "SharedAlias")];

        // Both match (same player on both sides)
        expect(
            resolveUserSide({ white: "me", black: "sharedalias", orientation: "black" }, sessions),
        ).toBe("black");
        expect(
            resolveUserSide(
                { white: "me", black: "sharedalias", orientation: undefined },
                sessions,
            ),
        ).toBe("white");

        // Neither matches
        expect(
            resolveUserSide({ white: "Alice", black: "Bob", orientation: "black" }, sessions),
        ).toBe("black");
        expect(resolveUserSide({ white: "?", black: "", orientation: undefined }, sessions)).toBe(
            "white",
        );
    });
});

describe("compareGameToRepertoire", () => {
    test("reports a deviation with up to 3 repertoire moves, file name, and before-position", () => {
        const repFile = makeRepertoireFile("Sicilian & e4", [
            buildRepertoireChapter(
                [
                    ["e4", "e5", "Nf3", "Nc6"],
                    ["e4", "e5", "Bc4"],
                    ["e4", "e5", "Nc3"],
                    ["e4", "e5", "f4"],
                ],
                "white",
            ),
            // Opposite colour chapter must be ignored even if it has Qh5
            buildRepertoireChapter([["e4", "e5", "Qh5"]], "black"),
        ]);

        const game = createTreeStore();
        game.getState().makeMoves({ payload: ["e4", "e5", "Qh5", "Nc6"], mainline: true });

        const result = compareGameToRepertoire(
            game.getState().root,
            makeSnapshot([repFile]),
            "white",
        );
        expect(result).toEqual({
            kind: "deviation",
            move: {
                mainlineIndex: 3,
                path: [0, 0, 0],
                beforePath: [0, 0],
                beforeFen: game.getState().root.children[0].children[0].fen,
                halfMoves: 3,
                san: "Qh5",
            },
            repertoireMoves: ["Nf3", "Bc4", "Nc3"],
            fileName: "Sicilian & e4",
        });
    });

    test("counts a move beyond the first 3 repertoire choices as followed, not a deviation", () => {
        const repFile = makeRepertoireFile("Broad Repertoire", [
            buildRepertoireChapter(
                [
                    ["e4", "e5", "Nf3"],
                    ["e4", "e5", "Bc4"],
                    ["e4", "e5", "Nc3"],
                    ["e4", "e5", "f4"],
                ],
                "white",
            ),
        ]);

        const game = createTreeStore();
        game.getState().makeMoves({ payload: ["e4", "e5", "f4"], mainline: true });

        const result = compareGameToRepertoire(
            game.getState().root,
            makeSnapshot([repFile]),
            "white",
        );
        expect(result).toEqual({
            kind: "followed",
            lastMove: {
                mainlineIndex: 3,
                path: [0, 0, 0],
                beforePath: [0, 0],
                beforeFen: game.getState().root.children[0].children[0].fen,
                halfMoves: 3,
                san: "f4",
            },
        });
    });

    test("ends cleanly as followed when the opponent leaves the repertoire files", () => {
        // User is Black; repertoire only covers 1. e4 c5 2. Nf3 d6.
        const repFile = makeRepertoireFile("Sicilian", [
            buildRepertoireChapter([["e4", "c5", "Nf3", "d6"]], "black"),
        ]);

        const game = createTreeStore();
        // Opponent (White) plays 2. d4, which is outside the Black repertoire.
        game.getState().makeMoves({ payload: ["e4", "c5", "d4", "cxd4"], mainline: true });

        const result = compareGameToRepertoire(
            game.getState().root,
            makeSnapshot([repFile]),
            "black",
        );
        expect(result).toEqual({
            kind: "followed",
            lastMove: {
                mainlineIndex: 2,
                path: [0, 0],
                beforePath: [0],
                beforeFen: game.getState().root.children[0].fen,
                halfMoves: 2,
                san: "c5",
            },
        });
    });

    test("returns none when no user move matched and none deviated", () => {
        const repFile = makeRepertoireFile("e4 Repertoire", [
            buildRepertoireChapter([["e4", "e5"]], "black"),
        ]);
        const game = createTreeStore();
        // White opens 1. d4, which is not in Black's repertoire; walk ends at Black's first move.
        game.getState().makeMoves({ payload: ["d4", "d5"], mainline: true });

        expect(
            compareGameToRepertoire(game.getState().root, makeSnapshot([repFile]), "black"),
        ).toEqual({
            kind: "none",
        });
    });

    test("anchors side-to-move to halfMoves on a Black-to-move start FEN", () => {
        const blackToMoveFen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
        const repFile = makeRepertoireFile("vs e4", [
            buildRepertoireChapter([["c5", "Nf3", "d6"]], "black", blackToMoveFen),
        ]);
        const game = createTreeStore(undefined, defaultTree(blackToMoveFen));
        game.getState().makeMoves({ payload: ["c5", "Nf3", "e6"], mainline: true });

        const result = compareGameToRepertoire(
            game.getState().root,
            makeSnapshot([repFile]),
            "black",
        );
        expect(result).toEqual({
            kind: "deviation",
            move: {
                mainlineIndex: 3,
                path: [0, 0, 0],
                beforePath: [0, 0],
                beforeFen: game.getState().root.children[0].children[0].fen,
                halfMoves: 4,
                san: "e6",
            },
            repertoireMoves: ["d6"],
            fileName: "vs e4",
        });
    });

    test.each<RepertoirePartialReason>(["listing-failed", "read-failed", "bound-reached"])(
        "partial index (%s) always returns incomplete-index outcome, never a sentence",
        (reason) => {
            const repFile = makeRepertoireFile("White", [
                buildRepertoireChapter([["e4", "e5", "Nf3"]], "white"),
            ]);
            const game = createTreeStore();
            game.getState().makeMoves({ payload: ["e4", "e5", "Qh5"], mainline: true });

            expect(
                compareGameToRepertoire(
                    game.getState().root,
                    makeSnapshot([repFile], true, reason),
                    "white",
                ),
            ).toEqual({ kind: "partial", reason });
        },
    );

    test("returns partial read-failed when only a repertoire file is marked partial", () => {
        const repFile = makeRepertoireFile(
            "White",
            [buildRepertoireChapter([["e4", "e5", "Nf3"]], "white")],
            true,
        );
        const game = createTreeStore();
        game.getState().makeMoves({ payload: ["e4", "e5", "Qh5"], mainline: true });

        expect(
            compareGameToRepertoire(
                game.getState().root,
                makeSnapshot([repFile], false, null),
                "white",
            ),
        ).toEqual({ kind: "partial", reason: "read-failed" });
    });

    test("returns partial listing-failed when only snapshot.partialReason is set", () => {
        const repFile = makeRepertoireFile(
            "White",
            [buildRepertoireChapter([["e4", "e5", "Nf3"]], "white")],
            false,
        );
        const game = createTreeStore();
        game.getState().makeMoves({ payload: ["e4", "e5", "Qh5"], mainline: true });

        expect(
            compareGameToRepertoire(
                game.getState().root,
                makeSnapshot([repFile], false, "listing-failed"),
                "white",
            ),
        ).toEqual({ kind: "partial", reason: "listing-failed" });
    });

    test("returns partial read-failed when only snapshot.partial is true", () => {
        const repFile = makeRepertoireFile(
            "White",
            [buildRepertoireChapter([["e4", "e5", "Nf3"]], "white")],
            false,
        );
        const game = createTreeStore();
        game.getState().makeMoves({ payload: ["e4", "e5", "Qh5"], mainline: true });

        expect(
            compareGameToRepertoire(
                game.getState().root,
                makeSnapshot([repFile], true, null),
                "white",
            ),
        ).toEqual({ kind: "partial", reason: "read-failed" });
    });

    test("maps missing chapter orientation to White (chapterOrientation)", () => {
        const repFile = makeRepertoireFile("Default Orientation", [
            buildRepertoireChapter([["e4", "e5", "Nf3"]], undefined),
        ]);
        const game = createTreeStore();
        game.getState().makeMoves({ payload: ["e4", "e5", "Nf3"], mainline: true });

        expect(
            compareGameToRepertoire(game.getState().root, makeSnapshot([repFile]), "white"),
        ).toMatchObject({ kind: "followed" });
        expect(
            compareGameToRepertoire(game.getState().root, makeSnapshot([repFile]), "black"),
        ).toEqual({ kind: "none" });
    });
});

describe("findMainlineNovelty", () => {
    test("finds the mainline move with NAG 146 and optional betterSan", () => {
        const game = createTreeStore();
        game.getState().makeMoves({ payload: ["e4", "e5", "Nf3"], mainline: true });
        game.getState().goToMove([0, 0]);
        game.getState().makeMoves({ payload: ["Bc4"] });
        game.setState((state) => {
            const e4 = state.root.children[0];
            const e5 = e4.children[0];
            const [nf3, bc4] = e5.children;
            return {
                root: {
                    ...state.root,
                    children: [
                        {
                            ...e4,
                            children: [
                                {
                                    ...e5,
                                    children: [
                                        { ...nf3, nags: [146] },
                                        { ...bc4, reportLine: true },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            };
        });

        expect(findMainlineNovelty(game.getState().root)).toEqual({
            mainlineIndex: 3,
            halfMoves: 3,
            san: "Nf3",
            beforePath: [0, 0],
            beforeFen: game.getState().root.children[0].children[0].fen,
            betterSan: "Bc4",
        });

        // Review fact takes precedence when summary is current; otherwise falls back to tree sibling.
        const facts = [{ mainlineIndex: 3, kind: null, betterLine: ["Nc3"] }];
        expect(findMainlineNovelty(game.getState().root, facts, true)?.betterSan).toBe("Nc3");
        expect(findMainlineNovelty(game.getState().root, facts, false)?.betterSan).toBe("Bc4");
    });

    test("returns betterSan as null when no better line exists", () => {
        const game = createTreeStore();
        game.getState().makeMoves({ payload: ["e4", "e5", "Nf3"], mainline: true });
        game.setState((state) => {
            const e4 = state.root.children[0];
            const e5 = e4.children[0];
            const nf3 = e5.children[0];
            return {
                root: {
                    ...state.root,
                    children: [
                        {
                            ...e4,
                            children: [
                                {
                                    ...e5,
                                    children: [{ ...nf3, nags: [146] }],
                                },
                            ],
                        },
                    ],
                },
            };
        });

        expect(findMainlineNovelty(game.getState().root)?.betterSan).toBeNull();
    });

    test("returns null when no mainline move carries NAG 146", () => {
        const game = createTreeStore();
        game.getState().makeMoves({ payload: ["e4", "e5"], mainline: true });
        expect(findMainlineNovelty(game.getState().root)).toBeNull();
    });
});
