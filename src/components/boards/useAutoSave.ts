import { useEffect } from "react";
import type { StoreApi } from "zustand";
import type { TreeStoreState } from "@/state/store/tree";
import { serializeStoreTree } from "@/utils/tabs";

/**
 * Autosaves a tree store while `enabled`, following the document's content rather than the edge
 * of its `dirty` flag. An edit that lands while a write is in flight, or after a write failed,
 * leaves `dirty` true, so a trigger keyed on `dirty` would never fire again for that tab.
 *
 * One write runs at a time per subscription. When a write settles, the loop writes again only
 * while the tree is still dirty and its PGN differs from the last attempt; the same serialized
 * tree is never written twice. Edits made during a write therefore get one follow-up write, a
 * failed write is retried only after a later edit changes the PGN, and a view-only change that
 * leaves the PGN unchanged (a live engine score) never writes. `saveToFile` orders writes that
 * overlap across subscriptions for the same store.
 *
 * The last attempt belongs to the store, not to the mounted board. A failed write can make the
 * file-freshness gate unmount and remount the board; a per-mount record would forget the failed
 * PGN and write it again on every remount, an endless write-and-notify loop.
 */
const lastAttempts = new WeakMap<StoreApi<TreeStoreState>, string>();

export function useAutoSave(
    store: StoreApi<TreeStoreState>,
    enabled: boolean,
    save: () => Promise<unknown>,
) {
    useEffect(() => {
        if (enabled) return;
        // While autosave is off nothing writes, but a clean tree still ends the record, so a
        // later return to the same PGN is written once autosave is back on.
        if (!store.getState().dirty) lastAttempts.delete(store);
        return store.subscribe((state) => {
            if (!state.dirty) lastAttempts.delete(store);
        });
    }, [store, enabled]);
    useEffect(() => {
        if (!enabled) return;
        let disposed = false;
        let running = false;
        const run = async () => {
            if (running) return;
            running = true;
            try {
                while (!disposed) {
                    if (!store.getState().dirty) {
                        lastAttempts.delete(store);
                        return;
                    }
                    const pgn = serializeStoreTree(store);
                    if (pgn === lastAttempts.get(store)) return;
                    lastAttempts.set(store, pgn);
                    await save();
                }
            } finally {
                running = false;
            }
        };
        void run();
        const unsubscribe = store.subscribe((state, previous) => {
            if (!state.dirty) {
                lastAttempts.delete(store);
            } else if (
                !previous.dirty ||
                state.root !== previous.root ||
                state.headers !== previous.headers
            ) {
                void run();
            }
        });
        return () => {
            disposed = true;
            unsubscribe();
        };
    }, [store, enabled, save]);
}
