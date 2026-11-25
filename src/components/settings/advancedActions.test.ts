import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import i18n from "i18next";
import enUSCatalogue from "@/translation/en-US.json";
import {
    clearSavedData,
    clearSavedDataAfterConfirmation,
    openAppLogs,
    reloadApp,
} from "./advancedActions";

const mocks = vi.hoisted(() => ({
    initializePathOwners: vi.fn(),
    startupLegacyDeckScanComplete: vi.fn(),
    ensureMigration: vi.fn(),
    runMigration: vi.fn(),
    retireMigratedKeys: vi.fn(),
    ask: vi.fn(),
    openAppLog: vi.fn(),
    nativeClear: vi.fn(),
    sessionClear: vi.fn(),
}));

vi.mock("@/state/pathOwners", () => ({
    initializePathOwners: mocks.initializePathOwners,
    startupLegacyDeckScanComplete: mocks.startupLegacyDeckScanComplete,
}));
vi.mock("@/state/practiceStorage", () => ({
    ensurePracticeMigration: mocks.ensureMigration,
    runPracticeMigrationPass: mocks.runMigration,
    retireMigratedLegacyDeckKeysFromBrowser: mocks.retireMigratedKeys,
}));
vi.mock("@/i18n", () => ({
    default: {
        t: (key: string, options?: Record<string, unknown>) =>
            typeof options?.decks === "string"
                ? `${key} ${options.decks}`
                : i18n.isInitialized
                  ? i18n.t(key, options)
                  : key,
    },
}));
vi.mock("@/platform/native", () => ({
    ask: mocks.ask,
}));
vi.mock("@/platform/tauri", () => ({
    tauri: {
        openAppLog: mocks.openAppLog,
    },
}));
vi.mock("@/state/unsavedGames", async (original) => {
    const actual = await original<typeof import("@/state/unsavedGames")>();
    return {
        ...actual,
        nativeUnsavedGames: {
            list: vi.fn(),
            remove: vi.fn(),
            clear: mocks.nativeClear,
        },
    };
});
vi.mock("@/state/workspaceSession", async (original) => {
    const actual = await original<typeof import("@/state/workspaceSession")>();
    return {
        ...actual,
        nativeWorkspaceSession: {
            ...actual.nativeWorkspaceSession,
            clear: mocks.sessionClear,
        },
    };
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

beforeAll(async () => {
    if (!i18n.isInitialized) {
        await i18n.init({
            lng: "en-US",
            resources: { "en-US": { translation: enUSCatalogue.translation } },
        });
        return;
    }
    i18n.addResourceBundle("en-US", "translation", enUSCatalogue.translation, true, true);
    await i18n.changeLanguage("en-US");
});

beforeEach(() => {
    mocks.initializePathOwners.mockReset().mockResolvedValue(undefined);
    mocks.startupLegacyDeckScanComplete.mockReset().mockReturnValue(true);
    mocks.ensureMigration.mockReset().mockResolvedValue({});
    mocks.runMigration.mockReset();
    mocks.retireMigratedKeys.mockReset();
    mocks.ask.mockReset();
    mocks.openAppLog.mockReset().mockResolvedValue(undefined);
    mocks.nativeClear.mockReset().mockResolvedValue([]);
    mocks.sessionClear.mockReset().mockResolvedValue([]);
    localStorage.clear();
    sessionStorage.clear();
});

async function clearThroughProductionPath(
    result: unknown,
    clear: () => void | Promise<void>,
): Promise<void> {
    mocks.runMigration.mockResolvedValue(result);
    await clearSavedDataAfterConfirmation({
        blockedMessage: (decks) => `blocked: ${decks.join(", ")}`,
        clear,
    });
}

test("the production clear path refuses after a failed migration", async () => {
    const clear = vi.fn();
    const outcomes = [
        {
            key: "deck-failed-0",
            identity: { file: "failed", game: 0 },
            status: "failed",
        },
    ];

    await expect(
        clearThroughProductionPath(
            {
                outcomes,
                inventory: { decks: [], anomalies: [] },
                scanTrusted: true,
                inventoryTrusted: true,
            },
            clear,
        ),
    ).rejects.toThrow("failed (0)");
    expect(mocks.retireMigratedKeys).toHaveBeenCalledExactlyOnceWith(outcomes);
    expect(clear).not.toHaveBeenCalled();
});

test("the production clear path refuses when inventory reports a damaged deck", async () => {
    const clear = vi.fn();

    await expect(
        clearThroughProductionPath(
            {
                outcomes: [],
                inventory: {
                    decks: [],
                    anomalies: [
                        { kind: "OrphanShard", leaf: "orphan", fileId: "damaged", game: 2 },
                    ],
                },
                scanTrusted: true,
                inventoryTrusted: true,
            },
            clear,
        ),
    ).rejects.toThrow("damaged (2)");
    expect(clear).not.toHaveBeenCalled();
});

test("the production clear path does not name a repaired native deck", async () => {
    const clear = vi.fn();
    const outcomes = [
        {
            key: "deck-repaired-0",
            identity: { file: "repaired", game: 0 },
            status: "migrated",
        },
    ];

    await clearThroughProductionPath(
        {
            outcomes,
            inventory: {
                decks: [{ fileId: "repaired", game: 0 }],
                anomalies: [],
            },
            scanTrusted: true,
            inventoryTrusted: true,
        },
        clear,
    );

    expect(clear).toHaveBeenCalledOnce();
    expect(mocks.retireMigratedKeys).toHaveBeenCalledExactlyOnceWith(outcomes);
});

test("the production clear path waits for migration and runs a fresh pass before clearing", async () => {
    const migration = deferred<void>();
    const clear = vi.fn();
    mocks.ensureMigration.mockReturnValueOnce(migration.promise);
    mocks.runMigration.mockResolvedValueOnce({
        outcomes: [],
        inventory: { decks: [], anomalies: [] },
        scanTrusted: true,
        inventoryTrusted: true,
    });

    const clearing = clearSavedDataAfterConfirmation({
        blockedMessage: (decks) => `blocked: ${decks.join(", ")}`,
        clear,
    });
    await Promise.resolve();
    expect(clear).not.toHaveBeenCalled();
    expect(mocks.runMigration).not.toHaveBeenCalled();

    migration.resolve();
    await clearing;
    expect(mocks.runMigration).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
});

test("the production clear path waits for path owners before migrating and retiring", async () => {
    const initialization = deferred<void>();
    const clear = vi.fn();
    const outcomes = [
        {
            key: "deck-migrated-0",
            identity: { file: "migrated", game: 0 },
            status: "migrated",
        },
    ];
    mocks.initializePathOwners.mockReturnValueOnce(initialization.promise);
    mocks.runMigration.mockResolvedValueOnce({
        outcomes,
        inventory: { decks: [], anomalies: [] },
        scanTrusted: true,
        inventoryTrusted: true,
    });

    const clearing = clearSavedDataAfterConfirmation({
        blockedMessage: (decks) => `blocked: ${decks.join(", ")}`,
        clear,
    });
    expect(mocks.initializePathOwners).toHaveBeenCalledOnce();
    expect(mocks.ensureMigration).not.toHaveBeenCalled();
    expect(mocks.runMigration).not.toHaveBeenCalled();
    expect(mocks.retireMigratedKeys).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();

    initialization.resolve();
    await clearing;

    expect(mocks.runMigration).toHaveBeenCalledOnce();
    expect(mocks.retireMigratedKeys).toHaveBeenCalledExactlyOnceWith(outcomes);
    expect(clear).toHaveBeenCalledOnce();
});

test("the production clear path still refuses failed migration when path owners reject", async () => {
    const clear = vi.fn();
    mocks.initializePathOwners.mockRejectedValueOnce(new Error("path owners failed"));

    await expect(
        clearThroughProductionPath(
            {
                outcomes: [
                    {
                        key: "deck-migrated-0",
                        identity: { file: "migrated", game: 0 },
                        status: "migrated",
                    },
                    {
                        key: "deck-failed-0",
                        identity: { file: "failed", game: 0 },
                        status: "failed",
                    },
                ],
                inventory: { decks: [], anomalies: [] },
                scanTrusted: true,
                inventoryTrusted: true,
            },
            clear,
        ),
    ).rejects.toThrow("blocked: failed (0)");

    expect(mocks.ensureMigration).toHaveBeenCalledOnce();
    expect(mocks.runMigration).toHaveBeenCalledOnce();
    expect(mocks.retireMigratedKeys).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
});

test("the production clear path clears clean migration without retirement when path owners reject", async () => {
    const clear = vi.fn();
    mocks.initializePathOwners.mockRejectedValueOnce(new Error("path owners failed"));

    await clearThroughProductionPath(
        {
            outcomes: [
                {
                    key: "deck-migrated-0",
                    identity: { file: "migrated", game: 0 },
                    status: "migrated",
                },
            ],
            inventory: { decks: [], anomalies: [] },
            scanTrusted: true,
            inventoryTrusted: true,
        },
        clear,
    );

    expect(mocks.ensureMigration).toHaveBeenCalledOnce();
    expect(mocks.runMigration).toHaveBeenCalledOnce();
    expect(mocks.retireMigratedKeys).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledOnce();
});

test("reloadApp reloads the window", () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    try {
        reloadApp();
        expect(reload).toHaveBeenCalledOnce();
    } finally {
        vi.unstubAllGlobals();
    }
});

test("openAppLogs opens the application log", async () => {
    await openAppLogs();
    expect(mocks.openAppLog).toHaveBeenCalledOnce();
});

test("openAppLogs rejects when the log cannot be opened", async () => {
    mocks.openAppLog.mockRejectedValueOnce(new Error("log missing"));
    await expect(openAppLogs()).rejects.toThrow("log missing");
});

function fakeMirror(drain: () => Promise<{ finished: boolean }>) {
    return {
        pause: vi.fn(),
        resume: vi.fn(),
        drain,
    };
}

test("clearSavedData asks first and clears nothing when declined", async () => {
    const mirror = fakeMirror(async () => ({ finished: true }));
    mocks.ask.mockResolvedValueOnce(false);
    await clearSavedData({ mirror });
    expect(mocks.ask).toHaveBeenCalledOnce();
    expect(mocks.runMigration).not.toHaveBeenCalled();
    expect(mirror.pause).not.toHaveBeenCalled();
    expect(mocks.nativeClear).not.toHaveBeenCalled();
});

test("clearSavedData clears through the supplied unsaved-games mirror after confirmation", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    localStorage.setItem("keep", "no");
    sessionStorage.setItem("keep", "no");
    const mirror = fakeMirror(async () => ({ finished: true }));
    mocks.ask.mockResolvedValueOnce(true);
    mocks.runMigration.mockResolvedValueOnce({
        outcomes: [],
        inventory: { decks: [], anomalies: [] },
        scanTrusted: true,
        inventoryTrusted: true,
    });
    try {
        await clearSavedData({ mirror });
        expect(mirror.pause).toHaveBeenCalledOnce();
        expect(mocks.sessionClear).toHaveBeenCalledOnce();
        expect(mocks.nativeClear).toHaveBeenCalledOnce();
        expect(localStorage.getItem("keep")).toBeNull();
        expect(sessionStorage.getItem("keep")).toBeNull();
        expect(reload).toHaveBeenCalledOnce();
    } finally {
        vi.unstubAllGlobals();
    }
});

test("clearSavedData shows the migration refusal and clears nothing", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    localStorage.setItem("keep", "yes");
    const mirror = fakeMirror(async () => ({ finished: true }));
    mocks.ask.mockResolvedValueOnce(true);
    mocks.runMigration.mockResolvedValueOnce({
        outcomes: [
            {
                key: "deck-failed-0",
                identity: { file: "failed", game: 0 },
                status: "failed",
            },
        ],
        inventory: { decks: [], anomalies: [] },
        scanTrusted: true,
        inventoryTrusted: true,
    });
    try {
        await expect(clearSavedData({ mirror })).rejects.toThrow(/failed \(0\)/);
        expect(mocks.nativeClear).not.toHaveBeenCalled();
        expect(localStorage.getItem("keep")).toBe("yes");
        expect(reload).not.toHaveBeenCalled();
    } finally {
        vi.unstubAllGlobals();
    }
});

test("clearSavedData shows the unsaved-games refusal and clears nothing", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    localStorage.setItem("keep", "yes");
    const mirror = fakeMirror(async () => ({ finished: false }));
    mocks.ask.mockResolvedValueOnce(true);
    mocks.runMigration.mockResolvedValueOnce({
        outcomes: [],
        inventory: { decks: [], anomalies: [] },
        scanTrusted: true,
        inventoryTrusted: true,
    });
    try {
        await expect(clearSavedData({ mirror })).rejects.toThrow(
            enUSCatalogue.translation["Menu.Help.ClearSavedData.UnsavedPending"],
        );
        expect(mirror.resume).toHaveBeenCalledOnce();
        expect(mocks.nativeClear).not.toHaveBeenCalled();
        expect(localStorage.getItem("keep")).toBe("yes");
        expect(reload).not.toHaveBeenCalled();
    } finally {
        vi.unstubAllGlobals();
    }
});
