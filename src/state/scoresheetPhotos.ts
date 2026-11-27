// Load the atoms barrel first so `tabFamilies` initializes before its circular submodules.
import "./atoms";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { CoachError } from "@/bindings";
import { coachErrorCode } from "@/platform/coach";
import { tauri } from "@/platform/tauri";
import { MAX_SCORESHEET_PHOTOS } from "@/utils/scoresheet";
import { registerTabDisposer } from "./atoms/tabFamilies";
import { createNoticeAcceptedAtom } from "./coach";
import { registerScoresheetReviewCleanup } from "./store/tree";

export const MAX_SCORESHEET_PHOTO_TABS = 4;
/** Upper bound on the global id-keyed photo cache shared across open tabs. */
export const MAX_CACHED_SCORESHEET_PHOTOS = 32;
const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";

export type CachedScoresheetPhoto = { status: "ok"; dataUrl: string } | { status: "missing" };

export type ResolvedScoresheetPhotoSlot =
    | { status: "ok"; dataUrl: string }
    | { status: "missing" }
    | { status: "unreadable" }
    | { status: "loading" };

export type ResolvedScoresheetPhotosState = {
    slots: readonly ResolvedScoresheetPhotoSlot[];
    readError: CoachError | null;
    storeError: CoachError | null;
    retry: () => void;
};

type TabUnsavedEntry = {
    photos: readonly string[];
    storeError: CoachError | null;
};

const EMPTY_PHOTOS: readonly string[] = Object.freeze([]);
const EMPTY_UNREADABLE: ReadonlySet<string> = new Set();

// Scope (a): global cache keyed by content-addressed photo id. Never cleared on a single tab's
// close so duplicated tabs keep their photos. `unreadable` outcomes are never cached.
const cachedPhotosById = new Map<string, CachedScoresheetPhoto>();

// Scope (b): tab-scoped unsaved photos (no id) plus their store error. Cleared on tab close,
// game replacement, or when a later store succeeds.
const unsavedByTab = new Map<string, TabUnsavedEntry>();

// Active native read controllers per tab so tab disposal cancels in-flight reads immediately.
const activeReadControllersByTab = new Map<string, Set<AbortController>>();

const listeners = new Set<() => void>();

type PhotoStoreSnapshot = {
    readonly version: number;
    getUnsaved: (tabId: string) => TabUnsavedEntry | undefined;
    getCached: (id: string) => CachedScoresheetPhoto | undefined;
};

function createStoreSnapshot(version: number): PhotoStoreSnapshot {
    return {
        version,
        getUnsaved: (tabId) => unsavedByTab.get(tabId),
        getCached: (id) => cachedPhotosById.get(id),
    };
}

const SERVER_STORE_SNAPSHOT: PhotoStoreSnapshot = {
    version: 0,
    getUnsaved: () => undefined,
    getCached: () => undefined,
};

let storeSnapshot: PhotoStoreSnapshot = createStoreSnapshot(0);

function getStoreSnapshot(): PhotoStoreSnapshot {
    return storeSnapshot;
}

function getServerStoreSnapshot(): PhotoStoreSnapshot {
    return SERVER_STORE_SNAPSHOT;
}

function emit(): void {
    storeSnapshot = createStoreSnapshot(storeSnapshot.version + 1);
    for (const listener of listeners) listener();
}

export function subscribeScoresheetPhotos(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function putCachedPhoto(id: string, entry: CachedScoresheetPhoto): void {
    cachedPhotosById.delete(id);
    cachedPhotosById.set(id, entry);
    while (cachedPhotosById.size > MAX_CACHED_SCORESHEET_PHOTOS) {
        const oldest = cachedPhotosById.keys().next().value;
        if (oldest === undefined) break;
        cachedPhotosById.delete(oldest);
    }
}

/** Returns the globally cached entry for `id` (`ok` or `missing`), if present. */
export function getCachedScoresheetPhoto(id: string): CachedScoresheetPhoto | undefined {
    return cachedPhotosById.get(id);
}

/**
 * Records successfully stored photos in the global id-keyed cache, upgrading any prior `missing`
 * entry for those ids.
 */
export function cacheStoredScoresheetPhotos(
    ids: readonly string[],
    dataUrls: readonly string[],
): void {
    const count = Math.min(ids.length, dataUrls.length, MAX_SCORESHEET_PHOTOS);
    let changed = false;
    for (let i = 0; i < count; i += 1) {
        const id = ids[i];
        const dataUrl = dataUrls[i];
        if (!id || !dataUrl.startsWith(JPEG_DATA_URL_PREFIX)) continue;
        putCachedPhoto(id, { status: "ok", dataUrl });
        changed = true;
    }
    if (changed) emit();
}

/** Tab-scoped unsaved fallback photos held in renderer memory for `tabId`, never persisted. */
export function getUnsavedScoresheetPhotos(tabId: string): readonly string[] {
    return unsavedByTab.get(tabId)?.photos ?? EMPTY_PHOTOS;
}

/** Tab-scoped store error recorded when saving photos to the native store failed for `tabId`. */
export function getScoresheetStoreError(tabId: string): CoachError | null {
    return unsavedByTab.get(tabId)?.storeError ?? null;
}

/**
 * Stores up to `MAX_SCORESHEET_PHOTOS` unsaved fallback JPEG data-URL photos (and an optional
 * store error) for `tabId` in memory. Keeps at most `MAX_SCORESHEET_PHOTO_TABS` tabs, dropping the
 * oldest entry when full.
 */
export function setUnsavedScoresheetPhotos(
    tabId: string,
    photos: readonly string[],
    storeError: CoachError | null = null,
): void {
    const valid = photos
        .filter((photo) => photo.startsWith(JPEG_DATA_URL_PREFIX))
        .slice(0, MAX_SCORESHEET_PHOTOS);
    if (valid.length === 0) {
        clearUnsavedScoresheetPhotos(tabId);
        return;
    }
    unsavedByTab.delete(tabId);
    unsavedByTab.set(tabId, { photos: Object.freeze(valid), storeError });
    while (unsavedByTab.size > MAX_SCORESHEET_PHOTO_TABS) {
        const oldest = unsavedByTab.keys().next().value;
        if (oldest === undefined) break;
        unsavedByTab.delete(oldest);
    }
    emit();
}

/** Removes any tab-scoped unsaved fallback photos and store error owned by `tabId`. */
export function clearUnsavedScoresheetPhotos(tabId: string): void {
    if (!unsavedByTab.delete(tabId)) return;
    emit();
}

function registerTabReadController(tabId: string, controller: AbortController): void {
    let set = activeReadControllersByTab.get(tabId);
    if (!set) {
        set = new Set();
        activeReadControllersByTab.set(tabId, set);
    }
    set.add(controller);
}

function unregisterTabReadController(tabId: string, controller: AbortController): void {
    const set = activeReadControllersByTab.get(tabId);
    if (!set) return;
    set.delete(controller);
    if (set.size === 0) activeReadControllersByTab.delete(tabId);
}

function abortTabPhotoReads(tabId: string): void {
    const set = activeReadControllersByTab.get(tabId);
    if (!set) return;
    activeReadControllersByTab.delete(tabId);
    for (const controller of set) {
        controller.abort();
    }
}

function disposeTabScoresheetPhotos(tabId: string): void {
    abortTabPhotoReads(tabId);
    clearUnsavedScoresheetPhotos(tabId);
}

registerTabDisposer(disposeTabScoresheetPhotos);
registerScoresheetReviewCleanup(clearUnsavedScoresheetPhotos);

/** Clears both scopes and aborts any active reads; for test isolation only. */
export function clearAllScoresheetPhotosForTests(): void {
    for (const controllers of activeReadControllersByTab.values()) {
        for (const controller of controllers) controller.abort();
    }
    activeReadControllersByTab.clear();
    const hadEntries = unsavedByTab.size > 0 || cachedPhotosById.size > 0;
    unsavedByTab.clear();
    cachedPhotosById.clear();
    if (hadEntries) emit();
}

type LocalPhotoReadState = {
    key: string;
    unreadable: ReadonlySet<string>;
    readError: CoachError | null;
};

const INITIAL_LOCAL_READ_STATE: LocalPhotoReadState = {
    key: "",
    unreadable: EMPTY_UNREADABLE,
    readError: null,
};

/**
 * Resolves a tab's scoresheet photos from either tab-scoped unsaved photos or the global id-keyed
 * cache backed by `tauri.scoresheetReadPhotos`. Cancels and discards stale responses on tab switch,
 * id-list change, unmount, or tab close, and re-reads ids evicted from the global cache while mounted.
 */
export function useResolvedScoresheetPhotos(
    tabId: string,
    photoIds: readonly string[] | null,
): ResolvedScoresheetPhotosState {
    const photoStore = useSyncExternalStore(
        subscribeScoresheetPhotos,
        getStoreSnapshot,
        getServerStoreSnapshot,
    );

    const unsaved = photoStore.getUnsaved(tabId);
    const unsavedPhotos = unsaved?.photos ?? EMPTY_PHOTOS;
    const storeError = unsaved?.storeError ?? null;
    const hasUnsaved = unsavedPhotos.length > 0;

    const idsKey = photoIds && photoIds.length > 0 ? photoIds.join(",") : "";
    const requestKey = `${tabId}:${idsKey}`;

    const [localRead, setLocalRead] = useState<LocalPhotoReadState>(INITIAL_LOCAL_READ_STATE);

    const retry = useCallback(() => {
        setLocalRead(INITIAL_LOCAL_READ_STATE);
    }, []);

    const isCurrentLocal = localRead.key === requestKey;
    const allCached =
        !hasUnsaved &&
        photoIds !== null &&
        photoIds.length > 0 &&
        photoIds.every((id) => photoStore.getCached(id) !== undefined);
    const uncachedNeededKey =
        !hasUnsaved && photoIds && photoIds.length > 0
            ? photoIds
                  .filter(
                      (id) =>
                          photoStore.getCached(id) === undefined &&
                          !(
                              isCurrentLocal &&
                              (localRead.unreadable.has(id) || localRead.readError !== null)
                          ),
                  )
                  .join(",")
            : "";

    useEffect(() => {
        if (hasUnsaved || !idsKey) {
            setLocalRead(INITIAL_LOCAL_READ_STATE);
            return;
        }
        if (allCached) {
            setLocalRead((prev) =>
                prev.readError !== null || prev.unreadable.size > 0
                    ? INITIAL_LOCAL_READ_STATE
                    : prev,
            );
            return;
        }
        if (!uncachedNeededKey) {
            return;
        }
        const uncachedIds = uncachedNeededKey.split(",");

        const controller = new AbortController();
        registerTabReadController(tabId, controller);

        let active = true;
        void tauri
            .scoresheetReadPhotos(uncachedIds, { signal: controller.signal })
            .then((results) => {
                if (!active || controller.signal.aborted) return;
                const unreadable = new Set<string>();
                let cacheChanged = false;
                for (let i = 0; i < uncachedIds.length; i += 1) {
                    const id = uncachedIds[i];
                    const item = results[i];
                    if (item?.status === "ok" && item.dataUrl.startsWith(JPEG_DATA_URL_PREFIX)) {
                        putCachedPhoto(id, { status: "ok", dataUrl: item.dataUrl });
                        cacheChanged = true;
                    } else if (item?.status === "missing") {
                        putCachedPhoto(id, { status: "missing" });
                        cacheChanged = true;
                    } else {
                        unreadable.add(id);
                    }
                }
                if (cacheChanged) emit();
                setLocalRead({
                    key: requestKey,
                    unreadable,
                    readError: null,
                });
            })
            .catch((cause) => {
                if (!active || controller.signal.aborted) return;
                const code = coachErrorCode(cause);
                // Renderer-initiated aborts are already filtered above; a native cancellation for
                // a still-active request must settle into a terminal, retryable state.
                setLocalRead({
                    key: requestKey,
                    unreadable: EMPTY_UNREADABLE,
                    readError: code === "cancelled" ? "photoStorage" : code,
                });
            })
            .finally(() => {
                unregisterTabReadController(tabId, controller);
            });

        return () => {
            active = false;
            controller.abort();
            unregisterTabReadController(tabId, controller);
        };
    }, [tabId, idsKey, requestKey, uncachedNeededKey, hasUnsaved, allCached]);

    if (hasUnsaved) {
        return {
            slots: unsavedPhotos.map((dataUrl) => ({ status: "ok", dataUrl })),
            readError: null,
            storeError,
            retry,
        };
    }

    if (!photoIds || photoIds.length === 0) {
        return {
            slots: [],
            readError: null,
            storeError,
            retry,
        };
    }

    const readError = isCurrentLocal && !allCached ? localRead.readError : null;
    const slots: ResolvedScoresheetPhotoSlot[] = photoIds.map((id) => {
        const cached = photoStore.getCached(id);
        if (cached) return cached;
        if (isCurrentLocal && (localRead.unreadable.has(id) || localRead.readError !== null)) {
            return { status: "unreadable" };
        }
        return { status: "loading" };
    });

    return {
        slots,
        readError,
        storeError,
        retry,
    };
}

/**
 * The connections for which the user accepted the scoresheet photo first-use notice.
 */
export const scoresheetNoticeAcceptedAtom = createNoticeAcceptedAtom("scoresheet-notice-accepted");

type IntakeTranslator = (key: string, options?: Record<string, unknown>) => string;

/** Formats skipped/unreadable counts from a photo intake batch, or `null` when every photo succeeded. */
export function formatScoresheetIntakeCounts(
    counts: { skipped: number; failed: number },
    t: IntakeTranslator,
): string | null {
    const parts: string[] = [];
    if (counts.skipped > 0) {
        parts.push(t("Scoresheet.Intake.Skipped", { count: counts.skipped }));
    }
    if (counts.failed > 0) {
        parts.push(t("Scoresheet.Intake.Failed", { count: counts.failed }));
    }
    return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Formats an error from a photo intake command for the intake status line.
 * Dismissed pickers (`cancelled`) and stale drops (`notFound`) are quiet and return `null`.
 */
export function formatScoresheetIntakeError(
    cause: unknown,
    messages: Record<CoachError, string>,
): string | null {
    const code = coachErrorCode(cause);
    if (code === "cancelled" || code === "notFound") return null;
    return messages[code];
}
