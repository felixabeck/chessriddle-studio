import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useStore } from "zustand";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import GameNotation from "@/components/common/GameNotation";
import EvalChart from "@/components/common/EvalChart";
import { FileChapterSwitchProvider } from "@/components/boards/FileChapterSwitch";
import InfoPanel from "@/components/panels/info/InfoPanel";
import RepertoireInfo from "@/components/panels/practice/RepertoireInfo";
import { activeTabAtom, pgnOptionsFamily, referenceDbAtom, tabsAtom } from "@/state/atoms";
import * as deferredView from "@/state/deferredTreeView";
import { removeFileFreshness, setFileFreshness } from "@/state/fileFreshness";
import { WorkspaceTabScope } from "@/state/tabScope";
import { closeTreeStore, createTreeStore, type TreeStore } from "@/state/store/tree";
import { tabStorage } from "@/state/store/tabStorage";
import type { Tab } from "@/utils/tabs";
import * as chess from "@/utils/chess";
import * as repertoire from "@/utils/repertoire";
import * as treeReducer from "@/utils/treeReducer";
import * as notation from "@/components/common/notationRows";
import { installMatchMediaStub } from "@/tests/matchMedia";
import {
  fileFreshnessTiming,
  fileFreshnessApplicationWithinBudget,
  fileFreshnessMainThreadWithinBudget,
} from "../../../scripts/file-freshness-timing.mjs";
import FileFreshnessGate from "./FileFreshnessGate";
import { TabCommandsProvider } from "./TabCommands";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  parse: vi.fn(),
  translate: (key: string) => key,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.translate, i18n: { language: "en-US" } }),
}));
vi.mock("react-hotkeys-hook", () => ({ useHotkeys: vi.fn() }));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("@/platform/native", async () => ({
  ...(await vi.importActual<typeof import("@/platform/native")>("@/platform/native")),
  platform: () => "linux",
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: "/" } }),
}));
vi.mock("@/hooks/useDatabaseList", () => ({
  useDatabaseList: () => ({ data: { collections: [] } }),
}));
vi.mock("@/components/common/OpeningName", () => ({ default: () => null }));
vi.mock("@/components/common/GameReference", () => ({
  GameReferenceProvider: ({ children }: { children: React.ReactNode }) => children,
  useGameReference: () => null,
}));
vi.mock("@/components/panels/info/FileInfo", () => ({ default: () => null }));
vi.mock("@/components/panels/info/FenSearch", () => ({ default: () => null }));
vi.mock("@/components/common/GameInfo", () => ({ default: () => null }));
vi.mock("@/components/panels/info/GameSelector", () => ({ default: () => null }));
vi.mock("@/utils/files", async (original) => ({
  ...(await original<typeof import("@/utils/files")>()),
  readFileGame: mocks.read,
}));
vi.mock("@/platform/tauri", async (original) => {
  const actual = await original<typeof import("@/platform/tauri")>();
  return { ...actual, tauri: { ...actual.tauri, collectionForDatabase: vi.fn(async () => null) } };
});
vi.mock("@/utils/chess", async (original) => {
  const actual = await original<typeof import("@/utils/chess")>();
  return { ...actual, parsePGN: mocks.parse, getPGN: vi.fn(actual.getPGN) };
});
vi.mock("@/utils/repertoire", async (original) => {
  const actual = await original<typeof import("@/utils/repertoire")>();
  return {
    ...actual,
    getStats: vi.fn(actual.getStats),
    computeTreeCoverage: vi.fn(async () => ({
      coverageMap: new Map(),
      gamesMap: new Map(),
      missingGamesMap: new Map(),
      dbMovesMap: new Map(),
    })),
    fetchPositionMoves: vi.fn(async () => ({ moves: [], total: 0 })),
  };
});
vi.mock("@/utils/treeReducer", async (original) => {
  const actual = await original<typeof import("@/utils/treeReducer")>();
  return {
    ...actual,
    getMemoizedBoardStateMap: vi.fn(actual.getMemoizedBoardStateMap),
    treeIteratorMainLine: vi.fn(actual.treeIteratorMainLine),
  };
});
vi.mock("@/components/common/notationRows", async (original) => {
  const actual = await original<typeof import("@/components/common/notationRows")>();
  return { ...actual, buildNotationRows: vi.fn(actual.buildNotationRows) };
});
vi.mock("@tanstack/react-virtual", async (original) => ({
  ...(await original<typeof import("@tanstack/react-virtual")>()),
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 32,
    measure: () => undefined,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 32 })),
    measureElement: () => undefined,
    getOffsetForIndex: () => undefined,
    scrollToOffset: () => undefined,
    scrollOffset: 0,
  }),
}));
// Only the chart drawing surface is replaced. EvalChart's mainline and data derivations run.
vi.mock("@mantine/charts", () => ({
  AreaChart: ({
    data,
    areaChartProps,
  }: {
    data: { name: string }[];
    areaChartProps: { onClick: (event: { activeLabel: string }) => void };
  }) => (
    <button onClick={() => areaChartProps.onClick({ activeLabel: data[0]?.name })}>
      chart point
    </button>
  ),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, "ResizeObserver", { writable: true, value: ResizeObserverStub });

// Read the verifier's budget so the real-install proof cannot silently use a different ceiling.
const verifierFileSystemModule = "node:fs";
const verifier = await (
  import(verifierFileSystemModule) as Promise<{
    readFileSync(path: string, encoding: "utf8"): string;
  }>
).then((fs) => fs.readFileSync("scripts/verify-app.mjs", "utf8"));
const FILE_FRESHNESS_APPLY_BUDGET_MS = Number(
  verifier.match(/const FILE_FRESHNESS_APPLY_BUDGET_MS = ([\d_]+);/)![1].replaceAll("_", ""),
);
const FILE_FRESHNESS_POLL_INTERVAL_MS = Number(
  verifier.match(/const FILE_FRESHNESS_POLL_INTERVAL_MS = ([\d_]+);/)![1].replaceAll("_", ""),
);
const tabId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const tab: Tab = {
  value: tabId,
  name: "Publication",
  type: "analysis",
  gameOrigin: {
    kind: "file",
    gameNumber: 0,
    file: {
      type: "file",
      handle: { id: { id: "publication" }, kind: "fileWorkspace" },
      name: "publication.pgn",
      numGames: 1,
      lastModified: 1,
      metadata: { type: "repertoire", tags: [] },
    },
  },
};
const hooks = globalThis as typeof globalThis & {
  __verifyAppRecordTreeApplied?: () => void;
  __verifyAppStallFreshnessApply?: () => void;
};
let host: HTMLDivElement;
let root: Root;
let store: TreeStore;
let workspace: ReturnType<typeof createStore>;
let replacement: ReturnType<typeof treeReducer.defaultTree>;
let recoveries: unknown[];

function game(moves: string[], comment: string) {
  const builder = createTreeStore();
  const result = builder.getState().makeMoves({ payload: moves });
  if (!result.success) throw result.error;
  builder.getState().goToStart();
  builder.getState().setComment(comment);
  const state = builder.getState();
  return {
    ...treeReducer.defaultTree(),
    root: state.root,
    headers: state.headers,
    dirty: false,
    sourceStamp: crypto.randomUUID().replaceAll("-", "").repeat(2),
  };
}

function BoardProbe() {
  const current = useStore(store, (state) => state.currentNode());
  return <output data-board-fen={current.fen} data-board-comment={current.comment} />;
}

function panels() {
  return (
    <MantineProvider>
      <Provider store={workspace}>
        <TabCommandsProvider>
          <WorkspaceTabScope tabId={tabId}>
            <TreeStateContext.Provider value={store}>
              <FileChapterSwitchProvider>
                <FileFreshnessGate tab={tab} closeTab={() => undefined}>
                  <section data-panel="inner-notation">
                    <GameNotation />
                  </section>
                  <section data-panel="inner-info">
                    <InfoPanel />
                  </section>
                  <section data-panel="inner-repertoire">
                    <RepertoireInfo />
                  </section>
                  <section data-panel="inner-chart">
                    <EvalChart isAnalysing={false} />
                  </section>
                  {/* BoardsPage renders the board inside this gate. The probe has to be here too. */}
                  <BoardProbe />
                </FileFreshnessGate>
                {/* Keep every heavy consumer mounted across the gate's checking state. */}
                <section data-panel="notation">
                  <GameNotation />
                </section>
                <section data-panel="info">
                  <InfoPanel />
                </section>
                <section data-panel="repertoire">
                  <RepertoireInfo />
                </section>
                <section data-panel="chart">
                  <EvalChart isAnalysing={false} />
                </section>
              </FileChapterSwitchProvider>
            </TreeStateContext.Provider>
          </WorkspaceTabScope>
        </TabCommandsProvider>
      </Provider>
    </MantineProvider>
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  recoveries = [];
  const initial = game(["e4", "e5"], "old comment");
  replacement = game(["d4", "d5", "c4"], "replacement comment");
  store = createTreeStore(tabId, initial);
  workspace = createStore();
  workspace.set(tabsAtom, [tab], tabId);
  workspace.set(activeTabAtom, tabId);
  workspace.set(referenceDbAtom, { id: { id: "reference" }, kind: "database" });
  setFileFreshness(tabId, "verified", { verifiedRevision: "old" });
  mocks.parse.mockImplementation(async () => replacement);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host, { onRecoverableError: (error) => recoveries.push(error) });
  await act(async () => root.render(panels()));
});

afterEach(async () => {
  delete hooks.__verifyAppRecordTreeApplied;
  delete hooks.__verifyAppStallFreshnessApply;
  await act(async () => root?.unmount());
  host?.remove();
  tabStorage.flush();
  closeTreeStore(tabId);
  removeFileFreshness(tabId);
  vi.restoreAllMocks();
});

function commitWalkCalls() {
  return (
    vi.mocked(notation.buildNotationRows).mock.calls.length +
    vi.mocked(chess.getPGN).mock.calls.length +
    vi.mocked(treeReducer.treeIteratorMainLine).mock.calls.length +
    vi.mocked(repertoire.getStats).mock.calls.length +
    vi.mocked(treeReducer.getMemoizedBoardStateMap).mock.calls.length
  );
}

function replacementWalks() {
  return {
    notation: vi
      .mocked(notation.buildNotationRows)
      .mock.calls.filter(([root]) => root === replacement.root).length,
    pgn: vi.mocked(chess.getPGN).mock.calls.filter(([root]) => root === replacement.root).length,
    eval: vi
      .mocked(treeReducer.treeIteratorMainLine)
      .mock.calls.filter(([root]) => root === replacement.root).length,
    stats: vi
      .mocked(repertoire.getStats)
      .mock.calls.filter(([state]) => state.root === replacement.root).length,
    map: vi
      .mocked(treeReducer.getMemoizedBoardStateMap)
      .mock.calls.filter(([root]) => root === replacement.root).length,
  };
}

async function install(now: () => number = () => performance.now()) {
  let finish!: (value: unknown) => void;
  mocks.read.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => setFileFreshness(tabId, "unverified"));
  let readFinishedAt = 0;
  await act(async () => {
    readFinishedAt = now();
    finish({
      pgn: "replacement",
      present: true,
      stamp: replacement.sourceStamp,
      revision: crypto.randomUUID(),
    });
  });
  return readFinishedAt;
}

test("the verified commit retains every named view, then rebuilds the replacement root", async () => {
  let applied: ReturnType<typeof replacementWalks> | undefined;
  let cleared: ReturnType<typeof replacementWalks> | undefined;
  let attribute: string | null | undefined;
  let board: string | null | undefined;
  let deferredAtApplied = false;
  let deferredAfterRelease = true;
  let walksDuringCommit = -1;
  hooks.__verifyAppRecordTreeApplied = () => {
    applied = replacementWalks();
    deferredAtApplied = deferredView.isTreeViewDeferred(store);
    walksDuringCommit = commitWalkCalls();
  };
  const release = deferredView.releaseTreeView;
  vi.spyOn(deferredView, "releaseTreeView").mockImplementation((owner) => {
    cleared = replacementWalks();
    attribute = host.querySelector("[data-file-freshness]")?.getAttribute("data-file-freshness");
    board = host.querySelector("[data-board-comment]")?.getAttribute("data-board-comment");
    release(owner);
    deferredAfterRelease = deferredView.isTreeViewDeferred(owner);
    walksDuringCommit = commitWalkCalls() - walksDuringCommit;
  });

  await install();

  expect(walksDuringCommit).toBe(0);
  expect(host.querySelector('[data-panel="inner-notation"]')).not.toBeNull();
  const freshness = host.querySelector("[data-file-freshness]");
  expect(freshness?.contains(host.querySelector("[data-board-comment]"))).toBe(true);
  expect(applied).toEqual({ notation: 0, pgn: 0, eval: 0, stats: 0, map: 0 });
  expect(cleared).toEqual(applied);
  expect(attribute).toBe("verified:1");
  expect(board).toBe("replacement comment");
  expect(deferredAtApplied).toBe(true);
  expect(deferredAfterRelease).toBe(false);
  const rebuilt = replacementWalks();
  expect(rebuilt.notation).toBeGreaterThan(0);
  expect(rebuilt.pgn).toBeGreaterThanOrEqual(2);
  expect(rebuilt.eval).toBeGreaterThan(0);
  expect(rebuilt.stats).toBeGreaterThanOrEqual(2);
  expect(rebuilt.map).toBeGreaterThan(0);
});

function button(scope: ParentNode, text: string) {
  const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent === text,
  );
  if (!match) throw new Error(`Missing ${text}`);
  return match;
}

function infoPanel() {
  return host.querySelector('[data-panel="info"]')!;
}

async function draftInfoPgn(text: string) {
  const textarea = infoPanel().querySelector("textarea");
  if (!textarea) throw new Error("Missing info PGN editor");
  const assign = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    assign.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

test("retained notation, chart, repertoire moves and a draft Update refuse the new root", async () => {
  const goToMove = vi.spyOn(store.getState(), "goToMove");
  const setState = vi.spyOn(store.getState(), "setState");
  let clicks = 0;
  let stateCallsBefore = 0;
  let stateCallsAfter = 0;
  let parseCallsBefore = 0;
  const release = deferredView.releaseTreeView;
  vi.spyOn(deferredView, "releaseTreeView").mockImplementation((owner) => {
    stateCallsBefore = setState.mock.calls.length;
    parseCallsBefore = mocks.parse.mock.calls.length;
    button(host.querySelector('[data-panel="notation"]')!, "e4").click();
    button(host.querySelector('[data-panel="chart"]')!, "chart point").click();
    const move = [
      ...host.querySelectorAll<HTMLButtonElement>('[data-panel="repertoire"] button'),
    ].find((element) =>
      [...element.querySelectorAll("p")].some((label) => label.textContent === "1. e4"),
    );
    if (!move) throw new Error("Missing retained repertoire move");
    move.click();
    button(infoPanel(), "Common.Update").click();
    clicks = 4;
    stateCallsAfter = setState.mock.calls.length;
    release(owner);
  });

  const textarea = infoPanel().querySelector("textarea");
  if (!textarea) throw new Error("Missing info PGN editor");
  await draftInfoPgn(`${textarea.value} `);
  expect(button(infoPanel(), "Common.Update")).toBeDefined();

  await install();

  expect(clicks).toBe(4);
  expect(goToMove).not.toHaveBeenCalled();
  expect(stateCallsBefore).toBe(1);
  expect(stateCallsAfter).toBe(stateCallsBefore);
  expect(mocks.parse).toHaveBeenCalledTimes(parseCallsBefore);
  expect(store.getState().root).toBe(replacement.root);
});

test("a comments-off PGN editor is read-only and offers no Update", async () => {
  const options = workspace.get(pgnOptionsFamily(tabId));
  await act(async () => {
    workspace.set(pgnOptionsFamily(tabId), { ...options, comments: false });
  });
  const panel = infoPanel();
  expect(
    [...panel.querySelectorAll("button")].some(
      (element) => element.textContent === "Common.Update",
    ),
  ).toBe(false);
  expect(panel.querySelector("textarea")!.hasAttribute("readonly")).toBe(true);
});

test("a thrown follow-up walk leaves deferral clear and the next successful render rebuilds", async () => {
  let thrown = 0;
  let deferredWhenThrown = true;
  vi.mocked(notation.buildNotationRows).mockImplementation((root, options) => {
    if (root === replacement.root && thrown === 0) {
      thrown++;
      deferredWhenThrown = deferredView.isTreeViewDeferred(store);
      throw new Error("follow-up rebuild");
    }
    // The spy wraps the real walk, whose implementation is restored for successful retries.
    return realBuildNotationRows(root, options);
  });
  await install();
  await act(async () => root.render(panels()));
  expect(thrown).toBe(1);
  expect(deferredWhenThrown).toBe(false);
  expect(deferredView.isTreeViewDeferred(store)).toBe(false);
  expect(replacementWalks().notation).toBeGreaterThan(1);
  expect(host.querySelector('[data-panel="notation"]')?.textContent).toContain("d4");
  expect(recoveries).toHaveLength(1);
  vi.mocked(notation.buildNotationRows).mockImplementation(realBuildNotationRows);
});

const { buildNotationRows: realBuildNotationRows } = await vi.importActual<
  typeof import("@/components/common/notationRows")
>("@/components/common/notationRows");

// The wall-clock budget belongs to `pnpm verify:app`, which measures the real application. Here a
// virtual clock that only the apply hook advances proves that apply-path work lands inside the
// measured main-thread interval, independent of machine load in the instrumented coverage lane.
test("real install counts apply-path work against the main-thread budget", async () => {
  const outcomes: boolean[] = [];
  let virtualMs = 0;
  const now = () => virtualMs;
  let treeAppliedAtStall = false;
  for (const stalled of [true, false]) {
    let appliedAt = Number.NaN;
    let observedAt = Number.NaN;
    const before = host.querySelector("[data-file-freshness]")!.getAttribute("data-file-freshness");
    const expected = `verified:${stalled ? 1 : 2}`;
    const observer = new MutationObserver(() => {
      if (
        host.querySelector("[data-file-freshness]")?.getAttribute("data-file-freshness") ===
          expected &&
        !Number.isFinite(observedAt)
      ) {
        observedAt = now();
      }
    });
    observer.observe(host, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-file-freshness"],
    });
    hooks.__verifyAppRecordTreeApplied = () => {
      appliedAt = now();
    };
    if (stalled)
      hooks.__verifyAppStallFreshnessApply = () => {
        // Test-only install wedge: the apply path costs more than the budget on the virtual clock.
        // It must run after the tree is applied, so the measured interval covers that work.
        treeAppliedAtStall = store.getState().root.comment === "wedged";
        virtualMs += FILE_FRESHNESS_APPLY_BUDGET_MS + 100;
      };
    else delete hooks.__verifyAppStallFreshnessApply;
    // Each iteration installs a distinct revision and root through reconciliation.
    replacement = game(stalled ? ["d4", "d5"] : ["c4", "e5"], stalled ? "wedged" : "clean");
    try {
      const readFinishedAt = await install(now);
      expect(Number.isFinite(observedAt)).toBe(true);
      const timing = fileFreshnessTiming(
        { readFinishedAt, appliedAt, observedAt, lexAwaitMs: 0, readTimeMs: 0 },
        FILE_FRESHNESS_POLL_INTERVAL_MS,
      );
      outcomes.push(fileFreshnessMainThreadWithinBudget(timing, FILE_FRESHNESS_APPLY_BUDGET_MS));
      expect(fileFreshnessApplicationWithinBudget(timing, FILE_FRESHNESS_APPLY_BUDGET_MS)).toBe(
        true,
      );
      expect(timing.mainThreadMs).toBe(stalled ? FILE_FRESHNESS_APPLY_BUDGET_MS + 100 : 0);
      expect(
        host.querySelector("[data-file-freshness]")!.getAttribute("data-file-freshness"),
      ).not.toBe(before);
    } finally {
      observer.disconnect();
      delete hooks.__verifyAppStallFreshnessApply;
    }
  }
  expect(outcomes).toEqual([false, true]);
  expect(treeAppliedAtStall).toBe(true);
  expect(hooks.__verifyAppStallFreshnessApply).toBeUndefined();
});
