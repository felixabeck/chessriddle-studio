import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseHandle } from "@/bindings";
import { createStore } from "jotai";
import { databaseConversionStateAtom, runDatabaseConversion } from "@/state/atoms";
import { TauriCommandError } from "@/platform/tauri";
import { runUnlessCancelled } from "@/components/files/notifyError";
import { type Arguments, type ScopedMutator, type State, unstable_serialize } from "swr";
import {
    deleteDatabaseAndInvalidate,
    invalidateDeletedDatabase,
    runAddGamesToDatabase,
    runPgnExport,
    refreshDatabaseGameQueries,
    refreshAfterDatabaseConversion,
    saveDbGameHeaders,
    type DatabaseRemovalState,
} from "./databaseMutation";

const notify = vi.hoisted(() => vi.fn());
const logError = vi.hoisted(() => vi.fn());
const writeDbGameHeaders = vi.hoisted(() => vi.fn());
vi.mock("@mantine/notifications", () => ({ notifications: { show: notify } }));
vi.mock("@/platform/native", () => ({ error: logError }));
vi.mock("@/platform/tauri", async (original) => {
    const mod = await original<typeof import("@/platform/tauri")>();
    return {
        ...mod,
        tauri: {
            ...mod.tauri,
            writeDbGameHeaders,
        },
    };
});
vi.mock("@/i18n", async (original) => ({
    ...(await original<typeof import("@/i18n")>()),
    default: {
        t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    },
}));

const database = (id: string): DatabaseHandle => ({ id: { id }, kind: "database" });

describe("database conversion refresh outcome", () => {
    beforeEach(() => {
        notify.mockClear();
        logError.mockReset().mockResolvedValue(undefined);
    });

    it.each([false, true])(
        "returns the committed result after reload fails even when logger failure is %s",
        async (loggerFails) => {
            const result = database("committed");
            const refresh = vi
                .fn()
                .mockRejectedValue(new Error("reload denied at /private/db.db3"));
            const setRefreshFailed = vi.fn();
            const fallback = vi.spyOn(console, "error").mockImplementation(() => {});
            if (loggerFails)
                logError.mockRejectedValueOnce(new Error("logger denied at /private/log"));
            try {
                await expect(
                    refreshAfterDatabaseConversion(
                        async () => result,
                        refresh,
                        setRefreshFailed,
                        "Common.Error",
                    ),
                ).resolves.toBe(result);
                expect(refresh).toHaveBeenCalledOnce();
                expect(setRefreshFailed).toHaveBeenCalledExactlyOnceWith(true);
                expect(logError).toHaveBeenCalledExactlyOnceWith(
                    "Failed import database refresh failed: reload denied at [path]",
                );
                expect(notify).toHaveBeenCalledExactlyOnceWith({
                    color: "danger",
                    title: "Common.Error",
                    message: "reload denied at [path]",
                });
                expect(fallback.mock.calls).toEqual(
                    loggerFails
                        ? [
                              [
                                  "Import refresh logging failed",
                                  {
                                      operation: "failed import database refresh",
                                      primaryFailure: {
                                          category: "permission",
                                          message: "reload denied at [path]",
                                      },
                                      loggerFailure: {
                                          category: "permission",
                                          message: "logger denied at [path]",
                                      },
                                  },
                              ],
                          ]
                        : [],
                );
            } finally {
                fallback.mockRestore();
            }
        },
    );

    it("retains success and clears an earlier refresh failure after a successful reload", async () => {
        const result = database("committed");
        const setRefreshFailed = vi.fn();
        await expect(
            refreshAfterDatabaseConversion(
                async () => result,
                async () => undefined,
                setRefreshFailed,
                "Common.Error",
            ),
        ).resolves.toBe(result);
        expect(setRefreshFailed).toHaveBeenCalledExactlyOnceWith(false);
        expect(notify).not.toHaveBeenCalled();
        expect(logError).not.toHaveBeenCalled();
    });

    it("maps a post-success reload root failure to the existing database notification", async () => {
        const result = database("committed");
        await expect(
            refreshAfterDatabaseConversion(
                async () => result,
                async () => {
                    throw new TauriCommandError({
                        tag: "backend-error",
                        category: "io",
                        message: "missing database root at /private/databases",
                        rootFailure: "missing",
                    });
                },
                vi.fn(),
                "Common.Error",
            ),
        ).resolves.toBe(result);
        expect(notify).toHaveBeenCalledExactlyOnceWith({
            color: "danger",
            title: "Common.Error",
            message: "This database folder is no longer available. Choose another.",
        });
    });

    it.each(["convert failed", "Cancellation"])(
        "rethrows the exact %s cause and leaves primary notification ownership with the caller",
        async (message) => {
            const cause = new Error(message);
            const refreshCause = new Error("reload denied at /private/db.db3");
            const setRefreshFailed = vi.fn();
            const conversion = refreshAfterDatabaseConversion(
                async () => {
                    throw cause;
                },
                async () => {
                    throw refreshCause;
                },
                setRefreshFailed,
                "Common.Error",
            );
            await expect(conversion).rejects.toBe(cause);
            expect(notify).toHaveBeenCalledTimes(message === "Cancellation" ? 1 : 0);
            await runUnlessCancelled("Common.Error", () => conversion);
            expect(setRefreshFailed).toHaveBeenCalledExactlyOnceWith(true);
            expect(logError).toHaveBeenCalledExactlyOnceWith(
                "Failed import database refresh failed: reload denied at [path]",
            );
            expect(notify).toHaveBeenCalledExactlyOnceWith({
                color: "danger",
                title: "Common.Error",
                message: message === "Cancellation" ? "reload denied at [path]" : message,
            });
        },
    );
});

describe("database game query refresh", () => {
    it("observes original same-database view keys without mutating during collection", async () => {
        const file = database("selected");
        const keys: Arguments[] = [
            ["games", { ...file }, { page: 1 }],
            ["games", file, { page: 2 }],
            ["players", file, {}],
            ["tournaments", file, {}],
            ["games", database("other"), {}],
            ["players", database("other"), {}],
            ["tournaments", database("other"), {}],
            ["engines", file],
            "databases",
        ];
        const cache = new Map<string, State>();
        const matches: boolean[] = [];
        const mutate = vi.fn(
            async (
                key: Arguments | ((key: Arguments) => boolean),
                _data?: unknown,
                options?: { revalidate: boolean },
            ) => {
                if (typeof key === "function") {
                    for (const original of keys) matches.push(key(original));
                    return [];
                }
                if (options?.revalidate === false) {
                    cache.set(unstable_serialize(key), { data: undefined, error: undefined });
                    return undefined;
                }
                cache.set(unstable_serialize(key), { data: "refreshed" });
                return "refreshed";
            },
        );
        expect(await refreshDatabaseGameQueries(file, cache, mutate as ScopedMutator)).toEqual(
            Array.from({ length: 4 }, () => ({ status: "fulfilled", value: "refreshed" })),
        );
        expect(matches).toEqual(keys.map(() => false));
        expect(mutate.mock.calls.slice(1)).toEqual([
            ...keys.slice(0, 4).map((key) => [key, undefined, { revalidate: false }]),
            ...keys.slice(0, 4).map((key) => [key]),
        ]);
    });

    it("reads fetch errors from cache after revalidation and settles delayed siblings and direct exceptions", async () => {
        const file = database("selected");
        const keys = ["games", "players", "tournaments"].map((view) => [view, file] as const);
        const cache = new Map<string, State>();
        const fetchError = new Error("Games fetch refused");
        const directError = new Error("Players refresh refused");
        let completeRelated!: () => void;
        const related = new Promise<void>((resolve) => {
            completeRelated = resolve;
        });
        const mutate = vi.fn(
            (
                key: Arguments | ((key: Arguments) => boolean),
                _data?: unknown,
                options?: { revalidate: boolean },
            ) => {
                if (typeof key === "function") {
                    for (const original of keys) key(original);
                    return Promise.resolve([]);
                }
                if (options?.revalidate === false) {
                    cache.set(unstable_serialize(key), { data: undefined, error: undefined });
                    return Promise.resolve(undefined);
                }
                if (key === keys[0]) {
                    cache.set(unstable_serialize(key), { data: "old data", error: fetchError });
                    return Promise.resolve("old data");
                }
                if (key === keys[1]) throw directError;
                return related.then(() => {
                    cache.set(unstable_serialize(key), { data: "new data" });
                    return "new data";
                });
            },
        );
        let terminal = false;
        const operation = refreshDatabaseGameQueries(file, cache, mutate as ScopedMutator).then(
            (results) => {
                terminal = true;
                return results;
            },
        );
        await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(7));
        expect(terminal).toBe(false);
        completeRelated();
        expect(await operation).toEqual([
            { status: "rejected", reason: fetchError },
            { status: "rejected", reason: directError },
            { status: "fulfilled", value: "new data" },
        ]);
    });
});

describe("database deletion transaction", () => {
    it("keeps every renderer target intact when native deletion rejects", async () => {
        const deleted = database("delete-me");
        const invalidate = vi.fn();

        await expect(
            deleteDatabaseAndInvalidate(
                deleted,
                vi.fn().mockRejectedValue(new Error("native failed")),
                invalidate,
            ),
        ).rejects.toThrow("native failed");

        expect(invalidate).not.toHaveBeenCalled();
    });

    it("invalidates only after native deletion succeeds", async () => {
        const deleted = database("delete-me");
        const order: string[] = [];
        await deleteDatabaseAndInvalidate(
            deleted,
            async () => {
                order.push("native");
            },
            () => order.push("invalidate"),
        );
        expect(order).toEqual(["native", "invalidate"]);
    });

    it.each([
        {
            path: "structured backend-error",
            error: new TauriCommandError({
                tag: "backend-error",
                category: "partial-removal",
                message: "Partially removed: 1 entries were deleted before failing: conflict",
            }),
        },
        {
            path: "string fallback",
            // Fallback-path coverage: classify() still matches this owned Display literal.
            error: new Error("Partially removed: 1 entries were deleted before failing: conflict"),
        },
    ])(
        "invalidates after partial removal and preserves the rejection via the $path",
        async ({ error }) => {
            const deleted = database("delete-me");
            const invalidate = vi.fn();

            await expect(
                deleteDatabaseAndInvalidate(deleted, vi.fn().mockRejectedValue(error), invalidate),
            ).rejects.toBe(error);
            expect(invalidate).toHaveBeenCalledWith(deleted);
        },
    );

    it("clears stale selection, reference and opened view for the deleted handle only", () => {
        const deleted = database("delete-me");
        const retained = database("keep-me");
        const state: DatabaseRemovalState = {
            selected: "delete-me",
            reference: deleted,
            active: {
                type: "success",
                file: deleted,
                filename: "delete-me.db3",
                title: "Delete me",
                description: "",
                player_count: 0,
                event_count: 0,
                game_count: 0,
                storage_size: "0",
                indexed: false,
            },
        };
        expect(invalidateDeletedDatabase(deleted, state)).toEqual({
            selected: null,
            reference: null,
            active: undefined,
        });
        expect(
            invalidateDeletedDatabase(deleted, {
                ...state,
                selected: "keep-me",
                reference: retained,
                active: { ...state.active!, file: retained },
            }),
        ).toMatchObject({ selected: "keep-me", reference: retained });
    });
});

describe("PGN export picker", () => {
    const file = database("export-me");
    const destination = { handle: { id: { id: "pgn-out" }, kind: "fileWorkspace" as const } };

    beforeEach(() => {
        notify.mockClear();
    });

    it("exports to the issued destination and always clears loading", async () => {
        const setLoading = vi.fn();
        const exportToPgn = vi.fn().mockResolvedValue(undefined);
        await runPgnExport({
            issueDestination: async () => destination,
            exportToPgn,
            file,
            notifyTitle: "Common.Error",
            setLoading,
        });
        expect(exportToPgn).toHaveBeenCalledWith(file, destination.handle);
        expect(setLoading.mock.calls.map((call) => call[0])).toEqual([true, false]);
        expect(notify).not.toHaveBeenCalled();
    });

    it("stays silent on Cancellation and re-enables the button", async () => {
        const setLoading = vi.fn();
        const exportToPgn = vi.fn();
        await runPgnExport({
            issueDestination: async () => {
                throw new Error("Cancellation");
            },
            exportToPgn,
            file,
            notifyTitle: "Common.Error",
            setLoading,
        });
        expect(exportToPgn).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
        expect(setLoading.mock.calls.map((call) => call[0])).toEqual([true, false]);
    });

    it("notifies a real picker failure and re-enables the button", async () => {
        const setLoading = vi.fn();
        await runPgnExport({
            issueDestination: async () => {
                throw new Error("permission denied");
            },
            exportToPgn: vi.fn(),
            file,
            notifyTitle: "Common.Error",
            setLoading,
        });
        expect(notify).toHaveBeenCalledWith({
            color: "danger",
            title: "Common.Error",
            message: "permission denied",
        });
        expect(setLoading.mock.calls.map((call) => call[0])).toEqual([true, false]);
    });
});

describe("Add Games picker", () => {
    const dest = database("add-games");
    const handle = { id: { id: "pgn-in" }, kind: "fileWorkspace" as const };
    const selected = { handle, name: "games.pgn" };
    let store: ReturnType<typeof createStore>;
    type RunConversion = Parameters<typeof runAddGamesToDatabase>[0]["runConversion"];
    let runConversion: ReturnType<typeof vi.fn<RunConversion>>;

    beforeEach(() => {
        notify.mockClear();
        store = createStore();
        runConversion = vi.fn<RunConversion>((sourceFileName, convert) =>
            runDatabaseConversion(
                (update) => store.set(databaseConversionStateAtom, update),
                { targetDatabase: dest, targetDatabaseTitle: "Existing", sourceFileName },
                convert,
            ),
        );
    });

    it("converts the picked file and always finishes", async () => {
        const convertPgn = vi.fn(async (id: string) => {
            expect(id).toMatch(/^conversion:[0-9a-f-]{36}$/);
            expect(store.get(databaseConversionStateAtom)).toEqual([
                {
                    id,
                    targetDatabase: dest,
                    targetDatabaseTitle: "Existing",
                    sourceFileName: selected.name,
                    totalGames: 0,
                    elapsedSeconds: 0,
                },
            ]);
        });
        await runAddGamesToDatabase({
            pickPgnFile: async () => selected,
            convertPgn,
            dest,
            notifyTitle: "Common.Error",
            runConversion,
        });
        expect(convertPgn).toHaveBeenCalledWith(
            expect.stringMatching(/^conversion:[0-9a-f-]{36}$/),
            [handle],
            dest,
            null,
        );
        expect(runConversion).toHaveBeenCalledWith(selected.name, expect.any(Function));
        expect(store.get(databaseConversionStateAtom)).toEqual([]);
        expect(notify).not.toHaveBeenCalled();
    });

    it("stays silent on a cancelled pick", async () => {
        const convertPgn = vi.fn();
        await runAddGamesToDatabase({
            pickPgnFile: async () => null,
            convertPgn,
            dest,
            notifyTitle: "Common.Error",
            runConversion,
        });
        expect(convertPgn).not.toHaveBeenCalled();
        expect(runConversion).not.toHaveBeenCalled();
        expect(store.get(databaseConversionStateAtom)).toEqual([]);
        expect(notify).not.toHaveBeenCalled();
    });

    it("notifies a real picker failure", async () => {
        const convertPgn = vi.fn();
        await runAddGamesToDatabase({
            pickPgnFile: async () => {
                throw new Error("permission denied");
            },
            convertPgn,
            dest,
            notifyTitle: "Common.Error",
            runConversion,
        });
        expect(notify).toHaveBeenCalledWith({
            color: "danger",
            title: "Common.Error",
            message: "permission denied",
        });
        expect(convertPgn).not.toHaveBeenCalled();
        expect(runConversion).not.toHaveBeenCalled();
    });

    it("notifies convert failure and still finishes", async () => {
        await runAddGamesToDatabase({
            pickPgnFile: async () => selected,
            convertPgn: vi.fn().mockRejectedValue(new Error("convert failed")),
            dest,
            notifyTitle: "Common.Error",
            runConversion,
        });
        expect(runConversion).toHaveBeenCalledOnce();
        expect(store.get(databaseConversionStateAtom)).toEqual([]);
        expect(notify).toHaveBeenCalledWith({
            color: "danger",
            title: "Common.Error",
            message: "convert failed",
        });
    });

    it("a cancelled conversion removes its entry and stays silent", async () => {
        await runAddGamesToDatabase({
            pickPgnFile: async () => selected,
            convertPgn: vi.fn().mockRejectedValue(new Error("Cancellation")),
            dest,
            notifyTitle: "Common.Error",
            runConversion,
        });
        expect(runConversion).toHaveBeenCalledOnce();
        expect(store.get(databaseConversionStateAtom)).toEqual([]);
        expect(notify).not.toHaveBeenCalled();
    });

    it("removing an already absent operation preserves the registry object", async () => {
        let resolveConversion: (() => void) | undefined;
        const pending = runConversion(
            selected.name,
            () =>
                new Promise<void>((resolve) => {
                    resolveConversion = resolve;
                }),
        );
        expect(store.get(databaseConversionStateAtom)).toHaveLength(1);
        store.set(databaseConversionStateAtom, []);
        const previous = store.get(databaseConversionStateAtom);
        if (!resolveConversion) throw new Error("Conversion did not start");
        resolveConversion();
        await pending;
        expect(store.get(databaseConversionStateAtom)).toBe(previous);
    });
});

describe("saveDbGameHeaders", () => {
    const file = database("header-edit");
    const headers = {
        white: "Carlsen",
        black: "Caruana",
        event: "Candidates",
    };

    beforeEach(() => {
        notify.mockClear();
        writeDbGameHeaders.mockReset();
    });

    it("writes headers, invokes onSaved, refreshes queries and resolves with the new stamp", async () => {
        const order: string[] = [];
        writeDbGameHeaders.mockImplementation(async () => {
            order.push("write");
            return "new-stamp";
        });
        const keys: Arguments[] = [["games", file, { page: 1 }]];
        const cache = new Map<string, State>();
        const mutate = vi.fn(
            async (
                key: Arguments | ((key: Arguments) => boolean),
                _data?: unknown,
                options?: { revalidate: boolean },
            ) => {
                if (typeof key === "function") {
                    for (const original of keys) key(original);
                    return [];
                }
                if (options?.revalidate === false) {
                    order.push("invalidate");
                    cache.set(unstable_serialize(key), { data: undefined, error: undefined });
                    return undefined;
                }
                order.push("revalidate");
                cache.set(unstable_serialize(key), { data: "fresh" });
                return "fresh";
            },
        );

        const stamp = await saveDbGameHeaders({
            file,
            gameId: 42,
            headers,
            expectedStamp: "old-stamp",
            cache,
            mutate: mutate as ScopedMutator,
            refreshFailedTitle: "Databases.Game.SavedRefreshFailed",
            onSaved: (savedStamp) => order.push(`saved:${savedStamp}`),
        });

        expect(stamp).toBe("new-stamp");
        expect(writeDbGameHeaders).toHaveBeenCalledExactlyOnceWith(file, 42, headers, "old-stamp");
        expect(order).toEqual(["write", "saved:new-stamp", "invalidate", "revalidate"]);
        expect(notify).not.toHaveBeenCalled();
    });

    it("reports a refresh failure after a successful write and still resolves with the new stamp", async () => {
        writeDbGameHeaders.mockResolvedValueOnce("new-stamp");
        const keys: Arguments[] = [["games", file, { page: 1 }]];
        const cache = new Map<string, State>();
        const fetchError = new TauriCommandError({
            tag: "backend-error",
            category: "io",
            message: "missing database root at /private/databases",
            rootFailure: "missing",
        });
        const mutate = vi.fn(
            async (
                key: Arguments | ((key: Arguments) => boolean),
                _data?: unknown,
                options?: { revalidate: boolean },
            ) => {
                if (typeof key === "function") {
                    for (const original of keys) key(original);
                    return [];
                }
                if (options?.revalidate === false) {
                    cache.set(unstable_serialize(key), { data: undefined, error: undefined });
                    return undefined;
                }
                cache.set(unstable_serialize(key), { data: "stale", error: fetchError });
                return "stale";
            },
        );

        await expect(
            saveDbGameHeaders({
                file,
                gameId: 7,
                headers,
                expectedStamp: "old-stamp",
                cache,
                mutate: mutate as ScopedMutator,
                refreshFailedTitle: "Databases.Game.SavedRefreshFailed",
            }),
        ).resolves.toBe("new-stamp");

        expect(notify).toHaveBeenCalledExactlyOnceWith({
            color: "danger",
            title: "Databases.Game.SavedRefreshFailed",
            message: "This database folder is no longer available. Choose another.",
        });
    });

    it("reports a direct refresh exception after a successful write and still resolves", async () => {
        writeDbGameHeaders.mockResolvedValueOnce("new-stamp");
        const cache = new Map<string, State>();
        const mutate = vi.fn(async () => {
            throw new Error("cache traversal failed");
        });

        await expect(
            saveDbGameHeaders({
                file,
                gameId: 7,
                headers,
                expectedStamp: "old-stamp",
                cache,
                mutate: mutate as ScopedMutator,
                refreshFailedTitle: "Databases.Game.SavedRefreshFailed",
            }),
        ).resolves.toBe("new-stamp");

        expect(notify).toHaveBeenCalledExactlyOnceWith({
            color: "danger",
            title: "Databases.Game.SavedRefreshFailed",
            message: "cache traversal failed",
        });
    });

    it("rejects on a command error without calling onSaved or refreshing", async () => {
        const failure = new TauriCommandError({
            tag: "backend-error",
            category: "stale-game",
            message: "Game changed on disk",
        });
        writeDbGameHeaders.mockRejectedValueOnce(failure);
        const onSaved = vi.fn();
        const mutate = vi.fn();

        await expect(
            saveDbGameHeaders({
                file,
                gameId: 7,
                headers,
                expectedStamp: "old-stamp",
                cache: new Map<string, State>(),
                mutate: mutate as ScopedMutator,
                refreshFailedTitle: "Databases.Game.SavedRefreshFailed",
                onSaved,
            }),
        ).rejects.toBe(failure);

        expect(onSaved).not.toHaveBeenCalled();
        expect(mutate).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
    });
});
