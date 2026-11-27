import { MantineProvider } from "@mantine/core";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useStore } from "zustand";
import { supportedLocales } from "@/i18n";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { catalogueI18n } from "@/tests/catalogues";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { fixtureNode } from "@/tests/treeFixtures";
import { defaultTree, getEffectiveTermination } from "@/utils/treeReducer";
import GameInfo from "./GameInfo";
import { TreeStateContext } from "./TreeStateContext";

dayjs.extend(customParseFormat);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts
        ? `${key}(${Object.entries(opts)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join(",")})`
        : key,
  }),
}));
const fideInfo = vi.hoisted(() =>
  vi.fn((_props: { opened: boolean; setOpened: (opened: boolean) => void; name: string }) => null),
);
vi.mock("./FideInfo", () => ({ default: fideInfo }));

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

test("draft editing mode renders a Lichess site as an input and calls onHeadersChange without tree context", async () => {
  const onHeadersChange = vi.fn();
  const headers = {
    ...defaultTree().headers,
    site: "https://lichess.org/Abcd1234",
    event: "Open",
  };
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <GameInfo headers={headers} onHeadersChange={onHeadersChange} documentId="db:42" />
      </MantineProvider>,
    ),
  );

  expect(host.querySelector("a")).toBeNull();
  const siteField = host.querySelector<HTMLInputElement>(
    'input[aria-label="Databases.Game.Site"]',
  )!;
  expect(siteField).not.toBeNull();
  expect(siteField.disabled).toBe(false);
  expect(siteField.value).toBe("https://lichess.org/Abcd1234");
  expect(host.querySelector('[aria-label="GameInfo.Termination"]')).toBeNull();

  await act(async () => setNativeInputValue(siteField, "Berlin"));
  expect(onHeadersChange).toHaveBeenCalledWith(expect.objectContaining({ site: "Berlin" }));
});

test("two mounted GameInfo instances have distinct Result ids", async () => {
  const headers = defaultTree().headers;
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <GameInfo headers={headers} />
        <GameInfo headers={headers} onHeadersChange={vi.fn()} documentId="db:1" />
      </MantineProvider>,
    ),
  );

  const labels = [...host.querySelectorAll("label")].filter(
    (label) => label.textContent === "GameInfo.Result",
  );
  expect(labels).toHaveLength(2);
  const ids = labels.map((label) => label.getAttribute("for"));
  expect(ids[0]).toBeTruthy();
  expect(ids[1]).toBeTruthy();
  expect(ids[0]).not.toBe(ids[1]);
  for (const id of ids) {
    expect([...host.querySelectorAll("[id]")].filter((el) => el.id === id)).toHaveLength(1);
  }
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
  // The field sits in the result cell, under the result picker.
  const resultLabel = [...host.querySelectorAll("label")].find(
    (label) => label.textContent === "GameInfo.Result",
  )!;
  const resultId = resultLabel.getAttribute("for")!;
  const resultCell = resultLabel.parentElement!;
  expect(document.getElementById(resultId)).not.toBeNull();
  expect(resultCell.contains(document.getElementById(resultId))).toBe(true);
  expect(resultCell.contains(field)).toBe(true);
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

const TERMINATION_SUGGESTIONS = [
  ["Normal", "GameInfo.TerminationHint.Normal"],
  ["Time forfeit", "GameInfo.TerminationHint.TimeForfeit"],
  ["Abandoned", "GameInfo.TerminationHint.Abandoned"],
  ["Adjudication", "GameInfo.TerminationHint.Adjudication"],
  ["Rules infraction", "GameInfo.TerminationHint.RulesInfraction"],
  ["Unterminated", "GameInfo.TerminationHint.Unterminated"],
] as const;

async function renderAndFocusTermination(termination?: string) {
  const state = defaultTree();
  state.root.children = [
    { ...fixtureNode("e4"), gameEnd: termination === undefined ? {} : { termination } },
  ];
  store.getState().setState(state);
  await act(async () => root.render(<Editor />));
  const field = host.querySelector<HTMLInputElement>('input[aria-label="GameInfo.Termination"]')!;
  await act(async () => field.focus());
  return field;
}

/** The Termination field's own listed options; the result picker keeps its own list mounted. */
function terminationOptionElements() {
  const field = host.querySelector<HTMLInputElement>('input[aria-label="GameInfo.Termination"]')!;
  const listbox = document.getElementById(field.getAttribute("aria-controls") ?? "");
  return [...(listbox?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
}

/** Each listed suggestion as [value, hint], read from the open dropdown. */
function terminationOptions() {
  return terminationOptionElements().map((option) => {
    const [value, hint] = [...option.querySelectorAll("p")].map((line) => line.textContent);
    return [value, hint];
  });
}

test("focusing an empty Termination lists every PGN-standard suggestion with its hint", async () => {
  await renderAndFocusTermination();
  expect(terminationOptions()).toEqual(TERMINATION_SUGGESTIONS.map((entry) => [...entry]));
});

test("picking a suggestion stores its exact English value", async () => {
  const setTermination = vi.spyOn(store.getState(), "setTermination");
  const field = await renderAndFocusTermination();
  const option = terminationOptionElements().find(
    (candidate) => candidate.getAttribute("value") === "Time forfeit",
  )!;
  await act(async () => option.click());
  expect(setTermination).toHaveBeenLastCalledWith("Time forfeit");
  expect(getEffectiveTermination(store.getState())).toBe("Time forfeit");
  expect(field.value).toBe("Time forfeit");
});

test("free text outside the suggestions is accepted and stored", async () => {
  const field = await renderAndFocusTermination();
  await act(async () => setNativeInputValue(field, "Black won by resignation"));
  expect(getEffectiveTermination(store.getState())).toBe("Black won by resignation");
  expect(field.value).toBe("Black won by resignation");
  expect(terminationOptions()).toEqual([]);
});

test.each([
  ["a stored suggestion", "Normal", TERMINATION_SUGGESTIONS.map(([value]) => value)],
  ["a partial value, case-insensitively", "time", ["Time forfeit"]],
  ["unrelated free text", "White won on time", []],
])("Termination suggestions for %s", async (_case, termination, expected) => {
  await renderAndFocusTermination(termination);
  expect(terminationOptions().map(([value]) => value)).toEqual(expected);
});

test.each(supportedLocales)(
  "ships every Termination hint in %s with fallback disabled",
  async (locale) => {
    const i18n = await catalogueI18n(locale);
    for (const [, key] of TERMINATION_SUGGESTIONS) {
      expect(i18n.t(key).trim()).toBeTruthy();
      expect(i18n.t(key)).not.toBe(key);
    }
  },
);

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

test.each([
  ["GameInfo.WhiteElo", "white_elo"],
  ["GameInfo.BlackElo", "black_elo"],
] as const)("%s parses Unrated, dash, blank and numbers into %s", async (label, field) => {
  await act(async () => root.render(<Editor />));
  const input = () => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  for (const [typed, stored, shown] of [
    ["2400", 2400, "2400"],
    ["", undefined, ""],
    ["gameinfo.unrated", 0, "GameInfo.Unrated"],
    ["-", 0, "GameInfo.Unrated"],
    ["abc", undefined, ""],
  ] as const) {
    await act(async () => setNativeInputValue(input(), typed));
    expect(store.getState().headers[field]).toBe(stored);
    expect(input().value).toBe(shown);
  }
});

test("each colour button opens only that player's FIDE card and closing clears it", async () => {
  await act(async () =>
    store.getState().setHeaders({ ...store.getState().headers, white: "W", black: "B" }),
  );
  await act(async () => root.render(<Editor />));
  const dialogs = () =>
    fideInfo.mock.calls.slice(-2).map(([props]) => ({ name: props.name, opened: props.opened }));
  const button = (label: string) =>
    Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label)!;
  for (const [label, opened] of [
    ["Fen.White", [true, false]],
    ["Fen.Black", [false, true]],
  ] as const) {
    await act(async () => button(label).click());
    expect(dialogs()).toEqual([
      { name: "W", opened: opened[0] },
      { name: "B", opened: opened[1] },
    ]);
  }
  await act(async () => fideInfo.mock.calls.at(-1)?.[0].setOpened(false));
  expect(dialogs().map((d) => d.opened)).toEqual([false, false]);
});

function resultField() {
  const label = [...host.querySelectorAll("label")].find(
    (item) => item.textContent === "GameInfo.Result",
  )!;
  const id = label.getAttribute("for")!;
  return document.getElementById(id) as HTMLInputElement;
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
  // Separate steps, as in a browser: the click must see the state the focus left behind.
  await act(async () => {
    resultField().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  await act(async () => resultField().focus());
  await act(async () => resultField().click());
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

function timeControlSelect() {
  const label = [...host.querySelectorAll<HTMLLabelElement>("label")].find(
    (el) => el.textContent === "GameInfo.TimeControl",
  );
  return (label?.control as HTMLInputElement | null) ?? null;
}

async function pickTimeControlOption(value: string) {
  const restore = stubScrollIntoView();
  try {
    await act(async () => timeControlSelect()!.click());
    const listbox = document.getElementById(
      timeControlSelect()!.getAttribute("aria-controls") ?? "",
    )!;
    const option = listbox.querySelector<HTMLElement>(`[role="option"][value="${value}"]`)!;
    expect(option).not.toBeNull();
    await act(async () => option.click());
  } finally {
    restore();
  }
}

function customField(labelKey: string) {
  const label = [...host.querySelectorAll<HTMLLabelElement>("label")].find(
    (el) => el.textContent === labelKey,
  );
  return (label?.control as HTMLInputElement | null) ?? null;
}

test.each([
  ["5400+30", "TimeControl.MinutesShort(minutes=90)", "TimeControl.WithIncrement"],
  [
    "40/5400+30:1800+30",
    "TimeControl.MovesInTime(count=40,time=TimeControl.MinutesShort(minutes=90))",
    "TimeControl.ThenTime(time=TimeControl.MinutesShort(minutes=30))",
  ],
  [
    "40/5400+30:900+30",
    "TimeControl.MovesInTime(count=40,time=TimeControl.MinutesShort(minutes=90))",
    "TimeControl.ThenTime(time=TimeControl.MinutesShort(minutes=15))",
  ],
  ["3600+30", "TimeControl.MinutesShort(minutes=60)", "TimeControl.WithIncrement"],
] as const)(
  "Time control preset %s writes its exact PGN string and displays plain words",
  async (pgn, expectedPart1, expectedPart2) => {
    await act(async () => root.render(<Editor />));
    expect(timeControlSelect()!.value).toBe("GameInfo.TimeControlNone");

    await pickTimeControlOption(pgn);
    expect(store.getState().headers.time_control).toBe(pgn);
    expect(timeControlSelect()!.value).toContain(expectedPart1);
    expect(timeControlSelect()!.value).toContain(expectedPart2);
  },
);

test("picking None removes time_control", async () => {
  store.getState().setHeaders({ ...defaultTree().headers, time_control: "5400+30" });
  await act(async () => root.render(<Editor />));
  await pickTimeControlOption("none");
  expect(store.getState().headers.time_control).toBeUndefined();
});

test("Custom fields produce 40/5400+30:1800+30 and stay mounted across intermediate preset values", async () => {
  await act(async () => root.render(<Editor />));
  await pickTimeControlOption("custom");

  await act(async () => setNativeInputValue(customField("GameInfo.TimeControlMinutes")!, "90"));
  // Increment is still empty, so nothing is written yet.
  expect(store.getState().headers.time_control).toBeUndefined();

  await act(async () => setNativeInputValue(customField("GameInfo.TimeControlIncrement")!, "30"));
  expect(store.getState().headers.time_control).toBe("5400+30");
  // Custom form remains open while the user continues into the second period.
  expect(customField("GameInfo.TimeControlAfterMove")).not.toBeNull();

  await act(async () => setNativeInputValue(customField("GameInfo.TimeControlAfterMove")!, "40"));
  // Only one half of the optional pair is filled -> invalid, tag stays at 5400+30.
  expect(store.getState().headers.time_control).toBe("5400+30");
  expect(customField("GameInfo.TimeControlAddMinutes")!.getAttribute("aria-invalid")).toBe("true");

  await act(async () => setNativeInputValue(customField("GameInfo.TimeControlAddMinutes")!, "30"));
  expect(store.getState().headers.time_control).toBe("40/5400+30:1800+30");
});

test("invalid custom input shows field errors and writes nothing", async () => {
  store.getState().setHeaders({ ...defaultTree().headers, time_control: "600+5" });
  await act(async () => root.render(<Editor />));

  const minutes = customField("GameInfo.TimeControlMinutes")!;
  const increment = customField("GameInfo.TimeControlIncrement")!;
  const afterMove = customField("GameInfo.TimeControlAfterMove")!;
  const addMinutes = customField("GameInfo.TimeControlAddMinutes")!;
  expect(minutes.value).toBe("10");
  expect(increment.value).toBe("5");

  for (const bad of ["0", "601", "1.5", "abc", ""]) {
    await act(async () => setNativeInputValue(minutes, bad));
    expect(minutes.getAttribute("aria-invalid")).toBe("true");
    expect(store.getState().headers.time_control).toBe("600+5");
  }

  await act(async () => setNativeInputValue(minutes, "10"));
  await act(async () => setNativeInputValue(increment, "601"));
  expect(increment.getAttribute("aria-invalid")).toBe("true");
  expect(store.getState().headers.time_control).toBe("600+5");

  await act(async () => setNativeInputValue(increment, "5"));
  for (const badAfterMove of ["0", "201"]) {
    await act(async () => setNativeInputValue(afterMove, badAfterMove));
    expect(afterMove.getAttribute("aria-invalid")).toBe("true");
    expect(host.textContent).toContain("GameInfo.TimeControlRangeError(max=200,min=1)");
    expect(store.getState().headers.time_control).toBe("600+5");
  }

  await act(async () => setNativeInputValue(afterMove, ""));
  await act(async () => setNativeInputValue(addMinutes, "15"));
  expect(afterMove.getAttribute("aria-invalid")).toBe("true");
  expect(store.getState().headers.time_control).toBe("600+5");
});

test.each([
  ["90+0", "TimeControl.WithIncrement("],
  ["0+1", "TimeControl.WithIncrement("],
  ["5400+30:1800+30", "TimeControl.PeriodsWithIncrement("],
  ["40/5400+30:1800+10", "TimeControl.ThenTime("],
  ["300", "TimeControl.MinutesShort(minutes=5)"],
  ["?", "?"],
])(
  "unrepresentable tag %s shows read-only text without Custom fields and is never silently altered",
  async (rawTag, expectedSummary) => {
    store.getState().setHeaders({ ...defaultTree().headers, time_control: rawTag });
    await act(async () => root.render(<Editor />));

    expect(timeControlSelect()!.value).toBe("");
    expect(timeControlSelect()!.placeholder).toBe("GameInfo.TimeControlUnlisted");
    expect(customField("GameInfo.TimeControlMinutes")).toBeNull();
    expect(store.getState().headers.time_control).toBe(rawTag);
    expect(host.textContent).toContain(expectedSummary);

    // Picking Custom starts empty without altering the stored tag until valid.
    await pickTimeControlOption("custom");
    expect(customField("GameInfo.TimeControlMinutes")!.value).toBe("");
    expect(store.getState().headers.time_control).toBe(rawTag);
  },
);

test("side tags leave select unselected, show per-side summary, and are cleared on None/preset or first valid Custom write", async () => {
  // Differing side tags
  store.getState().setHeaders({
    ...defaultTree().headers,
    time_control: "5400+30",
    white_time_control: "600+5",
    black_time_control: "300+2",
  });
  await act(async () => root.render(<Editor />));

  expect(timeControlSelect()!.value).toBe("");
  expect(timeControlSelect()!.placeholder).toBe("GameInfo.TimeControlPerSide");
  expect(host.textContent).toContain("GameInfo.TimeControlSides(");

  // Picking a preset EQUAL to the shared tag still fires onChange and clears side tags immediately.
  await pickTimeControlOption("5400+30");
  expect(store.getState().headers.time_control).toBe("5400+30");
  expect(store.getState().headers.white_time_control).toBeUndefined();
  expect(store.getState().headers.black_time_control).toBeUndefined();

  // Re-seed side tags and verify None clears them immediately.
  await act(async () =>
    store.getState().setHeaders({
      ...defaultTree().headers,
      time_control: "5400+30",
      white_time_control: "600+5",
      black_time_control: "300+2",
    }),
  );
  await pickTimeControlOption("none");
  expect(store.getState().headers.time_control).toBeUndefined();
  expect(store.getState().headers.white_time_control).toBeUndefined();
  expect(store.getState().headers.black_time_control).toBeUndefined();

  // CR-1: Custom keeps side tags until its first valid write.
  await act(async () =>
    store.getState().setHeaders({
      ...defaultTree().headers,
      white_time_control: "600+5",
      black_time_control: "300+2",
    }),
  );
  await pickTimeControlOption("custom");
  expect(store.getState().headers.white_time_control).toBe("600+5");
  expect(store.getState().headers.black_time_control).toBe("300+2");

  await act(async () => setNativeInputValue(customField("GameInfo.TimeControlMinutes")!, "15"));
  // Invalid/incomplete -> side tags stay untouched.
  expect(store.getState().headers.white_time_control).toBe("600+5");
  expect(store.getState().headers.black_time_control).toBe("300+2");

  await act(async () => setNativeInputValue(customField("GameInfo.TimeControlIncrement")!, "10"));
  // First valid write clears side tags and writes time_control.
  expect(store.getState().headers.time_control).toBe("900+10");
  expect(store.getState().headers.white_time_control).toBeUndefined();
  expect(store.getState().headers.black_time_control).toBeUndefined();
});

test("displays both-sides-unresolved and one-side-unresolved per-side texts", async () => {
  // Both unresolved with distinct raw tags
  store.getState().setHeaders({
    ...defaultTree().headers,
    white_time_control: "garbage",
    black_time_control: "bad",
  });
  await act(async () => root.render(<Editor />));
  expect(host.textContent).toContain("GameInfo.TimeControlSides(black=bad,white=garbage)");

  // Both unresolved, only one side has a tag -> other side is unknown
  await act(async () =>
    store.getState().setHeaders({
      ...defaultTree().headers,
      white_time_control: "garbage",
    }),
  );
  expect(host.textContent).toContain(
    "GameInfo.TimeControlSides(black=GameInfo.TimeControlUnknown,white=garbage)",
  );

  // One side resolved, other side unresolved (no tag)
  await act(async () =>
    store.getState().setHeaders({
      ...defaultTree().headers,
      white_time_control: "600+5",
    }),
  );
  expect(host.textContent).toContain("black=GameInfo.TimeControlUnknown");
  expect(host.textContent).toContain("minutes=10");
});

test("read-only GameInfo (without store and with timeControlReadOnly) hides dropdown and shows only resolved controls", async () => {
  // Without tree store, no tag -> nothing shown
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <GameInfo headers={defaultTree().headers} />
      </MantineProvider>,
    ),
  );
  expect(timeControlSelect()).toBeNull();
  expect(host.textContent).not.toContain("GameInfo.TimeControlSummary");

  // Unparseable tag without store -> nothing shown
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <GameInfo headers={{ ...defaultTree().headers, time_control: "?" }} />
      </MantineProvider>,
    ),
  );
  expect(host.textContent).not.toContain("GameInfo.TimeControlSummary");

  // Differing side tags without store -> White/Black summary shown
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <GameInfo
          headers={{
            ...defaultTree().headers,
            white_time_control: "600+5",
            black_time_control: "300+2",
          }}
        />
      </MantineProvider>,
    ),
  );
  expect(timeControlSelect()).toBeNull();
  expect(host.textContent).toContain("GameInfo.TimeControlSummary(");
  expect(host.textContent).toContain("GameInfo.TimeControlSides(");

  // With tree store + timeControlReadOnly -> no dropdown, resolved plain words shown
  store.getState().setHeaders({ ...defaultTree().headers, time_control: "5400+30" });
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <TreeStateContext.Provider value={store}>
          <GameInfo headers={store.getState().headers} timeControlReadOnly />
        </TreeStateContext.Provider>
      </MantineProvider>,
    ),
  );
  expect(timeControlSelect()).toBeNull();
  expect(host.textContent).toContain("GameInfo.TimeControlSummary(");
  expect(host.textContent).toContain("minutes=90");
});

test("undo and redo of a Custom write reopen Custom with the restored values", async () => {
  await act(async () => root.render(<Editor />));
  await pickTimeControlOption("custom");

  await act(async () => setNativeInputValue(customField("GameInfo.TimeControlMinutes")!, "10"));
  await act(async () => setNativeInputValue(customField("GameInfo.TimeControlIncrement")!, "5"));
  expect(store.getState().headers.time_control).toBe("600+5");

  await act(async () => store.getState().undo());
  expect(store.getState().headers.time_control).toBeUndefined();
  expect(timeControlSelect()!.value).toBe("GameInfo.TimeControlNone");
  expect(customField("GameInfo.TimeControlMinutes")).toBeNull();

  await act(async () => store.getState().redo());
  expect(store.getState().headers.time_control).toBe("600+5");
  expect(timeControlSelect()!.value).toBe("GameInfo.TimeControlCustom");
  expect(customField("GameInfo.TimeControlMinutes")!.value).toBe("10");
  expect(customField("GameInfo.TimeControlIncrement")!.value).toBe("5");
});

test("same-key Custom write clears the echo marker so undo and redo still re-sync Custom", async () => {
  await act(async () =>
    store
      .getState()
      .setHeaders({ ...defaultTree().headers, white: "Alice", time_control: "5400+30" }),
  );
  await act(async () => root.render(<Editor />));

  await pickTimeControlOption("custom");
  await act(async () => setNativeInputValue(customField("GameInfo.TimeControlMinutes")!, "10"));
  await act(async () => setNativeInputValue(customField("GameInfo.TimeControlIncrement")!, "5"));
  expect(store.getState().headers.time_control).toBe("600+5");

  // Type invalid minutes then the original "10" again, writing the already-stored tag key.
  const minutes = customField("GameInfo.TimeControlMinutes")!;
  await act(async () => setNativeInputValue(minutes, "0"));
  expect(minutes.getAttribute("aria-invalid")).toBe("true");
  await act(async () => setNativeInputValue(minutes, "10"));
  expect(minutes.getAttribute("aria-invalid")).not.toBe("true");
  expect(store.getState().headers.time_control).toBe("600+5");

  // Undo back to the preset then redo back to "600+5": Custom must re-open with 10/5.
  await act(async () => store.getState().undo());
  expect(store.getState().headers.time_control).toBe("5400+30");
  expect(customField("GameInfo.TimeControlMinutes")).toBeNull();

  await act(async () => store.getState().redo());
  expect(store.getState().headers.time_control).toBe("600+5");
  expect(timeControlSelect()!.value).toBe("GameInfo.TimeControlCustom");
  expect(customField("GameInfo.TimeControlMinutes")!.value).toBe("10");
  expect(customField("GameInfo.TimeControlIncrement")!.value).toBe("5");
});

test("an external header change resets a stale Custom draft", async () => {
  store.getState().setHeaders({ ...defaultTree().headers, time_control: "600+5" });
  await act(async () => root.render(<Editor />));

  await act(async () => setNativeInputValue(customField("GameInfo.TimeControlMinutes")!, "0"));
  expect(customField("GameInfo.TimeControlMinutes")!.getAttribute("aria-invalid")).toBe("true");
  expect(store.getState().headers.time_control).toBe("600+5");

  await act(async () =>
    store.getState().setHeaders({ ...store.getState().headers, time_control: "900+10" }),
  );
  expect(customField("GameInfo.TimeControlMinutes")!.value).toBe("15");
  expect(customField("GameInfo.TimeControlIncrement")!.value).toBe("10");
  expect(customField("GameInfo.TimeControlMinutes")!.getAttribute("aria-invalid")).not.toBe("true");
});

test("switching to another document with an identical tag resets a stale Custom draft", async () => {
  const storeA = createTreeStore();
  const storeB = createTreeStore();
  storeA.getState().setHeaders({ ...defaultTree().headers, time_control: "600+5" });
  storeB.getState().setHeaders({ ...defaultTree().headers, time_control: "600+5" });

  function SwitchableEditor({ activeStore }: { activeStore: TreeStore }) {
    const headers = useStore(activeStore, (state) => state.headers);
    return (
      <MantineProvider env="test">
        <TreeStateContext.Provider value={activeStore}>
          <GameInfo headers={headers} />
        </TreeStateContext.Provider>
      </MantineProvider>
    );
  }

  await act(async () => root.render(<SwitchableEditor activeStore={storeA} />));
  await act(async () => setNativeInputValue(customField("GameInfo.TimeControlMinutes")!, "0"));
  expect(customField("GameInfo.TimeControlMinutes")!.getAttribute("aria-invalid")).toBe("true");

  await act(async () => root.render(<SwitchableEditor activeStore={storeB} />));
  expect(customField("GameInfo.TimeControlMinutes")!.value).toBe("10");
  expect(customField("GameInfo.TimeControlIncrement")!.value).toBe("5");
  expect(customField("GameInfo.TimeControlMinutes")!.getAttribute("aria-invalid")).not.toBe("true");
});

test("read-only mode with one side resolved and the other invalid shows unknown without leaking raw tag", async () => {
  const headers = {
    ...defaultTree().headers,
    white_time_control: "600+5",
    black_time_control: "garbage",
  };
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <GameInfo headers={headers} />
      </MantineProvider>,
    ),
  );
  expect(timeControlSelect()).toBeNull();
  expect(host.textContent).toContain("GameInfo.TimeControlSummary(");
  expect(host.textContent).toContain("black=GameInfo.TimeControlUnknown");
  expect(host.textContent).toContain("minutes=10");
  expect(host.textContent).not.toContain("garbage");
});

test("Custom validation reports cleared Increment, blurred empty required fields, and out-of-range Add (min)", async () => {
  store.getState().setHeaders({ ...defaultTree().headers, time_control: "600+5" });
  await act(async () => root.render(<Editor />));

  // Clearing Increment shows its error and preserves the stored tag.
  await act(async () => setNativeInputValue(customField("GameInfo.TimeControlIncrement")!, ""));
  expect(customField("GameInfo.TimeControlIncrement")!.getAttribute("aria-invalid")).toBe("true");
  expect(host.textContent).toContain("GameInfo.TimeControlRangeError(max=600,min=0)");
  expect(store.getState().headers.time_control).toBe("600+5");

  // Switching to Custom on a fresh game and blurring untouched empty Minutes/Increment marks them touched.
  await act(async () =>
    store.getState().setHeaders({ ...defaultTree().headers, time_control: undefined }),
  );
  await pickTimeControlOption("custom");
  const minutes = customField("GameInfo.TimeControlMinutes")!;
  const increment = customField("GameInfo.TimeControlIncrement")!;
  expect(minutes.getAttribute("aria-invalid")).not.toBe("true");
  expect(increment.getAttribute("aria-invalid")).not.toBe("true");

  await act(async () => {
    minutes.focus();
    minutes.blur();
    increment.focus();
    increment.blur();
  });
  expect(minutes.getAttribute("aria-invalid")).toBe("true");
  expect(increment.getAttribute("aria-invalid")).toBe("true");

  // Valid base control + After move, then out-of-range Add (min) "0" and "601" write nothing.
  await act(async () => setNativeInputValue(minutes, "90"));
  await act(async () => setNativeInputValue(increment, "30"));
  expect(store.getState().headers.time_control).toBe("5400+30");

  await act(async () => setNativeInputValue(customField("GameInfo.TimeControlAfterMove")!, "40"));
  for (const invalidAdd of ["0", "601"]) {
    await act(async () =>
      setNativeInputValue(customField("GameInfo.TimeControlAddMinutes")!, invalidAdd),
    );
    expect(customField("GameInfo.TimeControlAddMinutes")!.getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(host.textContent).toContain("GameInfo.TimeControlRangeError(max=600,min=1)");
    expect(store.getState().headers.time_control).toBe("5400+30");
  }
});

test.each([
  ["40/5400+30", "TimeControl.MovesInTime(count=40"],
  ["40/5400+30:20/1800+30:900+30", "TimeControl.ThenMovesInTime(count=20"],
  ["40/5400+30:20/1800+30", "TimeControl.ThenMovesInTime(count=20"],
  ["201/5400+30:1800+30", "TimeControl.MovesInTime(count=201"],
  ["05400+30", "TimeControl.MinutesShort(minutes=90)"],
])(
  "non-Custom-representable tag %s renders as read-only text rather than a Custom form",
  async (rawTag, expectedSummaryPart) => {
    store.getState().setHeaders({ ...defaultTree().headers, time_control: rawTag });
    await act(async () => root.render(<Editor />));

    expect(timeControlSelect()!.value).toBe("");
    expect(timeControlSelect()!.placeholder).toBe("GameInfo.TimeControlUnlisted");
    expect(customField("GameInfo.TimeControlMinutes")).toBeNull();
    expect(host.textContent).toContain(expectedSummaryPart);
  },
);

const TIME_CONTROL_KEYS = [
  "GameInfo.TimeControl",
  "GameInfo.TimeControlNone",
  "GameInfo.TimeControlCustom",
  "GameInfo.TimeControlPerSide",
  "GameInfo.TimeControlUnlisted",
  "GameInfo.TimeControlMinutes",
  "GameInfo.TimeControlIncrement",
  "GameInfo.TimeControlAfterMove",
  "GameInfo.TimeControlAddMinutes",
  "GameInfo.TimeControlUnknown",
] as const;

test.each(supportedLocales)(
  "ships every TimeControl key in %s with fallback disabled",
  async (locale) => {
    const i18n = await catalogueI18n(locale);
    for (const key of TIME_CONTROL_KEYS) {
      expect(i18n.t(key).trim()).toBeTruthy();
      expect(i18n.t(key)).not.toBe(key);
    }
    const sides = i18n.t("GameInfo.TimeControlSides", { white: "A", black: "B" });
    expect(sides).toContain("A");
    expect(sides).toContain("B");
    expect(sides).not.toMatch(/\{\{|\}\}/);

    const summary = i18n.t("GameInfo.TimeControlSummary", { value: "90 min" });
    expect(summary).toContain("90 min");
    expect(summary).not.toMatch(/\{\{|\}\}/);

    const rangeErr = i18n.t("GameInfo.TimeControlRangeError", { min: 1, max: 600 });
    expect(rangeErr).toContain("1");
    expect(rangeErr).toContain("600");
    expect(rangeErr).not.toMatch(/\{\{|\}\}/);
  },
);
