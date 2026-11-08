import { describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@/bindings";
import type { ManagedDatabaseInfo, SuccessDatabaseInfo } from "@/utils/db";
import { databaseRouteTarget, resolveDatabaseRoute } from "./databaseRoute";

describe("database route target", () => {
    it("targets the database view using the handle key", () => {
        expect(databaseRouteTarget(database("db-1"))).toEqual({
            to: "/databases/$databaseId",
            params: { databaseId: "db-1" },
        });
    });

    it.each([undefined, null, {}, { file: {} }, { file: { id: { id: "" }, kind: "database" } }])(
        "safely targets the overview for %j",
        (value) => {
            const target = () =>
                databaseRouteTarget(value as SuccessDatabaseInfo | null | undefined);
            expect(target).not.toThrow();
            expect(target()).toEqual({ to: "/library" });
        },
    );
});

const handle = (id: string): DatabaseHandle => ({ id: { id }, kind: "database" });
const database = (id: string, title = "Same title"): SuccessDatabaseInfo => ({
    type: "success",
    file: handle(id),
    filename: `${id}.db3`,
    title,
    description: "",
    player_count: 0,
    event_count: 0,
    game_count: 0,
    storage_size: "0",
    indexed: false,
});

describe("database route resolution", () => {
    it.each([
        { transient: "upgrading" as const },
        { transient: "busy" as const },
        { upgradeFailed: true as const },
    ])("keeps an unavailable route for %j even without a persisted selection", (state) => {
        const row: ManagedDatabaseInfo = {
            type: "error",
            file: handle("held"),
            filename: "held.db3",
            error: "Unavailable explanation",
            indexed: false,
            ...state,
        };
        for (const active of [undefined, database("held"), database("other")]) {
            expect(resolveDatabaseRoute([row], "held", active)).toEqual({
                status: "unavailable",
                database: row,
            });
        }
    });
    it("does not open an error entry even when its route key and persisted handle match", () => {
        const staleDatabase = database("broken");
        expect(
            resolveDatabaseRoute(
                [
                    {
                        type: "error",
                        file: staleDatabase.file,
                        filename: "broken.db3",
                        error: "unfinished",
                        indexed: false,
                    },
                ],
                "broken",
                staleDatabase,
            ),
        ).toEqual({ status: "not_found" });
    });
    it("never renders persisted database B for a deep-link to database A, even with the same title", () => {
        const routeDatabase = database("A");
        const persistedDatabase = database("B");
        const result = resolveDatabaseRoute(
            [routeDatabase, persistedDatabase],
            "A",
            persistedDatabase,
        );
        expect(result).toEqual({ status: "synchronizing", database: routeDatabase });
    });

    it("becomes renderable only after the active cache contains the exact route handle", () => {
        const routeDatabase = database("A");
        expect(resolveDatabaseRoute([routeDatabase], "A", routeDatabase)).toEqual({
            status: "ready",
            database: routeDatabase,
        });
    });

    it("requires a fresh synchronization when navigating back to a different opaque database", () => {
        const first = database("first", "Same title");
        const second = database("second", "Same title");
        expect(resolveDatabaseRoute([first, second], "second", first)).toMatchObject({
            status: "synchronizing",
            database: second,
        });
        expect(resolveDatabaseRoute([first, second], "first", second)).toMatchObject({
            status: "synchronizing",
            database: first,
        });
    });

    it("does not reuse a deleted route from persisted state", () => {
        const staleDatabase = database("deleted");
        const result = resolveDatabaseRoute([] as ManagedDatabaseInfo[], "deleted", staleDatabase);
        expect(result).toEqual({ status: "not_found" });
    });
});
