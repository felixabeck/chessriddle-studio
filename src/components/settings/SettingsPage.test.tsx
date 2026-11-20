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
import { catalogueI18n } from "@/tests/catalogues";
import { installInlineComputedStyleStub } from "@/tests/computedStyle";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
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
vi.mock("./SettingsSwitch", () => ({ default: () => null }));
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
  root = undefined;
  if (originalScroll) Object.defineProperty(Element.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

async function renderSettingsPage() {
  const atoms = createStore();
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
