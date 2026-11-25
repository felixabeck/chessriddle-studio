import { createStore } from "jotai";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
    DatabaseDescriptor,
    DatabaseHandle,
    ErrorPayload,
    OpponentImportOutcome,
    OpponentImportRequest,
} from "@/bindings";

const mocks = vi.hoisted(() => ({
    importOpponentGames: vi.fn(),
    withDownloadTicket: vi.fn(),
    getDatabaseWorkspace: vi.fn(),
    listWorkspaceDatabases: vi.fn(),
    deleteDatabase: vi.fn(),
    cancelDownload: vi.fn(),
    forgetDeletedDatabase: vi.fn(),
    publishDatabaseList: vi.fn(),
    warn: vi.fn(),
}));

vi.mock("@/platform/tauri", async () => {
    const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
    return {
        ...actual,
        tauri: {
            ...actual.tauri,
            importOpponentGames: mocks.importOpponentGames,
            getDatabaseWorkspace: mocks.getDatabaseWorkspace,
            listWorkspaceDatabases: mocks.listWorkspaceDatabases,
            deleteDatabase: mocks.deleteDatabase,
            cancelDownload: mocks.cancelDownload,
        },
        withDownloadTicket: mocks.withDownloadTicket,
    };
});
vi.mock("@/platform/errors", async (original) => ({
    ...(await original<typeof import("@/platform/errors")>()),
    warnSafely: mocks.warn,
}));
vi.mock("@/hooks/useDatabaseList", async (original) => ({
    ...(await original<typeof import("@/hooks/useDatabaseList")>()),
    publishDatabaseList: mocks.publishDatabaseList,
}));
vi.mock("./forgetDeletedDatabase", () => ({
    forgetDeletedDatabase: mocks.forgetDeletedDatabase,
}));

import { opponentImportsAtom, opponentLinksAtom, sessionsAtom } from "@/state/atoms";
import { defaultOpponentFilter, type OpponentLink } from "@/state/opponentLinks";
import {
    cancelOpponentImport,
    importOpponentGames,
    isOpponentImportRunning,
    opponentAccountFailure,
    removeOpponentGames,
    runOpponentImport,
    unlinkOpponent,
} from "./opponentImport";

const ID = "11111111-1111-4111-8111-111111111111";
const OLD = `opponent-${ID}-00000001.db3`;
const LEFTOVER = `opponent-${ID}-00000002.db3`;
const root = { id: { id: "root" }, kind: "databaseRoot" } as const;
const account = { provider: "lichess", username: "DrNykterstein" } as const;

function handle(id: string): DatabaseHandle {
    return { id: { id }, kind: "database" };
}

function listed(filename: string): DatabaseDescriptor {
    return { handle: handle(filename), filename, availability: "available" };
}

function payload(overrides: Partial<ErrorPayload>): ErrorPayload {
    return { tag: "backend-error", category: "network", message: "failed", ...overrides };
}

function imported(games: number, merged = true): OpponentImportOutcome {
    return { kind: "imported", database: handle("new"), accounts: [{ account, games }], merged };
}

function setup(link: Partial<OpponentLink> = {}) {
    const store = createStore();
    const mutateCache = vi.fn();
    store.set(opponentLinksAtom, [
        {
            id: ID,
            playerName: "Carlsen, Magnus",
            accounts: [account],
            filter: defaultOpponentFilter(),
            ...link,
        },
    ]);
    return { store, mutateCache, deps: { store, mutateCache } };
}

function currentLink(store: ReturnType<typeof createStore>) {
    return store.get(opponentLinksAtom).find((link) => link.id === ID);
}

beforeEach(() => {
    localStorage.clear();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.withDownloadTicket.mockImplementation((run: (ticket: string) => Promise<unknown>) =>
        run("ticket-1"),
    );
    mocks.getDatabaseWorkspace.mockResolvedValue({ root, displayName: "Databases" });
    mocks.listWorkspaceDatabases.mockResolvedValue({ entries: [], unread: [] });
    mocks.deleteDatabase.mockResolvedValue(null);
    mocks.cancelDownload.mockResolvedValue(true);
    mocks.publishDatabaseList.mockResolvedValue(undefined);
});

describe("importOpponentGames", () => {
    const request: OpponentImportRequest = {
        root,
        filename: `opponent-${ID}-0a1b2c3d.db3`,
        title: "Carlsen, Magnus",
        accounts: [account],
        sinceUnixSeconds: 1_700_000_000,
        timeControls: ["blitz", "rapid"],
        lichessHandle: null,
    };

    test("announces the ticket before the import starts and passes the request with it", async () => {
        const outcome = imported(0);
        const order: string[] = [];
        mocks.importOpponentGames.mockImplementation(async () => {
            order.push("import");
            return outcome;
        });

        await expect(
            importOpponentGames(request, (ticket) => order.push(`ticket:${ticket}`)),
        ).resolves.toBe(outcome);

        expect(order).toEqual(["ticket:ticket-1", "import"]);
        expect(mocks.importOpponentGames).toHaveBeenCalledExactlyOnceWith(request, "ticket-1");
    });

    test("passes a failed import on unchanged", async () => {
        const failure = new Error("cancelled");
        mocks.importOpponentGames.mockRejectedValue(failure);

        await expect(importOpponentGames(request, () => {})).rejects.toBe(failure);
    });
});

describe("opponentAccountFailure", () => {
    test.each([
        [{ remoteHttpRejection: { status: 404, authorizationSent: false } }, "notFound"],
        [{ remoteHttpRejection: { status: 404, authorizationSent: true } }, "notFound"],
        [{ remoteHttpRejection: { status: 429, authorizationSent: true } }, "rateLimited"],
        [{ remoteHttpRejection: { status: 401, authorizationSent: true } }, "signIn"],
        [{ remoteHttpRejection: { status: 403, authorizationSent: true } }, "signIn"],
        [{ category: "authentication" as const }, "signIn"],
        [{ remoteHttpRejection: { status: 401, authorizationSent: false } }, "other"],
        [{ remoteHttpRejection: { status: 403, authorizationSent: false } }, "other"],
        [{ remoteHttpRejection: { status: 500, authorizationSent: true } }, "other"],
        [{ remoteHttpRejection: { status: 503, authorizationSent: true } }, "other"],
        [{ category: "invalid-input" as const }, "other"],
        [{}, "other"],
    ])("%j reads as %s", (overrides, reason) => {
        expect(opponentAccountFailure(payload(overrides))).toBe(reason);
    });
});

describe("runOpponentImport", () => {
    test("switches the link to the new database before the previous one is deleted", async () => {
        const { store, deps, mutateCache } = setup({ database: OLD });
        mocks.listWorkspaceDatabases.mockResolvedValue({
            entries: [listed(OLD), listed(LEFTOVER), listed("games.db3")],
            unread: [],
        });
        const order: string[] = [];
        mocks.deleteDatabase.mockImplementation(async (database: DatabaseHandle) => {
            order.push(`delete:${database.id.id}:${currentLink(store)?.database}`);
            return null;
        });
        mocks.publishDatabaseList.mockImplementation(async () => {
            order.push(`publish:${currentLink(store)?.database}`);
        });
        mocks.importOpponentGames.mockImplementation(async () => {
            order.push("import");
            return {
                kind: "imported",
                database: handle("new"),
                accounts: [
                    { account, games: 40 },
                    { account: { provider: "chesscom", username: "magnus" }, games: 2 },
                ],
                merged: false,
            } satisfies OpponentImportOutcome;
        });

        const result = await runOpponentImport(deps, ID, "Carlsen, Magnus (online)");

        const request = mocks.importOpponentGames.mock.calls[0][0] as OpponentImportRequest;
        expect(result).toEqual({ kind: "imported", games: 42, merged: false, leftovers: 0 });
        expect(request.filename).toMatch(new RegExp(`^opponent-${ID}-[0-9a-f]{8}\\.db3$`));
        expect(request.filename).not.toBe(OLD);
        expect(request).toMatchObject({
            root,
            title: "Carlsen, Magnus (online)",
            accounts: [account],
            timeControls: ["blitz", "rapid", "classical", "correspondence"],
            lichessHandle: null,
        });
        // The listing is published with the new database in place before the link names it, and
        // once more after the previous database is gone.
        expect(order).toEqual([
            `delete:${LEFTOVER}:${OLD}`,
            "import",
            `publish:${OLD}`,
            `delete:${OLD}:${request.filename}`,
            `publish:${request.filename}`,
        ]);
        expect(currentLink(store)?.database).toBe(request.filename);
        expect(mocks.forgetDeletedDatabase.mock.calls.map(([database]) => database.id.id)).toEqual([
            LEFTOVER,
            OLD,
        ]);
        expect(mocks.publishDatabaseList.mock.calls).toEqual([[mutateCache], [mutateCache]]);
    });

    test.each([
        ["no game matched", { ...imported(0), database: null }, { kind: "noGames", leftovers: 0 }],
        [
            "an account failed",
            {
                kind: "accountFailed",
                account,
                error: payload({ remoteHttpRejection: { status: 404, authorizationSent: false } }),
            },
            { kind: "accountFailed", account, reason: "notFound", leftovers: 0 },
        ],
    ] as const)(
        "keeps the previous database and the link when %s",
        async (_, outcome, expected) => {
            const { store, deps } = setup({ database: OLD });
            mocks.listWorkspaceDatabases.mockResolvedValue({ entries: [listed(OLD)], unread: [] });
            mocks.importOpponentGames.mockResolvedValue(outcome);

            await expect(runOpponentImport(deps, ID, "title")).resolves.toEqual(expected);

            expect(currentLink(store)?.database).toBe(OLD);
            expect(mocks.deleteDatabase).not.toHaveBeenCalled();
            // Only the refresh every ending gets; nothing waits for a listing here.
            expect(mocks.publishDatabaseList).toHaveBeenCalledExactlyOnceWith(deps.mutateCache);
        },
    );

    test("reports a failed and a cancelled import as such and keeps the previous database", async () => {
        const { store, deps } = setup({ database: OLD });
        mocks.listWorkspaceDatabases.mockResolvedValue({ entries: [listed(OLD)], unread: [] });
        const failure = payload({ category: "database", message: "disk I/O error" });
        mocks.importOpponentGames.mockRejectedValueOnce(failure);
        mocks.importOpponentGames.mockRejectedValueOnce(
            payload({ category: "cancellation", message: "Cancellation" }),
        );

        await expect(runOpponentImport(deps, ID, "title")).resolves.toEqual({
            kind: "failed",
            error: failure,
            leftovers: 0,
        });
        await expect(runOpponentImport(deps, ID, "title")).resolves.toEqual({
            kind: "cancelled",
            leftovers: 0,
        });

        expect(currentLink(store)?.database).toBe(OLD);
        expect(mocks.deleteDatabase).not.toHaveBeenCalled();
    });

    test("a leftover that cannot be deleted is counted and does not stop the run", async () => {
        const { deps } = setup();
        mocks.listWorkspaceDatabases.mockResolvedValue({ entries: [listed(LEFTOVER)], unread: [] });
        mocks.deleteDatabase.mockRejectedValue(payload({ category: "io", message: "busy" }));
        mocks.importOpponentGames.mockResolvedValue(imported(3));

        await expect(runOpponentImport(deps, ID, "title")).resolves.toEqual({
            kind: "imported",
            games: 3,
            merged: true,
            leftovers: 1,
        });
        expect(mocks.forgetDeletedDatabase).not.toHaveBeenCalled();
        // The cause goes to the log, sanitised; the user gets the count.
        expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
            "An opponent's online games could not be deleted: busy",
        );
    });

    test.each([
        [
            "no game matched",
            () => mocks.importOpponentGames.mockResolvedValue({ ...imported(0), database: null }),
            "noGames",
        ],
        [
            "an account failed",
            () =>
                mocks.importOpponentGames.mockResolvedValue({
                    kind: "accountFailed",
                    account,
                    error: payload({
                        remoteHttpRejection: { status: 429, authorizationSent: false },
                    }),
                }),
            "accountFailed",
        ],
        [
            "the import failed",
            () => mocks.importOpponentGames.mockRejectedValue(payload({ category: "database" })),
            "failed",
        ],
        [
            "the import was cancelled",
            () =>
                mocks.importOpponentGames.mockRejectedValue(
                    payload({ category: "cancellation", message: "Cancellation" }),
                ),
            "cancelled",
        ],
    ] as const)(
        "a leftover that cannot be deleted is still counted when %s",
        async (_, arrange, kind) => {
            const { deps } = setup();
            mocks.listWorkspaceDatabases.mockResolvedValue({
                entries: [listed(LEFTOVER)],
                unread: [],
            });
            mocks.deleteDatabase.mockRejectedValue(payload({ category: "io", message: "busy" }));
            arrange();

            const result = await runOpponentImport(deps, ID, "title");

            expect(result).toMatchObject({ kind, leftovers: 1 });
        },
    );

    test("previous games that cannot be deleted after an update are counted, and the link points at the new ones", async () => {
        const { store, deps } = setup({ database: OLD });
        mocks.listWorkspaceDatabases.mockResolvedValue({ entries: [listed(OLD)], unread: [] });
        mocks.deleteDatabase.mockRejectedValue(payload({ category: "io", message: "busy" }));
        mocks.importOpponentGames.mockResolvedValue(imported(5));

        const result = await runOpponentImport(deps, ID, "title");

        expect(result).toEqual({ kind: "imported", games: 5, merged: true, leftovers: 1 });
        expect(mocks.deleteDatabase.mock.calls.map(([database]) => database.id.id)).toEqual([OLD]);
        const request = mocks.importOpponentGames.mock.calls[0][0] as OpponentImportRequest;
        expect(currentLink(store)?.database).toBe(request.filename);
    });

    test("a deletion that reported its error only afterwards is no leftover", async () => {
        const { deps } = setup();
        mocks.listWorkspaceDatabases.mockResolvedValue({ entries: [listed(LEFTOVER)], unread: [] });
        mocks.deleteDatabase.mockRejectedValue(payload({ category: "durability" }));
        mocks.importOpponentGames.mockResolvedValue(imported(1));

        await expect(runOpponentImport(deps, ID, "title")).resolves.toMatchObject({ leftovers: 0 });
        expect(mocks.warn).not.toHaveBeenCalled();
    });

    test("the user's own Lichess login is passed on, the first one that has a handle", async () => {
        const { store, deps } = setup();
        const session = (username: string, handle?: string) => ({
            player: username,
            updatedAt: 1,
            lichess: {
                username,
                ...(handle ? { handle } : {}),
                account: { id: username, username, perfs: {} },
            },
        });
        // An account added without a login has no handle and is passed over.
        store.set(sessionsAtom, [
            session("public"),
            session("me", "lichess-handle-1"),
            session("other", "lichess-handle-2"),
        ] as never);
        mocks.importOpponentGames.mockResolvedValue(imported(1));

        await runOpponentImport(deps, ID, "title");

        expect(
            (mocks.importOpponentGames.mock.calls[0][0] as OpponentImportRequest).lichessHandle,
        ).toBe("lichess-handle-1");
    });

    test("a second start joins the running import, which is in flight under its ticket", async () => {
        const { store, deps } = setup();
        let finish: (outcome: OpponentImportOutcome) => void = () => {};
        mocks.importOpponentGames.mockReturnValue(
            new Promise<OpponentImportOutcome>((resolve) => {
                finish = resolve;
            }),
        );

        const first = runOpponentImport(deps, ID, "title");
        const second = runOpponentImport(deps, ID, "title");
        expect(second).toBe(first);
        expect(store.get(opponentImportsAtom).get(ID)).toBeNull();
        await vi.waitFor(() => expect(store.get(opponentImportsAtom).get(ID)).toBe("ticket-1"));

        await cancelOpponentImport(store, ID);
        expect(mocks.cancelDownload).toHaveBeenCalledExactlyOnceWith("ticket-1");

        finish(imported(1));
        await first;
        expect(mocks.importOpponentGames).toHaveBeenCalledTimes(1);
        expect(store.get(opponentImportsAtom).has(ID)).toBe(false);
    });

    test("the link names the new database only once the listing has been published", async () => {
        const { store, deps } = setup();
        mocks.importOpponentGames.mockResolvedValue(imported(2));
        let published: () => void = () => {};
        mocks.publishDatabaseList.mockReturnValueOnce(
            new Promise<void>((resolve) => {
                published = resolve;
            }),
        );
        let ended = false;
        const run = runOpponentImport(deps, ID, "title").then((result) => {
            ended = true;
            return result;
        });
        await vi.waitFor(() => expect(mocks.publishDatabaseList).toHaveBeenCalledOnce());
        await Promise.resolve();

        // The download is over: the run is still in flight, but its spent ticket is gone, so
        // nothing offers a cancel that could not work. The link waits for the listing.
        expect(currentLink(store)?.database).toBeUndefined();
        expect(store.get(opponentImportsAtom).get(ID)).toBeNull();
        await cancelOpponentImport(store, ID);
        expect(mocks.cancelDownload).not.toHaveBeenCalled();
        await expect(removeOpponentGames(deps, ID)).rejects.toThrow("opponent import is running");
        expect(ended).toBe(false);

        published();
        await expect(run).resolves.toMatchObject({ kind: "imported", games: 2 });
        const filename = (mocks.importOpponentGames.mock.calls[0][0] as OpponentImportRequest)
            .filename;
        expect(currentLink(store)?.database).toBe(filename);
        expect(store.get(opponentImportsAtom).has(ID)).toBe(false);
        // The run has left the registry: its games can be removed again.
        await expect(removeOpponentGames(deps, ID)).resolves.toBe(0);
    });

    test("a listing that cannot be read does not undo the download or hold the run", async () => {
        const { store, deps } = setup();
        mocks.importOpponentGames.mockResolvedValue(imported(2));
        mocks.publishDatabaseList.mockRejectedValue(new Error("listing failed"));

        await expect(runOpponentImport(deps, ID, "title")).resolves.toMatchObject({
            kind: "imported",
            games: 2,
        });

        const filename = (mocks.importOpponentGames.mock.calls[0][0] as OpponentImportRequest)
            .filename;
        expect(currentLink(store)?.database).toBe(filename);
        expect(store.get(opponentImportsAtom).has(ID)).toBe(false);
        // Both refreshes failed, the one before the link switched and the one at the end.
        await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalledTimes(2));
        for (const [message] of mocks.warn.mock.calls) {
            expect(message).toBe(
                "The database list could not be refreshed after an opponent's online games changed: listing failed",
            );
        }
        await expect(removeOpponentGames(deps, ID)).resolves.toBe(0);
    });

    test("an unknown link fails without asking for anything", async () => {
        const { deps } = setup();

        const result = await runOpponentImport(deps, "22222222-2222-4222-8222-222222222222", "t");

        expect(result.kind).toBe("failed");
        expect(mocks.importOpponentGames).not.toHaveBeenCalled();
    });

    test.each([
        [
            "success",
            (resolve: (o: OpponentImportOutcome) => void) => resolve(imported(1)),
            "imported",
        ],
        [
            "cancel",
            (_: (o: OpponentImportOutcome) => void, reject: (e: unknown) => void) =>
                reject(payload({ category: "cancellation", message: "Cancellation" })),
            "cancelled",
        ],
        [
            "failure",
            (_: (o: OpponentImportOutcome) => void, reject: (e: unknown) => void) =>
                reject(payload({ category: "database", message: "disk I/O error" })),
            "failed",
        ],
    ] as const)(
        "isOpponentImportRunning is false before, true while running, and false after %s",
        async (_, settle, expectedKind) => {
            const { deps } = setup();
            let resolveImport: (outcome: OpponentImportOutcome) => void = () => {};
            let rejectImport: (error: unknown) => void = () => {};
            mocks.importOpponentGames.mockReturnValue(
                new Promise<OpponentImportOutcome>((resolve, reject) => {
                    resolveImport = resolve;
                    rejectImport = reject;
                }),
            );

            expect(isOpponentImportRunning(ID)).toBe(false);
            const run = runOpponentImport(deps, ID, "title");
            expect(isOpponentImportRunning(ID)).toBe(true);
            expect(isOpponentImportRunning("22222222-2222-4222-8222-222222222222")).toBe(false);
            await vi.waitFor(() => expect(mocks.importOpponentGames).toHaveBeenCalledOnce());
            expect(isOpponentImportRunning(ID)).toBe(true);

            settle(resolveImport, rejectImport);
            await expect(run).resolves.toMatchObject({ kind: expectedKind });
            expect(isOpponentImportRunning(ID)).toBe(false);
        },
    );
});

describe("removing online games and unlinking", () => {
    test("neither is possible while the link's import is running", async () => {
        const { store, deps } = setup({ database: OLD });
        mocks.listWorkspaceDatabases.mockResolvedValue({ entries: [listed(OLD)], unread: [] });
        let finish: (outcome: OpponentImportOutcome) => void = () => {};
        mocks.importOpponentGames.mockReturnValue(
            new Promise<OpponentImportOutcome>((resolve) => {
                finish = resolve;
            }),
        );
        const run = runOpponentImport(deps, ID, "title");
        await vi.waitFor(() => expect(mocks.importOpponentGames).toHaveBeenCalledOnce());

        await expect(removeOpponentGames(deps, ID)).rejects.toThrow("opponent import is running");
        await expect(unlinkOpponent(deps, ID)).rejects.toThrow("opponent import is running");

        expect(mocks.deleteDatabase).not.toHaveBeenCalled();
        expect(currentLink(store)?.database).toBe(OLD);
        finish({ kind: "imported", database: null, accounts: [], merged: true });
        await run;
    });

    test("removing the games deletes every file of the link and keeps its accounts", async () => {
        const { store, deps, mutateCache } = setup({ database: OLD });
        mocks.listWorkspaceDatabases.mockResolvedValue({
            entries: [listed(OLD), listed(LEFTOVER), listed("games.db3")],
            unread: [],
        });

        await expect(removeOpponentGames(deps, ID)).resolves.toBe(0);

        expect(mocks.deleteDatabase.mock.calls.map(([database]) => database.id.id)).toEqual([
            OLD,
            LEFTOVER,
        ]);
        expect(currentLink(store)).toEqual({
            id: ID,
            playerName: "Carlsen, Magnus",
            accounts: [account],
            filter: defaultOpponentFilter(),
        });
        expect(mocks.forgetDeletedDatabase).toHaveBeenCalledTimes(2);
        expect(mocks.publishDatabaseList).toHaveBeenCalledExactlyOnceWith(mutateCache);
    });

    test("a listing that cannot be read after a removal is logged and fails nothing", async () => {
        const { store, deps } = setup({ database: OLD });
        mocks.listWorkspaceDatabases.mockResolvedValue({ entries: [listed(OLD)], unread: [] });
        mocks.publishDatabaseList.mockRejectedValue(new Error("listing failed"));

        await expect(removeOpponentGames(deps, ID)).resolves.toBe(0);

        expect(currentLink(store)?.database).toBeUndefined();
        await vi.waitFor(() =>
            expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
                "The database list could not be refreshed after an opponent's online games changed: listing failed",
            ),
        );
    });

    test("a failed deletion keeps the link as it was, for removal and for unlinking", async () => {
        const { store, deps } = setup({ database: OLD });
        mocks.listWorkspaceDatabases.mockResolvedValue({ entries: [listed(OLD)], unread: [] });
        const failure = payload({ category: "io", message: "busy" });
        mocks.deleteDatabase.mockRejectedValue(failure);

        await expect(removeOpponentGames(deps, ID)).rejects.toBe(failure);
        await expect(unlinkOpponent(deps, ID)).rejects.toBe(failure);

        expect(currentLink(store)?.database).toBe(OLD);
    });

    test("a deletion that applied despite its error counts as deleted", async () => {
        const { store, deps } = setup({ database: OLD });
        mocks.listWorkspaceDatabases.mockResolvedValue({ entries: [listed(OLD)], unread: [] });
        mocks.deleteDatabase.mockRejectedValue(payload({ category: "partial-removal" }));

        await expect(unlinkOpponent(deps, ID)).resolves.toBe(0);

        expect(currentLink(store)).toBeUndefined();
        expect(mocks.forgetDeletedDatabase).toHaveBeenCalledTimes(1);
    });

    test("unlinking removes the link, and a leftover it cannot delete does not keep it", async () => {
        const { store, deps } = setup({ database: OLD });
        mocks.listWorkspaceDatabases.mockResolvedValue({
            entries: [listed(OLD), listed(LEFTOVER)],
            unread: [],
        });
        mocks.deleteDatabase.mockImplementation(async (database: DatabaseHandle) => {
            if (database.id.id === LEFTOVER) throw payload({ category: "io", message: "busy" });
            return null;
        });

        await expect(unlinkOpponent(deps, ID)).resolves.toBe(1);

        expect(currentLink(store)).toBeUndefined();
    });

    test("a link without downloaded games is unlinked without deleting anything", async () => {
        const { store, deps } = setup();

        await expect(unlinkOpponent(deps, ID)).resolves.toBe(0);

        expect(mocks.deleteDatabase).not.toHaveBeenCalled();
        expect(currentLink(store)).toBeUndefined();
    });
});
