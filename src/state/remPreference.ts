import type { SyncStorage, SyncStringStorage } from "jotai/vanilla/utils/atomWithStorage";
import { z } from "zod";
import { createZodStorage } from "./utils";

/**
 * Accepts any positive finite number in rem, so an out-of-range stored size stays untouched in
 * storage and is clamped only where it is applied.
 */
const positiveRemSchema = z.number().finite().positive();

/** Storage for a remembered size in rem, such as a resizable panel's width. */
export function createPositiveRemStorage(
    storage: SyncStringStorage = localStorage,
): SyncStorage<number> {
    return createZodStorage(positiveRemSchema, storage);
}

/** Rounds a size in rem to two decimals for storage and aria values. */
export function roundRem(sizeRem: number): number {
    return Math.round(sizeRem * 100) / 100;
}
