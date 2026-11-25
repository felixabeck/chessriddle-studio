import type { DatabaseHandle, OpponentAccount, OpponentProvider } from "@/bindings";
import { errorUnlessCancelled } from "@/platform/errors";
import { normalizeOpponentName } from "@/state/opponentLinks";
import { getChessComProfile, getChessComStats } from "@/utils/chess.com/api";
import { query_players } from "@/utils/db";
import { getLichessAccount } from "@/utils/lichess/api";

/** What a site says about an account, as shown before the account is linked. */
export type OpponentProfile = {
    provider: OpponentProvider;
    /** The username as the site spells it. */
    username: string;
    title?: string;
    realName?: string;
    country?: string;
    ratedGames?: number;
    /** A closed Chess.com account; its games stay available. */
    closed: boolean;
};

export type OpponentLookup =
    | { kind: "found"; profile: OpponentProfile }
    | { kind: "notFound" }
    /** A closed Lichess account: the site no longer exports its games. */
    | { kind: "closed" }
    | { kind: "rateLimited" }
    | { kind: "failed" };

const USERNAME: Record<OpponentProvider, RegExp> = {
    lichess: /^[A-Za-z0-9_-]{2,30}$/,
    chesscom: /^[A-Za-z0-9_-]{1,50}$/,
};

/** Whether the text can be a username on the site at all. */
export function isOpponentUsername(provider: OpponentProvider, username: string): boolean {
    return USERNAME[provider].test(username);
}

/** Longest profile text shown; the sites' own limits are far below it. */
const MAX_PROFILE_TEXT = 100;

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== ""
        ? value.trim().slice(0, MAX_PROFILE_TEXT)
        : undefined;
}

async function lichessProfile(username: string): Promise<OpponentLookup> {
    const account = await getLichessAccount({ username });
    if (!account) return { kind: "notFound" };
    if (account.disabled) return { kind: "closed" };
    // Lichess has spelled these fields in two ways; both are read as untyped profile data.
    const profile: Record<string, unknown> = account.profile ?? {};
    const realName =
        text(profile.realName) ??
        text([text(profile.firstName), text(profile.lastName)].filter(Boolean).join(" "));
    const country = text(profile.flag) ?? text(profile.country);
    const title = text(account.title);
    const ratedGames = account.count?.rated;
    return {
        kind: "found",
        profile: {
            provider: "lichess",
            username: account.username,
            ...(title ? { title } : {}),
            ...(realName ? { realName } : {}),
            ...(country ? { country } : {}),
            ...(typeof ratedGames === "number" ? { ratedGames } : {}),
            closed: false,
        },
    };
}

async function chessComProfile(username: string): Promise<OpponentLookup> {
    const profile = await getChessComProfile(username);
    // The counts are an extra; the profile alone confirms the account.
    const stats = await getChessComStats(username).catch(() => null);
    const ratedGames = stats
        ? Object.values(stats).reduce(
              (sum, perf) => sum + perf.record.win + perf.record.loss + perf.record.draw,
              0,
          )
        : undefined;
    return {
        kind: "found",
        profile: {
            provider: "chesscom",
            username: profile.username,
            ...(profile.title ? { title: profile.title } : {}),
            ...(profile.name ? { realName: profile.name } : {}),
            ...(profile.countryCode ? { country: profile.countryCode } : {}),
            ...(ratedGames !== undefined ? { ratedGames } : {}),
            closed: profile.closed,
        },
    };
}

/** Asks the site about the account. Every failure is an outcome; nothing is thrown. */
export async function lookupOpponentAccount(
    provider: OpponentProvider,
    username: string,
): Promise<OpponentLookup> {
    try {
        const answer = await (provider === "lichess"
            ? lichessProfile(username)
            : chessComProfile(username));
        // The site's spelling is what gets stored and exported; it must be a name the site can have.
        return answer.kind === "found" && !isOpponentUsername(provider, answer.profile.username)
            ? { kind: "failed" }
            : answer;
    } catch (cause) {
        const status = errorUnlessCancelled(cause)?.remoteHttpRejection?.status;
        if (status === 404) return { kind: "notFound" };
        if (status === 429) return { kind: "rateLimited" };
        return { kind: "failed" };
    }
}

/** A player of the opponent's database that a linked username names. */
export type OpponentPlayer = { id: number; name: string };

/**
 * Every player the linked usernames name in the opponent's database, ordered by the earliest
 * matching account and then lowest id. After a complete merge that is one player; usernames that
 * met each other keep one each. The first one is the player the board follows.
 */
export async function opponentPlayers(
    file: DatabaseHandle,
    accounts: readonly OpponentAccount[],
): Promise<OpponentPlayer[]> {
    const accountRank = new Map<string, number>();
    for (const [index, account] of accounts.entries()) {
        const normalized = normalizeOpponentName(account.username);
        if (!accountRank.has(normalized)) accountRank.set(normalized, index);
    }
    const found = new Map<number, { name: string; rank: number }>();
    for (const [index, account] of accounts.entries()) {
        const players = await query_players(file, {
            name: account.username,
            nameMatch: "exact",
            options: { direction: "asc", sort: "id", skipCount: true },
        });
        for (const player of players.data) {
            const name = player.name ?? account.username;
            const rank =
                (player.name !== null
                    ? accountRank.get(normalizeOpponentName(player.name))
                    : undefined) ?? index;
            const existing = found.get(player.id);
            if (!existing || rank < existing.rank) found.set(player.id, { name, rank });
        }
    }
    return [...found]
        .sort(([idA, a], [idB, b]) => a.rank - b.rank || idA - idB)
        .map(([id, { name }]) => ({ id, name }));
}
