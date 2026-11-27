import { createStore } from "jotai";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CoachCommandError } from "@/platform/coach";
import { disposeTabAtoms } from "@/state/atoms";
import { closeTreeStore, createTreeStore } from "@/state/store/tree";
import { MAX_SCORESHEET_PHOTOS } from "@/utils/scoresheet";
import { defaultTree } from "@/utils/treeReducer";

const mocks = vi.hoisted(() => ({
    scoresheetReadPhotos: vi.fn(),
}));

vi.mock("@/platform/tauri", () => ({
    tauri: {
        scoresheetReadPhotos: (ids: string[], opts?: { signal?: AbortSignal }) =>
            mocks.scoresheetReadPhotos(ids, opts),
    },
}));

import {
    cacheStoredScoresheetPhotos,
    clearAllScoresheetPhotosForTests,
    clearUnsavedScoresheetPhotos,
    getCachedScoresheetPhoto,
    getScoresheetStoreError,
    getUnsavedScoresheetPhotos,
    MAX_CACHED_SCORESHEET_PHOTOS,
    MAX_SCORESHEET_PHOTO_TABS,
    type ResolvedScoresheetPhotosState,
    scoresheetNoticeAcceptedAtom,
    setUnsavedScoresheetPhotos,
    subscribeScoresheetPhotos,
    useResolvedScoresheetPhotos,
} from "./scoresheetPhotos";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const PHOTO_A = "data:image/jpeg;base64,AAAA";
const PHOTO_B = "data:image/jpeg;base64,BBBB";
const PHOTO_C = "data:image/jpeg;base64,CCCC";
const PHOTO_D = "data:image/jpeg;base64,DDDD";
const PHOTO_E = "data:image/jpeg;base64,EEEE";

const ID_1 = "1".repeat(64);
const ID_2 = "2".repeat(64);
const ID_MISSING = "3".repeat(64);

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
    vi.clearAllMocks();
    clearAllScoresheetPhotosForTests();
    sessionStorage.clear();
    localStorage.clear();
});

afterEach(async () => {
    if (root) {
        await act(async () => root!.unmount());
        root = null;
    }
    host?.remove();
    host = null;
    clearAllScoresheetPhotosForTests();
});

test("keeps at most 4 photos per tab, accepts only JPEG data URLs, and never writes to web storage", () => {
    setUnsavedScoresheetPhotos(
        "tab-1",
        [PHOTO_A, "data:image/png;base64,NOPE", PHOTO_B, PHOTO_C, PHOTO_D, PHOTO_E],
        "photoStorage",
    );

    expect(getUnsavedScoresheetPhotos("tab-1")).toEqual([PHOTO_A, PHOTO_B, PHOTO_C, PHOTO_D]);
    expect(getUnsavedScoresheetPhotos("tab-1")).toHaveLength(MAX_SCORESHEET_PHOTOS);
    expect(getScoresheetStoreError("tab-1")).toBe("photoStorage");
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
});

test("evicts the oldest tab once more than 4 tabs hold unsaved photos", () => {
    for (let i = 1; i <= MAX_SCORESHEET_PHOTO_TABS + 1; i++) {
        setUnsavedScoresheetPhotos(`tab-${i}`, [PHOTO_A]);
    }

    expect(getUnsavedScoresheetPhotos("tab-1")).toEqual([]);
    expect(getUnsavedScoresheetPhotos("tab-2")).toEqual([PHOTO_A]);
    expect(getUnsavedScoresheetPhotos("tab-5")).toEqual([PHOTO_A]);
});

test("notifies subscribers on set and clear, and removes unsaved photos and store error on tab close", () => {
    let calls = 0;
    const unsubscribe = subscribeScoresheetPhotos(() => {
        calls++;
    });

    setUnsavedScoresheetPhotos("tab-close", [PHOTO_A], "photoStorage");
    expect(calls).toBe(1);
    disposeTabAtoms("tab-close");
    expect(getUnsavedScoresheetPhotos("tab-close")).toEqual([]);
    expect(getScoresheetStoreError("tab-close")).toBeNull();
    expect(calls).toBe(2);

    // Clearing an already absent tab is a no-op.
    clearUnsavedScoresheetPhotos("tab-close");
    expect(calls).toBe(2);
    unsubscribe();
});

test("removes unsaved photos and store error when another game is installed, start FEN changes, or store closes", () => {
    const id = crypto.randomUUID();
    const store = createTreeStore(id, { ...defaultTree(), scoresheetReview: {} });

    setUnsavedScoresheetPhotos(id, [PHOTO_A], "photoStorage");
    store.getState().setState(defaultTree());
    expect(getUnsavedScoresheetPhotos(id)).toEqual([]);
    expect(getScoresheetStoreError(id)).toBeNull();

    setUnsavedScoresheetPhotos(id, [PHOTO_A], "photoStorage");
    store.getState().reset();
    expect(getUnsavedScoresheetPhotos(id)).toEqual([]);

    setUnsavedScoresheetPhotos(id, [PHOTO_A], "photoStorage");
    store.getState().setFen("4k3/8/8/8/8/8/8/4K3 w - - 0 1");
    expect(getUnsavedScoresheetPhotos(id)).toEqual([]);

    setUnsavedScoresheetPhotos(id, [PHOTO_A], "photoStorage");
    store.getState().setHeaders({
        ...store.getState().headers,
        fen: "4k3/8/8/8/4P3/8/8/4K3 b - - 0 1",
    });
    expect(getUnsavedScoresheetPhotos(id)).toEqual([]);

    setUnsavedScoresheetPhotos(id, [PHOTO_A], "photoStorage");
    closeTreeStore(id);
    expect(getUnsavedScoresheetPhotos(id)).toEqual([]);
});

test("global id-keyed cache is bounded and closing one of two duplicated tabs keeps the other's photos", () => {
    // Closing tab-1 must not evict ID_1 from the global cache used by duplicated tab-2.
    cacheStoredScoresheetPhotos([ID_1], [PHOTO_A]);
    disposeTabAtoms("tab-1");
    expect(getCachedScoresheetPhoto(ID_1)).toEqual({ status: "ok", dataUrl: PHOTO_A });

    // Global cache respects MAX_CACHED_SCORESHEET_PHOTOS.
    for (let i = 0; i < MAX_CACHED_SCORESHEET_PHOTOS + 3; i += 1) {
        const hexId = i.toString(16).padStart(64, "0");
        cacheStoredScoresheetPhotos([hexId], [PHOTO_A]);
    }
    expect(getCachedScoresheetPhoto(ID_1)).toBeUndefined();
    const newestId = (MAX_CACHED_SCORESHEET_PHOTOS + 2).toString(16).padStart(64, "0");
    expect(getCachedScoresheetPhoto(newestId)).toEqual({ status: "ok", dataUrl: PHOTO_A });
});

test("useResolvedScoresheetPhotos caches ok/missing, upgrades missing on store, never caches unreadable, handles native cancel, re-reads evicted ids, and aborts on tab disposal", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    let latest!: ResolvedScoresheetPhotosState;
    function Probe({ tabId, ids }: { tabId: string; ids: readonly string[] | null }) {
        latest = useResolvedScoresheetPhotos(tabId, ids);
        return null;
    }

    // 1. Late response for a previous game's id list is discarded and its signal is aborted.
    let resolveFirst!: (value: unknown) => void;
    let firstSignal!: AbortSignal;
    mocks.scoresheetReadPhotos.mockImplementationOnce(
        (_ids: string[], opts?: { signal?: AbortSignal }) => {
            firstSignal = opts!.signal!;
            return new Promise((resolve) => {
                resolveFirst = resolve;
            });
        },
    );

    await act(async () => {
        root!.render(createElement(Probe, { tabId: "tab-a", ids: [ID_1] }));
    });
    expect(latest.slots).toEqual([{ status: "loading" }]);
    expect(firstSignal.aborted).toBe(false);

    // Switch to a different game/id list before the first read settles.
    mocks.scoresheetReadPhotos.mockResolvedValueOnce([{ status: "ok", dataUrl: PHOTO_B }]);
    await act(async () => {
        root!.render(createElement(Probe, { tabId: "tab-a", ids: [ID_2] }));
    });
    expect(firstSignal.aborted).toBe(true);
    expect(latest.slots).toEqual([{ status: "ok", dataUrl: PHOTO_B }]);

    // Late response for ID_1 settles: must be discarded (neither cached nor shown).
    await act(async () => {
        resolveFirst([{ status: "ok", dataUrl: PHOTO_A }]);
        await Promise.resolve();
    });
    expect(getCachedScoresheetPhoto(ID_1)).toBeUndefined();
    expect(latest.slots).toEqual([{ status: "ok", dataUrl: PHOTO_B }]);

    // 2. Missing result is cached across mounts/tabs and upgraded to ok by cacheStoredScoresheetPhotos.
    mocks.scoresheetReadPhotos.mockResolvedValueOnce([{ status: "missing" }]);
    await act(async () => {
        root!.render(createElement(Probe, { tabId: "tab-missing-1", ids: [ID_MISSING] }));
    });
    expect(getCachedScoresheetPhoto(ID_MISSING)).toEqual({ status: "missing" });
    expect(latest.slots).toEqual([{ status: "missing" }]);

    const readsBeforeSecondMount = mocks.scoresheetReadPhotos.mock.calls.length;
    await act(async () => {
        root!.render(createElement(Probe, { tabId: "tab-missing-2", ids: [ID_MISSING] }));
    });
    expect(mocks.scoresheetReadPhotos).toHaveBeenCalledTimes(readsBeforeSecondMount);
    expect(latest.slots).toEqual([{ status: "missing" }]);

    await act(async () => {
        cacheStoredScoresheetPhotos([ID_MISSING], [PHOTO_A]);
    });
    expect(getCachedScoresheetPhoto(ID_MISSING)).toEqual({ status: "ok", dataUrl: PHOTO_A });
    expect(latest.slots).toEqual([{ status: "ok", dataUrl: PHOTO_A }]);

    // 3. Unreadable result is NOT cached and retry fetches it again.
    mocks.scoresheetReadPhotos.mockResolvedValueOnce([{ status: "unreadable" }]);
    await act(async () => {
        root!.render(createElement(Probe, { tabId: "tab-b", ids: [ID_1] }));
    });
    expect(getCachedScoresheetPhoto(ID_1)).toBeUndefined();
    expect(latest.slots).toEqual([{ status: "unreadable" }]);

    mocks.scoresheetReadPhotos.mockResolvedValueOnce([{ status: "ok", dataUrl: PHOTO_A }]);
    await act(async () => {
        latest.retry();
    });
    expect(getCachedScoresheetPhoto(ID_1)).toEqual({ status: "ok", dataUrl: PHOTO_A });
    expect(latest.slots).toEqual([{ status: "ok", dataUrl: PHOTO_A }]);

    // 4. Eviction of a cached id while mounted triggers a re-read instead of getting stuck loading.
    mocks.scoresheetReadPhotos.mockResolvedValueOnce([{ status: "ok", dataUrl: PHOTO_A }]);
    await act(async () => {
        for (let i = 0; i < MAX_CACHED_SCORESHEET_PHOTOS + 1; i += 1) {
            cacheStoredScoresheetPhotos([i.toString(16).padStart(64, "0")], [PHOTO_B]);
        }
    });
    expect(mocks.scoresheetReadPhotos).toHaveBeenLastCalledWith([ID_1], {
        signal: expect.any(AbortSignal),
    });
    expect(latest.slots).toEqual([{ status: "ok", dataUrl: PHOTO_A }]);

    // 5. Native "cancelled" for a still-active request settles to a terminal, retryable error.
    const ID_CANCEL = "c".repeat(64);
    mocks.scoresheetReadPhotos.mockRejectedValueOnce(new CoachCommandError("cancelled"));
    await act(async () => {
        root!.render(createElement(Probe, { tabId: "tab-cancel", ids: [ID_CANCEL] }));
    });
    expect(latest.readError).toBe("photoStorage");
    expect(latest.slots).toEqual([{ status: "unreadable" }]);

    mocks.scoresheetReadPhotos.mockResolvedValueOnce([{ status: "ok", dataUrl: PHOTO_A }]);
    await act(async () => {
        latest.retry();
    });
    expect(latest.readError).toBeNull();
    expect(latest.slots).toEqual([{ status: "ok", dataUrl: PHOTO_A }]);

    // 6. Command error is not cached and reports readError.
    const ID_ERR = "e".repeat(64);
    mocks.scoresheetReadPhotos.mockRejectedValueOnce(new CoachCommandError("photoStorage"));
    await act(async () => {
        root!.render(createElement(Probe, { tabId: "tab-c", ids: [ID_ERR] }));
    });
    expect(latest.readError).toBe("photoStorage");
    expect(getCachedScoresheetPhoto(ID_ERR)).toBeUndefined();

    // 7. Tab disposal via registerTabDisposer immediately aborts in-flight reads and discards late replies.
    const ID_DISPOSE = "d".repeat(64);
    let resolveDispose!: (value: unknown) => void;
    let disposeSignal!: AbortSignal;
    mocks.scoresheetReadPhotos.mockImplementationOnce(
        (_ids: string[], opts?: { signal?: AbortSignal }) => {
            disposeSignal = opts!.signal!;
            return new Promise((resolve) => {
                resolveDispose = resolve;
            });
        },
    );
    await act(async () => {
        root!.render(createElement(Probe, { tabId: "tab-dispose", ids: [ID_DISPOSE] }));
    });
    expect(disposeSignal.aborted).toBe(false);
    await act(async () => {
        disposeTabAtoms("tab-dispose");
    });
    expect(disposeSignal.aborted).toBe(true);
    await act(async () => {
        resolveDispose([{ status: "ok", dataUrl: PHOTO_A }]);
        await Promise.resolve();
    });
    expect(getCachedScoresheetPhoto(ID_DISPOSE)).toBeUndefined();
});

test("scoresheetNoticeAcceptedAtom persists per-connection acceptance under scoresheet-notice-accepted", () => {
    const jotai = createStore();
    expect(jotai.get(scoresheetNoticeAcceptedAtom)).toEqual([]);
    jotai.set(scoresheetNoticeAcceptedAtom, ["conn-1"]);
    expect(JSON.parse(localStorage.getItem("scoresheet-notice-accepted")!)).toEqual(["conn-1"]);
});
