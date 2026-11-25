import { WorkspaceTabScope } from "@/state/tabScope";
import { parseUci } from "chessops";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import {
  clearAllScoresheetPhotosForTests,
  getScoresheetPhotos,
  setScoresheetPhotos,
} from "@/state/scoresheetPhotos";
import { closeTreeStore, createTreeStore, type TreeStore } from "@/state/store/tree";
import { defaultTree, getNodeAtPath } from "@/utils/treeReducer";
import ScoresheetPhotoPanel, {
  adjacentUnsurePath,
  formatScoresheetRemainingTokens,
} from "./ScoresheetPhotoPanel";

const catalogues = import.meta.glob<{ translation: Record<string, string> }>(
  "../../../translation/*.json",
  { eager: true, import: "default" },
);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (!options) return key;
      const parts = Object.entries(options)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(",");
      return `${key}(${parts})`;
    },
  }),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const Icon = () => null;
  return {
    ...(await importOriginal<typeof import("lucide-react")>()),
    Check: Icon,
    ChevronLeft: Icon,
    ChevronRight: Icon,
    Maximize2: Icon,
    Minimize2: Icon,
  };
});

vi.mock("@/components/common/IconAction", () => ({
  default: ({ children, label, pressed, ...props }: any) => (
    <button type="button" aria-label={label} aria-pressed={pressed} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@mantine/core", () => ({
  Button: ({ children, leftSection, ...props }: any) => (
    <button type="button" {...props}>
      {leftSection}
      {children}
    </button>
  ),
  Group: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  Text: ({ children, ...props }: any) => <div {...props}>{children}</div>,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const PHOTO_1 = "data:image/jpeg;base64,AAAA";
const PHOTO_2 = "data:image/jpeg;base64,BBBB";

let host: HTMLDivElement;
let root: Root;
const createdTabs: string[] = [];

beforeEach(() => {
  clearAllScoresheetPhotosForTests();
  sessionStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  for (const id of createdTabs.splice(0)) closeTreeStore(id);
  clearAllScoresheetPhotosForTests();
  sessionStorage.clear();
});

function buildReviewStore(
  tabId: string,
  options?: {
    moves?: string[];
    unsurePlies?: number[];
    variationUnsure?: boolean;
    stopped?: { ply: number; tokens: string[] };
  },
): TreeStore {
  const scratch = createTreeStore(undefined, {
    ...defaultTree(),
    scoresheetReview: options?.stopped ? { stopped: options.stopped } : {},
  });
  for (const uci of options?.moves ?? ["e2e4", "e7e5", "g1f3", "b8c6"]) {
    scratch.getState().makeMove({ payload: parseUci(uci)! });
  }
  if (options?.variationUnsure) {
    scratch.getState().goToMove([0]);
    scratch.getState().makeMove({ payload: parseUci("c7c5")! });
  }
  const clonedRoot = structuredClone(scratch.getState().root);
  for (const ply of options?.unsurePlies ?? []) {
    getNodeAtPath(clonedRoot, Array<number>(ply).fill(0)).unsure = true;
  }
  if (options?.variationUnsure) {
    getNodeAtPath(clonedRoot, [0, 1]).unsure = true;
  }
  createdTabs.push(tabId);
  return createTreeStore(tabId, {
    ...defaultTree(),
    root: clonedRoot,
    position: [],
    dirty: false,
    scoresheetReview: options?.stopped ? { stopped: options.stopped } : {},
  });
}

async function renderPanel(store: TreeStore, tabId = "tab-1") {
  await act(async () => {
    root.render(
      <WorkspaceTabScope tabId={tabId}>
        <TreeStateContext.Provider value={store}>
          <ScoresheetPhotoPanel />
        </TreeStateContext.Provider>
      </WorkspaceTabScope>,
    );
  });
}

test("shows the photo fitted with a toggle to full size and switches between multiple pages", async () => {
  setScoresheetPhotos("tab-1", [PHOTO_1, PHOTO_2]);
  const store = buildReviewStore("tab-1", { unsurePlies: [1] });
  await renderPanel(store, "tab-1");

  const img = () => host.querySelector<HTMLImageElement>("img")!;
  expect(img().src).toBe(PHOTO_1);
  expect(
    host.querySelector("[data-scoresheet-photo-size]")?.getAttribute("data-scoresheet-photo-size"),
  ).toBe("fit");
  expect(host.querySelector("[data-scoresheet-page]")?.textContent).toBe(
    "Scoresheet.PageOf(current=1,total=2)",
  );

  await act(async () => {
    host.querySelector<HTMLButtonElement>('[aria-label="Scoresheet.NextPage"]')!.click();
  });
  expect(img().src).toBe(PHOTO_2);
  expect(host.querySelector("[data-scoresheet-page]")?.textContent).toBe(
    "Scoresheet.PageOf(current=2,total=2)",
  );

  await act(async () => {
    host.querySelector<HTMLButtonElement>('[aria-label="Scoresheet.FullSize"]')!.click();
  });
  expect(
    host.querySelector("[data-scoresheet-photo-size]")?.getAttribute("data-scoresheet-photo-size"),
  ).toBe("full");
  expect(host.querySelector('[aria-label="Scoresheet.FitToPanel"]')).not.toBeNull();
});

test("shows a no-photo-in-memory state without any dead button when no photo is loaded", async () => {
  const store = buildReviewStore("tab-empty");
  await renderPanel(store, "tab-empty");

  const empty = host.querySelector("[data-scoresheet-no-photo]");
  expect(empty?.textContent).toContain("Scoresheet.NoPhotoInMemory");
  expect(empty?.querySelector("button")).toBeNull();
  expect(host.querySelector("img")).toBeNull();

  // Zero unsure marks: AllMovesChecked shown and prev/next buttons disabled.
  expect(host.querySelector("[data-scoresheet-unsure-count]")?.textContent).toBe(
    "Scoresheet.AllMovesChecked",
  );
  expect(
    host.querySelector<HTMLButtonElement>('[aria-label="Scoresheet.PreviousUnsure"]')!.disabled,
  ).toBe(true);
  expect(
    host.querySelector<HTMLButtonElement>('[aria-label="Scoresheet.NextUnsure"]')!.disabled,
  ).toBe(true);
});

test("counts and navigates only main-line unsure marks with wrap-around, marks one checked, and finishes the review", async () => {
  setScoresheetPhotos("tab-1", [PHOTO_1]);
  const store = buildReviewStore("tab-1", { unsurePlies: [2, 4], variationUnsure: true });
  await renderPanel(store, "tab-1");

  // Variation mark at [0, 1] is ignored; only the 2 main-line marks count.
  expect(host.querySelector("[data-scoresheet-unsure-count]")?.textContent).toBe(
    "Scoresheet.MovesToCheck(count=2)",
  );

  const nextBtn = () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Scoresheet.NextUnsure"]')!;
  const prevBtn = () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Scoresheet.PreviousUnsure"]')!;
  const markBtn = () =>
    Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Scoresheet.MarkAsChecked"),
    )!;
  const finishBtn = () =>
    Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Scoresheet.FinishReview"),
    )!;

  expect(markBtn().disabled).toBe(true);

  await act(async () => nextBtn().click());
  expect(store.getState().position).toEqual([0, 0]);
  expect(markBtn().disabled).toBe(false);

  // Previous from first mark wraps to last mark.
  await act(async () => prevBtn().click());
  expect(store.getState().position).toEqual([0, 0, 0, 0]);

  // Next from last mark wraps to first mark.
  await act(async () => nextBtn().click());
  expect(store.getState().position).toEqual([0, 0]);

  await act(async () => markBtn().click());
  expect(getNodeAtPath(store.getState().root, [0, 0]).unsure).toBeUndefined();
  expect(store.getState().dirty).toBe(false);
  expect(store.getState().history.past).toHaveLength(0);
  expect(host.querySelector("[data-scoresheet-unsure-count]")?.textContent).toBe(
    "Scoresheet.MovesToCheck(count=1)",
  );

  await act(async () => finishBtn().click());
  expect(store.getState().scoresheetReview).toBeUndefined();
  expect(getNodeAtPath(store.getState().root, [0, 0, 0, 0]).unsure).toBeUndefined();
  expect(getNodeAtPath(store.getState().root, [0, 1]).unsure).toBeUndefined();
  expect(store.getState().dirty).toBe(false);
  expect(store.getState().history.past).toHaveLength(0);
  expect(getScoresheetPhotos("tab-1")).toEqual([]);
});

test("renders the stop notice for L < ply, L = ply, L > ply (White and Black) and hides it when nothing remains", async () => {
  // Game has 4 plies (e4, e5, Nf3, Nc6).
  // L = ply = 4 (White): game ends at stop -> shows StoppedAtWhite(move=3), failedToken, and all remaining tokens.
  const atStopWhite = buildReviewStore("tab-stop-w", {
    stopped: { ply: 4, tokens: ["Bb5", "a6", "Ba4"] },
  });
  await renderPanel(atStopWhite, "tab-stop-w");
  expect(host.querySelector("[data-scoresheet-stop-notice]")?.textContent).toContain(
    "Scoresheet.StoppedAtWhite(move=3)",
  );
  expect(host.querySelector("[data-scoresheet-failed-token]")?.textContent).toBe(
    "Scoresheet.CouldNotPlay(token=Bb5)",
  );
  expect(host.querySelector("[data-scoresheet-remaining-tokens]")?.textContent).toBe(
    "3. Bb5 a6 4. Ba4",
  );

  // L = ply = 3 (Black): 3 plies (e4, e5, Nf3) -> shows StoppedAtBlack(move=2) and failedToken.
  const atStopBlack = buildReviewStore("tab-stop-b", {
    moves: ["e2e4", "e7e5", "g1f3"],
    stopped: { ply: 3, tokens: ["Nc6", "Bb5"] },
  });
  await renderPanel(atStopBlack, "tab-stop-b");
  expect(host.querySelector("[data-scoresheet-stop-notice]")?.textContent).toContain(
    "Scoresheet.StoppedAtBlack(move=2)",
  );
  expect(host.querySelector("[data-scoresheet-failed-token]")?.textContent).toBe(
    "Scoresheet.CouldNotPlay(token=Nc6)",
  );
  expect(host.querySelector("[data-scoresheet-remaining-tokens]")?.textContent).toBe(
    "2... Nc6 3. Bb5",
  );

  // L < ply (4 < 6, White): game shorter than stop -> shows NextOnSheetWhite(move=4), no failedToken, all tokens.
  const shorterWhite = buildReviewStore("tab-short-w", {
    stopped: { ply: 6, tokens: ["Ba4", "Nf6"] },
  });
  await renderPanel(shorterWhite, "tab-short-w");
  expect(host.querySelector("[data-scoresheet-stop-notice]")?.textContent).toContain(
    "Scoresheet.NextOnSheetWhite(move=4)",
  );
  expect(host.querySelector("[data-scoresheet-failed-token]")).toBeNull();
  expect(host.querySelector("[data-scoresheet-remaining-tokens]")?.textContent).toBe("4. Ba4 Nf6");

  // L < ply (4 < 5, Black): shows NextOnSheetBlack(move=3), no failedToken.
  const shorterBlack = buildReviewStore("tab-short-b", {
    stopped: { ply: 5, tokens: ["a6", "Ba4"] },
  });
  await renderPanel(shorterBlack, "tab-short-b");
  expect(host.querySelector("[data-scoresheet-stop-notice]")?.textContent).toContain(
    "Scoresheet.NextOnSheetBlack(move=3)",
  );
  expect(host.querySelector("[data-scoresheet-failed-token]")).toBeNull();
  expect(host.querySelector("[data-scoresheet-remaining-tokens]")?.textContent).toBe(
    "3... a6 4. Ba4",
  );

  // L > ply (4 > 3, White): next token is tokens[1] at ply 4 (3. White), no failedToken.
  const pastStop = buildReviewStore("tab-past", {
    stopped: { ply: 3, tokens: ["Nc6", "Bb5", "a6"] },
  });
  await renderPanel(pastStop, "tab-past");
  expect(host.querySelector("[data-scoresheet-stop-notice]")?.textContent).toContain(
    "Scoresheet.NextOnSheetWhite(move=3)",
  );
  expect(host.querySelector("[data-scoresheet-failed-token]")).toBeNull();
  expect(host.querySelector("[data-scoresheet-remaining-tokens]")?.textContent).toBe("3. Bb5 a6");

  // L - ply >= tokens.length (4 - 2 >= 2): nothing remains -> notice hidden.
  const exhausted = buildReviewStore("tab-done", {
    stopped: { ply: 2, tokens: ["Nf3", "Nc6"] },
  });
  await renderPanel(exhausted, "tab-done");
  expect(host.querySelector("[data-scoresheet-stop-notice]")).toBeNull();
});

test("pure formatting and adjacent unsure path helpers handle Black starts and variations", () => {
  expect(formatScoresheetRemainingTokens(1, ["e5", "Nf3", "Nc6"])).toBe("1... e5 2. Nf3 Nc6");
  const marks = [
    [0, 0],
    [0, 0, 0, 0],
  ];
  expect(adjacentUnsurePath(marks, [0, 1], "next")).toEqual([0, 0]);
  expect(adjacentUnsurePath(marks, [0, 0, 1], "previous")).toEqual([0, 0]);
  expect(adjacentUnsurePath([], [], "next")).toBeNull();
});

test.each(Object.entries(catalogues))(
  "ships scoresheet review copy in %s with fallback disabled",
  async (path, catalogue) => {
    const locale = path.split("/").at(-1)!.replace(".json", "");
    const i18n = createInstance();
    await i18n.init({
      lng: locale,
      fallbackLng: false,
      keySeparator: false,
      resources: { [locale]: catalogue },
    });
    const cases: readonly (readonly [string, Record<string, string | number> | undefined])[] = [
      ["Board.Tabs.Photo", undefined],
      ["Notation.UnsureMove", undefined],
      ["Notation.UnsureMoveLabel", { move: "Nf3" }],
      ["Scoresheet.AllMovesChecked", undefined],
      ["Scoresheet.CouldNotPlay", { token: "Nxe5" }],
      ["Scoresheet.FinishReview", undefined],
      ["Scoresheet.FitToPanel", undefined],
      ["Scoresheet.FullSize", undefined],
      ["Scoresheet.LoadFailed", undefined],
      ["Scoresheet.MarkAsChecked", undefined],
      ["Scoresheet.MovesToCheck", { count: 1 }],
      ["Scoresheet.MovesToCheck", { count: 3 }],
      ["Scoresheet.NextOnSheetBlack", { move: 12 }],
      ["Scoresheet.NextOnSheetWhite", { move: 12 }],
      ["Scoresheet.NextPage", undefined],
      ["Scoresheet.NextUnsure", undefined],
      ["Scoresheet.NoPhotoInMemory", undefined],
      ["Scoresheet.PageOf", { current: 1, total: 2 }],
      ["Scoresheet.PhotoAlt", { number: 1 }],
      ["Scoresheet.PreviousPage", undefined],
      ["Scoresheet.PreviousUnsure", undefined],
      ["Scoresheet.StoppedAtBlack", { move: 12 }],
      ["Scoresheet.StoppedAtWhite", { move: 12 }],
    ];
    for (const [key, opts] of cases) {
      const value = String(opts ? i18n.t(key, opts) : i18n.t(key));
      expect(value.trim()).toBeTruthy();
      expect(value).not.toBe(key);
    }
  },
);
