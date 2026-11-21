import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MantineProvider } from "@mantine/core";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { HotkeyItem } from "@mantine/hooks";
import type { Tab } from "@/state/workspaceTypes";
import type { SuccessDatabaseInfo } from "@/utils/db";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { activeDatabaseViewStore } from "@/state/store/database";
import { boardTabPanelId } from "./boardTabDom";
import classes from "./NavigationRow.module.css";
import type { MenuAction } from "@/routes/-appMenu";
import { TabCommandsProvider, useTabCommands } from "./TabCommands";
import NavigationRow from "./NavigationRow";

const fixtures = vi.hoisted(() => ({
  abortGame: vi.fn(),
  closeWorkspaceTab: vi.fn(),
  closeTreeStore: vi.fn(),
  createTreeStore: vi.fn(() => ({
    dispose: fixtures.dispose,
    subscribe: fixtures.subscribe,
    getState: () => ({ dirty: false }),
  })),
  createTab: vi.fn(),
  dispose: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
  closeReceipt: true,
  commitReceipt: true,
  hotkeyBindings: null as HotkeyItem[] | null,
  newTabHotkey: null as (() => void) | null,
  platform: vi.fn(() => "linux"),
  killEngines: vi.fn(),
  invalidateReportOwner: vi.fn(),
  restoreReportOwner: vi.fn(),
  notifyUnlessCancelled: vi.fn(),
  compact: false,
  overflowing: false,
  tabs: [
    { value: "current", name: "Current", type: "new", gameOrigin: { kind: "none" } },
    { value: "next", name: "Next", type: "new", gameOrigin: { kind: "none" } },
  ] as TabFixture[],
}));

type TabFixture = {
  gameOrigin: Tab["gameOrigin"];
  name: string;
  type: "new" | "play" | "analysis" | "puzzles";
  value: string;
};

vi.mock("@/state/atoms", async () => {
  const { atom } = await vi.importActual<typeof import("jotai")>("jotai");
  const { atomFamily } = await vi.importActual<typeof import("jotai/utils")>("jotai/utils");
  const activeTabAtom = atom<string | null>("current");
  const tabsStateAtom = atom<TabFixture[]>(fixtures.tabs);
  const tabsAtom = atom(
    (get) => get(tabsStateAtom),
    (get, set, update: TabFixture[] | ((tabs: TabFixture[]) => TabFixture[]), active?: string) => {
      if (!fixtures.commitReceipt) return false;
      const tabs = typeof update === "function" ? update(get(tabsStateAtom)) : update;
      set(tabsStateAtom, tabs);
      if (active !== undefined) set(activeTabAtom, active);
      return true;
    },
  );
  return {
    initializeWorkspace: vi.fn(),
    activeTabAtom,
    closeWorkspaceTabAtom: atom(null, (get, set, tabId: string) => {
      if (!fixtures.closeReceipt) return false;
      const tabs = get(tabsAtom).filter((tab) => tab.value !== tabId);
      set(tabsAtom, tabs);
      if (get(activeTabAtom) === tabId) set(activeTabAtom, tabs[0]?.value ?? null);
      fixtures.closeWorkspaceTab(tabId);
      return true;
    }),
    closingTabsAtom: atom<Set<string>>(new Set<string>()),
    fontSizeAtom: atom(100),
    gameIdFamily: atomFamily(() => atom<string | null>(null)),
    gameSessionFamily: atomFamily(() => atom<bigint | null>(null)),
    gameStateFamily: atomFamily(() => atom<"settingUp" | "playing" | "gameOver">("settingUp")),
    pendingGameStartFamily: atomFamily(() => atom<Promise<void> | null>(null)),
    tabsAtom,
  };
});
vi.mock("@/state/keybinds", async () => {
  const { atom } = await vi.importActual<typeof import("jotai")>("jotai");
  return {
    keyMapAtom: atom({
      NEW_TAB: { keys: "mod+t" },
      CLOSE_TAB: { keys: "mod+w" },
      CYCLE_TABS: { keys: "mod+tab" },
      REVERSE_CYCLE_TABS: { keys: "mod+shift+tab" },
    }),
  };
});
vi.mock("@/platform/native", () => ({
  platform: fixtures.platform,
  warn: vi.fn().mockResolvedValue(undefined),
  getCurrentWebviewWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => undefined,
    minimize: async () => undefined,
    toggleMaximize: async () => undefined,
    close: async () => undefined,
  }),
}));
vi.mock("@/platform/tauri", () => ({
  tauri: { abortGame: fixtures.abortGame, killEngines: fixtures.killEngines },
}));
vi.mock("@/state/store/tree", () => ({
  closeTreeStore: fixtures.closeTreeStore,
  createTreeStore: fixtures.createTreeStore,
  invalidateReportOwner: fixtures.invalidateReportOwner,
  restoreReportOwner: fixtures.restoreReportOwner,
}));
vi.mock("@/state/store/tabStorage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store/tabStorage")>();
  return {
    ...actual,
    tabStorage: {
      storageFor: actual.tabStorage.storageFor.bind(actual.tabStorage),
      getStatus: () => ({ kind: "available" }),
    },
  };
});
vi.mock("@/utils/tabs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/tabs")>()),
  createTab: fixtures.createTab,
}));
vi.mock("../files/notifyError", () => ({ notifyUnlessCancelled: fixtures.notifyUnlessCancelled }));
vi.mock("@/hooks/useScaledMaxWidth", () => ({
  useScaledMaxWidth: () => fixtures.compact,
}));
vi.mock("@mantine/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mantine/hooks")>();
  return {
    ...actual,
    useHotkeys: (bindings: HotkeyItem[]) => {
      fixtures.hotkeyBindings = bindings;
      actual.useHotkeys(bindings);
    },
  };
});
vi.mock("react-hotkeys-hook", () => ({
  useHotkeys: (_keys: string, cb: () => void) => {
    fixtures.newTabHotkey = cb;
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string; defaultValue?: string }) =>
      options?.name ? `${key}:${options.name}` : (options?.defaultValue ?? key),
  }),
}));
vi.mock("@hello-pangea/dnd", () => ({
  DragDropContext: ({ children }: { children: ReactNode }) => children,
  Draggable: ({ children }: { children: (provided: Record<string, unknown>) => ReactNode }) =>
    children({ dragHandleProps: {}, draggableProps: {}, innerRef: vi.fn() }),
  Droppable: ({ children }: { children: (provided: Record<string, unknown>) => ReactNode }) =>
    children({ droppableProps: {}, innerRef: vi.fn(), placeholder: null }),
  useMouseSensor: vi.fn(),
  useTouchSensor: vi.fn(),
}));
vi.mock("../common/AppModal", () => ({
  default: ({ opened, children }: { opened: boolean; children: ReactNode }) =>
    opened ? <div role="dialog">{children}</div> : null,
}));
vi.mock("./ConfirmChangesModal", () => ({ default: () => null }));

import { activeTabAtom, tabsAtom } from "@/state/atoms";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const store = getDefaultStore();

const database: SuccessDatabaseInfo = {
  type: "success",
  file: { id: { id: "database-A" }, kind: "database" },
  filename: "database-A.db3",
  title: "Database A",
  description: "",
  player_count: 0,
  event_count: 0,
  game_count: 0,
  storage_size: "0",
  indexed: false,
};

function following(a: Element, b: Element) {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

async function renderRow({
  path = "/",
  showWindowControls = true,
  menuActions,
  onSendFeedback = () => undefined,
}: {
  path?: string;
  showWindowControls?: boolean;
  menuActions?: MenuAction[];
  onSendFeedback?: () => void;
} = {}) {
  function Shell() {
    const { newTab } = useTabCommands();
    const actions =
      menuActions ??
      ([
        { id: "new_tab", label: "Menu.File.NewTab", action: newTab, shortcut: "mod+t" },
        {
          id: "open_file",
          label: "Menu.File.OpenFile",
          action: () => undefined,
          shortcut: "mod+o",
        },
        { kind: "separator" },
        { id: "save", label: "Common.Save", action: () => undefined, shortcut: "mod+s" },
        { id: "save_to", label: "Board.Database.Save", action: () => undefined },
        { kind: "separator" },
        { id: "accounts", label: "SideBar.Accounts", action: () => undefined },
        { id: "engines", label: "SideBar.Engines", action: () => undefined },
        { id: "settings", label: "SideBar.Settings", action: () => undefined },
        { kind: "separator" },
        {
          id: "toggle_fullscreen",
          label: "Menu.View.Fullscreen",
          action: () => undefined,
          shortcut: "F11",
        },
        { kind: "separator" },
        { id: "send_feedback", label: "Menu.Help.SendFeedback", action: () => undefined },
        { id: "about", label: "Menu.Help.About", action: () => undefined },
        { kind: "separator" },
        { id: "exit", label: "Menu.File.Exit", action: () => undefined },
      ] satisfies MenuAction[]);
    return (
      <NavigationRow
        menuActions={actions}
        showWindowControls={showWindowControls}
        onSendFeedback={onSendFeedback}
      />
    );
  }
  const rootRoute = createRootRoute({
    component: () => (
      <TabCommandsProvider>
        <Shell />
        <Outlet />
      </TabCommandsProvider>
    ),
  });
  const routePaths = [
    "/",
    "/accounts",
    "/library",
    "/databases",
    "/databases/$databaseId",
    "/databasesX",
    "/engines",
    "/settings",
  ];
  const routes = routePaths.map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    await router.load();
  });
  await act(async () =>
    root!.render(
      <MantineProvider>
        <RouterProvider router={router} />
      </MantineProvider>,
    ),
  );
  return router;
}

function libraryLink() {
  return host!.querySelector<HTMLAnchorElement>('a[aria-label="SideBar.Library"]')!;
}

function tabs() {
  return [...host!.querySelectorAll<HTMLButtonElement>('[role="tablist"] [role="tab"]')];
}

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.platform.mockReturnValue("linux");
  fixtures.compact = false;
  fixtures.overflowing = false;
  fixtures.commitReceipt = true;
  fixtures.closeReceipt = true;
  fixtures.hotkeyBindings = null;
  fixtures.newTabHotkey = null;
  fixtures.createTab.mockResolvedValue("created");
  fixtures.killEngines.mockResolvedValue(undefined);
  fixtures.invalidateReportOwner.mockReturnValue({ previous: {}, invalidated: {} });
  fixtures.tabs = [
    { value: "current", name: "Current", type: "new", gameOrigin: { kind: "none" } },
    { value: "next", name: "Next", type: "new", gameOrigin: { kind: "none" } },
  ];
  store.set(tabsAtom, fixtures.tabs);
  store.set(activeTabAtom, "current");
  installMatchMediaStub();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(target: Element) {
        Object.defineProperty(target, "scrollWidth", {
          configurable: true,
          get: () => (fixtures.overflowing ? 400 : 100),
        });
        Object.defineProperty(target, "clientWidth", {
          configurable: true,
          get: () => 100,
        });
        this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  activeDatabaseViewStore.getState().clearDatabase();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

test("the row keeps menu, Library, tabs, New tab, Feedback and window buttons in order", async () => {
  await renderRow();
  const menu = host!.querySelector('[aria-label="Menu.Application.Menu"]')!;
  const library = libraryLink();
  const tablist = host!.querySelector('[role="tablist"]')!;
  const newTab = host!.querySelector('[aria-label="Tab.NewTab"]')!;
  const gap = host!.querySelector("[data-tauri-drag-region]:not(nav)")!;
  const feedback = host!.querySelector('[aria-label="Navigation.Feedback"]')!;
  const minimize = host!.querySelector('[aria-label="Window.Minimize"]')!;
  expect(host!.querySelector("nav")?.hasAttribute("data-tauri-drag-region")).toBe(true);
  expect(tablist.hasAttribute("data-tauri-drag-region")).toBe(false);
  expect(following(menu, library)).toBe(true);
  expect(following(library, tablist)).toBe(true);
  expect(following(tablist, newTab)).toBe(true);
  expect(following(newTab, gap)).toBe(true);
  expect(following(gap, feedback)).toBe(true);
  expect(following(feedback, minimize)).toBe(true);
  expect(host!.querySelector('[aria-label="Tab.AllTabs"]')).toBeNull();
  expect(host!.querySelector("[aria-current='page'][class*='temporary']")).toBeNull();
});

test("window buttons are omitted when the app does not draw them", async () => {
  await renderRow({ showWindowControls: false });
  expect(host!.querySelector('[aria-label="Window.Minimize"]')).toBeNull();
  expect(host!.querySelector('[aria-label="Window.Close"]')).toBeNull();
  expect(host!.querySelector('[aria-label="Menu.Application.Menu"]')).not.toBeNull();
});

test("New tab navigates to `/` when triggered away from `/` by the row button, the menu entry and the NEW_TAB hotkey", async () => {
  const router = await renderRow({ path: "/library" });
  expect(router.state.location.pathname).toBe("/library");

  await act(async () => {
    host!.querySelector<HTMLButtonElement>('[aria-label="Tab.NewTab"]')!.click();
  });
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
  expect(fixtures.createTab).toHaveBeenCalledOnce();

  await act(async () => {
    await router.navigate({ to: "/library" });
  });
  fixtures.createTab.mockClear();
  await act(async () => {
    host!.querySelector<HTMLButtonElement>('[aria-label="Menu.Application.Menu"]')!.click();
  });
  const newTabItem = [...document.querySelectorAll('[role="menuitem"]')].find((node) =>
    node.textContent?.includes("Menu.File.NewTab"),
  );
  expect(newTabItem).toBeDefined();
  await act(async () => {
    (newTabItem as HTMLElement).click();
  });
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
  expect(fixtures.createTab).toHaveBeenCalledOnce();

  await act(async () => {
    await router.navigate({ to: "/library" });
  });
  fixtures.createTab.mockClear();
  expect(fixtures.newTabHotkey).toEqual(expect.any(Function));
  await act(async () => {
    fixtures.newTabHotkey!();
  });
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
  expect(fixtures.createTab).toHaveBeenCalledOnce();
});

test("a tab carries no aria-controls while its panel is not mounted: unselected tabs on `/` and every tab away from `/`", async () => {
  const router = await renderRow({ path: "/" });
  const onBoards = tabs();
  expect(onBoards).toHaveLength(2);
  const selected = onBoards.find((tab) => tab.getAttribute("aria-selected") === "true")!;
  const unselected = onBoards.filter((tab) => tab.getAttribute("aria-selected") === "false");
  expect(selected.getAttribute("aria-controls")).toBe(boardTabPanelId("current"));
  expect(unselected).toHaveLength(1);
  for (const tab of unselected) expect(tab.hasAttribute("aria-controls")).toBe(false);
  expect(onBoards.filter((tab) => tab.tabIndex === 0)).toHaveLength(1);

  await act(async () => {
    await router.navigate({ to: "/library" });
  });
  const away = tabs();
  expect(away).toHaveLength(2);
  for (const tab of away) {
    expect(tab.getAttribute("aria-selected")).toBe("false");
    expect(tab.hasAttribute("aria-controls")).toBe(false);
  }
  expect(away.filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
});

test("clicking a tab away from `/` selects it and navigates home", async () => {
  const router = await renderRow({ path: "/library" });
  await act(async () => {
    tabs()[1]!.click();
  });
  expect(store.get(activeTabAtom)).toBe("next");
  expect(router.state.location.pathname).toBe("/");
});

test("each tab has its own close control that closes that tab", async () => {
  await renderRow();
  const closeNext = host!.querySelector<HTMLButtonElement>('[aria-label="Tab.CloseNamed:Next"]')!;
  expect(closeNext.tabIndex).toBe(-1);
  await act(async () => {
    closeNext.click();
  });
  await vi.waitFor(() => expect(fixtures.closeWorkspaceTab).toHaveBeenCalledWith("next"));
});

test("the flat menu lists the in-app entries in order with shortcuts", async () => {
  await renderRow();
  await act(async () => {
    host!.querySelector<HTMLButtonElement>('[aria-label="Menu.Application.Menu"]')!.click();
  });
  const items = [...document.querySelectorAll('[role="menuitem"]')].map((node) =>
    (node.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
  expect(items).toEqual([
    "Menu.File.NewTabmod+t",
    "Menu.File.OpenFilemod+o",
    "Common.Savemod+s",
    "Board.Database.Save",
    "SideBar.Accounts",
    "SideBar.Engines",
    "SideBar.Settings",
    "Menu.View.FullscreenF11",
    "Menu.Help.SendFeedback",
    "Menu.Help.About",
    "Menu.File.Exit",
  ]);
});

test("arrow keys activate tabs on `/` and only move focus away from `/`", async () => {
  const router = await renderRow({ path: "/" });
  const first = tabs()[0]!;
  first.focus();
  await act(async () => {
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  expect(store.get(activeTabAtom)).toBe("next");
  expect(tabs()[1]!.getAttribute("aria-selected")).toBe("true");

  await act(async () => {
    await router.navigate({ to: "/library" });
  });
  store.set(activeTabAtom, "current");
  await act(async () => {
    await router.navigate({ to: "/library" });
  });
  const awayFirst = tabs()[0]!;
  awayFirst.focus();
  await act(async () => {
    awayFirst.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  expect(store.get(activeTabAtom)).toBe("current");
  expect(document.activeElement).toBe(tabs()[1]);
  await act(async () => {
    tabs()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(store.get(activeTabAtom)).toBe("next");
  expect(router.state.location.pathname).toBe("/");
});

test("F2 opens rename and Shift+F10 opens the tab menu under the tab", async () => {
  await renderRow();
  const first = tabs()[0]!;
  first.focus();
  await act(async () => {
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
  });
  expect(host!.querySelector('[role="dialog"]')).not.toBeNull();

  await act(async () => {
    first.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }),
    );
  });
  expect(
    [...document.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent),
  ).toEqual(expect.arrayContaining(["Duplicate tab", "Rename tab", "Close tab"]));
});

test("the temporary page item appears on settings and its X returns to `/`", async () => {
  const router = await renderRow({ path: "/settings" });
  const item = [...host!.querySelectorAll("[aria-current='page']")].find((node) =>
    node.textContent?.includes("SideBar.Settings"),
  );
  expect(item).toBeDefined();
  const close = host!.querySelector<HTMLButtonElement>(
    '[aria-label="Tab.CloseNamed:SideBar.Settings"]',
  )!;
  await act(async () => {
    close.click();
  });
  expect(router.state.location.pathname).toBe("/");
});

test("CLOSE_TAB on a temporary page returns home and does nothing on Library", async () => {
  const router = await renderRow({ path: "/settings" });
  const binding = fixtures.hotkeyBindings?.find(([keys]) => keys === "mod+w");
  expect(binding).toBeDefined();
  await act(async () => {
    binding![1](new KeyboardEvent("keydown"));
  });
  expect(router.state.location.pathname).toBe("/");
  expect(fixtures.closeWorkspaceTab).not.toHaveBeenCalled();

  await act(async () => {
    await router.navigate({ to: "/library" });
  });
  const libraryBinding = fixtures.hotkeyBindings?.find(([keys]) => keys === "mod+w");
  await act(async () => {
    libraryBinding![1](new KeyboardEvent("keydown"));
  });
  expect(fixtures.closeWorkspaceTab).not.toHaveBeenCalled();
  expect(router.state.location.pathname).toBe("/library");
});

test("overflowing tabs reveal the all-tabs button", async () => {
  fixtures.overflowing = true;
  await renderRow();
  const allTabs = host!.querySelector<HTMLButtonElement>('[aria-label="Tab.AllTabs"]')!;
  expect(allTabs).not.toBeNull();
  await act(async () => {
    allTabs.click();
  });
  await vi.waitFor(() => {
    const names = [...document.querySelectorAll('[role="menuitem"]')].map((node) =>
      (node.textContent ?? "").trim(),
    );
    expect(names).toEqual(expect.arrayContaining(["Current", "Next"]));
  });
});

test("compact mode keeps Library and Feedback names for assistive tech", async () => {
  fixtures.compact = true;
  await renderRow();
  expect(host!.querySelector("nav")!.classList.contains(classes.compact)).toBe(true);
  expect(libraryLink().getAttribute("aria-label")).toBe("SideBar.Library");
  expect(host!.querySelector('[aria-label="Navigation.Feedback"]')).not.toBeNull();
});

test("opens feedback without navigating", async () => {
  const onSendFeedback = vi.fn();
  const router = await renderRow({ path: "/library", onSendFeedback });
  await act(async () => {
    host!.querySelector<HTMLButtonElement>('[aria-label="Navigation.Feedback"]')!.click();
  });
  expect(onSendFeedback).toHaveBeenCalledTimes(1);
  expect(router.state.location.pathname).toBe("/library");
});

test("reactively resumes the active database in the Library link", async () => {
  await renderRow({ path: "/library" });
  expect(libraryLink().getAttribute("href")).toBe("/library");
  await act(async () => activeDatabaseViewStore.getState().setDatabase(database));
  expect(libraryLink().getAttribute("href")).toBe("/databases/database-A");
});

test.each([undefined, null, {}, { file: {} }, { file: { id: { id: "" }, kind: "database" } }])(
  "renders safely and targets the overview with stored value %j",
  async (value) => {
    activeDatabaseViewStore.setState({ database: value as never });
    await expect(renderRow()).resolves.toBeDefined();
    expect(libraryLink().getAttribute("href")).toBe("/library");
  },
);

test("marks all database routes current independently of the resume target", async () => {
  activeDatabaseViewStore.getState().setDatabase(database);
  const router = await renderRow();
  for (const [to, current] of [
    ["/databases", true],
    ["/databases/", true],
    ["/databases/database-A", true],
    ["/databases/database-B", true],
    ["/settings", false],
    ["/databasesX", false],
  ] as const) {
    await act(async () => {
      await router.navigate({ to: to as string });
    });
    expect(libraryLink().getAttribute("href")).toBe("/databases/database-A");
    expect(libraryLink().getAttribute("aria-current")).toBe(current ? "page" : null);
    expect(libraryLink().classList.contains(classes.current)).toBe(current);
  }
});
