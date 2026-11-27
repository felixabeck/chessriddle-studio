import { useEffect, useState } from "react";
import { normalizeError, warnSafely } from "@/platform/errors";
import { getOpening, openingLineFens } from "@/utils/chess";
import { LruCache } from "@/utils/lruCache";
import type { TreeNode } from "@/utils/treeReducer";

// Display of `Error::NoOpeningFound` in src-tauri/src/error.rs.
const NO_OPENING_FOUND = "No opening found";

/** Lines whose opening name is remembered app-wide; the least recently used one is dropped first. */
export const OPENING_NAME_CACHE_CAPACITY = 256;

/** Opening names by line, so a tab shown again renders its name at once. Failures are never stored. */
export const openingNameCache = new LruCache<string, string>(OPENING_NAME_CACHE_CAPACITY);

/**
 * The cached name of the longest leading part of `fens`, the line itself excluded, or `undefined`.
 *
 * `get_opening_from_fens` names a line after its deepest named position, so a leading part's name is
 * what the line's own lookup returns unless a later position is named too. Shown while that lookup
 * is pending, it keeps the name in place on each step through a game instead of blanking it for one
 * round trip, and it never shows a name from a line that does not lead to this one.
 */
function knownPrefixName(fens: string[]): string | undefined {
    for (let length = fens.length - 1; length > 0; length--) {
        const prefix = fens.slice(0, length).join("\n");
        if (openingNameCache.has(prefix)) return openingNameCache.get(prefix);
    }
    return undefined;
}

/**
 * Looks up the opening name for `(root, position)` with an app-wide LRU cache, caching negative
 * "No opening found" results as `""` and discarding stale or failed results. While a line's lookup
 * is pending it shows the name of the line's longest cached leading part (`knownPrefixName`).
 */
export function useOpeningName(root: TreeNode, position: number[]): string {
    // The line key and name of the most recent lookup this mount completed, shown only while that
    // line is still current. The cache read below is memoized on `key` by React Compiler, so a result
    // arriving after the render reaches the screen through here.
    const [lastLookup, setLastLookup] = useState<{ key: string; name: string } | null>(null);

    // The FENs `getOpening` sends determine its result, so they identify the cached name. FENs hold
    // no newline.
    const fens = openingLineFens(root, position);
    const key = fens.join("\n");
    const rawName =
        lastLookup?.key === key
            ? lastLookup.name
            : (openingNameCache.get(key) ?? knownPrefixName(fens));
    const openingName = typeof rawName === "string" ? rawName : "";

    useEffect(() => {
        if (openingNameCache.get(key) !== undefined) return;
        let cancelled = false;
        void getOpening(root, position).then(
            (name) => {
                const normalized = typeof name === "string" ? name : "";
                openingNameCache.set(key, normalized);
                if (!cancelled) setLastLookup({ key, name: normalized });
            },
            (error: unknown) => {
                const message = normalizeError(error).message;
                if (message === NO_OPENING_FOUND) {
                    // A line without an opening is a result, remembered like a name.
                    openingNameCache.set(key, "");
                    if (!cancelled) setLastLookup({ key, name: "" });
                    return;
                }
                if (cancelled) return;
                // Not cached, so the next mount retries; this mount stops showing a prefix's name.
                setLastLookup({ key, name: "" });
                warnSafely(message);
            },
        );
        return () => {
            cancelled = true;
        };
    }, [key, root, position]);

    return openingName;
}
