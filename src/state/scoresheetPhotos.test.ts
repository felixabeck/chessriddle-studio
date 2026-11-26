import { createStore } from "jotai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { disposeTabAtoms } from "@/state/atoms";
import { closeTreeStore, createTreeStore } from "@/state/store/tree";
import { defaultTree } from "@/utils/treeReducer";
import {
    clearAllScoresheetPhotosForTests,
    clearScoresheetPhotos,
    getScoresheetPhotos,
    MAX_SCORESHEET_PHOTO_TABS,
    MAX_SCORESHEET_PHOTOS_PER_TAB,
    scoresheetNoticeAcceptedAtom,
    setScoresheetPhotos,
    subscribeScoresheetPhotos,
} from "./scoresheetPhotos";

const PHOTO_A = "data:image/jpeg;base64,AAAA";
const PHOTO_B = "data:image/jpeg;base64,BBBB";
const PHOTO_C = "data:image/jpeg;base64,CCCC";
const PHOTO_D = "data:image/jpeg;base64,DDDD";
const PHOTO_E = "data:image/jpeg;base64,EEEE";

beforeEach(() => {
    clearAllScoresheetPhotosForTests();
    sessionStorage.clear();
    localStorage.clear();
});

afterEach(() => {
    clearAllScoresheetPhotosForTests();
});

test("keeps at most 4 photos per tab, accepts only JPEG data URLs, and never writes to web storage", () => {
    setScoresheetPhotos("tab-1", [
        PHOTO_A,
        "data:image/png;base64,NOPE",
        PHOTO_B,
        PHOTO_C,
        PHOTO_D,
        PHOTO_E,
    ]);

    expect(getScoresheetPhotos("tab-1")).toEqual([PHOTO_A, PHOTO_B, PHOTO_C, PHOTO_D]);
    expect(getScoresheetPhotos("tab-1")).toHaveLength(MAX_SCORESHEET_PHOTOS_PER_TAB);
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
});

test("evicts the oldest tab once more than 4 tabs hold photos", () => {
    for (let i = 1; i <= MAX_SCORESHEET_PHOTO_TABS + 1; i++) {
        setScoresheetPhotos(`tab-${i}`, [PHOTO_A]);
    }

    expect(getScoresheetPhotos("tab-1")).toEqual([]);
    expect(getScoresheetPhotos("tab-2")).toEqual([PHOTO_A]);
    expect(getScoresheetPhotos("tab-5")).toEqual([PHOTO_A]);
});

test("notifies subscribers on set and clear, and removes photos on tab close", () => {
    let calls = 0;
    const unsubscribe = subscribeScoresheetPhotos(() => {
        calls++;
    });

    setScoresheetPhotos("tab-close", [PHOTO_A]);
    expect(calls).toBe(1);
    disposeTabAtoms("tab-close");
    expect(getScoresheetPhotos("tab-close")).toEqual([]);
    expect(calls).toBe(2);

    // Clearing an already absent tab is a no-op.
    clearScoresheetPhotos("tab-close");
    expect(calls).toBe(2);
    unsubscribe();
});

test("removes photos when another game is installed, start FEN changes, or store closes", () => {
    const id = crypto.randomUUID();
    const store = createTreeStore(id, { ...defaultTree(), scoresheetReview: {} });

    setScoresheetPhotos(id, [PHOTO_A]);
    store.getState().setState(defaultTree());
    expect(getScoresheetPhotos(id)).toEqual([]);

    setScoresheetPhotos(id, [PHOTO_A]);
    store.getState().reset();
    expect(getScoresheetPhotos(id)).toEqual([]);

    setScoresheetPhotos(id, [PHOTO_A]);
    store.getState().setFen("4k3/8/8/8/8/8/8/4K3 w - - 0 1");
    expect(getScoresheetPhotos(id)).toEqual([]);

    setScoresheetPhotos(id, [PHOTO_A]);
    store.getState().setHeaders({
        ...store.getState().headers,
        fen: "4k3/8/8/8/4P3/8/8/4K3 b - - 0 1",
    });
    expect(getScoresheetPhotos(id)).toEqual([]);

    setScoresheetPhotos(id, [PHOTO_A]);
    closeTreeStore(id);
    expect(getScoresheetPhotos(id)).toEqual([]);
});

test("scoresheetNoticeAcceptedAtom persists per-connection acceptance under scoresheet-notice-accepted", () => {
    const jotai = createStore();
    expect(jotai.get(scoresheetNoticeAcceptedAtom)).toEqual([]);
    jotai.set(scoresheetNoticeAcceptedAtom, ["conn-1"]);
    expect(JSON.parse(localStorage.getItem("scoresheet-notice-accepted")!)).toEqual(["conn-1"]);
});
