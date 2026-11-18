import type { DatabaseHandle } from "@/bindings";
import { databaseHandleKey, type ManagedDatabaseInfo } from "@/utils/db";

export type ComparisonState =
    | { kind: "none" }
    | { kind: "source"; database: DatabaseHandle; title: string }
    | { kind: "unreadable"; name: string };

/**
 * What a panel shows of the stored comparison database. Only an unpinned local explorer with a
 * primary database compares, and only against another database of the current list. `databases`
 * is `undefined` while the list is pending or failed.
 */
export function comparisonState({
    local,
    pinned,
    primary,
    stored,
    databases,
}: {
    local: boolean;
    pinned: boolean;
    primary: DatabaseHandle | null;
    stored: DatabaseHandle | null;
    databases: readonly ManagedDatabaseInfo[] | undefined;
}): ComparisonState {
    if (!local || pinned || !primary || !stored || !databases) return { kind: "none" };
    const key = databaseHandleKey(stored);
    if (key === databaseHandleKey(primary)) return { kind: "none" };
    const entry = databases.find((database) => databaseHandleKey(database.file) === key);
    if (!entry) return { kind: "none" };
    return entry.type === "success"
        ? { kind: "source", database: entry.file, title: entry.title || entry.filename }
        : { kind: "unreadable", name: entry.filename };
}
