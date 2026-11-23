import type {
    ColorStatsData,
    DailyStatsData,
    LatestRatingData,
    OpeningStatsData,
    PlayerGameInfo,
    SiteStatsData,
} from "@/bindings";
import type { Color } from "chessops";
import type { AccountSite } from "@/utils/session";
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

/** The Website and Account filter values that select everything. */
export const ALL_WEBSITES = "All websites";
export const ALL_ACCOUNTS = "All accounts";

/** The account provider behind each single-website filter value. */
export const WEBSITE_SITE: Record<string, AccountSite> = {
    Lichess: "lichess",
    "Chess.com": "chesscom",
};

export type OverviewFilters = {
    website: string | null;
    account: string | null;
    timeControl: string | null;
};

/** FIDE table 8.1(a) dp values for p = 0.50 … 1.00 (d-20261108-15). */
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

export type OpeningSort = "games" | "best" | "worst";

/** Below this many games an opening's score is not ranked: one game would decide it. */
export const MIN_SCORED_GAMES = 5;

/**
 * Orders openings already sorted by games. In a score mode the openings with enough games come
 * first by score, ties by games and then name; the rest follow in their games order.
 */
export function sortOpenings(openings: OpeningStats[], sort: OpeningSort): OpeningStats[] {
    if (sort === "games") return openings;
    const direction = sort === "best" ? -1 : 1;
    const score = (opening: OpeningStats) => scoreFraction(opening.won, opening.draw, opening.lost);
    const scored = openings
        .filter((opening) => opening.games >= MIN_SCORED_GAMES)
        .sort(
            (a, b) =>
                direction * (score(a) - score(b)) ||
                b.games - a.games ||
                (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
        );
    return [...scored, ...openings.filter((opening) => opening.games < MIN_SCORED_GAMES)];
}

/** The verbatim time-control values of these statistics that fall into the selected category. */
export function matchingTimeControls(info: PlayerGameInfo, selected: string): string[] {
    const values = new Set<string>();
    for (const site of info.site_stats_data ?? []) {
        for (const rows of [site.daily, site.openings, site.colors, site.latest]) {
            for (const row of rows) {
                if (matchesTimeControl(site.site, selected, row.time_control)) {
                    values.add(row.time_control);
                }
            }
        }
    }
    return [...values].sort();
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

export function scoreHundredths(won: number, drawn: number, lost: number): number {
    const games = won + drawn + lost;
    return games === 0 ? 0 : Math.floor((200 * won + 100 * drawn + games) / (2 * games));
}

/** Rp = Ra + dp(p), with p rounded half-up to two decimals from the exact score (FIDE table 8.1(a)). */
export function fidePerformanceRating(
    averageOpponent: number,
    won: number,
    drawn: number,
    lost: number,
): number {
    return averageOpponent + fideDp(scoreHundredths(won, drawn, lost));
}

export function fideDp(hundredths: number): number {
    const clamped = Math.min(100, Math.max(0, hundredths));
    if (clamped >= 50) return DP_FROM_EQUAL[clamped - 50];
    return -DP_FROM_EQUAL[50 - clamped];
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
        .filter((site) => filters.website === ALL_WEBSITES || site.site === filters.website)
        .filter((site) => filters.account === ALL_ACCOUNTS || site.player === filters.account)
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
            if (
                row.max_player_elo !== null &&
                (peakRating === null || row.max_player_elo > peakRating)
            ) {
                peakRating = row.max_player_elo;
            }
        }
        for (const row of site.latest) {
            if (latest === null || compareLatestRating(row, latest) > 0) {
                latest = row;
            }
        }
    }

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

/** Every game with a result in these statistics, as the Overview headline counts them. */
export function playerGameCount(info: PlayerGameInfo): number {
    let games = 0;
    for (const site of info.site_stats_data ?? []) {
        for (const row of site.colors) games += row.won + row.drawn + row.lost;
    }
    return games;
}

/** The account sites these statistics have games from; other sites have no Website filter. */
export function statisticsSites(info: PlayerGameInfo): AccountSite[] {
    const present = new Set((info.site_stats_data ?? []).map((site) => site.site));
    return Object.entries(WEBSITE_SITE)
        .filter(([website]) => present.has(website))
        .map(([, site]) => site);
}

/**
 * The website and time-control category with the most rated games: a rating curve shows one
 * site's one category at a time, and starts on this one. `null` without rated games.
 */
export function busiestRatingLine(
    info: PlayerGameInfo,
): { website: string; timeControl: string } | null {
    const counts = new Map<string, { website: string; timeControl: string; games: number }>();
    for (const site of info.site_stats_data ?? []) {
        if (!(site.site in WEBSITE_SITE)) continue;
        for (const row of site.daily) {
            if (row.max_player_elo === null) continue;
            const timeControl = getTimeControl(site.site, row.time_control);
            const key = `${site.site}\n${timeControl}`;
            const line = counts.get(key) ?? { website: site.site, timeControl, games: 0 };
            line.games += row.won + row.drawn + row.lost;
            counts.set(key, line);
        }
    }
    let busiest: { website: string; timeControl: string; games: number } | null = null;
    for (const line of counts.values()) {
        if (busiest === null || line.games > busiest.games) busiest = line;
    }
    return busiest && { website: busiest.website, timeControl: busiest.timeControl };
}

/** The single-website filter value of each account site, the inverse of `WEBSITE_SITE`. */
const SITE_WEBSITE: Record<AccountSite, string> = {
    lichess: "Lichess",
    chesscom: "Chess.com",
};

/** The single-website filter value of an account site. */
export function websiteOf(site: AccountSite): string {
    return SITE_WEBSITE[site];
}
