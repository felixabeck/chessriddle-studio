import { expect, test } from "vitest";
import type { Opening } from "@/utils/db";
import {
    combineOpenings,
    effectiveOpeningsSort,
    openingGames,
    openingScore,
    openingTotals,
} from "./openingRows";

const opening = (move: string, white: number, draw = 0, black = 0): Opening => ({
    move,
    white,
    draw,
    black,
});
const mega = [opening("e4", 50, 10, 40), opening("d4", 30, 5, 5), opening("c4", 5)];
const corr = [opening("d4", 2, 9, 1), opening("h4", 1, 6, 0), opening("e4", 1, 3, 0)];
const ref = [opening("Nf3", 200, 50, 50), opening("e4", 400, 100, 100)];
const pair = (primary: readonly Opening[], comparison: readonly Opening[]) => [
    { column: "primary" as const, openings: primary },
    { column: "comparison" as const, openings: comparison },
];
const moves = (rows: { move: string }[]) => rows.map((row) => row.move);

test("a move's games are its three results, and an absent move has none", () => {
    expect(openingGames(opening("e4", 50, 10, 40))).toBe(100);
    expect(openingGames(undefined)).toBe(0);
});

test("White's score counts a win as one point and a draw as half", () => {
    expect(openingScore({ move: "e4", white: 38, draw: 27, black: 35 })).toBeCloseTo(51.5);
    expect(openingScore({ move: "a3", white: 0, draw: 0, black: 4 })).toBe(0);
    expect(openingScore({ move: "b3", white: 0, draw: 2, black: 0 })).toBe(50);
});

test("a move without a counted game has no score", () => {
    expect(openingScore(undefined)).toBeNull();
    expect(openingScore({ move: "a3", white: 0, draw: 0, black: 0, unknown: 4 })).toBeNull();
});

test("totals add each result separately", () => {
    expect(openingTotals(mega)).toEqual({ move: "", white: 85, draw: 15, black: 45 });
    expect(openingTotals([])).toEqual({ move: "", white: 0, draw: 0, black: 0 });
});

test("rows are the union of both sources, each side kept or absent", () => {
    const rows = combineOpenings(pair(mega, corr), { source: "primary", direction: "desc" });
    expect(moves(rows)).toEqual(["e4", "d4", "c4", "h4"]);
    expect(rows.find((row) => row.move === "c4")).toEqual({ move: "c4", primary: mega[2] });
    expect(rows.find((row) => row.move === "h4")).toEqual({ move: "h4", comparison: corr[1] });
    expect(rows.find((row) => row.move === "d4")).toEqual({
        move: "d4",
        primary: mega[1],
        comparison: corr[0],
    });
});

test("the chosen source and direction order the rows", () => {
    expect(
        moves(combineOpenings(pair(mega, corr), { source: "comparison", direction: "desc" })),
    ).toEqual(["d4", "h4", "e4", "c4"]);
    expect(
        moves(combineOpenings(pair(mega, corr), { source: "comparison", direction: "asc" })),
    ).toEqual(["c4", "e4", "h4", "d4"]);
    expect(
        moves(combineOpenings(pair(mega, corr), { source: "primary", direction: "asc" })),
    ).toEqual(["h4", "c4", "d4", "e4"]);
});

test("a tie falls to the other source's count, most games first, in both directions", () => {
    const primary = [opening("a3", 5), opening("b3", 5), opening("c3", 5)];
    const comparison = [opening("b3", 9), opening("c3", 2)];
    expect(
        moves(combineOpenings(pair(primary, comparison), { source: "primary", direction: "desc" })),
    ).toEqual(["b3", "c3", "a3"]);
    expect(
        moves(combineOpenings(pair(primary, comparison), { source: "primary", direction: "asc" })),
    ).toEqual(["b3", "c3", "a3"]);
});

test("a full tie keeps the primary source's order", () => {
    const primary = [opening("b3", 5), opening("a3", 5)];
    expect(
        moves(combineOpenings(pair(primary, []), { source: "comparison", direction: "desc" })),
    ).toEqual(["b3", "a3"]);
});

test("one empty source leaves the other's moves", () => {
    expect(
        moves(combineOpenings(pair([], corr), { source: "primary", direction: "desc" })),
    ).toEqual(["d4", "h4", "e4"]);
    expect(combineOpenings(pair([], []), { source: "primary", direction: "desc" })).toEqual([]);
});

test("three sources union all moves, sort by reference, and break ties in displayed order", () => {
    const rows = combineOpenings(
        [
            { column: "primary", openings: mega },
            { column: "comparison", openings: corr },
            { column: "reference", openings: ref },
        ],
        { source: "reference", direction: "desc" },
    );
    expect(moves(rows)).toEqual(["e4", "Nf3", "d4", "c4", "h4"]);
    expect(rows.find((row) => row.move === "Nf3")).toEqual({ move: "Nf3", reference: ref[0] });
});

test("a sort naming an absent source falls back to primary while keeping the direction", () => {
    expect(
        effectiveOpeningsSort({ source: "reference", direction: "asc" }, ["primary", "comparison"]),
    ).toEqual({ source: "primary", direction: "asc" });
    expect(
        effectiveOpeningsSort({ source: "reference", direction: "desc" }, ["primary", "reference"]),
    ).toEqual({ source: "reference", direction: "desc" });
    const fallback = effectiveOpeningsSort({ source: "reference", direction: "desc" }, [
        "primary",
        "comparison",
    ]);
    expect(moves(combineOpenings(pair(mega, corr), fallback))).toEqual(["e4", "d4", "c4", "h4"]);
});

test("two further columns keep their own rows and a sort on the second stays when the first is removed", () => {
    const rows = combineOpenings(
        [
            { column: "primary", openings: mega },
            { column: "lch_all", openings: corr },
            { column: "lch_master", openings: ref },
        ],
        { source: "lch_master", direction: "desc" },
    );
    expect(moves(rows)).toEqual(["e4", "Nf3", "d4", "c4", "h4"]);
    expect(rows.find((row) => row.move === "Nf3")).toEqual({ move: "Nf3", lch_master: ref[0] });
    expect(rows.find((row) => row.move === "h4")).toEqual({ move: "h4", lch_all: corr[1] });
    const remaining = [
        { column: "primary" as const, openings: mega },
        { column: "lch_master" as const, openings: ref },
    ];
    expect(
        effectiveOpeningsSort({ source: "lch_master", direction: "desc" }, [
            "primary",
            "lch_master",
        ]),
    ).toEqual({
        source: "lch_master",
        direction: "desc",
    });
    expect(
        moves(
            combineOpenings(remaining, {
                source: "lch_master",
                direction: "desc",
            }),
        ),
    ).toEqual(["e4", "Nf3", "d4", "c4"]);
});
