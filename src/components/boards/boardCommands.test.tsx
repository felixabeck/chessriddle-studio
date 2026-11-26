import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { boardCommandAtom, useBoardCommands } from "./boardCommands";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function Consumer(props: {
  tabId: string;
  save: () => void;
  saveTo: () => void;
  saveLayoutAs: () => void;
  manageLayouts: () => void;
}) {
  useBoardCommands(props.tabId, {
    save: props.save,
    saveTo: props.saveTo,
    saveLayoutAs: props.saveLayoutAs,
    manageLayouts: props.manageLayouts,
  });
  return null;
}

async function setup(tabId: string) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const store = createStore();
  const save = vi.fn();
  const saveTo = vi.fn();
  const saveLayoutAs = vi.fn();
  const manageLayouts = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <Provider store={store}>
        <Consumer
          tabId={tabId}
          save={save}
          saveTo={saveTo}
          saveLayoutAs={saveLayoutAs}
          manageLayouts={manageLayouts}
        />
      </Provider>,
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { store, save, saveTo, saveLayoutAs, manageLayouts };
}

test("a Save request for this tab runs the board's save once and is consumed", async () => {
  const { store, save, saveTo } = await setup("tab-a");
  await act(async () => store.set(boardCommandAtom, { tabId: "tab-a", kind: "save" }));
  expect(save).toHaveBeenCalledOnce();
  expect(saveTo).not.toHaveBeenCalled();
  expect(store.get(boardCommandAtom)).toBeNull();
});

test("a Save to… request opens the board's dialog", async () => {
  const { store, save, saveTo } = await setup("tab-a");
  await act(async () => store.set(boardCommandAtom, { tabId: "tab-a", kind: "saveTo" }));
  expect(saveTo).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
});

test("layout requests open Save layout as… and Manage layouts… and are consumed", async () => {
  const { store, saveLayoutAs, manageLayouts } = await setup("tab-a");
  await act(async () => store.set(boardCommandAtom, { tabId: "tab-a", kind: "saveLayoutAs" }));
  expect(saveLayoutAs).toHaveBeenCalledOnce();
  expect(manageLayouts).not.toHaveBeenCalled();
  expect(store.get(boardCommandAtom)).toBeNull();

  await act(async () => store.set(boardCommandAtom, { tabId: "tab-a", kind: "manageLayouts" }));
  expect(manageLayouts).toHaveBeenCalledOnce();
  expect(store.get(boardCommandAtom)).toBeNull();
});

test("a request for another tab is left alone", async () => {
  const { store, save, saveTo } = await setup("tab-a");
  await act(async () => store.set(boardCommandAtom, { tabId: "tab-b", kind: "save" }));
  expect(save).not.toHaveBeenCalled();
  expect(saveTo).not.toHaveBeenCalled();
  expect(store.get(boardCommandAtom)).toEqual({ tabId: "tab-b", kind: "save" });
});
