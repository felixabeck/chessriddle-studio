import { useSetAtom } from "jotai";
import { createContext, useCallback, useContext, useEffect, useRef } from "react";
import { useStore } from "zustand";
import { showVariationsFamily } from "@/state/atoms";
import { useTabAtom } from "@/state/tabScope";
import { createTreeStore, getOrCreateTreeStore, type TreeStore } from "@/state/store/tree";
import {
  createVariationChooserStore,
  subscribeVariationChooser,
  type VariationChooserStore,
} from "@/state/store/variationChooser";
import type { TreeState } from "@/utils/treeReducer";

export const TreeStateContext = createContext<TreeStore | null>(null);
export const VariationChooserContext = createContext<VariationChooserStore | null>(null);

export function useVariationChooser() {
  const store = useContext(VariationChooserContext)!;
  return useStore(store);
}

/**
 * Jumps to the next open variation and, when the cursor moved, turns the tab's variations on:
 * the target is a side line, which "hide variations" would keep out of the notation.
 */
export function useGoToNextOpenVariation(store: TreeStore): () => void {
  const setShowVariations = useSetAtom(useTabAtom(showVariationsFamily));
  return useCallback(() => {
    const before = store.getState().position;
    store.getState().goToNextOpenVariation();
    if (store.getState().position !== before) setShowVariations(true);
  }, [store, setShowVariations]);
}

export function TreeStateProvider({
  id,
  treeKey,
  initial,
  store: externalStore,
  children,
}: {
  id?: string;
  treeKey?: string;
  initial?: TreeState;
  store?: TreeStore;
  children: React.ReactNode;
}) {
  const storeRef = useRef<TreeStore | null>(null);
  if (storeRef.current === null && !externalStore) {
    storeRef.current = id
      ? getOrCreateTreeStore(id, initial, treeKey)
      : createTreeStore(undefined, initial);
  }
  const store = externalStore ?? storeRef.current!;
  const chooserRef = useRef<VariationChooserStore | null>(null);
  if (chooserRef.current === null) chooserRef.current = createVariationChooserStore();
  const chooser = chooserRef.current;

  useEffect(() => {
    const unsubscribe = subscribeVariationChooser(store, chooser);
    return () => {
      unsubscribe();
      chooser.getState().close();
    };
  }, [store, chooser]);

  return (
    <TreeStateContext.Provider value={store}>
      <VariationChooserContext.Provider value={chooser}>
        {children}
      </VariationChooserContext.Provider>
    </TreeStateContext.Provider>
  );
}
