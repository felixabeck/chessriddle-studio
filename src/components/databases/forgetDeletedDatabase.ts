import type { createStore } from "jotai";
import type { ScopedMutator } from "swr";
import type { DatabaseHandle } from "@/bindings";
import { tauri } from "@/platform/tauri";
import { forgetExplorerDatabaseAtom, referenceDbAtom } from "@/state/atoms";
import { activeDatabaseViewStore } from "@/state/store/database";
import { sameDatabaseHandle } from "@/utils/db";

type Store = ReturnType<typeof createStore>;

/**
 * Forgets every stored choice and cached result that names a deleted database: the reference
 * database, the explorer's saved filters and comparison, the open database view, and each
 * result cache bound to its handle. Whoever deletes a database calls this once it is gone.
 */
export function forgetDeletedDatabase(
    deleted: DatabaseHandle,
    store: Store,
    mutateCache: ScopedMutator,
): void {
    if (sameDatabaseHandle(store.get(referenceDbAtom), deleted)) {
        store.set(referenceDbAtom, null);
        void tauri.clearGames();
    }
    store.set(forgetExplorerDatabaseAtom, deleted);
    if (sameDatabaseHandle(activeDatabaseViewStore.getState().database?.file, deleted)) {
        activeDatabaseViewStore.getState().clearDatabase();
    }
    // Clear every result-set cache bound to this exact opaque handle. A later
    // revalidation must never resurrect data belonging to the deleted database.
    void mutateCache(
        (key) =>
            Array.isArray(key) &&
            key.length > 1 &&
            typeof key[1] === "object" &&
            key[1] !== null &&
            "id" in key[1] &&
            "kind" in key[1] &&
            key[1].kind === "database" &&
            sameDatabaseHandle(key[1] as DatabaseHandle, deleted),
        undefined,
        { revalidate: false },
    );
}
