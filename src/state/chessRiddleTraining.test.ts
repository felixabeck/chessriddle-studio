import { INITIAL_FEN } from "chessops/fen";
import { expect, test, vi } from "vitest";
import type { TrainingPuzzle, TrainingVerdict } from "@/bindings";
import {
    createChessRiddleTrainingSessions,
    chessRiddleTrainingSessions,
} from "./chessRiddleTraining";
import { disposeTabAtoms } from "./atoms";
import {
    createTrainingSettingsStore,
    defaultTrainingSettings,
} from "./chessRiddleTrainingSettings";
import { createTrainingSummaryStore } from "./chessRiddleTrainingSummary";

const puzzle: TrainingPuzzle = {
    id: 1,
    source: "tactics",
    preEntranceFen: INITIAL_FEN,
    entranceMove: "e2e4",
    decisionFen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    sideToMove: "black",
    puzzleRating: 1500,
    solutionPlyCount: 3,
};
const verdict: TrainingVerdict = {
    isCorrect: true,
    tooShort: false,
    ratingChange: 8,
    playerRating: 1508,
    puzzleRating: 1500,
    rated: true,
    ratingPending: false,
    feedbackCode: "correct",
    feedbackContext: "analysis",
    correctVariation: ["e7e5", "g1f3", "b8c6"],
    incorrectMove: null,
    correctMove: null,
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}
function fixture(
    settingsApi = {
        chessriddleTrainingSettings: vi.fn().mockResolvedValue(defaultTrainingSettings),
        chessriddleSaveTrainingSettings: vi.fn().mockImplementation(async (settings) => settings),
        chessriddleTrainingMotifs: vi.fn().mockResolvedValue(["fork", "pin"]),
    },
) {
    const api = {
        chessriddleTrainingAvailable: vi.fn().mockResolvedValue(true),
        chessriddleTrainingNext: vi.fn().mockResolvedValue(puzzle),
        chessriddleMistakeCount: vi.fn().mockResolvedValue(2),
        chessriddleTrainingSubmit: vi.fn().mockResolvedValue(verdict),
        chessriddleOpenUpgrade: vi.fn().mockResolvedValue(undefined),
    };
    let clock = 0;
    let key = 0;
    const settings = createTrainingSettingsStore(settingsApi);
    const summary = createTrainingSummaryStore(
        vi.fn().mockResolvedValue({
            status: "connected",
            account: { handle: "account", tactic_rating: 1500 },
            durability_uncertain: false,
        }),
    );
    const sessions = createChessRiddleTrainingSessions(
        api,
        () => clock,
        () => `00000000-0000-4000-8000-${String(++key).padStart(12, "0")}`,
        settings,
        summary,
    );
    sessions.ensure("tab");
    return {
        api,
        sessions,
        settings,
        summary,
        tick: () => {
            clock += 1000;
        },
    };
}

test.each([false, true])(
    "first request waits for the saved settings and the catalogue, failed catalogue=%s",
    async (fails) => {
        const read = deferred<typeof defaultTrainingSettings>();
        const catalogue = deferred<string[]>();
        const settingsApi = {
            chessriddleTrainingSettings: vi.fn().mockReturnValue(read.promise),
            chessriddleSaveTrainingSettings: vi.fn(),
            chessriddleTrainingMotifs: vi.fn().mockReturnValue(catalogue.promise),
        };
        const { sessions, api, settings } = fixture(settingsApi);
        const first = sessions.next("tab");
        expect(api.chessriddleTrainingNext).not.toHaveBeenCalled();
        read.resolve({ ...defaultTrainingSettings, difficulty: 250, motif: "fork" });
        await vi.waitFor(() => expect(settings.get().status).toBe("ready"));
        expect(api.chessriddleTrainingNext).not.toHaveBeenCalled();
        if (fails) catalogue.reject("network");
        else catalogue.resolve(["fork"]);
        await first;
        expect(api.chessriddleTrainingNext).toHaveBeenLastCalledWith(
            "tactics",
            [],
            250,
            fails ? null : "fork",
        );
        expect(settings.get().values.motif).toBe("fork");
    },
);

test("two tabs share settings and summary while each submission keeps its request motif", async () => {
    const { sessions, settings, summary, api } = fixture({
        chessriddleTrainingSettings: vi
            .fn()
            .mockResolvedValue({ ...defaultTrainingSettings, motif: "fork" }),
        chessriddleSaveTrainingSettings: vi.fn().mockImplementation(async (values) => values),
        chessriddleTrainingMotifs: vi.fn().mockResolvedValue(["fork", "pin"]),
    });
    sessions.ensure("other");
    await Promise.all([sessions.next("tab"), sessions.next("other")]);
    settings.change({ motif: "pin", difficulty: 500 });
    await vi.waitFor(() => expect(settings.get().saving).toBe(false));
    await sessions.next("other");
    expect(api.chessriddleTrainingNext).toHaveBeenLastCalledWith("tactics", [], 500, "pin");
    fill(sessions);
    await sessions.submit("tab");
    expect(api.chessriddleTrainingSubmit).toHaveBeenLastCalledWith(
        expect.objectContaining({ motif: "fork" }),
    );
    expect(summary.get().attempts).toBe(1);
    await sessions.next("other", "mistakes");
    expect(api.chessriddleTrainingNext).toHaveBeenLastCalledWith("mistakes", [], null, null);
});

test.each(["notConnected", "authentication", "invalidGrant"])(
    "account error %s resets settings and summary",
    async (code) => {
        const { sessions, settings, summary, api } = fixture();
        await sessions.next("tab");
        fill(sessions);
        await sessions.submit("tab");
        api.chessriddleTrainingNext.mockRejectedValueOnce(code);
        await sessions.next("tab");
        expect(settings.get().status).toBe("idle");
        expect(summary.get().attempts).toBe(0);
    },
);
function fill(sessions: ReturnType<typeof fixture>["sessions"]) {
    for (const token of ["e7e5", "g1f3", "b8c6"]) sessions.append("tab", token);
}

test("a session and an in-flight submit survive view unmount and remount", async () => {
    const { api, sessions } = fixture();
    await sessions.next("tab");
    const first = vi.fn();
    const unsubscribe = sessions.subscribe("tab", first);
    fill(sessions);
    expect(first).toHaveBeenCalledTimes(3);
    const pending = deferred<TrainingVerdict>();
    api.chessriddleTrainingSubmit.mockReturnValueOnce(pending.promise);
    unsubscribe();
    const beforeSubmit = sessions.get("tab");
    const submitting = sessions.submit("tab");
    expect(first).toHaveBeenCalledTimes(3);
    expect(sessions.get("tab")?.puzzle).toBe(beforeSubmit?.puzzle);
    expect(sessions.get("tab")?.line).toBe(beforeSubmit?.line);
    expect(sessions.get("tab")?.elapsedStart).toBe(beforeSubmit?.elapsedStart);
    const second = vi.fn();
    const unsubscribeAgain = sessions.subscribe("tab", second);
    expect(sessions.get("tab")?.phase).toBe("submitting");
    expect(sessions.get("tab")?.line).toEqual(["e7e5", "g1f3", "b8c6"]);
    pending.resolve(verdict);
    await submitting;
    expect(sessions.get("tab")?.phase).toBe("verdict");
    expect(second).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledTimes(3);
    unsubscribeAgain();
});

test("a result arriving after a newer request is ignored", async () => {
    const { api, sessions } = fixture();
    const old = deferred<TrainingPuzzle>();
    api.chessriddleTrainingNext.mockReturnValueOnce(old.promise);
    const first = sessions.next("tab");
    await vi.waitFor(() => expect(api.chessriddleTrainingNext).toHaveBeenCalledOnce());
    api.chessriddleTrainingNext.mockResolvedValueOnce({ ...puzzle, id: 2 });
    await sessions.next("tab");
    old.resolve(puzzle);
    await first;
    expect(sessions.get("tab")?.puzzle?.id).toBe(2);
});

test("a closed tab ignores late fetch and submit results without recreating its session", async () => {
    const { api, sessions } = fixture();
    const old = deferred<TrainingPuzzle>();
    api.chessriddleTrainingNext.mockReturnValueOnce(old.promise);
    const fetching = sessions.next("tab");
    sessions.remove("tab");
    old.resolve(puzzle);
    await fetching;
    expect(sessions.get("tab")).toBeUndefined();
    sessions.ensure("tab");
    await sessions.next("tab");
    fill(sessions);
    const pending = deferred<TrainingVerdict>();
    api.chessriddleTrainingSubmit.mockReturnValueOnce(pending.promise);
    const submitting = sessions.submit("tab");
    sessions.remove("tab");
    sessions.ensure("tab");
    pending.resolve(verdict);
    await submitting;
    expect(sessions.get("tab")?.phase).toBe("idle");
    sessions.remove("tab");
    expect(sessions.get("tab")).toBeUndefined();
});

test.each(["network", "submissionInProgress", "engineBusy", "engineUnavailable"])(
    "Retry after %s reuses the frozen body and key and keeps the puzzle",
    async (code) => {
        const { api, sessions, tick } = fixture();
        await sessions.next("tab");
        fill(sessions);
        tick();
        api.chessriddleTrainingSubmit.mockRejectedValueOnce(code);
        await sessions.submit("tab");
        const body = api.chessriddleTrainingSubmit.mock.calls[0][0];
        expect(body.elapsedMs).toBe(1000);
        expect(Object.isFrozen(body)).toBe(true);
        expect(Object.isFrozen(body.line)).toBe(true);
        expect(sessions.get("tab")?.puzzle).toEqual(puzzle);
        expect(sessions.actions("tab")).toEqual(["retry"]);
        tick();
        sessions.undo("tab");
        await sessions.retry("tab");
        expect(api.chessriddleTrainingSubmit.mock.calls[1][0]).toBe(body);
        expect(api.chessriddleTrainingSubmit.mock.calls[1][0].elapsedMs).toBe(1000);
        expect(sessions.get("tab")?.phase).toBe("verdict");
    },
);

test("continuing after too-short at the cap extends the line and uses a new submission key", async () => {
    const { api, sessions, tick } = fixture();
    await sessions.next("tab");
    fill(sessions);
    api.chessriddleTrainingSubmit.mockResolvedValueOnce({
        ...verdict,
        isCorrect: false,
        tooShort: true,
        correctVariation: [],
    });
    await sessions.submit("tab");
    expect(sessions.actions("tab")).toEqual(["continue"]);
    expect(sessions.get("tab")).toMatchObject({ inputCap: 7, submitThreshold: 4 });
    await sessions.submit("tab");
    expect(api.chessriddleTrainingSubmit).toHaveBeenCalledTimes(1);
    sessions.append("tab", "f1c4");
    tick();
    await sessions.submit("tab");
    expect(api.chessriddleTrainingSubmit.mock.calls[1][0].line).toEqual([
        "e7e5",
        "g1f3",
        "b8c6",
        "f1c4",
    ]);
    expect(api.chessriddleTrainingSubmit.mock.calls[1][0].decisionFen).toBe(puzzle.decisionFen);
    expect(api.chessriddleTrainingSubmit.mock.calls[0][0].idempotencyKey).not.toBe(
        api.chessriddleTrainingSubmit.mock.calls[1][0].idempotencyKey,
    );
    await sessions.next("tab");
    expect(sessions.get("tab")).toMatchObject({
        inputCap: puzzle.solutionPlyCount,
        submitThreshold: puzzle.solutionPlyCount,
    });
});

test("invalidRequest after submit offers only Next and can fetch another puzzle", async () => {
    const { api, sessions } = fixture();
    await sessions.next("tab");
    fill(sessions);
    api.chessriddleTrainingSubmit.mockRejectedValueOnce("invalidRequest");
    await sessions.submit("tab");
    expect(sessions.actions("tab")).toEqual(["next"]);
    await sessions.retry("tab");
    expect(api.chessriddleTrainingSubmit).toHaveBeenCalledTimes(1);
    api.chessriddleTrainingNext.mockResolvedValueOnce({ ...puzzle, id: 2 });
    await sessions.next("tab");
    expect(sessions.get("tab")?.puzzle?.id).toBe(2);
    api.chessriddleTrainingNext.mockRejectedValueOnce("invalidRequest");
    await sessions.next("tab");
    expect(sessions.actions("tab")).toEqual([]);
});

test.each(["tactics", "mistakes"] as const)(
    "engineTimeout on %s offers only Next and advances with source-aware exclusions",
    async (source) => {
        const { api, sessions } = fixture();
        api.chessriddleTrainingNext.mockResolvedValueOnce({ ...puzzle, source });
        await sessions.next("tab", source);
        fill(sessions);
        api.chessriddleTrainingSubmit.mockRejectedValueOnce("engineTimeout");
        await sessions.submit("tab");
        expect(sessions.actions("tab")).toEqual(["next"]);
        await sessions.retry("tab");
        expect(api.chessriddleTrainingSubmit).toHaveBeenCalledTimes(1);
        api.chessriddleTrainingNext.mockResolvedValueOnce({ ...puzzle, id: 2, source });
        await sessions.next("tab");
        expect(api.chessriddleTrainingNext).toHaveBeenLastCalledWith(
            source,
            source === "mistakes" ? [1] : [],
            source === "tactics" ? 0 : null,
            null,
        );
        expect(sessions.get("tab")?.puzzle?.id).toBe(2);
    },
);

test("timed-out mistake exclusions drop the oldest id at fifty", async () => {
    const { api, sessions } = fixture();
    for (let id = 1; id <= 51; id++) {
        api.chessriddleTrainingNext.mockResolvedValueOnce({ ...puzzle, source: "mistakes", id });
        await sessions.next("tab", "mistakes");
        api.chessriddleTrainingSubmit.mockRejectedValueOnce("engineTimeout");
        await sessions.submit("tab", true);
    }
    expect(sessions.get("tab")?.timedOutMistakeIds).toEqual(
        Array.from({ length: 50 }, (_, i) => i + 2),
    );
    await sessions.next("tab");
    expect(api.chessriddleTrainingNext.mock.calls.at(-1)?.[1]).toEqual(
        Array.from({ length: 50 }, (_, i) => i + 2),
    );
});

test("availability, count, upgrade, reveal and empty mistakes have production session consumers", async () => {
    const { api, sessions } = fixture();
    expect(await sessions.available("tab")).toBe(true);
    await sessions.refreshMistakeCount("tab");
    expect(sessions.get("tab")?.mistakeCount).toBe(2);
    await sessions.openUpgrade("tab");
    expect(api.chessriddleOpenUpgrade).toHaveBeenCalledTimes(1);
    await sessions.next("tab");
    await sessions.submit("tab", true);
    expect(api.chessriddleTrainingSubmit.mock.calls[0][0]).toMatchObject({
        solutionShown: true,
        line: [],
    });
    api.chessriddleTrainingNext.mockResolvedValueOnce(null);
    await sessions.next("tab", "mistakes");
    expect(sessions.get("tab")?.phase).toBe("empty");
});

test("the real tab disposal path retires the production session", () => {
    chessRiddleTrainingSessions.ensure("closed-training");
    disposeTabAtoms("closed-training");
    expect(chessRiddleTrainingSessions.get("closed-training")).toBeUndefined();
});

test("availability on remount cannot strand a submit and count errors cannot replace timeout recovery", async () => {
    const { api, sessions } = fixture();
    await sessions.next("tab");
    fill(sessions);
    const pending = deferred<TrainingVerdict>();
    api.chessriddleTrainingSubmit.mockReturnValueOnce(pending.promise);
    const submitting = sessions.submit("tab");
    await sessions.available("tab");
    pending.resolve(verdict);
    await submitting;
    expect(sessions.get("tab")?.phase).toBe("verdict");
    await sessions.next("tab");
    fill(sessions);
    api.chessriddleTrainingSubmit.mockRejectedValueOnce("engineTimeout");
    await sessions.submit("tab");
    api.chessriddleMistakeCount.mockRejectedValueOnce("network");
    await sessions.refreshMistakeCount("tab");
    expect(sessions.actions("tab")).toEqual(["next"]);
    expect(sessions.get("tab")?.mistakeCountError).toBe("network");
});

test("late availability and count replies cannot recreate a closed tab", async () => {
    const { api, sessions } = fixture();
    const count = deferred<number>();
    const availability = deferred<boolean>();
    api.chessriddleMistakeCount.mockReturnValueOnce(count.promise);
    api.chessriddleTrainingAvailable.mockReturnValueOnce(availability.promise);
    const counting = sessions.refreshMistakeCount("tab");
    const checking = sessions.available("tab");
    sessions.remove("tab");
    count.resolve(1);
    availability.resolve(true);
    await Promise.all([counting, checking]);
    expect(sessions.get("tab")).toBeUndefined();
});

test("pending availability is shared and a failed read stays unknown with typed retry", async () => {
    const { api, sessions } = fixture();
    const pending = deferred<boolean>();
    api.chessriddleTrainingAvailable.mockReturnValueOnce(pending.promise);
    const first = sessions.available("tab");
    expect(sessions.available("tab")).toBe(first);
    expect(api.chessriddleTrainingAvailable).toHaveBeenCalledOnce();
    pending.resolve(false);
    expect(await first).toBe(false);
    expect(sessions.get("tab")?.available).toBe(false);
    sessions.remove("tab");
    api.chessriddleTrainingAvailable.mockRejectedValueOnce("server");
    expect(await sessions.available("tab")).toBeNull();
    expect(sessions.get("tab")).toMatchObject({
        available: null,
        phase: "error",
        error: "server",
        failedOperation: "availability",
    });
    expect(sessions.actions("tab")).toEqual(["retry"]);
    await sessions.retry("tab");
    expect(sessions.get("tab")).toMatchObject({ available: true, phase: "idle", error: null });
});

test.each(["notConnected", "authentication", "invalidGrant", "engineTimeout", "server"])(
    "failed availability always retries its read for typed %s",
    async (error) => {
        const { api, sessions } = fixture();
        api.chessriddleTrainingAvailable.mockRejectedValueOnce(error);
        await sessions.available("tab");
        expect(sessions.actions("tab")).toEqual(["retry"]);
        api.chessriddleTrainingAvailable.mockRejectedValueOnce("network");
        await sessions.retry("tab");
        expect(sessions.get("tab")).toMatchObject({
            error: "network",
            failedOperation: "availability",
        });
        await sessions.retry("tab");
        expect(sessions.get("tab")).toMatchObject({ available: true, phase: "idle", error: null });
        expect(api.chessriddleTrainingNext).not.toHaveBeenCalled();
    },
);

test("training state never writes web storage", async () => {
    const { sessions } = fixture();
    const write = vi.spyOn(Storage.prototype, "setItem");
    try {
        await sessions.next("tab");
        fill(sessions);
        await sessions.submit("tab");
        sessions.remove("tab");
        expect(write).not.toHaveBeenCalled();
    } finally {
        write.mockRestore();
    }
});
