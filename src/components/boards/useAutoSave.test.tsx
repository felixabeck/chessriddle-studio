import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { StoreApi } from "zustand";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createTreeStore, type TreeStoreState } from "@/state/store/tree";
import { serializeStoreTree } from "@/utils/tabs";
import { useAutoSave } from "./useAutoSave";

function AutoSave({
  store,
  save,
  enabled,
}: {
  store: StoreApi<TreeStoreState>;
  save: () => Promise<unknown>;
  enabled: boolean;
}) {
  useAutoSave(store, enabled, save);
  return null;
}

const roots: Root[] = [];

// One root per test: re-rendering it with another `enabled` keeps the board mounted, as the
// autosave setting does; unmounting it is a board remount.
async function mount(
  store: StoreApi<TreeStoreState>,
  save: () => Promise<unknown>,
  enabled = true,
) {
  if (roots.length === 0) roots.push(createRoot(document.createElement("div")));
  const root = roots[0]!;
  await act(async () => root.render(<AutoSave store={store} save={save} enabled={enabled} />));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

describe("useAutoSave", () => {
  test("a remounted board does not rewrite a PGN whose autosave already ran", async () => {
    const store = createTreeStore();
    store.getState().setComment("Edited");
    expect(store.getState().dirty).toBe(true);
    // A write that leaves the tree dirty, like a refused autosave.
    const save = vi.fn(async () => {});

    await mount(store, save);
    expect(save).toHaveBeenCalledTimes(1);
    act(() => roots.splice(0).forEach((root) => root.unmount()));

    // A failed write can make the file-freshness gate remount the board. The remount must not
    // write the same PGN again, or the failure repeats on every remount.
    await mount(store, save);
    expect(save).toHaveBeenCalledTimes(1);

    // A later edit changes the PGN and is written once.
    await act(async () => store.getState().setComment("Edited again"));
    expect(save).toHaveBeenCalledTimes(2);
  });

  test("a clean tree ends the record, also while autosave is off", async () => {
    const store = createTreeStore();
    store.getState().setComment("Edited");
    const save = vi.fn(async () => {});
    await mount(store, save, true);
    expect(save).toHaveBeenCalledTimes(1);
    const edited = serializeStoreTree(store);

    // Autosave goes off, a manual save cleans the tree, and an edit returns to the same PGN.
    await mount(store, save, false);
    await act(async () => store.getState().save());
    await act(async () => store.getState().setComment("Other"));
    await act(async () => store.getState().setComment("Edited"));
    expect(serializeStoreTree(store)).toBe(edited);
    expect(store.getState().dirty).toBe(true);

    // Back on, that PGN is written again: it is a new attempt, not the one recorded earlier.
    await mount(store, save, true);
    expect(save).toHaveBeenCalledTimes(2);
  });

  test("a tree cleaned while no board was mounted ends the record when one mounts with autosave off", async () => {
    const store = createTreeStore();
    store.getState().setComment("Edited");
    const save = vi.fn(async () => {});
    await mount(store, save, true);
    expect(save).toHaveBeenCalledTimes(1);
    act(() => roots.splice(0).forEach((root) => root.unmount()));

    // Cleaned with no board subscribed, then a board mounts with autosave off.
    store.getState().save();
    await mount(store, save, false);
    await act(async () => store.getState().setComment("Other"));
    await act(async () => store.getState().setComment("Edited"));

    await mount(store, save, true);
    expect(save).toHaveBeenCalledTimes(2);
  });
});
