import { MantineProvider } from "@mantine/core";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { practiceGradingAtom, practiceNewPerSessionAtom } from "@/state/atoms";
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
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
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
  root = undefined;
  if (originalScroll) Object.defineProperty(Element.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

test("practice settings expose automatic/manual grading and the session new-move limit", async () => {
  const atoms = createStore();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <Provider store={atoms}>
        <MantineProvider env="test">
          <Page />
        </MantineProvider>
      </Provider>,
    ),
  );
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
