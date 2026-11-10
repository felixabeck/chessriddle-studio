import type { AccountStatus, TrainingVerdict } from "@/bindings";
import { tauri } from "@/platform/tauri";

type Summary = {
    handle: string | null;
    attempts: number;
    ratedAttempts: number;
    correct: number;
    change: number;
    rating: number | null;
};
export function createTrainingSummaryStore(account: typeof tauri.chessriddleAccount) {
    const empty = (): Summary => ({
        handle: null,
        attempts: 0,
        ratedAttempts: 0,
        correct: 0,
        change: 0,
        rating: null,
    });
    let state = empty();
    let generation = Symbol();
    let loaded = false;
    let pending: Promise<void> | null = null;
    let verdictRating: number | null = null;
    let profileRating: number | null = null;
    const listeners = new Set<() => void>();
    const publish = () => listeners.forEach((listener) => listener());
    const reset = () => {
        generation = Symbol();
        loaded = false;
        pending = null;
        verdictRating = null;
        profileRating = null;
        state = empty();
        publish();
    };
    const accept = (status: AccountStatus) => {
        if (status.status === "connected") {
            if (state.handle !== status.account.handle) {
                reset();
                state = { ...state, handle: status.account.handle };
            }
            loaded = true;
            profileRating = status.account.tactic_rating ?? null;
            state = { ...state, rating: verdictRating ?? profileRating };
            publish();
        } else if (status.status === "disconnected" || status.status === "reconnectNeeded") reset();
    };
    return {
        get: () => state,
        identity: () => generation,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        accept,
        reset,
        load() {
            if (pending) return pending;
            if (loaded) return Promise.resolve();
            loaded = true;
            const identity = generation;
            const promise = account()
                .then((status) => {
                    if (generation === identity) accept(status);
                })
                .catch(() => {
                    // The account card owns account errors. Missing profile leaves the rating as a dash.
                })
                .finally(() => {
                    if (pending === promise) pending = null;
                });
            pending = promise;
            return promise;
        },
        record(verdict: TrainingVerdict, identity = generation) {
            if (verdict.tooShort || identity !== generation) return;
            verdictRating = verdict.playerRating;
            state = {
                ...state,
                attempts: state.attempts + 1,
                ratedAttempts: state.ratedAttempts + Number(verdict.rated),
                correct: state.correct + Number(verdict.isCorrect),
                change: state.change + (verdict.rated ? verdict.ratingChange : 0),
                rating: verdict.playerRating ?? profileRating,
            };
            publish();
        },
    };
}
export const trainingSummary = createTrainingSummaryStore(() => tauri.chessriddleAccount());
