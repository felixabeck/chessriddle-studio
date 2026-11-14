import { useSyncExternalStore } from "react";
import type { DatabaseHandle } from "@/bindings";
import { capabilityKey } from "@/utils/pathCapabilities";

// Bound: one integer per database written in this renderer session. Entries are never
// removed; a recreated database at the same handle must not fall back to a revision
// whose SWR entry is stale.
const revisions = new Map<string, number>();
const listeners = new Set<() => void>();

function handleKey(handle: DatabaseHandle | null | undefined): string | null {
    if (handle == null) return null;
    try {
        return capabilityKey(handle);
    } catch {
        return null;
    }
}

export function recordDatabaseWrite(handles: readonly (DatabaseHandle | null | undefined)[]): void {
    const seen = new Set<string>();
    let changed = false;
    for (const handle of handles) {
        const key = handleKey(handle);
        if (key === null || seen.has(key)) continue;
        seen.add(key);
        revisions.set(key, (revisions.get(key) ?? 0) + 1);
        changed = true;
    }
    if (!changed) return;
    for (const listener of listeners) listener();
}

export function databaseWriteRevision(handle: DatabaseHandle | null | undefined): number {
    const key = handleKey(handle);
    if (key === null) return 0;
    return revisions.get(key) ?? 0;
}

export function subscribeDatabaseWrites(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useDatabaseWriteRevision(handle: DatabaseHandle | null | undefined): number {
    return useSyncExternalStore(
        subscribeDatabaseWrites,
        () => databaseWriteRevision(handle),
        () => databaseWriteRevision(handle),
    );
}
