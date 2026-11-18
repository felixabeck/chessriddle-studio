import { expect, test } from "vitest";
import type { DatabaseHandle } from "@/bindings";
import type { ManagedDatabaseInfo as DatabaseInfo } from "@/utils/db";
import { comparisonState } from "./explorerComparison";

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
    databases: [readable("mega"), readable("corr", "Correspondence")],
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
