import { describe, expect, test, vi } from "vitest";
import type { CollectionDescriptor, NormalizedGame } from "@/bindings";
import {
    boundPlayerQuery,
    compareOwnGames,
    OwnGamesFeed,
    OWN_GAMES_CONCURRENCY,
    OWN_GAMES_PAGE_SIZE,
    type OwnGame,
    type OwnGamesPageLoader,
    type OwnGamesSnapshot,
} from "./ownGamesFeed";

function collection(
    id: string,
    status: CollectionDescriptor["status"] = "ready",
): CollectionDescriptor {
    return {
        id,
        name: id,
        file: { kind: "fileWorkspace", id: { id } },
        database: { kind: "database", id: { id } },
        status,
        generation: "one",
        account: null,
        omitted: 0,
        retiredDatabase: null,
        fetchSinceMs: null,
    };
}
function game(
    id: number,
    date: string | null = "2026.11.09",
    time: string | null = null,
): NormalizedGame {
    return {
        id,
        date,
        time,
        white: "Beck, Felix",
        black: "Prassas",
        white_id: 1,
        black_id: 2,
        fen: "",
        event: "",
        event_id: 1,
        site: "",
        site_id: 1,
        result: "*",
        moves: "",
    };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
async function flush() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("own game ordering", () => {
    test("matches normalized dates, nullable descending time, descending id and stable collection ties", () => {
        const c = collection("a");
        const games: OwnGame[] = [
            game(1, null),
            game(2, "????.??.??"),
            game(3, "2026.11.??"),
            game(4, "2026.11.09"),
            game(5, "2026.11.09", ""),
            game(6, "2026.11.09", "10:00:00"),
            game(7, "2026.11.09", "10:00:00"),
            game(8, "2026.12.01"),
        ].map((game) => ({ collection: c, game }));
        expect(games.sort(compareOwnGames).map((item) => item.game.id)).toEqual([
            8, 7, 6, 5, 4, 3, 2, 1,
        ]);
        expect(
            compareOwnGames(
                { collection: collection("a"), game: game(1) },
                { collection: collection("b"), game: game(1) },
            ),
        ).toBeLessThan(0);
        expect(
            compareOwnGames(
                { collection: c, game: game(1, "2026.11.00") },
                { collection: c, game: game(1, "2026.11.??") },
            ),
        ).toBe(0);
    });

    test("bounds player input to the native token and Unicode character limits", () => {
        const result = boundPlayerQuery(
            `  Felix,Beck\u0085${"😀".repeat(140)} ${Array.from({ length: 20 }, (_, i) => i).join(" ")} `,
        );
        const tokens = result.split(" ");
        expect(tokens).toHaveLength(16);
        expect(tokens.slice(0, 2)).toEqual(["Felix", "Beck"]);
        expect(Array.from(tokens[2])).toHaveLength(128);
        expect(boundPlayerQuery("%,_ \t")).toBe("% _");
    });
});

describe("paged merge", () => {
    test("globally interleaves collections across pages, including an early exhausted collection", async () => {
        const a = Array.from({ length: OWN_GAMES_PAGE_SIZE + 2 }, (_, index) =>
            game(100 - index * 2),
        );
        const b = [game(99), game(97), game(49)];
        const load = vi.fn<OwnGamesPageLoader>(async (database, query) => {
            const data = database.id.id === "a" ? a : b;
            const start = ((query.options?.page ?? 1) - 1) * OWN_GAMES_PAGE_SIZE;
            return { data: data.slice(start, start + OWN_GAMES_PAGE_SIZE), count: null };
        });
        const feed = new OwnGamesFeed(
            [collection("a"), collection("b")],
            "Felix Beck",
            load,
            () => {},
        );
        await feed.showMore(OWN_GAMES_PAGE_SIZE);
        expect(feed.snapshot().games.map((item) => item.game.id)).toEqual(
            [...a, ...b]
                .sort((a, b) => b.id - a.id)
                .slice(0, OWN_GAMES_PAGE_SIZE)
                .map((item) => item.id),
        );
        await feed.showMore();
        expect(feed.snapshot().games.map((item) => item.game.id)).toEqual(
            [...a, ...b].sort((a, b) => b.id - a.id).map((item) => item.id),
        );
        expect(feed.snapshot().hasMore).toBe(false);
        expect(
            load.mock.calls.every(
                ([, query]) =>
                    query.options?.sort === "newest" && query.player_name === "Felix Beck",
            ),
        ).toBe(true);
        feed.dispose();
    });

    test("waits for an unfetched head even when another collection already has buffered games", async () => {
        const second = deferred<{ data: NormalizedGame[]; count: null }>();
        const feed = new OwnGamesFeed(
            [collection("a"), collection("b")],
            "",
            async (database, query) => {
                if (database.id.id === "b") return { data: [game(1)], count: null };
                return query.options?.page === 1
                    ? { data: Array.from({ length: 25 }, (_, i) => game(100 - i)), count: null }
                    : second.promise;
            },
            () => {},
        );
        await feed.showMore(25);
        const more = feed.showMore(1);
        await flush();
        expect(feed.snapshot().games).toHaveLength(25);
        second.resolve({ data: [game(75)], count: null });
        await more;
        expect(feed.snapshot().games.at(-1)?.game.id).toBe(75);
        feed.dispose();
    });

    test("aborts a superseded identity and discards a response that ignores abort", async () => {
        const pending = deferred<{ data: NormalizedGame[]; count: null }>();
        let signal: AbortSignal | undefined;
        const publish = vi.fn();
        const feed = new OwnGamesFeed(
            [collection("a")],
            "",
            async (_database, _query, options) => {
                signal = options.signal;
                return pending.promise;
            },
            publish,
        );
        const loading = feed.showMore();
        feed.dispose();
        expect(signal?.aborted).toBe(true);
        pending.resolve({ data: [game(1)], count: null });
        await loading;
        expect(feed.snapshot().games).toEqual([]);
        expect(publish).toHaveBeenCalledTimes(1);
    });

    test("retains successful results when another collection fails, and counts non-ready descriptors before loading", async () => {
        const publish = vi.fn<(snapshot: OwnGamesSnapshot) => void>();
        const feed = new OwnGamesFeed(
            [
                collection("good"),
                collection("bad"),
                collection("stale", "stale"),
                collection("unavailable", "unavailable"),
                collection("retired", "retired"),
                collection("trashed", "trashed"),
                collection("preserved", "preservedOriginal"),
            ],
            "",
            async (database) => {
                if (database.id.id === "bad") throw new Error("failed");
                return { data: [game(1)], count: null };
            },
            publish,
        );
        expect(feed.snapshot().incompleteCount).toBe(2);
        expect(feed.snapshot().games).toEqual([]);
        await feed.showMore();
        expect(feed.snapshot().games.map((item) => item.collection.id)).toEqual(["good"]);
        expect(feed.snapshot().incompleteCount).toBe(3);
        expect(feed.snapshot().failedCollections).toEqual(["bad"]);
        feed.dispose();
    });

    test("bounds simultaneous collection page requests", async () => {
        const pending: (() => void)[] = [];
        let active = 0;
        let peak = 0;
        const feed = new OwnGamesFeed(
            Array.from({ length: 12 }, (_, i) => collection(String(i))),
            "",
            async () => {
                active++;
                peak = Math.max(peak, active);
                await new Promise<void>((resolve) => pending.push(resolve));
                active--;
                return { data: [], count: null };
            },
            () => {},
        );
        const loading = feed.showMore();
        for (let batch = 0; batch < 3; batch++) {
            await flush();
            expect(active).toBe(OWN_GAMES_CONCURRENCY);
            pending.splice(0).forEach((resolve) => resolve());
        }
        await loading;
        expect(peak).toBe(4);
        feed.dispose();
    });
});
