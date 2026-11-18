import type { Opening } from "@/utils/db";

export type OpeningsSort = { source: "primary" | "comparison"; direction: "asc" | "desc" };

/** One move of the two-source table; a side is absent when its source has no game with it. */
export type OpeningRow = { move: string; primary?: Opening; comparison?: Opening };

export function openingGames(opening: Opening | undefined): number {
    return opening ? opening.white + opening.draw + opening.black : 0;
}

export function openingTotals(openings: readonly Opening[]): Opening {
    return {
        move: "",
        white: openings.reduce((sum, opening) => sum + opening.white, 0),
        draw: openings.reduce((sum, opening) => sum + opening.draw, 0),
        black: openings.reduce((sum, opening) => sum + opening.black, 0),
    };
}

/**
 * The union of two sources' moves, ordered by the chosen source's game count. Ties fall to the
 * other source's count, most games first, and then keep the sources' own order.
 */
export function combineOpenings(
    primary: readonly Opening[],
    comparison: readonly Opening[],
    sort: OpeningsSort,
): OpeningRow[] {
    const rows = new Map<string, OpeningRow>();
    for (const opening of primary) rows.set(opening.move, { move: opening.move, primary: opening });
    for (const opening of comparison) {
        const row = rows.get(opening.move);
        if (row) row.comparison = opening;
        else rows.set(opening.move, { move: opening.move, comparison: opening });
    }
    const other = sort.source === "primary" ? "comparison" : "primary";
    const sign = sort.direction === "asc" ? 1 : -1;
    return [...rows.values()].sort(
        (left, right) =>
            sign * (openingGames(left[sort.source]) - openingGames(right[sort.source])) ||
            openingGames(right[other]) - openingGames(left[other]),
    );
}
