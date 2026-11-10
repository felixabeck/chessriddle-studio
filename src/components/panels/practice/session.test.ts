import { parseUci } from "chessops";
import { createEmptyCard } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import { buildFromTree, type Position } from "@/components/files/opening";
import { createNode, defaultTree, getBoardState, getNodeAtPath } from "@/utils/treeReducer";
import {
    advancePracticeQueue,
    buildPracticeQueue,
    buildPracticeReplay,
    canSubmitPracticeMove,
    emptyPracticeStats,
    getAutomaticPracticeGrade,
    idlePracticeSession,
    isPracticePhase,
    practiceSessionReducer,
    PRACTICE_REPLAY_STEP_MS,
    PRACTICE_SLOW_ANSWER_MS,
    type PracticeEvent,
    type PracticeSession,
} from "./session";

function waitingSession(token: number, fen: string, positionKey: string): PracticeSession {
    const replay = practiceSessionReducer(idlePracticeSession(), {
        type: "replay",
        token,
        fen,
        positionKey,
    });
    return practiceSessionReducer(replay, { type: "replayed", token, learning: false });
}

describe("practiceSessionReducer", () => {
    it("advances only a correctly answered card, and only to advancing", () => {
        const waiting = waitingSession(3, "fen-a", "board-a");
        const correct = practiceSessionReducer(waiting, {
            type: "correct",
            token: 3,
            answer: "e4",
            timeTaken: 7,
        });

        expect(practiceSessionReducer(correct, { type: "advance", token: 3 })).toEqual({
            ...correct,
            phase: "advancing",
        });
        // A rating arriving while waiting or after a miss must not skip the card.
        expect(practiceSessionReducer(waiting, { type: "advance", token: 3 })).toBe(waiting);
        const retry = practiceSessionReducer(waiting, {
            type: "wrong",
            token: 3,
            answer: "e4",
            playedMove: "d4",
            timeTaken: 9,
        });
        expect(practiceSessionReducer(retry, { type: "advance", token: 3 })).toBe(retry);
        expect(practiceSessionReducer(correct, { type: "advance", token: 4 })).toBe(correct);
    });

    it("allows one retry before revealing and ignores further wrong answers", () => {
        const waiting = waitingSession(1, "fen-a", "board-a");
        const retry = practiceSessionReducer(waiting, {
            type: "wrong",
            token: 1,
            answer: "e4",
            playedMove: "d4",
            timeTaken: 42,
        });
        expect(retry.phase).toBe("retry");
        const revealed = practiceSessionReducer(retry, {
            type: "wrong",
            token: 1,
            answer: "e4",
            playedMove: "c4",
            timeTaken: 43,
        });
        expect(revealed.phase).toBe("revealed");
        expect(
            practiceSessionReducer(revealed, {
                type: "wrong",
                token: 1,
                answer: "e4",
                playedMove: "d4",
                timeTaken: 44,
            }),
        ).toBe(revealed);
    });

    it("keeps correct and retry outcomes semantically distinct", () => {
        const waiting = waitingSession(5, "fen-a", "board-a");

        expect(
            practiceSessionReducer(waiting, {
                type: "correct",
                token: 5,
                answer: "Nf3",
                timeTaken: 12,
            }),
        ).toEqual({
            phase: "correct",
            token: 5,
            currentFen: "fen-a",
            positionKey: "board-a",
            answer: "Nf3",
            timeTaken: 12,
        });
        expect(
            practiceSessionReducer(waiting, {
                type: "wrong",
                token: 5,
                answer: "Nf3",
                playedMove: "Nc3",
                timeTaken: 12,
            }),
        ).toEqual({
            phase: "retry",
            token: 5,
            currentFen: "fen-a",
            positionKey: "board-a",
            answer: "Nf3",
            playedMove: "Nc3",
            timeTaken: 12,
        });
    });

    it("rejects delayed callbacks from stopped or switched sessions", () => {
        const waiting = waitingSession(3, "fen-a", "board-a");
        const stopped = practiceSessionReducer(waiting, { type: "end", token: 3 });
        expect(
            practiceSessionReducer(stopped, {
                type: "correct",
                token: 3,
                answer: "e4",
                timeTaken: 20,
            }),
        ).toEqual(stopped);
        expect(
            practiceSessionReducer(waiting, {
                type: "correct",
                token: 4,
                answer: "e4",
                timeTaken: 20,
            }),
        ).toBe(waiting);
    });

    it("completion clears every active-card field before a later run starts", () => {
        const waiting = waitingSession(7, "history-card", "board-a");
        const completed = practiceSessionReducer(
            practiceSessionReducer(waiting, {
                type: "correct",
                token: 7,
                answer: "Nf3",
                timeTaken: 100,
            }),
            { type: "end", token: 7 },
        );
        expect(completed).toEqual({ phase: "idle", token: 7 });
    });

    it("only unlocks the board for the current waiting card", () => {
        const waiting = waitingSession(1, "fen-a", "board-a");
        expect(canSubmitPracticeMove(waiting, "fen-a")).toBe(true);
        expect(canSubmitPracticeMove(waiting, "fen-b")).toBe(false);
        expect(canSubmitPracticeMove({ ...waiting, phase: "correct" }, "fen-a")).toBe(false);
    });

    it.each(["KQkq e3", "HAha -"])(
        "keeps exact currentFen authority when %s cards share a position key",
        (rightsAndEp) => {
            const board = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b";
            const fen = `${board} ${rightsAndEp} 0 1`;
            const canonical = `${board} KQkq - 0 1`;
            expect(getBoardState(fen)).toBe(getBoardState(canonical));
            const waiting = waitingSession(7, fen, getBoardState(fen));
            expect(canSubmitPracticeMove(waiting, fen)).toBe(true);
            expect(canSubmitPracticeMove(waiting, canonical)).toBe(false);
            expect(waiting.currentFen).toBe(fen);
        },
    );

    it("creates empty statistics and identifies every non-idle practice phase", () => {
        expect(idlePracticeSession()).toEqual({ phase: "idle", token: 0 });
        expect(idlePracticeSession(23)).toEqual({ phase: "idle", token: 23 });
        expect(emptyPracticeStats()).toEqual({
            mode: "anki",
            remainingPositionKeys: [],
            reappendedPositionKeys: [],
            introducedPositionKeys: [],
            correct: 0,
            incorrect: 0,
            streak: 0,
            bestStreak: 0,
        });
        expect(isPracticePhase("idle")).toBe(false);
        expect(isPracticePhase("waiting")).toBe(true);
        expect(isPracticePhase("correct")).toBe(true);
        expect(isPracticePhase("retry")).toBe(true);
    });
});

describe("practice queue", () => {
    const now = new Date("2026-11-10T12:00:00Z");
    const positions: Position[] = [
        { fen: "8/8/8/8/8/8/P7/K6k w - - 0 1", reps: 0, due: now },
        { fen: "8/8/8/8/8/8/1P6/K6k w - - 0 1", reps: 2, due: now },
        { fen: "8/8/8/8/8/8/2P5/K6k w - - 0 1", reps: 3, due: new Date(now.getTime() + 1) },
        { fen: "8/8/8/8/8/8/3P4/K6k w - - 0 1", reps: 0, due: new Date(now.getTime() + 1) },
        { fen: "8/8/8/8/8/8/4P3/K6k w - - 0 1", reps: 0, due: now },
        { fen: "8/8/8/8/8/8/5P2/K6k w - - 0 1", reps: 1, due: new Date(now.getTime() - 1) },
    ].map(({ fen, reps, due }) => ({
        fen,
        answer: "e4",
        card: { ...createEmptyCard(now), reps, due },
    }));
    const keys = positions.map(({ fen }) => getBoardState(fen));

    it.each([
        { limit: 0, indices: [1, 5] },
        { limit: 1, indices: [0, 1, 5] },
        { limit: 2, indices: [0, 1, 3, 5] },
        { limit: 100, indices: [0, 1, 3, 4, 5] },
    ])("selects due reviews and at most $limit new cards in deck order", ({ limit, indices }) => {
        const before = structuredClone(positions);
        expect(buildPracticeQueue(positions, "anki", limit, now)).toEqual({
            remainingPositionKeys: indices.map((index) => keys[index]),
            reappendedPositionKeys: [],
        });
        expect(positions).toEqual(before);
    });

    it("includes every card in full mode, including future reviews and unlimited new cards", () => {
        expect(buildPracticeQueue(positions, "full", 0, now).remainingPositionKeys).toEqual(keys);
        expect(buildPracticeQueue([], "anki", 10, now).remainingPositionKeys).toEqual([]);
    });

    it("consumes the head and re-appends failed or introduced cards only once per session", () => {
        const queue = buildPracticeQueue(positions, "anki", 1, now);
        const before = structuredClone(queue);
        let next = advancePracticeQueue(queue, "anki", true);
        expect(next).toEqual({
            remainingPositionKeys: [keys[1], keys[5], keys[0]],
            reappendedPositionKeys: [keys[0]],
        });
        expect(queue).toEqual(before);
        next = advancePracticeQueue(next, "anki");
        next = advancePracticeQueue(next, "anki", true);
        expect(next.remainingPositionKeys).toEqual([keys[0], keys[5]]);
        next = advancePracticeQueue(next, "anki", true);
        expect(next.remainingPositionKeys).toEqual([keys[5]]);
        next = advancePracticeQueue(next, "anki", true);
        expect(next.remainingPositionKeys).toEqual([]);
        expect(next.reappendedPositionKeys).toEqual([keys[0], keys[5]]);
        expect(advancePracticeQueue(next, "anki", true)).toBe(next);
    });

    it("never re-appends in full mode and resets the re-append record for a new session", () => {
        const queue = buildPracticeQueue(positions, "full", 10, now);
        expect(advancePracticeQueue(queue, "full", true)).toEqual({
            remainingPositionKeys: keys.slice(1),
            reappendedPositionKeys: [],
        });
        expect(buildPracticeQueue(positions, "anki", 1, now).reappendedPositionKeys).toEqual([]);
    });
});

describe("practice replay", () => {
    it("includes every ply from the root to a first card at ply 14", () => {
        const path = Array<number>(14).fill(0);
        const replay = buildPracticeReplay(null, path);
        expect(PRACTICE_REPLAY_STEP_MS).toBe(450);
        expect(replay.startPath).toEqual([]);
        expect(replay.steps).toEqual([
            [0],
            [0, 0],
            [0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        ]);
        expect(path).toEqual(Array<number>(14).fill(0));
    });

    it.each([
        {
            cursor: [0, 1, 0, 0],
            target: [0, 1, 2, 0],
            start: [0, 1],
            steps: [
                [0, 1, 2],
                [0, 1, 2, 0],
            ],
        },
        { cursor: [0], target: [1, 0], start: [], steps: [[1], [1, 0]] },
        { cursor: [0, 1, 0], target: [0, 1], start: [0, 1], steps: [] },
        { cursor: [0, 1], target: [0, 1], start: [0, 1], steps: [] },
        {
            cursor: [0],
            target: [0, 1, 2],
            start: [0],
            steps: [
                [0, 1],
                [0, 1, 2],
            ],
        },
    ])(
        "starts a later card at the deepest common ancestor ($cursor → $target)",
        ({ cursor, target, start, steps }) => {
            const before = structuredClone({ cursor, target });
            expect(buildPracticeReplay(cursor, target)).toEqual({ startPath: start, steps });
            expect({ cursor, target }).toEqual(before);
        },
    );

    it("starts the first card at headers.start, including when it is the card position", () => {
        expect(buildPracticeReplay(null, [1, 0, 2, 0], [1, 0])).toEqual({
            startPath: [1, 0],
            steps: [
                [1, 0, 2],
                [1, 0, 2, 0],
            ],
        });
        expect(buildPracticeReplay(null, [1, 0], [1, 0])).toEqual({ startPath: [1, 0], steps: [] });
        expect(buildPracticeReplay([1, 0, 2], [1, 0, 3], [1, 0])).toEqual({
            startPath: [1, 0],
            steps: [[1, 0, 3]],
        });
    });

    it("replays consecutive plies from a Black-to-move root at move 23", () => {
        const root = defaultTree(
            "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 23",
        ).root;
        const reply = createNode({
            fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 24",
            san: "e5",
            move: parseUci("e7e5")!,
            halfMoves: root.halfMoves + 1,
        });
        const answer = createNode({
            fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 24",
            san: "Nf3",
            move: parseUci("g1f3")!,
            halfMoves: reply.halfMoves + 1,
        });
        root.children.push(reply);
        reply.children.push(answer);
        const [card] = buildFromTree(root, "white", []);
        expect(card.answer).toBe("Nf3");
        const replay = buildPracticeReplay(null, [0]);
        expect(replay).toEqual({ startPath: [], steps: [[0]] });
        expect(getNodeAtPath(root, replay.startPath).halfMoves).toBe(45);
        expect(replay.steps.map((path) => getNodeAtPath(root, path).halfMoves)).toEqual([46]);
    });
});

describe("automatic practice grading", () => {
    it.each([
        { time: 0, grade: 3 },
        { time: 9_999, grade: 3 },
        { time: 10_000, grade: 3 },
        { time: 10_001, grade: 2 },
        { time: 60_000, grade: 2 },
    ])("grades an answer in $time ms as $grade", ({ time, grade }) => {
        expect(PRACTICE_SLOW_ANSWER_MS).toBe(10_000);
        expect(getAutomaticPracticeGrade(time)).toBe(grade);
    });
});

describe("line-training reducer phases", () => {
    const replaying = (): PracticeSession =>
        practiceSessionReducer(idlePracticeSession(), {
            type: "replay",
            token: 5,
            fen: "card-fen",
            positionKey: "card-key",
        });
    const waiting = (): PracticeSession =>
        practiceSessionReducer(replaying(), {
            type: "replayed",
            token: 5,
            learning: false,
        });
    const wrong: PracticeEvent = {
        type: "wrong",
        token: 5,
        answer: "Nf3",
        playedMove: "Bc4",
        timeTaken: 100,
    };

    it("locks replay, then unlocks an ordinary quiz without accepting early answers", () => {
        const replay = replaying();
        expect(replay).toEqual({
            phase: "replaying",
            token: 5,
            currentFen: "card-fen",
            positionKey: "card-key",
        });
        expect(canSubmitPracticeMove(replay, "card-fen")).toBe(false);
        expect(practiceSessionReducer(replay, wrong)).toBe(replay);
        expect(
            practiceSessionReducer(replay, {
                type: "correct",
                token: 5,
                answer: "Nf3",
                timeTaken: 10,
            }),
        ).toBe(replay);
        expect(waiting().phase).toBe("waiting");
        expect(canSubmitPracticeMove(waiting(), "card-fen")).toBe(true);
    });

    it.each(["learning", "waiting", "retry", "revealed", "correct", "advancing"] as const)(
        "rebinds the FEN and stored answer in %s and rejects stale tokens",
        (phase) => {
            const state: PracticeSession = {
                ...replaying(),
                phase,
                answer: "Nf3",
                playedMove: "d4",
                timeTaken: 42,
            };
            expect(
                practiceSessionReducer(state, {
                    type: "rebind",
                    token: 5,
                    fen: "new-fen",
                    answer: "d5",
                }),
            ).toEqual({ ...state, currentFen: "new-fen", answer: "d5" });
            for (const token of [4, 6])
                expect(
                    practiceSessionReducer(state, {
                        type: "rebind",
                        token,
                        fen: "new-fen",
                        answer: "d5",
                    }),
                ).toBe(state);
        },
    );

    it("ignores rebind during idle and replaying", () => {
        for (const state of [idlePracticeSession(5), replaying()]) {
            expect(
                practiceSessionReducer(state, {
                    type: "rebind",
                    token: 5,
                    fen: "new-fen",
                    answer: "d5",
                }),
            ).toBe(state);
        }
    });

    it("does not add an answer to a presentation that has not stored one", () => {
        const state = waiting();
        expect(
            practiceSessionReducer(state, {
                type: "rebind",
                token: 5,
                fen: "new-fen",
                answer: "d5",
            }),
        ).toEqual({ ...state, currentFen: "new-fen" });
    });

    it("introduces unseen cards without a quiz result and finishes through learned", () => {
        const learning = practiceSessionReducer(replaying(), {
            type: "replayed",
            token: 5,
            learning: true,
        });
        expect(learning.phase).toBe("learning");
        expect(canSubmitPracticeMove(learning, "card-fen")).toBe(true);
        expect(practiceSessionReducer(learning, wrong)).toBe(learning);
        expect(
            practiceSessionReducer(learning, {
                type: "correct",
                token: 5,
                answer: "Nf3",
                timeTaken: 100,
            }),
        ).toBe(learning);
        expect(practiceSessionReducer(learning, { type: "learned", token: 5 })).toEqual({
            ...learning,
            phase: "advancing",
        });
        expect(practiceSessionReducer(waiting(), { type: "learned", token: 5 }).phase).toBe(
            "waiting",
        );
    });

    it("allows one retry, reveals on a second wrong answer and ignores further wrong answers", () => {
        const retry = practiceSessionReducer(waiting(), wrong);
        expect(retry).toMatchObject({ phase: "retry", playedMove: "Bc4", timeTaken: 100 });
        expect(canSubmitPracticeMove(retry, "card-fen")).toBe(true);
        const revealed = practiceSessionReducer(retry, { ...wrong, playedMove: "d4" });
        expect(revealed).toMatchObject({ phase: "revealed", playedMove: "d4", answer: "Nf3" });
        expect(canSubmitPracticeMove(revealed, "card-fen")).toBe(true);
        expect(practiceSessionReducer(revealed, wrong)).toBe(revealed);
        const correct = practiceSessionReducer(revealed, {
            type: "correct",
            token: 5,
            answer: "Nf3",
            timeTaken: 200,
        });
        expect(correct.phase).toBe("correct");
        expect(practiceSessionReducer(correct, { type: "advance", token: 5 }).phase).toBe(
            "advancing",
        );
    });

    it("accepts the answer during retry and allows an immediate reveal from waiting or retry", () => {
        const retry = practiceSessionReducer(waiting(), wrong);
        expect(
            practiceSessionReducer(retry, {
                type: "correct",
                token: 5,
                answer: "Nf3",
                timeTaken: 200,
            }).phase,
        ).toBe("correct");
        for (const state of [waiting(), retry]) {
            expect(
                practiceSessionReducer(state, { type: "reveal", token: 5, answer: "Nf3" }),
            ).toEqual({ ...state, phase: "revealed", answer: "Nf3" });
            expect(practiceSessionReducer(state, { type: "advance", token: 5 })).toBe(state);
        }
    });

    it("restarts a surviving replay with its token but rejects a different card under that token", () => {
        const state = replaying();
        expect(
            practiceSessionReducer(state, {
                type: "replay",
                token: 5,
                fen: "updated-fen",
                positionKey: "card-key",
            }),
        ).toEqual({ ...state, currentFen: "updated-fen" });
        expect(
            practiceSessionReducer(state, {
                type: "replay",
                token: 5,
                fen: "other-fen",
                positionKey: "other-key",
            }),
        ).toBe(state);
    });

    it.each(["replaying", "learning", "retry", "revealed"] as const)(
        "guards every event by token in %s and clears it on end",
        (phase) => {
            const state: PracticeSession = { ...replaying(), phase };
            const events: PracticeEvent[] = [
                { type: "replay", token: 4, fen: "old", positionKey: "old" },
                { type: "replayed", token: 4, learning: false },
                { type: "learned", token: 4 },
                { type: "wrong", token: 4, answer: "old", playedMove: "old", timeTaken: 0 },
                { type: "correct", token: 4, answer: "old", timeTaken: 0 },
                { type: "reveal", token: 4, answer: "old" },
                { type: "advance", token: 4 },
                { type: "end", token: 4 },
            ];
            for (const event of events) expect(practiceSessionReducer(state, event)).toBe(state);
            expect(isPracticePhase(phase)).toBe(true);
            expect(canSubmitPracticeMove(state, "other-fen")).toBe(false);
            const ended = practiceSessionReducer(state, { type: "end", token: 5 });
            expect(ended).toEqual(idlePracticeSession(5));
            expect(
                practiceSessionReducer(ended, { type: "replayed", token: 5, learning: false }),
            ).toBe(ended);
            expect(
                practiceSessionReducer(ended, {
                    type: "replay",
                    token: 5,
                    fen: "old",
                    positionKey: "old",
                }),
            ).toBe(ended);
        },
    );
});
