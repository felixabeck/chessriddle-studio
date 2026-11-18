import { expect, test } from "vitest";
import {
    type ExplorerFilterEntry,
    type ExplorerFilters,
    MAX_EXPLORER_FILTER_DATABASES,
    defaultExplorerFilters,
    explorerFilterEntriesSchema,
    explorerFilterOwnersSchema,
    explorerFiltersFor,
    isDefaultExplorerFilters,
    normalizeExplorerFilters,
    replaceExplorerFilterDatabase,
    withExplorerFilters,
    withoutExplorerFilters,
} from "./explorerFilters";

const elo: ExplorerFilters = { ...defaultExplorerFilters(), elo: [1900, 2500] };
const entry = (database: string, filters: ExplorerFilters = elo): ExplorerFilterEntry => ({
    database,
    filters,
});

test("a valid stored list parses to itself, so a read never rewrites it", () => {
    const stored = [
        entry("a"),
        entry("b", {
            player: 7,
            color: "black",
            start_date: "2020.01.01",
            end_date: "2024.12.31",
            result: "draw",
            exclude_fast_events: true,
        }),
    ];
    expect(explorerFilterEntriesSchema.parse(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
});

test("an invalid or repeated element is dropped and the valid ones are kept", () => {
    const parsed = explorerFilterEntriesSchema.parse([
        entry("a"),
        { database: "bad-result", filters: { ...elo, result: "sometimes" } },
        { database: "", filters: elo },
        { database: "extra-key", filters: elo, name: "Mega" },
        { database: "bad-date", filters: { ...elo, start_date: "2020-01-01" } },
        { database: "off-switch", filters: { ...elo, exclude_fast_events: false } },
        "not an entry",
        null,
        entry("a", defaultExplorerFilters()),
        entry("b"),
    ]);
    expect(parsed).toEqual([entry("a"), entry("b")]);
});

test.each([null, "text", 3, { database: "a" }])(
    "a stored %j that is no list reads as empty",
    (raw) => {
        expect(explorerFilterEntriesSchema.parse(raw)).toEqual([]);
    },
);

test("a stored list beyond the bound keeps its most recently changed entries", () => {
    const stored = Array.from({ length: MAX_EXPLORER_FILTER_DATABASES + 3 }, (_, i) =>
        entry(`db-${i}`),
    );
    const parsed = explorerFilterEntriesSchema.parse(stored);
    expect(parsed).toHaveLength(MAX_EXPLORER_FILTER_DATABASES);
    expect(parsed[0].database).toBe("db-3");
    expect(parsed.at(-1)!.database).toBe(`db-${MAX_EXPLORER_FILTER_DATABASES + 2}`);
});

test("the owner schema keeps a database id whose filters the read schema would drop", () => {
    const stored = [entry("a"), { database: "b", filters: { result: "sometimes" } }];
    expect(explorerFilterOwnersSchema.parse(stored)).toEqual(stored);
    expect(explorerFilterOwnersSchema.safeParse([{ filters: elo }]).success).toBe(false);
    expect(explorerFilterOwnersSchema.safeParse({ a: elo }).success).toBe(false);
});

test("the normal form drops a full Elo band, an unset switch and a colour without a player", () => {
    expect(
        normalizeExplorerFilters({
            player: null,
            color: "black",
            start_date: undefined,
            end_date: undefined,
            result: "any",
            elo: [0, 3000],
            exclude_fast_events: false,
        }),
    ).toEqual(defaultExplorerFilters());
    expect(
        Object.keys(normalizeExplorerFilters({ ...defaultExplorerFilters(), elo: undefined })),
    ).toEqual(["player", "color", "result"]);
    const kept: ExplorerFilters = {
        player: 7,
        color: "black",
        start_date: "2020.01.01",
        end_date: "2024.12.31",
        result: "whitewon",
        elo: [0, 2990],
        exclude_fast_events: true,
    };
    expect(normalizeExplorerFilters(kept)).toEqual(kept);
});

test.each<[string, Partial<ExplorerFilters>, boolean]>([
    ["nothing set", {}, true],
    ["a full Elo band", { elo: [0, 3000] }, true],
    ["a colour without a player", { color: "black" }, true],
    ["an unset switch", { exclude_fast_events: false }, true],
    ["a player", { player: 1 }, false],
    ["a result", { result: "draw" }, false],
    ["a start date", { start_date: "2020.01.01" }, false],
    ["an end date", { end_date: "2020.01.01" }, false],
    ["an Elo band", { elo: [1, 3000] }, false],
    ["the switch", { exclude_fast_events: true }, false],
])("filters with %s are default: %s", (_name, change, expected) => {
    expect(isDefaultExplorerFilters({ ...defaultExplorerFilters(), ...change })).toBe(expected);
});

test("a database without an entry has the default filters", () => {
    expect(explorerFiltersFor([entry("a")], "b")).toEqual(defaultExplorerFilters());
    expect(explorerFiltersFor([entry("a")], null)).toEqual(defaultExplorerFilters());
    expect(explorerFiltersFor([entry("a")], "a")).toEqual(elo);
});

test("a changed entry is stored in normal form as the most recently changed one", () => {
    const entries = [entry("a"), entry("b")];
    const next = withExplorerFilters(entries, "a", { ...elo, color: "black", elo: [0, 2000] });
    expect(next).toEqual([entry("b"), entry("a", { ...defaultExplorerFilters(), elo: [0, 2000] })]);
    expect(entries).toEqual([entry("a"), entry("b")]);
});

test("a default filter set is removed instead of stored", () => {
    expect(withExplorerFilters([entry("a"), entry("b")], "a", { ...elo, elo: [0, 3000] })).toEqual([
        entry("b"),
    ]);
    expect(withExplorerFilters([], "a", defaultExplorerFilters())).toEqual([]);
});

test("a new entry beyond the bound evicts the least recently changed database", () => {
    const full = Array.from({ length: MAX_EXPLORER_FILTER_DATABASES }, (_, i) => entry(`db-${i}`));
    const touched = withExplorerFilters(full, "db-0", { ...elo, result: "draw" });
    expect(touched).toHaveLength(MAX_EXPLORER_FILTER_DATABASES);
    const next = withExplorerFilters(touched, "new", elo);
    expect(next).toHaveLength(MAX_EXPLORER_FILTER_DATABASES);
    expect(next.map((item) => item.database)).not.toContain("db-1");
    expect(next.map((item) => item.database)).toContain("db-0");
    expect(next.at(-1)).toEqual(entry("new"));
});

test("removing a database's entry leaves the others", () => {
    expect(withoutExplorerFilters([entry("a"), entry("b")], "a")).toEqual([entry("b")]);
    expect(withoutExplorerFilters([entry("a")], "missing")).toEqual([entry("a")]);
});

test("a replaced database's filters follow in place without its player", () => {
    const entries = [
        entry("first"),
        entry("old", { ...elo, player: 9, color: "black" }),
        entry("last"),
    ];
    expect(replaceExplorerFilterDatabase(entries, "old", "new")).toEqual([
        entry("first"),
        entry("new", elo),
        entry("last"),
    ]);
});

test("a replacement whose only filter was the player leaves no entry and no colour behind", () => {
    const entries = [entry("old", { ...defaultExplorerFilters(), player: 9, color: "black" })];
    expect(replaceExplorerFilterDatabase(entries, "old", "new")).toEqual([]);
});

test("filters the new database already has win and the old entry goes", () => {
    const kept = entry("new", { ...defaultExplorerFilters(), result: "draw" });
    expect(replaceExplorerFilterDatabase([entry("old"), kept], "old", "new")).toEqual([kept]);
});

test("a replacement in a full list evicts no other database", () => {
    const full = Array.from({ length: MAX_EXPLORER_FILTER_DATABASES }, (_, i) => entry(`db-${i}`));
    const next = replaceExplorerFilterDatabase(full, "db-40", "new");
    expect(next).toHaveLength(MAX_EXPLORER_FILTER_DATABASES);
    expect(next.map((item) => item.database)).toEqual(
        full.map((item) => (item.database === "db-40" ? "new" : item.database)),
    );
});

test("a replacement by itself or of an unknown database changes nothing", () => {
    const entries = [entry("a")];
    expect(replaceExplorerFilterDatabase(entries, "a", "a")).toEqual(entries);
    expect(replaceExplorerFilterDatabase(entries, "missing", "new")).toEqual(entries);
});
