import type { TFunction } from "i18next";
import { getDefaultStore } from "jotai";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { GameState as NativeGameState } from "@/bindings";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { tauri } from "@/platform/tauri";
import { closingTabsAtom, gameStateFamily } from "@/state/atoms";
import type { TreeStore } from "@/state/store/tree";
import { isPrefix } from "@/utils/misc";
import type { OpponentSettings } from "./OpponentForm";
import { getMainlineUcis } from "./gameSession";
import type { useNativeGameOwnership } from "./useNativeGameOwnership";

const RECONCILIATION_INTERVAL_MS = 1000;
const RECONCILIATION_INITIAL_BACKOFF_MS = 1000;
const RECONCILIATION_BACKOFF_FACTOR = 2;
const RECONCILIATION_MAX_BACKOFF_MS = 8000;

type ReconciliationState = {
    inFlight: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    poll: (() => Promise<void>) | null;
    schedule: ((delayMs: number) => void) | null;
    backoffMs: number;
    outageNotified: boolean;
    requestId: number;
    /** A response to a request numbered below this was issued for an earlier epoch. */
    validAfterRequestId: number;
};

export type GameReconciliation = {
    state: ReconciliationState;
    /** Stop the timer and drop the epoch's poll; an in-flight request still finishes. */
    stop: () => void;
    /** Also reject every response already in flight. */
    discardInFlight: () => void;
    /** Start the next UI session from a clean backoff. */
    invalidate: () => void;
};

/**
 * The poll's bookkeeping, created before the callbacks that invalidate a UI session so they can
 * reset it. `useGameReconciliation` runs the poll once the state it applies is defined.
 */
export function useReconciliationState(): GameReconciliation {
    const ref = useRef<GameReconciliation | null>(null);
    if (ref.current === null) {
        const state: ReconciliationState = {
            inFlight: false,
            timer: null,
            poll: null,
            schedule: null,
            backoffMs: RECONCILIATION_INITIAL_BACKOFF_MS,
            outageNotified: false,
            requestId: 0,
            validAfterRequestId: 0,
        };
        const stop = () => {
            if (state.timer !== null) {
                clearTimeout(state.timer);
                state.timer = null;
            }
            state.poll = null;
            state.schedule = null;
        };
        const discardInFlight = () => {
            stop();
            state.validAfterRequestId = state.requestId + 1;
        };
        const invalidate = () => {
            discardInFlight();
            state.backoffMs = RECONCILIATION_INITIAL_BACKOFF_MS;
            state.outageNotified = false;
        };
        ref.current = { state, stop, discardInFlight, invalidate };
    }
    return ref.current;
}

type Ownership = ReturnType<typeof useNativeGameOwnership>;

/**
 * While the tab plays a native game, poll its authoritative state every second, backing off
 * exponentially (to 8 s) while native is unreachable and reporting the outage once. A response
 * applies only to the epoch that requested it. In a player-vs-engine game a poll that reveals the
 * engine's reply also plays the human's stored premove.
 */
export function useGameReconciliation(
    reconciliation: GameReconciliation,
    {
        ownerTabId,
        gameState,
        isTabClosing,
        owner,
        applyAuthoritativeState,
        scheduleDeferredPremove,
        players,
        isPlayerVsEngine,
        store,
        tRef,
    }: {
        ownerTabId: string;
        gameState: string;
        isTabClosing: boolean;
        owner: Pick<
            Ownership,
            | "gameId"
            | "backendSession"
            | "currentSession"
            | "currentGeneration"
            | "ownsMountedOwner"
            | "ownsUiSession"
        >;
        applyAuthoritativeState: (
            state: NativeGameState,
            ownedGameId: string,
            ownedSession: bigint,
            generation: number,
        ) => boolean;
        scheduleDeferredPremove: (gameId: string, session: bigint, generation: number) => void;
        players: { white: OpponentSettings; black: OpponentSettings };
        isPlayerVsEngine: boolean;
        store: TreeStore;
        tRef: RefObject<TFunction>;
    },
) {
    const atomStore = getDefaultStore();
    const ownerGameStateAtom = useMemo(() => gameStateFamily(ownerTabId), [ownerTabId]);
    const {
        gameId,
        backendSession,
        currentSession,
        currentGeneration,
        ownsMountedOwner,
        ownsUiSession,
    } = owner;
    const { state } = reconciliation;

    useEffect(() => {
        if (gameState !== "playing" || !gameId) {
            reconciliation.stop();
            return;
        }
        const polledGameId = gameId;
        const expectedSession = currentSession();
        if (expectedSession === null) return;
        const generation = currentGeneration();

        if (isTabClosing) {
            reconciliation.discardInFlight();
            return;
        }

        const isCurrentEpoch = () =>
            ownsMountedOwner() &&
            !atomStore.get(closingTabsAtom).has(ownerTabId) &&
            ownsUiSession(polledGameId, expectedSession, generation) &&
            atomStore.get(ownerGameStateAtom) === "playing";

        if (!isCurrentEpoch()) return;

        const scheduleNext = (delayMs: number) => {
            if (!isCurrentEpoch() || state.timer !== null) return;
            state.timer = setTimeout(() => {
                state.timer = null;
                void state.poll?.();
            }, delayMs);
        };

        const poll = async () => {
            if (!isCurrentEpoch() || state.inFlight) return;
            state.inFlight = true;
            const requestId = ++state.requestId;
            let nextDelay = RECONCILIATION_INTERVAL_MS;

            try {
                const nativeState = await tauri.getGameState(polledGameId, expectedSession);
                const canApply = isCurrentEpoch() && requestId >= state.validAfterRequestId;

                if (canApply) {
                    state.backoffMs = RECONCILIATION_INITIAL_BACKOFF_MS;
                    state.outageNotified = false;

                    let eligibleForPremove = false;
                    if (nativeState.status === "playing" && isPlayerVsEngine) {
                        const nextTurnIsHuman =
                            nativeState.turn === "white"
                                ? players.white.type === "human"
                                : players.black.type === "human";
                        if (nextTurnIsHuman) {
                            const currentLiveMoves = getMainlineUcis(store.getState().root);
                            const backendUcis = nativeState.moves.map((m) => m.uci);
                            if (
                                backendUcis.length > currentLiveMoves.length &&
                                isPrefix(currentLiveMoves, backendUcis)
                            ) {
                                eligibleForPremove = true;
                            }
                        }
                    }

                    const applied = applyAuthoritativeState(
                        nativeState,
                        polledGameId,
                        expectedSession,
                        generation,
                    );

                    if (applied && eligibleForPremove) {
                        scheduleDeferredPremove(polledGameId, expectedSession, generation);
                    }
                }
            } catch (error) {
                const canReport = isCurrentEpoch() && requestId >= state.validAfterRequestId;

                if (canReport) {
                    if (!state.outageNotified) {
                        state.outageNotified = true;
                        notifyUnlessCancelled(tRef.current("Common.Error"), error);
                    }

                    nextDelay = state.backoffMs;
                    state.backoffMs = Math.min(
                        state.backoffMs * RECONCILIATION_BACKOFF_FACTOR,
                        RECONCILIATION_MAX_BACKOFF_MS,
                    );
                }
            } finally {
                state.inFlight = false;
                state.schedule?.(nextDelay);
            }
        };

        state.poll = poll;
        state.schedule = scheduleNext;

        if (!state.inFlight && state.timer === null) {
            void poll();
        }
    }, [
        gameId,
        gameState,
        applyAuthoritativeState,
        backendSession,
        currentSession,
        currentGeneration,
        ownsMountedOwner,
        ownsUiSession,
        atomStore,
        ownerGameStateAtom,
        ownerTabId,
        players,
        isPlayerVsEngine,
        scheduleDeferredPremove,
        store,
        isTabClosing,
        reconciliation,
        state,
        tRef,
    ]);
}
