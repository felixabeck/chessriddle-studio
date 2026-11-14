import { expect, test, vi } from "vitest";
import type { DatabaseHandle } from "@/bindings";
import {
    databaseWriteRevision,
    recordDatabaseWrite,
    subscribeDatabaseWrites,
} from "./databaseWrites";

function handle(id: string): DatabaseHandle {
    return { id: { id }, kind: "database" };
}

test("revision starts at 0, increments per write, and keeps distinct handles independent", () => {
    const first = handle("writes-first");
    const second = handle("writes-second");
    expect(databaseWriteRevision(first)).toBe(0);
    expect(databaseWriteRevision(second)).toBe(0);
    expect(databaseWriteRevision(null)).toBe(0);
    expect(databaseWriteRevision(undefined)).toBe(0);

    recordDatabaseWrite([first]);
    expect(databaseWriteRevision(first)).toBe(1);
    expect(databaseWriteRevision(second)).toBe(0);

    recordDatabaseWrite([first, second, null, undefined]);
    expect(databaseWriteRevision(first)).toBe(2);
    expect(databaseWriteRevision(second)).toBe(1);
});

test("a duplicate handle in one call increments once", () => {
    const file = handle("writes-duplicate");
    expect(databaseWriteRevision(file)).toBe(0);
    recordDatabaseWrite([file, file, { ...file }]);
    expect(databaseWriteRevision(file)).toBe(1);
});

test("listeners are notified once per changing write and unsubscribe", () => {
    const file = handle("writes-listener");
    const listener = vi.fn();
    const unsubscribe = subscribeDatabaseWrites(listener);

    recordDatabaseWrite([null, undefined]);
    expect(listener).not.toHaveBeenCalled();

    recordDatabaseWrite([file, file]);
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    recordDatabaseWrite([file]);
    expect(listener).toHaveBeenCalledOnce();
    expect(databaseWriteRevision(file)).toBe(2);
});
