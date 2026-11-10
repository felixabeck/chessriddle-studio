import { expect, test, vi } from "vitest";
import type { TrainingVerdict } from "@/bindings";
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
    });
    store.accept({ status: "disconnected" });
    expect(store.get()).toEqual({
        handle: null,
        attempts: 0,
        ratedAttempts: 0,
        correct: 0,
        change: 0,
        rating: null,
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
