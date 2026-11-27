import { MantineProvider, VisuallyHidden } from "@mantine/core";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createStore, getDefaultStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  defaultPanelTabAtom,
  fileWorkspaceAtom,
  fileWorkspaceDisplayNameAtom,
  materialDisplayAtom,
  moveHighlightAtom,
  practiceGradingAtom,
  practiceNewPerSessionAtom,
  puzzleWorkspaceGenerationAtom,
  restoreOpenTabsAtom,
} from "@/state/atoms";
import { readRestoreOpenTabsPreference, RESTORE_OPEN_TABS_KEY } from "@/state/restoreOpenTabs";
import {
  clearSettingsScroll,
  readSettingsScroll,
  requestSettingsNavigation,
  settingsNavigationRequestAtom,
} from "@/state/settingsNavigation";
import { Route as SettingsRoute } from "@/routes/settings";
import { catalogueI18n } from "@/tests/catalogues";
import { installInlineComputedStyleStub } from "@/tests/computedStyle";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { describeSettings } from "./settingsDescription";
import Page, { loadPgnDirectoryStatus } from "./SettingsPage";
import { ensureFileWorkspace } from "@/utils/files";
import classes from "./SettingsPage.module.css";

const platformMock = vi.hoisted(() => vi.fn(() => "windows"));
vi.mock("@/platform/native", () => ({
  getVersion: vi.fn().mockResolvedValue("test"),
  platform: platformMock,
  warn: vi.fn(),
  error: vi.fn(),
}));
const translation = vi.hoisted(() => ({
  identity: (key: string) => key,
  t: (key: string, _options?: Record<string, unknown>): string => key,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => translation.t(key, options),
    i18n: { language: "en-US" },
  }),
}));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  changeLocale: vi.fn(),
}));
vi.mock("./BoardSelect", () => ({ default: () => null }));
const layout = vi.hoisted(() => ({ compact: false }));
vi.mock("@/hooks/useScaledMaxWidth", () => ({
  useScaledMaxWidth: () => layout.compact,
}));
vi.mock("./KeybindInput", () => ({ default: () => null, KbdDisplay: () => null }));
vi.mock("./PercentagePreferenceSlider", () => ({ default: () => null }));
vi.mock("./PiecesSelect", () => ({ default: () => null }));
vi.mock("./RepertoireMinGamesSetting", () => ({ default: () => null }));
vi.mock("./DirectorySetting", () => ({ DirectorySetting: () => null }));
const directoryRows = vi.hoisted(() => ({
  current: [] as Array<{
    load: () => Promise<{ displayName: string }>;
    issue: () => Promise<{ displayName: string } | null>;
    restoreDefault?: () => Promise<{ displayName: string } | null>;
    onShowInFolder?: () => Promise<void> | void;
    onSelected?: (name: string) => void;
    onError: (error: unknown) => void;
    reportLoadError?: boolean;
  }>,
}));
const publishDatabaseListMock = vi.hoisted(() => vi.fn((..._args: unknown[]) => Promise.resolve()));
const swrMutateMock = vi.hoisted(() => vi.fn((..._args: unknown[]) => Promise.resolve()));
vi.mock("@/hooks/useDatabaseList", () => ({
  publishDatabaseList: publishDatabaseListMock,
}));
vi.mock("swr", async (original) => {
  const actual = await original<typeof import("swr")>();
  return {
    ...actual,
    useSWRConfig: () => ({ mutate: swrMutateMock }),
  };
});
vi.mock("./WorkspaceDirectorySetting", () => ({
  WorkspaceDirectorySetting: (props: (typeof directoryRows.current)[number]) => {
    directoryRows.current.push(props);
    return null;
  },
}));
const tauriMocks = vi.hoisted(() => ({
  issueFileWorkspace: vi.fn(),
  openFileWorkspace: vi.fn(),
  openDatabaseWorkspace: vi.fn(),
  openEngineWorkspace: vi.fn(),
  openPuzzleWorkspace: vi.fn(),
  issueDatabaseWorkspace: vi.fn(),
  restoreDatabaseWorkspace: vi.fn(),
  issueEngineWorkspace: vi.fn(),
  restoreEngineWorkspace: vi.fn(),
  issuePuzzleWorkspace: vi.fn(),
  restorePuzzleWorkspace: vi.fn(),
  getDatabaseFolderStatus: vi.fn(),
  getEngineFolderStatus: vi.fn(),
  getPuzzleFolderStatus: vi.fn(),
  applyFolderSwitch: vi.fn(),
  cancelFolderSwitch: vi.fn(),
  getDefaultFileWorkspace: vi.fn(),
  getFileFolderStatus: vi.fn(),
}));
vi.mock("@/platform/tauri", async (original) => {
  const actual = await original<typeof import("@/platform/tauri")>();
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      issueFileWorkspace: (...args: unknown[]) => tauriMocks.issueFileWorkspace(...args),
      issueDatabaseWorkspace: (...args: unknown[]) => tauriMocks.issueDatabaseWorkspace(...args),
      restoreDatabaseWorkspace: (...args: unknown[]) =>
        tauriMocks.restoreDatabaseWorkspace(...args),
      issueEngineWorkspace: (...args: unknown[]) => tauriMocks.issueEngineWorkspace(...args),
      restoreEngineWorkspace: (...args: unknown[]) => tauriMocks.restoreEngineWorkspace(...args),
      issuePuzzleWorkspace: (...args: unknown[]) => tauriMocks.issuePuzzleWorkspace(...args),
      restorePuzzleWorkspace: (...args: unknown[]) => tauriMocks.restorePuzzleWorkspace(...args),
      getDatabaseFolderStatus: (...args: unknown[]) => tauriMocks.getDatabaseFolderStatus(...args),
      getEngineFolderStatus: (...args: unknown[]) => tauriMocks.getEngineFolderStatus(...args),
      getPuzzleFolderStatus: (...args: unknown[]) => tauriMocks.getPuzzleFolderStatus(...args),
      applyFolderSwitch: (...args: unknown[]) => tauriMocks.applyFolderSwitch(...args),
      cancelFolderSwitch: (...args: unknown[]) => tauriMocks.cancelFolderSwitch(...args),
      openFileWorkspace: (...args: unknown[]) => tauriMocks.openFileWorkspace(...args),
      openDatabaseWorkspace: (...args: unknown[]) => tauriMocks.openDatabaseWorkspace(...args),
      openEngineWorkspace: (...args: unknown[]) => tauriMocks.openEngineWorkspace(...args),
      openPuzzleWorkspace: (...args: unknown[]) => tauriMocks.openPuzzleWorkspace(...args),
      getDefaultFileWorkspace: (...args: unknown[]) => tauriMocks.getDefaultFileWorkspace(...args),
      getFileFolderStatus: (...args: unknown[]) => tauriMocks.getFileFolderStatus(...args),
    },
  };
});
vi.mock("./SoundSelect", () => ({ default: () => null }));
vi.mock("./VolumeSlider", () => ({ default: () => null }));
vi.mock("./ThemeButton", () => ({ default: () => null }));
const coach = vi.hoisted(() => ({ enabled: false }));
vi.mock("@/state/coach", async (original) => {
  const { atom } = await import("jotai");
  return {
    ...(await original<typeof import("@/state/coach")>()),
    coachEnabledAtom: atom(() => coach.enabled),
  };
});
vi.mock("./coach/CoachConnections", () => ({
  CoachConnections: () => <div data-testid="coach-connections" />,
}));
vi.mock("./coach/CoachEngineSelect", () => ({ CoachEngineSelect: () => null }));
vi.mock("./coach/CoachModelSetting", () => ({ CoachModelSetting: () => null }));
const actionMocks = vi.hoisted(() => ({
  reloadApp: vi.fn(),
  clearSavedData: vi.fn(),
  openAppLogs: vi.fn(),
  notifyUnlessCancelled: vi.fn(),
  notificationsShow: vi.fn(),
}));
vi.mock("./advancedActions", () => ({
  reloadApp: (...args: unknown[]) => actionMocks.reloadApp(...args),
  clearSavedData: (...args: unknown[]) => actionMocks.clearSavedData(...args),
  openAppLogs: (...args: unknown[]) => actionMocks.openAppLogs(...args),
}));
vi.mock("@/components/files/notifyError", () => ({
  notifyUnlessCancelled: (...args: unknown[]) => actionMocks.notifyUnlessCancelled(...args),
}));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: (...args: unknown[]) => actionMocks.notificationsShow(...args) },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();
installInlineComputedStyleStub();
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  localStorage.clear();
  sessionStorage.clear();
  clearSettingsScroll();
  translation.t = translation.identity;
  layout.compact = false;
  coach.enabled = false;
  actionMocks.reloadApp.mockReset();
  actionMocks.clearSavedData.mockReset();
  actionMocks.openAppLogs.mockReset();
  actionMocks.notifyUnlessCancelled.mockReset();
  actionMocks.notificationsShow.mockReset();
  directoryRows.current = [];
  tauriMocks.issueFileWorkspace.mockReset();
  tauriMocks.openFileWorkspace.mockReset();
  tauriMocks.openDatabaseWorkspace.mockReset();
  tauriMocks.openEngineWorkspace.mockReset();
  tauriMocks.openPuzzleWorkspace.mockReset();
  tauriMocks.getDefaultFileWorkspace.mockReset();
  tauriMocks.getFileFolderStatus.mockReset();
  getDefaultStore().set(fileWorkspaceAtom, null);
  getDefaultStore().set(fileWorkspaceDisplayNameAtom, "");
  root = undefined;
  if (originalScroll) Object.defineProperty(Element.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

async function renderSettingsPage(atoms = createStore(), initialEntry = "/settings") {
  const container = document.createElement("div");
  host = container;
  document.body.append(container);
  root = createRoot(container);
  const rootRoute = createRootRoute();
  const settingsChild = SettingsRoute.update({
    id: "/settings",
    path: "/settings",
    getParentRoute: () => rootRoute,
  } as never).update({
    component: Page,
    errorComponent: () => <div data-testid="settings-error-component">error</div>,
  });
  const history = createMemoryHistory({ initialEntries: [initialEntry] });
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsChild]),
    history,
  });
  await act(async () => {
    await router.load();
    root!.render(
      <Provider store={atoms}>
        <MantineProvider env="test">
          <RouterProvider router={router} />
        </MantineProvider>
      </Provider>,
    );
  });
  return { atoms, host: container, router, history };
}

/** Opens the select named `label`, checks its current value and option order, and picks `choice`. */
async function pickSelectOption(
  container: HTMLElement,
  label: string,
  { initial, options, choice }: { initial: string; options: string[]; choice: string },
) {
  const select = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(select.value).toBe(initial);
  await act(async () => select.click());
  const rendered = [
    ...document.querySelectorAll<HTMLElement>(
      `#${select.getAttribute("aria-controls")} [role="option"]`,
    ),
  ];
  expect(rendered.map((node) => node.textContent)).toEqual(options);
  const picked = rendered.find((node) => node.textContent === choice)!;
  await act(async () => picked.click());
  expect(select.value).toBe(choice);
}

test("practice settings expose automatic/manual grading and the session new-move limit", async () => {
  const { atoms, host } = await renderSettingsPage();
  expect(host.querySelector('input[placeholder="Common.Search"]')?.getAttribute("aria-label")).toBe(
    "Common.Search",
  );
  const tab = host.querySelector<HTMLButtonElement>(
    '[role="tab"][data-settings-category="repertoire"]',
  )!;
  await act(async () => tab.click());
  const grading = host.querySelector<HTMLInputElement>(
    'input[aria-label="Settings.Repertoire.Grading"]',
  )!;
  expect(grading.value).toBe("Settings.Repertoire.Grading.Automatic");
  await act(async () => grading.click());
  const manual = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (node) => node.textContent === "Settings.Repertoire.Grading.Manual",
  )!;
  await act(async () => manual.click());
  expect(atoms.get(practiceGradingAtom)).toBe("manual");
  const limit = host.querySelector<HTMLInputElement>(
    'input[aria-label="Settings.Repertoire.NewPerSession"]',
  )!;
  expect(limit.value).toBe("10");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(limit, "0");
    limit.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(atoms.get(practiceNewPerSessionAtom)).toBe(0);
  const setText = async (text: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(limit, text);
      limit.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const blur = async () =>
    act(async () => {
      limit.focus();
      limit.blur();
    });
  // A cleared field shows the stored limit again once it loses focus.
  await setText("");
  await blur();
  expect(limit.value).toBe("0");
  expect(atoms.get(practiceNewPerSessionAtom)).toBe(0);
  // An over-limit draft is clamped on blur, and the clamped limit is stored.
  await setText("150");
  expect(atoms.get(practiceNewPerSessionAtom)).toBe(0);
  await blur();
  expect(limit.value).toBe("100");
  expect(atoms.get(practiceNewPerSessionAtom)).toBe(100);
});

test("the material display select offers Off and stores none", async () => {
  const { atoms, host } = await renderSettingsPage();
  await pickSelectOption(host, "Settings.MaterialDisplay", {
    initial: "Settings.MaterialDisplay.Diff",
    options: [
      "Settings.MaterialDisplay.Diff",
      "Settings.MaterialDisplay.All",
      "Settings.MaterialDisplay.None",
    ],
    choice: "Settings.MaterialDisplay.None",
  });
  expect(atoms.get(materialDisplayAtom)).toBe("none");
  expect(localStorage.getItem("material-display")).toBe(JSON.stringify("none"));
});

test("the default panel select offers the four board panels and stores the choice", async () => {
  const { atoms, host } = await renderSettingsPage();
  await pickSelectOption(host, "Settings.DefaultPanel", {
    initial: "Board.Tabs.Info",
    options: [
      "Board.Tabs.Info",
      "Board.Tabs.Analysis",
      "Board.Tabs.Database",
      "Board.Tabs.Annotate",
    ],
    choice: "Board.Tabs.Database",
  });
  expect(atoms.get(defaultPanelTabAtom)).toBe("database");
  expect(localStorage.getItem("default-panel-tab")).toBe(JSON.stringify("database"));
});

test("keybind actions are labelled in the active language", async () => {
  const i18n = await catalogueI18n("de-DE");
  translation.t = (key, options) => i18n.t(key, options);
  const { host } = await renderSettingsPage();
  const tab = host.querySelector<HTMLButtonElement>(
    '[role="tab"][data-settings-category="keybinds"]',
  )!;
  await act(async () => tab.click());
  const labels = [...host.querySelectorAll("td:first-child")].map((cell) => cell.textContent);
  expect(labels).toContain("Neuer Tab");
  expect(labels).toContain("Zum Anfang der Partie");
  expect(labels).not.toContain("New tab");
});

test.each(["{", '"invalid"', "null", "101", "-1", "1.5"])(
  "corrupt stored practice preferences %s fall back to defaults",
  (value) => {
    localStorage.setItem("practice-grading", value);
    localStorage.setItem("practice-new-per-session", value);
    const atoms = createStore();
    const cleanups = [
      atoms.sub(practiceGradingAtom, () => {}),
      atoms.sub(practiceNewPerSessionAtom, () => {}),
    ];
    expect(atoms.get(practiceGradingAtom)).toBe("auto");
    expect(atoms.get(practiceNewPerSessionAtom)).toBe(10);
    cleanups.forEach((cleanup) => cleanup());
  },
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function settingsTab(host: HTMLElement, category: string) {
  return host.querySelector<HTMLButtonElement>(
    `[role="tab"][data-settings-category="${category}"]`,
  )!;
}

function tabIds(host: HTMLElement) {
  return [...host.querySelectorAll("[data-settings-category]")].map((node) =>
    node.getAttribute("data-settings-category"),
  );
}

async function openAdvanced(host: HTMLElement) {
  const tab = settingsTab(host, "advanced");
  await act(async () => tab.click());
  return tab;
}

function actionButton(host: HTMLElement, label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === label,
  )!;
}

async function searchSettings(host: HTMLElement, query: string) {
  const search = host.querySelector<HTMLInputElement>('input[placeholder="Common.Search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, query);
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("Advanced is the eighth and last settings category", async () => {
  const { host } = await renderSettingsPage();
  const tabs = tabIds(host);
  expect(tabs).toHaveLength(8);
  expect(tabs.at(-1)).toBe("advanced");
});

test("a build without the Coach shows no Coach category, row or search result", async () => {
  const { host } = await renderSettingsPage();
  expect(host.textContent).not.toContain("Settings.AI");
  expect(host.querySelector('[data-testid="coach-connections"]')).toBeNull();
  await searchSettings(host, "coach");
  expect(host.textContent).toContain("Settings.Search.NoResults");
  expect(host.textContent).not.toContain("Settings.AI");
});

test("the Coach shortcut is listed only in a build with the Coach", async () => {
  const keybindRows = async () => {
    const { host } = await renderSettingsPage();
    const tab = settingsTab(host, "keybinds");
    await act(async () => tab.click());
    const rows = [...host.querySelectorAll("tbody tr")].map((row) => row.textContent);
    await act(async () => root!.unmount());
    host.remove();
    root = undefined;
    return rows;
  };
  const without = await keybindRows();
  expect(without).not.toContain("Settings.Keybinds.Actions.COACH_TAB");
  expect(without).toContain("Settings.Keybinds.Actions.ANNOTATE_TAB");
  coach.enabled = true;
  expect(await keybindRows()).toContain("Settings.Keybinds.Actions.COACH_TAB");
});

test("a build with the Coach adds its category in the Chess group, with connections and the engine row", async () => {
  coach.enabled = true;
  const { host } = await renderSettingsPage();
  const tabs = tabIds(host);
  expect(tabs).toHaveLength(9);
  expect(tabs).toEqual([
    "board",
    "analysis",
    "repertoire",
    "coach",
    "general",
    "sound",
    "keybinds",
    "directories",
    "advanced",
  ]);
  const tab = settingsTab(host, "coach");
  await act(async () => tab.click());
  const panel = host.querySelector<HTMLElement>(`#${tab.getAttribute("aria-controls")}`)!;
  expect(panel.querySelector('[data-testid="coach-connections"]')).not.toBeNull();
  expect(panel.textContent).toContain("Settings.Coach.Engine.Desc");
  await searchSettings(host, "coach");
  expect(host.textContent).toContain("Settings.Coach.Engine.Desc");
});

test("Reload reloads and is disabled while pending", async () => {
  const pending = deferred<void>();
  actionMocks.reloadApp.mockImplementation(() => pending.promise);
  const { host } = await renderSettingsPage();
  await openAdvanced(host);
  const button = actionButton(host, "Menu.View.Reload");
  await act(async () => button.click());
  expect(actionMocks.reloadApp).toHaveBeenCalledOnce();
  expect(button.disabled).toBe(true);
  await act(async () => pending.resolve());
  expect(button.disabled).toBe(false);
});

test("Clear saved data asks through the shared action and is disabled while pending", async () => {
  const pending = deferred<void>();
  actionMocks.clearSavedData.mockImplementation(() => pending.promise);
  const { host } = await renderSettingsPage();
  await openAdvanced(host);
  const button = actionButton(host, "Menu.Help.ClearSavedData");
  await act(async () => button.click());
  expect(actionMocks.clearSavedData).toHaveBeenCalledOnce();
  expect(button.disabled).toBe(true);
  await act(async () => pending.resolve());
  expect(button.disabled).toBe(false);
});

test("Clear saved data shows the error when the shared action refuses", async () => {
  const error = new Error("blocked: failed (0)");
  actionMocks.clearSavedData.mockRejectedValueOnce(error);
  const { host } = await renderSettingsPage();
  await openAdvanced(host);
  await act(async () => actionButton(host, "Menu.Help.ClearSavedData").click());
  expect(actionMocks.notifyUnlessCancelled).toHaveBeenCalledExactlyOnceWith("Common.Error", error);
  expect(actionMocks.notificationsShow).not.toHaveBeenCalled();
});

test("Open logs opens the log, shows its message, and is disabled while pending", async () => {
  const pending = deferred<void>();
  actionMocks.openAppLogs.mockImplementation(() => pending.promise);
  const { host } = await renderSettingsPage();
  await openAdvanced(host);
  const button = actionButton(host, "Menu.Help.OpenLogs");
  await act(async () => button.click());
  expect(actionMocks.openAppLogs).toHaveBeenCalledOnce();
  expect(button.disabled).toBe(true);
  expect(actionMocks.notificationsShow).not.toHaveBeenCalled();
  await act(async () => pending.resolve());
  expect(button.disabled).toBe(false);
  expect(actionMocks.notificationsShow).toHaveBeenCalledExactlyOnceWith({
    message: "Menu.Help.OpenLogs",
  });
});

test("Open logs shows the error when opening fails", async () => {
  const error = new Error("log missing");
  actionMocks.openAppLogs.mockRejectedValueOnce(error);
  const { host } = await renderSettingsPage();
  await openAdvanced(host);
  await act(async () => actionButton(host, "Menu.Help.OpenLogs").click());
  expect(actionMocks.notifyUnlessCancelled).toHaveBeenCalledExactlyOnceWith("Common.Error", error);
  expect(actionMocks.notificationsShow).not.toHaveBeenCalled();
});

test("a second click cannot start an Advanced action while it is pending", async () => {
  const pending = deferred<void>();
  actionMocks.reloadApp.mockImplementation(() => pending.promise);
  const { host } = await renderSettingsPage();
  await openAdvanced(host);
  const button = actionButton(host, "Menu.View.Reload");
  await act(async () => button.click());
  await act(async () => button.click());
  expect(actionMocks.reloadApp).toHaveBeenCalledOnce();
  await act(async () => pending.resolve());
});

test("settings search finds the Advanced rows", async () => {
  const { host } = await renderSettingsPage();
  await searchSettings(host, "advanced");
  expect(host.textContent).toContain("Settings.Advanced.RestoreOpenTabs");
  expect(host.textContent).toContain("Menu.View.Reload");
  expect(host.textContent).toContain("Menu.Help.ClearSavedData");
  expect(host.textContent).toContain("Menu.Help.OpenLogs");
  await searchSettings(host, "restore");
  expect(host.textContent).toContain("Settings.Advanced.RestoreOpenTabs");
  expect(host.textContent).not.toContain("Menu.View.Reload");
  await searchSettings(host, "reload");
  expect(host.textContent).toContain("Menu.View.Reload");
  expect(host.textContent).not.toContain("Menu.Help.OpenLogs");
  await searchSettings(host, "logs");
  expect(host.textContent).toContain("Menu.Help.OpenLogs");
  expect(host.textContent).not.toContain("Menu.View.Reload");
  await searchSettings(host, "clear");
  expect(host.textContent).toContain("Menu.Help.ClearSavedData");
  expect(host.textContent).not.toContain("Menu.View.Reload");
});

test("Restore open tabs at start renders in Advanced and writes the restore preference key", async () => {
  const { atoms, host } = await renderSettingsPage();
  await openAdvanced(host);
  const panel = panelFor(host, "advanced");
  const row = panel.querySelector<HTMLElement>('[data-setting-id="restore-open-tabs"]')!;
  expect(row).toBeTruthy();
  expect(row.textContent).toContain("Settings.Advanced.RestoreOpenTabs");
  expect(row.textContent).toContain("Settings.Advanced.RestoreOpenTabs.Desc");

  const toggle = row.querySelector<HTMLInputElement>(
    'input[type="checkbox"][aria-label="Settings.Advanced.RestoreOpenTabs"]',
  )!;
  expect(toggle).toBeTruthy();
  expect(toggle.checked).toBe(true);
  expect(atoms.get(restoreOpenTabsAtom)).toBe(true);
  expect(readRestoreOpenTabsPreference()).toBe(true);

  await act(async () => {
    toggle.click();
  });
  expect(toggle.checked).toBe(false);
  expect(atoms.get(restoreOpenTabsAtom)).toBe(false);
  expect(localStorage.getItem(RESTORE_OPEN_TABS_KEY)).toBe(JSON.stringify(false));
  expect(readRestoreOpenTabsPreference()).toBe(false);

  await act(async () => {
    toggle.click();
  });
  expect(toggle.checked).toBe(true);
  expect(atoms.get(restoreOpenTabsAtom)).toBe(true);
  expect(localStorage.getItem(RESTORE_OPEN_TABS_KEY)).toBe(JSON.stringify(true));
  expect(readRestoreOpenTabsPreference()).toBe(true);
});

test.each([false, true])(
  "the page shows a row for every setting of the description and none besides (coachEnabled=%s)",
  async (coachEnabled) => {
    coach.enabled = coachEnabled;
    const { host } = await renderSettingsPage();
    const expectedIds = describeSettings(translation.identity, {
      platform: import.meta.env.VITE_PLATFORM,
      coachEnabled,
    })
      .filter((setting) => setting.shown)
      .map((setting) => setting.id);

    const renderedIds = [...host.querySelectorAll<HTMLElement>("[data-setting-id]")].map(
      (row) => row.dataset.settingId,
    );
    expect(renderedIds).toEqual(expect.arrayContaining(expectedIds));
    expect(renderedIds).toHaveLength(expectedIds.length);
  },
);

test("a request for a setting selects its category, marks its row, scrolls it into view and clears an entered search", async () => {
  const { atoms, host } = await renderSettingsPage();
  await searchSettings(host, "reload");
  expect(host.querySelector('[role="tablist"]')).toBeNull();

  const scrollSpy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
  scrollSpy.mockClear();

  await act(async () => {
    requestSettingsNavigation({ kind: "setting", settingId: "volume" }, atoms);
  });

  const search = host.querySelector<HTMLInputElement>('input[placeholder="Common.Search"]')!;
  expect(search.value).toBe("");
  const activeTab = host.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
  expect(activeTab?.getAttribute("data-settings-category")).toBe("sound");

  const row = host.querySelector<HTMLElement>('[data-setting-id="volume"]')!;
  expect(row.getAttribute("data-highlighted")).toBe("true");
  expect(host.querySelectorAll("[data-highlighted]")).toHaveLength(1);
  expect(scrollSpy).toHaveBeenCalledTimes(1);
  expect(scrollSpy.mock.instances[0]).toBe(row);
  expect(atoms.get(settingsNavigationRequestAtom)).toBeNull();
});

test("a request for a category selects it, clears an entered search, and clears a prior highlight", async () => {
  const { atoms, host } = await renderSettingsPage();
  await act(async () => {
    requestSettingsNavigation({ kind: "setting", settingId: "volume" }, atoms);
  });
  expect(host.querySelector('[data-setting-id="volume"]')?.getAttribute("data-highlighted")).toBe(
    "true",
  );

  await searchSettings(host, "volume");

  await act(async () => {
    requestSettingsNavigation({ kind: "category", category: "directories" }, atoms);
  });

  const search = host.querySelector<HTMLInputElement>('input[placeholder="Common.Search"]')!;
  expect(search.value).toBe("");
  const activeTab = host.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
  expect(activeTab?.getAttribute("data-settings-category")).toBe("directories");
  expect(host.querySelectorAll("[data-highlighted]")).toHaveLength(0);
  expect(atoms.get(settingsNavigationRequestAtom)).toBeNull();
});

test("switching tabs manually clears a prior setting highlight", async () => {
  const { atoms, host } = await renderSettingsPage();
  await act(async () => {
    requestSettingsNavigation({ kind: "setting", settingId: "volume" }, atoms);
  });
  expect(host.querySelector('[data-setting-id="volume"]')?.getAttribute("data-highlighted")).toBe(
    "true",
  );

  const generalTab = settingsTab(host, "general");
  await act(async () => generalTab.click());

  expect(
    host
      .querySelector('[role="tab"][aria-selected="true"]')
      ?.getAttribute("data-settings-category"),
  ).toBe("general");
  expect(host.querySelectorAll("[data-highlighted]")).toHaveLength(0);
});

test("a consumed request writes the category to the URL and remount keeps it while dropping highlight", async () => {
  const atoms = createStore();
  requestSettingsNavigation({ kind: "setting", settingId: "volume" }, atoms);
  const { host: firstHost, router: firstRouter } = await renderSettingsPage(atoms);

  expect(
    firstHost
      .querySelector('[role="tab"][aria-selected="true"]')
      ?.getAttribute("data-settings-category"),
  ).toBe("sound");
  expect(firstRouter.state.location.href).toBe("/settings?category=sound");
  expect(
    firstHost.querySelector('[data-setting-id="volume"]')?.getAttribute("data-highlighted"),
  ).toBe("true");
  expect(atoms.get(settingsNavigationRequestAtom)).toBeNull();

  const savedHref = firstRouter.state.location.href;
  await act(async () => root!.unmount());
  firstHost.remove();
  root = undefined;

  const scrollSpy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
  scrollSpy.mockClear();

  const { host: secondHost } = await renderSettingsPage(atoms, savedHref);
  expect(
    secondHost
      .querySelector('[role="tab"][aria-selected="true"]')
      ?.getAttribute("data-settings-category"),
  ).toBe("sound");
  expect(secondHost.querySelectorAll("[data-highlighted]")).toHaveLength(0);
  expect(scrollSpy).not.toHaveBeenCalled();
});

test("a newer request replaces an unconsumed one before Settings mounts", async () => {
  const atoms = createStore();
  requestSettingsNavigation({ kind: "setting", settingId: "volume" }, atoms);
  requestSettingsNavigation({ kind: "setting", settingId: "font-size" }, atoms);

  const { host } = await renderSettingsPage(atoms);
  expect(
    host
      .querySelector('[role="tab"][aria-selected="true"]')
      ?.getAttribute("data-settings-category"),
  ).toBe("general");
  expect(
    host.querySelector('[data-setting-id="font-size"]')?.getAttribute("data-highlighted"),
  ).toBe("true");
  expect(
    host.querySelector('[data-setting-id="volume"]')?.getAttribute("data-highlighted"),
  ).toBeNull();
  expect(atoms.get(settingsNavigationRequestAtom)).toBeNull();
});

test("a request for a hidden setting is consumed without leaving a broken selection", async () => {
  const atoms = createStore();
  requestSettingsNavigation({ kind: "setting", settingId: "coach-engine" }, atoms);

  const { host } = await renderSettingsPage(atoms);
  expect(
    host
      .querySelector('[role="tab"][aria-selected="true"]')
      ?.getAttribute("data-settings-category"),
  ).toBe("board");
  expect(host.querySelectorAll("[data-highlighted]")).toHaveLength(0);
  expect(atoms.get(settingsNavigationRequestAtom)).toBeNull();
});

test("a request for a hidden category leaves tab, search and highlight untouched and is consumed", async () => {
  const { atoms, host } = await renderSettingsPage();
  await act(async () => {
    requestSettingsNavigation({ kind: "setting", settingId: "volume" }, atoms);
  });
  await searchSettings(host, "reload");

  await act(async () => {
    requestSettingsNavigation({ kind: "category", category: "coach" }, atoms);
  });

  expect(atoms.get(settingsNavigationRequestAtom)).toBeNull();
  const search = host.querySelector<HTMLInputElement>('input[placeholder="Common.Search"]')!;
  expect(search.value).toBe("reload");

  await searchSettings(host, "");
  expect(
    host
      .querySelector('[role="tab"][aria-selected="true"]')
      ?.getAttribute("data-settings-category"),
  ).toBe("sound");
  expect(host.querySelector('[data-setting-id="volume"]')?.getAttribute("data-highlighted")).toBe(
    "true",
  );
});

test("last-move highlight dependents hide when the switch is off and reappear when it is on", async () => {
  const { atoms, host } = await renderSettingsPage();
  expect(host.querySelector('[data-setting-id="move-highlight-color"]')).not.toBeNull();
  expect(host.querySelector('[data-setting-id="move-highlight-opacity"]')).not.toBeNull();

  await act(async () => {
    atoms.set(moveHighlightAtom, false);
  });
  expect(host.querySelector('[data-setting-id="move-highlight-color"]')).toBeNull();
  expect(host.querySelector('[data-setting-id="move-highlight-opacity"]')).toBeNull();
  expect(host.querySelector('[data-setting-id="move-highlight"]')).not.toBeNull();

  await act(async () => {
    atoms.set(moveHighlightAtom, true);
  });
  expect(host.querySelector('[data-setting-id="move-highlight-color"]')).not.toBeNull();
  expect(host.querySelector('[data-setting-id="move-highlight-opacity"]')).not.toBeNull();
});

test("the board preview opens the Look card, above its first row, and appears nowhere else", async () => {
  const { host } = await renderSettingsPage();
  const previews = host.querySelectorAll('[data-testid="board-settings-preview"]');
  expect(previews).toHaveLength(1);
  const look = host.querySelector('[data-settings-section="look"]')!;
  expect(look.contains(previews[0])).toBe(true);
  const firstRow = look.querySelector('[data-setting-id="board-image"]')!;
  expect(previews[0].compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );

  await searchSettings(host, "texture");
  expect(host.querySelector('[data-setting-id="board-wood-texture"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="board-settings-preview"]')).toBeNull();
});

test("search still lists highlight dependents and groups them under Board · Highlights", async () => {
  const atoms = createStore();
  atoms.set(moveHighlightAtom, false);
  const { host } = await renderSettingsPage(atoms);
  await searchSettings(host, "Highlights");
  expect(host.querySelector('[data-setting-id="move-highlight-color"]')).not.toBeNull();
  expect(host.querySelector('[data-setting-id="move-highlight-opacity"]')).not.toBeNull();
  expect(
    host.querySelector('[data-search-group="Settings.Board · Settings.Group.Highlights"]'),
  ).not.toBeNull();

  await searchSettings(host, "");
  expect(host.querySelector('[data-setting-id="move-highlight-color"]')).toBeNull();
  expect(host.querySelector('[data-setting-id="move-highlight-opacity"]')).toBeNull();
  expect(atoms.get(moveHighlightAtom)).toBe(false);
});

test("navigation to a hidden highlight dependent reveals and scrolls to it", async () => {
  const atoms = createStore();
  atoms.set(moveHighlightAtom, false);
  requestSettingsNavigation({ kind: "setting", settingId: "move-highlight-color" }, atoms);
  const { host } = await renderSettingsPage(atoms);

  const row = host.querySelector<HTMLElement>('[data-setting-id="move-highlight-color"]')!;
  expect(row).toBeTruthy();
  expect(row.getAttribute("data-highlighted")).toBe("true");
  expect(row.getAttribute("data-dependent")).toBe("true");
  expect(
    host
      .querySelector('[role="tab"][aria-selected="true"]')
      ?.getAttribute("data-settings-category"),
  ).toBe("board");
  expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  expect(atoms.get(moveHighlightAtom)).toBe(false);
});

function panelFor(host: HTMLElement, category: string) {
  const tab = settingsTab(host, category);
  return host.querySelector<HTMLElement>(`#${tab.getAttribute("aria-controls")}`)!;
}

function sectionIds(host: HTMLElement, category: string) {
  return [...panelFor(host, category).querySelectorAll("[data-settings-section]")].map((node) =>
    node.getAttribute("data-settings-section"),
  );
}

test("the page renders Chess and App sidebar groups and titled section cards", async () => {
  const { host } = await renderSettingsPage();
  expect(
    [...host.querySelectorAll("[data-settings-group]")].map((node) =>
      node.getAttribute("data-settings-group"),
    ),
  ).toEqual(["chess", "app"]);
  expect(host.querySelector('[data-settings-group="chess"]')?.textContent).toBe(
    "Settings.Group.Chess",
  );
  expect(host.querySelector('[data-settings-group="app"]')?.textContent).toBe("Settings.Group.App");

  expect(sectionIds(host, "board")).toEqual([
    "look",
    "highlights",
    "movingPieces",
    "arrowsDrawing",
  ]);
  expect(
    panelFor(host, "board").querySelector('[data-settings-section="look"]')?.textContent,
  ).toContain("Settings.Group.Look");
  expect(
    panelFor(host, "board").querySelector('[data-settings-section="highlights"]')?.textContent,
  ).toContain("Settings.Group.Highlights");
  expect(
    panelFor(host, "board").querySelector('[data-settings-section="movingPieces"]')?.textContent,
  ).toContain("Settings.Group.MovingPieces");
  expect(
    panelFor(host, "board").querySelector('[data-settings-section="arrowsDrawing"]')?.textContent,
  ).toContain("Settings.Group.ArrowsDrawing");

  expect(sectionIds(host, "analysis")).toEqual(["notation", "navigating", "layoutSaving"]);
  expect(
    panelFor(host, "analysis").querySelector('[data-settings-section="notation"]')?.textContent,
  ).toContain("Settings.Group.Notation");
  expect(
    panelFor(host, "analysis").querySelector('[data-settings-section="navigating"]')?.textContent,
  ).toContain("Settings.Group.Navigating");
  expect(
    panelFor(host, "analysis").querySelector('[data-settings-section="layoutSaving"]')?.textContent,
  ).toContain("Settings.Group.LayoutSaving");

  expect(sectionIds(host, "keybinds")).toEqual([
    "tabsFiles",
    "navigation",
    "editing",
    "annotations",
    "engine",
    "panels",
    "drawing",
  ]);
  expect(
    panelFor(host, "keybinds").querySelector('[data-settings-section="tabsFiles"]')?.textContent,
  ).toContain("Settings.Keybinds.Group.TabsFiles");
  expect(
    panelFor(host, "keybinds").querySelector('[data-settings-section="navigation"]')?.textContent,
  ).toContain("Settings.Keybinds.Group.Navigation");
  expect(
    panelFor(host, "keybinds").querySelector('[data-settings-section="editing"]')?.textContent,
  ).toContain("Settings.Keybinds.Group.Editing");
  expect(
    panelFor(host, "keybinds").querySelector('[data-settings-section="annotations"]')?.textContent,
  ).toContain("Settings.Keybinds.Group.Annotations");
  expect(
    panelFor(host, "keybinds").querySelector('[data-settings-section="engine"]')?.textContent,
  ).toContain("Settings.Keybinds.Group.Engine");
  expect(
    panelFor(host, "keybinds").querySelector('[data-settings-section="panels"]')?.textContent,
  ).toContain("Settings.Keybinds.Group.Panels");
  expect(
    panelFor(host, "keybinds").querySelector('[data-settings-section="drawing"]')?.textContent,
  ).toContain("Settings.Drawing");

  const keybindsPanel = panelFor(host, "keybinds");
  const tabsFilesTable = keybindsPanel.querySelector('[data-settings-section="tabsFiles"] table');
  const drawingTable = keybindsPanel.querySelector('[data-settings-section="drawing"] table');
  expect(tabsFilesTable?.className).toContain(classes.keybindTable);
  expect(drawingTable?.className).toContain(classes.keybindTable);
  expect(tabsFilesTable?.querySelector("thead")?.className).toContain(VisuallyHidden.classes.root);
  expect(drawingTable?.querySelector("thead")?.className).not.toContain(
    VisuallyHidden.classes.root,
  );
});

test("compact Shortcuts stack each action above its key instead of a two-column table", async () => {
  layout.compact = true;
  const { host } = await renderSettingsPage();
  expect(host.querySelector("[data-compact]")).not.toBeNull();
  await act(async () => settingsTab(host, "keybinds").click());
  const panel = panelFor(host, "keybinds");
  expect(panel.querySelector('[data-settings-section="tabsFiles"] table')).toBeNull();
  expect(panel.querySelector('[data-settings-section="drawing"] table')).not.toBeNull();
  expect(sectionIds(host, "keybinds")).toEqual([
    "tabsFiles",
    "navigation",
    "editing",
    "annotations",
    "engine",
    "panels",
    "drawing",
  ]);
  expect(panel.textContent).toContain("Settings.Keybinds.Actions.NEW_TAB");
});

test("Reset layout in Analysis / Layout & Saving restores all three kinds to their presets and keeps saved layouts without touching windowsState or tab selection", async () => {
  const { ANALYSIS_BOARD_LAYOUTS_KEY, BOARD_LAYOUTS_VERSION, boardLayoutsAtom, WINDOWS_STATE_KEY } =
    await import("@/state/layoutStorage");
  const { defaultBoardArrangement, engineAreaId } = await import("@/state/boardArrangement");
  const { defaultKindLayouts } = await import("@/state/layoutPresets");
  const { tabFamily } = await import("@/state/atoms");

  const customWindows = JSON.stringify({ currentNode: "left" });
  const customArrangement = {
    direction: "row" as const,
    first: { direction: "column" as const, first: "left" as const, second: engineAreaId("eng-1") },
    second: {
      direction: "row" as const,
      first: "bottomRight" as const,
      second: "topRight" as const,
    },
  };
  const savedEntry = {
    id: "saved-1",
    name: "My Study",
    arrangement: defaultBoardArrangement(),
    tabsHidden: true,
  };
  const initialLayouts = {
    version: BOARD_LAYOUTS_VERSION,
    kinds: {
      repertoire: { arrangement: customArrangement, tabsHidden: true },
      game: { arrangement: customArrangement, tabsHidden: true },
      preparation: { arrangement: customArrangement, tabsHidden: true },
    },
    saved: [savedEntry],
  };
  localStorage.setItem(ANALYSIS_BOARD_LAYOUTS_KEY, JSON.stringify(initialLayouts));
  localStorage.setItem(WINDOWS_STATE_KEY, customWindows);

  const { host, atoms } = await renderSettingsPage();
  atoms.set(boardLayoutsAtom, initialLayouts);
  atoms.set(tabFamily("tab-1"), "database");

  await act(async () => settingsTab(host, "analysis").click());
  const section = panelFor(host, "analysis").querySelector(
    '[data-settings-section="layoutSaving"]',
  )!;
  const row = section.querySelector('[data-setting-id="board-layout"]')!;
  expect(row).not.toBeNull();
  const resetButton = [...row.querySelectorAll<HTMLButtonElement>("button")].find(
    (btn) => btn.textContent === "Settings.BoardLayout.Reset",
  )!;
  expect(resetButton).not.toBeUndefined();

  await act(async () => resetButton.click());

  expect(JSON.parse(localStorage.getItem(ANALYSIS_BOARD_LAYOUTS_KEY)!)).toEqual({
    version: BOARD_LAYOUTS_VERSION,
    kinds: defaultKindLayouts(),
    saved: [savedEntry],
  });
  expect(localStorage.getItem(WINDOWS_STATE_KEY)).toBe(customWindows);
  expect(atoms.get(tabFamily("tab-1"))).toBe("database");
});

async function openDirectoryRows(atoms = createStore()) {
  directoryRows.current = [];
  const rendered = await renderSettingsPage(atoms);
  await act(async () => settingsTab(rendered.host, "directories").click());
  const rows = directoryRows.current.slice(-4);
  expect(rows).toHaveLength(4);
  return { ...rendered, rows };
}

test("Files & folders PGN picker issues the current handle and show-in-folder opens each workspace", async () => {
  const workspace = { id: { id: "pgn-workspace" }, kind: "fileWorkspace" as const };
  localStorage.setItem("file-workspace", JSON.stringify(workspace));
  tauriMocks.issueFileWorkspace.mockResolvedValue({ handle: workspace, displayName: "MyPGN" });
  const atoms = createStore();
  atoms.set(fileWorkspaceAtom, workspace);
  const { rows } = await openDirectoryRows(atoms);
  await rows[0]?.issue();
  expect(tauriMocks.issueFileWorkspace).toHaveBeenCalledWith(workspace);
  await rows[0]?.onShowInFolder?.();
  expect(tauriMocks.openFileWorkspace).toHaveBeenCalledWith(workspace);
  await rows[1]?.onShowInFolder?.();
  expect(tauriMocks.openDatabaseWorkspace).toHaveBeenCalledOnce();
  await rows[2]?.onShowInFolder?.();
  expect(tauriMocks.openEngineWorkspace).toHaveBeenCalledOnce();
  await rows[3]?.onShowInFolder?.();
  expect(tauriMocks.openPuzzleWorkspace).toHaveBeenCalledOnce();
});

test("Files & folders errors notify with the row's root-failure domain", async () => {
  const { rows } = await openDirectoryRows();
  const error = {
    tag: "backend-error",
    category: "io",
    message: "native diagnostic",
    rootFailure: "missing",
  };
  rows[0]?.onError(error);
  expect(actionMocks.notifyUnlessCancelled).toHaveBeenLastCalledWith(
    "Common.Error",
    error,
    "files",
  );
  rows[1]?.onError(error);
  expect(actionMocks.notifyUnlessCancelled).toHaveBeenLastCalledWith(
    "Common.Error",
    error,
    "database",
  );
  rows[2]?.onError(error);
  expect(actionMocks.notifyUnlessCancelled).toHaveBeenLastCalledWith(
    "Common.Error",
    error,
    "engine",
  );
  rows[3]?.onError(error);
  expect(actionMocks.notifyUnlessCancelled).toHaveBeenLastCalledWith(
    "Common.Error",
    error,
    "puzzle",
  );
});

test("PGN load uses the stored file workspace and reports load errors only on that row", async () => {
  const workspace = { id: { id: "pgn-workspace" }, kind: "fileWorkspace" as const };
  tauriMocks.getFileFolderStatus.mockResolvedValue({ displayName: "MyPGN", isDefault: false });
  const atoms = createStore();
  atoms.set(fileWorkspaceAtom, workspace);
  const { rows } = await openDirectoryRows(atoms);
  expect(rows[0]?.reportLoadError).toBe(true);
  expect(rows[1]?.reportLoadError).toBeFalsy();
  expect(rows[2]?.reportLoadError).toBeFalsy();
  expect(rows[3]?.reportLoadError).toBeFalsy();
  await expect(rows[0]?.load()).resolves.toEqual({ displayName: "MyPGN", isDefault: false });
  expect(tauriMocks.getFileFolderStatus).toHaveBeenCalledExactlyOnceWith(workspace);
  expect(tauriMocks.getDefaultFileWorkspace).not.toHaveBeenCalled();
  expect(atoms.get(fileWorkspaceAtom)).toEqual(workspace);
});

test("PGN load seeds through ensureFileWorkspace only when the handle is null", async () => {
  const handle = { id: { id: "default-pgn" }, kind: "fileWorkspace" as const };
  tauriMocks.getDefaultFileWorkspace.mockResolvedValue({
    handle,
    displayName: "PGN",
  });
  tauriMocks.getFileFolderStatus.mockResolvedValue({ displayName: "PGN", isDefault: true });
  const status = await loadPgnDirectoryStatus(null);
  expect(status).toEqual({ displayName: "PGN", isDefault: true });
  expect(tauriMocks.getDefaultFileWorkspace).toHaveBeenCalledOnce();
  expect(tauriMocks.getFileFolderStatus).toHaveBeenCalledExactlyOnceWith(handle);
  expect(getDefaultStore().get(fileWorkspaceAtom)).toEqual(handle);
  expect(getDefaultStore().get(fileWorkspaceDisplayNameAtom)).toBe("PGN");
});

test("Import then Settings PGN seed keep one file-workspace handle", async () => {
  const handle = { id: { id: "default-pgn" }, kind: "fileWorkspace" as const };
  tauriMocks.getDefaultFileWorkspace.mockResolvedValue({
    handle,
    displayName: "PGN",
  });
  tauriMocks.getFileFolderStatus.mockResolvedValue({ displayName: "PGN", isDefault: true });
  const imported = await ensureFileWorkspace();
  const { rows } = await openDirectoryRows();
  await expect(rows[0]?.load()).resolves.toEqual({ displayName: "PGN", isDefault: true });
  expect(imported).toEqual(handle);
  expect(tauriMocks.getDefaultFileWorkspace).toHaveBeenCalledOnce();
  expect(tauriMocks.getFileFolderStatus).toHaveBeenCalledExactlyOnceWith(handle);
  expect(getDefaultStore().get(fileWorkspaceAtom)).toEqual(handle);
});

test("Files & folders rows trigger real database, engine, and puzzle refresh signals on switch", async () => {
  publishDatabaseListMock.mockClear();
  swrMutateMock.mockClear();
  platformMock.mockReturnValue("windows");
  const atoms = createStore();
  atoms.set(puzzleWorkspaceGenerationAtom, 0);
  const { rows } = await openDirectoryRows(atoms);

  // Databases row uses publishDatabaseList (works without a mounted reader)
  rows[1]?.onSelected?.("MovedDatabases");
  expect(publishDatabaseListMock).toHaveBeenCalledWith(swrMutateMock);

  // Engines row revalidates file-exists, engine-config, and the real Platform OS key ("windows", not "win32")
  rows[2]?.onSelected?.("MovedEngines");
  expect(swrMutateMock).not.toHaveBeenCalledWith("default_engines");
  expect(swrMutateMock).not.toHaveBeenCalledWith("win32", undefined, { revalidate: true });
  expect(swrMutateMock).toHaveBeenCalledWith("windows", undefined, { revalidate: true });
  const predicates = swrMutateMock.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is (key: unknown) => boolean => typeof arg === "function");
  expect(predicates.some((fn) => fn(["file-exists", "eng-1"]))).toBe(true);
  expect(predicates.some((fn) => fn(["engine-config", "eng-1"]))).toBe(true);

  // Puzzles row bumps puzzleWorkspaceGenerationAtom
  rows[3]?.onSelected?.("MovedPuzzles");
  expect(atoms.get(puzzleWorkspaceGenerationAtom)).toBe(1);
});

test("SettingsPage Databases, Engines, and Puzzles rows handle Pending + Cancel and keep persisted engines byte-identical", async () => {
  const { getPendingFolderSwitch, setPendingFolderSwitch } = await import("./folderSwitch");
  const initialEngines = JSON.stringify([
    {
      type: "local",
      name: "Stockfish",
      version: "17",
      path: { id: { id: "ref-1" }, kind: "engine" },
      loaded: true,
      settings: [],
    },
  ]);
  localStorage.setItem("engines", initialEngines);

  tauriMocks.issueDatabaseWorkspace.mockResolvedValueOnce({
    status: "pending",
    grant: { id: { id: "gd1" }, kind: "database" },
    displayName: "NewDBs",
    itemCount: 1,
  });
  tauriMocks.issueEngineWorkspace.mockResolvedValueOnce({
    status: "pending",
    grant: { id: { id: "ge1" }, kind: "engine" },
    displayName: "NewEngs",
    itemCount: 1,
  });
  tauriMocks.restorePuzzleWorkspace.mockResolvedValueOnce({
    status: "pending",
    grant: { id: { id: "gp1" }, kind: "puzzle" },
    displayName: "Puzzles",
    itemCount: 2,
  });

  const { rows } = await openDirectoryRows();

  // Databases Pending -> Cancel resolves null
  const dbPending = rows[1]?.issue();
  await act(async () => {});
  getPendingFolderSwitch()?.resolve(null);
  setPendingFolderSwitch(null);
  await expect(dbPending).resolves.toBeNull();

  // Engines Pending -> Move resolves status and keeps localStorage["engines"] byte-identical
  const engPending = rows[2]?.issue();
  await act(async () => {});
  getPendingFolderSwitch()?.resolve({ displayName: "NewEngs", isDefault: false });
  setPendingFolderSwitch(null);
  await expect(engPending).resolves.toEqual({ displayName: "NewEngs", isDefault: false });
  rows[2]?.onSelected?.("NewEngs");
  expect(localStorage.getItem("engines")).toBe(initialEngines);

  // Puzzles restoreDefault Pending -> Cancel resolves null
  const puzPending = rows[3]?.restoreDefault?.();
  await act(async () => {});
  getPendingFolderSwitch()?.resolve(null);
  setPendingFolderSwitch(null);
  await expect(puzPending).resolves.toBeNull();
});

test("fail-open URL search handles category=sound, unknown category, hidden coach, and numeric q=123 without ErrorComponent", async () => {
  // category=sound renders Sound.
  {
    const { host } = await renderSettingsPage(createStore(), "/settings?category=sound");
    expect(host.querySelector('[data-testid="settings-error-component"]')).toBeNull();
    expect(
      host
        .querySelector('[role="tab"][aria-selected="true"]')
        ?.getAttribute("data-settings-category"),
    ).toBe("sound");
    await act(async () => root!.unmount());
    host.remove();
    root = undefined;
  }

  // Unknown category renders Board without ErrorComponent.
  {
    const { host } = await renderSettingsPage(createStore(), "/settings?category=nonexistent");
    expect(host.querySelector('[data-testid="settings-error-component"]')).toBeNull();
    expect(
      host
        .querySelector('[role="tab"][aria-selected="true"]')
        ?.getAttribute("data-settings-category"),
    ).toBe("board");
    await act(async () => root!.unmount());
    host.remove();
    root = undefined;
  }

  // Hidden coach category renders Board without rewriting the URL.
  {
    coach.enabled = false;
    const { host, router } = await renderSettingsPage(createStore(), "/settings?category=coach");
    expect(host.querySelector('[data-testid="settings-error-component"]')).toBeNull();
    expect(
      host
        .querySelector('[role="tab"][aria-selected="true"]')
        ?.getAttribute("data-settings-category"),
    ).toBe("board");
    expect(router.state.location.href).toBe("/settings?category=coach");
    await act(async () => root!.unmount());
    host.remove();
    root = undefined;
  }

  // Numeric q=123 coerces to string "123" and shows the search view without ErrorComponent.
  {
    const { host } = await renderSettingsPage(createStore(), "/settings?q=123");
    expect(host.querySelector('[data-testid="settings-error-component"]')).toBeNull();
    const input = host.querySelector<HTMLInputElement>('input[placeholder="Common.Search"]')!;
    expect(input.value).toBe("123");
    expect(host.querySelector('[role="tab"]')).toBeNull();
  }
});

test("typing search updates input immediately, writes q with replace, and remount restores search view without touching web storage", async () => {
  const { host, router, history } = await renderSettingsPage();
  const initialLength = history.length;
  const localBefore = Object.entries(localStorage);
  const sessionBefore = Object.entries(sessionStorage);
  const input = host.querySelector<HTMLInputElement>('input[placeholder="Common.Search"]')!;

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "vol");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(input.value).toBe("vol");
  await vi.waitFor(() => expect(router.state.location.href).toBe("/settings?q=vol"));
  expect(history.length).toBe(initialLength);
  expect(Object.entries(localStorage)).toEqual(localBefore);
  expect(Object.entries(sessionStorage)).toEqual(sessionBefore);

  const savedHref = router.state.location.href;
  await act(async () => root!.unmount());
  host.remove();
  root = undefined;

  const { host: remountHost } = await renderSettingsPage(createStore(), savedHref);
  expect(
    remountHost.querySelector<HTMLInputElement>('input[placeholder="Common.Search"]')?.value,
  ).toBe("vol");
  expect(remountHost.querySelector('[data-setting-id="volume"]')).not.toBeNull();
  expect(remountHost.querySelector('[role="tab"]')).toBeNull();
});

test("a live request overrides a restored URL while a hidden coach request preserves it", async () => {
  // Live volume request overrides /settings?category=general&q=font.
  {
    const atoms = createStore();
    requestSettingsNavigation({ kind: "setting", settingId: "volume" }, atoms);
    const { host, router } = await renderSettingsPage(atoms, "/settings?category=general&q=font");
    expect(
      host
        .querySelector('[role="tab"][aria-selected="true"]')
        ?.getAttribute("data-settings-category"),
    ).toBe("sound");
    expect(host.querySelector<HTMLInputElement>('input[placeholder="Common.Search"]')?.value).toBe(
      "",
    );
    expect(host.querySelector('[data-setting-id="volume"]')?.getAttribute("data-highlighted")).toBe(
      "true",
    );
    expect(router.state.location.href).toBe("/settings?category=sound");
    await act(async () => root!.unmount());
    host.remove();
    root = undefined;
  }

  // Hidden coach request preserves /settings?category=general&q=font.
  {
    coach.enabled = false;
    const atoms = createStore();
    requestSettingsNavigation({ kind: "category", category: "coach" }, atoms);
    const { host, router } = await renderSettingsPage(atoms, "/settings?category=general&q=font");
    expect(atoms.get(settingsNavigationRequestAtom)).toBeNull();
    expect(host.querySelector<HTMLInputElement>('input[placeholder="Common.Search"]')?.value).toBe(
      "font",
    );
    expect(router.state.location.href).toBe("/settings?category=general&q=font");
  }
});

test("remount restores saved scroll for category and search viewports; category switch does not leak scrollTop; close clear blocks late writes", async () => {
  const { host, router } = await renderSettingsPage();
  const localBefore = Object.entries(localStorage);
  const sessionBefore = Object.entries(sessionStorage);
  const categoryViewport = host.querySelector<HTMLDivElement>(".mantine-ScrollArea-viewport")!;
  expect(categoryViewport).not.toBeNull();

  // Scroll Board to 260.
  categoryViewport.scrollTop = 260;
  await act(async () => {
    categoryViewport.dispatchEvent(new Event("scroll"));
  });
  expect(readSettingsScroll({ mode: "category", category: "board" })).toBe(260);
  expect(Object.entries(localStorage)).toEqual(localBefore);
  expect(Object.entries(sessionStorage)).toEqual(sessionBefore);

  // Switch to Sound: Sound restores 0 and does not record Board's leaked 260.
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[role="tab"][data-settings-category="sound"]')!.click();
  });
  await vi.waitFor(() => expect(router.state.location.href).toBe("/settings?category=sound"));
  expect(categoryViewport.scrollTop).toBe(0);
  expect(readSettingsScroll({ mode: "category", category: "sound" })).toBeUndefined();
  expect(readSettingsScroll({ mode: "category", category: "board" })).toBe(260);

  // Scroll Sound to 140, unmount, remount at /settings?category=sound -> restores 140.
  categoryViewport.scrollTop = 140;
  await act(async () => {
    categoryViewport.dispatchEvent(new Event("scroll"));
  });
  await act(async () => root!.unmount());
  host.remove();
  root = undefined;

  const { host: soundRemount } = await renderSettingsPage(
    createStore(),
    "/settings?category=sound",
  );
  const remountCatViewport = soundRemount.querySelector<HTMLDivElement>(
    ".mantine-ScrollArea-viewport",
  )!;
  expect(remountCatViewport.scrollTop).toBe(140);

  // Search view scroll restore: scroll search viewport to 95, unmount, remount at /settings?q=font.
  const searchInput = soundRemount.querySelector<HTMLInputElement>(
    'input[placeholder="Common.Search"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      searchInput,
      "font",
    );
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const searchViewport = soundRemount.querySelector<HTMLDivElement>(
    ".mantine-ScrollArea-viewport",
  )!;
  searchViewport.scrollTop = 95;
  await act(async () => {
    searchViewport.dispatchEvent(new Event("scroll"));
  });
  await act(async () => root!.unmount());
  soundRemount.remove();
  root = undefined;

  const { host: searchRemount } = await renderSettingsPage(createStore(), "/settings?q=font");
  const remountSearchViewport = searchRemount.querySelector<HTMLDivElement>(
    ".mantine-ScrollArea-viewport",
  )!;
  expect(remountSearchViewport.scrollTop).toBe(95);

  // Simulate closePageTab("settings") clearing scroll & bumping generation while still mounted:
  // a late scroll event + unmount must NOT rewrite scroll, and later Board starts at 0.
  clearSettingsScroll();
  remountSearchViewport.scrollTop = 333;
  await act(async () => {
    remountSearchViewport.dispatchEvent(new Event("scroll"));
  });
  await act(async () => root!.unmount());
  searchRemount.remove();
  root = undefined;
  expect(readSettingsScroll({ mode: "search", q: "font" })).toBeUndefined();
  expect(readSettingsScroll({ mode: "category", category: "board" })).toBeUndefined();

  const { host: freshBoard } = await renderSettingsPage(createStore(), "/settings");
  expect(freshBoard.querySelector<HTMLDivElement>(".mantine-ScrollArea-viewport")!.scrollTop).toBe(
    0,
  );
});

test("live navigation request does not restore saved scroll and successful scrollIntoView is not reset to 0", async () => {
  // Seed saved scroll for sound = 280.
  const { host: firstHost } = await renderSettingsPage(createStore(), "/settings?category=sound");
  const firstViewport = firstHost.querySelector<HTMLDivElement>(".mantine-ScrollArea-viewport")!;
  firstViewport.scrollTop = 280;
  await act(async () => {
    firstViewport.dispatchEvent(new Event("scroll"));
  });
  await act(async () => root!.unmount());
  firstHost.remove();
  root = undefined;

  // Mount with a live volume request: saved 280 must NOT be applied, and viewport stays where scrollIntoView put it.
  const scrollIntoViewMock = vi.fn(function (this: HTMLElement) {
    const viewport = this.closest<HTMLDivElement>(".mantine-ScrollArea-viewport");
    if (viewport) viewport.scrollTop = 412;
  });
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoViewMock,
  });
  const originalScrollTo = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTo");
  const scrollToMock = vi.fn();
  Object.defineProperty(Element.prototype, "scrollTo", {
    configurable: true,
    value: scrollToMock,
  });

  try {
    const atoms = createStore();
    requestSettingsNavigation({ kind: "setting", settingId: "volume" }, atoms);
    const { host: secondHost } = await renderSettingsPage(atoms, "/settings?category=sound");
    expect(scrollToMock).not.toHaveBeenCalledWith(expect.objectContaining({ top: 280 }));
    expect(scrollIntoViewMock).toHaveBeenCalledOnce();
    expect(
      secondHost.querySelector<HTMLDivElement>(".mantine-ScrollArea-viewport")!.scrollTop,
    ).toBe(412);
  } finally {
    if (originalScrollTo) Object.defineProperty(Element.prototype, "scrollTo", originalScrollTo);
    else Reflect.deleteProperty(Element.prototype, "scrollTo");
  }
});

test("missing scrollTo fails open, and unresolvable pendingScroll clears only once the target category is on screen", async () => {
  // Missing scrollTo fails open on restore without throwing.
  const originalScrollTo = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTo");
  Object.defineProperty(Element.prototype, "scrollTo", {
    configurable: true,
    value: undefined,
  });
  try {
    const { host } = await renderSettingsPage(createStore(), "/settings");
    expect(host.querySelector('[role="tab"][aria-selected="true"]')).not.toBeNull();
    await act(async () => root!.unmount());
    host.remove();
    root = undefined;
  } finally {
    if (originalScrollTo) Object.defineProperty(Element.prototype, "scrollTo", originalScrollTo);
    else Reflect.deleteProperty(Element.prototype, "scrollTo");
  }

  // Target category on screen, row missing -> clears pendingScroll and sets viewport to 0.
  const atoms = createStore();
  const { host: mountedHost, router } = await renderSettingsPage(atoms, "/settings?category=sound");
  const viewport = mountedHost.querySelector<HTMLDivElement>(".mantine-ScrollArea-viewport")!;
  viewport.scrollTop = 190;
  const volumeRow = mountedHost.querySelector<HTMLElement>('[data-setting-id="volume"]')!;
  // Hide the row attribute to simulate an unresolvable row on the target category.
  volumeRow.removeAttribute("data-setting-id");
  await act(async () => {
    requestSettingsNavigation({ kind: "setting", settingId: "volume" }, atoms);
  });
  expect(viewport.scrollTop).toBe(0);
  // Restore attribute and switch away/back: pendingScroll was cleared, so scrollIntoView does not fire later.
  volumeRow.setAttribute("data-setting-id", "volume");
  const scrollSpy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
  scrollSpy.mockClear();
  await act(async () => {
    await router.navigate({ to: "/settings", search: { category: "general" } });
  });
  await act(async () => {
    await router.navigate({ to: "/settings", search: { category: "sound" } });
  });
  expect(scrollSpy).not.toHaveBeenCalled();

  // Row missing before the category URL commits does NOT clear pendingScroll prematurely:
  // starting from Board, requesting volume waits for category=sound to commit and then scrolls volume into view.
  await act(async () => {
    await router.navigate({ to: "/settings", search: {} });
  });
  const categoriesAtScroll: Array<string | null> = [];
  scrollSpy.mockClear();
  scrollSpy.mockImplementation(() => {
    categoriesAtScroll.push(
      mountedHost
        .querySelector('[role="tab"][aria-selected="true"]')
        ?.getAttribute("data-settings-category") ?? null,
    );
  });
  await act(async () => {
    requestSettingsNavigation({ kind: "setting", settingId: "volume" }, atoms);
  });
  await vi.waitFor(() => expect(router.state.location.href).toBe("/settings?category=sound"));
  expect(scrollSpy).toHaveBeenCalledOnce();
  expect(categoriesAtScroll).toEqual(["sound"]);
});

test("mounted URL navigation syncs search input and rapid a -> empty -> b typing preserves the draft", async () => {
  const { host, router } = await renderSettingsPage();
  const input = host.querySelector<HTMLInputElement>('input[placeholder="Common.Search"]')!;
  expect(input.value).toBe("");
  expect(host.querySelector('[role="tablist"]')).not.toBeNull();

  // Mounted URL navigation (no remount) syncs the search input and shows the search view.
  await act(async () => {
    await router.navigate({ to: "/settings", search: { q: "font" } });
  });
  expect(input.value).toBe("font");
  expect(host.querySelector('[role="tab"]')).toBeNull();
  expect(host.querySelector('[data-setting-id="font-size"]')).not.toBeNull();

  // Reset to /settings so prevUrlQueryRef is "".
  await act(async () => {
    await router.navigate({ to: "/settings", search: {} });
  });
  expect(input.value).toBe("");

  // Rapid a -> "" -> b while earlier navigations are still in flight: each navigation commits in order
  // and the intermediate "" commit must not wipe the "b" draft.
  const originalNavigate = router.navigate.bind(router);
  const queuedNavigations: Array<() => Promise<void>> = [];
  const navigateSpy = vi.spyOn(router, "navigate").mockImplementation(((options: never) => {
    const step = deferred<void>();
    queuedNavigations.push(async () => {
      await originalNavigate(options);
      step.resolve();
    });
    return step.promise;
  }) as typeof router.navigate);

  try {
    const typeQuery = (query: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };

    await act(async () => {
      typeQuery("a");
    });
    await act(async () => {
      typeQuery("");
    });
    await act(async () => {
      typeQuery("b");
    });
    expect(input.value).toBe("b");
    expect(queuedNavigations).toHaveLength(3);

    for (const commit of queuedNavigations) {
      await act(async () => {
        await commit();
      });
      expect(input.value).toBe("b");
    }

    expect(router.state.location.href).toBe("/settings?q=b");
    expect(input.value).toBe("b");
  } finally {
    navigateSpy.mockRestore();
  }
});

test("same-category navigation request resets viewport scrollTop to 0 and Escape clears search and URL q", async () => {
  const { atoms, host, router } = await renderSettingsPage();
  const viewport = host.querySelector<HTMLDivElement>(".mantine-ScrollArea-viewport")!;
  viewport.scrollTop = 190;
  await act(async () => {
    viewport.dispatchEvent(new Event("scroll"));
  });
  expect(readSettingsScroll({ mode: "category", category: "board" })).toBe(190);

  await act(async () => {
    requestSettingsNavigation({ kind: "category", category: "board" }, atoms);
  });
  expect(viewport.scrollTop).toBe(0);
  expect(readSettingsScroll({ mode: "category", category: "board" })).toBeUndefined();

  await searchSettings(host, "font");
  await vi.waitFor(() => expect(router.state.location.href).toBe("/settings?q=font"));
  const input = host.querySelector<HTMLInputElement>('input[placeholder="Common.Search"]')!;
  expect(input.value).toBe("font");

  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(input.value).toBe("");
  await vi.waitFor(() => expect(router.state.location.href).toBe("/settings"));
});
