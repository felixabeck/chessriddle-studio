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

const puzzleRatingSchema = z.number().int().min(0).max(65535);
export const puzzleRatingRangeSchema = z
    .tuple([puzzleRatingSchema, puzzleRatingSchema])
    .refine(([min, max]) => min <= max);
