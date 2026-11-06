import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createStore } from "jotai";
import "./atoms";
import { serializeStorageValue } from "./store/debouncedStorage";

const effects = vi.hoisted(() => ({ warn: vi.fn(), report: vi.fn() }));
vi.mock("@/platform/native", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/platform/native")>()),
    warn: effects.warn,
}));
vi.mock("./persistError", () => ({ reportPersistError: effects.report }));
vi.mock("@/platform/tauri", async (importOriginal) => {
    const original = await importOriginal<typeof import("@/platform/tauri")>();
    return {
        ...original,
        tauri: Object.fromEntries(Object.keys(original.tauri).map((key) => [key, vi.fn()])),
    };
});

const POSTHOG_COOKIE_EXPIRE =
    "ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_posthog=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    document.cookie = POSTHOG_COOKIE_EXPIRE;
});
afterEach(() => vi.restoreAllMocks());

function captureCookieWrites(): { writes: string[]; restore: () => void } {
    const writes: string[] = [];
    let target: object = document;
    let descriptor: PropertyDescriptor | undefined;
    while (target && !descriptor) {
        descriptor = Object.getOwnPropertyDescriptor(target, "cookie");
        if (descriptor?.get && descriptor?.set) break;
        descriptor = undefined;
        target = Object.getPrototypeOf(target) as object;
    }
    if (!descriptor?.get || !descriptor?.set) {
        throw new Error("document.cookie descriptor missing");
    }
    const getter = descriptor.get;
    const setter = descriptor.set;
    Object.defineProperty(document, "cookie", {
        configurable: true,
        enumerable: true,
        get: () => getter.call(document),
        set: (value: string) => {
            writes.push(value);
            setter.call(document, value);
        },
    });
    return {
        writes,
        restore: () => {
            Reflect.deleteProperty(document, "cookie");
        },
    };
}

// This case deliberately uses only existing production module paths and no new API.
// Restoring the old production sources must fail on storage behavior, not import resolution.
test("real state import leaves fixture storage untouched", async () => {
    localStorage.setItem("document-dir", "legacy-directory");
    localStorage.setItem("telemetry-enabled", "true");
    localStorage.setItem("ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_posthog", "{}");
    localStorage.setItem("__ph_opt_in_out_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z", "1");
    sessionStorage.setItem("ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_posthog", "{}");
    sessionStorage.setItem("ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_window_id", "1");
    document.cookie = "ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_posthog={}";
    localStorage.setItem("download-destination-capability", "{malformed");
    localStorage.setItem("show-coordinates-v2", JSON.stringify("invalid"));
    sessionStorage.setItem("expanded-directories", JSON.stringify(["unscoped-directory"]));
    sessionStorage.setItem("workspace", "unreadable-workspace");
    const workspace = await import("./workspace");
    const loadWorkspace = vi.spyOn(workspace, "loadWorkspace");
    const reads = vi.spyOn(Storage.prototype, "getItem");
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const removals = vi.spyOn(Storage.prototype, "removeItem");
    const enumeration = vi.spyOn(Storage.prototype, "key");

    await import("./atoms");
    const { tauri } = await import("@/platform/tauri");

    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(removals).not.toHaveBeenCalled();
    expect(enumeration).not.toHaveBeenCalled();
    expect(loadWorkspace).not.toHaveBeenCalled();
    expect(effects.warn).not.toHaveBeenCalled();
    expect(effects.report).not.toHaveBeenCalled();
    for (const operation of Object.values(tauri)) expect(operation).not.toHaveBeenCalled();
    expect(localStorage.getItem("document-dir")).toBe("legacy-directory");
    expect(localStorage.getItem("telemetry-enabled")).toBe("true");
    expect(localStorage.getItem("ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_posthog")).toBe(
        "{}",
    );
    expect(
        localStorage.getItem("__ph_opt_in_out_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z"),
    ).toBe("1");
    expect(
        sessionStorage.getItem("ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_posthog"),
    ).toBe("{}");
    expect(
        sessionStorage.getItem("ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_window_id"),
    ).toBe("1");
    expect(document.cookie).toContain("ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_posthog");
    expect(localStorage.getItem("download-destination-capability")).toBe("{malformed");
    expect(localStorage.getItem("show-coordinates-v2")).toBe(JSON.stringify("invalid"));
    expect(sessionStorage.getItem("expanded-directories")).toBe(
        JSON.stringify(["unscoped-directory"]),
    );
    expect(sessionStorage.getItem("workspace")).toBe("unreadable-workspace");
});

test("explicit initialization preserves raw lossy and sibling ownership after repairs and reconciliation", async () => {
    localStorage.setItem("document-dir", "legacy-directory");
    localStorage.setItem("telemetry-enabled", "true");
    localStorage.setItem("ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_posthog", "{}");
    localStorage.setItem("__ph_opt_in_out_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z", "1");
    sessionStorage.setItem("ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_posthog", "{}");
    sessionStorage.setItem("ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_window_id", "1");
    document.cookie = "ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_posthog={}";
    localStorage.setItem(
        "download-destination-capability",
        JSON.stringify({ id: "lossy-download", obsolete: true }),
    );
    localStorage.setItem(
        "file-workspace",
        JSON.stringify({ id: { id: "workspace" }, kind: "fileWorkspace" }),
    );
    localStorage.setItem("engines", "malformed");
    localStorage.setItem(
        "game-player1-settings",
        serializeStorageValue({
            type: "engine",
            engine: {
                type: "local",
                id: "player-engine",
                name: "Engine",
                version: "1",
                filename: "engine",
                handle: { id: { id: "sibling-executable" }, kind: "engine" },
                imageHandle: { id: { id: "sibling-image" }, kind: "engineImage" },
            },
            go: { t: "Depth", c: 24 },
            engineSettings: [],
        }),
    );
    sessionStorage.setItem("expanded-directories", JSON.stringify(["unscoped-directory"]));
    const atoms = await import("./atoms");
    const owners = await import("./pathOwners");
    const { tauri } = await import("@/platform/tauri");
    vi.mocked(tauri.listPracticeDecks).mockResolvedValue({ decks: [], anomalies: [] });
    const cookies = captureCookieWrites();
    atoms.initializeRendererState();
    cookies.restore();
    expect(cookies.writes).toEqual([
        POSTHOG_COOKIE_EXPIRE,
        `${POSTHOG_COOKIE_EXPIRE}; Domain=.tauri.localhost`,
        `${POSTHOG_COOKIE_EXPIRE}; Domain=.localhost`,
        `${POSTHOG_COOKIE_EXPIRE}; Domain=tauri.localhost`,
    ]);
    const snapshot = owners.initializeOriginalPathOwners();
    expect(snapshot.pathOwners.retainedIds).toEqual(
        expect.arrayContaining([
            { id: "workspace" },
            { id: "sibling-executable" },
            { id: "sibling-image" },
        ]),
    );
    expect(snapshot.pathOwners.retainedIds).not.toContainEqual({ id: "lossy-download" });
    for (const family of ["downloadDestination", "engines", "expandedDirectories"]) {
        expect(snapshot.pathOwners.trustedFamilies).not.toContain(family);
    }
    expect(snapshot.engineAttachmentIds).toBeNull();
    expect(localStorage.getItem("download-destination-capability")).toBe(
        JSON.stringify({ id: "lossy-download" }),
    );
    expect(localStorage.getItem("document-dir")).toBeNull();
    expect(localStorage.getItem("telemetry-enabled")).toBeNull();
    expect(
        localStorage.getItem("ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_posthog"),
    ).toBeNull();
    expect(
        localStorage.getItem("__ph_opt_in_out_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z"),
    ).toBeNull();
    expect(
        sessionStorage.getItem("ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_posthog"),
    ).toBeNull();
    expect(
        sessionStorage.getItem("ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_window_id"),
    ).toBeNull();
    expect(document.cookie).not.toContain(
        "ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_posthog",
    );
    expect(sessionStorage.getItem("expanded-directories")).toBeNull();
    localStorage.setItem("engines", serializeStorageValue([]));
    await owners.initializePathOwners();
    atoms.initializeRendererState();
    expect(owners.initializeOriginalPathOwners()).toBe(snapshot);
    expect(tauri.reconcileStartupPathOwners).toHaveBeenCalledExactlyOnceWith({
        retainedIds: snapshot.pathOwners.retainedIds,
        trustedFamilies: [...snapshot.pathOwners.trustedFamilies, "practiceDeck"].sort(),
    });
    expect(tauri.reconcileEngineAttachments).not.toHaveBeenCalled();
});

test("asynchronous path initialization captures original evidence before its first migration wait", async () => {
    sessionStorage.setItem("expanded-directories", JSON.stringify(["unscoped-directory"]));
    const owners = await import("./pathOwners");
    const { tauri } = await import("@/platform/tauri");
    let finishInventory!: (inventory: { decks: []; anomalies: [] }) => void;
    vi.mocked(tauri.listPracticeDecks).mockReturnValueOnce(
        new Promise((resolve) => {
            finishInventory = resolve;
        }),
    );
    vi.mocked(tauri.listPracticeDecks).mockResolvedValue({ decks: [], anomalies: [] });
    const startup = owners.initializePathOwners();
    expect(sessionStorage.getItem("expanded-directories")).toBeNull();
    expect(owners.initializeOriginalPathOwners().pathOwners.trustedFamilies).not.toContain(
        "expandedDirectories",
    );
    expect(tauri.reconcileStartupPathOwners).not.toHaveBeenCalled();
    finishInventory({ decks: [], anomalies: [] });
    await startup;
    expect(tauri.reconcileEngineAttachments).toHaveBeenCalledExactlyOnceWith({
        action: "reconcile",
        retained_ids: [],
        abandoned_ids: [],
        startup: true,
    });
});

test("direct owner hydration preserves refused raw ownership even when its next read succeeds", async () => {
    const originalGetItem = Storage.prototype.getItem;
    let reads = 0;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
        if (this === localStorage && key === "reference-database" && ++reads === 1) {
            throw new DOMException("read refused", "SecurityError");
        }
        return originalGetItem.call(this, key);
    });
    localStorage.setItem(
        "reference-database",
        JSON.stringify({ id: { id: "reference" }, kind: "database" }),
    );
    const atoms = await import("./atoms");
    const store = createStore();
    const unmount = store.sub(atoms.referenceDbAtom, () => {});
    try {
        expect(store.get(atoms.referenceDbAtom)).toEqual({
            id: { id: "reference" },
            kind: "database",
        });
        const { initializeOriginalPathOwners } = await import("./pathOwners");
        const snapshot = initializeOriginalPathOwners();
        expect(snapshot.pathOwners.trustedFamilies).not.toContain("referenceDatabase");
        expect(snapshot.pathOwners.retainedIds).not.toContainEqual({ id: "reference" });
    } finally {
        unmount();
    }
});
