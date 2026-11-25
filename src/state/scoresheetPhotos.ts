// Load the atoms barrel first so `tabFamilies` initializes before its circular submodules.
import "./atoms";
import { useSyncExternalStore } from "react";
import { registerTabDisposer } from "./atoms/tabFamilies";
import { createNoticeAcceptedAtom } from "./coach";
import { registerScoresheetReviewCleanup } from "./store/tree";

export const MAX_SCORESHEET_PHOTO_TABS = 4;
export const MAX_SCORESHEET_PHOTOS_PER_TAB = 4;
const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";

const EMPTY_PHOTOS: readonly string[] = Object.freeze([]);
const photosByTab = new Map<string, readonly string[]>();
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

export function subscribeScoresheetPhotos(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Photos currently held in renderer memory for `tabId`, never persisted to storage or disk. */
export function getScoresheetPhotos(tabId: string): readonly string[] {
    return photosByTab.get(tabId) ?? EMPTY_PHOTOS;
}

/**
 * Stores up to `MAX_SCORESHEET_PHOTOS_PER_TAB` JPEG data-URL photos for `tabId` in memory.
 * Keeps at most `MAX_SCORESHEET_PHOTO_TABS` tabs, dropping the oldest entry when full.
 */
export function setScoresheetPhotos(tabId: string, photos: readonly string[]): void {
    const valid = photos
        .filter((photo) => photo.startsWith(JPEG_DATA_URL_PREFIX))
        .slice(0, MAX_SCORESHEET_PHOTOS_PER_TAB);
    if (valid.length === 0) {
        clearScoresheetPhotos(tabId);
        return;
    }
    photosByTab.delete(tabId);
    photosByTab.set(tabId, Object.freeze(valid));
    while (photosByTab.size > MAX_SCORESHEET_PHOTO_TABS) {
        const oldest = photosByTab.keys().next().value;
        if (oldest === undefined) break;
        photosByTab.delete(oldest);
    }
    emit();
}

/** Removes any in-memory photos owned by `tabId`. */
export function clearScoresheetPhotos(tabId: string): void {
    if (!photosByTab.delete(tabId)) return;
    emit();
}

registerTabDisposer(clearScoresheetPhotos);
registerScoresheetReviewCleanup(clearScoresheetPhotos);

/** Clears every entry; for test isolation only. */
export function clearAllScoresheetPhotosForTests(): void {
    if (photosByTab.size === 0) return;
    photosByTab.clear();
    emit();
}

export function useScoresheetPhotos(tabId: string): readonly string[] {
    return useSyncExternalStore(
        subscribeScoresheetPhotos,
        () => getScoresheetPhotos(tabId),
        () => EMPTY_PHOTOS,
    );
}

/**
 * The connections for which the user accepted the scoresheet photo first-use notice.
 * Used from Phase 3 when sending photos to a provider.
 */
export const scoresheetNoticeAcceptedAtom = createNoticeAcceptedAtom("scoresheet-notice-accepted");
