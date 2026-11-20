import { Text } from "@mantine/core";
import { useContext, useEffect, useState } from "react";
import { useStore } from "zustand";
import { normalizeError, warnSafely } from "@/platform/errors";
import { getOpening, openingLineFens } from "@/utils/chess";
import { LruCache } from "@/utils/lruCache";
import { TreeStateContext } from "./TreeStateContext";

// Display of `Error::NoOpeningFound` in src-tauri/src/error.rs.
const NO_OPENING_FOUND = "No opening found";

/** Lines whose opening name is remembered app-wide; the least recently used one is dropped first. */
export const OPENING_NAME_CACHE_CAPACITY = 256;

/** Opening names by line, so a tab shown again renders its name at once. Failures are never stored. */
export const openingNameCache = new LruCache<string, string>(OPENING_NAME_CACHE_CAPACITY);

function OpeningName() {
  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);
  // The line key and name of the most recent lookup this mount completed, shown only while that
  // line is still current. The cache read below is memoized on `key` by React Compiler, so a result
  // arriving after the render reaches the screen through here.
  const [lastLookup, setLastLookup] = useState<{ key: string; name: string } | null>(null);

  // The FENs `getOpening` sends determine its result, so they identify the cached name. FENs hold
  // no newline.
  const key = openingLineFens(root, position).join("\n");
  const cached = openingNameCache.get(key);
  const openingName = lastLookup?.key === key ? lastLookup.name : (cached ?? "");

  useEffect(() => {
    if (openingNameCache.get(key) !== undefined) return;
    let cancelled = false;
    void getOpening(root, position).then(
      (name) => {
        openingNameCache.set(key, name);
        if (!cancelled) setLastLookup({ key, name });
      },
      (error: unknown) => {
        const message = normalizeError(error).message;
        if (message === NO_OPENING_FOUND) {
          // A line without an opening is a result, remembered like a name.
          openingNameCache.set(key, "");
          return;
        }
        if (!cancelled) warnSafely(message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, root, position]);

  return (
    <Text style={{ userSelect: "text" }} fz="sm">
      {openingName}
    </Text>
  );
}

export default OpeningName;
