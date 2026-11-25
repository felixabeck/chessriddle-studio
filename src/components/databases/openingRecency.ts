import type { PositionStats, RecentGame } from "@/bindings";
import { compareRecentGames, RECENT_GAMES_LIMIT } from "@/utils/repertoire";

const VISIBLE_YEAR_COUNT = 8;
const RECENT_HIGHLIGHT_MIN_GAMES = 3;

export type RecentGamesSummary = {
    windowSize: number;
    counts: Map<string, number>;
    oldestDate: string | null;
    leaders: string[];
    leaderCount: number;
    uniqueLeader: string | null;
};

/**
 * Derives the section's recent-game window (newest `RECENT_GAMES_LIMIT` entries across all
 * continuation moves, excluding `"*"` games that ended in this position).
 */
export function summarizeRecentGames(openings: readonly PositionStats[]): RecentGamesSummary {
    const entries: { move: string; game: RecentGame }[] = [];
    for (const row of openings) {
        if (row.move === "*") continue;
        for (const game of row.recent) {
            entries.push({ move: row.move, game });
        }
    }
    entries.sort((a, b) => compareRecentGames(a.game, b.game));
    const window = entries.slice(0, RECENT_GAMES_LIMIT);
    const windowSize = window.length;

    const counts = new Map<string, number>();
    for (const { move } of window) {
        counts.set(move, (counts.get(move) ?? 0) + 1);
    }

    let leaderCount = 0;
    for (const count of counts.values()) {
        if (count > leaderCount) leaderCount = count;
    }

    const leaders: string[] = [];
    if (leaderCount > 0) {
        for (const row of openings) {
            if (row.move === "*") continue;
            if ((counts.get(row.move) ?? 0) === leaderCount && !leaders.includes(row.move)) {
                leaders.push(row.move);
            }
        }
    }

    return {
        windowSize,
        counts,
        oldestDate: windowSize > 0 ? window[windowSize - 1].game.date : null,
        leaders,
        leaderCount,
        uniqueLeader:
            leaders.length === 1 && windowSize >= RECENT_HIGHLIGHT_MIN_GAMES ? leaders[0] : null,
    };
}

/** Maps a row's `year_counts` into 9 buckets: before `firstYear`, then 8 local calendar years up to `currentYear`. */
export function yearBuckets(
    yearCounts: PositionStats["year_counts"],
    currentYear: number,
): { firstYear: number; counts: number[] } {
    const firstYear = currentYear - VISIBLE_YEAR_COUNT + 1;
    const counts = Array<number>(VISIBLE_YEAR_COUNT + 1).fill(0);
    for (const { year, count } of yearCounts) {
        if (year > 0 && year <= currentYear) {
            counts[year < firstYear ? 0 : year - firstYear + 1] += count;
        }
    }
    return { firstYear, counts };
}

/** Sums every row's year buckets across the section, including `"*"` games that ended here. */
export function sectionYearTotals(
    openings: readonly PositionStats[],
    currentYear: number,
): number[] {
    const totals = Array<number>(VISIBLE_YEAR_COUNT + 1).fill(0);
    for (const row of openings) {
        const { counts } = yearBuckets(row.year_counts, currentYear);
        for (let index = 0; index < totals.length; index += 1) {
            totals[index] += counts[index];
        }
    }
    return totals;
}
