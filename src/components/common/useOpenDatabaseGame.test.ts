import { expect, test } from "vitest";
import type { DatabaseHandle } from "@/bindings";
import type { DatabaseList } from "@/utils/db";
import { listedDatabaseTitle } from "./useOpenDatabaseGame";

const handle = (id: string) => ({ id: { id }, kind: "database" }) as unknown as DatabaseHandle;

const listing = {
    databases: [
        { type: "error", file: handle("broken"), filename: "broken.db3", error: "x" },
        { type: "success", file: handle("games"), title: "My games" },
    ],
} as unknown as DatabaseList;

test("the listing's title is recorded for the handle that opened the game", () => {
    expect(listedDatabaseTitle(listing, handle("games"))).toBe("My games");
});

test("an unlisted, failed or absent database records no title", () => {
    expect(listedDatabaseTitle(listing, handle("other"))).toBeUndefined();
    expect(listedDatabaseTitle(listing, handle("broken"))).toBeUndefined();
    expect(listedDatabaseTitle(undefined, handle("games"))).toBeUndefined();
    expect(listedDatabaseTitle(listing, null)).toBeUndefined();
});
