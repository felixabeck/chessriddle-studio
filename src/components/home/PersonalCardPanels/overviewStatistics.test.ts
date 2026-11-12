import { describe, expect, test } from "vitest";
import type {
    ColorStatsData,
    DailyStatsData,
    LatestRatingData,
    OpeningStatsData,
    SiteStatsData,
} from "@/bindings";
import {
    aggregateOpenings,
    compareLatestRating,
    deriveOverviewStatistics,
    extractMonthlyResults,
    fideDp,
    fidePerformanceRating,
    filterPlayerStats,
    formatResultCounts,
    formatScorePercent,
    scoreHundredths,
    scoreFraction,
} from "./overviewStatistics";

function color(
    partial: Partial<ColorStatsData> & Pick<ColorStatsData, "is_player_white">,
): ColorStatsData {
    return {
        time_control: "600+0",
        won: 0,
        drawn: 0,
        lost: 0,
        rated_won: 0,
        rated_drawn: 0,
        rated_lost: 0,
        opponent_elo_sum: 0,
        ...partial,
    };
}

function daily(partial: Partial<DailyStatsData> & Pick<DailyStatsData, "date">): DailyStatsData {
    return {
        time_control: "600+0",
        won: 0,
        drawn: 0,
        lost: 0,
        max_player_elo: 0,
        ...partial,
    };
}

function latest(
    partial: Partial<LatestRatingData> & Pick<LatestRatingData, "date" | "player_elo" | "game_id">,
): LatestRatingData {
    return {
        time_control: "600+0",
        time: null,
        ...partial,
    };
}

function opening(
    partial: Partial<OpeningStatsData> & Pick<OpeningStatsData, "opening" | "is_player_white">,
): OpeningStatsData {
    return {
        time_control: "600+0",
        won: 0,
        drawn: 0,
        lost: 0,
        ...partial,
    };
}

function site(partial: Partial<SiteStatsData> = {}): SiteStatsData {
    return {
        site: "Lichess",
        player: "Magnus",
        daily: [],
        openings: [],
        colors: [],
        latest: [],
        ...partial,
    };
}

const mixedResultSites: SiteStatsData[] = [
    site({
        colors: [
            color({ is_player_white: true, won: 2, drawn: 1, lost: 1 }),
            color({ is_player_white: false, won: 0, drawn: 1, lost: 1 }),
        ],
        daily: [daily({ date: "2026.01.01", won: 2, drawn: 2, lost: 2, max_player_elo: 1800 })],
        openings: [
            opening({
                is_player_white: true,
                opening: "Sicilian Defense",
                won: 2,
                drawn: 1,
                lost: 0,
            }),
            opening({
                is_player_white: true,
                opening: "French Defense",
                won: 0,
                drawn: 0,
                lost: 1,
            }),
            opening({
                is_player_white: false,
                opening: "Caro-Kann Defense",
                won: 0,
                drawn: 1,
                lost: 1,
            }),
        ],
    }),
];

describe("mixed-result fixture", () => {
    test("White 2W 1D 1L 62.5%, Black 0W 1D 1L 25%, total 2W 2D 2L 50%", () => {
        const stats = deriveOverviewStatistics(mixedResultSites);
        expect(formatScorePercent(stats.white.won, stats.white.drawn, stats.white.lost)).toBe(
            "62.5%",
        );
        expect(formatResultCounts(stats.white.won, stats.white.drawn, stats.white.lost)).toBe(
            "+2 =1 −1",
        );
        expect(stats.white.games).toBe(4);
        expect(stats.white).toEqual({
            games: 4,
            won: 2,
            drawn: 1,
            lost: 1,
            ratedGames: 0,
            averageOpponent: null,
            performance: null,
        });
        expect(formatScorePercent(stats.black.won, stats.black.drawn, stats.black.lost)).toBe(
            "25%",
        );
        expect(formatResultCounts(stats.black.won, stats.black.drawn, stats.black.lost)).toBe(
            "+0 =1 −1",
        );
        expect(stats.black.games).toBe(2);
        expect(formatScorePercent(stats.total.won, stats.total.drawn, stats.total.lost)).toBe(
            "50%",
        );
        expect(formatResultCounts(stats.total.won, stats.total.drawn, stats.total.lost)).toBe(
            "+2 =2 −2",
        );
        expect(stats.total.games).toBe(6);
    });
});

describe("zero and one-colour cases", () => {
    test("zero games yields empty colour rows and no ratings", () => {
        const stats = deriveOverviewStatistics([site()]);
        expect(stats.total.games).toBe(0);
        expect(stats.white.games).toBe(0);
        expect(stats.black.games).toBe(0);
        expect(stats.peakRating).toBeNull();
        expect(stats.latestRating).toBeNull();
        expect(stats.total.averageOpponent).toBeNull();
        expect(stats.total.performance).toBeNull();
        expect(stats.months).toEqual([]);
        expect(stats.whiteOpenings).toEqual([]);
        expect(stats.blackOpenings).toEqual([]);
    });

    test("only White games leave Black at zero", () => {
        const stats = deriveOverviewStatistics([
            site({
                colors: [color({ is_player_white: true, won: 1, drawn: 0, lost: 0 })],
            }),
        ]);
        expect(stats.white.games).toBe(1);
        expect(stats.black.games).toBe(0);
        expect(stats.total.games).toBe(1);
        expect(formatScorePercent(stats.white.won, stats.white.drawn, stats.white.lost)).toBe(
            "100%",
        );
    });
});

describe("rated opponents and FIDE performance", () => {
    test("games without rated opponents produce no performance line", () => {
        const stats = deriveOverviewStatistics([
            site({
                colors: [
                    color({
                        is_player_white: true,
                        won: 2,
                        drawn: 0,
                        lost: 0,
                        rated_won: 0,
                        opponent_elo_sum: 0,
                    }),
                ],
            }),
        ]);
        expect(stats.total.ratedGames).toBe(0);
        expect(stats.total.averageOpponent).toBeNull();
        expect(stats.total.performance).toBeNull();
    });

    test("p = 1.00 uses dp +800", () => {
        expect(fideDp(100)).toBe(800);
        expect(fidePerformanceRating(1800, 3, 0, 0)).toBe(2600);
    });

    test("p = 0.00 uses dp −800", () => {
        expect(fideDp(0)).toBe(-800);
        expect(fidePerformanceRating(1800, 0, 0, 4)).toBe(1000);
    });

    test("p rounds to two decimals before the dp lookup", () => {
        // 2.5 / 4 = 0.625 → 0.63 → dp 95
        expect(scoreFraction(2, 1, 1)).toBe(0.625);
        expect(scoreHundredths(2, 1, 1)).toBe(63);
        expect(fideDp(63)).toBe(95);
        expect(fidePerformanceRating(1800, 2, 1, 1)).toBe(1895);
    });

    test("rounds exact scores half-up to hundredths", () => {
        expect(scoreHundredths(3, 17, 0)).toBe(58);
        expect(fidePerformanceRating(1800, 3, 17, 0)).toBe(1857);
        expect(fidePerformanceRating(1800, 6, 34, 0)).toBe(1857);
        expect(scoreHundredths(0, 0, 0)).toBe(0);
    });
});

describe("latest rating chronology", () => {
    test("same-day decline keeps peak 1800 and latest 1750", () => {
        const stats = deriveOverviewStatistics([
            site({
                daily: [daily({ date: "2026.03.01", won: 1, lost: 1, max_player_elo: 1800 })],
                latest: [
                    latest({
                        date: "2026.03.01",
                        time: "10:00:00",
                        game_id: 1,
                        player_elo: 1800,
                    }),
                    latest({
                        date: "2026.03.01",
                        time: "18:00:00",
                        game_id: 2,
                        player_elo: 1750,
                    }),
                ],
            }),
        ]);
        expect(stats.peakRating).toBe(1800);
        expect(stats.latestRating).toBe(1750);
    });

    test("missing time orders before a present time on the same date", () => {
        expect(
            compareLatestRating(
                latest({ date: "2026.03.01", time: null, game_id: 9, player_elo: 1800 }),
                latest({ date: "2026.03.01", time: "00:00:00", game_id: 1, player_elo: 1700 }),
            ),
        ).toBeLessThan(0);
    });

    test("game id breaks remaining ties", () => {
        expect(
            compareLatestRating(
                latest({ date: "2026.03.01", time: "12:00:00", game_id: 1, player_elo: 1800 }),
                latest({ date: "2026.03.01", time: "12:00:00", game_id: 2, player_elo: 1750 }),
            ),
        ).toBeLessThan(0);
        const stats = deriveOverviewStatistics([
            site({
                latest: [
                    latest({ date: "2026.03.01", time: "12:00:00", game_id: 1, player_elo: 1800 }),
                    latest({ date: "2026.03.01", time: "12:00:00", game_id: 2, player_elo: 1750 }),
                ],
            }),
        ]);
        expect(stats.latestRating).toBe(1750);
    });
});

describe("filtering", () => {
    test("All websites rapid classifies all four aggregates by their own site", () => {
        const info = {
            site_stats_data: ["Chess.com", "Lichess"].map((website) =>
                site({
                    site: website,
                    daily: [
                        daily({
                            date: "2026.01.01",
                            time_control: "1800+0",
                            won: 2,
                            max_player_elo: 1800,
                        }),
                    ],
                    openings: [
                        opening({
                            opening: `${website} Opening`,
                            is_player_white: true,
                            time_control: "1800+0",
                            won: 2,
                        }),
                    ],
                    colors: [color({ is_player_white: true, time_control: "1800+0", won: 2 })],
                    latest: [
                        latest({
                            date: "2026.01.01",
                            game_id: 1,
                            player_elo: 1800,
                            time_control: "1800+0",
                        }),
                    ],
                }),
            ),
        };
        const filtered = filterPlayerStats(info, {
            website: "All websites",
            account: "All accounts",
            timeControl: "rapid",
        });
        for (const key of ["daily", "openings", "colors", "latest"] as const) {
            expect(filtered[0][key]).toEqual(info.site_stats_data[0][key]);
            expect(filtered[1][key]).toEqual([]);
        }
        const stats = deriveOverviewStatistics(filtered);
        expect(stats.total.games).toBe(2);
        expect(stats.months).toEqual([{ name: "2026-01", count: 2, won: 2, drawn: 0, lost: 0 }]);
        expect(stats.whiteOpenings.map((row) => row.name)).toEqual(["Chess.com Opening"]);
        expect(stats.latestRating).toBe(1800);
    });

    test("applies website, account and time control once to daily, openings, colors and latest", () => {
        const info = {
            site_stats_data: [
                site({
                    site: "Lichess",
                    player: "Magnus",
                    daily: [
                        daily({
                            date: "2026.01.01",
                            time_control: "60+0",
                            won: 1,
                            max_player_elo: 1700,
                        }),
                        daily({
                            date: "2026.01.02",
                            time_control: "600+0",
                            won: 1,
                            max_player_elo: 1800,
                        }),
                    ],
                    colors: [
                        color({ time_control: "60+0", is_player_white: true, won: 1 }),
                        color({ time_control: "600+0", is_player_white: true, won: 1 }),
                    ],
                    openings: [
                        opening({
                            time_control: "60+0",
                            is_player_white: true,
                            opening: "Bullet Opening",
                            won: 1,
                        }),
                        opening({
                            time_control: "600+0",
                            is_player_white: true,
                            opening: "Rapid Opening",
                            won: 1,
                        }),
                    ],
                    latest: [
                        latest({
                            time_control: "60+0",
                            date: "2026.01.01",
                            game_id: 1,
                            player_elo: 1700,
                        }),
                        latest({
                            time_control: "600+0",
                            date: "2026.01.02",
                            game_id: 2,
                            player_elo: 1800,
                        }),
                    ],
                }),
                site({
                    site: "Chess.com",
                    player: "Other",
                    colors: [color({ is_player_white: false, won: 5 })],
                }),
            ],
        };
        const filtered = filterPlayerStats(info, {
            website: "Lichess",
            account: "Magnus",
            timeControl: "rapid",
        });
        expect(filtered).toHaveLength(1);
        expect(filtered[0].daily).toHaveLength(1);
        expect(filtered[0].colors).toHaveLength(1);
        expect(filtered[0].openings).toEqual([
            expect.objectContaining({ opening: "Rapid Opening" }),
        ]);
        expect(filtered[0].latest).toEqual([expect.objectContaining({ player_elo: 1800 })]);
        const stats = deriveOverviewStatistics(filtered);
        expect(stats.white.won).toBe(1);
        expect(stats.latestRating).toBe(1800);
        expect(stats.whiteOpenings.map((row) => row.name)).toEqual(["Rapid Opening"]);
    });
});

describe("aggregateOpenings", () => {
    test("Overview returns exactly the three most-played openings in order per colour", () => {
        const stats = deriveOverviewStatistics([
            site({
                openings: [true, false].flatMap((is_player_white) =>
                    [2, 5, 1, 4, 3].map((games) =>
                        opening({
                            is_player_white,
                            opening: `${is_player_white ? "White" : "Black"} Opening ${games}`,
                            won: games,
                        }),
                    ),
                ),
            }),
        ]);
        expect(stats.whiteOpenings.map(({ name, games }) => ({ name, games }))).toEqual([
            { name: "White Opening 5", games: 5 },
            { name: "White Opening 4", games: 4 },
            { name: "White Opening 3", games: 3 },
        ]);
        expect(stats.blackOpenings.map(({ name, games }) => ({ name, games }))).toEqual([
            { name: "Black Opening 5", games: 5 },
            { name: "Black Opening 4", games: 4 },
            { name: "Black Opening 3", games: 3 },
        ]);
    });

    test("sums duplicate names and keeps colours apart", () => {
        const rows = [
            opening({ is_player_white: true, opening: "Sicilian Defense", won: 2, drawn: 1 }),
            opening({ is_player_white: true, opening: "Sicilian Defense", won: 1, lost: 1 }),
            opening({ is_player_white: false, opening: "Sicilian Defense", lost: 3 }),
        ];
        expect(aggregateOpenings(rows, "white")).toEqual([
            { name: "Sicilian Defense", games: 5, won: 3, draw: 1, lost: 1 },
        ]);
        expect(aggregateOpenings(rows, "black")).toEqual([
            { name: "Sicilian Defense", games: 3, won: 0, draw: 0, lost: 3 },
        ]);
    });
});

test("extractMonthlyResults sums wins, draws and losses separately per month", () => {
    expect(
        extractMonthlyResults([
            daily({ date: "2026.01.01", won: 2, drawn: 1, lost: 3 }),
            daily({ date: "2026.01.15", won: 1, drawn: 4, lost: 1 }),
            daily({ date: "2026.02.01", won: 5, drawn: 2, lost: 1 }),
        ]),
    ).toEqual([
        { name: "2026-01", count: 12, won: 3, drawn: 5, lost: 4 },
        { name: "2026-02", count: 8, won: 5, drawn: 2, lost: 1 },
    ]);
});
