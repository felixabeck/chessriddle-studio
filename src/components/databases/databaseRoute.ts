import {
    databaseHandleKey,
    sameDatabaseHandle,
    type ManagedDatabaseInfo,
    type SuccessDatabaseInfo,
} from "@/utils/db";
import { databaseHandleSchema } from "@/utils/pathCapabilities";

export type DatabaseRouteTarget =
    | { to: "/databases/$databaseId"; params: { databaseId: string } }
    | { to: "/library" };

export function databaseRouteTarget(
    database: SuccessDatabaseInfo | null | undefined,
): DatabaseRouteTarget {
    const parsed = databaseHandleSchema.safeParse(database?.file);
    return parsed.success
        ? { to: "/databases/$databaseId", params: { databaseId: databaseHandleKey(parsed.data) } }
        : { to: "/library" };
}

export type DatabaseRouteResolution =
    | { status: "loading" }
    | { status: "not_found" }
    | { status: "unavailable"; database: Extract<ManagedDatabaseInfo, { type: "error" }> }
    | { status: "synchronizing"; database: SuccessDatabaseInfo }
    | { status: "ready"; database: SuccessDatabaseInfo };

/**
 * The URL capability key is authoritative. A persisted view store is merely a
 * cache and must finish synchronizing before database children may render.
 */
export function resolveDatabaseRoute(
    databases: readonly ManagedDatabaseInfo[] | undefined,
    routeKey: string,
    active: SuccessDatabaseInfo | undefined,
): DatabaseRouteResolution {
    if (!databases) return { status: "loading" };
    const database = databases.find((candidate) => databaseHandleKey(candidate.file) === routeKey);
    if (!database) return { status: "not_found" };
    if (database.type === "error") {
        return database.transient || database.upgradeFailed
            ? { status: "unavailable", database }
            : { status: "not_found" };
    }
    return sameDatabaseHandle(database.file, active?.file)
        ? { status: "ready", database }
        : { status: "synchronizing", database };
}
