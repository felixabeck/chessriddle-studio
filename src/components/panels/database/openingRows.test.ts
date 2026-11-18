import { expect, test } from "vitest";
import type { Opening } from "@/utils/db";
import { combineOpenings, openingGames, openingTotals } from "./openingRows";

const opening = (move: string, white: number, draw = 0, black = 0): Opening => ({
    move,
    white,
    draw,
    black,
});
const mega = [opening("e4", 50, 10, 40), opening("d4", 30, 5, 5), opening("c4", 5)];
const corr = [opening("d4", 2, 9, 1), opening("h4", 1, 6, 0), opening("e4", 1, 3, 0)];
const moves = (rows: { move: string }[]) => rows.map((row) => row.move);

test("a move's games are its three results, and an absent move has none", () => {
    expect(openingGames(opening("e4", 50, 10, 40))).toBe(100);
    expect(openingGames(undefined)).toBe(0);
});

test("totals add each result separately", () => {
    expect(openingTotals(mega)).toEqual({ move: "", white: 85, draw: 15, black: 45 });
    expect(openingTotals([])).toEqual({ move: "", white: 0, draw: 0, black: 0 });
});

test("rows are the union of both sources, each side kept or absent", () => {
    const rows = combineOpenings(mega, corr, { source: "primary", direction: "desc" });
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
    expect(moves(combineOpenings(mega, corr, { source: "comparison", direction: "desc" }))).toEqual(
        ["d4", "h4", "e4", "c4"],
    );
    expect(moves(combineOpenings(mega, corr, { source: "comparison", direction: "asc" }))).toEqual([
        "c4",
        "e4",
        "h4",
        "d4",
    ]);
    expect(moves(combineOpenings(mega, corr, { source: "primary", direction: "asc" }))).toEqual([
        "h4",
        "c4",
        "d4",
        "e4",
    ]);
});

test("a tie falls to the other source's count, most games first, in both directions", () => {
    const primary = [opening("a3", 5), opening("b3", 5), opening("c3", 5)];
    const comparison = [opening("b3", 9), opening("c3", 2)];
    expect(
        moves(combineOpenings(primary, comparison, { source: "primary", direction: "desc" })),
    ).toEqual(["b3", "c3", "a3"]);
    expect(
        moves(combineOpenings(primary, comparison, { source: "primary", direction: "asc" })),
    ).toEqual(["b3", "c3", "a3"]);
});

test("a full tie keeps the primary source's order", () => {
    const primary = [opening("b3", 5), opening("a3", 5)];
    expect(
        moves(combineOpenings(primary, [], { source: "comparison", direction: "desc" })),
    ).toEqual(["b3", "a3"]);
});

test("one empty source leaves the other's moves", () => {
    expect(moves(combineOpenings([], corr, { source: "primary", direction: "desc" }))).toEqual([
        "d4",
        "h4",
        "e4",
    ]);
    expect(combineOpenings([], [], { source: "primary", direction: "desc" })).toEqual([]);
});
