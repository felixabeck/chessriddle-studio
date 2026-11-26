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
import { CoachCommandError } from "@/platform/coach";
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

const mocks = vi.hoisted(() => ({
  scoresheetPickPhotos: vi.fn(),
}));

vi.mock("@/platform/tauri", () => ({
  tauri: {
    scoresheetPickPhotos: () => mocks.scoresheetPickPhotos(),
  },
}));

vi.mock("lucide-react", async (importOriginal) => {
  const Icon = () => null;
  return {
    ...(await importOriginal<typeof import("lucide-react")>()),
    Check: Icon,
    ChevronLeft: Icon,
    ChevronRight: Icon,
    ImagePlus: Icon,
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
  vi.clearAllMocks();
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

test("shows the photo with overlay controls (enlarge top-right, page overlay only for multiple photos) and no toolbar row above", async () => {
  setScoresheetPhotos("tab-1", [PHOTO_1]);
  const store = buildReviewStore("tab-1", { unsurePlies: [1] });
  await renderPanel(store, "tab-1");

  const img = () => host.querySelector<HTMLImageElement>("img")!;
  expect(img().src).toBe(PHOTO_1);
  expect(
    host.querySelector("[data-scoresheet-photo-size]")?.getAttribute("data-scoresheet-photo-size"),
  ).toBe("fit");
  expect(host.querySelector("[data-scoresheet-enlarge-overlay]")).not.toBeNull();
  // Single photo hides the bottom page overlay.
  expect(host.querySelector("[data-scoresheet-page-overlay]")).toBeNull();
  expect(host.querySelector("[data-scoresheet-page]")).toBeNull();

  // Multiple photos show the page overlay and switch pages; clicking enlarge toggles full size.
  await act(async () => setScoresheetPhotos("tab-1", [PHOTO_1, PHOTO_2]));
  expect(host.querySelector("[data-scoresheet-page-overlay]")).not.toBeNull();
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
  // Enlarge and page overlays stay present in full-size mode.
  expect(host.querySelector("[data-scoresheet-enlarge-overlay]")).not.toBeNull();
  expect(host.querySelector("[data-scoresheet-page-overlay]")).not.toBeNull();
});

test("shows a no-photo-in-memory state with Load photo again when no photo is loaded, and omits Mark as checked at zero marks", async () => {
  const store = buildReviewStore("tab-empty");
  await renderPanel(store, "tab-empty");

  const empty = host.querySelector("[data-scoresheet-no-photo]");
  expect(empty?.textContent).toContain("Scoresheet.NoPhotoInMemory");
  expect(empty?.querySelector("button")?.textContent).toContain("Scoresheet.LoadPhotoAgain");
  expect(host.querySelector("img")).toBeNull();
  expect(host.querySelector("[data-scoresheet-enlarge-overlay]")).toBeNull();
  expect(host.querySelector("[data-scoresheet-page-overlay]")).toBeNull();

  // Zero unsure marks: AllMovesChecked shown, prev/next buttons disabled, Mark as checked absent, no Finish review.
  expect(host.querySelector("[data-scoresheet-unsure-count]")?.textContent).toBe(
    "Scoresheet.AllMovesChecked",
  );
  expect(
    host.querySelector<HTMLButtonElement>('[aria-label="Scoresheet.PreviousUnsure"]')!.disabled,
  ).toBe(true);
  expect(
    host.querySelector<HTMLButtonElement>('[aria-label="Scoresheet.NextUnsure"]')!.disabled,
  ).toBe(true);
  expect(
    Array.from(host.querySelectorAll("button")).some((b) =>
      b.textContent?.includes("Scoresheet.MarkAsChecked"),
    ),
  ).toBe(false);
  expect(host.textContent).not.toContain("Scoresheet.FinishReview");
});

test("counts and navigates only main-line unsure marks with wrap-around and removes Mark as checked once all are checked", async () => {
  setScoresheetPhotos("tab-1", [PHOTO_1]);
  const store = buildReviewStore("tab-1", { unsurePlies: [2, 4], variationUnsure: true });
  await renderPanel(store, "tab-1");

  // Variation mark at [0, 1] is ignored; only the 2 main-line marks count.
  expect(host.querySelector("[data-scoresheet-unsure-count]")?.textContent).toBe(
    "Scoresheet.MovesToCheck(count=2)",
  );
  expect(host.textContent).not.toContain("Scoresheet.FinishReview");

  const nextBtn = () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Scoresheet.NextUnsure"]')!;
  const prevBtn = () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Scoresheet.PreviousUnsure"]')!;
  const markBtn = () =>
    Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Scoresheet.MarkAsChecked"),
    );

  expect(markBtn()?.disabled).toBe(true);

  await act(async () => nextBtn().click());
  expect(store.getState().position).toEqual([0, 0]);
  expect(markBtn()?.disabled).toBe(false);

  // Previous from first mark wraps to last mark.
  await act(async () => prevBtn().click());
  expect(store.getState().position).toEqual([0, 0, 0, 0]);

  // Next from last mark wraps to first mark.
  await act(async () => nextBtn().click());
  expect(store.getState().position).toEqual([0, 0]);

  await act(async () => markBtn()!.click());
  expect(getNodeAtPath(store.getState().root, [0, 0]).unsure).toBeUndefined();
  expect(store.getState().dirty).toBe(false);
  expect(store.getState().history.past).toHaveLength(0);
  expect(host.querySelector("[data-scoresheet-unsure-count]")?.textContent).toBe(
    "Scoresheet.MovesToCheck(count=1)",
  );

  // Clearing the final unsure mark removes Mark as checked and shows AllMovesChecked.
  await act(async () => nextBtn().click());
  expect(store.getState().position).toEqual([0, 0, 0, 0]);
  await act(async () => markBtn()!.click());
  expect(host.querySelector("[data-scoresheet-unsure-count]")?.textContent).toBe(
    "Scoresheet.AllMovesChecked",
  );
  expect(markBtn()).toBeUndefined();
});

test("hides the review controls row when no scoresheet review is active (reopened saved game)", async () => {
  setScoresheetPhotos("tab-reopened", [PHOTO_1, PHOTO_2]);
  createdTabs.push("tab-reopened");
  const store = createTreeStore("tab-reopened", {
    ...defaultTree(),
    scoresheetReview: undefined,
  });
  await renderPanel(store, "tab-reopened");

  expect(host.querySelector("img")?.getAttribute("src")).toBe(PHOTO_1);
  expect(host.querySelector("[data-scoresheet-enlarge-overlay]")).not.toBeNull();
  expect(host.querySelector("[data-scoresheet-page-overlay]")).not.toBeNull();
  expect(host.querySelector("[data-scoresheet-review-row]")).toBeNull();
  expect(host.querySelector("[data-scoresheet-unsure-count]")).toBeNull();
  expect(host.querySelector("[data-scoresheet-stop-notice]")).toBeNull();
  expect(host.querySelector("[data-scoresheet-continue]")).toBeNull();
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

test("Load photo again attaches picked photos without sending, reports failed files, and stays quiet on cancel", async () => {
  const store = buildReviewStore("tab-reload-photo");
  await renderPanel(store, "tab-reload-photo");
  expect(host.querySelector("[data-scoresheet-no-photo]")).not.toBeNull();

  const loadButton = () =>
    Array.from(host.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Scoresheet.LoadPhotoAgain"),
    )!;

  // Cancelled picker shows nothing.
  mocks.scoresheetPickPhotos.mockRejectedValueOnce(new CoachCommandError("cancelled"));
  await act(async () => {
    loadButton().click();
  });
  expect(host.querySelector("[data-scoresheet-intake-status]")).toBeNull();
  expect(getScoresheetPhotos("tab-reload-photo")).toEqual([]);

  // Failed file reported on intake line while valid photo is attached for viewing.
  mocks.scoresheetPickPhotos.mockResolvedValueOnce({
    photos: [{ dataUrl: PHOTO_1 }],
    skipped: 0,
    failed: 1,
  });
  await act(async () => {
    loadButton().click();
  });
  expect(mocks.scoresheetPickPhotos).toHaveBeenCalledTimes(2);
  expect(getScoresheetPhotos("tab-reload-photo")).toEqual([PHOTO_1]);
  expect(host.querySelector("img")?.getAttribute("src")).toBe(PHOTO_1);
  expect(host.querySelector("[data-scoresheet-intake-status]")?.textContent).toBe(
    "Scoresheet.Intake.Failed(count=1)",
  );
});

test("Load photo again reports visible command errors and skipped counts on the intake line", async () => {
  const store = buildReviewStore("tab-reload-errors");
  await renderPanel(store, "tab-reload-errors");

  const loadButton = () =>
    Array.from(host.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Scoresheet.LoadPhotoAgain"),
    )!;

  mocks.scoresheetPickPhotos.mockRejectedValueOnce(new CoachCommandError("photoUnreadable"));
  await act(async () => {
    loadButton().click();
  });
  expect(host.querySelector("[data-scoresheet-intake-status]")?.textContent).toBe(
    "Coach.Error.PhotoUnreadable",
  );

  mocks.scoresheetPickPhotos.mockRejectedValueOnce(new CoachCommandError("unavailable"));
  await act(async () => {
    loadButton().click();
  });
  expect(host.querySelector("[data-scoresheet-intake-status]")?.textContent).toBe(
    "Scoresheet.Error.Unavailable",
  );

  mocks.scoresheetPickPhotos.mockResolvedValueOnce({
    photos: [{ dataUrl: PHOTO_1 }],
    skipped: 2,
    failed: 0,
  });
  await act(async () => {
    loadButton().click();
  });
  expect(getScoresheetPhotos("tab-reload-errors")).toEqual([PHOTO_1]);
  expect(host.querySelector("[data-scoresheet-intake-status]")?.textContent).toBe(
    "Scoresheet.Intake.Skipped(count=2)",
  );
});

test("Load photo again resets loading state when tabId changes mid-pick so the new tab can pick", async () => {
  const storeA = buildReviewStore("tab-mid-a");
  const storeB = buildReviewStore("tab-mid-b");
  await renderPanel(storeA, "tab-mid-a");

  let resolveFirst!: (value: {
    photos: Array<{ dataUrl: string }>;
    skipped: number;
    failed: number;
  }) => void;
  mocks.scoresheetPickPhotos.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  );

  const loadButton = () =>
    Array.from(host.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Scoresheet.LoadPhotoAgain"),
    )!;

  await act(async () => {
    loadButton().click();
  });
  expect(mocks.scoresheetPickPhotos).toHaveBeenCalledTimes(1);

  // Switch to tab-mid-b while tab-mid-a's pick is still in flight.
  await renderPanel(storeB, "tab-mid-b");

  // Button on tab-mid-b must work immediately (not stuck loading).
  mocks.scoresheetPickPhotos.mockResolvedValueOnce({
    photos: [{ dataUrl: PHOTO_2 }],
    skipped: 0,
    failed: 0,
  });
  await act(async () => {
    loadButton().click();
  });
  expect(mocks.scoresheetPickPhotos).toHaveBeenCalledTimes(2);
  expect(getScoresheetPhotos("tab-mid-b")).toEqual([PHOTO_2]);

  // Late settlement of tab-mid-a's stale pick must not attach to tab-mid-a or overwrite tab-mid-b.
  await act(async () => {
    resolveFirst({ photos: [{ dataUrl: PHOTO_1 }], skipped: 0, failed: 0 });
    await Promise.resolve();
  });
  expect(getScoresheetPhotos("tab-mid-a")).toEqual([]);
  expect(getScoresheetPhotos("tab-mid-b")).toEqual([PHOTO_2]);
});

test("Continue with the rest of the sheet button is shown only in the two eligible situations and replays on click", async () => {
  // Situation 1: after a stop (L > ply at last main-line move).
  const afterStopStore = buildReviewStore("tab-continue-stop", {
    moves: ["e2e4", "e7e5", "g1f3", "b8c6"],
    stopped: { ply: 3, tokens: ["?", "Bb5", "a6"] },
  });
  await renderPanel(afterStopStore, "tab-continue-stop");

  const continueBtn = () =>
    host.querySelector<HTMLButtonElement>("[data-scoresheet-continue-button]");

  // At root -> hidden.
  expect(continueBtn()).toBeNull();

  // At ply 3 (not last move) -> hidden.
  await act(async () => afterStopStore.getState().goToMove([0, 0, 0]));
  expect(continueBtn()).toBeNull();

  // At ply 4 (last move of main line, L = 4 > ply = 3, remaining tokens = ["Bb5", "a6"]) -> shown.
  await act(async () => afterStopStore.getState().goToMove([0, 0, 0, 0]));
  expect(continueBtn()).not.toBeNull();
  expect(host.querySelector("[data-scoresheet-continue]")?.textContent).toContain(
    "Scoresheet.ContinueHint",
  );
  expect(continueBtn()?.textContent).toContain("Scoresheet.ContinueWithSheet");

  // Click -> appends Bb5, a6, stays on user's move [0, 0, 0, 0], notice hides (exhausted), button hides.
  await act(async () => continueBtn()!.click());
  expect(afterStopStore.getState().position).toEqual([0, 0, 0, 0]);
  expect(getNodeAtPath(afterStopStore.getState().root, [0, 0, 0, 0, 0]).san).toBe("Bb5");
  expect(getNodeAtPath(afterStopStore.getState().root, [0, 0, 0, 0, 0, 0]).san).toBe("a6");
  expect(host.querySelector("[data-scoresheet-stop-notice]")).toBeNull();
  expect(continueBtn()).toBeNull();

  // At L === ply -> hidden.
  const atStopStore = buildReviewStore("tab-continue-at-stop", {
    moves: ["e2e4", "e7e5", "g1f3"],
    stopped: { ply: 3, tokens: ["Nc6", "Bb5"] },
  });
  await renderPanel(atStopStore, "tab-continue-at-stop");
  await act(async () => atStopStore.getState().goToMove([0, 0, 0]));
  expect(continueBtn()).toBeNull();

  // Situation 2: 1-move variation beside a main-line move.
  const middleStore = buildReviewStore("tab-continue-middle", {
    moves: ["e2e4", "e7e5", "g1f3", "b8c6"],
    unsurePlies: [3],
  });
  await renderPanel(middleStore, "tab-continue-middle");
  await act(async () => {
    middleStore.getState().goToMove([0]);
    middleStore.getState().makeMove({ payload: parseUci("c7c5")! });
  });
  expect(middleStore.getState().position).toEqual([0, 1]);
  expect(continueBtn()).not.toBeNull();

  await act(async () => continueBtn()!.click());
  expect(middleStore.getState().position).toEqual([0, 0]);
  expect(getNodeAtPath(middleStore.getState().root, [0, 0]).san).toBe("c5");
  expect(getNodeAtPath(middleStore.getState().root, [0, 0, 0]).san).toBe("Nf3");
  expect(getNodeAtPath(middleStore.getState().root, [0, 0, 0]).unsure).toBe(true);
  expect(continueBtn()).toBeNull();

  // One-move variation beside the LAST main-line move with no remaining sheet tokens -> hidden.
  const lastMoveStore = buildReviewStore("tab-continue-last-move", {
    moves: ["e2e4", "e7e5", "g1f3", "b8c6"],
  });
  await renderPanel(lastMoveStore, "tab-continue-last-move");
  await act(async () => {
    lastMoveStore.getState().goToMove([0, 0, 0]);
    lastMoveStore.getState().makeMove({ payload: parseUci("g8f6")! });
  });
  expect(lastMoveStore.getState().position).toEqual([0, 0, 0, 1]);
  expect(continueBtn()).toBeNull();
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
      ["Scoresheet.ContinueHint", undefined],
      ["Scoresheet.ContinueWithSheet", undefined],
      ["Scoresheet.CouldNotPlay", { token: "Nxe5" }],
      ["Scoresheet.FitToPanel", undefined],
      ["Scoresheet.FullSize", undefined],
      ["Scoresheet.LoadFailed", undefined],
      ["Scoresheet.LoadPhotoAgain", undefined],
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
