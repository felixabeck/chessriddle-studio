import { act, useLayoutEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { TabTreeStorageStatus } from "@/state/store/tabStorage";
import type { Tab } from "@/state/workspaceTypes";
import type { HotkeyItem } from "@mantine/hooks";
import { TabCommandsProvider, useTabCommands, type TabCommands } from "./TabCommands";

const fixtures = vi.hoisted(() => ({
  abortGame: vi.fn(),
  closeWorkspaceTab: vi.fn(),
  replaceWorkspaceTab: vi.fn(),
  copyTabEngineSettings: vi.fn(),
  replaceReceipt: true,
  modalProps: null as null | {
    pendingClose: { tabId: string; intent: string } | null;
    onDiscard: () => void;
    onSaved: () => void;
    onCancel: () => void;
  },
  closeTreeStore: vi.fn(),
  createTreeStore: vi.fn<(...args: any[]) => any>(() => ({
    subscribe: fixtures.subscribe,
    getState: () => ({ dirty: fixtures.dirty }),
  })),
  createTab: vi.fn(),
  cloneDurable: vi.fn(),
  readForClone: vi.fn(),
  seed: vi.fn(),
  getStatus: vi.fn((key: string) => fixtures.treeStatuses.get(key) ?? fixtures.treeStatus),
  treeStatus: { kind: "available" } as TabTreeStorageStatus,
  treeStatuses: new Map<string, TabTreeStorageStatus>(),
  subscribe: vi.fn(() => vi.fn()),
  dirty: false,
  closeReceipt: true,
  commitReceipt: true,
  hotkeyBindings: null as HotkeyItem[] | null,
  platform: vi.fn(() => "linux"),
  killEngines: vi.fn(),
  invalidateReportOwner: vi.fn(),
  restoreReportOwner: vi.fn(),
  notifyUnlessCancelled: vi.fn(),
  navigate: vi.fn(),
  pathname: "/",
  href: null as string | null,
  reactiveRouter: false,
  routeListeners: new Set<() => void>(),
  navigateImpl: (options: { to?: string; href?: string; replace?: boolean }) => {
    const result = fixtures.navigate(options);
    if (fixtures.reactiveRouter && typeof options?.to === "string") {
      fixtures.pathname = options.to;
      fixtures.href = options.to;
      for (const listener of fixtures.routeListeners) listener();
    }
    return result instanceof Promise ? result : Promise.resolve();
  },
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
  treeKey?: string;
  explorer?: Tab["explorer"];
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
    replaceWorkspaceTabAtom: atom(
      null,
      (get, set, tabId: string, successor: TabFixture, onCommitted?: () => void) => {
        if (!fixtures.replaceReceipt) return false;
        set(
          tabsAtom,
          get(tabsAtom).map((tab) => (tab.value === tabId ? successor : tab)),
        );
        if (get(activeTabAtom) === tabId) set(activeTabAtom, successor.value);
        fixtures.replaceWorkspaceTab(tabId, successor);
        onCommitted?.();
        return true;
      },
    ),
    copyTabEngineSettingsAtom: atom(null, (_get, _set, pair: { from: string; to: string }) =>
      fixtures.copyTabEngineSettings(pair),
    ),
    closingTabsAtom: atom<Set<string>>(new Set<string>()),
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
    firedByNativeMenu: () => false,
    keyMapAtom: atom({
      NEW_TAB: { keys: "mod+t" },
      NEW_ANALYSIS: { keys: "mod+n" },
      CLOSE_TAB: { keys: "mod+w" },
      CYCLE_TABS: { keys: "mod+tab" },
      REVERSE_CYCLE_TABS: { keys: "mod+shift+tab" },
    }),
  };
});
vi.mock("@/platform/native", () => ({
  platform: fixtures.platform,
  warn: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/platform/tauri", () => ({
  tauri: { abortGame: fixtures.abortGame, killEngines: fixtures.killEngines },
}));
vi.mock("@/state/store/tree", () => ({
  closeTreeStore: fixtures.closeTreeStore,
  createTreeStore: fixtures.createTreeStore,
  getOrCreateTreeStore: fixtures.createTreeStore,
  invalidateReportOwner: fixtures.invalidateReportOwner,
  restoreReportOwner: fixtures.restoreReportOwner,
}));
vi.mock("@/state/store/tabStorage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store/tabStorage")>();
  return {
    ...actual,
    tabStorage: {
      storageFor: actual.tabStorage.storageFor.bind(actual.tabStorage),
      cloneDurable: fixtures.cloneDurable,
      readForClone: fixtures.readForClone,
      seed: fixtures.seed,
      getStatus: fixtures.getStatus,
    },
  };
});
vi.mock("@/utils/tabs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/tabs")>()),
  createTab: fixtures.createTab,
}));
vi.mock("../files/notifyError", () => ({ notifyUnlessCancelled: fixtures.notifyUnlessCancelled }));
vi.mock("@tanstack/react-router", async () => {
  const { useSyncExternalStore } = await vi.importActual<typeof import("react")>("react");
  const subscribeRoute = (listener: () => void) => {
    fixtures.routeListeners.add(listener);
    return () => {
      fixtures.routeListeners.delete(listener);
    };
  };
  return {
    useNavigate: () => fixtures.navigateImpl,
    useRouterState: ({
      select,
    }: {
      select: (state: { location: { pathname: string; href: string } }) => unknown;
    }) => {
      const pathname = useSyncExternalStore(subscribeRoute, () => fixtures.pathname);
      const href = useSyncExternalStore(subscribeRoute, () => fixtures.href ?? fixtures.pathname);
      return select({ location: { pathname, href } });
    },
  };
});
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
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@mantine/core", () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Group: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TextInput: ({ label, ...props }: { label: string }) => <input aria-label={label} {...props} />,
}));
vi.mock("../common/AppModal", () => ({
  default: ({ opened, children }: { opened: boolean; children: ReactNode }) =>
    opened ? <div role="dialog">{children}</div> : null,
}));
vi.mock("./ConfirmChangesModal", () => ({
  default: (props: NonNullable<typeof fixtures.modalProps>) => {
    fixtures.modalProps = props;
    return null;
  },
}));

import { useRouterState } from "@tanstack/react-router";
import {
  activeTabAtom,
  closingTabsAtom,
  gameIdFamily,
  gameSessionFamily,
  pendingGameStartFamily,
  tabsAtom,
} from "@/state/atoms";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;
let latest: TabCommands | null;
const store = getDefaultStore();

function Probe() {
  latest = useTabCommands();
  return <div data-testid="probe" />;
}

function renderOwner() {
  return act(async () => {
    root.render(
      <TabCommandsProvider>
        <Probe />
      </TabCommandsProvider>,
    );
  });
}

function invokeHotkey(keys: string) {
  const binding = fixtures.hotkeyBindings?.find(([shortcut]) => shortcut === keys);
  if (!binding) throw new Error(`Missing hotkey binding: ${keys}`);
  binding[1](new KeyboardEvent("keydown"));
}

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.platform.mockReturnValue("linux");
  fixtures.commitReceipt = true;
  fixtures.treeStatuses.clear();
  fixtures.tabs = [
    { value: "current", name: "Current", type: "new", gameOrigin: { kind: "none" } },
    { value: "next", name: "Next", type: "new", gameOrigin: { kind: "none" } },
  ];
  fixtures.treeStatus = { kind: "available" };
  fixtures.getStatus.mockImplementation(
    (key) => fixtures.treeStatuses.get(key) ?? fixtures.treeStatus,
  );
  store.set(tabsAtom, fixtures.tabs);
  store.set(activeTabAtom, "current");
  store.set(closingTabsAtom, new Set());
  for (const tabId of ["current", "next"]) {
    store.set(gameIdFamily(tabId), null);
    store.set(gameSessionFamily(tabId), null);
    store.set(pendingGameStartFamily(tabId), null);
  }
  fixtures.dirty = false;
  fixtures.closeReceipt = true;
  fixtures.replaceReceipt = true;
  fixtures.modalProps = null;
  fixtures.createTab.mockResolvedValue("created");
  fixtures.hotkeyBindings = null;
  fixtures.pathname = "/";
  fixtures.href = null;
  fixtures.reactiveRouter = false;
  fixtures.routeListeners.clear();
  fixtures.navigate.mockReset();
  fixtures.killEngines.mockResolvedValue(undefined);
  fixtures.invalidateReportOwner.mockReturnValue({ previous: {}, invalidated: {} });
  fixtures.abortGame.mockResolvedValue(undefined);
  fixtures.createTreeStore.mockImplementation(() => ({
    subscribe: fixtures.subscribe,
    getState: () => ({ dirty: fixtures.dirty }),
  }));
  latest = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => root.unmount());
  fixtures.reactiveRouter = false;
  fixtures.routeListeners.clear();
  container.remove();
});

test("useTabCommands throws outside the owner", async () => {
  let caught: unknown;
  function Broken() {
    try {
      useTabCommands();
    } catch (error) {
      caught = error;
    }
    return null;
  }
  await act(async () => {
    root.render(<Broken />);
  });
  expect(caught).toEqual(
    expect.objectContaining({ message: "useTabCommands used outside a TabCommandsProvider" }),
  );
});

test.each(["/", "/library"] as const)(
  "closing a gated tab from %s shows the tab and stops the close",
  async (pathname) => {
    fixtures.pathname = pathname;
    fixtures.tabs = [
      { value: "current", name: "Current", type: "new", gameOrigin: { kind: "none" } },
      { value: "gated", name: "Gated", type: "analysis", gameOrigin: { kind: "none" } },
    ];
    store.set(tabsAtom, fixtures.tabs);
    fixtures.treeStatuses.set("gated", { kind: "unreadable", rawValue: "broken" });
    await renderOwner();

    await act(async () => {
      await latest!.closeTab("gated");
    });

    expect(fixtures.closeWorkspaceTab).not.toHaveBeenCalled();
    expect(store.get(activeTabAtom)).toBe("gated");
    expect(fixtures.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/" });
  },
);

test.each(["not-read", "unreadable", "unavailable"] as const)(
  "refused close for a %s tree shows the tab",
  async (kind) => {
    fixtures.tabs = [
      { value: "current", name: "Current", type: "new", gameOrigin: { kind: "none" } },
      {
        value: "gated",
        name: "Gated",
        type: "play",
        gameOrigin: { kind: "none" },
      },
    ];
    store.set(tabsAtom, fixtures.tabs);
    fixtures.treeStatuses.set(
      "gated",
      kind === "not-read"
        ? { kind: "not-read" }
        : kind === "unreadable"
          ? { kind: "unreadable", rawValue: "broken" }
          : { kind: "unavailable", error: new Error("refused") },
    );
    await renderOwner();

    await act(async () => {
      await latest!.closeTab("gated");
    });

    expect(fixtures.closeWorkspaceTab).not.toHaveBeenCalled();
    expect(store.get(activeTabAtom)).toBe("gated");
    expect(fixtures.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/" });
  },
);

test("select, duplicate, rename, reorder and new tab are callable without BoardsPage", async () => {
  await renderOwner();

  await act(async () => latest!.selectTab("next"));
  expect(store.get(activeTabAtom)).toBe("next");

  await act(async () => latest!.duplicateTab("current"));
  expect(fixtures.cloneDurable.mock.calls[0]?.[0]).toBe("current");
  expect(store.get(tabsAtom)).toHaveLength(3);

  await act(async () => latest!.renameTab("current"));
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(container.querySelector("input")!.value).toBe("Current");

  await act(async () => latest!.reorderTabs(0, 1));
  expect(
    store
      .get(tabsAtom)
      .map((tab) => tab.value)
      .slice(0, 2),
  ).toEqual(["next", "current"]);

  await act(async () => latest!.newTab());
  expect(fixtures.createTab).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(fixtures.navigate).toHaveBeenCalledWith({ to: "/" }));
});

test("selectTab and newTab navigate to the boards page from another route", async () => {
  fixtures.pathname = "/library";
  await renderOwner();
  await act(async () => latest!.selectTab("next"));
  expect(store.get(activeTabAtom)).toBe("next");
  expect(fixtures.navigate).toHaveBeenCalledWith({ to: "/" });
  fixtures.navigate.mockClear();
  await act(async () => latest!.newTab());
  await vi.waitFor(() => expect(fixtures.navigate).toHaveBeenCalledWith({ to: "/" }));
});

test("CLOSE_TAB closes a board tab, leaves a temporary page, and ignores the Library family", async () => {
  fixtures.pathname = "/";
  await renderOwner();
  invokeHotkey("mod+w");
  await vi.waitFor(() => expect(fixtures.closeWorkspaceTab).toHaveBeenCalledWith("current"));

  fixtures.closeWorkspaceTab.mockClear();
  fixtures.pathname = "/settings";
  await renderOwner();
  invokeHotkey("mod+w");
  expect(fixtures.navigate).toHaveBeenCalledWith({ to: "/" });

  fixtures.navigate.mockClear();
  fixtures.closeWorkspaceTab.mockClear();
  fixtures.pathname = "/library";
  await renderOwner();
  invokeHotkey("mod+w");
  expect(fixtures.closeWorkspaceTab).not.toHaveBeenCalled();
});

test("select and cycle do nothing when there is no tab", async () => {
  fixtures.createTab.mockReturnValue(new Promise(() => undefined));
  store.set(tabsAtom, []);
  store.set(activeTabAtom, null);
  await renderOwner();

  await act(async () => {
    latest!.selectTab("missing");
    invokeHotkey("alt+1");
    invokeHotkey("ctrl+9");
    invokeHotkey("mod+tab");
    invokeHotkey("mod+shift+tab");
  });

  expect(store.get(tabsAtom)).toEqual([]);
  expect(store.get(activeTabAtom)).toBeNull();
});

test("macOS meta+w capture closes a temporary item, the active tab on `/`, and nothing on Library", async () => {
  fixtures.platform.mockReturnValue("macos");

  fixtures.pathname = "/settings";
  await renderOwner();
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "w", metaKey: true, bubbles: true, cancelable: true }),
    );
  });
  expect(fixtures.navigate).toHaveBeenCalledWith({ to: "/" });
  expect(fixtures.closeWorkspaceTab).not.toHaveBeenCalled();

  fixtures.navigate.mockClear();
  fixtures.pathname = "/";
  await renderOwner();
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "w", metaKey: true, bubbles: true, cancelable: true }),
    );
  });
  await vi.waitFor(() => expect(fixtures.closeWorkspaceTab).toHaveBeenCalledWith("current"));

  fixtures.closeWorkspaceTab.mockClear();
  fixtures.navigate.mockClear();
  fixtures.pathname = "/library";
  await renderOwner();
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "w", metaKey: true, bubbles: true, cancelable: true }),
    );
  });
  expect(fixtures.closeWorkspaceTab).not.toHaveBeenCalled();
  expect(fixtures.navigate).not.toHaveBeenCalled();
});

test("cycleTabs and selectTabAt from /library navigate home and select the right tab", async () => {
  fixtures.pathname = "/library";
  await renderOwner();

  await act(async () => invokeHotkey("mod+tab"));
  expect(store.get(activeTabAtom)).toBe("next");
  expect(fixtures.navigate).toHaveBeenCalledWith({ to: "/" });

  fixtures.navigate.mockClear();
  store.set(activeTabAtom, "current");
  await act(async () => invokeHotkey("alt+2"));
  expect(store.get(activeTabAtom)).toBe("next");
  expect(fixtures.navigate).toHaveBeenCalledWith({ to: "/" });
});

test("cycleTabs does nothing when tabs are present but none matches the active tab", async () => {
  store.set(activeTabAtom, "missing");
  await renderOwner();
  fixtures.navigate.mockClear();

  await act(async () => invokeHotkey("mod+tab"));

  expect(store.get(activeTabAtom)).toBe("missing");
  expect(fixtures.navigate).not.toHaveBeenCalled();
});

test("close of a healthy tab still tears the tab down", async () => {
  await renderOwner();
  await act(async () => {
    await latest!.closeTab("current");
  });
  expect(fixtures.closeWorkspaceTab).toHaveBeenCalledWith("current");
  expect(fixtures.navigate).not.toHaveBeenCalled();
});

function BoardProbe({ renders }: { renders: Array<string | null> }) {
  const { activeTab } = useTabCommands();
  useLayoutEffect(() => {
    renders.push(activeTab);
  });
  return <div data-testid="board-probe" data-active-tab={activeTab ?? ""} />;
}

function ReactiveBoardRoute({ renders }: { renders: Array<string | null> }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return pathname === "/" ? <BoardProbe renders={renders} /> : null;
}

const offBoardActivationCases = [
  { name: 'selectTab("B")', activate: () => latest!.selectTab("B") },
  { name: "numbered hotkey alt+2", activate: () => invokeHotkey("alt+2") },
  { name: "forward cycle hotkey", activate: () => invokeHotkey("mod+tab") },
  { name: "reverse cycle hotkey", activate: () => invokeHotkey("mod+shift+tab") },
  { name: 'showTab("B")', activate: () => latest!.showTab("B") },
] as const;

test.each(offBoardActivationCases)(
  "activating tab B from /library via $name renders B on the first board render",
  async ({ activate }) => {
    fixtures.reactiveRouter = true;
    fixtures.pathname = "/library";
    fixtures.tabs = [
      { value: "A", name: "Tab A", type: "new", gameOrigin: { kind: "none" } },
      { value: "B", name: "Tab B", type: "new", gameOrigin: { kind: "none" } },
    ];
    store.set(tabsAtom, fixtures.tabs);
    store.set(activeTabAtom, "A");

    const boardRenders: Array<string | null> = [];
    await act(async () => {
      root.render(
        <TabCommandsProvider>
          <Probe />
          <ReactiveBoardRoute renders={boardRenders} />
        </TabCommandsProvider>,
      );
    });
    expect(boardRenders).toEqual([]);

    await act(async () => {
      activate();
    });

    expect(boardRenders).toEqual(["B"]);
    expect(store.get(activeTabAtom)).toBe("B");
    expect(latest!.activeTab).toBe("B");
  },
);

test("showPageTab restores last href, returns a Promise, falls back on rejection, and resets on closePageTab", async () => {
  const {
    clearSettingsScroll,
    getSettingsScrollGeneration,
    readSettingsScroll,
    recordSettingsScroll,
  } = await import("@/state/settingsNavigation");
  clearSettingsScroll();
  sessionStorage.clear();
  localStorage.clear();

  // Visit /settings?category=sound so pageTabHrefRef records it.
  fixtures.pathname = "/settings";
  fixtures.href = "/settings?category=sound";
  await renderOwner();

  const genBeforeClose = getSettingsScrollGeneration();
  recordSettingsScroll({ mode: "category", category: "sound" }, 220, genBeforeClose);

  // Already on Settings: showPageTab resolves without navigating.
  await act(async () => {
    const result = latest!.showPageTab("settings");
    expect(result).toBeInstanceOf(Promise);
    await result;
  });
  expect(fixtures.navigate).not.toHaveBeenCalled();

  // Switch away to Library, then return via showPageTab("settings") -> restores last href.
  fixtures.pathname = "/library";
  fixtures.href = "/library";
  await renderOwner();
  await act(async () => {
    await latest!.showPageTab("settings");
  });
  expect(fixtures.navigate).toHaveBeenCalledExactlyOnceWith({ href: "/settings?category=sound" });

  // No web-storage write of Settings last location (category/q/scroll).
  expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain("category=sound");
  expect(JSON.stringify(Object.entries(localStorage))).not.toContain("category=sound");

  // If navigating to the saved href rejects, fall back to /settings.
  fixtures.navigate.mockReset();
  fixtures.navigate.mockRejectedValueOnce(new Error("stale href")).mockResolvedValueOnce(undefined);
  await act(async () => {
    await latest!.showPageTab("settings");
  });
  expect(fixtures.navigate.mock.calls).toEqual([
    [{ href: "/settings?category=sound" }],
    [{ to: "/settings" }],
  ]);

  // If both last-href and the /settings fallback reject, showPageTab rejects with the fallback error.
  fixtures.pathname = "/settings";
  fixtures.href = "/settings?category=sound";
  await renderOwner();
  fixtures.pathname = "/library";
  fixtures.href = "/library";
  await renderOwner();
  fixtures.navigate.mockReset();
  const fallbackError = new Error("fallback failed");
  fixtures.navigate
    .mockRejectedValueOnce(new Error("stale href"))
    .mockRejectedValueOnce(fallbackError);
  await expect(latest!.showPageTab("settings")).rejects.toBe(fallbackError);
  expect(fixtures.navigate.mock.calls).toEqual([
    [{ href: "/settings?category=sound" }],
    [{ to: "/settings" }],
  ]);

  // If last-href rejects and the /settings fallback is deferred, showPageTab waits for the fallback to settle.
  fixtures.pathname = "/settings";
  fixtures.href = "/settings?category=sound";
  await renderOwner();
  fixtures.pathname = "/library";
  fixtures.href = "/library";
  await renderOwner();
  fixtures.navigate.mockReset();
  let resolveFallback!: () => void;
  const fallbackPromise = new Promise<void>((resolve) => {
    resolveFallback = resolve;
  });
  fixtures.navigate
    .mockRejectedValueOnce(new Error("stale href"))
    .mockReturnValueOnce(fallbackPromise);
  let settled = false;
  const pendingFallback = latest!.showPageTab("settings").then(() => {
    settled = true;
  });
  await vi.waitFor(() =>
    expect(fixtures.navigate.mock.calls).toEqual([
      [{ href: "/settings?category=sound" }],
      [{ to: "/settings" }],
    ]),
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  resolveFallback();
  await pendingFallback;
  expect(settled).toBe(true);

  // Re-record a last href, then closePageTab("settings") clears href, clears scroll, and bumps generation.
  fixtures.pathname = "/settings";
  fixtures.href = "/settings?category=sound";
  await renderOwner();
  fixtures.pathname = "/library";
  fixtures.href = "/library";
  await renderOwner();
  fixtures.navigate.mockReset();

  await act(async () => {
    latest!.closePageTab("settings");
  });
  expect(getSettingsScrollGeneration()).toBeGreaterThan(genBeforeClose);
  expect(readSettingsScroll({ mode: "category", category: "sound" })).toBeUndefined();
  // Stale generation write after close is ignored.
  recordSettingsScroll({ mode: "category", category: "board" }, 180, genBeforeClose);
  expect(readSettingsScroll({ mode: "category", category: "board" })).toBeUndefined();

  await act(async () => {
    await latest!.showPageTab("settings");
  });
  expect(fixtures.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/settings" });
});

function seedAnalysisTabs() {
  fixtures.tabs = [
    {
      value: "current",
      name: "Sicilian",
      type: "analysis",
      gameOrigin: { kind: "temp_file", file: { path: "/x.pgn" } as never, gameNumber: 0 },
      explorer: { firstSource: "lch_master" },
    },
    { value: "next", name: "Next", type: "new", gameOrigin: { kind: "none" } },
  ];
  store.set(tabsAtom, fixtures.tabs);
}

test("New analysis replaces the shown analysis board in place with an empty, unlinked one", async () => {
  seedAnalysisTabs();
  await renderOwner();

  await act(async () => latest!.newAnalysis());

  await vi.waitFor(() => expect(fixtures.replaceWorkspaceTab).toHaveBeenCalledOnce());
  const [replaced, successor] = fixtures.replaceWorkspaceTab.mock.calls[0] as [string, TabFixture];
  expect(replaced).toBe("current");
  expect(successor).toEqual({
    name: "Home.Card.AnalysisBoard.Title",
    value: expect.any(String),
    type: "analysis",
    gameOrigin: { kind: "none" },
    explorer: { firstSource: "lch_master" },
  });
  expect(successor.value).not.toBe("current");
  expect(fixtures.killEngines).toHaveBeenCalledWith("current");
  expect(fixtures.copyTabEngineSettings).toHaveBeenCalledWith({
    from: "current",
    to: successor.value,
  });
  expect(fixtures.closeTreeStore).toHaveBeenCalledWith("current");
  expect(fixtures.closeWorkspaceTab).not.toHaveBeenCalled();
  expect(store.get(tabsAtom).map((tab) => tab.value)).toEqual([successor.value, "next"]);
  expect(store.get(activeTabAtom)).toBe(successor.value);
  expect(fixtures.createTab).not.toHaveBeenCalled();
});

test("New analysis asks first when unsaved work would be lost, then discards on request", async () => {
  seedAnalysisTabs();
  fixtures.dirty = true;
  await renderOwner();

  await act(async () => latest!.newAnalysis());

  expect(fixtures.modalProps?.pendingClose).toEqual(
    expect.objectContaining({ tabId: "current", intent: "newAnalysis" }),
  );
  expect(fixtures.killEngines).not.toHaveBeenCalled();
  expect(fixtures.replaceWorkspaceTab).not.toHaveBeenCalled();

  await act(async () => fixtures.modalProps!.onDiscard());

  await vi.waitFor(() => expect(fixtures.replaceWorkspaceTab).toHaveBeenCalledOnce());
  expect(fixtures.closeWorkspaceTab).not.toHaveBeenCalled();
});

test("New analysis continues with the replacement after Save in its confirmation", async () => {
  seedAnalysisTabs();
  fixtures.dirty = true;
  await renderOwner();

  await act(async () => latest!.newAnalysis());
  await act(async () => fixtures.modalProps!.onSaved());

  await vi.waitFor(() => expect(fixtures.replaceWorkspaceTab).toHaveBeenCalledOnce());
  expect(fixtures.replaceWorkspaceTab.mock.calls[0]?.[0]).toBe("current");
  expect(fixtures.closeWorkspaceTab).not.toHaveBeenCalled();
});

test("the NEW_ANALYSIS shortcut replaces the shown analysis board", async () => {
  seedAnalysisTabs();
  await renderOwner();

  const event = new KeyboardEvent("keydown", {
    key: "n",
    code: "KeyN",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    document.body.dispatchEvent(event);
  });

  // The webview's own Ctrl+N must not run as well.
  expect(event.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(fixtures.replaceWorkspaceTab).toHaveBeenCalledOnce());
  expect(fixtures.createTab).not.toHaveBeenCalled();
});

test("a dirty close still closes after its confirmation", async () => {
  seedAnalysisTabs();
  fixtures.dirty = true;
  await renderOwner();

  await act(async () => {
    await latest!.closeTab("current");
  });
  expect(fixtures.modalProps?.pendingClose).toEqual(
    expect.objectContaining({ tabId: "current", intent: "close" }),
  );

  await act(async () => fixtures.modalProps!.onSaved());

  await vi.waitFor(() => expect(fixtures.closeWorkspaceTab).toHaveBeenCalledWith("current"));
  expect(fixtures.replaceWorkspaceTab).not.toHaveBeenCalled();
});

test("a refused replacement keeps the old board and restores its report owner", async () => {
  seedAnalysisTabs();
  fixtures.replaceReceipt = false;
  await renderOwner();

  await act(async () => latest!.newAnalysis());

  await vi.waitFor(() => expect(fixtures.restoreReportOwner).toHaveBeenCalledOnce());
  expect(fixtures.closeTreeStore).not.toHaveBeenCalled();
  expect(store.get(tabsAtom).map((tab) => tab.value)).toEqual(["current", "next"]);
});

test.each([
  ["a tab that is not an analysis board", "/", false],
  ["an analysis board behind another page", "/library", true],
] as const)(
  "New analysis from %s opens a new analysis board tab",
  async (_label, path, analysis) => {
    if (analysis) seedAnalysisTabs();
    fixtures.pathname = path;
    await renderOwner();

    await act(async () => latest!.newAnalysis());

    expect(fixtures.createTab).toHaveBeenCalledWith(
      expect.objectContaining({
        tab: { name: "Home.Card.AnalysisBoard.Title", type: "analysis" },
      }),
    );
    await vi.waitFor(() => expect(fixtures.navigate).toHaveBeenCalledWith({ to: "/" }));
    expect(fixtures.replaceWorkspaceTab).not.toHaveBeenCalled();
    expect(fixtures.killEngines).not.toHaveBeenCalled();
  },
);
