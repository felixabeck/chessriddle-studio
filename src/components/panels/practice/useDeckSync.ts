import { useAtom, useStore as useAtomStore } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { buildFromTree, syncDeck } from "@/components/files/opening";
import { deckAtomFamily, practiceSegmentGateFamily, tabsAtom } from "@/state/atoms";
import type { GameHeaders, TreeNode } from "@/utils/treeReducer";
import { collectRetainedPracticePositions } from "./retainedPositions";

export const SYNC_MESSAGE_DISMISS_MS = 5000;

export type DeckIdentity = {
    file: string;
    game: number;
};

export type SyncMessage = {
    added: number;
    removed: number;
};

export type UseDeckSyncParams = {
    root: TreeNode;
    headers: GameHeaders;
    treeViewDeferred: boolean;
    deckIdentity: DeckIdentity;
    currentTabId: string | undefined;
};

export function useDeckSync({
    root,
    headers,
    treeViewDeferred,
    deckIdentity,
    currentTabId,
}: UseDeckSyncParams) {
    const atomStore = useAtomStore();
    const [deck, setDeck] = useAtom(deckAtomFamily(deckIdentity));

    const [syncMessage, setSyncMessage] = useState<SyncMessage | null>(null);
    const [syncedWithTreeAndScope, setSyncedWithTreeAndScope] = useState(false);
    const deckPositionsRef = useRef(deck.positions);
    deckPositionsRef.current = deck.positions;
    // The tree and deck scope (orientation, start) last diffed into the deck. A remount renders
    // the atom's previous "ready" snapshot before hydration starts, and a sync diffed from it is
    // dropped while the deck loads, so a new hydration (loading or read-failed) forgets it and the
    // hydrated deck is diffed again. Ratings do not reset it: re-diffing the whole tree after every
    // rating would cost O(tree).
    const lastSyncedRef = useRef<{ root: typeof root; scope: string } | null>(null);
    const syncMessageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearSyncMessageTimer = useCallback(() => {
        if (syncMessageTimerRef.current) clearTimeout(syncMessageTimerRef.current);
        syncMessageTimerRef.current = null;
    }, []);

    useEffect(() => {
        if (deck.status === "loading" || deck.status === "read-failed") {
            lastSyncedRef.current = null;
            setSyncedWithTreeAndScope(false);
            return;
        }
        if (treeViewDeferred || deckIdentity.file === "") {
            setSyncedWithTreeAndScope(false);
            return;
        }
        if (deck.status !== "ready") {
            const orientation = headers.orientation || "white";
            const start = headers.start || [];
            const scope = `${orientation}:${start.join(",")}`;
            const lastSynced = lastSyncedRef.current;
            setSyncedWithTreeAndScope(
                !!lastSynced && lastSynced.root === root && lastSynced.scope === scope,
            );
            return;
        }

        const orientation = headers.orientation || "white";
        const start = headers.start || [];
        const scope = `${orientation}:${start.join(",")}`;
        const lastSynced = lastSyncedRef.current;
        if (lastSynced?.root === root && lastSynced.scope === scope) {
            setSyncedWithTreeAndScope(true);
            return;
        }

        if (deckPositionsRef.current.length === 0) {
            const newDeck = buildFromTree(root, orientation, start);
            if (newDeck.length > 0) setDeck({ type: "sync", positions: newDeck });
        } else {
            // Sync existing deck with tree changes
            const { positions, added, removed, updated, reordered } = syncDeck(
                deckPositionsRef.current,
                root,
                orientation,
                start,
                () =>
                    collectRetainedPracticePositions({
                        tabs: atomStore.get(tabsAtom),
                        currentTabId,
                        identity: { file: deckIdentity.file, game: deckIdentity.game },
                        existing: deckPositionsRef.current,
                    }),
            );
            if (added > 0 || removed > 0 || updated > 0 || reordered) {
                setDeck((prev) => ({ ...prev, positions }));
            }
            if (added > 0 || removed > 0) {
                setSyncMessage({ added, removed });
                if (syncMessageTimerRef.current) clearTimeout(syncMessageTimerRef.current);
                syncMessageTimerRef.current = setTimeout(() => {
                    syncMessageTimerRef.current = null;
                    setSyncMessage(null);
                }, SYNC_MESSAGE_DISMISS_MS);
            }
        }
        lastSyncedRef.current = { root, scope };
        setSyncedWithTreeAndScope(true);
    }, [
        root,
        headers,
        setDeck,
        deck.status,
        deckIdentity.file,
        deckIdentity.game,
        treeViewDeferred,
        atomStore,
        currentTabId,
    ]);

    useEffect(() => {
        if (!currentTabId) return;
        return () => {
            atomStore.set(practiceSegmentGateFamily(currentTabId), null);
        };
    }, [atomStore, currentTabId]);

    useEffect(() => {
        if (!currentTabId) return;
        atomStore.set(practiceSegmentGateFamily(currentTabId), {
            synced: syncedWithTreeAndScope,
            status: deck.status,
        });
    }, [atomStore, currentTabId, syncedWithTreeAndScope, deck.status]);

    return {
        deck,
        setDeck,
        syncMessage,
        setSyncMessage,
        clearSyncMessageTimer,
        syncedWithTreeAndScope,
    };
}

export type UseDeckSyncResult = ReturnType<typeof useDeckSync>;
