import { createStore } from "jotai";
import { beforeEach, expect, test, vi } from "vitest";
import type { DatabaseHandle } from "@/bindings";
import {
    explorerDatabaseFiltersAtom,
    forgetExplorerDatabaseAtom,
    referenceDbAtom,
    replaceExplorerDatabaseAtom,
    setExplorerFiltersAtom,
} from "./atoms";
import { defaultExplorerFilters, explorerFiltersFor } from "./explorerFilters";

const handle = (id: string): DatabaseHandle => ({ id: { id }, kind: "database" });
const stored = () => JSON.parse(localStorage.getItem("explorer-database-filters") ?? "null");

beforeEach(() => {
    localStorage.clear();
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

test("the stored list is read at document initialization, before any consumer mounts", async () => {
    localStorage.setItem(
        "explorer-database-filters",
        JSON.stringify([
            { database: "old", filters: { ...defaultExplorerFilters(), result: "draw" } },
        ]),
    );
    vi.resetModules();
    const atoms = await import("./atoms");
    const { createStore: createReloadedStore } = await import("jotai");
    const store = createReloadedStore();
    // Nothing subscribed: a migration on the Library page replaces the database.
    store.set(atoms.replaceExplorerDatabaseAtom, { from: handle("old"), to: handle("new") });
    expect(stored()).toEqual([
        { database: "new", filters: { ...defaultExplorerFilters(), result: "draw" } },
    ]);
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
