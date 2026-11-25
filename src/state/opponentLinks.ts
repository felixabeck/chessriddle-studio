import { z } from "zod";
import type { OpponentAccount, OpponentProvider, OpponentTimeControl } from "@/bindings";

/** How far back online games are fetched, in years; `null` fetches all. */
export type OpponentPeriod = 1 | 3 | 5 | null;

export type OpponentFilter = { years: OpponentPeriod; timeControls: OpponentTimeControl[] };

/**
 * The online accounts of one opponent. `id` is the link's only identity. `playerName` is the name
 * the opponent carries in a database and is only ever compared, never used as a key. `database`
 * names the file holding the downloaded online games and is checked against the database listing
 * wherever it is read.
 */
export type OpponentLink = {
    id: string;
    playerName: string;
    accounts: OpponentAccount[];
    filter: OpponentFilter;
    database?: string;
};

/** Links are bounded; the least recently changed one goes first. */
export const MAX_OPPONENT_LINKS = 200;
/** The native import accepts at most this many accounts. */
export const MAX_OPPONENT_ACCOUNTS = 8;
const MAX_PLAYER_NAME_LENGTH = 200;
const MAX_USERNAME_LENGTH = 50;

/** Every time control the filter offers, in the order it shows them. */
export const OPPONENT_TIME_CONTROLS = [
    "bullet",
    "blitz",
    "rapid",
    "classical",
    "correspondence",
] as const satisfies readonly OpponentTimeControl[];

export const OPPONENT_PERIODS = [1, 3, 5, null] as const satisfies readonly OpponentPeriod[];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATABASE_FILE = /^opponent-[0-9a-f-]{36}-[0-9a-f]{8}\.db3$/;

/** Three years without bullet. */
export function defaultOpponentFilter(): OpponentFilter {
    return { years: 3, timeControls: ["blitz", "rapid", "classical", "correspondence"] };
}

/** The form a player name is compared in: surrounding blanks, composition and case do not count. */
export function normalizeOpponentName(name: string): string {
    return name.trim().normalize("NFC").toLowerCase();
}

function accountKey(account: OpponentAccount): string {
    return `${account.provider}:${account.username.toLowerCase()}`;
}

export function sameOpponentAccount(a: OpponentAccount, b: OpponentAccount): boolean {
    return accountKey(a) === accountKey(b);
}

/** The offered time controls a filter selects, without repeats, in the offered order. */
function orderedTimeControls(selected: readonly OpponentTimeControl[]): OpponentTimeControl[] {
    return OPPONENT_TIME_CONTROLS.filter((control) => selected.includes(control));
}

function distinctAccounts(accounts: readonly OpponentAccount[]): OpponentAccount[] {
    const distinct = new Map<string, OpponentAccount>();
    for (const account of accounts) {
        if (!distinct.has(accountKey(account))) distinct.set(accountKey(account), account);
    }
    return [...distinct.values()].slice(0, MAX_OPPONENT_ACCOUNTS);
}

const accountSchema = z
    .object({
        provider: z.enum(["lichess", "chesscom"]),
        username: z
            .string()
            .min(1)
            .max(MAX_USERNAME_LENGTH)
            .regex(/^[A-Za-z0-9_-]+$/),
    })
    .strict();

const filterSchema = z
    .object({
        years: z.union([z.literal(1), z.literal(3), z.literal(5), z.null()]),
        timeControls: z.array(z.enum(OPPONENT_TIME_CONTROLS)).min(1),
    })
    .strict();

const linkSchema = z
    .object({
        id: z.string().regex(UUID),
        playerName: z.string().min(1).max(MAX_PLAYER_NAME_LENGTH),
        accounts: z.array(accountSchema).min(1),
        filter: filterSchema,
        database: z.string().regex(DATABASE_FILE).optional(),
    })
    .strict();

/**
 * Reads the stored list element by element. An invalid element, one repeating an earlier id and
 * one repeating an earlier player name are dropped; repeated accounts within a link and repeated
 * time controls are folded. A valid stored value parses to itself.
 */
export const opponentLinksSchema: z.ZodType<OpponentLink[], z.ZodTypeDef, unknown> = z
    .unknown()
    .transform((value) => {
        if (!Array.isArray(value)) return [];
        const ids = new Set<string>();
        const names = new Set<string>();
        const links: OpponentLink[] = [];
        for (const item of value) {
            const parsed = linkSchema.safeParse(item);
            if (!parsed.success) continue;
            const name = normalizeOpponentName(parsed.data.playerName);
            if (name === "" || ids.has(parsed.data.id) || names.has(name)) continue;
            ids.add(parsed.data.id);
            names.add(name);
            links.push({
                ...parsed.data,
                accounts: distinctAccounts(parsed.data.accounts),
                filter: {
                    years: parsed.data.filter.years,
                    timeControls: orderedTimeControls(parsed.data.filter.timeControls),
                },
            });
        }
        return links.slice(-MAX_OPPONENT_LINKS);
    });

export function findOpponentLink(
    links: readonly OpponentLink[],
    playerName: string | null | undefined,
): OpponentLink | undefined {
    if (!playerName) return undefined;
    const name = normalizeOpponentName(playerName);
    return name === ""
        ? undefined
        : links.find((link) => normalizeOpponentName(link.playerName) === name);
}

export function findLinkWithAccount(
    links: readonly OpponentLink[],
    account: OpponentAccount,
): OpponentLink | undefined {
    return links.find((link) => link.accounts.some((other) => sameOpponentAccount(other, account)));
}

/** Whether a link can be kept under this player name; what is stored must read back. */
export function isOpponentPlayerName(playerName: string | null | undefined): playerName is string {
    const name = playerName?.trim() ?? "";
    return name !== "" && name.length <= MAX_PLAYER_NAME_LENGTH;
}

/** Replaces the link with this id and makes it the most recently changed one. */
function withLink(links: readonly OpponentLink[], link: OpponentLink): OpponentLink[] {
    return [...links.filter((other) => other.id !== link.id), link].slice(-MAX_OPPONENT_LINKS);
}

/**
 * Adds an account to the player's link, creating the link under `newId` when the player has none.
 * An account the link already has, one beyond the bound, and a player name that cannot be stored
 * change nothing.
 */
export function withOpponentAccount(
    links: readonly OpponentLink[],
    playerName: string,
    account: OpponentAccount,
    newId: string,
): OpponentLink[] {
    if (!isOpponentPlayerName(playerName)) return [...links];
    const existing = findOpponentLink(links, playerName);
    if (!existing) {
        return withLink(links, {
            id: newId,
            playerName: playerName.trim(),
            accounts: [account],
            filter: defaultOpponentFilter(),
        });
    }
    if (
        existing.accounts.some((other) => sameOpponentAccount(other, account)) ||
        existing.accounts.length >= MAX_OPPONENT_ACCOUNTS
    ) {
        return [...links];
    }
    return withLink(links, { ...existing, accounts: [...existing.accounts, account] });
}

/** Removes one account. The last account stays: a link without accounts is removed by unlinking. */
export function withoutOpponentAccount(
    links: readonly OpponentLink[],
    id: string,
    account: OpponentAccount,
): OpponentLink[] {
    const link = links.find((other) => other.id === id);
    if (!link) return [...links];
    const accounts = link.accounts.filter((other) => !sameOpponentAccount(other, account));
    if (accounts.length === 0 || accounts.length === link.accounts.length) return [...links];
    return withLink(links, { ...link, accounts });
}

/** Stores the filter; a selection without a time control changes nothing. */
export function withOpponentFilter(
    links: readonly OpponentLink[],
    id: string,
    filter: OpponentFilter,
): OpponentLink[] {
    const link = links.find((other) => other.id === id);
    const timeControls = orderedTimeControls(filter.timeControls);
    if (!link || timeControls.length === 0) return [...links];
    return withLink(links, { ...link, filter: { years: filter.years, timeControls } });
}

/** Points the link at the database holding its online games, or at none. */
export function withOpponentDatabase(
    links: readonly OpponentLink[],
    id: string,
    database: string | undefined,
): OpponentLink[] {
    const link = links.find((other) => other.id === id);
    if (!link) return [...links];
    const { database: _previous, ...rest } = link;
    return withLink(links, database === undefined ? rest : { ...rest, database });
}

/**
 * Renames the link, keeping its id, accounts, filter and database. An unknown id, a name that
 * cannot be stored, or a name another link already carries changes nothing.
 */
export function withOpponentLinkRenamed(
    links: readonly OpponentLink[],
    id: string,
    playerName: string,
): OpponentLink[] {
    if (!isOpponentPlayerName(playerName)) return [...links];
    const link = links.find((other) => other.id === id);
    if (!link) return [...links];
    const normalized = normalizeOpponentName(playerName);
    if (
        links.some(
            (other) => other.id !== id && normalizeOpponentName(other.playerName) === normalized,
        )
    ) {
        return [...links];
    }
    return withLink(links, { ...link, playerName: playerName.trim() });
}

export function withoutOpponentLink(links: readonly OpponentLink[], id: string): OpponentLink[] {
    return links.filter((link) => link.id !== id);
}

/** Every database file of a link starts with this, whichever import wrote it. */
export function opponentDatabasePrefix(id: string): string {
    return `opponent-${id}-`;
}

/** A fresh file name for one import of the link; `nonce` is eight hex digits. */
export function opponentDatabaseFilename(id: string, nonce: string): string {
    return `${opponentDatabasePrefix(id)}${nonce}.db3`;
}

/** The instant the filter's period starts at, in seconds since the Unix epoch. */
export function opponentSinceUnixSeconds(filter: OpponentFilter, now: Date): number | null {
    if (filter.years === null) return null;
    const since = new Date(now);
    since.setUTCFullYear(since.getUTCFullYear() - filter.years);
    return Math.floor(since.getTime() / 1000);
}

export function opponentProviderName(provider: OpponentProvider): string {
    return provider === "lichess" ? "Lichess" : "Chess.com";
}
