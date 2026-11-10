import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useStore } from "zustand";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { fixtureNode } from "@/tests/treeFixtures";
import { defaultTree, getEffectiveTermination } from "@/utils/treeReducer";
import GameInfo from "./GameInfo";
import { TreeStateContext } from "./TreeStateContext";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../databases/FideInfo", () => ({ default: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;
let store: TreeStore;
let matchMediaDescriptor: PropertyDescriptor | undefined;
let resizeObserverDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  installMatchMediaStub();
  resizeObserverDescriptor = Object.getOwnPropertyDescriptor(window, "ResizeObserver");
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  installResizeObserverStub();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  store = createTreeStore();
});

afterEach(async () => {
  try {
    await act(async () => root.unmount());
  } finally {
    host.remove();
    if (matchMediaDescriptor) Object.defineProperty(window, "matchMedia", matchMediaDescriptor);
    else Reflect.deleteProperty(window, "matchMedia");
    if (resizeObserverDescriptor)
      Object.defineProperty(window, "ResizeObserver", resizeObserverDescriptor);
    else Reflect.deleteProperty(window, "ResizeObserver");
  }
});

function Editor() {
  const headers = useStore(store, (state) => state.headers);
  return (
    <MantineProvider env="test">
      <TreeStateContext.Provider value={store}>
        <GameInfo headers={headers} />
      </TreeStateContext.Provider>
    </MantineProvider>
  );
}

function expectSiteLink(site: string, label: string) {
  const anchors = host.querySelectorAll("a");
  expect(anchors).toHaveLength(1);
  const anchor = anchors[0];
  expect(anchor.textContent).toBe(label);
  expect(anchor.getAttribute("href")).toBe(site);
  expect(anchor.getAttribute("rel")).toBe("noreferrer");
  expect(anchor.getAttribute("target")).toBe("_blank");
}

test.each([
  ["https://lichess.org/Abcd1234", "Lichess"],
  ["https://www.chess.com/game/live/123", "Chess.com"],
])("brands the genuine site %s as %s", async (site, label) => {
  const state = defaultTree();
  store.getState().setState({ ...state, headers: { ...state.headers, site } });
  await act(async () => root.render(<Editor />));

  expectSiteLink(site, label);
});

test.each([
  "https://lichess.org.attacker.invalid/game",
  "https://www.chess.com.attacker.invalid/game",
  "https://lichess.org@attacker.invalid/game",
  "https://www.chess.com@attacker.invalid/game",
  "https://user:pw@lichess.org/game",
  "https://user@lichess.org/game",
  "https://:pw@lichess.org/game",
  "http://lichess.org/game",
  "https://lichess.org:8443/game",
  "https://lichess.org bad",
])("keeps the untrusted site %s unbranded and editable", async (site) => {
  const state = defaultTree();
  store.getState().setState({ ...state, headers: { ...state.headers, site } });
  await act(async () => root.render(<Editor />));

  expect(host.querySelector("a")).toBeNull();
  expect(host.textContent).not.toContain("Lichess");
  expect(host.textContent).not.toContain("Chess.com");
  const field = host.querySelector<HTMLInputElement>('input[placeholder="GameInfo.UnknownSite"]');
  expect(field).not.toBeNull();
  expect(field?.value).toBe(site);
});

test("keeps a read-only lookalike site literal and brands a genuine site without tree context", async () => {
  const headers = defaultTree().headers;
  const site = "https://lichess.org.attacker.invalid/game";
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <GameInfo headers={{ ...headers, site }} />
      </MantineProvider>,
    ),
  );

  expect(host.querySelector("a")).toBeNull();
  expect(host.textContent).toContain(site);
  expect(host.textContent).not.toContain("Lichess");
  expect(host.textContent).not.toContain("Chess.com");

  const genuineSite = "https://lichess.org/Abcd1234";
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <GameInfo headers={{ ...headers, site: genuineSite }} />
      </MantineProvider>,
    ),
  );

  expectSiteLink(genuineSite, "Lichess");
});

test("the Termination field reads the effective value and edits and clears it through the store", async () => {
  const state = defaultTree();
  const node = fixtureNode("e4");
  node.gameEnd = { termination: "Abandoned" };
  state.root.children = [node];
  state.headers.other = { Termination: "Old header" };
  store.getState().setState(state);
  const setTermination = vi.spyOn(store.getState(), "setTermination");
  await act(async () => root.render(<Editor />));
  const field = host.querySelector<HTMLInputElement>('input[aria-label="GameInfo.Termination"]')!;
  expect(field).not.toBeNull();
  expect(field.value).toBe("Abandoned");
  expect(field.placeholder).toBe("GameInfo.Termination");
  expect(field.parentElement?.querySelector("#game-result")).not.toBeNull();
  for (const value of ["Time forfeit", ""]) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(setTermination).toHaveBeenLastCalledWith(value);
    expect(getEffectiveTermination(store.getState())).toBe(value || undefined);
    expect(store.getState().headers.other?.Termination).toBeUndefined();
    expect(field.value).toBe(value);
  }
  await act(async () => store.getState().clearGameEnd());
  expect(host.querySelector('[aria-label="GameInfo.Termination"]')).toBeNull();
});

test("the Termination field is hidden without an effective end", async () => {
  const state = defaultTree();
  state.root.children = [
    fixtureNode("e4"),
    { ...fixtureNode("d4"), gameEnd: { termination: "Abandoned" } },
  ];
  state.headers.other = { Termination: "Normal" };
  store.getState().setState(state);
  await act(async () => root.render(<Editor />));
  expect(host.querySelector('[aria-label="GameInfo.Termination"]')).toBeNull();
});
