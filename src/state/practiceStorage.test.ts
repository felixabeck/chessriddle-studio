import { createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ReviewLog } from "ts-fsrs";
import type { PracticeMigrationOutcome } from "@/bindings";
import type { Position } from "@/components/files/opening";
import { createZodStorage } from "./utils";

const native = vi.hoisted(() => ({
    acknowledge: vi.fn(),
    load: vi.fn(),
    loadReviews: vi.fn(),
    migrate: vi.fn(),
    record: vi.fn(),
    repair: vi.fn(),
    reset: vi.fn(),
    sync: vi.fn(),
    list: vi.fn(),
    epoch: vi.fn(),
}));
const persistError = vi.hoisted(() => ({ report: vi.fn() }));

vi.mock("@/platform/tauri", () => ({
    tauri: {
        acknowledgePracticeOrphans: native.acknowledge,
        listPracticeDecks: native.list,
        loadPracticeDeck: native.load,
        practiceEpoch: native.epoch,
        loadPracticeReviews: native.loadReviews,
        migratePracticeDeck: native.migrate,
        recordPracticeReview: native.record,
        repairPracticeDeck: native.repair,
        resetPracticeDeck: native.reset,
        syncPracticePositions: native.sync,
    },
}));
vi.mock("./persistError", () => ({ reportPersistError: persistError.report }));
vi.mock("@/i18n", () => ({
    default: {
        t: (key: string) =>
            key === "Board.Practice.QueuedWriteNotSaved" ? "practice change not saved" : key,
    },
}));

import {
    createPracticeDeckAtom,
    ensurePracticeMigration,
    practiceDataSchema,
    PRACTICE_MAX_CONFLICT_RETRIES,
    PRACTICE_SYNC_DEBOUNCE_MS,
    resetPracticeMigrationForTests,
    recordPracticeReview,
    retireMigratedLegacyDeckKeys,
    retireMigratedLegacyDeckKeysFromBrowser,
    runPracticeMigrationPass,
    type PracticeDeckValue,
    type PracticeMigrationDeckOutcome,
    type PracticeRatingMutation,
} from "./practiceStorage";

const firstFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const sameBoardDifferentFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 7 42";
const identityRefreshes = [
    { name: "clocks", raw: firstFen, refreshed: sameBoardDifferentFen },
    {
        name: "uncapturable EP",
        raw: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
        refreshed: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 7 42",
    },
    {
        name: "castling aliases",
        raw: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b HAha - 0 1",
        refreshed: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 7 42",
    },
];

function position(fen = firstFen, card = { due: "2026-09-22T00:00:00.000Z", reps: 0 }): Position {
    return { fen, answer: "e4", card: card as unknown as Position["card"] };
}

function snapshot(positions: Position[], overrides: Partial<PracticeDeckValue> = {}) {
    return {
        epoch: overrides.epoch ?? "no-map",
        deck: {
            positionsDocument: JSON.stringify({ positions }),
            revision: overrides.revision ?? 4,
            generation: overrides.generation ?? 2,
            migrated: true,
            unappliedReviews: overrides.unappliedReviews ?? 0,
            orphansAcknowledged: overrides.orphansAcknowledged ?? true,
        },
    };
}

async function waitForReady(
    store: ReturnType<typeof createStore>,
    atom: ReturnType<typeof createPracticeDeckAtom>,
) {
    await vi.waitFor(() => expect(store.get(atom).status).toBe("ready"));
}

function mountDeck(file = "file-a", game = 0) {
    const atom = createPracticeDeckAtom({ file, game });
    const store = createStore();
    const unsubscribe = store.sub(atom, () => undefined);
    return { atom, store, unsubscribe };
}

function ratingMutation(
    positions: Position[],
    sourcePosition = positions[0],
): PracticeRatingMutation {
    return {
        type: "rating",
        positions,
        entry: { fen: sourcePosition.fen, rating: 3 } as ReviewLog & { fen: string },
        entryId: "entry-fixed",
        sourcePosition,
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, reject, resolve };
}

function legacyData() {
    return { positions: [position()], logs: [{ fen: firstFen, rating: 3 }] };
}

function migrationOutcome(
    overrides: Partial<PracticeMigrationOutcome> = {},
): PracticeMigrationOutcome {
    return {
        status: "migrated",
        entries: 1,
        positions: 1,
        positionsDigest: "positions-digest",
        entriesDigest: "entries-digest",
        ...overrides,
    };
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    native.acknowledge.mockReset().mockResolvedValue(null);
    native.load.mockReset().mockResolvedValue({ epoch: "no-map", deck: null });
    native.epoch.mockReset().mockResolvedValue({ epoch: "no-map", legacySuperseded: false });
    native.loadReviews.mockReset();
    native.migrate.mockReset().mockResolvedValue({});
    native.record.mockReset().mockResolvedValue(5);
    native.repair.mockReset().mockResolvedValue(null);
    native.reset.mockReset().mockResolvedValue(5);
    native.sync.mockReset().mockResolvedValue(5);
    native.list.mockReset().mockResolvedValue({ decks: [], anomalies: [] });
    persistError.report.mockReset();
    resetPracticeMigrationForTests();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("practice epoch authority", () => {
    test("sends the rating snapshot as one write argument alongside its epoch", async () => {
        const document = JSON.stringify({ positions: [position()] });
        const entry = JSON.stringify({ fen: firstFen, rating: 3 });
        await recordPracticeReview("file-a", 2, 4, 9, 7, document, entry, "rating-id", "epoch-a");
        expect(native.record).toHaveBeenCalledExactlyOnceWith("file-a", 2, "epoch-a", {
            generation: 4,
            revision: 9,
            baseRevision: 7,
            positionsDocument: document,
            entry,
            entryId: "rating-id",
        });
    });

    test("drops the first sync when its reload observes a new epoch", async () => {
        native.load
            .mockResolvedValueOnce({ epoch: "no-map", deck: null })
            .mockResolvedValueOnce({ epoch: "after-delete", deck: null });
        const mounted = mountDeck();
        await waitForReady(mounted.store, mounted.atom);
        vi.useFakeTimers();
        const write = mounted.store.set(mounted.atom, { type: "sync", positions: [position()] });
        await vi.advanceTimersByTimeAsync(PRACTICE_SYNC_DEBOUNCE_MS);
        await write;
        expect(native.sync).not.toHaveBeenCalled();
        expect(mounted.store.get(mounted.atom)).toMatchObject({
            epoch: "after-delete",
            status: "ready",
            positions: [],
        });
        expect(persistError.report).toHaveBeenCalledOnce();
        mounted.unsubscribe();
    });

    test("rehydrates an epoch-conflicted rating without resubmitting it or a queued rating", async () => {
        const source = position();
        native.load
            .mockResolvedValueOnce(snapshot([source], { epoch: "old" }))
            .mockResolvedValueOnce(snapshot([source], { epoch: "new" }));
        const first = deferred<number>();
        native.record.mockImplementationOnce(() => first.promise);
        const mounted = mountDeck();
        await waitForReady(mounted.store, mounted.atom);
        const one = mounted.store.set(mounted.atom, ratingMutation([source]));
        const two = mounted.store.set(mounted.atom, {
            ...ratingMutation([source]),
            entryId: "queued",
        });
        first.reject({ tag: "backend-error", category: "conflict", message: "epoch changed" });
        await Promise.all([one, two]);
        expect(native.record).toHaveBeenCalledOnce();
        expect(native.record.mock.calls[0][2]).toBe("old");
        expect(mounted.store.get(mounted.atom)).toMatchObject({ epoch: "new", status: "ready" });
        mounted.unsubscribe();
    });

    test("uses the independent epoch read to repair a damaged map without an epoch", async () => {
        native.load
            .mockRejectedValueOnce({
                tag: "backend-error",
                category: "invalid-input",
                rootFailure: "unusable",
                message: "damaged map",
            })
            .mockResolvedValue({ epoch: "repaired", deck: null });
        native.epoch.mockRejectedValueOnce({
            tag: "backend-error",
            category: "invalid-input",
            rootFailure: "unusable",
            message: "damaged map",
        });
        const mounted = mountDeck();
        await vi.waitFor(() => expect(mounted.store.get(mounted.atom).repairable).toBe(true));
        await mounted.store.set(mounted.atom, { type: "repair" });
        expect(native.repair).toHaveBeenCalledExactlyOnceWith("file-a", 0, null);
        expect(mounted.store.get(mounted.atom)).toMatchObject({
            epoch: "repaired",
            status: "ready",
        });
        mounted.unsubscribe();
    });

    test("retains superseded legacy values without importing or blocking practice", async () => {
        const legacy = JSON.stringify(legacyData());
        localStorage.setItem("deck-file-a-0", legacy);
        native.epoch.mockResolvedValue({ epoch: "after-delete", legacySuperseded: true });
        native.load.mockResolvedValue({ epoch: "after-delete", deck: null });
        const result = await runPracticeMigrationPass();
        expect(result.outcomes[0]?.status).toBe("superseded");
        retireMigratedLegacyDeckKeysFromBrowser(result.outcomes);
        expect(native.migrate).not.toHaveBeenCalled();
        expect(localStorage.getItem("deck-file-a-0")).toBe(legacy);
        expect(persistError.report).not.toHaveBeenCalled();
        const mounted = mountDeck();
        await waitForReady(mounted.store, mounted.atom);
        mounted.unsubscribe();
    });

    test("does not retire a superseded legacy value when native inventory already has its ordinal", async () => {
        localStorage.setItem("deck-file-a-0", JSON.stringify(legacyData()));
        native.list.mockResolvedValue({ decks: [{ fileId: "file-a", game: 0 }], anomalies: [] });
        native.epoch.mockResolvedValue({ epoch: "after-delete", legacySuperseded: true });
        const result = await runPracticeMigrationPass();
        retireMigratedLegacyDeckKeysFromBrowser(result.outcomes);
        expect(result.outcomes[0]?.status).toBe("superseded");
        expect(localStorage.getItem("deck-file-a-0")).not.toBeNull();
        expect(native.migrate).not.toHaveBeenCalled();
    });
});

describe("retiring migrated legacy deck keys", () => {
    test("removes only migrated and already migrated keys from the outcomes", () => {
        const outcomes: PracticeMigrationDeckOutcome[] = [
            { key: "deck-migrated-0", identity: { file: "migrated", game: 0 }, status: "migrated" },
            { key: "deck-held-0", identity: { file: "held", game: 0 }, status: "alreadyMigrated" },
            { key: "deck-failed-0", identity: { file: "failed", game: 0 }, status: "failed" },
        ];
        for (const key of [...outcomes.map((outcome) => outcome.key), "deck-other-0"]) {
            localStorage.setItem(key, JSON.stringify(legacyData()));
        }

        retireMigratedLegacyDeckKeys(localStorage, outcomes);

        expect(localStorage.getItem("deck-migrated-0")).toBeNull();
        expect(localStorage.getItem("deck-held-0")).toBeNull();
        expect(localStorage.getItem("deck-failed-0")).toBe(JSON.stringify(legacyData()));
        expect(localStorage.getItem("deck-other-0")).toBe(JSON.stringify(legacyData()));
        expect(persistError.report).not.toHaveBeenCalled();
    });

    test("reports only the first removal failure and continues with later keys", () => {
        const outcomes: PracticeMigrationDeckOutcome[] = [
            { key: "deck-first-0", identity: { file: "first", game: 0 }, status: "migrated" },
            {
                key: "deck-second-0",
                identity: { file: "second", game: 0 },
                status: "alreadyMigrated",
            },
            { key: "deck-later-0", identity: { file: "later", game: 0 }, status: "migrated" },
        ];
        for (const outcome of outcomes) {
            localStorage.setItem(outcome.key, JSON.stringify(legacyData()));
        }
        const firstError = new Error("first removal denied");
        const originalRemoveItem = Storage.prototype.removeItem;
        const removeItem = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (
            this: Storage,
            key: string,
        ) {
            if (key === "deck-first-0") throw firstError;
            if (key === "deck-second-0") throw new Error("second removal denied");
            originalRemoveItem.call(this, key);
        });
        try {
            retireMigratedLegacyDeckKeys(localStorage, outcomes);
        } finally {
            removeItem.mockRestore();
        }

        expect(localStorage.getItem("deck-first-0")).toBe(JSON.stringify(legacyData()));
        expect(localStorage.getItem("deck-second-0")).toBe(JSON.stringify(legacyData()));
        expect(localStorage.getItem("deck-later-0")).toBeNull();
        expect(outcomes.map(({ status }) => status)).toEqual([
            "migrated",
            "alreadyMigrated",
            "migrated",
        ]);
        expect(persistError.report).toHaveBeenCalledExactlyOnceWith(firstError);
    });

    test("reports an unavailable browser storage getter without throwing", () => {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
        const error = new Error("storage disabled");
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            get: () => {
                throw error;
            },
        });
        try {
            expect(() => retireMigratedLegacyDeckKeysFromBrowser([])).not.toThrow();
        } finally {
            if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
        }
        expect(persistError.report).toHaveBeenCalledExactlyOnceWith(error);
    });
});

describe("the real practice deck atom", () => {
    test("a deck hydration starts and waits for the startup migration pass", async () => {
        const migration = deferred<{ decks: never[]; anomalies: never[] }>();
        native.list.mockReturnValueOnce(migration.promise);
        const first = position();
        native.load.mockResolvedValue(snapshot([first]));

        const mounted = mountDeck();
        expect(mounted.store.get(mounted.atom).status).toBe("loading");
        await vi.waitFor(() => expect(native.list).toHaveBeenCalledOnce());
        expect(native.load).not.toHaveBeenCalled();

        migration.resolve({ decks: [], anomalies: [] });
        await waitForReady(mounted.store, mounted.atom);
        expect(mounted.store.get(mounted.atom).positions).toEqual([first]);
        mounted.unsubscribe();

        native.load.mockResolvedValue(snapshot([position(sameBoardDifferentFen)], { revision: 9 }));
        const reloaded = mountDeck();
        await waitForReady(reloaded.store, reloaded.atom);
        expect(native.load).toHaveBeenCalledTimes(2);
        expect(reloaded.store.get(reloaded.atom).revision).toBe(9);
        reloaded.unsubscribe();
        expect(await ensurePracticeMigration()).toEqual({
            outcomes: [],
            inventory: { decks: [], anomalies: [] },
            scanTrusted: true,
            inventoryTrusted: true,
        });
    });

    test("does not call native storage for an empty tab identity", async () => {
        const { atom, store, unsubscribe } = mountDeck("");
        expect(store.get(atom).status).toBe("ready");
        await store.set(atom, { type: "sync", positions: [position()] });
        expect(native.load).not.toHaveBeenCalled();
        expect(native.sync).not.toHaveBeenCalled();
        unsubscribe();
    });

    test("creates a missing deck through sync at revision and generation zero", async () => {
        native.load.mockResolvedValue({ epoch: "no-map", deck: null });
        const { atom, store, unsubscribe } = mountDeck();
        await waitForReady(store, atom);
        vi.useFakeTimers();

        const write = store.set(atom, { type: "sync", positions: [position()] });
        await vi.advanceTimersByTimeAsync(PRACTICE_SYNC_DEBOUNCE_MS);
        await write;

        expect(native.sync).toHaveBeenCalledWith(
            "file-a",
            0,
            0,
            0,
            expect.stringContaining('"positions"'),
            "no-map",
        );
        expect(Object.keys(JSON.parse(native.sync.mock.calls[0][4]))).toEqual(["positions"]);
        unsubscribe();
    });

    test("reports a write failure, retains the pending value, and blocks later writes", async () => {
        const initial = position();
        native.load.mockResolvedValue(snapshot([initial]));
        const { atom, store, unsubscribe } = mountDeck();
        await waitForReady(store, atom);
        native.sync.mockRejectedValueOnce({
            tag: "backend-error",
            category: "io",
            message: "disk unavailable",
        });

        const next = position(sameBoardDifferentFen);
        vi.useFakeTimers();
        const write = store.set(atom, { type: "sync", positions: [next] });
        await vi.advanceTimersByTimeAsync(PRACTICE_SYNC_DEBOUNCE_MS);
        await write;

        expect(store.get(atom).status).toBe("write-blocked");
        expect(store.get(atom).positions).toEqual([next]);
        expect(persistError.report).toHaveBeenCalledOnce();
        await store.set(atom, { type: "sync", positions: [initial] });
        await vi.advanceTimersByTimeAsync(PRACTICE_SYNC_DEBOUNCE_MS);
        expect(native.sync).toHaveBeenCalledOnce();
        unsubscribe();
    });

    test("keeps a read failure distinct from an empty deck and blocks initialization", async () => {
        native.load.mockRejectedValueOnce({
            tag: "backend-error",
            category: "io",
            message: "practice read failed",
        });
        const { atom, store, unsubscribe } = mountDeck();
        await vi.waitFor(() => expect(store.get(atom).status).toBe("read-failed"));

        expect(store.get(atom).positions).toEqual([]);
        await store.set(atom, { type: "sync", positions: [position()] });
        await vi.waitFor(() => expect(native.load).toHaveBeenCalledOnce());
        expect(native.sync).not.toHaveBeenCalled();
        expect(persistError.report).not.toHaveBeenCalled();
        unsubscribe();
    });

    test("a load refusal the inventory did not classify as damage offers no repair", async () => {
        native.load.mockRejectedValueOnce({
            tag: "backend-error",
            category: "invalid-input",
            message: "file is not authorized for reading",
        });
        const { atom, store, unsubscribe } = mountDeck();
        await vi.waitFor(() => expect(store.get(atom).status).toBe("read-failed"));
        expect(store.get(atom).repairable).toBe(false);
        unsubscribe();
    });

    test("a successful repair clears the write block and permits the rebuilt deck to sync", async () => {
        native.list.mockResolvedValueOnce({
            decks: [{ fileId: "file-a", game: 0 }],
            anomalies: [
                { kind: "DamagedDeck", leaf: "file-a-positions.json", fileId: "file-a", game: 0 },
            ],
        });
        const { atom, store, unsubscribe } = mountDeck();
        await vi.waitFor(() => expect(store.get(atom).status).toBe("read-failed"));
        expect(store.get(atom).repairable).toBe(true);
        native.load.mockResolvedValue({ epoch: "no-map", deck: null });

        await store.set(atom, { type: "repair" });
        expect(native.repair).toHaveBeenCalledOnce();
        expect(store.get(atom).status).toBe("ready");

        vi.useFakeTimers();
        const write = store.set(atom, { type: "sync", positions: [position()] });
        await vi.advanceTimersByTimeAsync(PRACTICE_SYNC_DEBOUNCE_MS);
        await write;
        expect(store.get(atom).status).toBe("ready");
        expect(native.sync).toHaveBeenCalledOnce();
        unsubscribe();
    });

    test("repair clears stale migration state, migrates retained legacy data, and rehydrates", async () => {
        localStorage.setItem("deck-repaired-0", JSON.stringify(legacyData()));
        native.list
            .mockResolvedValueOnce({
                decks: [{ fileId: "repaired", game: 0 }],
                anomalies: [
                    {
                        kind: "DamagedDeck",
                        leaf: "repaired-positions.json",
                        fileId: "repaired",
                        game: 0,
                    },
                    {
                        kind: "StrandedMigration",
                        leaf: "repaired-state.json",
                        fileId: "repaired",
                        game: 0,
                    },
                ],
            })
            .mockResolvedValue({ decks: [], anomalies: [] });
        native.migrate
            .mockRejectedValueOnce(new Error("repair required"))
            .mockResolvedValueOnce(migrationOutcome());
        const mounted = mountDeck("repaired", 0);
        await vi.waitFor(() => expect(mounted.store.get(mounted.atom).status).toBe("read-failed"));

        native.load.mockResolvedValue(snapshot([position()], { revision: 8 }));
        await mounted.store.set(mounted.atom, { type: "repair" });
        const result = await ensurePracticeMigration();

        expect(native.migrate).toHaveBeenCalledTimes(2);
        expect(native.migrate).toHaveBeenLastCalledWith(
            "repaired",
            0,
            JSON.stringify(legacyData()),
            "no-map",
        );
        expect(native.list).toHaveBeenCalledTimes(2);
        expect(result.inventory?.anomalies).toEqual([]);
        expect(result.outcomes).toEqual([
            expect.objectContaining({
                identity: { file: "repaired", game: 0 },
                status: "migrated",
            }),
        ]);
        mounted.unsubscribe();

        const reopened = mountDeck("repaired", 0);
        await waitForReady(reopened.store, reopened.atom);
        expect(reopened.store.get(reopened.atom).positions).toEqual([position()]);
        reopened.unsubscribe();
    });

    test("an unreadable identity is read-failed, retryable, and has no repair offer state", async () => {
        native.list
            .mockResolvedValueOnce({
                decks: [{ fileId: "unreadable", game: 0 }],
                anomalies: [
                    {
                        kind: "Unreadable",
                        leaf: "unreadable-positions.json",
                        fileId: "unreadable",
                        game: 0,
                    },
                ],
            })
            .mockResolvedValueOnce({ decks: [], anomalies: [] });
        native.load.mockResolvedValue(snapshot([position()]));
        const mounted = mountDeck("unreadable", 0);
        await vi.waitFor(() => expect(mounted.store.get(mounted.atom).status).toBe("read-failed"));
        expect(mounted.store.get(mounted.atom).repairable).toBe(false);
        expect(mounted.store.get(mounted.atom).error?.message).toBe(
            "Board.Practice.InventoryUnreadable",
        );
        expect(persistError.report.mock.calls.map(([error]) => error.message)).toEqual([
            "Board.Practice.InventoryUnreadable",
        ]);

        await mounted.store.set(mounted.atom, { type: "retry" });
        await waitForReady(mounted.store, mounted.atom);
        expect(native.load).toHaveBeenCalledOnce();
        expect(native.repair).not.toHaveBeenCalled();
        mounted.unsubscribe();
    });

    test("an unreadable deck with retained legacy data stays non-repairable after migration I/O failure", async () => {
        localStorage.setItem("deck-unreadable-0", JSON.stringify(legacyData()));
        native.list.mockResolvedValue({
            decks: [{ fileId: "unreadable", game: 0 }],
            anomalies: [
                {
                    kind: "Unreadable",
                    leaf: "unreadable-positions.json",
                    fileId: "unreadable",
                    game: 0,
                },
            ],
        });
        native.migrate.mockRejectedValueOnce({
            tag: "backend-error",
            category: "io",
            message: "practice read failed",
        });

        const result = await runPracticeMigrationPass();
        const mounted = mountDeck("unreadable", 0);
        await vi.waitFor(() => expect(mounted.store.get(mounted.atom).status).toBe("read-failed"));

        expect(result.outcomes[0]?.status).toBe("failed");
        expect(mounted.store.get(mounted.atom).repairable).toBe(false);
        expect(native.repair).not.toHaveBeenCalled();
        mounted.unsubscribe();
    });

    test("a localStorage read failure during migration is not repairable", async () => {
        const key = "deck-storage-denied-0";
        localStorage.setItem(key, JSON.stringify(legacyData()));
        native.list.mockResolvedValue({ decks: [], anomalies: [] });
        const originalGetItem = Storage.prototype.getItem;
        const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (
            this: Storage,
            candidate: string,
        ) {
            if (candidate === key) throw new Error("localStorage read denied");
            return originalGetItem.call(this, candidate);
        });

        try {
            const result = await runPracticeMigrationPass();
            const mounted = mountDeck("storage-denied", 0);
            await vi.waitFor(() =>
                expect(mounted.store.get(mounted.atom).status).toBe("read-failed"),
            );

            expect(result.outcomes[0]?.status).toBe("failed");
            expect(mounted.store.get(mounted.atom).repairable).toBe(false);
            expect(native.repair).not.toHaveBeenCalled();
            mounted.unsubscribe();
        } finally {
            getItem.mockRestore();
        }
    });

    test("malformed legacy JSON is not repairable", async () => {
        localStorage.setItem("deck-malformed-legacy-0", "{not-json");
        native.list.mockResolvedValue({ decks: [], anomalies: [] });

        const result = await runPracticeMigrationPass();
        const mounted = mountDeck("malformed-legacy", 0);
        await vi.waitFor(() => expect(mounted.store.get(mounted.atom).status).toBe("read-failed"));

        expect(result.outcomes[0]?.status).toBe("failed");
        expect(mounted.store.get(mounted.atom).repairable).toBe(false);
        expect(native.repair).not.toHaveBeenCalled();
        mounted.unsubscribe();
    });

    test("a DamagedDeck stays repairable when its legacy migration fails, also after retry", async () => {
        localStorage.setItem("deck-damaged-migration-0", JSON.stringify(legacyData()));
        native.list.mockResolvedValue({
            decks: [{ fileId: "damaged-migration", game: 0 }],
            anomalies: [
                {
                    kind: "DamagedDeck",
                    leaf: "damaged-migration-positions.json",
                    fileId: "damaged-migration",
                    game: 0,
                },
            ],
        });
        native.migrate.mockRejectedValue({
            tag: "backend-error",
            category: "io",
            message: "migration storage unavailable",
        });

        const result = await runPracticeMigrationPass();
        const mounted = mountDeck("damaged-migration", 0);
        await vi.waitFor(() => expect(mounted.store.get(mounted.atom).status).toBe("read-failed"));

        expect(result.outcomes[0]?.status).toBe("failed");
        expect(mounted.store.get(mounted.atom).repairable).toBe(true);

        const migrateCalls = native.migrate.mock.calls.length;
        await mounted.store.set(mounted.atom, { type: "retry" });
        expect(native.migrate.mock.calls.length).toBeGreaterThan(migrateCalls);
        expect(mounted.store.get(mounted.atom).status).toBe("read-failed");
        expect(mounted.store.get(mounted.atom).repairable).toBe(true);
        mounted.unsubscribe();
    });

    test("adopts the committed reset revision after partial removal", async () => {
        const initial = position();
        const resetPosition = position(sameBoardDifferentFen);
        native.load.mockResolvedValue(snapshot([initial], { revision: 4, generation: 2 }));
        native.reset.mockRejectedValueOnce({
            tag: "backend-error",
            category: "partial-removal",
            message: "partially removed: practice deck",
        });
        const mounted = mountDeck();
        await waitForReady(mounted.store, mounted.atom);

        await mounted.store.set(mounted.atom, { type: "reset", positions: [resetPosition] });

        const value = mounted.store.get(mounted.atom);
        expect(value.status).toBe("write-blocked");
        expect(value.positions).toEqual([resetPosition]);
        expect(value.revision).toBe(5);
        expect(value.generation).toBe(3);
        expect(value.error?.category).toBe("applied-despite-error");
        mounted.unsubscribe();
    });

    test("a reset committed before partial-removal still clears identity failure state", async () => {
        native.load.mockResolvedValue(snapshot([position()], { revision: 4, generation: 2 }));
        const mounted = mountDeck("file-a", 0);
        await waitForReady(mounted.store, mounted.atom);

        localStorage.setItem("deck-file-a-0", JSON.stringify(legacyData()));
        native.list.mockResolvedValue({ decks: [], anomalies: [] });
        native.migrate.mockRejectedValueOnce({
            tag: "backend-error",
            category: "invalid-input",
            message: "damaged native deck",
        });
        expect((await runPracticeMigrationPass()).outcomes[0]?.status).toBe("failed");
        native.reset.mockRejectedValueOnce({
            tag: "backend-error",
            category: "partial-removal",
            message: "partially removed: review cleanup",
        });

        await mounted.store.set(mounted.atom, { type: "reset", positions: [position()] });
        expect(mounted.store.get(mounted.atom).error?.category).toBe("applied-despite-error");
        mounted.unsubscribe();

        const reopened = mountDeck("file-a", 0);
        await waitForReady(reopened.store, reopened.atom);
        expect(reopened.store.get(reopened.atom).positions).toEqual([position()]);
        reopened.unsubscribe();
    });

    test.each(identityRefreshes)(
        "merges a committed rating into a later $name sync",
        async ({ raw, refreshed }) => {
            const source = position(raw);
            const syncPosition = position(refreshed);
            const rated = position(raw, {
                due: "2026-10-01T00:00:00.000Z",
                reps: 1,
            });
            native.load.mockResolvedValue(snapshot([source], { revision: 4, generation: 2 }));
            native.record.mockResolvedValueOnce(5);
            native.sync.mockResolvedValueOnce(6);
            const { atom, store, unsubscribe } = mountDeck();
            await waitForReady(store, atom);
            vi.useFakeTimers();

            const syncWrite = store.set(atom, { type: "sync", positions: [syncPosition] });
            const ratingWrite = store.set(atom, {
                ...ratingMutation([rated], source),
                entryId: "before-sync",
            });
            await ratingWrite;
            await vi.advanceTimersByTimeAsync(PRACTICE_SYNC_DEBOUNCE_MS);
            await syncWrite;

            expect(native.sync).toHaveBeenCalledOnce();
            expect(native.sync.mock.calls[0][3]).toBe(5);
            expect(JSON.parse(native.sync.mock.calls[0][4]).positions).toEqual([
                { ...rated, fen: refreshed },
            ]);
            expect(JSON.parse(native.record.mock.calls[0][3].entry).fen).toBe(raw);
            expect(native.record.mock.calls[0][3].entryId).toBe("before-sync");
            unsubscribe();
        },
    );

    test.each(identityRefreshes)(
        "debounced $name sync retains the last committed equivalent card without merging histories",
        async ({ raw, refreshed }) => {
            const first = position(raw, { due: "2026-10-01T00:00:00.000Z", reps: 4 });
            const last = position(refreshed, { due: "2026-11-01T00:00:00.000Z", reps: 9 });
            native.load.mockResolvedValue(snapshot([first, last]));
            const { atom, store, unsubscribe } = mountDeck();
            await waitForReady(store, atom);
            vi.useFakeTimers();
            const pending = store.set(atom, { type: "sync", positions: [position(raw)] });
            await vi.advanceTimersByTimeAsync(PRACTICE_SYNC_DEBOUNCE_MS);
            await pending;
            expect(JSON.parse(native.sync.mock.calls[0][4]).positions).toEqual([
                { ...first, card: last.card },
            ]);
            expect(store.get(atom).positions).toEqual([{ ...first, card: last.card }]);
            unsubscribe();
        },
    );

    test("drops a debounced sync computed before a reset", async () => {
        const initial = position();
        const staleSync = position(sameBoardDifferentFen);
        const resetPosition = position("8/8/8/8/8/8/8/8 w - - 0 1");
        native.load.mockResolvedValue(snapshot([initial], { revision: 4, generation: 2 }));
        native.reset.mockResolvedValueOnce(6);
        const { atom, store, unsubscribe } = mountDeck();
        await waitForReady(store, atom);
        vi.useFakeTimers();

        const syncWrite = store.set(atom, { type: "sync", positions: [staleSync] });
        const resetWrite = store.set(atom, { type: "reset", positions: [resetPosition] });
        await resetWrite;
        await vi.advanceTimersByTimeAsync(PRACTICE_SYNC_DEBOUNCE_MS);
        await syncWrite;

        expect(native.reset).toHaveBeenCalledOnce();
        expect(native.sync).not.toHaveBeenCalled();
        expect(store.get(atom).generation).toBe(3);
        unsubscribe();
    });

    test("chains a rating behind an in-flight sync using the post-sync revision", async () => {
        const source = position();
        const synced = position(sameBoardDifferentFen);
        const rated = position(sameBoardDifferentFen, {
            due: "2026-10-01T00:00:00.000Z",
            reps: 1,
        });
        native.load.mockResolvedValue(snapshot([source], { revision: 4, generation: 2 }));
        const syncResult = deferred<number>();
        native.sync.mockImplementationOnce(() => syncResult.promise);
        native.record.mockResolvedValueOnce(6);
        const { atom, store, unsubscribe } = mountDeck();
        await waitForReady(store, atom);
        vi.useFakeTimers();

        const syncWrite = store.set(atom, { type: "sync", positions: [synced] });
        await vi.advanceTimersByTimeAsync(PRACTICE_SYNC_DEBOUNCE_MS);
        await vi.waitFor(() => expect(native.sync).toHaveBeenCalledOnce());
        const ratingWrite = store.set(atom, {
            ...ratingMutation([rated], synced),
            entryId: "after-sync",
        });

        syncResult.resolve(5);
        await Promise.all([syncWrite, ratingWrite]);

        expect(native.record).toHaveBeenCalledOnce();
        expect(native.record.mock.calls[0][3].revision).toBe(5);
        expect(native.record.mock.calls[0][3].baseRevision).toBe(5);
        expect(native.record.mock.calls[0][3].entryId).toBe("after-sync");
        unsubscribe();
    });

    test("chains back-to-back ratings in order with the returned revision", async () => {
        const source = position();
        const first = position(firstFen, { due: "2026-10-01T00:00:00.000Z", reps: 1 });
        const second = position(firstFen, { due: "2026-11-01T00:00:00.000Z", reps: 2 });
        native.load.mockResolvedValue(snapshot([source], { revision: 4, generation: 2 }));
        const firstResult = deferred<number>();
        const secondResult = deferred<number>();
        native.record
            .mockImplementationOnce(() => firstResult.promise)
            .mockImplementationOnce(() => secondResult.promise);
        const { atom, store, unsubscribe } = mountDeck();
        await waitForReady(store, atom);

        const firstWrite = store.set(atom, {
            ...ratingMutation([first], source),
            entryId: "first-rating",
        });
        const secondWrite = store.set(atom, {
            ...ratingMutation([second], first),
            entryId: "second-rating",
        });
        await vi.waitFor(() => expect(native.record).toHaveBeenCalledOnce());
        firstResult.resolve(5);
        await vi.waitFor(() => expect(native.record).toHaveBeenCalledTimes(2));
        expect(native.record.mock.calls[1][3].revision).toBe(5);
        expect(native.record.mock.calls[1][3].entryId).toBe("second-rating");
        secondResult.resolve(6);
        await Promise.all([firstWrite, secondWrite]);
        unsubscribe();
    });

    test.each(identityRefreshes)(
        "reports and adopts a rating whose $name-equivalent conflicted card already changed",
        async ({ raw, refreshed }) => {
            const source = position(raw);
            const rated = position(raw, { due: "2026-10-01T00:00:00.000Z", reps: 1 });
            const reloaded = position(refreshed, { due: "2026-10-02T00:00:00.000Z", reps: 2 });
            native.load
                .mockResolvedValueOnce(snapshot([source], { revision: 4, generation: 2 }))
                .mockResolvedValueOnce(snapshot([reloaded], { revision: 5, generation: 2 }));
            native.record.mockRejectedValueOnce({
                tag: "backend-error",
                category: "conflict",
                message: "revision conflict",
            });
            const { atom, store, unsubscribe } = mountDeck();
            await waitForReady(store, atom);

            await store.set(atom, {
                ...ratingMutation([rated], source),
                entryId: "dropped-rating",
            });

            expect(persistError.report).toHaveBeenCalledOnce();
            expect(store.get(atom).status).toBe("ready");
            expect(store.get(atom).positions).toEqual([reloaded]);

            native.record.mockResolvedValueOnce(6);
            await store.set(atom, {
                ...ratingMutation(
                    [position(refreshed, { due: "2026-12-01T00:00:00.000Z", reps: 3 })],
                    reloaded,
                ),
                entryId: "after-drop",
            });
            expect(native.record).toHaveBeenCalledTimes(2);
            expect(persistError.report).toHaveBeenCalledOnce();
            unsubscribe();
        },
    );

    test("reports an already-queued rating as not saved after an earlier write fails", async () => {
        const source = position();
        const first = position(firstFen, { due: "2026-10-01T00:00:00.000Z", reps: 1 });
        const second = position(firstFen, { due: "2026-11-01T00:00:00.000Z", reps: 2 });
        native.load.mockResolvedValue(snapshot([source], { revision: 4, generation: 2 }));
        native.record.mockRejectedValueOnce({
            tag: "backend-error",
            category: "io",
            message: "write failed",
        });
        const { atom, store, unsubscribe } = mountDeck();
        await waitForReady(store, atom);

        const firstWrite = store.set(atom, {
            ...ratingMutation([first], source),
            entryId: "failed-rating",
        });
        const secondWrite = store.set(atom, {
            ...ratingMutation([second], first),
            entryId: "queued-rating",
        });
        await Promise.all([firstWrite, secondWrite]);

        expect(native.record).toHaveBeenCalledOnce();
        expect(persistError.report).toHaveBeenCalledTimes(2);
        expect(persistError.report.mock.calls[1][0].message).toContain("not saved");
        expect(store.get(atom).status).toBe("write-blocked");
        expect(store.get(atom).positions).toEqual([second]);
        unsubscribe();
    });

    test.each(identityRefreshes)(
        "retries a $name conflict by board identity with the same entry and base revision",
        async ({ raw, refreshed }) => {
            const source = position(raw);
            const changed = position(raw, { due: "2026-10-01T00:00:00.000Z", reps: 1 });
            const second = position(raw, { due: "2026-12-01T00:00:00.000Z", reps: 9 });
            native.load
                .mockResolvedValueOnce(snapshot([source], { revision: 4, generation: 2 }))
                .mockResolvedValueOnce(
                    snapshot([position(refreshed), second], { revision: 5, generation: 2 }),
                );
            native.record.mockRejectedValueOnce({
                tag: "backend-error",
                category: "conflict",
                message: "revision conflict",
            });
            native.record.mockResolvedValueOnce(6);
            const { atom, store, unsubscribe } = mountDeck();
            await waitForReady(store, atom);

            await store.set(atom, {
                ...ratingMutation([changed], source),
                positions: [changed],
            });

            expect(native.record).toHaveBeenCalledTimes(2);
            expect(native.record.mock.calls[0][3].baseRevision).toBe(4);
            expect(native.record.mock.calls[1][3].baseRevision).toBe(4);
            expect(native.record.mock.calls[0][3].entryId).toBe("entry-fixed");
            expect(native.record.mock.calls[1][3].entryId).toBe("entry-fixed");
            expect(JSON.parse(native.record.mock.calls[1][3].positionsDocument).positions).toEqual([
                { ...changed, fen: refreshed },
                second,
            ]);
            expect(JSON.parse(native.record.mock.calls[1][3].entry).fen).toBe(raw);
            expect(store.get(atom).status).toBe("ready");
            unsubscribe();
        },
    );

    test("branches on backendCategory rather than the renderer validation category", async () => {
        const source = position();
        const changed = position(firstFen, { due: "2026-10-01T00:00:00.000Z", reps: 1 });
        native.load
            .mockResolvedValueOnce(snapshot([source]))
            .mockResolvedValueOnce(snapshot([source], { revision: 5 }));
        native.record.mockRejectedValueOnce(
            Object.assign(new Error("conflict"), {
                category: "validation",
                backendCategory: "conflict",
            }),
        );
        native.record.mockResolvedValueOnce(6);
        const { atom, store, unsubscribe } = mountDeck();
        await waitForReady(store, atom);

        await store.set(atom, { ...ratingMutation([changed], source), positions: [changed] });

        expect(native.record).toHaveBeenCalledTimes(2);
        expect(persistError.report).not.toHaveBeenCalled();
        unsubscribe();
    });

    test("stops after the maximum conflict retries and blocks the deck", async () => {
        const source = position();
        const changed = position(firstFen, { due: "2026-10-01T00:00:00.000Z", reps: 1 });
        native.load.mockResolvedValue(snapshot([source]));
        native.record.mockRejectedValue({
            tag: "backend-error",
            category: "conflict",
            message: "revision conflict",
        });
        native.load.mockResolvedValue(snapshot([source], { revision: 5 }));
        const { atom, store, unsubscribe } = mountDeck();
        await waitForReady(store, atom);

        await store.set(atom, { ...ratingMutation([changed], source), positions: [changed] });

        expect(native.record).toHaveBeenCalledTimes(PRACTICE_MAX_CONFLICT_RETRIES + 1);
        expect(native.load).toHaveBeenCalledTimes(PRACTICE_MAX_CONFLICT_RETRIES + 1);
        expect(store.get(atom).status).toBe("write-blocked");
        expect(persistError.report).toHaveBeenCalledOnce();
        unsubscribe();
    });

    test("drops a hydration result that belongs to an unmounted request", async () => {
        let releaseFirst!: (value: ReturnType<typeof snapshot>) => void;
        native.load.mockImplementationOnce(
            () => new Promise((resolve) => (releaseFirst = resolve)),
        );
        native.load.mockResolvedValueOnce(snapshot([position(sameBoardDifferentFen)]));
        const first = mountDeck();
        await vi.waitFor(() => expect(native.load).toHaveBeenCalledOnce());
        first.unsubscribe();

        const second = mountDeck();
        await waitForReady(second.store, second.atom);
        releaseFirst(snapshot([position()]));
        await Promise.resolve();
        expect(second.store.get(second.atom).positions[0]?.fen).toBe(sameBoardDifferentFen);
        second.unsubscribe();
    });

    test("an older hydration rejection cannot block writes after retry succeeds", async () => {
        const older = deferred<ReturnType<typeof snapshot>>();
        native.load.mockImplementationOnce(() => older.promise);
        native.load.mockResolvedValueOnce(snapshot([position(sameBoardDifferentFen)]));
        const mounted = mountDeck();
        await vi.waitFor(() => expect(native.load).toHaveBeenCalledOnce());

        await mounted.store.set(mounted.atom, { type: "retry" });
        await waitForReady(mounted.store, mounted.atom);
        older.reject(new Error("superseded read failed"));
        await older.promise.catch(() => undefined);
        await Promise.resolve();

        vi.useFakeTimers();
        const write = mounted.store.set(mounted.atom, {
            type: "sync",
            positions: [position()],
        });
        await vi.advanceTimersByTimeAsync(PRACTICE_SYNC_DEBOUNCE_MS);
        await write;

        expect(native.sync).toHaveBeenCalledOnce();
        expect(mounted.store.get(mounted.atom).status).toBe("ready");
        mounted.unsubscribe();
    });

    test("an older hydration success cannot replace the committed state a retry loaded", async () => {
        const older = deferred<ReturnType<typeof snapshot>>();
        native.load.mockImplementationOnce(() => older.promise);
        native.load.mockResolvedValueOnce(snapshot([position()], { revision: 7 }));
        const mounted = mountDeck();
        await vi.waitFor(() => expect(native.load).toHaveBeenCalledOnce());

        await mounted.store.set(mounted.atom, { type: "retry" });
        await waitForReady(mounted.store, mounted.atom);
        older.resolve(snapshot([position()], { revision: 1 }));
        await older.promise;
        await Promise.resolve();

        vi.useFakeTimers();
        const write = mounted.store.set(mounted.atom, {
            type: "sync",
            positions: [position(sameBoardDifferentFen)],
        });
        await vi.advanceTimersByTimeAsync(PRACTICE_SYNC_DEBOUNCE_MS);
        await write;

        expect(native.sync.mock.calls[0]?.[3]).toBe(7);
        mounted.unsubscribe();
    });
});

describe("the eager legacy migration pass", () => {
    test("does not hold a damaged native identity over its retained legacy value", async () => {
        localStorage.setItem("deck-damaged-4", JSON.stringify(legacyData()));
        native.list.mockResolvedValue({
            decks: [{ fileId: "damaged", game: 4 }],
            anomalies: [
                {
                    kind: "DamagedDeck",
                    leaf: "damaged-positions.json",
                    fileId: "damaged",
                    game: 4,
                },
            ],
        });
        native.migrate.mockResolvedValue(migrationOutcome());

        await runPracticeMigrationPass();

        expect(native.migrate).toHaveBeenCalledWith(
            "damaged",
            4,
            JSON.stringify(legacyData()),
            "no-map",
        );
    });

    test("isolates a failed first deck and still migrates later decks", async () => {
        localStorage.setItem("deck-first-0", JSON.stringify(legacyData()));
        localStorage.setItem("deck-later-1", JSON.stringify(legacyData()));
        native.list.mockResolvedValue({ decks: [], anomalies: [] });
        native.migrate
            .mockRejectedValueOnce({
                tag: "backend-error",
                category: "invalid-input",
                message: "first deck failed",
            })
            .mockResolvedValueOnce(migrationOutcome());

        const result = await runPracticeMigrationPass();

        expect(native.migrate).toHaveBeenCalledTimes(2);
        expect(result.outcomes.map(({ status }) => status)).toEqual(["failed", "migrated"]);
        expect(localStorage.getItem("deck-first-0")).toBe(JSON.stringify(legacyData()));
        expect(persistError.report).toHaveBeenCalledOnce();
        const blocked = mountDeck("first", 0);
        await vi.waitFor(() => expect(blocked.store.get(blocked.atom).status).toBe("read-failed"));
        // Repair cannot change the legacy value the migration read, and nothing found native damage.
        expect(blocked.store.get(blocked.atom).repairable).toBe(false);
        await blocked.store.set(blocked.atom, { type: "sync", positions: [position()] });
        expect(native.sync).not.toHaveBeenCalled();
        blocked.unsubscribe();
    });

    test("parses the real createZodStorage JSON.stringify representation", async () => {
        createZodStorage(practiceDataSchema, localStorage).setItem(
            "deck-real-0",
            legacyData() as never,
        );
        native.list.mockResolvedValue({ decks: [], anomalies: [] });
        native.migrate.mockResolvedValue(migrationOutcome());

        await runPracticeMigrationPass();

        expect(native.migrate).toHaveBeenCalledWith(
            "real",
            0,
            JSON.stringify(legacyData()),
            "no-map",
        );
    });

    test("continues past malformed keys while retaining valid keys and distrusting the family", async () => {
        localStorage.setItem("deck-before-0", JSON.stringify(legacyData()));
        localStorage.setItem("deck-malformed", JSON.stringify(legacyData()));
        localStorage.setItem("deck-held-1", JSON.stringify(legacyData()));
        native.list.mockResolvedValue({
            decks: [{ fileId: "held", game: 1 }],
            anomalies: [],
        });
        native.migrate.mockResolvedValue(migrationOutcome());

        const result = await runPracticeMigrationPass();

        expect(native.migrate).toHaveBeenCalledWith(
            "before",
            0,
            JSON.stringify(legacyData()),
            "no-map",
        );
        expect(native.migrate).toHaveBeenCalledTimes(1);
        expect(result.outcomes).toEqual([
            expect.objectContaining({ identity: { file: "before", game: 0 }, status: "migrated" }),
            expect.objectContaining({
                identity: { file: "held", game: 1 },
                status: "alreadyMigrated",
            }),
        ]);
        expect(result.scanTrusted).toBe(false);
        expect(persistError.report).toHaveBeenCalledOnce();
    });

    test("fails closed when whole-storage enumeration throws", async () => {
        const originalLength = Object.getOwnPropertyDescriptor(Storage.prototype, "length");
        Object.defineProperty(Storage.prototype, "length", {
            configurable: true,
            get: () => {
                throw new Error("enumeration denied");
            },
        });
        native.list.mockResolvedValue({ decks: [], anomalies: [] });
        try {
            const result = await runPracticeMigrationPass();
            expect(result.scanTrusted).toBe(false);
            const mounted = mountDeck("unseen", 0);
            await vi.waitFor(() =>
                expect(mounted.store.get(mounted.atom).status).toBe("read-failed"),
            );
            await mounted.store.set(mounted.atom, { type: "sync", positions: [position()] });
            expect(native.sync).not.toHaveBeenCalled();
            mounted.unsubscribe();
        } finally {
            if (originalLength) Object.defineProperty(Storage.prototype, "length", originalLength);
        }
    });

    test("treats a migrated count mismatch as a failed, write-blocked deck", async () => {
        localStorage.setItem("deck-count-0", JSON.stringify(legacyData()));
        native.list.mockResolvedValue({ decks: [], anomalies: [] });
        native.migrate.mockResolvedValue(migrationOutcome({ entries: 2 }));

        const result = await runPracticeMigrationPass();

        expect(result.outcomes[0]?.status).toBe("failed");
        expect(localStorage.getItem("deck-count-0")).toBe(JSON.stringify(legacyData()));
        const mounted = mountDeck("count", 0);
        await vi.waitFor(() => expect(mounted.store.get(mounted.atom).status).toBe("read-failed"));
        mounted.unsubscribe();
    });

    test("does not count-compare an AlreadyMigrated outcome", async () => {
        localStorage.setItem("deck-already-0", JSON.stringify(legacyData()));
        native.list.mockResolvedValue({ decks: [], anomalies: [] });
        native.migrate.mockResolvedValue(
            migrationOutcome({ status: "alreadyMigrated", entries: 99, positions: 77 }),
        );

        const result = await runPracticeMigrationPass();

        expect(result.outcomes[0]).toEqual(
            expect.objectContaining({ status: "alreadyMigrated", entries: 99, positions: 77 }),
        );
        expect(persistError.report).not.toHaveBeenCalled();
    });

    test("rechecks and migrates a legacy key immediately before native creation", async () => {
        native.load
            .mockResolvedValueOnce({ epoch: "no-map", deck: null })
            .mockResolvedValueOnce(snapshot([position()], { revision: 9, generation: 2 }));
        native.list.mockResolvedValue({ decks: [], anomalies: [] });
        native.migrate.mockResolvedValue(migrationOutcome());
        const mounted = mountDeck("appeared", 0);
        await waitForReady(mounted.store, mounted.atom);
        localStorage.setItem("deck-appeared-0", JSON.stringify(legacyData()));
        vi.useFakeTimers();

        const write = mounted.store.set(mounted.atom, { type: "sync", positions: [position()] });
        await vi.advanceTimersByTimeAsync(PRACTICE_SYNC_DEBOUNCE_MS);
        await write;

        expect(native.migrate).toHaveBeenCalledWith(
            "appeared",
            0,
            JSON.stringify(legacyData()),
            "no-map",
        );
        expect(localStorage.getItem("deck-appeared-0")).toBeNull();
        expect(native.sync).toHaveBeenCalledOnce();
        expect(native.sync.mock.calls[0][2]).toBe(2);
        expect(native.sync.mock.calls[0][3]).toBe(9);
        mounted.unsubscribe();
    });

    test("retires the legacy key and syncs when inline inventory already contains the deck", async () => {
        native.load
            .mockResolvedValueOnce({ epoch: "no-map", deck: null })
            .mockResolvedValueOnce(snapshot([position()], { revision: 9, generation: 2 }));
        const mounted = mountDeck("held", 0);
        await waitForReady(mounted.store, mounted.atom);
        localStorage.setItem("deck-held-0", JSON.stringify(legacyData()));
        native.list.mockResolvedValue({
            decks: [{ fileId: "held", game: 0 }],
            anomalies: [],
        });
        vi.useFakeTimers();

        try {
            const write = mounted.store.set(mounted.atom, {
                type: "sync",
                positions: [position()],
            });
            await vi.advanceTimersByTimeAsync(PRACTICE_SYNC_DEBOUNCE_MS);
            await write;

            expect(native.migrate).not.toHaveBeenCalled();
            expect(localStorage.getItem("deck-held-0")).toBeNull();
            expect(native.sync).toHaveBeenCalledOnce();
        } finally {
            mounted.unsubscribe();
        }
    });

    test("syncs after successful inline migration when removing the legacy key fails", async () => {
        native.load
            .mockResolvedValueOnce({ epoch: "no-map", deck: null })
            .mockResolvedValueOnce(snapshot([position()], { revision: 9, generation: 2 }));
        native.migrate.mockResolvedValue(migrationOutcome());
        const mounted = mountDeck("appeared", 0);
        await waitForReady(mounted.store, mounted.atom);
        localStorage.setItem("deck-appeared-0", JSON.stringify(legacyData()));
        const error = new Error("removal denied");
        const originalRemoveItem = Storage.prototype.removeItem;
        const removeItem = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (
            this: Storage,
            key: string,
        ) {
            if (key === "deck-appeared-0") throw error;
            originalRemoveItem.call(this, key);
        });
        vi.useFakeTimers();

        try {
            const write = mounted.store.set(mounted.atom, {
                type: "sync",
                positions: [position()],
            });
            await vi.advanceTimersByTimeAsync(PRACTICE_SYNC_DEBOUNCE_MS);
            await write;

            expect(native.migrate).toHaveBeenCalledExactlyOnceWith(
                "appeared",
                0,
                JSON.stringify(legacyData()),
                "no-map",
            );
            expect(native.sync).toHaveBeenCalledOnce();
            expect(localStorage.getItem("deck-appeared-0")).toBe(JSON.stringify(legacyData()));
            expect(persistError.report).toHaveBeenCalledExactlyOnceWith(error);
        } finally {
            removeItem.mockRestore();
            mounted.unsubscribe();
        }
    });
});
