import { createStore } from "jotai";
import { beforeEach, expect, test, vi } from "vitest";
import type { DatabaseHandle } from "@/bindings";

const native = vi.hoisted(() => ({ warn: vi.fn() }));
// An invalid stored value is reported through the native log, which has no transport here.
vi.mock("@/platform/native", () => ({
    error: vi.fn(),
    warn: native.warn,
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
}));
import {
    comparisonDbAtom,
    dbTypeFamily,
    explorerDatabaseFiltersAtom,
    forgetExplorerDatabaseAtom,
    pinnedExplorerFurtherColumnsFamily,
    referenceDbAtom,
    replaceExplorerDatabaseAtom,
    setExplorerFiltersAtom,
} from "./atoms";
import { defaultExplorerFilters, explorerFiltersFor } from "./explorerFilters";

const handle = (id: string): DatabaseHandle => ({ id: { id }, kind: "database" });
const stored = () => JSON.parse(localStorage.getItem("explorer-database-filters") ?? "null");

beforeEach(() => {
    localStorage.clear();
    native.warn.mockClear();
});

test("saved filters persist per database and hydrate in a fresh store", () => {
    const store = createStore();
    store.set(setExplorerFiltersAtom, {
        database: handle("mega"),
        update: (filters) => ({ ...filters, elo: [1900, 2500] }),
    });
    store.set(setExplorerFiltersAtom, {
        database: handle("corr"),
        update: { ...defaultExplorerFilters(), result: "draw" },
    });
    expect(stored()).toEqual([
        { database: "mega", filters: { ...defaultExplorerFilters(), elo: [1900, 2500] } },
        { database: "corr", filters: { ...defaultExplorerFilters(), result: "draw" } },
    ]);

    const reloaded = createStore();
    // A mounted consumer reads the stored list.
    reloaded.sub(explorerDatabaseFiltersAtom, () => {});
    const entries = reloaded.get(explorerDatabaseFiltersAtom);
    expect(explorerFiltersFor(entries, "mega").elo).toEqual([1900, 2500]);
    expect(explorerFiltersFor(entries, "corr").result).toBe("draw");
    expect(explorerFiltersFor(entries, "corr").elo).toBeUndefined();
});

test("an update function receives the database's current filters", () => {
    const store = createStore();
    const database = handle("mega");
    store.set(setExplorerFiltersAtom, {
        database,
        update: (filters) => ({ ...filters, result: "draw" }),
    });
    store.set(setExplorerFiltersAtom, {
        database,
        update: (filters) => ({ ...filters, exclude_fast_events: true }),
    });
    expect(explorerFiltersFor(store.get(explorerDatabaseFiltersAtom), "mega")).toEqual({
        ...defaultExplorerFilters(),
        result: "draw",
        exclude_fast_events: true,
    });
});

test("a corrupt stored element is dropped on hydration and the others survive", () => {
    localStorage.setItem(
        "explorer-database-filters",
        JSON.stringify([
            { database: "broken", filters: { result: "sometimes" } },
            { database: "mega", filters: { ...defaultExplorerFilters(), elo: [1900, 2500] } },
        ]),
    );
    const store = createStore();
    store.sub(explorerDatabaseFiltersAtom, () => {});
    expect(store.get(explorerDatabaseFiltersAtom)).toEqual([
        { database: "mega", filters: { ...defaultExplorerFilters(), elo: [1900, 2500] } },
    ]);
});

test("every stored explorer choice is read at document initialization, before any consumer mounts", async () => {
    localStorage.setItem(
        "explorer-database-filters",
        JSON.stringify([
            { database: "old", filters: { ...defaultExplorerFilters(), result: "draw" } },
        ]),
    );
    localStorage.setItem("reference-database", JSON.stringify(handle("old")));
    localStorage.setItem("comparison-database", JSON.stringify(handle("old")));
    vi.resetModules();
    const atoms = await import("./atoms");
    const { createStore: createReloadedStore } = await import("jotai");
    const store = createReloadedStore();
    // Nothing subscribed: a migration on the Accounts page replaces the database.
    store.set(atoms.replaceExplorerDatabaseAtom, { from: handle("old"), to: handle("new") });
    expect(stored()).toEqual([
        { database: "new", filters: { ...defaultExplorerFilters(), result: "draw" } },
    ]);
    expect(JSON.parse(localStorage.getItem("reference-database")!)).toEqual(handle("new"));
    expect(JSON.parse(localStorage.getItem("comparison-database")!)).toEqual(handle("new"));
});

test("an unmounted deletion forgets the stored comparison database", async () => {
    localStorage.setItem("comparison-database", JSON.stringify(handle("gone")));
    vi.resetModules();
    const atoms = await import("./atoms");
    const { createStore: createReloadedStore } = await import("jotai");
    const store = createReloadedStore();
    store.set(atoms.forgetExplorerDatabaseAtom, handle("gone"));
    expect(localStorage.getItem("comparison-database")).toBe("null");
});

test("a replaced database takes its filters and the reference with it", () => {
    const store = createStore();
    store.set(referenceDbAtom, handle("old"));
    store.set(setExplorerFiltersAtom, {
        database: handle("old"),
        update: { ...defaultExplorerFilters(), player: 4, color: "black", elo: [1900, 2500] },
    });
    store.set(replaceExplorerDatabaseAtom, { from: handle("old"), to: handle("new") });
    expect(store.get(referenceDbAtom)).toEqual(handle("new"));
    expect(stored()).toEqual([
        { database: "new", filters: { ...defaultExplorerFilters(), elo: [1900, 2500] } },
    ]);
    expect(JSON.parse(localStorage.getItem("reference-database")!)).toEqual(handle("new"));
});

test("replacing a database that is not the reference leaves the reference alone", () => {
    const store = createStore();
    store.set(referenceDbAtom, handle("reference"));
    store.set(setExplorerFiltersAtom, {
        database: handle("old"),
        update: { ...defaultExplorerFilters(), result: "draw" },
    });
    store.set(replaceExplorerDatabaseAtom, { from: handle("old"), to: handle("new") });
    expect(store.get(referenceDbAtom)).toEqual(handle("reference"));
    expect(explorerFiltersFor(store.get(explorerDatabaseFiltersAtom), "new").result).toBe("draw");

    store.set(replaceExplorerDatabaseAtom, { from: handle("reference"), to: handle("reference") });
    expect(store.get(referenceDbAtom)).toEqual(handle("reference"));
});

test("a replacement without saved filters writes no filter list", () => {
    const store = createStore();
    store.set(referenceDbAtom, handle("old"));
    store.set(replaceExplorerDatabaseAtom, { from: handle("old"), to: handle("new") });
    expect(store.get(referenceDbAtom)).toEqual(handle("new"));
    expect(localStorage.getItem("explorer-database-filters")).toBeNull();
});

test("a deleted database loses its saved filters and no other", () => {
    const store = createStore();
    for (const id of ["mega", "corr"]) {
        store.set(setExplorerFiltersAtom, {
            database: handle(id),
            update: { ...defaultExplorerFilters(), result: "draw" },
        });
    }
    store.set(forgetExplorerDatabaseAtom, handle("mega"));
    expect(stored().map((entry: { database: string }) => entry.database)).toEqual(["corr"]);
    store.set(forgetExplorerDatabaseAtom, handle("unknown"));
    expect(stored().map((entry: { database: string }) => entry.database)).toEqual(["corr"]);
});

test("the comparison database persists and follows its replacement", () => {
    const store = createStore();
    store.set(referenceDbAtom, handle("mega"));
    store.set(comparisonDbAtom, handle("old"));
    expect(JSON.parse(localStorage.getItem("comparison-database")!)).toEqual(handle("old"));
    store.set(replaceExplorerDatabaseAtom, { from: handle("old"), to: handle("new") });
    expect(store.get(comparisonDbAtom)).toEqual(handle("new"));
    expect(store.get(referenceDbAtom)).toEqual(handle("mega"));
    expect(JSON.parse(localStorage.getItem("comparison-database")!)).toEqual(handle("new"));

    const reloaded = createStore();
    reloaded.sub(comparisonDbAtom, () => {});
    expect(reloaded.get(comparisonDbAtom)).toEqual(handle("new"));
});

test("replacing the reference leaves another comparison database alone", () => {
    const store = createStore();
    store.set(referenceDbAtom, handle("old"));
    store.set(comparisonDbAtom, handle("corr"));
    store.set(replaceExplorerDatabaseAtom, { from: handle("old"), to: handle("new") });
    expect(store.get(referenceDbAtom)).toEqual(handle("new"));
    expect(store.get(comparisonDbAtom)).toEqual(handle("corr"));
});

test("a deleted comparison database is forgotten, another one is kept", () => {
    const store = createStore();
    store.set(comparisonDbAtom, handle("corr"));
    store.set(forgetExplorerDatabaseAtom, handle("mega"));
    expect(store.get(comparisonDbAtom)).toEqual(handle("corr"));
    store.set(forgetExplorerDatabaseAtom, handle("corr"));
    expect(store.get(comparisonDbAtom)).toBeNull();
    expect(localStorage.getItem("comparison-database")).toBe("null");
});

test("a corrupt stored comparison database reads as none", () => {
    localStorage.setItem("comparison-database", JSON.stringify({ id: "not-a-handle" }));
    const store = createStore();
    store.sub(comparisonDbAtom, () => {});
    expect(store.get(comparisonDbAtom)).toBeNull();
    expect(native.warn).toHaveBeenCalledWith("Invalid persisted value for comparison-database");
    expect(localStorage.getItem("comparison-database")).toBe("null");
});

test.each(["lch_all", "lch_master"] as const)(
    "a stored %s comparison source persists and is left alone when a database is replaced or deleted",
    (source) => {
        const store = createStore();
        store.set(comparisonDbAtom, source);
        expect(JSON.parse(localStorage.getItem("comparison-database")!)).toBe(source);
        store.set(replaceExplorerDatabaseAtom, { from: handle("old"), to: handle("new") });
        expect(store.get(comparisonDbAtom)).toBe(source);
        store.set(forgetExplorerDatabaseAtom, handle("old"));
        expect(store.get(comparisonDbAtom)).toBe(source);

        const reloaded = createStore();
        reloaded.sub(comparisonDbAtom, () => {});
        expect(reloaded.get(comparisonDbAtom)).toBe(source);
    },
);

test("a tab's first source and further columns write no storage key", () => {
    const localKeys = () =>
        Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    const sessionKeys = () =>
        Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i));
    const beforeLocal = localKeys();
    const beforeSession = sessionKeys();
    const store = createStore();
    store.set(dbTypeFamily("tab-1"), "lch_all");
    store.set(pinnedExplorerFurtherColumnsFamily("tab-1"), ["reference", "lch_master"]);
    expect(localKeys()).toEqual(beforeLocal);
    expect(sessionKeys()).toEqual(beforeSession);
});
