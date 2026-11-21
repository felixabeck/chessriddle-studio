import { createContext, useContext, useEffect, useRef } from "react";
import { useStore } from "zustand";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
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
    storeRef.current = createTreeStore(id, initial, treeKey);
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
      if (!externalStore) store.dispose();
    };
  }, [store, chooser, externalStore]);

  return (
    <TreeStateContext.Provider value={store}>
      <VariationChooserContext.Provider value={chooser}>
        {children}
      </VariationChooserContext.Provider>
    </TreeStateContext.Provider>
  );
}
