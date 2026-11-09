import type {
    CollectionDescriptor,
    DatabaseHandle,
    GameQuery,
    NormalizedGame,
    QueryResponse,
} from "@/bindings";

export const OWN_GAMES_PAGE_SIZE = 25;
// At most four collection page requests run concurrently for a feed.
export const OWN_GAMES_CONCURRENCY = 4;
export const PLAYER_QUERY_MAX_TOKENS = 16;
export const PLAYER_QUERY_MAX_TOKEN_CHARS = 128;

export type OwnGame = { collection: CollectionDescriptor; game: NormalizedGame };
export type OwnGamesSnapshot = {
    games: OwnGame[];
    loading: boolean;
    hasMore: boolean;
    failedCollections: string[];
    incompleteCount: number;
};
export type OwnGamesPageLoader = (
    database: DatabaseHandle,
    query: GameQuery,
    options: { signal: AbortSignal },
) => Promise<QueryResponse<NormalizedGame[]>>;

/** Rust splits on commas and Unicode whitespace, and counts Unicode scalar values. */
export function boundPlayerQuery(query: string): string {
    return query
        .split(/[,\p{White_Space}]+/u)
        .filter(Boolean)
        .slice(0, PLAYER_QUERY_MAX_TOKENS)
        .map((token) => Array.from(token).slice(0, PLAYER_QUERY_MAX_TOKEN_CHARS).join(""))
        .join(" ");
}

function compareText(left: string, right: string): number {
    // SQLite BINARY compares UTF-8, whose order is Unicode scalar order.
    const a = Array.from(left, (char) => char.codePointAt(0)!);
    const b = Array.from(right, (char) => char.codePointAt(0)!);
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
}

/** Exactly GameSort::Newest's date, nullable time and id order, then collection id. */
export function compareOwnGames(left: OwnGame, right: OwnGame): number {
    const date = compareText(
        (right.game.date ?? "").replaceAll("?", "0"),
        (left.game.date ?? "").replaceAll("?", "0"),
    );
    if (date) return date;
    const leftTime = left.game.time;
    const rightTime = right.game.time;
    if (leftTime == null && rightTime != null) return 1;
    if (rightTime == null && leftTime != null) return -1;
    return (
        compareText(rightTime ?? "", leftTime ?? "") ||
        right.game.id - left.game.id ||
        compareText(left.collection.id, right.collection.id)
    );
}

export function ownCollections(collections: readonly CollectionDescriptor[]) {
    return collections.filter(
        (collection) =>
            collection.database &&
            !["retired", "trashed", "preservedOriginal"].includes(collection.status),
    );
}

type Cursor = {
    collection: CollectionDescriptor;
    page: number;
    buffer: OwnGame[];
    exhausted: boolean;
    failed: boolean;
};

/** One disposable request identity owns every page and publication in this merge. */
export class OwnGamesFeed {
    private readonly controller = new AbortController();
    private readonly cursors: Cursor[];
    private readonly unavailable: number;
    private games: OwnGame[] = [];
    private running = false;
    private target = 0;

    constructor(
        collections: readonly CollectionDescriptor[],
        private readonly query: string,
        private readonly load: OwnGamesPageLoader,
        private readonly publish: (snapshot: OwnGamesSnapshot) => void,
    ) {
        const own = ownCollections(collections);
        this.unavailable = own.filter((collection) => collection.status !== "ready").length;
        this.cursors = own
            .filter((collection) => collection.status === "ready")
            .map((collection) => ({
                collection,
                page: 1,
                buffer: [],
                exhausted: false,
                failed: false,
            }));
    }

    snapshot(): OwnGamesSnapshot {
        const failedCollections = this.cursors
            .filter((cursor) => cursor.failed)
            .map((cursor) => cursor.collection.id);
        return {
            games: [...this.games],
            loading: this.running,
            hasMore: this.cursors.some((cursor) => cursor.buffer.length || !cursor.exhausted),
            failedCollections,
            incompleteCount: this.unavailable + failedCollections.length,
        };
    }

    dispose() {
        this.controller.abort();
    }

    async showMore(count = OWN_GAMES_PAGE_SIZE): Promise<void> {
        if (this.controller.signal.aborted) return;
        this.target += count;
        if (this.running) return;
        this.running = true;
        this.publish(this.snapshot());
        try {
            while (!this.controller.signal.aborted && this.games.length < this.target) {
                const pending = this.cursors.filter(
                    (cursor) => !cursor.exhausted && !cursor.buffer.length,
                );
                let next = 0;
                await Promise.all(
                    Array.from(
                        { length: Math.min(OWN_GAMES_CONCURRENCY, pending.length) },
                        async () => {
                            while (!this.controller.signal.aborted) {
                                const cursor = pending[next++];
                                if (!cursor) return;
                                try {
                                    const result = await this.load(
                                        cursor.collection.database!,
                                        {
                                            player_name: boundPlayerQuery(this.query) || undefined,
                                            options: {
                                                sort: "newest",
                                                direction: "desc",
                                                page: cursor.page,
                                                pageSize: OWN_GAMES_PAGE_SIZE,
                                                skipCount: true,
                                            },
                                        },
                                        { signal: this.controller.signal },
                                    );
                                    if (this.controller.signal.aborted) return;
                                    cursor.page++;
                                    cursor.buffer = result.data.map((game) => ({
                                        collection: cursor.collection,
                                        game,
                                    }));
                                    cursor.exhausted = result.data.length < OWN_GAMES_PAGE_SIZE;
                                } catch {
                                    if (this.controller.signal.aborted) return;
                                    cursor.failed = true;
                                    cursor.exhausted = true;
                                }
                            }
                        },
                    ),
                );
                if (this.controller.signal.aborted) return;
                // Every live collection has a head before any row is emitted. Refill an empty
                // cursor before the next comparison, even at a show-more boundary.
                const first = this.cursors
                    .filter((cursor) => cursor.buffer.length)
                    .sort((left, right) => compareOwnGames(left.buffer[0], right.buffer[0]))[0];
                if (!first) break;
                this.games.push(first.buffer.shift()!);
            }
        } finally {
            this.running = false;
            if (!this.controller.signal.aborted) this.publish(this.snapshot());
        }
    }
}
