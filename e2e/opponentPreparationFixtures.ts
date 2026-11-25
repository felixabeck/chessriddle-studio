import type { Token } from "../src/bindings/generated";
import {
    databaseLayoutCommands,
    filesWorkspaceCommands,
    filesWorkspaceFixture,
    type MockScenario,
} from "./fixtures";

export const repertoireFile = {
    ...filesWorkspaceFixture.pgnFile,
    handle: { id: { id: "prep-repertoire-file" }, kind: "fileWorkspace" as const },
    name: "Black vs e4",
    metadata: { type: "repertoire" as const, tags: [] },
    gameCount: 1,
    readError: null,
};

export const chapter0Pgn =
    '[Event "?"]\n[Site "?"]\n[Date "????.??.??"]\n[Round "?"]\n[White "Sicilian Najdorf"]\n[Black "Mainline"]\n[Orientation "black"]\n[Result "*"]\n\n1. e4 (1. c4 e5) (1. b3) c5 2. Nf3 (2. Be2 Nf6) d6 3. d4 cxd4 4. Nxd4 *';

export const chapter0Tokens: Token[] = [
    { type: "Header", value: { tag: "White", value: "Sicilian Najdorf" } },
    { type: "Header", value: { tag: "Black", value: "Mainline" } },
    { type: "Header", value: { tag: "Orientation", value: "black" } },
    { type: "Header", value: { tag: "Result", value: "*" } },
    { type: "San", value: "e4" },
    { type: "ParenOpen" },
    { type: "San", value: "c4" },
    { type: "San", value: "e5" },
    { type: "ParenClose" },
    { type: "ParenOpen" },
    { type: "San", value: "b3" },
    { type: "ParenClose" },
    { type: "San", value: "c5" },
    { type: "San", value: "Nf3" },
    { type: "ParenOpen" },
    { type: "San", value: "Be2" },
    { type: "San", value: "Nf6" },
    { type: "ParenClose" },
    { type: "San", value: "d6" },
    { type: "San", value: "d4" },
    { type: "San", value: "cxd4" },
    { type: "San", value: "Nxd4" },
    { type: "Outcome", value: "*" },
];

export const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";
export const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -";
export const AFTER_E4_C5 = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -";
export const AFTER_NF3 = "rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -";
export const AFTER_D6 = "rnbqkbnr/pp2pppp/3p4/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -";

export function stat(
    move: string,
    white: number,
    draw: number,
    black: number,
    last_played: string,
) {
    return {
        move,
        white,
        draw,
        black,
        unknown: 0,
        last_played,
        year_counts: [],
        recent: [],
    };
}

export function preparationCommands(
    revision = "e2e-opponent-prep-rev-1",
): NonNullable<MockScenario["commands"]> {
    const chapters = [{ pgn: chapter0Pgn, stamp: "a".repeat(64), revision, present: true }];
    return {
        ...databaseLayoutCommands,
        ...filesWorkspaceCommands([[repertoireFile]], {
            list_file_workspace: { result: { entries: [repertoireFile], unread: [] } },
            count_pgn_games: { result: 1 },
            read_games: { pgnGames: chapters },
            read_game: { pgnGames: chapters },
            file_revision: { result: revision },
            lex_pgn: {
                pgnTokens: {
                    [chapter0Pgn]: chapter0Tokens,
                },
            },
        }),
        get_progress: { result: null },
        search_positions_stats: {
            result: [
                {
                    fen: START,
                    openings: [
                        stat("e4", 12, 4, 3, "2026.09.10"),
                        stat("d4", 4, 2, 1, "2026.06.05"),
                    ],
                },
                {
                    fen: AFTER_E4,
                    openings: [stat("c5", 8, 2, 2, "2026.09.10")],
                },
                {
                    fen: AFTER_E4_C5,
                    openings: [
                        stat("Nf3", 5, 1, 1, "2026.09.10"),
                        stat("Nc3", 2, 1, 1, "2026.08.15"),
                    ],
                },
                {
                    fen: AFTER_NF3,
                    openings: [stat("d6", 4, 1, 1, "2026.09.10")],
                },
                {
                    fen: AFTER_D6,
                    openings: [stat("Bb5+", 4, 1, 1, "2026.09.10")],
                },
            ],
        },
    };
}
