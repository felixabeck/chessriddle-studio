import { createStore } from "jotai";
import { afterEach, expect, test, vi } from "vitest";
import {
    addRecentFileAtom,
    lastOpenedAtom,
    dedupeRecentFiles,
    recentFileKey,
    recentFileSchema,
    recentFilesAtom,
    updateRecentFilesAtom,
    type RecentFile,
} from "./atoms";
import { databaseGameOpenedKey } from "./lastOpened";

vi.mock("@/platform/tauri", () => ({ tauri: {} }));
const file: RecentFile = {
    name: "File",
    handle: { id: { id: "file" }, kind: "fileWorkspace" },
    type: "game",
    lastOpened: 1,
};
const database: Extract<RecentFile, { kind: "database" }> = {
    kind: "database",
    name: "White - Black",
    database: { id: { id: "file" }, kind: "database" },
    gameId: 1,
    lastOpened: 2,
};
const linked = {
    locator: {
        collection: "11111111-1111-4111-8111-111111111111",
        generation: "old",
        ordinal: 4,
        stamp: "a".repeat(64),
    },
    signature: {
        white: "White",
        black: "Black",
        event: "Event",
        site: null,
        date: null,
        round: null,
    },
};
afterEach(() => localStorage.clear());

test("old file shapes round-trip unchanged alongside database identities", () => {
    expect(recentFileSchema.parse(file)).toEqual(file);
    expect(recentFileSchema.parse(database)).toEqual(database);
    expect(recentFileSchema.parse({ ...database, linked })).toEqual({ ...database, linked });
    expect(recentFileSchema.safeParse({ ...database, gameId: "broken" }).success).toBe(false);
    expect(recentFileKey(file)).not.toBe(recentFileKey(database));
});

test("dedupe and the shared ten-entry cap span both entry kinds", () => {
    const store = createStore();
    store.set(recentFilesAtom, []);
    store.set(addRecentFileAtom, file);
    for (let i = 0; i < 12; i++) store.set(addRecentFileAtom, { ...database, gameId: i });
    expect(store.get(recentFilesAtom)).toHaveLength(10);
    store.set(addRecentFileAtom, file);
    store.set(addRecentFileAtom, { ...file, name: "Renamed" });
    expect(store.get(recentFilesAtom)).toHaveLength(10);
    expect(
        store.get(recentFilesAtom).filter((entry) => recentFileKey(entry) === recentFileKey(file)),
    ).toEqual([expect.objectContaining({ name: "Renamed" })]);
});

test("admitted file and database recents stamp opaque item keys, including their database", () => {
    const store = createStore();
    store.set(lastOpenedAtom, {});
    store.set(addRecentFileAtom, {
        ...file,
        handle: { ...file.handle, id: { id: "opaque-file" } },
    });
    store.set(addRecentFileAtom, database);
    const opened = store.get(lastOpenedAtom);
    expect(Object.keys(opened).sort()).toEqual(
        [
            "opaque-file",
            database.database.id.id,
            databaseGameOpenedKey(database.database, database.gameId),
        ].sort(),
    );
    expect(Object.values(opened).every((time) => time > 0)).toBe(true);
    expect(Object.keys(opened).join(" ")).not.toContain(database.name);
});

test("refresh dedupes normalized signatures by recency and ignores rebuilt locators", () => {
    const old = { ...database, linked };
    const saved = {
        ...database,
        gameId: 500,
        lastOpened: 3,
        linked: {
            locator: { ...linked.locator, generation: "new", ordinal: 1, stamp: "b".repeat(64) },
            signature: { ...linked.signature, site: "?", date: "????.??.??", round: "?" },
        },
    };
    expect(recentFileKey(old)).toBe(recentFileKey(saved));
    const distinct = {
        ...old,
        linked: { ...linked, signature: { ...linked.signature, white: "Other" } },
    };
    const store = createStore();
    store.set(updateRecentFilesAtom, [old, distinct, saved, file]);
    expect(store.get(recentFilesAtom)).toEqual([saved, distinct, file]);
    expect(dedupeRecentFiles([saved, old])).toEqual([saved]);
});
