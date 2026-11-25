import type { ExplorerColumnId } from "@/state/atoms";
import type { Opening } from "@/utils/db";

export type OpeningsSort = { source: ExplorerColumnId; direction: "asc" | "desc" };

/** One move of the multi-source table; a source is absent when it has no game with it. */
export type OpeningRow = {
    move: string;
} & Partial<Record<ExplorerColumnId, Opening>>;

export type OpeningSourceData = {
    column: ExplorerColumnId;
    openings: readonly Opening[];
};

export function openingGames(opening: Opening | undefined): number {
    return opening ? opening.white + opening.draw + opening.black : 0;
}

/**
 * White's score in percent, as in ChessBase: wins plus half the draws over the games with a
 * known result. `null` when there is no such game.
 */
export function openingScore(opening: Opening | undefined): number | null {
    const games = openingGames(opening);
    if (!opening || games === 0) return null;
    return ((opening.white + opening.draw / 2) / games) * 100;
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
 * Derives the active sort for the shown sources: a stored sort naming a source that is not shown
 * falls back to the first shown source while keeping the direction and leaving the stored choice
 * alone.
 */
export function effectiveOpeningsSort(
    sort: OpeningsSort,
    shown: readonly ExplorerColumnId[],
): OpeningsSort {
    return shown.includes(sort.source) ? sort : { ...sort, source: shown[0] ?? "primary" };
}

/**
 * The union of the given sources' moves, ordered by the chosen source's game count. Ties fall to
 * the remaining sources in their displayed order, most games first, and then keep the sources'
 * own order.
 */
export function combineOpenings(
    sources: readonly OpeningSourceData[],
    sort: OpeningsSort,
): OpeningRow[] {
    const rows = new Map<string, OpeningRow>();
    for (const { column, openings } of sources) {
        for (const opening of openings) {
            const row = rows.get(opening.move);
            if (row) row[column] = opening;
            else rows.set(opening.move, { move: opening.move, [column]: opening });
        }
    }
    const shown = sources.map((source) => source.column);
    const tieBreakers = shown.filter((column) => column !== sort.source);
    const sign = sort.direction === "asc" ? 1 : -1;
    return [...rows.values()].sort((left, right) => {
        const primaryDiff =
            sign * (openingGames(left[sort.source]) - openingGames(right[sort.source]));
        if (primaryDiff !== 0) return primaryDiff;
        for (const column of tieBreakers) {
            const diff = openingGames(right[column]) - openingGames(left[column]);
            if (diff !== 0) return diff;
        }
        return 0;
    });
}
