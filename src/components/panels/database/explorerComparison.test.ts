import { expect, test } from "vitest";
import type { DatabaseHandle } from "@/bindings";
import type { ManagedDatabaseInfo as DatabaseInfo } from "@/utils/db";
import { comparisonState, pinnedReferenceState } from "./explorerComparison";

const handle = (id: string): DatabaseHandle => ({ id: { id }, kind: "database" });
const readable = (id: string, title = id): DatabaseInfo => ({
    type: "success",
    file: handle(id),
    title,
    filename: `${id}.db3`,
    description: "",
    indexed: true,
    player_count: 1,
    event_count: 1,
    game_count: 1,
    storage_size: "1",
});
const unreadable = (id: string): DatabaseInfo => ({
    type: "error",
    file: handle(id),
    filename: `${id}.db3`,
    indexed: false,
    error: "unreadable",
});
const shown = {
    local: true,
    pinned: false,
    primary: handle("mega"),
    stored: handle("corr"),
    pinnedComparison: null as DatabaseHandle | null,
    databases: [readable("mega"), readable("corr", "Correspondence")],
};
/** A tab pinned to the primary with its own second database; the app-wide choice is another one. */
const pinnedPair = {
    ...shown,
    pinned: true,
    pinnedComparison: handle("online") as DatabaseHandle | null,
    databases: [...shown.databases, readable("online", "Online games")],
};

test("a readable stored database beside another primary is the second source", () => {
    expect(comparisonState(shown)).toEqual({
        kind: "source",
        database: handle("corr"),
        title: "Correspondence",
    });
});

test("a source without a title is named by its file", () => {
    expect(
        comparisonState({ ...shown, databases: [readable("mega"), readable("corr", "")] }),
    ).toEqual({
        kind: "source",
        database: handle("corr"),
        title: "corr.db3",
    });
});

test("the list's own handle is used, not the stored copy", () => {
    const listed = readable("corr");
    const state = comparisonState({ ...shown, databases: [readable("mega"), listed] });
    expect(state.kind === "source" && state.database).toBe(listed.file);
});

test("a listed but unreadable stored database is reported as unreadable", () => {
    expect(
        comparisonState({ ...shown, databases: [readable("mega"), unreadable("corr")] }),
    ).toEqual({ kind: "unreadable", name: "corr.db3" });
});

test.each<[string, Partial<typeof shown> & { databases?: DatabaseInfo[] | undefined }]>([
    ["a Lichess source", { local: false }],
    ["a pinned tab", { pinned: true }],
    ["no primary database", { primary: null as unknown as DatabaseHandle }],
    ["no stored choice", { stored: null as unknown as DatabaseHandle }],
    ["a pending or failed list", { databases: undefined }],
    ["a stored database missing from the list", { databases: [readable("mega")] }],
    ["the primary database itself", { stored: handle("mega") }],
])("%s shows no comparison", (_name, change) => {
    expect(comparisonState({ ...shown, ...change })).toEqual({ kind: "none" });
});

test.each<[string, Partial<typeof shown>]>([
    ["a pinned tab", { pinned: true }],
    ["no primary database", { primary: null as unknown as DatabaseHandle }],
    ["the primary database itself", { stored: handle("mega"), primary: handle("mega") }],
])("an unreadable stored database stays silent for %s", (_name, change) => {
    const databases = [unreadable("mega"), unreadable("corr")];
    expect(comparisonState({ ...shown, databases, ...change })).toEqual({ kind: "none" });
});

test("a pinned tab compares against its own second database, not the app-wide choice", () => {
    expect(comparisonState(pinnedPair)).toEqual({
        kind: "source",
        database: handle("online"),
        title: "Online games",
    });
    expect(comparisonState({ ...pinnedPair, stored: null })).toEqual({
        kind: "source",
        database: handle("online"),
        title: "Online games",
    });
});

test("a pinned tab's listed but unreadable second database is reported as unreadable", () => {
    expect(
        comparisonState({
            ...pinnedPair,
            databases: [...shown.databases, unreadable("online")],
        }),
    ).toEqual({ kind: "unreadable", name: "online.db3" });
});

test.each<[string, Partial<typeof pinnedPair>]>([
    ["a second database missing from the list", { databases: shown.databases }],
    ["a second database equal to the pinned one", { pinnedComparison: handle("mega") }],
    ["no second database of its own", { pinnedComparison: null }],
    ["a Lichess source", { local: false }],
    ["a pending or failed list", { databases: undefined }],
])("a pinned tab with %s shows no comparison", (_name, change) => {
    expect(comparisonState({ ...pinnedPair, ...change })).toEqual({ kind: "none" });
});

test("an unpinned tab ignores a pinned second database", () => {
    expect(comparisonState({ ...pinnedPair, pinned: false })).toEqual({
        kind: "source",
        database: handle("corr"),
        title: "Correspondence",
    });
    expect(comparisonState({ ...pinnedPair, pinned: false, stored: null })).toEqual({
        kind: "none",
    });
});

const pinnedRef = {
    local: true,
    pinned: true,
    primary: handle("mega"),
    reference: handle("ref"),
    databases: [readable("mega", "Mega"), readable("ref", "Reference")],
};

test("a pinned tab shows a readable reference database", () => {
    expect(pinnedReferenceState(pinnedRef)).toEqual({
        kind: "source",
        database: handle("ref"),
        title: "Reference",
    });
});

test("a pinned tab accepts the same database as the pinned one for its reference source", () => {
    expect(pinnedReferenceState({ ...pinnedRef, reference: handle("mega") })).toEqual({
        kind: "source",
        database: handle("mega"),
        title: "Mega",
    });
});

test.each<[string, Partial<typeof pinnedRef> & { databases?: DatabaseInfo[] | undefined }]>([
    ["an unpinned tab", { pinned: false }],
    ["a Lichess source", { local: false }],
    ["no primary database", { primary: null as unknown as DatabaseHandle }],
    ["no reference database selected", { reference: null as unknown as DatabaseHandle }],
    ["a missing reference database", { databases: [readable("mega")] }],
    ["an unreadable reference database", { databases: [readable("mega"), unreadable("ref")] }],
    ["a pending or failed list", { databases: undefined }],
])("pinnedReferenceState stays absent without error for %s", (_name, change) => {
    expect(pinnedReferenceState({ ...pinnedRef, ...change })).toEqual({ kind: "none" });
});
