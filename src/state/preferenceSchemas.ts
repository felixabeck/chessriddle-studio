import { z } from "zod";

export const SOUND_COLLECTIONS = [
    "futuristic",
    "lisp",
    "nes",
    "piano",
    "robot",
    "sfx",
    "standard",
    "woodland",
] as const;

export const soundCollectionSchema = z.enum(SOUND_COLLECTIONS);
export const soundVolumeSchema = z.number().min(0).max(1);
export const openingBookMaxPlySchema = z.number().int().min(1).safe();
export const coverageMinGamesSchema = z.number().int().min(1).safe();

export const PUZZLE_RATING_MIN = 0;
// Native getPuzzle accepts ratings up to the u16 bound.
export const PUZZLE_RATING_MAX = 65_535;

const puzzleRatingSchema = z.number().int().min(PUZZLE_RATING_MIN).max(PUZZLE_RATING_MAX);
export const puzzleRatingRangeSchema = z
    .tuple([puzzleRatingSchema, puzzleRatingSchema])
    .refine(([min, max]) => min <= max);
