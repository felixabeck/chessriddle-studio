import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { createStore, Provider } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "@/translation/en-US.json";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import ChessBaseGuide from "./ChessBaseGuide";
import { ChessBaseGuideLink } from "./ChessBaseGuideLink";
import { chessBaseGuideAtom } from "./chessBaseGuideState";

const native = vi.hoisted(() => ({ subscribe: vi.fn(), unlisten: vi.fn() }));
vi.mock("@/platform/tauri", () => ({
  tauriSubscriptions: { chessBaseSelected: native.subscribe },
}));
vi.mock("@/components/files/notifyError", () => ({ notifyUnlessCancelled: vi.fn() }));

let root: Root;
let host: HTMLDivElement;
let store: ReturnType<typeof createStore>;
let onDrop: () => void;

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  installMatchMediaStub();
  installResizeObserverStub();
  native.unlisten.mockClear();
  native.subscribe.mockReset().mockImplementation((callback: () => void) => {
    onDrop = callback;
    return Promise.resolve(native.unlisten);
  });
  store = createStore();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const i18n = createInstance();
  await i18n.init({ lng: "en-US", fallbackLng: false, resources: { "en-US": en } });
  await act(async () =>
    root.render(
      <Provider store={store}>
        <I18nextProvider i18n={i18n}>
          <MantineProvider env="test">
            <ChessBaseGuideLink />
            <ChessBaseGuide />
          </MantineProvider>
        </I18nextProvider>
      </Provider>,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test("link opens the complete guide without the selected-file line", async () => {
  await act(async () => host.querySelector("button")?.click());
  const modal = document.querySelector('[role="dialog"]');
  expect(store.get(chessBaseGuideAtom)).toBe("link");
  expect(modal?.textContent).toContain(en.translation["ChessBaseGuide.Intro"]);
  expect(modal?.textContent).not.toContain(en.translation["ChessBaseGuide.Selected"]);
  expect(modal?.querySelectorAll("ol > li")).toHaveLength(3);
  expect(modal?.querySelectorAll("ul > li")).toHaveLength(3);
  expect(modal?.textContent).toContain(en.translation["Library.AddDatabase"]);
  expect(modal?.textContent).toContain(en.translation["Common.Local"]);
});

test("the root-owned event listener opens selected mode and unsubscribes", async () => {
  expect(native.subscribe).toHaveBeenCalledOnce();
  await act(async () => onDrop());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    en.translation["ChessBaseGuide.Selected"],
  );
  await act(async () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]')?.click(),
  );
  expect(store.get(chessBaseGuideAtom)).toBe("closed");
  // Replace the mounted owner so afterEach can still unmount the root normally.
  await act(async () => root.render(null));
  expect(native.unlisten).toHaveBeenCalledOnce();
  await act(async () => onDrop());
  expect(store.get(chessBaseGuideAtom)).toBe("closed");
});

const catalogues = import.meta.glob<{ translation: Record<string, string> }>(
  "../../translation/*.json",
  { eager: true, import: "default" },
);
const keys = [
  "Title",
  "Selected",
  "Intro",
  "Step1",
  "Step2",
  "Step3",
  "Tips",
  "Tip1",
  "Tip2",
  "Tip3",
];

test("all sixteen catalogues translate the guide with fallback disabled", async () => {
  expect(Object.keys(catalogues)).toHaveLength(16);
  for (const [locale, catalogue] of Object.entries(catalogues)) {
    const i18n = createInstance();
    await i18n.init({ lng: locale, fallbackLng: false, resources: { [locale]: catalogue } });
    for (const key of keys) {
      const literal = `ChessBaseGuide.${key}`;
      expect(i18n.exists(literal)).toBe(true);
      expect(i18n.t(literal).trim()).not.toBe("");
    }
    for (const [key, names] of [
      ["Selected", ["ChessBase", "ChessRiddle Studio"]],
      ["Intro", ["PGN", "ChessBase", "ChessRiddle Studio"]],
      ["Tip2", ["Mega Database", "PGN"]],
    ] as const) {
      for (const name of names) expect(i18n.t(`ChessBaseGuide.${key}`)).toContain(name);
    }
  }
});
