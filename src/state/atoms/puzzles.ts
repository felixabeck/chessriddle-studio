/** Puzzle preferences and the per-tab puzzle timer. */
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { z } from "zod";
import { createPreferenceStorage, createZodStorage } from "../utils";
import { coverageMinGamesSchema, puzzleRatingRangeSchema } from "../preferenceSchemas";
import { tabAtomFamily } from "./tabFamilies";

export const hidePuzzleRatingAtom = atomWithStorage<boolean>(
    "hide-puzzle-rating",
    false,
    createPreferenceStorage(false),
);
export const progressivePuzzlesAtom = atomWithStorage<boolean>(
    "progressive-puzzles",
    false,
    createPreferenceStorage(false),
);
export const jumpToNextPuzzleAtom = atomWithStorage<boolean>(
    "puzzle-jump-immediately",
    true,
    createPreferenceStorage(true),
);
export const trackPuzzleTimeAtom = atomWithStorage<boolean>(
    "track-puzzle-time",
    true,
    createPreferenceStorage(true),
);
export const puzzleRatingRangeAtom = atomWithStorage<[number, number]>(
    "puzzle-ratings",
    [1000, 1500],
    createZodStorage(puzzleRatingRangeSchema, localStorage),
);

export const puzzleThemeAtom = atomWithStorage<string | null>(
    "puzzle-theme",
    null,
    createZodStorage(z.string().nullable(), localStorage),
);

export const coverageMinGamesAtom = atomWithStorage<number>(
    "coverage-min-games",
    50,
    createZodStorage(coverageMinGamesSchema, localStorage),
);

export type PuzzleTimer = { attemptId: string } & (
    | { startedAt: number; elapsed?: never }
    | { elapsed: number; startedAt?: never }
);

export const puzzleTimerFamily = tabAtomFamily((_tab: string) => atom<PuzzleTimer | null>(null));
