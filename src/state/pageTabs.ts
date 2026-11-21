import { atom } from "jotai";
import { z } from "zod";
import { decodeCompressedOrJson, serializeStorageValue } from "./store/debouncedStorage";
import { persistStorageWriteError } from "./storageWriteError";
import { reportPersistError } from "./persistError";

/** App pages that open as closable tabs at the front of the navigation row. */
export const PAGE_TABS = ["accounts", "engines", "settings"] as const;
export type PageTab = (typeof PAGE_TABS)[number];

/** Same storage and lifetime as the board-tab workspace (`WORKSPACE_STORAGE_KEY`). */
export const PAGE_TABS_STORAGE_KEY = "pageTabs";

// At most one entry per page, so the list is bounded by PAGE_TABS.length.
const pageTabsSchema = z
    .array(z.enum(PAGE_TABS))
    .max(PAGE_TABS.length)
    .refine((pages) => new Set(pages).size === pages.length);

/** Absent, corrupt or older-shape values fall back to no open page tabs. */
export function readPageTabs(storage: Pick<Storage, "getItem">): PageTab[] {
    try {
        const parsed = pageTabsSchema.safeParse(
            decodeCompressedOrJson(storage.getItem(PAGE_TABS_STORAGE_KEY)),
        );
        return parsed.success ? parsed.data : [];
    } catch {
        return [];
    }
}

function writePageTabs(storage: Pick<Storage, "setItem">, pages: PageTab[]) {
    try {
        storage.setItem(PAGE_TABS_STORAGE_KEY, serializeStorageValue(pages));
    } catch (error) {
        // The tabs stay open for this session; only their restoration is lost.
        reportPersistError(persistStorageWriteError(error));
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
