import { MantineProvider } from "@mantine/core";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  defaultPanelTabAtom,
  materialDisplayAtom,
  practiceGradingAtom,
  practiceNewPerSessionAtom,
} from "@/state/atoms";
import {
  requestSettingsNavigation,
  settingsNavigationRequestAtom,
} from "@/state/settingsNavigation";
import { catalogueI18n } from "@/tests/catalogues";
import { installInlineComputedStyleStub } from "@/tests/computedStyle";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { describeSettings } from "./settingsDescription";
import Page from "./SettingsPage";

vi.mock("@/platform/native", () => ({
  platform: vi.fn(() => "linux"),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useLoaderData: () => ({ version: "test" }),
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
vi.mock("./KeybindInput", () => ({ default: () => null, KbdDisplay: () => null }));
vi.mock("./PercentagePreferenceSlider", () => ({ default: () => null }));
vi.mock("./PiecesSelect", () => ({ default: () => null }));
vi.mock("./RepertoireMinGamesSetting", () => ({ default: () => null }));
vi.mock("./DirectorySetting", () => ({ DirectorySetting: () => null }));
vi.mock("./WorkspaceDirectorySetting", () => ({ WorkspaceDirectorySetting: () => null }));
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
vi.mock("./SettingsSwitch", () => ({ default: () => null }));
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
  translation.t = translation.identity;
  coach.enabled = false;
  actionMocks.reloadApp.mockReset();
  actionMocks.clearSavedData.mockReset();
  actionMocks.openAppLogs.mockReset();
  actionMocks.notifyUnlessCancelled.mockReset();
  actionMocks.notificationsShow.mockReset();
  root = undefined;
  if (originalScroll) Object.defineProperty(Element.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

async function renderSettingsPage(atoms = createStore()) {
  const container = document.createElement("div");
  host = container;
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <Provider store={atoms}>
        <MantineProvider env="test">
          <Page />
        </MantineProvider>
      </Provider>,
    ),
  );
  return { atoms, host: container };
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
  const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (node) => node.textContent === "Settings.Repertoire",
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
  const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (node) => node.textContent === "Tastenkombinationen",
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

async function openAdvanced(host: HTMLElement) {
  const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (node) => node.textContent === "Settings.Advanced",
  )!;
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
  const tabs = [...host.querySelectorAll('[role="tab"]')].map((node) => node.textContent);
  expect(tabs).toHaveLength(8);
  expect(tabs.at(-1)).toBe("Settings.Advanced");
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
    const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (node) => node.textContent === "Settings.Keybinds",
    )!;
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

test("a build with the Coach adds its category before Advanced, with connections and the engine row", async () => {
  coach.enabled = true;
  const { host } = await renderSettingsPage();
  const tabs = [...host.querySelectorAll('[role="tab"]')].map((node) => node.textContent);
  expect(tabs).toHaveLength(9);
  expect(tabs.slice(-2)).toEqual(["Settings.AI", "Settings.Advanced"]);
  const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (node) => node.textContent === "Settings.AI",
  )!;
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

test("settings search finds the three Advanced rows", async () => {
  const { host } = await renderSettingsPage();
  await searchSettings(host, "advanced");
  expect(host.textContent).toContain("Menu.View.Reload");
  expect(host.textContent).toContain("Menu.Help.ClearSavedData");
  expect(host.textContent).toContain("Menu.Help.OpenLogs");
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
  expect(activeTab?.textContent).toBe("Settings.Sound");

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
  expect(activeTab?.textContent).toBe("Settings.Directories");
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

  const appearanceTab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (node) => node.textContent === "Settings.Appearance",
  )!;
  await act(async () => appearanceTab.click());

  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
    "Settings.Appearance",
  );
  expect(host.querySelectorAll("[data-highlighted]")).toHaveLength(0);
});

test("a consumed request does not act again on remount", async () => {
  const atoms = createStore();
  requestSettingsNavigation({ kind: "setting", settingId: "volume" }, atoms);
  const { host: firstHost } = await renderSettingsPage(atoms);

  expect(firstHost.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
    "Settings.Sound",
  );
  expect(
    firstHost.querySelector('[data-setting-id="volume"]')?.getAttribute("data-highlighted"),
  ).toBe("true");
  expect(atoms.get(settingsNavigationRequestAtom)).toBeNull();

  await act(async () => root!.unmount());
  firstHost.remove();
  root = undefined;

  const scrollSpy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
  scrollSpy.mockClear();

  const { host: secondHost } = await renderSettingsPage(atoms);
  expect(secondHost.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
    "Settings.Board",
  );
  expect(secondHost.querySelectorAll("[data-highlighted]")).toHaveLength(0);
  expect(scrollSpy).not.toHaveBeenCalled();
});

test("a newer request replaces an unconsumed one before Settings mounts", async () => {
  const atoms = createStore();
  requestSettingsNavigation({ kind: "setting", settingId: "volume" }, atoms);
  requestSettingsNavigation({ kind: "setting", settingId: "font-size" }, atoms);

  const { host } = await renderSettingsPage(atoms);
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
    "Settings.Appearance",
  );
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
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
    "Settings.Board",
  );
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
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
    "Settings.Sound",
  );
  expect(host.querySelector('[data-setting-id="volume"]')?.getAttribute("data-highlighted")).toBe(
    "true",
  );
});
