import { createEmptyCard } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import type { Position } from "@/utils/practicePosition";
import {
    collectRunCandidates,
    planNextSegment,
    removeChapterCandidates,
    removeSegmentCandidates,
    timedRunPaceSeconds,
    TIMED_RUN_INITIAL_PACE_SECONDS,
    type TimedRunCandidate,
} from "./runPlanner";

const NOW = new Date("2026-11-24T12:00:00Z");

function card(options: {
    fen: string;
    reps: number;
    due?: Date;
    weight?: number;
    outOfScope?: true;
}): Position {
    return {
        fen: options.fen,
        answer: "Nf3",
        card: { ...createEmptyCard(options.due ?? NOW), reps: options.reps },
        weight: options.weight,
        ...(options.outOfScope ? { outOfScope: true as const } : {}),
    };
}

function candidate(
    partial: Partial<TimedRunCandidate> & Pick<TimedRunCandidate, "positionKey">,
): TimedRunCandidate {
    return {
        file: "a",
        game: 0,
        kind: "due",
        dueAt: NOW.getTime(),
        treeIndex: 0,
        ...partial,
    };
}

describe("collectRunCandidates", () => {
    it("orders weighted due first, then unweighted due by earliest date, then unseen by weight", () => {
        const collected = collectRunCandidates(
            [
                {
                    file: "a",
                    game: 0,
                    positions: [
                        card({
                            fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
                            reps: 1,
                            due: new Date(NOW.getTime() - 1000),
                            weight: 0.2,
                        }),
                        card({
                            fen: "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1",
                            reps: 1,
                            due: new Date(NOW.getTime() - 5000),
                        }),
                        card({
                            fen: "rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq c3 0 1",
                            reps: 0,
                            weight: 0.9,
                        }),
                    ],
                },
                {
                    file: "b",
                    game: 0,
                    positions: [
                        card({
                            fen: "rnbqkbnr/pppppppp/8/8/8/4P3/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
                            reps: 1,
                            due: new Date(NOW.getTime() - 2000),
                            weight: 0.8,
                        }),
                        card({
                            fen: "rnbqkbnr/pppppppp/8/8/8/3P4/PPP1PPPP/RNBQKBNR b KQkq - 0 1",
                            reps: 1,
                            due: new Date(NOW.getTime() - 9000),
                        }),
                        card({
                            fen: "rnbqkbnr/pppppppp/8/8/8/2P5/PP1PPPPP/RNBQKBNR b KQkq - 0 1",
                            reps: 0,
                            weight: 0.4,
                        }),
                    ],
                },
            ],
            NOW,
            10,
        );
        expect(
            collected.map((entry) => `${entry.file}:${entry.kind}:${entry.weight ?? "none"}`),
        ).toEqual([
            "b:due:0.8",
            "a:due:0.2",
            "b:due:none",
            "a:due:none",
            "a:unseen:0.9",
            "b:unseen:0.4",
        ]);
    });

    it("caps unseen cards for the whole run and ranks missing weights after weighted ones", () => {
        const collected = collectRunCandidates(
            [
                {
                    file: "a",
                    game: 0,
                    positions: [
                        card({
                            fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
                            reps: 0,
                            weight: 0.1,
                        }),
                        card({
                            fen: "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1",
                            reps: 0,
                        }),
                    ],
                },
                {
                    file: "b",
                    game: 0,
                    positions: [
                        card({
                            fen: "rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq c3 0 1",
                            reps: 0,
                            weight: 0.5,
                        }),
                        card({
                            fen: "rnbqkbnr/pppppppp/8/8/1P6/8/P1PPPPPP/RNBQKBNR b KQkq b3 0 1",
                            reps: 0,
                            weight: 0.2,
                        }),
                    ],
                },
            ],
            NOW,
            2,
        );
        expect(collected.map((entry) => `${entry.file}:${entry.weight ?? "none"}`)).toEqual([
            "b:0.5",
            "b:0.2",
        ]);
    });

    it("ignores out-of-scope cards and future due cards", () => {
        const collected = collectRunCandidates(
            [
                {
                    file: "a",
                    game: 0,
                    positions: [
                        card({
                            fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
                            reps: 1,
                            due: new Date(NOW.getTime() - 1),
                            weight: 1,
                            outOfScope: true,
                        }),
                        card({
                            fen: "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1",
                            reps: 1,
                            due: new Date(NOW.getTime() + 60_000),
                            weight: 1,
                        }),
                    ],
                },
            ],
            NOW,
            10,
        );
        expect(collected).toEqual([]);
    });
});

describe("planNextSegment", () => {
    it("uses the fixed pace until five cards, then the observed pace", () => {
        expect(timedRunPaceSeconds(4, 100_000)).toBe(TIMED_RUN_INITIAL_PACE_SECONDS);
        expect(timedRunPaceSeconds(5, 100_000)).toBe(20);
        const due = [
            candidate({ positionKey: "a1", file: "a", treeIndex: 0, weight: 1 }),
            candidate({ positionKey: "a2", file: "a", treeIndex: 1, weight: 0.9 }),
            candidate({ positionKey: "b1", file: "b", treeIndex: 0, weight: 0.8 }),
        ];
        expect(planNextSegment(due, 20, 0, 0)?.positionKeys).toEqual(["a1"]);
        expect(planNextSegment(due, 40, 5, 100_000)?.positionKeys).toEqual(["a1", "a2"]);
    });

    it("considers due candidates only while one remains, even when a chapter also has unseen cards", () => {
        const mixed: TimedRunCandidate[] = [
            candidate({ positionKey: "a-due", file: "a", kind: "due", weight: 1, treeIndex: 0 }),
            candidate({ positionKey: "b-due", file: "b", kind: "due", weight: 0.5, treeIndex: 0 }),
            candidate({
                positionKey: "a-new-1",
                file: "a",
                kind: "unseen",
                weight: 0.9,
                treeIndex: 1,
            }),
            candidate({
                positionKey: "a-new-2",
                file: "a",
                kind: "unseen",
                weight: 0.8,
                treeIndex: 2,
            }),
        ];
        expect(planNextSegment(mixed, 10_000, 0, 0)).toEqual({
            file: "a",
            game: 0,
            positionKeys: ["a-due"],
        });
        const afterA = removeSegmentCandidates(mixed, {
            file: "a",
            game: 0,
            positionKeys: ["a-due"],
        });
        expect(planNextSegment(afterA, 10_000, 0, 0)).toEqual({
            file: "b",
            game: 0,
            positionKeys: ["b-due"],
        });
        const afterB = removeSegmentCandidates(afterA, {
            file: "b",
            game: 0,
            positionKeys: ["b-due"],
        });
        expect(planNextSegment(afterB, 10_000, 0, 0)?.positionKeys).toEqual(["a-new-1", "a-new-2"]);
    });

    it("groups the first K considered cards and plays the highest-ranked chapter in tree order", () => {
        const due: TimedRunCandidate[] = [
            candidate({ positionKey: "b-late", file: "b", treeIndex: 1, weight: 1 }),
            candidate({ positionKey: "a1", file: "a", treeIndex: 0, weight: 0.9 }),
            candidate({ positionKey: "b-early", file: "b", treeIndex: 0, weight: 0.8 }),
            candidate({ positionKey: "c1", file: "c", treeIndex: 0, weight: 0.1 }),
        ];
        expect(planNextSegment(due, 45, 0, 0)).toEqual({
            file: "b",
            game: 0,
            positionKeys: ["b-early", "b-late"],
        });
    });

    it("returns a one-card segment when remaining time is positive but below pace", () => {
        const due = [
            candidate({ positionKey: "a1", file: "a", treeIndex: 0, weight: 1 }),
            candidate({ positionKey: "a2", file: "a", treeIndex: 1, weight: 0.9 }),
        ];
        const remaining = TIMED_RUN_INITIAL_PACE_SECONDS / 2;
        expect(remaining).toBeGreaterThan(0);
        expect(remaining).toBeLessThan(TIMED_RUN_INITIAL_PACE_SECONDS);
        expect(planNextSegment(due, remaining, 0, 0)).toEqual({
            file: "a",
            game: 0,
            positionKeys: ["a1"],
        });
    });

    it("returns null when none remain or the deadline has been reached", () => {
        expect(planNextSegment([], 30, 0, 0)).toBeNull();
        expect(planNextSegment([candidate({ positionKey: "a1", weight: 1 })], 0, 0, 0)).toBeNull();
    });
});

describe("candidate removal", () => {
    it("removes every card handed to a segment, including one the session never reached", () => {
        const remaining = removeSegmentCandidates(
            [
                candidate({ positionKey: "a1", file: "a", treeIndex: 0 }),
                candidate({ positionKey: "a2", file: "a", treeIndex: 1 }),
                candidate({ positionKey: "b1", file: "b", treeIndex: 0 }),
            ],
            { file: "a", game: 0, positionKeys: ["a1", "a2"] },
        );
        expect(remaining.map((entry) => entry.positionKey)).toEqual(["b1"]);
    });

    it("removes every candidate of a skipped chapter", () => {
        const remaining = removeChapterCandidates(
            [
                candidate({ positionKey: "a1", file: "a", kind: "due" }),
                candidate({ positionKey: "a2", file: "a", kind: "unseen" }),
                candidate({ positionKey: "b1", file: "b" }),
            ],
            "a",
            0,
        );
        expect(remaining.map((entry) => `${entry.file}:${entry.positionKey}`)).toEqual(["b:b1"]);
    });
});
