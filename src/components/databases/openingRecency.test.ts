import { expect, test } from "vitest";
import type { PositionStats, RecentGame } from "@/bindings";
import { sectionYearTotals, summarizeRecentGames, yearBuckets } from "./openingRecency";

function statsRow(
    move: string,
    recent: RecentGame[] = [],
    year_counts: PositionStats["year_counts"] = [],
): PositionStats {
    return {
        move,
        white: 0,
        draw: 0,
        black: 0,
        unknown: 0,
        last_played: recent[0]?.date ?? null,
        year_counts,
        recent,
    };
}

test("excludes terminal '*' entries from the recent window across rows", () => {
    const summary = summarizeRecentGames([
        statsRow("e4", [
            { date: "2026.10.01", game_id: 1 },
            { date: "2026.09.01", game_id: 2 },
        ]),
        statsRow("d4", [{ date: "2026.08.01", game_id: 3 }]),
        statsRow("*", [
            { date: "2026.11.10", game_id: 10 },
            { date: "2026.11.09", game_id: 9 },
            { date: "2026.11.08", game_id: 8 },
        ]),
    ]);

    expect(summary.windowSize).toBe(3);
    expect(summary.counts.get("*")).toBeUndefined();
    expect(summary.counts.get("e4")).toBe(2);
    expect(summary.counts.get("d4")).toBe(1);
    expect(summary.oldestDate).toBe("2026.08.01");
    expect(summary.leaders).toEqual(["e4"]);
    expect(summary.leaderCount).toBe(2);
    expect(summary.uniqueLeader).toBe("e4");
});

test("takes the 10 newest entries across rows ordered by date then game_id", () => {
    const summary = summarizeRecentGames([
        statsRow("e4", [
            { date: "2026.11.10", game_id: 1 },
            { date: "2026.11.05", game_id: 2 },
            { date: "2026.11.03", game_id: 1 },
        ]),
        statsRow("c5", [
            { date: "2026.11.09", game_id: 5 },
            { date: "2026.11.08", game_id: 4 },
            { date: "2026.11.07", game_id: 3 },
            { date: "2026.11.06", game_id: 2 },
            { date: "2026.11.05", game_id: 6 },
            { date: "2026.11.04", game_id: 9 },
            { date: "2026.11.04", game_id: 7 },
            { date: "2026.11.03", game_id: 5 },
        ]),
        statsRow("d4", [{ date: "2026.11.01", game_id: 99 }]),
    ]);

    // Same-date tie on 2026.11.03: c5 (game_id 5) stays inside the top 10, e4 (game_id 1) drops out.
    expect(summary.windowSize).toBe(10);
    expect(summary.counts.get("c5")).toBe(8);
    expect(summary.counts.get("e4")).toBe(2);
    expect(summary.counts.get("d4")).toBeUndefined();
    expect(summary.oldestDate).toBe("2026.11.03");
    expect(summary.leaders).toEqual(["c5"]);
    expect(summary.uniqueLeader).toBe("c5");
});

test("gates uniqueLeader on n >= 3 and uniqueness", () => {
    const tooFew = summarizeRecentGames([
        statsRow("e4", [
            { date: "2026.11.02", game_id: 2 },
            { date: "2026.11.01", game_id: 1 },
        ]),
    ]);
    expect(tooFew.windowSize).toBe(2);
    expect(tooFew.leaders).toEqual(["e4"]);
    expect(tooFew.uniqueLeader).toBeNull();

    const tied = summarizeRecentGames([
        statsRow("e4", [
            { date: "2026.11.04", game_id: 4 },
            { date: "2026.11.02", game_id: 2 },
        ]),
        statsRow("d4", [
            { date: "2026.11.03", game_id: 3 },
            { date: "2026.11.01", game_id: 1 },
        ]),
    ]);
    expect(tied.windowSize).toBe(4);
    expect(tied.leaders).toEqual(["e4", "d4"]);
    expect(tied.leaderCount).toBe(2);
    expect(tied.uniqueLeader).toBeNull();

    const empty = summarizeRecentGames([statsRow("e4")]);
    expect(empty.windowSize).toBe(0);
    expect(empty.oldestDate).toBeNull();
    expect(empty.leaders).toEqual([]);
    expect(empty.leaderCount).toBe(0);
    expect(empty.uniqueLeader).toBeNull();
});

test("buckets years relative to currentYear and sums section totals including '*'", () => {
    const rowA = statsRow(
        "e4",
        [],
        [
            { year: -5, count: 3 },
            { year: 0, count: 2 },
            { year: 2010, count: 1 },
            { year: 2019, count: 2 },
            { year: 2026, count: 3 },
            { year: 2027, count: 4 },
        ],
    );
    const terminal = statsRow("*", [], [{ year: 2026, count: 5 }]);

    expect(yearBuckets(rowA.year_counts, 2026)).toEqual({
        firstYear: 2019,
        counts: [1, 2, 0, 0, 0, 0, 0, 0, 3],
    });
    expect(sectionYearTotals([rowA, terminal], 2026)).toEqual([1, 2, 0, 0, 0, 0, 0, 0, 8]);
    expect(sectionYearTotals([rowA, terminal], 2027)).toEqual([3, 0, 0, 0, 0, 0, 0, 8, 4]);
});
