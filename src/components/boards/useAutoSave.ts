import { useEffect } from "react";
import type { StoreApi } from "zustand";
import type { TreeStoreState } from "@/state/store/tree";
import { serializeStoreTree } from "@/utils/tabs";

/**
 * Autosaves a tree store while `enabled`, following the document's content rather than the edge
 * of its `dirty` flag. An edit that lands while a write is in flight, or after a write failed,
 * leaves `dirty` true, so a trigger keyed on `dirty` would never fire again for that tab.
 *
 * One write runs at a time per subscription. When a write settles, the tree is written again only
 * while it is still dirty and its PGN differs from the last attempt. Edits made during a write
 * therefore get one follow-up write, a failed write is retried at most once per later edit (never
 * in a loop), and a view-only change that leaves the PGN unchanged (a live engine score) never
 * writes. `saveToFile` orders writes that overlap across subscriptions for the same store.
 */
export function useAutoSave(
    store: StoreApi<TreeStoreState>,
    enabled: boolean,
    save: () => Promise<unknown>,
) {
    useEffect(() => {
        if (!enabled) return;
        let disposed = false;
        let running = false;
        let lastAttempt: string | null = null;
        const run = async () => {
            if (running) return;
            running = true;
            try {
                while (!disposed) {
                    if (!store.getState().dirty) {
                        lastAttempt = null;
                        return;
                    }
                    const pgn = serializeStoreTree(store);
                    if (pgn === lastAttempt) return;
                    lastAttempt = pgn;
                    await save();
                }
            } finally {
                running = false;
            }
        };
        void run();
        const unsubscribe = store.subscribe((state, previous) => {
            if (!state.dirty) lastAttempt = null;
            else if (
                !previous.dirty ||
                state.root !== previous.root ||
                state.headers !== previous.headers
            )
                void run();
        });
        return () => {
            disposed = true;
            unsubscribe();
        };
    }, [store, enabled, save]);
}
