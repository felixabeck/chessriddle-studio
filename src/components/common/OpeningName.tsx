import { Text } from "@mantine/core";
import { useContext, useEffect, useState } from "react";
import { useStore } from "zustand";
import { normalizeError, warnSafely } from "@/platform/errors";
import { getOpening, openingLineFens } from "@/utils/chess";
import { TreeStateContext } from "./TreeStateContext";

// Display of `Error::NoOpeningFound` in src-tauri/src/error.rs.
const NO_OPENING_FOUND = "No opening found";

/** Lines whose opening name is remembered app-wide; the least recently used one is dropped first. */
export const OPENING_NAME_CACHE_CAPACITY = 256;

/** Opening names by line, so a tab shown again renders its name at once. Failures are never stored. */
export const openingNameCache = {
  entries: new Map<string, string>(),
  get(key: string): string | undefined {
    const name = this.entries.get(key);
    if (name !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, name);
    }
    return name;
  },
  set(key: string, name: string) {
    this.entries.delete(key);
    this.entries.set(key, name);
    if (this.entries.size > OPENING_NAME_CACHE_CAPACITY) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  },
  clear() {
    this.entries.clear();
  },
};

function OpeningName() {
  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const position = useStore(store, (s) => s.position);
  // The last lookup this mount finished, tagged with its line. The cache read below is memoized on
  // `key` by React Compiler, so a result arriving after the render reaches the screen through here.
  const [looked, setLooked] = useState<{ key: string; name: string } | null>(null);

  // The FENs `getOpening` sends determine its result, so they identify the cached name. FENs hold
  // no newline.
  const key = openingLineFens(root, position).join("\n");
  const cached = openingNameCache.get(key);
  const openingName = looked?.key === key ? looked.name : (cached ?? "");

  useEffect(() => {
    if (openingNameCache.get(key) !== undefined) return;
    let cancelled = false;
    void getOpening(root, position).then(
      (name) => {
        openingNameCache.set(key, name);
        if (!cancelled) setLooked({ key, name });
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
