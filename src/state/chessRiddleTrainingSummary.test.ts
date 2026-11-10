import { expect, test, vi } from "vitest";
import type { AccountStatus, TrainingVerdict } from "@/bindings";
import { createTrainingSummaryStore } from "./chessRiddleTrainingSummary";

const verdict: TrainingVerdict = {
    isCorrect: true,
    tooShort: false,
    ratingChange: 8,
    playerRating: 1508,
    puzzleRating: 1500,
    rated: true,
    ratingPending: false,
    feedbackCode: "correct",
    feedbackContext: null,
    correctVariation: [],
    incorrectMove: null,
    correctMove: null,
};
test("summary counts finished attempts and rated deltas across consumers and resets with account identity", async () => {
    const api = vi.fn().mockResolvedValue({
        status: "connected",
        account: { handle: "one", tactic_rating: 1500 },
        durability_uncertain: false,
    });
    const store = createTrainingSummaryStore(api);
    const one = vi.fn();
    const two = vi.fn();
    const stopOne = store.subscribe(one);
    const stopTwo = store.subscribe(two);
    await Promise.all([store.load(), store.load()]);
    expect(api).toHaveBeenCalledOnce();
    expect(store.get().rating).toBe(1500);
    store.record({ ...verdict, tooShort: true });
    expect(store.get().attempts).toBe(0);
    store.record(verdict);
    store.record({
        ...verdict,
        isCorrect: false,
        rated: false,
        ratingChange: -20,
        playerRating: null,
    });
    expect(store.get()).toEqual({
        handle: "one",
        attempts: 2,
        ratedAttempts: 1,
        correct: 1,
        change: 8,
        rating: 1500,
        error: null,
        loading: false,
    });
    store.accept({
        status: "connected",
        account: { handle: "one", username: "Renamed", plan: "gold", tactic_rating: 1400 },
        durability_uncertain: false,
    });
    expect(store.get().rating).toBe(1400);
    store.accept({
        status: "connected",
        account: { handle: "two", username: "Other", plan: "free", tactic_rating: 1700 },
        durability_uncertain: false,
    });
    expect(store.get()).toEqual({
        handle: "two",
        attempts: 0,
        ratedAttempts: 0,
        correct: 0,
        change: 0,
        rating: 1700,
        error: null,
        loading: false,
    });
    store.accept({ status: "disconnected" });
    expect(store.get()).toEqual({
        handle: null,
        attempts: 0,
        ratedAttempts: 0,
        correct: 0,
        change: 0,
        rating: null,
        error: null,
        loading: false,
    });
    expect(one.mock.calls.length).toBe(two.mock.calls.length);
    stopOne();
    stopTwo();
});

test("a zero rating change appears only after a finished rated attempt", () => {
    const store = createTrainingSummaryStore(vi.fn());
    store.record({ ...verdict, rated: false, ratingChange: 0 });
    expect(store.get().ratedAttempts).toBe(0);
    store.record({ ...verdict, tooShort: true, ratingChange: 0 });
    expect(store.get().ratedAttempts).toBe(0);
    store.record({ ...verdict, ratingChange: 0 });
    expect(store.get().ratedAttempts).toBe(1);
    expect(store.get().change).toBe(0);
});

test.each(["rejected", "unreadable", "raw"] as const)(
    "a %s profile read retains a typed error and a later load retries successfully",
    async (failure) => {
        const account = vi.fn<() => Promise<AccountStatus>>();
        if (failure === "unreadable")
            account.mockResolvedValueOnce({ status: "statusUnreadable", error: "storage" });
        else account.mockRejectedValueOnce(failure === "raw" ? "private server text" : "network");
        const store = createTrainingSummaryStore(account);
        await store.load();
        expect(store.get()).toMatchObject({
            rating: null,
            loading: false,
            error: failure === "unreadable" ? "storage" : failure === "raw" ? "server" : "network",
        });
        account.mockResolvedValueOnce({
            status: "connected",
            account: { handle: "account", username: "Player", plan: "gold", tactic_rating: 1550 },
            durability_uncertain: false,
        });
        await store.load();
        expect(account).toHaveBeenCalledTimes(2);
        expect(store.get()).toMatchObject({ rating: 1550, error: null, loading: false });
        await store.load();
        expect(account).toHaveBeenCalledTimes(2);
    },
);
