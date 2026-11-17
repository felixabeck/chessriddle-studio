import { tauri } from "@/platform/tauri";
import { z } from "zod";
import { decodeCompressedOrJson, serializeStorageValue } from "@/state/store/debouncedStorage";
import type { ChessComStats } from "@/utils/chess.com/api";
import { getLichessAccount, type LichessAccount } from "@/utils/lichess/api";
import {
    revocationReason,
    sanitizeRevocationReasons,
    type RevocationReason,
} from "@/utils/lichess/revocation";

export type LichessSession = {
    /** Opaque native credential identifier. It is never a bearer token. */
    handle?: string;
    username: string;
    account: LichessAccount;
};

export type ChessComSession = {
    username: string;
    stats: ChessComStats;
};

export type Session = {
    lichess?: LichessSession;
    chessCom?: ChessComSession;
    /** A player name the user chose. Accounts given the same alias form one player. */
    alias?: string;
    updatedAt: number;
};

export type AccountSite = "lichess" | "chesscom";

function sessionUsername(session: Session): string {
    return session.lichess?.username || session.chessCom?.username || "";
}

/**
 * The player of each session, in session order. A chosen alias groups every account given it,
 * and an account without one joins the alias equal to its exact username, so naming a player
 * after an account merges them. Any other account is its own player per site: the same username
 * on Lichess and Chess.com stays two players until the user gives them one name.
 */
export function playerKeys(sessions: Session[]): string[] {
    const aliases = new Set(sessions.flatMap((session) => (session.alias ? [session.alias] : [])));
    return sessions.map((session) => {
        const username = sessionUsername(session);
        const alias = session.alias || (aliases.has(username) ? username : "");
        if (alias) return `alias:${alias}`;
        const site: AccountSite = session.lichess ? "lichess" : "chesscom";
        return `${site}:${username.toLocaleLowerCase()}`;
    });
}

/** The name a player is shown under: its alias, else its account's username. */
export function sessionPlayerName(session: Session): string {
    return session.alias || sessionUsername(session);
}

export type PlayerGroup = {
    key: string;
    name: string;
    /** The sites the player's accounts live on, Lichess first, each listed once. */
    sites: AccountSite[];
    sessions: Session[];
};

/** Every player in order of first appearance. Names can repeat; keys cannot. */
export function playerGroups(sessions: Session[]): PlayerGroup[] {
    const groups = new Map<string, Session[]>();
    const keys = playerKeys(sessions);
    sessions.forEach((session, index) => {
        groups.set(keys[index], [...(groups.get(keys[index]) ?? []), session]);
    });
    return Array.from(groups, ([key, own]) => {
        const sites: AccountSite[] = [];
        if (own.some((session) => session.lichess?.username)) sites.push("lichess");
        if (own.some((session) => session.chessCom?.username)) sites.push("chesscom");
        return { key, name: sessionPlayerName(own[0]), sites, sessions: own };
    });
}

/** The sites a player's accounts live on, Lichess first, each listed once. */
export function playerSites(sessions: Session[], playerKey: string): AccountSite[] {
    return playerGroups(sessions).find((group) => group.key === playerKey)?.sites ?? [];
}

function recordUsername(record: Record<string, unknown>): string {
    for (const site of [record.lichess, record.chessCom]) {
        if (site !== null && typeof site === "object" && "username" in site) {
            const username = (site as { username: unknown }).username;
            if (typeof username === "string" && username !== "") return username;
        }
    }
    return "";
}

/**
 * Stored sessions written before player aliases always carried a `player` name, defaulting to
 * the account's exact stored username, so accounts sharing a username were merged without being
 * asked. A legacy name becomes an alias only when at least one of its accounts carries a name
 * other than its own username, even by case, which can only have been a choice. Records already
 * carrying `alias` keep it.
 */
export function migrateLegacyPlayerNames(
    records: Record<string, unknown>[],
): Record<string, unknown>[] {
    const chosen = new Set<string>();
    for (const record of records) {
        const player = record.player;
        if (
            "alias" in record ||
            typeof player !== "string" ||
            player === "" ||
            player === recordUsername(record)
        ) {
            continue;
        }
        chosen.add(player);
    }
    return records.map(({ player, ...record }) =>
        "alias" in record || typeof player !== "string" || !chosen.has(player)
            ? record
            : { ...record, alias: player },
    );
}

/** Storage boundary: the Lichess object is deliberately `strip`ped so an old `accessToken`
 * field can never be hydrated into Jotai state, even when Account screens never mount. */
export const sessionSchema = z
    .object({
        lichess: z
            .object({
                handle: z.string().optional(),
                username: z.string(),
                account: z.custom<LichessAccount>(
                    (value) => value !== null && typeof value === "object",
                ),
            })
            .strip()
            .optional(),
        chessCom: z
            .object({
                username: z.string(),
                stats: z.custom<ChessComStats>(
                    (value) => value !== null && typeof value === "object",
                ),
            })
            .strip()
            .optional(),
        alias: z.string().optional(),
        updatedAt: z.number(),
    })
    .strip();

export const sessionsSchema: z.ZodType<Session[]> = z.array(sessionSchema);

const SESSION_STORAGE_KEY = "sessions";

export type SessionPersistenceSnapshot = {
    sessions: Session[];
    status: "saved" | "unsaved";
};

// One public list belongs to this document, independently of mounted account consumers.
// Bootstrap admits it only after credential erasure succeeds. No legacy record is retained here.
let sessionSnapshot: SessionPersistenceSnapshot = { sessions: [], status: "saved" };
const sessionListeners = new Set<() => void>();

export function getSessionPersistenceSnapshot(): SessionPersistenceSnapshot {
    return sessionSnapshot;
}

export function subscribeSessionPersistence(listener: () => void): () => void {
    sessionListeners.add(listener);
    return () => sessionListeners.delete(listener);
}

/** Canonical public write boundary for bootstrap, account updates and explicit retry. */
export function savePublicSessions(sessions: Session[]): SessionPersistenceSnapshot {
    const safeSessions = sessionsSchema.parse(sessions);
    let status: SessionPersistenceSnapshot["status"] = "saved";
    try {
        persistSessions(safeSessions);
    } catch {
        // Do not expose exception text or stored contents from this credential-adjacent path.
        status = "unsaved";
    }
    sessionSnapshot = { sessions: safeSessions, status };
    for (const listener of sessionListeners) listener();
    return sessionSnapshot;
}

export function retrySessionPersistence(): SessionPersistenceSnapshot {
    return savePublicSessions(sessionSnapshot.sessions);
}

export class SessionSanitizationError extends Error {
    /** Whether this launch read any legacy Lichess bearer token; contains no account identity. */
    readonly legacySignInFound: boolean;
    /** Whether every token read is confirmed unusable, vacuously true for an empty batch. */
    readonly allRevoked: boolean;
    readonly unresolvedReasons: RevocationReason[];

    constructor(
        legacySignInFound = false,
        allRevoked = true,
        unresolvedReasons: readonly unknown[] = allRevoked ? [] : ["unconfirmed"],
    ) {
        super("account storage could not be sanitized");
        this.name = "SessionSanitizationError";
        this.legacySignInFound = legacySignInFound;
        this.allRevoked = allRevoked;
        this.unresolvedReasons = sanitizeRevocationReasons(unresolvedReasons);
    }
}

function parsePersistedSessions(): unknown[] {
    try {
        const raw = localStorage.getItem(SESSION_STORAGE_KEY);
        const parsed = decodeCompressedOrJson(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        // Never log storage contents: a legacy record can contain a bearer token.
        return [];
    }
}

function persistSessions(sessions: Session[]): void {
    localStorage.setItem(
        SESSION_STORAGE_KEY,
        serializeStorageValue(sessionsSchema.parse(sessions)),
    );
}

/** Returns whether the legacy credential record was overwritten with sanitized sessions or removed. */
function eraseLegacyCredentials(sessions: Session[]): boolean {
    try {
        persistSessions(sessions);
    } catch {
        try {
            localStorage.removeItem(SESSION_STORAGE_KEY);
        } catch {
            return false;
        }
    }
    return true;
}

/**
 * Attempts to scrub plaintext bearer tokens synchronously by overwriting sanitized sessions,
 * then removing the record if the overwrite fails, and reports whether credentials were erased.
 * Returns the tokens it read; migration input stays only in this startup call's memory, and no
 * retry path can re-persist it.
 */
function sanitizeLegacySessions(): {
    sessions: Session[];
    migrations: { username: string; token: string }[];
    legacyTokens: string[];
    credentialsErased: boolean;
} {
    const migrations: { username: string; token: string }[] = [];
    const legacyTokens: string[] = [];
    const sessions: Session[] = [];
    const records = parsePersistedSessions().filter(
        (stored): stored is Record<string, unknown> =>
            stored !== null && typeof stored === "object" && !Array.isArray(stored),
    );
    for (const storedSession of migrateLegacyPlayerNames(records)) {
        const session = { ...storedSession };
        const storedLichess = session.lichess;
        if (
            storedLichess !== null &&
            typeof storedLichess === "object" &&
            !Array.isArray(storedLichess)
        ) {
            const { accessToken, ...lichess } = storedLichess as Record<string, unknown>;
            if (typeof accessToken === "string" && accessToken !== "") {
                legacyTokens.push(accessToken);
            }
            if (
                typeof accessToken === "string" &&
                accessToken !== "" &&
                typeof lichess.username === "string" &&
                lichess.username !== ""
            ) {
                migrations.push({ username: lichess.username, token: accessToken });
            }
            session.lichess = lichess;
        }
        const parsed = sessionSchema.safeParse(session);
        if (parsed.success) sessions.push(parsed.data);
    }
    // This scrub is deliberately attempted before any await: after a successful overwrite or
    // removal, an app crash during native migration cannot resurrect plaintext credentials.
    const credentialsErased = eraseLegacyCredentials(sessions);
    return { sessions, migrations, legacyTokens, credentialsErased };
}

/**
 * Application bootstrap for native Lichess accounts. It runs before mounting React: legacy
 * token records are synchronously scrubbed by overwrite or removal before migrating once in
 * memory and reconciling native metadata into a deduplicated public-session list. If the scrub
 * cannot erase credentials, it attempts to revoke every read token through
 * `revoke_legacy_lichess_token`, then rejects with SessionSanitizationError carrying only a
 * token-free summary, without migrating, listing native accounts, or writing sessions.
 */
export async function initializePersistedSessions(): Promise<SessionPersistenceSnapshot> {
    const {
        sessions: sanitized,
        migrations,
        legacyTokens,
        credentialsErased,
    } = sanitizeLegacySessions();
    if (!credentialsErased) {
        const revocations = await Promise.all(
            legacyTokens.map(async (token) => {
                try {
                    return revocationReason(await tauri.revokeLegacyLichessToken(token));
                } catch {
                    return revocationReason(undefined);
                }
            }),
        );
        throw new SessionSanitizationError(
            legacyTokens.length > 0,
            revocations.every((reason) => reason === null),
            revocations,
        );
    }
    const migrated = await Promise.all(
        migrations.map(async ({ username, token }) => {
            try {
                const result = await tauri.migrateLegacyLichessToken(username, token);
                return result.account;
            } catch {
                return null;
            }
        }),
    );

    let accounts: Awaited<ReturnType<typeof tauri.listLichessAccounts>> | null = null;
    try {
        accounts = await tauri.listLichessAccounts();
    } catch {
        // The sanitized public sessions remain usable offline. A later startup reconciles them.
    }
    // A successful listing is newer authority than migration, including confirmed absence.
    const authoritative = new Map(
        (
            accounts ??
            migrated.filter(
                (account): account is NonNullable<typeof account> =>
                    account !== null &&
                    account !== undefined &&
                    typeof account.username === "string" &&
                    typeof account.handle === "string",
            )
        ).map((account: { username: string; handle: string }) => [
            account.username.toLocaleLowerCase(),
            account,
        ]),
    );
    const reconciled = sanitized.map((session) => {
        const lichess = session.lichess;
        if (!lichess) return session;
        const account = authoritative.get(lichess.username.toLocaleLowerCase());
        if (account) return { ...session, lichess: { ...lichess, handle: account.handle } };
        return accounts === null
            ? session
            : { ...session, lichess: { ...lichess, handle: undefined } };
    });
    const existing = new Set(
        reconciled.flatMap((session) =>
            session.lichess?.username ? [session.lichess.username.toLocaleLowerCase()] : [],
        ),
    );
    for (const account of authoritative.values()) {
        const key = account.username.toLocaleLowerCase();
        if (existing.has(key)) continue;
        try {
            const profile = await getLichessAccount({ handle: account.handle });
            if (!profile) continue;
            reconciled.push({
                updatedAt: Date.now(),
                lichess: { username: account.username, handle: account.handle, account: profile },
            });
            existing.add(key);
        } catch {
            // A native credential is still retained; its public card appears after the next
            // successful reconciliation rather than synthesising unverified profile data.
        }
    }
    // Collapse case-variant Chess.com duplicates written before adds were deduplicated case-insensitively.
    return savePublicSessions(dedupeChessComSessions(reconciled));
}

export function upsertLichessSession(
    sessions: Session[],
    alias: string,
    lichess: LichessSession,
): Session[] {
    const existingHandle = sessions.find(
        (session) =>
            sameAccountUsername(session.lichess?.username, lichess.username) &&
            session.lichess?.handle !== undefined,
    )?.lichess?.handle;
    return [
        ...sessions.filter(
            (session) => !sameAccountUsername(session.lichess?.username, lichess.username),
        ),
        {
            lichess:
                lichess.handle === undefined && existingHandle !== undefined
                    ? { ...lichess, handle: existingHandle }
                    : lichess,
            ...(alias ? { alias } : {}),
            updatedAt: Date.now(),
        },
    ];
}

/** Chess.com and Lichess usernames are case-insensitive. */
export function sameAccountUsername(a: string | undefined, b: string | undefined): boolean {
    return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

export function dedupeChessComSessions(sessions: Session[]): Session[] {
    const winnerByUsername = new Map<string, number>();
    sessions.forEach((session, index) => {
        if (!session.chessCom || session.lichess) return;
        const key = session.chessCom.username.toLowerCase();
        const prevIndex = winnerByUsername.get(key);
        if (prevIndex === undefined || session.updatedAt >= sessions[prevIndex].updatedAt) {
            winnerByUsername.set(key, index);
        }
    });
    return sessions.filter((session, index) => {
        if (!session.chessCom || session.lichess) return true;
        return winnerByUsername.get(session.chessCom.username.toLowerCase()) === index;
    });
}

export function upsertChessComSession(
    sessions: Session[],
    alias: string,
    chessCom: ChessComSession,
): Session[] {
    return [
        ...sessions.filter(
            (session) => !sameAccountUsername(session.chessCom?.username, chessCom.username),
        ),
        {
            chessCom,
            ...(alias ? { alias } : {}),
            updatedAt: Date.now(),
        },
    ];
}
