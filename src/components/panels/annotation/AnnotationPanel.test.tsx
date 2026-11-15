import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { ANNOTATION_INFO } from "@/utils/annotation";
import AnnotationPanel from "./AnnotationPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("./AnnotationEditor", () => ({ default: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const catalogues = import.meta.glob<{ translation: Record<string, string> }>(
  "../../../translation/*.json",
  { eager: true, import: "default" },
);

let host: HTMLDivElement;
let root: Root;
let store: TreeStore;

beforeEach(() => {
  installMatchMediaStub();
  installResizeObserverStub();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  store?.dispose();
  host.remove();
  vi.restoreAllMocks();
});

async function mount() {
  store = createTreeStore();
  await act(async () => {
    expect(store.getState().makeMoves({ payload: ["e4"] }).success).toBe(true);
    store.getState().setAnnotation("!?");
    root.render(
      <MantineProvider>
        <TreeStateContext.Provider value={store}>
          <AnnotationPanel />
        </TreeStateContext.Provider>
      </MantineProvider>,
    );
  });
}

function symbolButton(label: string) {
  return host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}

test("the interesting-move symbol reports pressed and toggles off on click", async () => {
  await mount();
  expect(symbolButton("Annotate.Interesting").getAttribute("aria-pressed")).toBe("true");
  expect(symbolButton("Annotate.Good").getAttribute("aria-pressed")).toBe("false");
  await act(async () => symbolButton("Annotate.Interesting").click());
  expect(symbolButton("Annotate.Interesting").getAttribute("aria-pressed")).toBe("false");
});

test("every offered annotation has a catalogue translation", () => {
  const shipped = Object.entries(catalogues).map(([path, { translation }]) => ({
    locale: path.slice(path.lastIndexOf("/") + 1, -".json".length),
    translation,
  }));
  expect(shipped.length).toBeGreaterThan(0);
  for (const [glyph, info] of Object.entries(ANNOTATION_INFO)) {
    if (glyph === "") continue;
    expect({ glyph, translationKey: info.translationKey }).toEqual({
      glyph,
      translationKey: expect.stringMatching(/\S/),
    });
    const key = `Annotate.${info.translationKey}`;
    for (const { locale, translation } of shipped) {
      expect({ locale, key, value: translation[key] }).toEqual({
        locale,
        key,
        value: expect.stringMatching(/\S/),
      });
    }
  }
});
