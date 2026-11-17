import { MantineProvider } from "@mantine/core";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
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

dayjs.extend(customParseFormat);

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

function Editor({ simplified = false }: { simplified?: boolean }) {
  const headers = useStore(store, (state) => state.headers);
  return (
    <MantineProvider env="test">
      <TreeStateContext.Provider value={store}>
        <GameInfo headers={headers} simplified={simplified} />
      </TreeStateContext.Provider>
    </MantineProvider>
  );
}

test.each(["", "?", "   "])(
  "simplified editing shows an editable Event fallback for White %j",
  async (white) => {
    const headers = {
      ...defaultTree().headers,
      white,
      black: "?",
      event: "Legacy opening",
      round: "2",
    };
    store.getState().setHeaders(headers);
    await act(async () => root.render(<Editor simplified />));
    const name = host.querySelector<HTMLInputElement>('input[aria-label="GameInfo.LineName"]')!;
    const idea = host.querySelector<HTMLInputElement>('input[aria-label="GameInfo.Idea"]')!;
    expect(name.value).toBe("Legacy opening");
    expect(name.placeholder).toBe("GameInfo.EnterLineName");
    expect(idea.value).toBe("");
    expect(idea.placeholder).toBe("GameInfo.EnterIdea");
    expect(host.querySelector('input[placeholder="GameInfo.UnknownEvent"]')).toBeNull();
    expect(host.querySelector('input[placeholder="?"]')).toBeNull();
    expect(host.textContent).toContain("GameInfo.OpeningFor");

    for (const [field, value, key] of [
      [name, "Dragon System", "white"],
      [idea, "6...Dc7 plan", "black"],
    ] as const) {
      for (let length = 1; length <= value.length; length += 1) {
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
            field,
            value.slice(0, length),
          );
          field.dispatchEvent(new Event("input", { bubbles: true }));
        });
        expect(store.getState().headers[key]).toBe(value.slice(0, length));
        expect(field.value).toBe(value.slice(0, length));
        expect(store.getState().headers.event).toBe("Legacy opening");
      }
    }
    expect(store.getState().headers).toEqual({
      ...headers,
      white: "Dragon System",
      black: "6...Dc7 plan",
    });
  },
);

function setNativeInputValue(field: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
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

test("clearing the round keeps the field mounted so it can be retyped", async () => {
  store.getState().setHeaders({ ...defaultTree().headers, round: "3" });
  await act(async () => root.render(<Editor />));
  const field = host.querySelector<HTMLInputElement>('input[aria-label="GameInfo.Round"]')!;
  expect(field.value).toBe("3");

  await act(async () => setNativeInputValue(field, ""));
  expect(store.getState().headers.round).toBe("");
  expect(field.isConnected).toBe(true);
  expect(host.textContent).toContain("GameInfo.Round");

  await act(async () => setNativeInputValue(field, "4"));
  expect(store.getState().headers.round).toBe("4");
  expect(field.value).toBe("4");
});

test.each([undefined, "?"] as const)(
  "editable view shows an empty round field when round is %j",
  async (round) => {
    store.getState().setHeaders({ ...defaultTree().headers, round });
    await act(async () => root.render(<Editor />));
    const field = host.querySelector<HTMLInputElement>('input[aria-label="GameInfo.Round"]')!;
    expect(field).not.toBeNull();
    expect(field.value).toBe("");
    expect(field.placeholder).toBe("?");
    await act(async () => setNativeInputValue(field, "2"));
    expect(store.getState().headers.round).toBe("2");
  },
);

test.each([undefined, "?"] as const)(
  "read-only view hides an empty round when round is %j",
  async (round) => {
    await act(async () =>
      root.render(
        <MantineProvider env="test">
          <GameInfo headers={{ ...defaultTree().headers, round }} />
        </MantineProvider>,
      ),
    );
    expect(host.querySelector('input[aria-label="GameInfo.Round"]')).toBeNull();
    expect(host.textContent).not.toContain("GameInfo.Round");
  },
);

test("read-only view shows a filled round", async () => {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <GameInfo headers={{ ...defaultTree().headers, round: "5" }} />
      </MantineProvider>,
    ),
  );
  expect(host.textContent).toContain("GameInfo.Round");
  const field = host.querySelector<HTMLInputElement>('input[aria-label="GameInfo.Round"]');
  expect(field).not.toBeNull();
  expect(field?.value).toBe("5");
});

test("a partial PGN date is shown as the date placeholder", async () => {
  store.getState().setHeaders({ ...defaultTree().headers, date: "1972.??.??" });
  await act(async () => root.render(<Editor />));
  const partial = host.querySelector<HTMLInputElement>('input[aria-label="Common.Date"]')!;
  expect(partial).not.toBeNull();
  expect(partial.value).toBe("");
  expect(partial.placeholder).toBe("1972.??.??");
  expect(store.getState().headers.date).toBe("1972.??.??");

  await act(async () =>
    store.getState().setHeaders({ ...store.getState().headers, date: "2024.05.17" }),
  );
  const full = host.querySelector<HTMLInputElement>('input[aria-label="Common.Date"]')!;
  expect(full.placeholder).toBe("????.??.??");
});

test("full layout names every header field", async () => {
  await act(async () => root.render(<Editor />));
  for (const label of [
    "Databases.Game.Event",
    "Databases.Game.Site",
    "Common.Date",
    "Fen.White",
    "Fen.Black",
    "GameInfo.WhiteElo",
    "GameInfo.BlackElo",
    "GameInfo.Round",
  ]) {
    expect(host.querySelector(`input[aria-label="${label}"]`)).not.toBeNull();
  }
});

function resultField() {
  return host.querySelector<HTMLInputElement>("#game-result")!;
}

function resultListOpen() {
  return resultField().getAttribute("aria-expanded") === "true";
}

function checkedResultOption() {
  return document.body.querySelector('[role="option"][data-checked]')?.textContent;
}

function selectedResultOption() {
  return document.body.querySelector('[role="option"][data-combobox-selected]')?.textContent;
}

// jsdom has no scrollIntoView; Mantine calls it while moving the active option.
function stubScrollIntoView() {
  const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  Element.prototype.scrollIntoView = () => {};
  return () => {
    if (original) Object.defineProperty(Element.prototype, "scrollIntoView", original);
    else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  };
}

async function pressResultKey(code: string) {
  const restore = stubScrollIntoView();
  try {
    await act(async () => {
      resultField().dispatchEvent(new KeyboardEvent("keydown", { code, key: code, bubbles: true }));
    });
  } finally {
    restore();
  }
}

test("Tab focus on the result opens the list with the current result active", async () => {
  store.getState().setHeaders({ ...defaultTree().headers, result: "0-1" });
  await act(async () => root.render(<Editor />));
  expect(resultListOpen()).toBe(false);

  await act(async () => resultField().focus());
  expect(resultListOpen()).toBe(true);
  expect(checkedResultOption()).toBe("0-1");
  // Mantine anchors the keyboard cursor on the checked option one tick after opening.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

  await pressResultKey("ArrowDown");
  expect(selectedResultOption()).toBe("1/2-1/2");
  await pressResultKey("Enter");
  expect(store.getState().headers.result).toBe("1/2-1/2");
  expect(resultListOpen()).toBe(false);
});

test("leaving the result field closes the list without changing the result", async () => {
  store.getState().setHeaders({ ...defaultTree().headers, result: "1-0" });
  await act(async () => root.render(<Editor />));
  await act(async () => resultField().focus());
  expect(resultListOpen()).toBe(true);

  await pressResultKey("ArrowDown");
  await act(async () => resultField().blur());
  expect(resultListOpen()).toBe(false);
  expect(store.getState().headers.result).toBe("1-0");
});

test("a mouse press on the result opens the list once instead of toggling it shut", async () => {
  await act(async () => root.render(<Editor />));
  await act(async () => {
    resultField().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    resultField().focus();
    resultField().click();
  });
  expect(resultListOpen()).toBe(true);

  // A press on the already focused field fires no focus event, so it leaves the pointer flag set.
  await act(async () => {
    resultField().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    resultField().click();
  });
  expect(resultListOpen()).toBe(false);
  expect(document.activeElement).toBe(resultField());

  // Leaving must clear that flag so the next Tab opens.
  await act(async () => resultField().blur());
  await act(async () => resultField().focus());
  expect(resultListOpen()).toBe(true);
});

test("a read-only result never opens the list", async () => {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <GameInfo headers={defaultTree().headers} />
      </MantineProvider>,
    ),
  );
  await act(async () => resultField().focus());
  await act(async () => resultField().click());
  await pressResultKey("ArrowDown");
  expect(resultListOpen()).toBe(false);
  expect(resultField().value).toBe("*");
});

test("Enter and Space reopen the result list after Escape closed it", async () => {
  await act(async () => root.render(<Editor />));
  await act(async () => resultField().focus());
  expect(resultListOpen()).toBe(true);
  await pressResultKey("Escape");
  expect(resultListOpen()).toBe(false);
  await pressResultKey("Enter");
  expect(resultListOpen()).toBe(true);
  await pressResultKey("Escape");
  await pressResultKey("Space");
  expect(resultListOpen()).toBe(true);
});
