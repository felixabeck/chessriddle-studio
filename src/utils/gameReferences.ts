import type {
    DatabaseHandle,
    ErrorCategory,
    NormalizedGame,
    Outcome,
    Player,
    QueryResponse,
} from "@/bindings";
import { normalizeError, type AppErrorCategory } from "@/platform/errors";
import { getDatabases, query_games, query_players } from "./db";

export type ReferencePlayer = { surname: string; initials: string; rating?: number };
export type GameReference = {
    start: number;
    end: number;
    label: string;
    outcome: Outcome;
    white: ReferencePlayer;
    black: ReferencePlayer;
    /** Full line-bounded tail through the next player pair, independent of the label end. */
    context: string;
    /** The visible label has a lexically identifiable closing round. */
    closed: boolean;
};

const surname = String.raw`[\p{L}\p{M}][\p{L}\p{M}'’\-]*(?: +[\p{L}\p{M}][\p{L}\p{M}'’\-]*)*`;
const player = String.raw`(${surname}),\s*([\p{L}](?:[.\-]?[\p{Lu}])*\.?)(?![\p{L}\p{M}])(?:\s*\((\d{3,4})\))?`;
const pair = new RegExp(
    String.raw`(?<![\p{L}\p{N}/-])(1-0|0-1|1/2-1/2|½-½)\s+${player}\s*-\s*${player}`,
    "gu",
);

// One field grammar for lexical label boundaries and candidate-relative metadata.
const fieldGrammar = String.raw`(?:((?:18|19|20|21)\d{2})(?: +\((\d+(?:\.\d+)*|[A-Za-z])\))?|\((\d+(?:\.\d+)*|[A-Za-z])\))(?=$|[\s.,!?:])`;
const fieldsAtStart = new RegExp(`^${fieldGrammar}`, "u");
const fieldsInText = new RegExp(String.raw`(?<![\p{L}\p{N}])${fieldGrammar}`, "gu");
const fieldRound = (fields: RegExpMatchArray) => fields[2] ?? fields[3];

function closingFields(text: string): RegExpExecArray | undefined {
    const fields = [...text.matchAll(fieldsInText)];
    const datedRounds = fields.filter((match) => match[1] && fieldRound(match));
    if (datedRounds.length === 1) return datedRounds[0];
    if (datedRounds.length > 1) return undefined;
    const rounds = fields.filter(fieldRound);
    const round = rounds.length === 1 ? rounds[0] : undefined;
    return round && !text.slice(round.index + round[0].length).trim() ? round : undefined;
}

/** Offsets refer to visible text from the safe comment reader, never stored Markdown. */
export function recognizeGameReferences(text: string): GameReference[] {
    const references: GameReference[] = [];
    const pairs = [...text.matchAll(pair)];
    for (const [index, match] of pairs.entries()) {
        const start = match.index;
        const pairEnd = start + match[0].length;
        const tail = text.slice(pairEnd, pairs[index + 1]?.index).split("\n")[0];
        // Candidate headers resolve matching boundaries later. A lexical label must never
        // discard a later supplied field or turn following prose into matching metadata.
        const terminator = closingFields(tail);
        const context = tail.trim();
        const end = terminator ? pairEnd + terminator.index + terminator[0].length : pairEnd;
        references.push({
            start,
            end,
            label: text.slice(start, end),
            outcome: match[1] === "½-½" ? "1/2-1/2" : (match[1] as Outcome),
            white: {
                surname: match[2],
                initials: match[3],
                rating: match[4] ? Number(match[4]) : undefined,
            },
            black: {
                surname: match[5],
                initials: match[6],
                rating: match[7] ? Number(match[7]) : undefined,
            },
            context,
            closed: Boolean(terminator),
        });
    }
    return references.filter(
        (reference, index) => index === 0 || reference.start >= references[index - 1].end,
    );
}

const normalized = (text: string) =>
    text.normalize("NFC").toLocaleLowerCase("en").replace(/’/g, "'").replace(/\s+/g, " ").trim();
const initialsOf = (text: string) => normalized(text).replace(/[.\s-]/g, "");
const knownMetadata = (text: string) => (text && !/^\?+$/.test(text) ? normalized(text) : "");

type ReferenceVerification = "verified" | "unverified" | "rejected";

function referencePlayerVerification(
    reference: ReferencePlayer,
    name: string | null,
): ReferenceVerification {
    if (!name) return "rejected";
    const comma = name.indexOf(",");
    let given: string;
    if (comma >= 0) {
        if (normalized(name.slice(0, comma)) !== normalized(reference.surname)) return "rejected";
        given = name.slice(comma + 1).trim();
    } else {
        const suffix = ` ${normalized(reference.surname)}`;
        if (!normalized(name).endsWith(suffix)) return "rejected";
        given = normalized(name).slice(0, -suffix.length);
    }
    if (!given) return "rejected";
    const wanted = initialsOf(reference.initials);
    const words = normalized(given)
        .split(/[.\s-]+/)
        .filter(Boolean);
    const abbreviated = words.every((word) => [...word].length === 1);
    // A compact token could be a short name or ordered initials, in every casing.
    if (!abbreviated && normalized(given) === wanted) return "unverified";
    const actual = abbreviated ? initialsOf(given) : words.map((word) => [...word][0]).join("");
    return actual.startsWith(wanted) ? "verified" : "rejected";
}

/** Whether a player may be offered, including ambiguous compact initials. */
export function matchesReferencePlayer(reference: ReferencePlayer, name: string | null): boolean {
    return referencePlayerVerification(reference, name) !== "rejected";
}

function referenceFieldsVerification(
    fields: RegExpMatchArray,
    game: NormalizedGame,
): ReferenceVerification {
    const year = fields[1];
    const round = fieldRound(fields);
    let verified = true;
    if (year) {
        const actual = /^\d{4}/.exec(game.date ?? "")?.[0];
        if (actual && actual !== year) return "rejected";
        if (!actual) verified = false;
    }
    if (round) {
        const actual = knownMetadata(game.round ?? "");
        if (actual && actual !== normalized(round)) return "rejected";
        if (!actual) verified = false;
    }
    return verified ? "verified" : "unverified";
}

/** The candidate's own event/site header that begins the citation context, longest first. */
function citedHeader(reference: GameReference, game: NormalizedGame) {
    const context = normalized(reference.context);
    const event = knownMetadata(game.event);
    const site = knownMetadata(game.site);
    const prefixes = [
        { text: event && site ? `${event} ${site}` : "", includesSite: true },
        { text: event, includesSite: false },
        { text: site, includesSite: true },
    ]
        .filter((prefix) => prefix.text)
        .sort((a, b) => b.text.length - a.text.length);
    const prefix = prefixes.find(({ text }) => context === text || context.startsWith(`${text} `));
    const remaining = prefix ? context.slice(prefix.text.length).trim() : context;
    const citesEvent = Boolean(
        event && prefix && (prefix.text === event || prefix.text === `${event} ${site}`),
    );
    return { context, event, site, prefix, remaining, citesEvent };
}

/**
 * ChessBase writes `Event Site Year` and annotators continue with their own prose. Once the
 * candidate's complete event begins the context, that prose cannot make the citation ambiguous.
 * A parenthesized continuation may extend the event itself (`Tata Steel (A)`), and every complete
 * year-round tuple after the header must still fit the game.
 */
function citedEventEstablishesGame(
    header: ReturnType<typeof citedHeader>,
    game: NormalizedGame,
): boolean {
    if (!header.citesEvent || header.remaining.startsWith("(")) return false;
    const anchored = fieldsAtStart.exec(header.remaining);
    if (anchored && referenceFieldsVerification(anchored, game) !== "verified") return false;
    return [...header.remaining.matchAll(fieldsInText)]
        .filter((fields) => fields[1] && fieldRound(fields))
        .every((fields) => referenceFieldsVerification(fields, game) === "verified");
}

function metadataVerification(
    reference: GameReference,
    game: NormalizedGame,
): ReferenceVerification {
    const header = citedHeader(reference, game);
    if (!header.context) return "verified";
    const verification = headerVerification(reference, game, header);
    return verification === "unverified" && citedEventEstablishesGame(header, game)
        ? "verified"
        : verification;
}

function headerVerification(
    reference: GameReference,
    game: NormalizedGame,
    { context, event, site, prefix, remaining }: ReturnType<typeof citedHeader>,
): ReferenceVerification {
    const anchored = fieldsAtStart.exec(remaining);
    if (!prefix && !anchored && reference.closed && event) return "rejected";
    if (reference.closed && prefix && !prefix.includesSite && site && remaining && !anchored)
        return "rejected";
    if (!remaining)
        return reference.closed || ![...context.matchAll(fieldsInText)].some(fieldRound)
            ? "verified"
            : "unverified";
    // Unknown text before a lexical close stays unverified, but its identifiable supplied
    // fields still constrain the game. An open prose tail supplies no incidental fields.
    let fields = anchored ?? (reference.closed ? closingFields(remaining) : undefined);
    if (!fields) return "unverified";
    let fieldText = remaining;
    let siteResolved = prefix?.includesSite;
    let verified = Boolean(anchored);
    if (anchored && fieldRound(anchored)) {
        // The first field can extend a shorter header. Account for adjacent fields or
        // the still-supplied known site before treating that first round as a close.
        const afterRound = remaining.slice(anchored[0].length).trim();
        const siteFollows = Boolean(
            prefix &&
            !siteResolved &&
            site &&
            (afterRound === site || afterRound.startsWith(`${site} `)),
        );
        const afterSite = siteFollows ? afterRound.slice(site.length).trim() : afterRound;
        const continuation = fieldsAtStart.exec(afterSite);
        if (continuation && siteFollows) {
            fields = continuation;
            fieldText = afterSite;
            siteResolved ||= siteFollows;
            verified = false;
        } else if (continuation && fieldRound(continuation)) {
            // Adjacency alone leaves both readings applicable. Matching either preserves
            // a choice, but cannot establish which tuple was actually supplied metadata.
            const original = referenceFieldsVerification(anchored, game);
            const alternative = referenceFieldsVerification(continuation, game);
            return original === "rejected" && alternative === "rejected"
                ? "rejected"
                : "unverified";
        } else if (continuation) {
            // A bare following year can begin prose. Keep the identifiable original
            // date/round constraints while the competing reading requires a choice.
            verified = false;
        } else {
            const matchingCombinedHeaderPrefix = Boolean(
                prefix && event && site && prefix.text === `${event} ${site}`,
            );
            const laterCompleteDatedRound = [...afterRound.matchAll(fieldsInText)].some(
                (match) => match[1] && fieldRound(match),
            );
            const certainClosingBoundary = !laterCompleteDatedRound;
            if (siteFollows || (laterCompleteDatedRound && !matchingCombinedHeaderPrefix)) {
                // The first field is still inside an unresolved header, or site evidence
                // placed it there. Do not compare it as date/round or promote later prose.
                return "unverified";
            }
            if (!certainClosingBoundary) {
                // Matching the candidate's combined headers does not prove this close
                // once another complete dated-round remains after the prefix.
                verified = false;
            }
            // The anchored original year/round still constrain the game. A later tuple
            // separated by ordinary prose is incidental and is compared only through
            // those retained fields below.
        }
    }
    const metadata = referenceFieldsVerification(fields, game);
    if (metadata === "rejected") return "rejected";
    if (fieldRound(fields)) {
        // Only fields before this established close belong to the citation. Later prose,
        // including years and parenthesized variation markers, is outside game metadata.
        return verified && metadata === "verified" ? "verified" : "unverified";
    }
    const residual = fieldText.slice(fields[0].length).trim();
    if (prefix && !siteResolved && site && residual) return "rejected";
    return verified && metadata === "verified" && !residual ? "verified" : "unverified";
}

function referenceGameVerification(
    reference: GameReference,
    game: NormalizedGame,
): ReferenceVerification {
    const white = referencePlayerVerification(reference.white, game.white);
    const black = referencePlayerVerification(reference.black, game.black);
    if (
        !(
            white !== "rejected" &&
            black !== "rejected" &&
            game.result === reference.outcome &&
            (reference.white.rating === undefined || game.white_elo === reference.white.rating) &&
            (reference.black.rating === undefined || game.black_elo === reference.black.rating)
        )
    )
        return "rejected";
    const metadata = metadataVerification(reference, game);
    if (metadata === "rejected") return "rejected";
    return [white, black, metadata].includes("unverified") ? "unverified" : "verified";
}

/**
 * Once some occurrence's own event begins the citation, an unverified occurrence from another
 * known event is the same players' other game, not a reading of this citation. Occurrences
 * without a known event stay, because their header cannot be compared.
 */
function withoutOtherEventsOnceOneIsCited(
    reference: GameReference,
    candidates: ReferenceOccurrence[],
): ReferenceOccurrence[] {
    const cites = candidates.map((candidate) => citedHeader(reference, candidate.game).citesEvent);
    if (!cites.includes(true)) return candidates;
    return candidates.filter(
        (candidate, index) =>
            cites[index] ||
            candidate.verification === "verified" ||
            !knownMetadata(candidate.game.event),
    );
}

/** Whether an occurrence may be offered. Lookup retains its separate metadata certainty. */
export function matchesReferenceGame(reference: GameReference, game: NormalizedGame): boolean {
    return referenceGameVerification(reference, game) !== "rejected";
}

export type ReferenceOccurrence = {
    database: DatabaseHandle;
    /** The database's own title, which Recent records; `source` is the dialog label. */
    databaseTitle: string;
    source: string;
    game: NormalizedGame;
    verification: Exclude<ReferenceVerification, "rejected">;
};
export type ReferenceFailure = {
    source: string;
    category: AppErrorCategory | "unavailable" | "omitted" | "budget";
    /** Discovery already provides localized, safe guidance. Query failures use category keys. */
    message?: string;
    backendCategory?: ErrorCategory;
    databaseAdmission?: true;
};
function sourceFailure(source: string, error: unknown): ReferenceFailure {
    const failure = normalizeError(error);
    return {
        source,
        category: failure.category,
        ...(failure.backendCategory ? { backendCategory: failure.backendCategory } : {}),
        ...(failure.databaseAdmission ? { databaseAdmission: true } : {}),
    };
}
export type ReferenceSearch = {
    candidates: ReferenceOccurrence[];
    failures: ReferenceFailure[];
    complete: boolean;
};
export const REFERENCE_SEARCH_LIMITS = {
    pageSize: 100,
    requests: 256,
    sources: 64,
    candidates: 100,
    players: 256,
    failures: 100,
} as const;
const apis = { getDatabases, query_games, query_players };

/** One fresh read-only traversal. Every page, retained ID and result has an explicit bound. */
export async function lookupGameReference(
    reference: GameReference,
    signal: AbortSignal,
    api: typeof apis = apis,
): Promise<ReferenceSearch> {
    const candidates: ReferenceOccurrence[] = [];
    const failures: ReferenceFailure[] = [];
    const addFailure = (failure: ReferenceFailure) => {
        if (failures.length < REFERENCE_SEARCH_LIMITS.failures) failures.push(failure);
        else failures[REFERENCE_SEARCH_LIMITS.failures - 1] = { source: "", category: "budget" };
    };
    let requests = 0;
    const check = () => signal.throwIfAborted();
    const budget = (source: string) => {
        if (!failures.some((failure) => failure.source === source && failure.category === "budget"))
            addFailure({ source, category: "budget" });
    };
    const pages = async <T>(
        source: string,
        query: (page: number) => Promise<QueryResponse<T[]>>,
        visit: (item: T) => boolean,
    ) => {
        for (let page = 1; ; page++) {
            check();
            if (requests >= REFERENCE_SEARCH_LIMITS.requests) {
                budget(source);
                return;
            }
            requests++;
            const response = await query(page);
            check();
            for (const item of response.data)
                if (!visit(item)) {
                    budget(source);
                    return;
                }
            if (
                response.count !== null
                    ? page * REFERENCE_SEARCH_LIMITS.pageSize >= response.count
                    : response.data.length < REFERENCE_SEARCH_LIMITS.pageSize
            )
                return;
            // An unexpectedly empty page before count is not proof of an exhaustive read.
            if (response.data.length === 0) {
                budget(source);
                return;
            }
        }
    };
    let library;
    try {
        library = await api.getDatabases({ signal });
        check();
    } catch (error) {
        check();
        return {
            candidates,
            failures: [sourceFailure("", error)],
            complete: false,
        };
    }
    for (const unread of library.unread)
        addFailure({ source: unread.filename, category: "unavailable", message: unread.error });
    for (const collection of library.collections ?? []) {
        if (collection.status === "trashed" && !collection.account) continue;
        if (collection.status === "retired") continue;
        if (!collection.database) addFailure({ source: collection.name, category: "unavailable" });
        if (collection.omitted > 0) addFailure({ source: collection.name, category: "omitted" });
    }
    if (library.databases.length > REFERENCE_SEARCH_LIMITS.sources) budget("");
    for (const database of library.databases.slice(0, REFERENCE_SEARCH_LIMITS.sources)) {
        check();
        const source =
            database.type === "success" && database.title !== database.filename
                ? `${database.title} (${database.filename})`
                : database.filename;
        if (database.type !== "success") {
            addFailure({ source, category: "unavailable", message: database.error });
            continue;
        }
        try {
            const players = async (person: ReferencePlayer) => {
                const matchedPlayers: Player[] = [];
                // SQLite NOCASE is ASCII-only. NFC keeps the ASCII fragment invariant across
                // composed/decomposed spellings. Scan all players only without such a fragment.
                await pages<Player>(
                    source,
                    (page) =>
                        api.query_players(
                            database.file,
                            {
                                name: person.surname
                                    .normalize("NFC")
                                    .match(/[A-Za-z]+/g)
                                    ?.sort((a, b) => b.length - a.length)[0],
                                nameMatch: "contains",
                                options: {
                                    page,
                                    pageSize: REFERENCE_SEARCH_LIMITS.pageSize,
                                    sort: "id",
                                    direction: "asc",
                                    skipCount: false,
                                },
                            },
                            { signal },
                        ),
                    (player) => {
                        if (matchesReferencePlayer(person, player.name)) {
                            if (matchedPlayers.length >= REFERENCE_SEARCH_LIMITS.players)
                                return false;
                            matchedPlayers.push(player);
                        }
                        return true;
                    },
                );
                return matchedPlayers;
            };
            const whites = await players(reference.white);
            if (!whites.length) continue;
            const blacks = await players(reference.black);
            const seen = new Set<number>();
            pairs: for (const white of whites)
                for (const black of blacks) {
                    await pages<NormalizedGame>(
                        source,
                        (page) =>
                            api.query_games(
                                database.file,
                                {
                                    player1: white.id,
                                    player2: black.id,
                                    sides: "WhiteBlack",
                                    outcome: reference.outcome,
                                    options: {
                                        page,
                                        pageSize: REFERENCE_SEARCH_LIMITS.pageSize,
                                        sort: "id",
                                        direction: "asc",
                                        skipCount: false,
                                    },
                                },
                                { signal },
                            ),
                        (game) => {
                            const verification = referenceGameVerification(reference, game);
                            if (!seen.has(game.id) && verification !== "rejected") {
                                if (candidates.length >= REFERENCE_SEARCH_LIMITS.candidates)
                                    return false;
                                seen.add(game.id);
                                candidates.push({
                                    database: database.file,
                                    databaseTitle: database.title,
                                    source,
                                    game,
                                    verification,
                                });
                            }
                            return true;
                        },
                    );
                    if (
                        requests >= REFERENCE_SEARCH_LIMITS.requests ||
                        candidates.length >= REFERENCE_SEARCH_LIMITS.candidates
                    ) {
                        budget(source);
                        break pairs;
                    }
                }
        } catch (error) {
            check();
            addFailure(sourceFailure(source, error));
        }
    }
    check();
    return {
        candidates: withoutOtherEventsOnceOneIsCited(reference, candidates),
        failures,
        complete: failures.length === 0,
    };
}
