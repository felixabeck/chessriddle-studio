import { atom, createStore, type PrimitiveAtom } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DefaultEngine, Engine } from "@/utils/engines";
import { normalizeError } from "@/platform/errors";
import { enginesAtom } from "./atoms";
import { enginesStorageKeyAbsent } from "./engineOwnerStorage";
import { deserializeStorageValue, serializeStorageValue } from "./store/debouncedStorage";
import {
    automaticStockfishJobAtom,
    claimFirstLaunchStockfish,
    FIRST_LAUNCH_STOCKFISH_KEY,
    startFirstLaunchStockfish,
} from "./firstLaunchStockfish";

const mocks = vi.hoisted(() => ({
    owners: vi.fn(),
    catalog: vi.fn(),
    install: vi.fn(),
    warn: vi.fn(),
    notify: vi.fn(),
}));
vi.mock("@/platform/errors", async (original) => ({
    ...(await original<typeof import("@/platform/errors")>()),
    warnSafely: mocks.warn,
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.notify } }));
vi.mock("./atoms", () => ({ enginesAtom: atom<Engine[] | undefined>(undefined) }));
vi.mock("./pathOwners", () => ({ initializePathOwners: mocks.owners }));
vi.mock("./catalogEngineCompletion", () => ({ installCatalogEngineJob: mocks.install }));
vi.mock("@/utils/engines", async (original) => ({
    ...(await original<typeof import("@/utils/engines")>()),
    loadStockfishCatalogEntry: mocks.catalog,
}));

const engine: DefaultEngine = {
    id: "catalog",
    type: "local",
    name: "Stockfish",
    version: "17",
    path: "stockfish",
    os: "linux",
    bmi2: false,
    sha256: "a".repeat(64),
    signature: "signature",
    downloadLink: "https://example.com/stockfish.zip",
};
const existing: Engine = {
    id: "cloud",
    type: "lichess",
    name: "Cloud",
    url: "https://example.com",
};
type Store = ReturnType<typeof createStore>;
const setEngines = (store: Store, value: Engine[] | undefined) => {
    // The production atom is deliberately read-only to this module. Its hydration is controlled here.
    store.set(enginesAtom as unknown as PrimitiveAtom<Engine[] | undefined>, value);
};
function readyStore() {
    const store = createStore();
    setEngines(store, []);
    return store;
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
const disposers: Array<() => void> = [];
function start(store: Store, os: "linux" | undefined = "linux") {
    const dispose = startFirstLaunchStockfish(os, store);
    disposers.push(dispose);
    return dispose;
}
const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
    localStorage.clear();
    vi.resetAllMocks();
    vi.stubGlobal("navigator", { webdriver: false });
    mocks.owners.mockResolvedValue(undefined);
    mocks.catalog.mockResolvedValue(engine);
    mocks.install.mockResolvedValue(true);
});
afterEach(() => {
    disposers.splice(0).forEach((dispose) => dispose());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

test("a synchronous claim writes the bounded serialized marker and cannot be repeated", () => {
    const store = readyStore();
    expect(claimFirstLaunchStockfish(store)).toBe(true);
    expect(deserializeStorageValue(localStorage.getItem(FIRST_LAUNCH_STOCKFISH_KEY)!)).toBe(true);
    expect(claimFirstLaunchStockfish(store)).toBe(false);
});

test.each(["", "{broken", "null", serializeStorageValue(false)])(
    "marker presence refuses without decoding: %j",
    (raw) => {
        localStorage.setItem(FIRST_LAUNCH_STOCKFISH_KEY, raw);
        expect(claimFirstLaunchStockfish(readyStore())).toBe(false);
        expect(localStorage.getItem(FIRST_LAUNCH_STOCKFISH_KEY)).toBe(raw);
    },
);

test.each(["", "{broken", "[]", serializeStorageValue([])])(
    "engines key presence refuses even after removing every engine: %j",
    (raw) => {
        localStorage.setItem("engines", raw);
        expect(enginesStorageKeyAbsent()).toBe(false);
        expect(claimFirstLaunchStockfish(readyStore())).toBe(false);
        expect(localStorage.getItem(FIRST_LAUNCH_STOCKFISH_KEY)).toBeNull();
    },
);

test.each([{ engines: undefined }, { engines: [existing] }])(
    "unknown or non-empty current engines refuse: %j",
    ({ engines }) => {
        const store = readyStore();
        setEngines(store, engines);
        expect(claimFirstLaunchStockfish(store)).toBe(false);
        expect(localStorage.getItem(FIRST_LAUNCH_STOCKFISH_KEY)).toBeNull();
    },
);

test("webdriver refuses the claim and automatic start", async () => {
    vi.stubGlobal("navigator", { webdriver: true });
    const store = readyStore();
    expect(claimFirstLaunchStockfish(store)).toBe(false);
    start(store);
    await flush();
    expect(mocks.install).not.toHaveBeenCalled();
});

test.each([
    "webdriver",
    "marker",
    "corrupt marker",
    "engines",
    "empty engines",
    "marker read",
    "engines read",
    "storage access",
])("an ineligible profile skips all asynchronous startup work: %s", async (source) => {
    if (source === "webdriver") vi.stubGlobal("navigator", { webdriver: true });
    if (source === "marker") localStorage.setItem(FIRST_LAUNCH_STOCKFISH_KEY, "");
    if (source === "corrupt marker") localStorage.setItem(FIRST_LAUNCH_STOCKFISH_KEY, "{broken");
    if (source === "engines") localStorage.setItem("engines", "{broken");
    if (source === "empty engines") localStorage.setItem("engines", serializeStorageValue([]));
    if (source === "storage access") {
        vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
            throw new Error("denied");
        });
    }
    if (source === "marker read" || source === "engines read") {
        const read = Storage.prototype.getItem;
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
            if (key === (source === "marker read" ? FIRST_LAUNCH_STOCKFISH_KEY : "engines")) {
                throw new Error("denied");
            }
            return read.call(this, key);
        });
    }
    start(readyStore());
    expect(mocks.owners).not.toHaveBeenCalled();
    expect(mocks.catalog).not.toHaveBeenCalled();
    await flush();
    expect(mocks.owners).not.toHaveBeenCalled();
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
});

test.each(["marker read", "engines read", "write", "storage access"])(
    "a storage exception refuses and starts nothing: %s",
    async (source) => {
        const read = Storage.prototype.getItem;
        if (source === "storage access")
            vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
                throw new Error("denied");
            });
        else if (source === "write")
            vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
                throw new Error("quota");
            });
        else
            vi.spyOn(Storage.prototype, "getItem").mockImplementation(
                function (this: Storage, key) {
                    if (key === (source === "marker read" ? FIRST_LAUNCH_STOCKFISH_KEY : "engines"))
                        throw new Error("denied");
                    return read.call(this, key);
                },
            );
        const store = readyStore();
        expect(claimFirstLaunchStockfish(store)).toBe(false);
        start(store);
        await flush();
        expect(mocks.install).not.toHaveBeenCalled();
    },
);

test.each(["owners", "engines", "catalog"])(
    "the start waits for %s, marks before the job and publishes only that job",
    async (pending) => {
        const store = readyStore();
        const owners = deferred<void>();
        const catalog = deferred<DefaultEngine>();
        if (pending === "owners") mocks.owners.mockReturnValue(owners.promise);
        if (pending === "catalog") mocks.catalog.mockReturnValue(catalog.promise);
        if (pending === "engines") setEngines(store, undefined);
        const job = deferred<boolean>();
        mocks.install.mockImplementation(() => {
            expect(deserializeStorageValue(localStorage.getItem(FIRST_LAUNCH_STOCKFISH_KEY)!)).toBe(
                true,
            );
            return job.promise;
        });
        const snapshots: unknown[] = [];
        const unsubscribe = store.sub(automaticStockfishJobAtom, () =>
            snapshots.push(store.get(automaticStockfishJobAtom)),
        );
        try {
            start(store);
            await flush();
            expect(mocks.install).not.toHaveBeenCalled();
            expect(localStorage.getItem(FIRST_LAUNCH_STOCKFISH_KEY)).toBeNull();
            owners.resolve();
            catalog.resolve(engine);
            setEngines(store, []);
            await flush();
            expect(mocks.install).toHaveBeenCalledExactlyOnceWith(
                engine,
                `engine:${engine.downloadLink}`,
                undefined,
                store,
            );
            expect(store.get(automaticStockfishJobAtom)).toEqual({
                engine,
                progressId: `engine:${engine.downloadLink}`,
            });
            job.resolve(true);
            await flush();
            expect(snapshots).toEqual([
                { engine, progressId: `engine:${engine.downloadLink}` },
                null,
            ]);
        } finally {
            unsubscribe();
        }
    },
);

test("double invocation, including effect cleanup, starts one job", async () => {
    const store = readyStore();
    start(store)();
    start(store);
    start(store);
    await flush();
    expect(mocks.install).toHaveBeenCalledOnce();
    start(store);
    await flush();
    expect(mocks.install).toHaveBeenCalledOnce();
});

test("effect cleanup leaves an accepted job visible until its document-owned settlement", async () => {
    const store = readyStore();
    const job = deferred<boolean>();
    mocks.install.mockReturnValue(job.promise);
    const dispose = start(store);
    await flush();
    dispose();
    expect(store.get(automaticStockfishJobAtom)?.progressId).toBe(`engine:${engine.downloadLink}`);
    job.resolve(false);
    await flush();
    expect(store.get(automaticStockfishJobAtom)).toBeNull();
});

test.each([
    "non-empty",
    "removed-all",
    "failed-read",
    "catalog-missing",
    "catalog-failed",
    "owners-failed",
    "no-os",
])("startup cannot claim when %s", async (source) => {
    const store = readyStore();
    if (source === "non-empty") setEngines(store, [existing]);
    if (source === "removed-all") localStorage.setItem("engines", serializeStorageValue([]));
    if (source === "failed-read")
        vi.spyOn(store, "get").mockImplementation(() => {
            throw new Error("unreadable");
        });
    if (source === "catalog-missing") mocks.catalog.mockResolvedValue(undefined);
    if (source === "catalog-failed")
        mocks.catalog.mockRejectedValue(new Error("verification failed"));
    if (source === "owners-failed")
        mocks.owners.mockRejectedValue(new Error("reconciliation failed"));
    disposers.push(startFirstLaunchStockfish(source === "no-os" ? undefined : "linux", store));
    await flush();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(localStorage.getItem(FIRST_LAUNCH_STOCKFISH_KEY)).toBeNull();
});

test("current engine state is rechecked after catalog resolution", async () => {
    const store = readyStore();
    const catalog = deferred<DefaultEngine>();
    mocks.catalog.mockReturnValue(catalog.promise);
    start(store);
    setEngines(store, [existing]);
    catalog.resolve(engine);
    await flush();
    expect(mocks.install).not.toHaveBeenCalled();
});

test.each(["marker", "engines", "webdriver"])(
    "profile eligibility is rechecked at claim time: %s",
    async (source) => {
        const store = readyStore();
        const catalog = deferred<DefaultEngine>();
        mocks.catalog.mockReturnValue(catalog.promise);
        start(store);
        if (source === "marker") localStorage.setItem(FIRST_LAUNCH_STOCKFISH_KEY, "{broken");
        if (source === "engines") localStorage.setItem("engines", serializeStorageValue([]));
        if (source === "webdriver") vi.stubGlobal("navigator", { webdriver: true });
        catalog.resolve(engine);
        await flush();
        expect(mocks.install).not.toHaveBeenCalled();
    },
);

test.each(["owners", "catalog", "engine read"])(
    "a failed %s logs its normalized cause without notifying the user",
    async (source) => {
        const failure = new Error("startup failed at /private/profile/state.json");
        const store = readyStore();
        if (source === "owners") mocks.owners.mockRejectedValue(failure);
        if (source === "catalog") mocks.catalog.mockRejectedValue(failure);
        if (source === "engine read")
            vi.spyOn(store, "get").mockImplementation(() => {
                throw failure;
            });
        start(store);
        await flush();
        const normalized = normalizeError(failure).message;
        expect(normalized).not.toBe(failure.message);
        expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
            `first-launch Stockfish startup: ${normalized}`,
        );
        expect(mocks.notify).not.toHaveBeenCalled();
        expect(mocks.install).not.toHaveBeenCalled();
        expect(localStorage.getItem(FIRST_LAUNCH_STOCKFISH_KEY)).toBeNull();
    },
);

test("a failed engine read during hydration releases the subscription and refuses startup", async () => {
    const store = createStore();
    start(store);
    await flush();
    const get = vi.spyOn(store, "get").mockImplementation(() => {
        throw new Error("read failed");
    });
    setEngines(store, []);
    await flush();
    get.mockRestore();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(localStorage.getItem(FIRST_LAUNCH_STOCKFISH_KEY)).toBeNull();
});

test.each(["prerequisites", "hydration"])(
    "disposal during %s releases its owner and prevents a late start",
    async (pending) => {
        const store = createStore();
        const owners = deferred<void>();
        if (pending === "prerequisites") mocks.owners.mockReturnValue(owners.promise);
        const unsubscribe = vi.fn();
        const sub = store.sub;
        vi.spyOn(store, "sub").mockImplementation((...args) => {
            const dispose = sub(...args);
            return () => {
                unsubscribe();
                dispose();
            };
        });
        const dispose = start(store);
        await flush();
        dispose();
        owners.resolve();
        setEngines(store, []);
        await flush();
        expect(mocks.install).not.toHaveBeenCalled();
        expect(unsubscribe.mock.calls.length > 0).toBe(pending === "hydration");
    },
);

test.each(["success", "cancel", "failure", "busy"])(
    "%s ends automatic visibility and never retries",
    async (outcome) => {
        const store = readyStore();
        if (outcome === "busy") mocks.install.mockReturnValue(null);
        else mocks.install.mockResolvedValue(outcome === "success");
        const listener = vi.fn();
        const unsubscribe = store.sub(automaticStockfishJobAtom, listener);
        try {
            start(store);
            await flush();
            expect(store.get(automaticStockfishJobAtom)).toBeNull();
            expect(localStorage.getItem(FIRST_LAUNCH_STOCKFISH_KEY)).not.toBeNull();
            expect(listener).toHaveBeenCalledTimes(outcome === "busy" ? 0 : 2);
            start(store);
            await flush();
            expect(mocks.install).toHaveBeenCalledOnce();
        } finally {
            unsubscribe();
        }
    },
);
