import { beforeEach, describe, expect, test, vi } from "vitest";
import "./atoms";
// Warms the transform at collection for the dynamic import in the incomplete-startup-scan test (f-20261101-01).
import "../routes/__root";
import { deserializeStorageValue, serializeStorageValue } from "./store/debouncedStorage";
import {
    EXPANDED_DIRECTORIES_STORAGE_KEY,
    MAX_EXPANDED_DIRECTORY_IDS,
} from "./expandedDirectories";

const persistError = vi.hoisted(() => ({ report: vi.fn() }));
const mocks = vi.hoisted(() => ({
    list: vi.fn(),
    migrate: vi.fn(),
    reconcile: vi.fn(),
    reconcileAttachments: vi.fn(),
}));
vi.mock("@/platform/tauri", () => ({
    tauri: {
        listPracticeDecks: mocks.list,
        migratePracticeDeck: mocks.migrate,
        practiceEpoch: vi.fn(async () => ({ epoch: "no-map", legacySuperseded: false })),
        reconcileStartupPathOwners: mocks.reconcile,
        reconcileEngineAttachments: mocks.reconcileAttachments,
    },
}));
vi.mock("./persistError", () => ({ reportPersistError: persistError.report }));
vi.mock("@/components/TopBar", () => ({ default: () => null }));
vi.mock("@/state/keybinds", () => ({ keyMapAtom: {} }));

import {
    collectOriginalPathOwners,
    initializePathOwners,
    resetPathOwnerInitializationForTests,
    startupLegacyDeckScanComplete,
} from "./pathOwners";
import { resetEngineOwnerCoordinatorForTests, saveEngineOwnerValue } from "./engineOwnerStorage";
import { ensurePracticeMigration, resetPracticeMigrationForTests } from "./practiceStorage";

const path = (id: string) => ({ id });
const fileHandle = (id: string) => ({ id: path(id), kind: "fileWorkspace" as const });
const databaseHandle = (id: string) => ({ id: path(id), kind: "database" as const });
const engineHandle = (id: string) => ({ id: path(id), kind: "engine" as const });

function setJson(storage: Storage, key: string, value: unknown) {
    storage.setItem(key, JSON.stringify(value));
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mocks.list.mockReset().mockResolvedValue({ decks: [], anomalies: [] });
    mocks.migrate.mockReset().mockResolvedValue({
        status: "migrated",
        entries: 0,
        positions: 0,
        positionsDigest: "positions",
        entriesDigest: "entries",
    });
    mocks.reconcile.mockReset().mockResolvedValue(null);
    mocks.reconcileAttachments.mockReset().mockResolvedValue(null);
    resetPathOwnerInitializationForTests();
    resetEngineOwnerCoordinatorForTests();
    resetPracticeMigrationForTests();
    persistError.report.mockReset();
});

describe("collectOriginalPathOwners", () => {
    test("mixed recent entries retain database and file capabilities without losing trust", () => {
        setJson(localStorage, "recent-files", [
            { name: "File", handle: fileHandle("recent-file"), type: "game", lastOpened: 1 },
            {
                kind: "database",
                name: "White - Black",
                database: databaseHandle("recent-db"),
                gameId: 42,
                lastOpened: 2,
            },
        ]);
        const owners = collectOriginalPathOwners();
        expect(owners.retainedIds).toEqual(
            expect.arrayContaining([path("recent-file"), path("recent-db")]),
        );
        expect(owners.trustedFamilies).toContain("recentFiles");
        setJson(localStorage, "recent-files", [
            { kind: "database", database: databaseHandle("recent-db"), gameId: "broken" },
        ]);
        expect(collectOriginalPathOwners().trustedFamilies).not.toContain("recentFiles");
    });
    test.each(["plain", "compressed"])(
        "retains and trusts a %s database-view envelope",
        (encoding) => {
            const envelope = {
                state: { database: { file: databaseHandle("database-view") } },
                version: 0,
            };
            const raw =
                encoding === "plain" ? JSON.stringify(envelope) : serializeStorageValue(envelope);
            sessionStorage.setItem("database-view", raw);

            const owners = collectOriginalPathOwners(localStorage, sessionStorage);
            expect(owners.retainedIds).toContainEqual(path("database-view"));
            expect(owners.trustedFamilies).toContain("databaseView");
            expect(sessionStorage.getItem("database-view")).toBe(raw);
        },
    );

    test("document snapshot captures raw owners before persisted atoms hydrate", async () => {
        vi.resetModules();
        const originalGetItem = Storage.prototype.getItem;
        let ownerReads = 0;
        const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (
            this: Storage,
            key: string,
        ) {
            if (this === localStorage && key === "download-destination-capability") {
                ownerReads += 1;
                return ownerReads === 1 ? JSON.stringify(path("raw-download")) : null;
            }
            return originalGetItem.call(this, key);
        });

        const { initializeRendererState } = await import("./atoms");
        initializeRendererState();
        const { initializeOriginalPathOwners } = await import("./pathOwners");
        const { pathOwners: originalPathOwnersSnapshot } = initializeOriginalPathOwners();
        getItem.mockRestore();

        expect(ownerReads).toBeGreaterThan(1);
        expect(originalPathOwnersSnapshot.retainedIds).toContainEqual(path("raw-download"));
    });

    test("captures each engine owner key once for both startup snapshots", async () => {
        vi.resetModules();
        const reads = new Map<string, number>();
        const originalGetItem = Storage.prototype.getItem;
        const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (
            this: Storage,
            key: string,
        ) {
            if (
                this === localStorage &&
                ["engines", "game-player1-settings", "game-player2-settings"].includes(key)
            ) {
                reads.set(key, (reads.get(key) ?? 0) + 1);
            }
            return originalGetItem.call(this, key);
        });

        const { initializeOriginalPathOwners } = await import("./pathOwners");
        initializeOriginalPathOwners();
        getItem.mockRestore();

        expect(reads).toEqual(
            new Map([
                ["engines", 1],
                ["game-player1-settings", 1],
                ["game-player2-settings", 1],
            ]),
        );
    });

    test("collects every known owner location before storage repair", () => {
        const engine = {
            type: "local" as const,
            id: "engine-record",
            name: "Engine",
            version: "1",
            handle: engineHandle("engine-executable"),
            filename: "engine",
            imageHandle: { id: path("engine-image"), kind: "engineImage" as const },
            settings: [
                {
                    type: "resource" as const,
                    name: "SyzygyPath",
                    resources: [
                        {
                            id: path("engine-resource"),
                            kind: "directory" as const,
                            displayName: "tables",
                        },
                    ],
                },
            ],
        };
        setJson(localStorage, "download-destination-capability", path("download"));
        setJson(localStorage, "file-workspace", fileHandle("workspace"));
        setJson(localStorage, "recent-files", [
            { name: "Recent", handle: fileHandle("recent"), type: "game", lastOpened: 1 },
        ]);
        setJson(localStorage, "reference-database", databaseHandle("reference"));
        setJson(localStorage, "puzzle-db", path("puzzle"));
        setJson(localStorage, "game-opening-book-handle", {
            id: path("book"),
            kind: "openingBook",
        });
        localStorage.setItem("engines", serializeStorageValue([engine]));
        localStorage.setItem(
            "game-player1-settings",
            serializeStorageValue({
                type: "engine",
                engine,
                go: { t: "Depth", c: 24 },
                engineSettings: [
                    {
                        type: "resource",
                        name: "EvalFile",
                        resources: [
                            { id: path("player-resource"), kind: "file", displayName: "net" },
                        ],
                    },
                ],
            }),
        );
        setJson(localStorage, "game-player2-settings", { type: "human", name: "Player" });

        const file = {
            type: "file" as const,
            handle: fileHandle("tab-file"),
            name: "study.pgn",
            numGames: 1,
            metadata: { type: "game" as const, tags: [] },
            lastModified: 1,
        };
        sessionStorage.setItem(
            "workspace",
            serializeStorageValue({
                version: 1,
                tabs: [
                    {
                        name: "Current",
                        value: "current",
                        type: "analysis",
                        gameOrigin: { kind: "file", file, gameNumber: 1 },
                    },
                ],
                activeTab: "current",
            }),
        );
        sessionStorage.setItem(
            "tabs",
            serializeStorageValue([
                {
                    name: "Legacy",
                    value: "legacy",
                    type: "analysis",
                    gameOrigin: {
                        kind: "database",
                        database: databaseHandle("legacy-database"),
                        gameId: 2,
                    },
                },
            ]),
        );
        setJson(sessionStorage, EXPANDED_DIRECTORIES_STORAGE_KEY, ["expanded"]);
        setJson(sessionStorage, "database-view", {
            state: { database: { file: databaseHandle("database-view") } },
        });
        localStorage.setItem("deck-deck-file-42", "unreadable study value");

        const owners = collectOriginalPathOwners(localStorage, sessionStorage);

        expect(owners.trustedFamilies).toHaveLength(10);
        expect(owners.retainedIds.map(({ id }) => id)).toEqual(
            expect.arrayContaining([
                "download",
                "workspace",
                "recent",
                "reference",
                "puzzle",
                "book",
                "engine-executable",
                "engine-image",
                "engine-resource",
                "player-resource",
                "tab-file",
                "legacy-database",
                "database-view",
                "deck-file",
            ]),
        );
        expect(owners.trustedFamilies).not.toContain("expandedDirectories");
        expect(owners.retainedIds).not.toContainEqual({ id: "expanded" });
    });

    test("trusts and bounds a valid oversized directory record without rewriting the snapshot", () => {
        const ids = Array.from(
            { length: MAX_EXPANDED_DIRECTORY_IDS + 5 },
            (_, index) => `directory-${index}`,
        );
        setJson(localStorage, "file-workspace", fileHandle("active-workspace"));
        const raw = serializeStorageValue({
            version: 1,
            workspaceId: "active-workspace",
            ids,
        });
        sessionStorage.setItem(EXPANDED_DIRECTORIES_STORAGE_KEY, raw);

        const owners = collectOriginalPathOwners(localStorage, sessionStorage);
        const retained = new Set(owners.retainedIds.map(({ id }) => id));

        expect(owners.trustedFamilies).toContain("expandedDirectories");
        expect(retained.has("directory-0")).toBe(false);
        expect(retained.has(`directory-${MAX_EXPANDED_DIRECTORY_IDS + 4}`)).toBe(true);
        expect([...retained].filter((id) => id.startsWith("directory-")).length).toBe(
            MAX_EXPANDED_DIRECTORY_IDS,
        );
        expect(sessionStorage.getItem(EXPANDED_DIRECTORIES_STORAGE_KEY)).toBe(raw);
        expect(deserializeStorageValue<{ version: number; ids: string[] }>(raw)?.ids).toHaveLength(
            MAX_EXPANDED_DIRECTORY_IDS + 5,
        );
    });

    test("trusts valid records for absent or mismatched workspaces without retaining ids", () => {
        const record = {
            version: 1,
            workspaceId: "stored-workspace",
            ids: ["stored-directory"],
        };
        sessionStorage.setItem(EXPANDED_DIRECTORIES_STORAGE_KEY, serializeStorageValue(record));

        const absent = collectOriginalPathOwners(localStorage, sessionStorage);
        expect(absent.trustedFamilies).toContain("expandedDirectories");
        expect(absent.retainedIds).not.toContainEqual({ id: "stored-directory" });

        setJson(localStorage, "file-workspace", fileHandle("other-workspace"));
        const mismatched = collectOriginalPathOwners(localStorage, sessionStorage);
        expect(mismatched.trustedFamilies).toContain("expandedDirectories");
        expect(mismatched.retainedIds).not.toContainEqual({ id: "stored-directory" });
    });

    test("repairs a valid oversized record at startup before Files mounts", async () => {
        const ids = Array.from(
            { length: MAX_EXPANDED_DIRECTORY_IDS + 5 },
            (_, index) => `startup-${index}`,
        );
        sessionStorage.setItem(
            EXPANDED_DIRECTORIES_STORAGE_KEY,
            serializeStorageValue({ version: 1, workspaceId: "inactive-workspace", ids }),
        );
        vi.resetModules();
        const { initializeOriginalPathOwners } = await import("./pathOwners");
        initializeOriginalPathOwners();
        const repaired = deserializeStorageValue<{ workspaceId: string; ids: string[] }>(
            sessionStorage.getItem(EXPANDED_DIRECTORIES_STORAGE_KEY)!,
        );
        expect(repaired).toEqual({
            version: 1,
            workspaceId: "inactive-workspace",
            ids: ids.slice(-MAX_EXPANDED_DIRECTORY_IDS),
        });
    });

    test("drops an unscoped legacy preference at startup after taking the owner snapshot", async () => {
        setJson(localStorage, "file-workspace", fileHandle("current-workspace"));
        sessionStorage.setItem(
            EXPANDED_DIRECTORIES_STORAGE_KEY,
            JSON.stringify(["unknown-directory"]),
        );
        vi.resetModules();
        const { initializeOriginalPathOwners } = await import("./pathOwners");
        const { pathOwners: originalPathOwnersSnapshot } = initializeOriginalPathOwners();
        expect(originalPathOwnersSnapshot.retainedIds).not.toContainEqual(
            path("unknown-directory"),
        );
        expect(originalPathOwnersSnapshot.trustedFamilies).not.toContain("expandedDirectories");
        expect(sessionStorage.getItem(EXPANDED_DIRECTORIES_STORAGE_KEY)).toBeNull();
    });

    test("distinguishes confirmed absence from malformed and throwing storage", () => {
        setJson(localStorage, "download-destination-capability", { id: "" });
        const owners = collectOriginalPathOwners(localStorage, sessionStorage);
        expect(owners.trustedFamilies).not.toContain("downloadDestination");
        expect(owners.trustedFamilies).toContain("fileWorkspace");

        const throwing = Object.create(localStorage) as Storage;
        Object.defineProperty(throwing, "getItem", {
            value: () => {
                throw new Error("denied");
            },
        });
        expect(collectOriginalPathOwners(throwing, sessionStorage).trustedFamilies).not.toContain(
            "engines",
        );

        setJson(localStorage, "file-workspace", { id: { id: "" }, kind: "fileWorkspace" });
        expect(
            collectOriginalPathOwners(localStorage, sessionStorage).trustedFamilies,
        ).not.toContain("fileWorkspace");
        const workspaceThrowing = Object.create(localStorage) as Storage;
        Object.defineProperty(workspaceThrowing, "getItem", {
            value: (key: string) => {
                if (key === "file-workspace") throw new Error("workspace read denied");
                return localStorage.getItem(key);
            },
        });
        expect(
            collectOriginalPathOwners(workspaceThrowing, sessionStorage).trustedFamilies,
        ).not.toContain("fileWorkspace");
    });

    test("unions valid sibling evidence while failed shared-family records withhold trust", () => {
        const playerEngine = {
            type: "local" as const,
            id: "player-engine",
            name: "Player engine",
            version: "1",
            handle: engineHandle("player-executable"),
            filename: "engine",
            imageHandle: { id: path("player-image"), kind: "engineImage" as const },
            settings: [
                {
                    type: "resource" as const,
                    name: "EvalFile",
                    resources: [
                        { id: path("player-net"), kind: "file" as const, displayName: "net" },
                    ],
                },
            ],
        };
        localStorage.setItem(
            "game-player1-settings",
            serializeStorageValue({
                type: "engine",
                engine: playerEngine,
                go: { t: "Depth", c: 24 },
                engineSettings: [
                    {
                        type: "resource",
                        name: "Override",
                        resources: [
                            { id: path("override-net"), kind: "file", displayName: "override" },
                        ],
                    },
                ],
            }),
        );
        let owners = collectOriginalPathOwners(localStorage, sessionStorage);
        expect(owners.trustedFamilies).toContain("engines");
        expect(owners.retainedIds).toEqual(
            expect.arrayContaining([
                path("player-executable"),
                path("player-image"),
                path("player-net"),
                path("override-net"),
            ]),
        );

        localStorage.setItem("engines", "malformed");
        owners = collectOriginalPathOwners(localStorage, sessionStorage);
        expect(owners.trustedFamilies).not.toContain("engines");
        expect(owners.retainedIds).toContainEqual(path("player-executable"));
    });

    test("unions current and legacy workspace evidence but distrusts either failed source", () => {
        const tempFile = {
            type: "file" as const,
            handle: fileHandle("temp-file"),
            name: "temp.pgn",
            numGames: 1,
            metadata: { type: "game" as const, tags: [] },
            lastModified: 1,
        };
        sessionStorage.setItem("workspace", "malformed");
        sessionStorage.setItem(
            "tabs",
            serializeStorageValue([
                {
                    name: "Legacy temp",
                    value: "legacy-temp",
                    type: "analysis",
                    gameOrigin: { kind: "temp_file", file: tempFile, gameNumber: 1 },
                },
            ]),
        );
        const owners = collectOriginalPathOwners(localStorage, sessionStorage);
        expect(owners.trustedFamilies).not.toContain("sessionWorkspace");
        expect(owners.retainedIds).toContainEqual(path("temp-file"));
    });

    test("storage access and enumeration failures protect only affected families", () => {
        const throwingRead = Object.create(localStorage) as Storage;
        Object.defineProperty(throwingRead, "getItem", {
            value: (key: string) => {
                if (key === "engines") throw new Error("denied");
                return localStorage.getItem(key);
            },
        });
        Object.defineProperty(throwingRead, "length", {
            get: () => {
                throw new Error("enumeration denied");
            },
        });
        const owners = collectOriginalPathOwners(throwingRead, sessionStorage);
        expect(owners.trustedFamilies).not.toContain("engines");
        expect(owners.trustedFamilies).not.toContain("practiceDeck");
        expect(owners.trustedFamilies).toContain("downloadDestination");
    });

    test("throwing global storage getters return an all-untrusted startup snapshot", () => {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            get: () => {
                throw new Error("storage disabled");
            },
        });
        try {
            expect(collectOriginalPathOwners()).toEqual({ retainedIds: [], trustedFamilies: [] });
        } finally {
            if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
        }
    });
});

test("initialization shares one native reconciliation promise", async () => {
    let resolve: () => void = () => {};
    mocks.reconcile.mockImplementation(
        () =>
            new Promise<null>((done) => {
                resolve = () => done(null);
            }),
    );
    const first = initializePathOwners();
    const second = initializePathOwners();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(mocks.reconcile).toHaveBeenCalledOnce());
    expect(mocks.reconcile).toHaveBeenCalledOnce();
    resolve();
    await first;
    expect(mocks.reconcileAttachments).toHaveBeenCalledOnce();
});

test("builds the practice union after migration and keeps a key inserted during the pass", async () => {
    localStorage.setItem("deck-before-0", JSON.stringify({ positions: [], logs: [] }));
    mocks.list.mockResolvedValue({
        decks: [{ fileId: "native", game: 1 }],
        anomalies: [],
    });
    mocks.migrate.mockImplementation(async () => {
        localStorage.setItem("deck-during-2", JSON.stringify({ positions: [], logs: [] }));
        return {
            status: "migrated",
            entries: 0,
            positions: 0,
            positionsDigest: "positions",
            entriesDigest: "entries",
        };
    });
    mocks.reconcile.mockImplementation(async () => {
        expect(localStorage.getItem("deck-before-0")).not.toBeNull();
        expect(localStorage.getItem("deck-during-2")).not.toBeNull();
        return null;
    });
    mocks.reconcileAttachments.mockImplementation(async () => {
        expect(localStorage.getItem("deck-before-0")).not.toBeNull();
        expect(localStorage.getItem("deck-during-2")).not.toBeNull();
        return null;
    });

    await ensurePracticeMigration();
    await initializePathOwners();

    const owners = mocks.reconcile.mock.calls[0][0];
    expect(owners.retainedIds).toEqual(
        expect.arrayContaining([{ id: "before" }, { id: "during" }, { id: "native" }]),
    );
    expect(owners.trustedFamilies).toContain("practiceDeck");
    expect(localStorage.getItem("deck-before-0")).toBeNull();
    expect(localStorage.getItem("deck-during-2")).not.toBeNull();
});

test("retires an already migrated key while retaining its identity from the inventory", async () => {
    expect(startupLegacyDeckScanComplete()).toBe(false);
    localStorage.setItem("deck-held-0", JSON.stringify({ positions: [], logs: [] }));
    mocks.list.mockResolvedValue({
        decks: [{ fileId: "held", game: 0 }],
        anomalies: [],
    });

    const migration = await ensurePracticeMigration();
    expect(migration.outcomes).toEqual([
        { key: "deck-held-0", identity: { file: "held", game: 0 }, status: "alreadyMigrated" },
    ]);
    await initializePathOwners();

    expect(startupLegacyDeckScanComplete()).toBe(true);
    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(localStorage.getItem("deck-held-0")).toBeNull();
    expect(mocks.reconcile.mock.calls[0][0].retainedIds).toContainEqual({ id: "held" });
});

test("keeps migrated legacy keys when the startup scan is incomplete", async () => {
    localStorage.setItem("deck-held-0", JSON.stringify({ positions: [], logs: [] }));
    mocks.list.mockResolvedValue({
        decks: [{ fileId: "held", game: 0 }],
        anomalies: [],
    });
    const migration = await ensurePracticeMigration();
    expect(migration.outcomes[0]?.status).toBe("alreadyMigrated");
    const key = vi.spyOn(Storage.prototype, "key").mockImplementationOnce(() => {
        throw new Error("enumeration denied");
    });

    try {
        await initializePathOwners();
        expect(key).toHaveBeenCalledOnce();
    } finally {
        key.mockRestore();
    }

    expect(localStorage.getItem("deck-held-0")).not.toBeNull();
    expect(startupLegacyDeckScanComplete()).toBe(false);
    expect(mocks.reconcile).toHaveBeenCalledOnce();
    expect(mocks.reconcileAttachments).toHaveBeenCalledOnce();
    expect(mocks.reconcile.mock.calls[0][0].retainedIds).toContainEqual({ id: "held" });
});

test("retires migrated legacy keys after a complete but untrusted startup scan", async () => {
    localStorage.setItem("deck-held-0", JSON.stringify({ positions: [], logs: [] }));
    mocks.list.mockResolvedValue({
        decks: [{ fileId: "held", game: 0 }],
        anomalies: [],
    });
    await ensurePracticeMigration();
    localStorage.setItem("deck-malformed", JSON.stringify({ positions: [], logs: [] }));

    await initializePathOwners();

    expect(startupLegacyDeckScanComplete()).toBe(true);
    expect(localStorage.getItem("deck-held-0")).toBeNull();
    expect(localStorage.getItem("deck-malformed")).not.toBeNull();
    expect(mocks.reconcile.mock.calls[0][0].retainedIds).toContainEqual({ id: "held" });
});

test("refuses clearing without retiring migrated keys after an incomplete startup scan", async () => {
    vi.resetModules();
    const practice = await import("./practiceStorage");
    const owners = await import("./pathOwners");
    const { clearSavedDataAfterConfirmation } = await import("../routes/__root");
    const legacy = JSON.stringify({ positions: [], logs: [] });
    localStorage.setItem("deck-migrated-0", legacy);
    localStorage.setItem("deck-failed-1", legacy);
    mocks.list.mockResolvedValue({
        decks: [
            { fileId: "migrated", game: 0 },
            { fileId: "failed", game: 1 },
        ],
        anomalies: [],
    });
    await practice.ensurePracticeMigration();
    const key = vi.spyOn(Storage.prototype, "key").mockImplementationOnce(() => {
        throw new Error("enumeration denied");
    });
    try {
        await expect(owners.initializePathOwners()).resolves.toBeUndefined();
        expect(key).toHaveBeenCalledOnce();
    } finally {
        key.mockRestore();
    }
    expect(localStorage.getItem("deck-migrated-0")).toBe(legacy);
    expect(localStorage.getItem("deck-failed-1")).toBe(legacy);
    mocks.list.mockResolvedValue({ decks: [], anomalies: [] });
    mocks.migrate.mockImplementation(async (fileId: string) => {
        if (fileId === "failed") throw new Error("failed migration");
        return {
            status: "migrated",
            entries: 0,
            positions: 0,
            positionsDigest: "positions",
            entriesDigest: "entries",
        };
    });
    const clear = vi.fn();

    await expect(
        clearSavedDataAfterConfirmation({
            blockedMessage: (decks) => `blocked: ${decks.join(", ")}`,
            clear,
        }),
    ).rejects.toThrow("blocked: failed (1)");

    expect(mocks.migrate).toHaveBeenCalledTimes(2);
    expect(clear).not.toHaveBeenCalled();
    expect(mocks.reconcile).toHaveBeenCalledOnce();
    expect(localStorage.getItem("deck-migrated-0")).toBe(legacy);
    expect(localStorage.getItem("deck-failed-1")).toBe(legacy);
});

test("retains an orphan identity, distrusts practice data, and reports the anomaly once", async () => {
    mocks.list.mockResolvedValue({
        decks: [],
        anomalies: [
            {
                kind: "OrphanShard",
                leaf: "orphan-shard",
                fileId: "orphan",
                game: 3,
            },
        ],
    });

    await ensurePracticeMigration();
    await initializePathOwners();

    const owners = mocks.reconcile.mock.calls[0][0];
    expect(owners.retainedIds).toContainEqual({ id: "orphan" });
    expect(owners.trustedFamilies).not.toContain("practiceDeck");
    expect(persistError.report).toHaveBeenCalledOnce();
});

test("retains a damaged deck identity while distrusting practice data", async () => {
    mocks.list.mockResolvedValue({
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

    await ensurePracticeMigration();
    await initializePathOwners();

    const owners = mocks.reconcile.mock.calls[0][0];
    expect(owners.retainedIds).toContainEqual({ id: "damaged" });
    expect(owners.trustedFamilies).not.toContain("practiceDeck");
});

test("retains an unreadable deck identity while distrusting practice data", async () => {
    mocks.list.mockResolvedValue({
        decks: [{ fileId: "unreadable", game: 5 }],
        anomalies: [
            {
                kind: "Unreadable",
                leaf: "unreadable-positions.json",
                fileId: "unreadable",
                game: 5,
            },
        ],
    });

    await ensurePracticeMigration();
    await initializePathOwners();

    const owners = mocks.reconcile.mock.calls[0][0];
    expect(owners.retainedIds).toContainEqual({ id: "unreadable" });
    expect(owners.trustedFamilies).not.toContain("practiceDeck");
});

test("does not retain an identity from an IdentityMismatch anomaly", async () => {
    mocks.list.mockResolvedValue({
        decks: [],
        anomalies: [
            {
                kind: "IdentityMismatch",
                leaf: "mismatched",
                fileId: null,
                game: null,
            },
        ],
    });

    await ensurePracticeMigration();
    await initializePathOwners();

    const owners = mocks.reconcile.mock.calls[0][0];
    expect(owners.retainedIds).not.toContainEqual({ id: "mismatched" });
    expect(owners.trustedFamilies).not.toContain("practiceDeck");
});

test("retains a native identity on the second startup after the legacy key is removed", async () => {
    localStorage.setItem("deck-native-0", JSON.stringify({ positions: [], logs: [] }));
    mocks.list.mockResolvedValue({
        decks: [{ fileId: "native", game: 0 }],
        anomalies: [],
    });

    await ensurePracticeMigration();
    await initializePathOwners();
    localStorage.removeItem("deck-native-0");
    resetPathOwnerInitializationForTests();
    mocks.reconcile.mockClear();

    await initializePathOwners();

    expect(mocks.reconcile.mock.calls[0][0].retainedIds).toContainEqual({ id: "native" });
});

test("a failed first add leaves absent storage trusted for fresh startup reclamation", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
        throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    });
    const receipt = await saveEngineOwnerValue("engines", serializeStorageValue([]));
    setItem.mockRestore();

    expect(receipt).toEqual(expect.objectContaining({ saved: false, synchronized: false }));
    expect(localStorage.getItem("engines")).toBeNull();

    vi.resetModules();
    const fresh = await import("./pathOwners");
    const snapshot = fresh.collectOriginalPathOwners(localStorage, sessionStorage);
    expect(snapshot.trustedFamilies).toContain("engines");

    await fresh.initializePathOwners();
    expect(mocks.reconcile).toHaveBeenCalledWith(
        expect.objectContaining({ trustedFamilies: expect.arrayContaining(["engines"]) }),
    );
    expect(mocks.reconcileAttachments).toHaveBeenLastCalledWith({
        action: "reconcile",
        retained_ids: [],
        abandoned_ids: [],
        startup: true,
    });
});
