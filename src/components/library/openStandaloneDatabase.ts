import {
    databaseRouteTarget,
    type DatabaseRouteTarget,
} from "@/components/databases/databaseRoute";
import { activeDatabaseViewStore } from "@/state/store/database";
import type { SuccessDatabaseInfo } from "@/utils/db";

export function openStandaloneDatabase(
    database: SuccessDatabaseInfo,
    navigate: (target: DatabaseRouteTarget) => unknown,
): boolean {
    if (activeDatabaseViewStore.getState().setDatabase(database) !== true) return false;
    void navigate(databaseRouteTarget(database));
    return true;
}
