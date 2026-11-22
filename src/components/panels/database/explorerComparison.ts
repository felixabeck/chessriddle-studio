import type { DatabaseHandle } from "@/bindings";
import { databaseHandleKey, type ManagedDatabaseInfo } from "@/utils/db";

export type ComparisonState =
    | { kind: "none" }
    | { kind: "source"; database: DatabaseHandle; title: string }
    | { kind: "unreadable"; name: string };

/**
 * What a panel shows as its second database. Only a local explorer with a primary database
 * compares, and only against another database of the current list. A tab pinned to a database
 * compares against its own `pinnedComparison` and never against the app-wide `stored` choice;
 * every other tab compares against `stored`. `databases` is `undefined` while the list is pending
 * or failed.
 */
export function comparisonState({
    local,
    pinned,
    primary,
    stored,
    pinnedComparison,
    databases,
}: {
    local: boolean;
    pinned: boolean;
    primary: DatabaseHandle | null;
    stored: DatabaseHandle | null;
    pinnedComparison: DatabaseHandle | null;
    databases: readonly ManagedDatabaseInfo[] | undefined;
}): ComparisonState {
    const candidate = pinned ? pinnedComparison : stored;
    if (!local || !primary || !candidate || !databases) return { kind: "none" };
    const key = databaseHandleKey(candidate);
    if (key === databaseHandleKey(primary)) return { kind: "none" };
    const entry = databases.find((database) => databaseHandleKey(database.file) === key);
    if (!entry) return { kind: "none" };
    return entry.type === "success"
        ? { kind: "source", database: entry.file, title: entry.title || entry.filename }
        : { kind: "unreadable", name: entry.filename };
}
