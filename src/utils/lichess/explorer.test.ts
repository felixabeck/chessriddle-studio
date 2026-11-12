// @vitest-environment node

import { beforeAll, describe, expect, test } from "vitest";
import { getExplorerQueriesInTimezone } from "../tests/explorerQueries.mjs";
import { INITIAL_FEN } from "chessops/fen";
import { getLichessGamesQueryParams, getMasterGamesQueryParams } from "./explorer";

describe("getLichessGamesQueryParams", () => {
    test.each(["white", "black"] as const)(
        "includes player and %s color with joined speeds and ratings",
        (color) => {
            const params = new URLSearchParams(
                getLichessGamesQueryParams(INITIAL_FEN, {
                    player: "Player Name",
                    color,
                    variant: "chess960",
                    speeds: ["blitz", "rapid"],
                    ratings: [1600, 2000],
                    moves: 0,
                }),
            );
            expect(Object.fromEntries(params)).toEqual({
                fen: INITIAL_FEN,
                player: "Player Name",
                color,
                variant: "chess960",
                speeds: "blitz,rapid",
                ratings: "1600,2000",
                moves: "0",
            });
        },
    );

    test("includes only FEN when optional filters are empty", () => {
        const params = new URLSearchParams(
            getLichessGamesQueryParams(INITIAL_FEN, {
                color: "white",
                player: "",
                speeds: [],
                ratings: [],
            }),
        );
        expect(Object.fromEntries(params)).toEqual({ fen: INITIAL_FEN });
    });

    test("returns an empty query for undefined options", () => {
        expect(getLichessGamesQueryParams(INITIAL_FEN, undefined)).toBe("");
    });

    test.each([
        [-1, null],
        [0, "0"],
        [4, "4"],
        [5, null],
    ] as const)(
        "restricts topGames and recentGames %s to the inclusive 0–4 range",
        (count, expected) => {
            const params = new URLSearchParams(
                getLichessGamesQueryParams(INITIAL_FEN, {
                    color: "white",
                    topGames: count,
                    recentGames: count,
                }),
            );
            expect(params.get("fen")).toBe(INITIAL_FEN);
            expect(params.get("topGames")).toBe(expected);
            expect(params.get("recentGames")).toBe(expected);
        },
    );
});

describe("getMasterGamesQueryParams", () => {
    test("includes only FEN for empty options", () => {
        const params = new URLSearchParams(getMasterGamesQueryParams(INITIAL_FEN, {}));
        expect(Object.fromEntries(params)).toEqual({ fen: INITIAL_FEN });
    });

    test("returns an empty query for undefined options", () => {
        expect(getMasterGamesQueryParams(INITIAL_FEN, undefined)).toBe("");
    });

    test.each([
        [-1, null],
        [0, "0"],
        [15, "15"],
        [16, null],
    ] as const)("restricts topGames %s to the inclusive 0–15 range", (count, expected) => {
        const params = new URLSearchParams(
            getMasterGamesQueryParams(INITIAL_FEN, {
                topGames: count,
                moves: 0,
            }),
        );
        expect(params.get("fen")).toBe(INITIAL_FEN);
        expect(params.get("moves")).toBe("0");
        expect(params.get("topGames")).toBe(expected);
    });
});

describe.each(["America/Los_Angeles", "Europe/Berlin"])("explorer queries in %s", (timezone) => {
    let queries: { timezone: string; lichess: string; masters: string };

    beforeAll(() => {
        queries = getExplorerQueriesInTimezone(timezone);
    });

    test("Lichess preserves January Since and February Until from picker calendar values", () => {
        expect(queries.timezone).toBe(timezone);
        const params = new URLSearchParams(queries.lichess);

        expect(params.get("since")).toBe("2024-01");
        expect(params.get("until")).toBe("2024-02");
    });

    test("Masters preserves the picker calendar year for both Since and Until", () => {
        expect(queries.timezone).toBe(timezone);
        const params = new URLSearchParams(queries.masters);

        expect(params.get("since")).toBe("2024");
        expect(params.get("until")).toBe("2024");
    });
});
