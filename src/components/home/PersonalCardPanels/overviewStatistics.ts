import type {
    ColorStatsData,
    DailyStatsData,
    LatestRatingData,
    OpeningStatsData,
    PlayerGameInfo,
    SiteStatsData,
} from "@/bindings";
import type { Color } from "chessops";
import { getTimeControl } from "@/utils/timeControl";

export type OpeningStats = {
    name: string;
    games: number;
    won: number;
    draw: number;
    lost: number;
};

export type MonthResults = {
    name: string;
    count: number;
    won: number;
    drawn: number;
    lost: number;
};

export type ColorOverview = {
    games: number;
    won: number;
    drawn: number;
    lost: number;
    ratedGames: number;
    averageOpponent: number | null;
    performance: number | null;
};

export type OverviewStatistics = {
    total: ColorOverview;
    white: ColorOverview;
    black: ColorOverview;
    peakRating: number | null;
    latestRating: number | null;
    months: MonthResults[];
    whiteOpenings: OpeningStats[];
    blackOpenings: OpeningStats[];
};

export type OverviewFilters = {
    website: string | null;
    account: string | null;
    timeControl: string | null;
};

/** FIDE table 8.1(a) dp values for p = 0.50 … 1.00 (d-20261108-06). */
const DP_FROM_EQUAL: readonly number[] = [
    0, 7, 14, 21, 29, 36, 43, 50, 57, 65, 72, 80, 87, 95, 102, 110, 117, 125, 133, 141, 149, 158,
    166, 175, 184, 193, 202, 211, 220, 230, 240, 251, 262, 273, 284, 296, 309, 322, 336, 351, 366,
    383, 401, 422, 444, 470, 501, 538, 589, 677, 800,
];

export function aggregateOpenings(data: OpeningStatsData[], color: Color): OpeningStats[] {
    const openings = new Map<string, OpeningStats>();
    for (const row of data) {
        if (row.is_player_white !== (color === "white")) continue;
        const previous = openings.get(row.opening) ?? {
            name: row.opening,
            games: 0,
            won: 0,
            draw: 0,
            lost: 0,
        };
        previous.won += row.won;
        previous.draw += row.drawn;
        previous.lost += row.lost;
        previous.games += row.won + row.drawn + row.lost;
        openings.set(row.opening, previous);
    }
    return Array.from(openings.values()).sort((a, b) => b.games - a.games);
}

export function scoreFraction(won: number, drawn: number, lost: number): number {
    const games = won + drawn + lost;
    if (games === 0) return 0;
    return (won + 0.5 * drawn) / games;
}

export function formatScorePercent(won: number, drawn: number, lost: number): string {
    const games = won + drawn + lost;
    if (games === 0) return "0%";
    const percent = scoreFraction(won, drawn, lost) * 100;
    return `${percent.toFixed(1).replace(/\.0$/, "")}%`;
}

export function formatResultCounts(won: number, drawn: number, lost: number): string {
    return `+${won} =${drawn} −${lost}`;
}

/** Rp = Ra + dp(p), with p rounded to two decimals (FIDE table 8.1(a)). */
export function fidePerformanceRating(
    averageOpponent: number,
    won: number,
    drawn: number,
    lost: number,
): number {
    return averageOpponent + fideDp(scoreFraction(won, drawn, lost));
}

export function fideDp(p: number): number {
    const hundredths = Math.min(100, Math.max(0, Math.round(p * 100)));
    if (hundredths >= 50) return DP_FROM_EQUAL[hundredths - 50];
    return -DP_FROM_EQUAL[50 - hundredths];
}

export function compareLatestRating(a: LatestRatingData, b: LatestRatingData): number {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.time === null && b.time !== null) return -1;
    if (a.time !== null && b.time === null) return 1;
    if (a.time !== null && b.time !== null && a.time !== b.time) {
        return a.time < b.time ? -1 : 1;
    }
    return a.game_id - b.game_id;
}

export function matchesTimeControl(
    website: string | null,
    selected: string | null,
    timeControl: string,
): boolean {
    return !selected || selected === "any" || getTimeControl(website, timeControl) === selected;
}

export function filterPlayerStats(info: PlayerGameInfo, filters: OverviewFilters): SiteStatsData[] {
    return (info.site_stats_data ?? [])
        .filter((site) => filters.website === "All websites" || site.site === filters.website)
        .filter((site) => filters.account === "All accounts" || site.player === filters.account)
        .map((site) => ({
            ...site,
            daily: site.daily.filter((row) =>
                matchesTimeControl(site.site, filters.timeControl, row.time_control),
            ),
            openings: site.openings.filter((row) =>
                matchesTimeControl(site.site, filters.timeControl, row.time_control),
            ),
            colors: site.colors.filter((row) =>
                matchesTimeControl(site.site, filters.timeControl, row.time_control),
            ),
            latest: site.latest.filter((row) =>
                matchesTimeControl(site.site, filters.timeControl, row.time_control),
            ),
        }));
}

export function extractMonthlyResults(dailyStats: DailyStatsData[]): MonthResults[] {
    const months = new Map<string, MonthResults>();
    for (const day of dailyStats) {
        const name = day.date.slice(0, 7).replace(".", "-");
        const previous = months.get(name) ?? { name, count: 0, won: 0, drawn: 0, lost: 0 };
        previous.won += day.won;
        previous.drawn += day.drawn;
        previous.lost += day.lost;
        previous.count += day.won + day.drawn + day.lost;
        months.set(name, previous);
    }
    return Array.from(months.values());
}

const TOP_OPENINGS = 3;

export function deriveOverviewStatistics(sites: SiteStatsData[]): OverviewStatistics {
    const white = emptyColor();
    const black = emptyColor();
    let peakRating: number | null = null;
    let latest: LatestRatingData | null = null;
    const daily: DailyStatsData[] = [];
    const openings: OpeningStatsData[] = [];

    for (const site of sites) {
        daily.push(...site.daily);
        openings.push(...site.openings);
        for (const row of site.colors) {
            addColor(row.is_player_white ? white : black, row);
        }
        for (const row of site.daily) {
            if (peakRating === null || row.max_player_elo > peakRating) {
                peakRating = row.max_player_elo;
            }
        }
        for (const row of site.latest) {
            if (latest === null || compareLatestRating(row, latest) > 0) {
                latest = row;
            }
        }
    }

    if (peakRating === 0) peakRating = null;

    return {
        total: summarizeColor(mergeColors(white, black)),
        white: summarizeColor(white),
        black: summarizeColor(black),
        peakRating,
        latestRating: latest?.player_elo ?? null,
        months: extractMonthlyResults(daily),
        whiteOpenings: aggregateOpenings(openings, "white").slice(0, TOP_OPENINGS),
        blackOpenings: aggregateOpenings(openings, "black").slice(0, TOP_OPENINGS),
    };
}

type ColorAccum = {
    won: number;
    drawn: number;
    lost: number;
    ratedWon: number;
    ratedDrawn: number;
    ratedLost: number;
    opponentEloSum: number;
};

function emptyColor(): ColorAccum {
    return {
        won: 0,
        drawn: 0,
        lost: 0,
        ratedWon: 0,
        ratedDrawn: 0,
        ratedLost: 0,
        opponentEloSum: 0,
    };
}

function addColor(target: ColorAccum, row: ColorStatsData): void {
    target.won += row.won;
    target.drawn += row.drawn;
    target.lost += row.lost;
    target.ratedWon += row.rated_won;
    target.ratedDrawn += row.rated_drawn;
    target.ratedLost += row.rated_lost;
    target.opponentEloSum += row.opponent_elo_sum;
}

function mergeColors(a: ColorAccum, b: ColorAccum): ColorAccum {
    return {
        won: a.won + b.won,
        drawn: a.drawn + b.drawn,
        lost: a.lost + b.lost,
        ratedWon: a.ratedWon + b.ratedWon,
        ratedDrawn: a.ratedDrawn + b.ratedDrawn,
        ratedLost: a.ratedLost + b.ratedLost,
        opponentEloSum: a.opponentEloSum + b.opponentEloSum,
    };
}

function summarizeColor(accum: ColorAccum): ColorOverview {
    const ratedGames = accum.ratedWon + accum.ratedDrawn + accum.ratedLost;
    const averageOpponent = ratedGames === 0 ? null : accum.opponentEloSum / ratedGames;
    return {
        games: accum.won + accum.drawn + accum.lost,
        won: accum.won,
        drawn: accum.drawn,
        lost: accum.lost,
        ratedGames,
        averageOpponent,
        performance:
            averageOpponent === null
                ? null
                : fidePerformanceRating(
                      averageOpponent,
                      accum.ratedWon,
                      accum.ratedDrawn,
                      accum.ratedLost,
                  ),
    };
}
