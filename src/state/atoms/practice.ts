/** Repertoire practice decks, per-tab practice state and practice preferences. */
import { atom } from "jotai";
import { atomFamily, atomWithStorage } from "jotai/utils";
import { z } from "zod";
import { createZodStorage, initializeBeforeUse } from "../utils";
import { createPracticeDeckAtom } from "../practiceStorage";
import type { PracticeDeckStatus } from "../practiceStorage";
import { emptyPracticeStats, type PracticeSessionStats } from "../practiceSessionStats";
import { initializeRendererState } from "./rendererState";
import { tabAtomFamily } from "./tabFamilies";
import type { FileMetadata } from "@/components/files/file";
import type { TimedRunCandidate } from "@/components/panels/practice/runPlanner";

export type { PracticeData } from "../practiceStorage";

export const deckAtomFamily = atomFamily(
    ({ file, game }: { file: string; game: number }) =>
        initializeBeforeUse(createPracticeDeckAtom({ file, game }), initializeRendererState),

    (a, b) => a.file === b.file && a.game === b.game,
);

/** A delete changes ordinal resolution for the whole file, including decks without open tabs. */
export function invalidateFileDeckAtoms(file: string): void {
    for (const identity of Array.from(deckAtomFamily.getParams())) {
        if (identity.file === file) deckAtomFamily.remove(identity);
    }
}

export type PracticePhase =
    | "idle" // Not practicing
    | "replaying" // Playing the line into the card position
    | "learning" // Showing an unseen move before its first quiz
    | "waiting" // Waiting for user to make a move
    | "retry" // First attempt was wrong, waiting for another attempt
    | "revealed" // Showing the answer, waiting for it to be played
    | "correct" // Correct presentation waiting for a grade, Continue or the short delay
    | "advancing"; // Presentation finished, including an unrated learn step

export type PracticeState = {
    phase: PracticePhase;
    currentFen?: string;
    answer?: string;
    playedMove?: string;
    timeTaken?: number;
    positionKey?: string;
};

export const practiceStateFamily = tabAtomFamily((_tab: string) =>
    atom<PracticeState>({ phase: "idle" }),
);

/** Runtime-only bridge between the practice controller and the board. */
export type PracticeMoveController = {
    canMove: boolean;
    hintSan?: string;
    submitMove: (san: string) => void;
};

export const practiceMoveControllerFamily = tabAtomFamily((_tab: string) =>
    atom<PracticeMoveController | null>(null),
);

export type { PracticeSessionStats } from "../practiceSessionStats";

export const practiceSessionStatsFamily = tabAtomFamily((_tab: string) =>
    atom<PracticeSessionStats>(emptyPracticeStats()),
);

/** Completed runs remain visible without keeping an inactive session alive. */
export const practiceCompletedSummaryFamily = tabAtomFamily((_tab: string) =>
    atom<PracticeSessionStats | null>(null),
);

export const practiceGradingAtom = atomWithStorage<"auto" | "manual">(
    "practice-grading",
    "auto",
    createZodStorage(z.enum(["auto", "manual"]), localStorage),
);

export const PRACTICE_NEW_PER_SESSION = { min: 0, max: 100, default: 10 } as const;

export const practiceNewPerSessionAtom = atomWithStorage<number>(
    "practice-new-per-session",
    PRACTICE_NEW_PER_SESSION.default,
    createZodStorage(
        z.number().int().min(PRACTICE_NEW_PER_SESSION.min).max(PRACTICE_NEW_PER_SESSION.max),
        localStorage,
    ),
);

export const PRACTICE_TRAIN_MINUTES = [10, 15, 20, 30, 45, 60] as const;
export type PracticeTrainMinutes = (typeof PRACTICE_TRAIN_MINUTES)[number];
export const PRACTICE_TRAIN_MINUTES_DEFAULT: PracticeTrainMinutes = 30;

export const practiceTrainMinutesAtom = atomWithStorage<PracticeTrainMinutes>(
    "practice-train-minutes",
    PRACTICE_TRAIN_MINUTES_DEFAULT,
    createZodStorage(
        z.union([
            z.literal(10),
            z.literal(15),
            z.literal(20),
            z.literal(30),
            z.literal(45),
            z.literal(60),
        ]),
        localStorage,
    ),
);

export const practiceCardStartTimeFamily = tabAtomFamily((_tab: string) => atom<number>(0));

export type TimedRunChapter = {
    file: string;
    game: number;
    metadata: FileMetadata;
};

export type TimedRunLaunch = {
    id: string;
    deadline: number;
    startedAt: number;
    newTabId: string;
    candidates: TimedRunCandidate[];
    chapters: TimedRunChapter[];
};

export const timedRunLaunchAtom = atom<TimedRunLaunch | null>(null);

export type TimedRunSegmentStatus = "opening" | "waiting" | "active";

export type TimedRunSegment = {
    id: string;
    file: string;
    game: number;
    positionKeys: string[];
    tabId: string | null;
    status: TimedRunSegmentStatus;
};

export type TimedRun = {
    id: string;
    deadline: number;
    startedAt: number;
    newTabId: string;
    candidates: TimedRunCandidate[];
    chapters: TimedRunChapter[];
    presentedCount: number;
    correct: number;
    incorrect: number;
    currentSegment: TimedRunSegment | null;
    previous: { tabId: string; openedByRun: boolean } | null;
    openedTabIds: readonly string[];
    lastSegmentTabId: string | null;
    phase: "running" | "finished" | "cancelled";
};

export const timedRunAtom = atom<TimedRun | null>(null);

export type PracticeRunRequest = {
    runId: string;
    segmentId: string;
    positionKeys: string[];
    deadline: number;
};

export const practiceRunRequestFamily = tabAtomFamily((_tab: string) =>
    atom<PracticeRunRequest | null>(null),
);

export type PracticeSessionEndReason =
    | "queue-exhausted"
    | "deadline"
    | "stop"
    | "tab-left"
    | "unwritable"
    | "identity-change";

export type PracticeSessionEndReport = {
    runId: string;
    segmentId: string;
    reason: PracticeSessionEndReason;
    correct: number;
    incorrect: number;
};

export const practiceSessionEndAtom = atom<PracticeSessionEndReport | null>(null);

export type PracticeSegmentGate = {
    synced: boolean;
    status: PracticeDeckStatus;
};

export const practiceSegmentGateFamily = tabAtomFamily((_tab: string) =>
    atom<PracticeSegmentGate | null>(null),
);

export type TimedRunSummary = {
    positions: number;
    correct: number;
    incorrect: number;
    elapsedMs: number;
};

export const practiceRunSummaryFamily = tabAtomFamily((_tab: string) =>
    atom<TimedRunSummary | null>(null),
);
