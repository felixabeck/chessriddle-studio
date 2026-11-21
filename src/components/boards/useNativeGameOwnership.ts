import { getDefaultStore, useAtomValue } from "jotai";
import { useCallback, useMemo, useRef } from "react";
import { tauri } from "@/platform/tauri";
import { gameIdFamily, gameSessionFamily, gameStateFamily, tabsAtom } from "@/state/atoms";
import { abortExactGame } from "./gameSession";

/**
 * Which native game session a game tab owns, and the predicates every asynchronous result checks
 * before it may touch the tab.
 *
 * The identity is held twice on purpose: in refs, so a callback reads the value of this render,
 * and in the tab's atoms, so a result landing after a remount or a tab swap is compared against
 * what the store holds now. A result applies only while both agree with the identity it was
 * requested for and the UI epoch (`generationRef`) has not advanced.
 */
export function useNativeGameOwnership(ownerTabId: string) {
    const atomStore = getDefaultStore();
    const { ownerGameIdAtom, ownerSessionAtom, ownerGameStateAtom } = useMemo(
        () => ({
            ownerGameIdAtom: gameIdFamily(ownerTabId),
            ownerSessionAtom: gameSessionFamily(ownerTabId),
            ownerGameStateAtom: gameStateFamily(ownerTabId),
        }),
        [ownerTabId],
    );
    const gameId = useAtomValue(ownerGameIdAtom);
    const backendSession = useAtomValue(ownerSessionAtom);

    const liveGameIdRef = useRef<string | null>(gameId);
    liveGameIdRef.current = gameId;
    const backendSessionRef = useRef<bigint | null>(backendSession);
    backendSessionRef.current = backendSession;
    const generationRef = useRef(0);
    const mountedRef = useRef(true);
    mountedRef.current = true;

    const ownerTabExists = useCallback(
        () => atomStore.get(tabsAtom).some((tab) => tab.value === ownerTabId),
        [atomStore, ownerTabId],
    );
    const ownsMountedOwner = useCallback(
        () => mountedRef.current && ownerTabExists(),
        [ownerTabExists],
    );
    const ownsUiEpoch = useCallback(
        (generation: number) => ownsMountedOwner() && generationRef.current === generation,
        [ownsMountedOwner],
    );
    const ownsUiSession = useCallback(
        (ownedGameId: string, ownedSession: bigint, generation: number) =>
            ownsUiEpoch(generation) &&
            liveGameIdRef.current === ownedGameId &&
            backendSessionRef.current === ownedSession &&
            atomStore.get(ownerGameIdAtom) === ownedGameId &&
            atomStore.get(ownerSessionAtom) === ownedSession,
        [atomStore, ownerGameIdAtom, ownerSessionAtom, ownsUiEpoch],
    );
    const currentIdentity = useCallback(() => {
        const ownedGameId = liveGameIdRef.current;
        const ownedSession = backendSessionRef.current;
        return ownedGameId && ownedSession !== null
            ? { gameId: ownedGameId, session: ownedSession }
            : null;
    }, []);
    const currentSession = useCallback(() => backendSessionRef.current, []);
    const currentGeneration = useCallback(() => generationRef.current, []);
    const advanceGeneration = useCallback(() => {
        generationRef.current += 1;
    }, []);
    const setMounted = useCallback((mounted: boolean) => {
        mountedRef.current = mounted;
    }, []);
    const claimOwnership = useCallback(
        (ownedGameId: string, ownedSession: bigint) => {
            liveGameIdRef.current = ownedGameId;
            backendSessionRef.current = ownedSession;
            atomStore.set(ownerGameIdAtom, ownedGameId);
            atomStore.set(ownerSessionAtom, ownedSession);
        },
        [atomStore, ownerGameIdAtom, ownerSessionAtom],
    );
    const clearOwnershipIfMatches = useCallback(
        (ownedGameId: string, ownedSession: bigint) => {
            const refsMatch =
                liveGameIdRef.current === ownedGameId && backendSessionRef.current === ownedSession;
            const atomsMatch =
                atomStore.get(ownerGameIdAtom) === ownedGameId &&
                atomStore.get(ownerSessionAtom) === ownedSession;
            if (refsMatch) {
                liveGameIdRef.current = null;
                backendSessionRef.current = null;
            }
            if (atomsMatch) {
                atomStore.set(ownerGameIdAtom, null);
                atomStore.set(ownerSessionAtom, null);
            }
            return atomsMatch;
        },
        [atomStore, ownerGameIdAtom, ownerSessionAtom],
    );
    const cleanupExactIdentity = useCallback(
        async (
            ownedGameId: string,
            ownedSession: bigint,
            options: { finish?: true } = {},
        ): Promise<boolean> => {
            await abortExactGame(ownedGameId, ownedSession, (id, session) =>
                tauri.abortGame(id, session),
            );
            const retiredOwnedAtoms = clearOwnershipIfMatches(ownedGameId, ownedSession);
            if (options.finish && retiredOwnedAtoms && ownerTabExists()) {
                atomStore.set(ownerGameStateAtom, "gameOver");
            }
            return retiredOwnedAtoms;
        },
        [atomStore, clearOwnershipIfMatches, ownerGameStateAtom, ownerTabExists],
    );

    return {
        gameId,
        backendSession,
        currentIdentity,
        currentSession,
        currentGeneration,
        advanceGeneration,
        setMounted,
        ownsMountedOwner,
        ownsUiEpoch,
        ownsUiSession,
        claimOwnership,
        clearOwnershipIfMatches,
        cleanupExactIdentity,
    };
}
