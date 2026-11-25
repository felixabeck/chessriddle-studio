import { atom } from "jotai";
import { z } from "zod";
import { decodeCompressedOrJson, serializeStorageValue } from "./store/debouncedStorage";
import { reportPreferenceStorageFailure } from "./utils";

/** App pages that open as closable tabs at the front of the navigation row. */
export const PAGE_TABS = ["accounts", "engines", "settings", "guide"] as const;
export type PageTab = (typeof PAGE_TABS)[number];

/** Its own sessionStorage key, so page tabs share the board tabs' storage and lifetime. */
export const PAGE_TABS_STORAGE_KEY = "pageTabs";

// At most one entry per page, so the list is bounded by PAGE_TABS.length.
const pageTabsSchema = z
    .array(z.enum(PAGE_TABS))
    .max(PAGE_TABS.length)
    .refine((pages) => new Set(pages).size === pages.length);

/** Absent, corrupt or older-shape values fall back to no open page tabs. */
export function readPageTabs(storage: Pick<Storage, "getItem">): PageTab[] {
    let stored: string | null;
    try {
        stored = storage.getItem(PAGE_TABS_STORAGE_KEY);
    } catch (error) {
        reportPreferenceStorageFailure("read", error);
        return [];
    }
    const parsed = pageTabsSchema.safeParse(decodeCompressedOrJson(stored));
    return parsed.success ? parsed.data : [];
}

function writePageTabs(storage: Pick<Storage, "setItem">, pages: PageTab[]) {
    try {
        storage.setItem(PAGE_TABS_STORAGE_KEY, serializeStorageValue(pages));
    } catch (error) {
        // The tabs stay open for this session; only their restoration is lost.
        reportPreferenceStorageFailure("save", error);
    }
}

const publishedPageTabsAtom = atom<PageTab[] | null>(null);

/** Open page tabs in the order they were opened. */
export const pageTabsAtom = atom(
    (get) => get(publishedPageTabsAtom) ?? readPageTabs(sessionStorage),
    (get, set, update: (pages: PageTab[]) => PageTab[]) => {
        const previous = get(pageTabsAtom);
        const next = update(previous);
        if (next === previous) return;
        set(publishedPageTabsAtom, next);
        writePageTabs(sessionStorage, next);
    },
);
