import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseHandle, GameQuery } from "@/bindings";
import type { tauri } from "@/platform/tauri";
import type { LocalOptions } from "@/components/panels/database/DatabasePanel";
import i18n from "i18next";
import { supportedLocales } from "@/i18n";
import { decodeCompressedOrJson } from "@/state/store/debouncedStorage";
import { fetchDatabaseList } from "@/hooks/useDatabaseList";

const mocks = vi.hoisted(() => ({
    getDatabaseWorkspace: vi.fn(),
    listWorkspaceDatabases: vi.fn(),
    getDbInfo: vi.fn(),
    logError: vi.fn(),
    logWarn: vi.fn(),
    verifySignedBytes: vi.fn(),
    remoteGet: vi.fn(),
    searchPosition: vi.fn(),
    getPlayers: vi.fn(),
}));
vi.mock("@/platform/tauri", () => ({
    tauri: {
        getDatabaseWorkspace: mocks.getDatabaseWorkspace,
        listWorkspaceDatabases: mocks.listWorkspaceDatabases,
        getDbInfo: mocks.getDbInfo,
        verifySignedBytes: mocks.verifySignedBytes,
        searchPosition: mocks.searchPosition,
        getPlayers: mocks.getPlayers,
        linkedCollectionsSupported: vi.fn(async () => false),
        listLinkedCollections: vi.fn(async () => []),
    },
}));
vi.mock("@/platform/native", () => ({ error: mocks.logError, warn: mocks.logWarn }));
vi.mock("@/platform/http", () => ({ remoteHttp: { get: mocks.remoteGet } }));
import databaseCatalogDocument from "@/catalogs/databases.json?raw";
import databaseCatalogSignature from "@/catalogs/databases.json.minisig?raw";
import puzzleCatalogDocument from "@/catalogs/puzzles.json?raw";
import puzzleCatalogSignature from "@/catalogs/puzzles.json.minisig?raw";
import { CatalogVerificationError } from "@/utils/signedCatalog";
import {
    DATABASE_NOT_INITIALIZED,
    ELO_FILTER_MAX,
    databaseHandleFromKey,
    databaseHandleKey,
    getEffectiveLocalPlayer,
    defaultDatabaseProgressId,
    defaultPuzzleDatabaseProgressId,
    getDefaultDatabases,
    getDefaultPuzzleDatabases,
    getDatabases,
    manifestDatabaseInstallCard,
    manifestPuzzleDatabaseInstallCard,
    sameDatabaseHandle,
    searchPosition,
    query_players,
    type ManagedDatabaseInfo,
} from "./db";

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDatabaseWorkspace.mockResolvedValue({ id: { id: "root" }, kind: "databaseRoot" });
    mocks.logError.mockResolvedValue(undefined);
});

const handle = (id: string): DatabaseHandle => ({ id: { id }, kind: "database" });

it.each([undefined, "contains", "exact"] as const)(
    "forwards player nameMatch %s through the real wrapper",
    async (nameMatch) => {
        const response = { data: [{ id: 2, name: "a_b", elo: null }], count: 1 };
        mocks.getPlayers.mockResolvedValue(response);
        const signal = new AbortController().signal;
        const result = await query_players(
            handle("owner"),
            {
                name: "a_b",
                nameMatch,
                range: [1000, 2000],
                options: { sort: "id", direction: "asc", skipCount: false },
            },
            { signal },
        );
        expect(result).toBe(response);
        expect(mocks.getPlayers).toHaveBeenCalledExactlyOnceWith(
            handle("owner"),
            {
                name: "a_b",
                nameMatch,
                range: [1000, 2000],
                options: {
                    sort: "id",
                    direction: "asc",
                    skipCount: false,
                    page: undefined,
                    pageSize: undefined,
                },
            },
            { signal },
        );
    },
);

const database = (id: string, filename = `${id}.db3`): ManagedDatabaseInfo => ({
    type: "success",
    file: handle(id),
    filename,
    title: filename,
    description: "",
    player_count: 0,
    event_count: 0,
    game_count: 0,
    storage_size: "0",
    indexed: false,
});

describe("database capability UI mapping", () => {
    it.each(["upgrading", "busy"] as const)(
        "maps %s metadata to a transient row without logging",
        async (status) => {
            mocks.listWorkspaceDatabases.mockResolvedValue({
                entries: [
                    {
                        handle: handle("pending"),
                        filename: "pending.db3",
                        availability: "available",
                    },
                ],
                unread: [],
            });
            mocks.getDbInfo.mockResolvedValue({ status, filename: "pending.db3", title: null });
            expect((await getDatabases()).databases).toEqual([
                {
                    type: "error",
                    file: handle("pending"),
                    filename: "pending.db3",
                    indexed: false,
                    transient: status,
                    error:
                        status === "upgrading"
                            ? i18n.t("Databases.Upgrading.Description")
                            : i18n.t("Databases.Busy.Description"),
                },
            ]);
            expect(mocks.logError).not.toHaveBeenCalled();
        },
    );

    it("maps a databaseBusy command rejection through real normalization without logging", async () => {
        mocks.listWorkspaceDatabases.mockResolvedValue({
            entries: [{ handle: handle("busy"), filename: "busy.db3", availability: "available" }],
            unread: [],
        });
        mocks.getDbInfo.mockRejectedValueOnce({
            tag: "backend-error",
            category: "database",
            message: "database failure",
            databaseBusy: true,
        });
        expect((await getDatabases()).databases).toEqual([
            {
                type: "error",
                file: handle("busy"),
                filename: "busy.db3",
                indexed: false,
                transient: "busy",
                error: i18n.t("Databases.Busy.Description"),
            },
        ]);
        expect(mocks.logError).not.toHaveBeenCalled();
    });

    it("maps upgrade-failed metadata to a permanent upgrade error row", async () => {
        mocks.listWorkspaceDatabases.mockResolvedValue({
            entries: [
                { handle: handle("failed"), filename: "failed.db3", availability: "available" },
            ],
            unread: [],
        });
        mocks.getDbInfo.mockResolvedValue({
            status: "upgrade-failed",
            filename: "failed.db3",
            message: "Upgrade could not finish",
        });
        expect((await getDatabases()).databases).toEqual([
            {
                type: "error",
                file: handle("failed"),
                filename: "failed.db3",
                indexed: false,
                upgradeFailed: true,
                error: "Upgrade could not finish",
            },
        ]);
        expect(mocks.logError).not.toHaveBeenCalled();
    });

    it.each(supportedLocales)(
        "localizes transient metadata in the shipped %s catalogue without fallback",
        async (locale) => {
            const { default: catalogue } = await import(`../translation/${locale}.json`);
            const translator = i18n.createInstance();
            await translator.init({
                lng: locale,
                fallbackLng: false,
                resources: { [locale]: catalogue },
            });
            const t = vi.spyOn(i18n, "t").mockImplementation(translator.t);
            try {
                mocks.listWorkspaceDatabases.mockResolvedValue({
                    entries: [
                        {
                            handle: handle("pending"),
                            filename: "pending.db3",
                            availability: "available",
                        },
                    ],
                    unread: [],
                });
                for (const [status, key] of [
                    ["upgrading", "Databases.Upgrading.Description"],
                    ["busy", "Databases.Busy.Description"],
                ] as const) {
                    mocks.getDbInfo.mockResolvedValue({ status, filename: "pending.db3" });
                    const [row] = (await getDatabases()).databases;
                    expect(row.type === "error" && row.error).toBe(catalogue.translation[key]);
                    expect(catalogue.translation[key]).toBeTruthy();
                    expect(catalogue.translation[key]).not.toBe(key);
                }
            } finally {
                t.mockRestore();
            }
        },
    );

    it("hides trashed non-account databases, retains account errors, and reconciles only the removed reference owner", async () => {
        const controller = new AbortController();
        const load = () =>
            fetchDatabaseList({
                run: (request) => request(controller.signal),
                supersede: async () => {},
            });
        const { tauri: native } = await import("@/platform/tauri");
        const { getDefaultStore } = await import("jotai");
        const { fileWorkspaceAtom, referenceDbAtom } = await import("@/state/atoms");
        const store = getDefaultStore();
        const previousWorkspace = store.get(fileWorkspaceAtom);
        const previousReference = store.get(referenceDbAtom);
        const workspace = { id: { id: "phase2-library" }, kind: "fileWorkspace" as const };
        const collection: import("@/bindings").CollectionDescriptor = {
            id: "44444444-4444-4444-8444-444444444444",
            name: "Trashed games",
            file: workspace,
            database: handle("trashed-index"),
            account: null,
            status: "ready",
            generation: "1",
            omitted: 0,
            retiredDatabase: null,
            fetchSinceMs: null,
        };
        try {
            store.set(fileWorkspaceAtom, workspace);
            store.set(referenceDbAtom, collection.database);
            vi.mocked(native.linkedCollectionsSupported).mockResolvedValue(true);
            mocks.listWorkspaceDatabases.mockResolvedValue({ entries: [], unread: [] });
            mocks.getDbInfo.mockResolvedValue(database("index"));
            vi.mocked(native.listLinkedCollections).mockResolvedValue([collection]);
            expect((await load()).databases).toHaveLength(1);
            collection.status = "trashed";
            expect((await load()).databases).toEqual([]);
            expect(store.get(referenceDbAtom)).toEqual(collection.database);
            collection.status = "ready";
            expect((await load()).databases).toHaveLength(1);
            expect(store.get(referenceDbAtom)).toEqual(collection.database);
            collection.status = "trashed";
            collection.account = { provider: "lichess", account: "player" };
            expect((await load()).databases).toMatchObject([
                { type: "error", collection: { status: "trashed" } },
            ]);
            let finishOlder!: (value: import("@/bindings").CollectionDescriptor[]) => void;
            const older = new Promise<import("@/bindings").CollectionDescriptor[]>((resolve) => {
                finishOlder = resolve;
            });
            const calls = vi.mocked(native.listLinkedCollections).mock.calls.length;
            vi.mocked(native.listLinkedCollections).mockReturnValueOnce(older);
            const olderListing = load();
            await vi.waitFor(() =>
                expect(native.listLinkedCollections).toHaveBeenCalledTimes(calls + 1),
            );
            await load();
            finishOlder([]);
            await olderListing;
            expect(store.get(referenceDbAtom)).toEqual(collection.database);
            vi.mocked(native.listLinkedCollections).mockResolvedValue([]);
            await getDatabases();
            expect(store.get(referenceDbAtom)).toEqual(collection.database);
            await load();
            expect(store.get(referenceDbAtom)).toBeNull();
            vi.mocked(native.listLinkedCollections).mockResolvedValue([collection]);
            store.set(referenceDbAtom, collection.database);
            await load();
            store.set(referenceDbAtom, handle("other-reference"));
            vi.mocked(native.listLinkedCollections).mockResolvedValue([]);
            await load();
            expect(store.get(referenceDbAtom)).toEqual(handle("other-reference"));
        } finally {
            store.set(fileWorkspaceAtom, previousWorkspace);
            store.set(referenceDbAtom, previousReference);
            vi.mocked(native.linkedCollectionsSupported).mockResolvedValue(false);
            vi.mocked(native.listLinkedCollections).mockResolvedValue([]);
        }
    });
    it("startup resolves the selected Library root and suppresses retired independent copies without duplicating linked caches", async () => {
        const { tauri: native } = await import("@/platform/tauri");
        const { getDefaultStore } = await import("jotai");
        const { fileWorkspaceAtom } = await import("@/state/atoms");
        const store = getDefaultStore();
        const previous = store.get(fileWorkspaceAtom);
        const workspace = { id: { id: "selected-library" }, kind: "fileWorkspace" as const };
        const collection = {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Owned games",
            file: workspace,
            database: handle("derived"),
            account: null,
            status: "ready" as const,
            generation: "current",
            omitted: 0,
            retiredDatabase: handle("retired"),
            fetchSinceMs: null,
        };
        try {
            store.set(fileWorkspaceAtom, workspace);
            vi.mocked(native.linkedCollectionsSupported).mockResolvedValue(true);
            vi.mocked(native.listLinkedCollections).mockResolvedValue([collection]);
            mocks.listWorkspaceDatabases.mockResolvedValue({
                entries: [
                    { handle: handle("retired"), filename: "old.db3", availability: "available" },
                    {
                        handle: handle("reference"),
                        filename: "reference.db3",
                        availability: "available",
                    },
                ],
                unread: [],
            });
            mocks.getDbInfo.mockImplementation(async (file: DatabaseHandle) =>
                database(file.id.id),
            );
            const current = await getDatabases();
            expect(native.listLinkedCollections).toHaveBeenCalledWith(workspace, {});
            expect(current.databases.map((item) => item.file.id.id)).toEqual([
                "reference",
                "derived",
            ]);
            expect(current.databases[1].collection).toEqual(collection);
            expect(mocks.getDbInfo).not.toHaveBeenCalledWith(handle("retired"), expect.anything());
            vi.mocked(native.listLinkedCollections).mockResolvedValue([
                { ...collection, status: "missing" },
            ]);
            expect((await getDatabases()).databases[1]).toMatchObject({
                type: "error",
                collection: { status: "missing" },
                indexed: false,
            });
        } finally {
            store.set(fileWorkspaceAtom, previous);
            vi.mocked(native.linkedCollectionsSupported).mockResolvedValue(false);
            vi.mocked(native.listLinkedCollections).mockResolvedValue([]);
        }
    });
    it("projects a handle to a stable widget key without treating it as a path", () => {
        expect(databaseHandleKey(handle("database-opaque-id"))).toBe("database-opaque-id");
    });

    it("restores a select key only from the current native database descriptors", () => {
        const databases = [database("first"), database("second")];
        expect(databaseHandleFromKey(databases, "second")).toEqual(handle("second"));
        expect(databaseHandleFromKey(databases, "revoked")).toBeNull();
    });

    it("compares separately deserialized handles by opaque identity", () => {
        expect(sameDatabaseHandle(handle("same"), handle("same"))).toBe(true);
        expect(sameDatabaseHandle(handle("first"), handle("second"))).toBe(false);
        expect(sameDatabaseHandle(handle("first"), null)).toBe(false);
    });
});

describe("production database metadata pipeline", () => {
    it.each([
        ["permission", "Databases.LoadError.Permission"],
        ["missing-resource", "Databases.LoadError.Missing"],
        ["invalid-input", "Databases.LoadError.Title"],
        ["io", "Databases.LoadError.Title"],
    ])("maps an unread %s child to %s without metadata hydration", async (category, key) => {
        mocks.listWorkspaceDatabases.mockResolvedValue({
            entries: [],
            unread: [{ filename: "unread.db3", category }],
        });
        expect((await getDatabases()).unread).toEqual([
            { filename: "unread.db3", error: i18n.t(key) },
        ]);
        expect(mocks.getDbInfo).not.toHaveBeenCalled();
    });

    it("returns unread children and the original root without reading their database info", async () => {
        const root = { id: { id: "unread-root" }, kind: "databaseRoot" };
        mocks.getDatabaseWorkspace.mockResolvedValue(root);
        mocks.listWorkspaceDatabases.mockResolvedValue({
            entries: [
                { handle: handle("healthy"), filename: "healthy.db3", availability: "available" },
            ],
            unread: [
                { filename: "�.db3", category: "permission" },
                { filename: "�.db3", category: "permission" },
            ],
        });
        mocks.getDbInfo.mockResolvedValue(database("healthy"));
        const result = await getDatabases();
        expect(result.root).toBe(root);
        expect(result.databases).toHaveLength(1);
        expect(result.unread).toEqual([
            { filename: "�.db3", error: i18n.t("Databases.LoadError.Permission") },
            { filename: "�.db3", error: i18n.t("Databases.LoadError.Permission") },
        ]);
        expect(mocks.getDbInfo).toHaveBeenCalledExactlyOnceWith(handle("healthy"));
        expect(
            result.unread.every(
                (item) => !("file" in item) && !("key" in item) && !("path" in item),
            ),
        ).toBe(true);
    });
    it("persists and rehydrates exact native decimal metadata through the compressed envelope", async () => {
        const metadata: Awaited<ReturnType<typeof tauri.getDbInfo>> = {
            status: "ready",
            filename: "exact.db3",
            title: "Exact byte count",
            description: "",
            player_count: 1,
            event_count: 2,
            game_count: 3,
            storage_size: "9007199254740993",
            indexed: false,
        };
        mocks.listWorkspaceDatabases.mockResolvedValue({
            entries: [
                { handle: handle("exact"), filename: metadata.filename, availability: "available" },
            ],
            unread: [],
        });
        mocks.getDbInfo.mockResolvedValue(metadata);
        const [managed] = (await getDatabases()).databases;
        const { status: _status, ...readyInfo } = metadata;
        expect(managed).toEqual({ ...readyInfo, type: "success", file: handle("exact") });
        if (managed?.type !== "success") throw new Error("expected successful managed metadata");

        const { activeDatabaseViewStore: store } = await import("@/state/store/database");
        try {
            store.getState().setDatabase(managed);
            const raw = sessionStorage.getItem("database-view");
            expect(raw).not.toBeNull();
            const stored = decodeCompressedOrJson(raw) as {
                version: number;
                state: { database: typeof managed };
            };
            expect(stored.version).toBe(0);
            expect(stored.state.database).toEqual(managed);
            expect(stored.state.database.storage_size).toBe("9007199254740993");

            vi.resetModules();
            const { activeDatabaseViewStore: rehydrated } = await import("@/state/store/database");
            expect(rehydrated.persist.hasHydrated()).toBe(true);
            expect(rehydrated.getState().database).toEqual(managed);
            expect(rehydrated.getState().database?.storage_size).toBe("9007199254740993");
            rehydrated.getState().clearDatabase();
        } finally {
            store.getState().clearDatabase();
            sessionStorage.removeItem("database-view");
        }
    });

    it("hydrates more than 128 entries sequentially as successful managed databases", async () => {
        const descriptors = Array.from({ length: 130 }, (_, index) => ({
            handle: handle(`db-${index}`),
            filename: `db-${index}.db3`,
            availability: "available" as const,
        }));
        mocks.listWorkspaceDatabases.mockResolvedValue({ entries: descriptors, unread: [] });
        let active = 0;
        let maximumActive = 0;
        mocks.getDbInfo.mockImplementation(async (file: DatabaseHandle) => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await Promise.resolve();
            active -= 1;
            const id = file.id.id;
            return {
                title: id,
                description: "",
                player_count: 0,
                event_count: 0,
                game_count: 0,
                storage_size: "0",
                indexed: false,
            };
        });

        const { databases: result } = await getDatabases();
        expect(result).toHaveLength(130);
        expect(result.every((item) => item.type === "success")).toBe(true);
        expect(result.map((item) => item.file.id.id)).toEqual(
            descriptors.map((item) => item.handle.id.id),
        );
        expect(maximumActive).toBe(1);
    });

    it("returns a renderer-safe error entry while retaining successful siblings", async () => {
        const descriptors = ["one", "failed", "three"].map((id) => ({
            handle: handle(id),
            filename: `${id}.db3`,
            availability: "available" as const,
        }));
        mocks.listWorkspaceDatabases.mockResolvedValue({ entries: descriptors, unread: [] });
        mocks.getDbInfo.mockImplementation(async (file: DatabaseHandle) => {
            if (file.id.id === "failed")
                throw new Error("metadata unavailable at /private/database.db3");
            return {
                title: file.id.id,
                description: "",
                player_count: 0,
                event_count: 0,
                game_count: 0,
                storage_size: "0",
                indexed: false,
            };
        });

        const { databases: result } = await getDatabases();
        expect(result.map((item) => item.file.id.id)).toEqual(["one", "failed", "three"]);
        expect(result.map((item) => item.type)).toEqual(["success", "error", "success"]);
        expect(result[1]).toEqual({
            type: "error",
            file: handle("failed"),
            filename: "failed.db3",
            indexed: false,
            error: i18n.t("Databases.LoadError.Title"),
        });
        expect(mocks.logError).toHaveBeenCalledExactlyOnceWith(
            "getDatabases metadata item 1 (failed.db3) failed: metadata unavailable at [path]",
        );
    });

    it.each(
        supportedLocales.flatMap((locale) =>
            [
                {
                    category: "conflict",
                    message: "Conflict: database is open through another name",
                    databaseAdmission: true,
                    key: "Databases.LoadError.Admission",
                },
                {
                    category: "conflict",
                    message: "Conflict: database is open through another name",
                    key: "Databases.LoadError.Title",
                },
                {
                    category: "invalid-input",
                    message:
                        "Invalid input: could not open SQLite database: unable to open database file",
                    key: "Databases.LoadError.Title",
                },
                {
                    category: "permission",
                    message: "Permission denied: cannot read /private/database.db3",
                    key: "Databases.LoadError.Permission",
                },
                {
                    category: "missing-resource",
                    message: "Missing resource: /private/database.db3 no longer exists",
                    key: "Databases.LoadError.Missing",
                },
            ].map((failure) => ({ locale, ...failure })),
        ),
    )(
        "uses fixed safe text for $category in the shipped $locale catalogue without fallback",
        async ({ locale, category, message, key, databaseAdmission }) => {
            const { default: catalogue } = await import(`../translation/${locale}.json`);
            const translator = i18n.createInstance();
            await translator.init({
                lng: locale,
                fallbackLng: false,
                resources: { [locale]: catalogue },
            });
            const t = vi.spyOn(i18n, "t").mockImplementation(translator.t);
            mocks.listWorkspaceDatabases.mockResolvedValue({
                entries: [
                    {
                        handle: handle("unreadable"),
                        filename: "unreadable.db3",
                        availability: "available",
                    },
                ],
                unread: [],
            });
            mocks.getDbInfo.mockRejectedValueOnce({
                tag: "backend-error",
                category,
                message,
                ...(databaseAdmission === true ? { databaseAdmission: true } : {}),
            });

            const { databases: result } = await getDatabases();
            expect(result).toEqual([
                {
                    type: "error",
                    file: handle("unreadable"),
                    filename: "unreadable.db3",
                    indexed: false,
                    error: catalogue.translation[key],
                    ...(databaseAdmission === true ? { databaseAdmission: true } : {}),
                },
            ]);
            expect(JSON.stringify(result)).not.toContain(message);
            expect(JSON.stringify(result)).not.toContain("/private/database.db3");
            expect(result[0].type === "error" && result[0].error).not.toBe(key);
            expect(catalogue.translation[key]).toBeTruthy();
            expect(mocks.logError).toHaveBeenCalledExactlyOnceWith(
                `getDatabases metadata item 0 (unreadable.db3) failed: ${message.replace("/private/database.db3", "[path]")}`,
            );
            t.mockRestore();
        },
    );

    it.each(supportedLocales)(
        "localizes an unfinished import in the shipped %s catalogue without fallback",
        async (locale) => {
            expect(DATABASE_NOT_INITIALIZED).toBe(
                "Invalid input: Database has not been initialized yet",
            );
            const { default: catalogue } = await import(`../translation/${locale}.json`);
            const translator = i18n.createInstance();
            await translator.init({
                lng: locale,
                fallbackLng: false,
                resources: { [locale]: catalogue },
            });
            const t = vi.spyOn(i18n, "t").mockImplementation(translator.t);
            mocks.listWorkspaceDatabases.mockResolvedValue({
                entries: [
                    {
                        handle: handle("unfinished"),
                        filename: "unfinished.db3",
                        availability: "available",
                    },
                ],
                unread: [],
            });
            mocks.getDbInfo.mockRejectedValueOnce({
                tag: "backend-error",
                category: "invalid-input",
                message: "Invalid input: Database has not been initialized yet",
            });
            const { databases: result } = await getDatabases();
            expect(result).toEqual([
                {
                    type: "error",
                    file: handle("unfinished"),
                    filename: "unfinished.db3",
                    indexed: false,
                    error: catalogue.translation["Databases.ImportUnfinished"],
                },
            ]);
            expect(result[0].type === "error" && result[0].error).not.toBe(
                "Databases.ImportUnfinished",
            );
            expect(catalogue.translation["Databases.ImportUnfinished"]).toBeTruthy();
            expect(JSON.stringify(result)).not.toContain(
                "Invalid input: Database has not been initialized yet",
            );
            t.mockRestore();
        },
    );

    it("propagates a metadata cancellation without returning an error card or logging", async () => {
        mocks.listWorkspaceDatabases.mockResolvedValue({
            entries: ["one", "two"].map((id) => ({
                handle: handle(id),
                filename: `${id}.db3`,
                availability: "available",
            })),
            unread: [],
        });
        const cancellation = {
            tag: "backend-error",
            category: "cancellation",
            message: "Cancellation",
        };
        mocks.getDbInfo.mockRejectedValueOnce(cancellation);
        await expect(getDatabases()).rejects.toBe(cancellation);
        expect(mocks.getDbInfo).toHaveBeenCalledOnce();
        expect(mocks.logError).not.toHaveBeenCalled();
    });

    it("keeps an error entry when diagnostic logging rejects and sanitizes its fallback", async () => {
        mocks.listWorkspaceDatabases.mockResolvedValue({
            entries: [
                { handle: handle("broken"), filename: "broken.db3", availability: "available" },
            ],
            unread: [],
        });
        mocks.getDbInfo.mockRejectedValueOnce(new Error("unreadable /private/database.db3"));
        mocks.logError.mockRejectedValueOnce(new Error("logger failed /private/log.txt"));
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        expect((await getDatabases()).databases).toEqual([
            {
                type: "error",
                file: handle("broken"),
                filename: "broken.db3",
                indexed: false,
                error: i18n.t("Databases.LoadError.Title"),
            },
        ]);
        expect(consoleError).toHaveBeenCalledExactlyOnceWith("Database metadata logging failed", {
            operation: "getDatabases metadata",
            itemIndex: 0,
            filename: "broken.db3",
            primaryFailure: { category: "unexpected", message: "unreadable [path]" },
            loggerFailure: { category: "unexpected", message: "logger failed [path]" },
        });
        consoleError.mockRestore();
    });

    it("owner cancellation during rejected metadata propagates without diagnostics", async () => {
        const controller = new AbortController();
        mocks.listWorkspaceDatabases.mockResolvedValue({
            entries: [{ handle: handle("one"), filename: "one.db3", availability: "available" }],
            unread: [],
        });
        mocks.getDbInfo.mockImplementationOnce(async () => {
            controller.abort();
            throw new Error("metadata unavailable");
        });
        await expect(getDatabases({ signal: controller.signal })).rejects.toMatchObject({
            name: "AbortError",
        });
        expect(mocks.logError).not.toHaveBeenCalled();
    });

    it("owner cancellation between metadata entries rejects without partial publication", async () => {
        const controller = new AbortController();
        const descriptors = ["one", "two", "three"].map((id) => ({
            handle: handle(id),
            filename: `${id}.db3`,
            availability: "available" as const,
        }));
        mocks.listWorkspaceDatabases.mockResolvedValue({ entries: descriptors, unread: [] });
        let resolveFirst!: (value: object) => void;
        mocks.getDbInfo.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveFirst = resolve;
            }),
        );
        const result = getDatabases({ signal: controller.signal });
        await vi.waitFor(() => expect(mocks.getDbInfo).toHaveBeenCalledOnce());
        resolveFirst({
            title: "one",
            description: "",
            player_count: 0,
            event_count: 0,
            game_count: 0,
            storage_size: "0",
            indexed: false,
        });
        controller.abort();
        await expect(result).rejects.toMatchObject({ name: "AbortError" });
        expect(mocks.getDbInfo).toHaveBeenCalledOnce();
        expect(mocks.logError).not.toHaveBeenCalled();
    });

    it("cancellation immediately after final metadata resolution rejects without diagnostics", async () => {
        const controller = new AbortController();
        mocks.listWorkspaceDatabases.mockResolvedValue({
            entries: [{ handle: handle("only"), filename: "only.db3", availability: "available" }],
            unread: [],
        });
        let resolveMetadata!: (value: object) => void;
        mocks.getDbInfo.mockReturnValue(
            new Promise((resolve) => {
                resolveMetadata = resolve;
            }),
        );
        const result = getDatabases({ signal: controller.signal });
        await vi.waitFor(() => expect(mocks.getDbInfo).toHaveBeenCalledOnce());
        resolveMetadata({
            title: "only",
            description: "",
            player_count: 0,
            event_count: 0,
            game_count: 0,
            storage_size: "0",
            indexed: false,
        });
        controller.abort();
        await expect(result).rejects.toMatchObject({ name: "AbortError" });
        expect(mocks.logError).not.toHaveBeenCalled();
    });
});

const puzzleManifestEntry = {
    title: "Lichess puzzles",
    description: "A curated puzzle database",
    puzzleCount: 1_000,
    storageSize: 2_048,
    downloadLink: "https://db.encroissant.org/puzzles/lichess.db3",
    sha256: "a".repeat(64),
    signature: "untrusted comment: test signature",
};

describe("manifest install-card identity", () => {
    const link = "https://db.encroissant.org/example.db3";
    const otherLink = "https://db.encroissant.org/other.db3";

    it("keys game-database progress by download URL, not array index or title", () => {
        const installed = [{ type: "success", title: "Lichess" }];
        const card = manifestDatabaseInstallCard(installed, {
            downloadLink: link,
            title: "Lichess",
        });
        expect(card).toEqual({
            progressId: defaultDatabaseProgressId(link),
            initInstalled: true,
        });
        expect(card.progressId).not.toBe("db_0");
        expect(card.progressId).toBe(`db:${link}`);
        expect(
            manifestDatabaseInstallCard(installed, { downloadLink: otherLink, title: "Other" })
                .initInstalled,
        ).toBe(false);
    });

    it("keys puzzle-database progress by download URL, not array index", () => {
        const card = manifestPuzzleDatabaseInstallCard([{ title: "Lichess.db3" }], {
            downloadLink: puzzleManifestEntry.downloadLink,
            title: "Lichess puzzles",
        });
        expect(card.progressId).toBe(
            defaultPuzzleDatabaseProgressId(puzzleManifestEntry.downloadLink),
        );
        expect(card.progressId).not.toBe("puzzle_db_0");
        expect(card.initInstalled).toBe(false);
        expect(
            manifestPuzzleDatabaseInstallCard([{ title: "Lichess puzzles.db3" }], {
                downloadLink: puzzleManifestEntry.downloadLink,
                title: "Lichess puzzles",
            }).initInstalled,
        ).toBe(true);
    });
});

describe("bundled default catalogs", () => {
    beforeEach(() => {
        mocks.verifySignedBytes.mockReset();
        mocks.remoteGet.mockReset();
        vi.stubGlobal("fetch", vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    it("verifies the exact bundled database catalog bytes without any HTTP request", async () => {
        mocks.verifySignedBytes.mockResolvedValue(null);

        const databases = await getDefaultDatabases();

        expect(mocks.verifySignedBytes).toHaveBeenCalledWith(
            databaseCatalogDocument,
            databaseCatalogSignature,
        );
        expect(databases.map((db) => db.title)).toContain("Lumbra's Gigabase");
        expect(
            databases.every((db) => db.downloadLink.startsWith("https://db.encroissant.org/")),
        ).toBe(true);
        expect(fetch).not.toHaveBeenCalled();
        expect(mocks.remoteGet).not.toHaveBeenCalled();
    });

    it("verifies the exact bundled puzzle catalog bytes without any HTTP request", async () => {
        mocks.verifySignedBytes.mockResolvedValue(null);

        const puzzles = await getDefaultPuzzleDatabases();

        expect(mocks.verifySignedBytes).toHaveBeenCalledWith(
            puzzleCatalogDocument,
            puzzleCatalogSignature,
        );
        expect(puzzles.map((db) => db.downloadLink)).toEqual([
            "https://db.encroissant.org/Lichess%20Puzzles%202026.db3",
        ]);
        expect(fetch).not.toHaveBeenCalled();
        expect(mocks.remoteGet).not.toHaveBeenCalled();
    });

    it("rejects with CatalogVerificationError instead of an empty list when verification fails", async () => {
        mocks.verifySignedBytes.mockRejectedValue(new Error("bad signature"));

        await expect(getDefaultDatabases()).rejects.toBeInstanceOf(CatalogVerificationError);
        await expect(getDefaultPuzzleDatabases()).rejects.toBeInstanceOf(CatalogVerificationError);
        expect(fetch).not.toHaveBeenCalled();
        expect(mocks.remoteGet).not.toHaveBeenCalled();
    });
});

describe("searchPosition query mapping", () => {
    it.each(["white", "black"] as const)(
        "%s player filters require matching ownership, including equivalent handles",
        async (color) => {
            const owner = databaseHandleKey(handle("local"));
            for (const [playerDatabase, expected] of [
                [owner, 42],
                [databaseHandleKey(handle("other")), null],
                [undefined, null],
            ] as const) {
                mocks.searchPosition.mockClear();
                const options = localOptions({
                    player: 42,
                    player_database: playerDatabase,
                    color,
                });
                expect(getEffectiveLocalPlayer(options, handle("local"))).toBe(expected);
                expect(getEffectiveLocalPlayer(options, null)).toBeNull();
                const query = await sentQuery(options);
                expect(query.player1 ?? null).toBe(color === "white" ? expected : null);
                expect(query.player2 ?? null).toBe(color === "black" ? expected : null);
            }
        },
    );
    it("forwards optional result and sample options without changing defaults", async () => {
        const defaults = await sentQuery(localOptions());
        expect(defaults).not.toHaveProperty("include_unknown_results");
        expect(defaults).not.toHaveProperty("sample_order");
        mocks.searchPosition.mockClear();
        expect(
            await sentQuery(localOptions({ include_unknown_results: true, sample_order: "date" })),
        ).toMatchObject({ include_unknown_results: true, sample_order: "date" });
        mocks.searchPosition.mockClear();
        expect(
            await sentQuery(localOptions({ include_unknown_results: false, sample_order: "elo" })),
        ).toMatchObject({ include_unknown_results: false, sample_order: "elo" });
    });
    const localOptions = (overrides: Partial<LocalOptions> = {}): LocalOptions => ({
        path: handle("local"),
        fen: "8/8/8/8/8/8/8/8 w - - 0 1",
        type: "exact",
        player: null,
        color: "white",
        result: "any",
        ...overrides,
    });
    const sentQuery = async (options: LocalOptions): Promise<GameQuery> => {
        mocks.searchPosition.mockResolvedValue([[], []]);
        await searchPosition(options, "tab-1");
        return mocks.searchPosition.mock.calls[0][1] as GameQuery;
    };

    it("sends the Elo band as both range1 and range2", async () => {
        const query = await sentQuery(localOptions({ elo: [1850, 2350] }));

        expect(query.range1).toEqual([1850, 2350]);
        expect(query.range2).toEqual([1850, 2350]);
    });

    it("omits both ranges when the slider is untouched or at [0, ELO_FILTER_MAX]", async () => {
        for (const elo of [undefined, [0, ELO_FILTER_MAX] as [number, number]]) {
            mocks.searchPosition.mockClear();
            const query = await sentQuery(localOptions({ elo }));

            expect(query).not.toHaveProperty("range1");
            expect(query).not.toHaveProperty("range2");
        }
    });

    it("keeps a width-3000 Elo band that does not start at zero", async () => {
        const query = await sentQuery(localOptions({ elo: [1, 3001] }));

        expect(query.range1).toEqual([1, 3001]);
        expect(query.range2).toEqual([1, 3001]);
    });

    it("omits wanted_result when the explorer result is any", async () => {
        const query = await sentQuery(localOptions({ result: "any" }));
        expect(query).not.toHaveProperty("wanted_result");
    });

    it("omits exclude_fast_events when off and sends true when on", async () => {
        for (const off of [undefined, false]) {
            mocks.searchPosition.mockClear();
            const query = await sentQuery(localOptions({ exclude_fast_events: off }));
            expect(query).not.toHaveProperty("exclude_fast_events");
        }

        mocks.searchPosition.mockClear();
        const query = await sentQuery(localOptions({ exclude_fast_events: true }));
        expect(query.exclude_fast_events).toBe(true);
    });
});
