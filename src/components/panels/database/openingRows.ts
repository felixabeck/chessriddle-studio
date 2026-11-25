import type { ExplorerColumnId } from "@/state/atoms";
import type { Opening } from "@/utils/db";

export type OpeningsSort = { source: ExplorerColumnId; direction: "asc" | "desc" };

/** One move of the multi-source table; a source is absent when it has no game with it. */
export type OpeningRow = {
    move: string;
} & Partial<Record<ExplorerColumnId, Opening>>;

export type OpeningSourceData = {
    role: ExplorerColumnId;
    openings: readonly Opening[];
};

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
 * Derives the active sort for the shown sources: a stored sort naming a source that is not shown
 * falls back to the first shown source while keeping the direction and leaving the stored choice
 * alone.
 */
export function effectiveOpeningsSort(
    sort: OpeningsSort,
    roles: readonly ExplorerColumnId[],
): OpeningsSort {
    return roles.includes(sort.source) ? sort : { ...sort, source: roles[0] ?? "primary" };
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
    for (const { role, openings } of sources) {
        for (const opening of openings) {
            const row = rows.get(opening.move);
            if (row) row[role] = opening;
            else rows.set(opening.move, { move: opening.move, [role]: opening });
        }
    }
    const roles = sources.map((source) => source.role);
    const tieBreakers = roles.filter((role) => role !== sort.source);
    const sign = sort.direction === "asc" ? 1 : -1;
    return [...rows.values()].sort((left, right) => {
        const primaryDiff =
            sign * (openingGames(left[sort.source]) - openingGames(right[sort.source]));
        if (primaryDiff !== 0) return primaryDiff;
        for (const role of tieBreakers) {
            const diff = openingGames(right[role]) - openingGames(left[role]);
            if (diff !== 0) return diff;
        }
        return 0;
    });
}
