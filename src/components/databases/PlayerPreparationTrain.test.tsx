import { MantineProvider } from "@mantine/core";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createEmptyCard } from "ts-fsrs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DatabaseHandle, FileWorkspaceHandle, Player, PositionStats } from "@/bindings";
import type { FileMetadata } from "@/components/files/file";
import TimedRunOwner from "@/components/panels/practice/TimedRunOwner";
import {
  activeTabAtom,
  fileWorkspaceAtom,
  invalidateFileDeckAtoms,
  opponentPreparationAtom,
  practiceNewPerSessionAtom,
  practiceRunRequestFamily,
  practiceSegmentGateFamily,
  practiceTabFamily,
  practiceTrainMinutesAtom,
  tabFamily,
  tabsAtom,
  timedRunAtom,
  timedRunLaunchAtom,
} from "@/state/atoms";
import { resetPracticeMigrationForTests } from "@/state/practiceStorage";
import type { RepertoireChapterNode, RepertoireSnapshot } from "@/state/repertoireIndex";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { INITIAL_BOARD_STATE } from "@/utils/opponentPreparation";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import type { Position } from "@/utils/practicePosition";
import type { Tab } from "@/utils/tabs";
import PlayerPreparation from "./PlayerPreparation";

const harness = vi.hoisted(() => ({
  store: null as ReturnType<typeof createStore> | null,
  refreshRepertoireIndex: vi.fn(),
  readRepertoireIndex: vi.fn(),
  fetchBatchStatistics: vi.fn(),
  openFile: vi.fn(),
  closeTab: vi.fn<(tabId: string | null, discard?: boolean) => Promise<void>>(
    async () => undefined,
  ),
  navigate: vi.fn(),
  notifyUnlessCancelled: vi.fn(),
  notifyShow: vi.fn(),
  prepareTimedRunWeights: vi.fn(),
  createTabOverride: null as ((...args: unknown[]) => Promise<string | null>) | null,
  tauri: {
    listPracticeDecks: vi.fn(),
    readPracticeEpoch: vi.fn(),
    loadPracticeDeck: vi.fn(),
    syncPracticePositions: vi.fn(),
    recordPracticeReview: vi.fn(),
    resetPracticeDeck: vi.fn(),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (!opts) return key;
      const parts = Object.entries(opts)
        .filter(([k]) => k !== "defaultValue")
        .map(([k, v]) => `${k}=${String(v)}`);
      return parts.length > 0 ? `${key}(${parts.join(",")})` : key;
    },
  }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => harness.navigate }));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: (...args: unknown[]) => harness.notifyShow(...args) },
}));
vi.mock("@/platform/tauri", () => ({
  tauri: harness.tauri,
}));
vi.mock("@/components/panels/database/DatabaseLoader", () => ({
  default: ({ label }: { label: string }) => <div>{label}</div>,
}));
vi.mock("@/state/repertoireIndex", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/repertoireIndex")>()),
  refreshRepertoireIndex: harness.refreshRepertoireIndex,
  readRepertoireIndex: harness.readRepertoireIndex,
}));
vi.mock("@/utils/repertoire", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/repertoire")>()),
  fetchBatchStatistics: harness.fetchBatchStatistics,
}));
vi.mock("./useOnlineGames", () => ({
  useOnlineGames: () => undefined,
}));
vi.mock("@/utils/openFile", () => ({
  openFile: (...args: unknown[]) => harness.openFile(...args),
}));
vi.mock("@/utils/tabs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/tabs")>();
  return {
    ...actual,
    createTab: (...args: Parameters<typeof actual.createTab>) =>
      harness.createTabOverride ? harness.createTabOverride(...args) : actual.createTab(...args),
  };
});
vi.mock("@/components/files/notifyError", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/files/notifyError")>()),
  notifyUnlessCancelled: harness.notifyUnlessCancelled,
}));
vi.mock("@/components/panels/practice/prepareTimedRun", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/panels/practice/prepareTimedRun")>()),
  prepareTimedRunWeights: harness.prepareTimedRunWeights,
}));
vi.mock("@/components/tabs/TabCommands", () => ({
  useTabCommands: () => ({
    closeTab: harness.closeTab,
    selectTab: (tabId: string) => {
      const current = harness.store;
      if (!current) return;
      if (!current.get(tabsAtom).some((tab) => tab.value === tabId)) return;
      current.set(activeTabAtom, tabId);
    },
    tabs: [],
    activeTab: null,
    showTab: vi.fn(),
    duplicateTab: vi.fn(),
    renameTab: vi.fn(),
    reorderTabs: vi.fn(),
    newTab: vi.fn(),
    pageTabs: [],
    showPageTab: vi.fn(),
    closePageTab: vi.fn(),
  }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

const workspace: FileWorkspaceHandle = { id: { id: "ws-train" }, kind: "fileWorkspace" };
const cardDb: DatabaseHandle = { id: { id: "db-otb" }, kind: "database" };
const player: Player = { id: 7, name: "Carlsen, Magnus", elo: 2830, game_count: 50 };

const repFileA: FileMetadata = {
  type: "file",
  name: "Black vs e4",
  handle: { id: { id: "file-black-a" }, kind: "fileWorkspace" },
  numGames: 1,
  metadata: { type: "repertoire", tags: [] },
  lastModified: 1,
};
const repFileB: FileMetadata = {
  type: "file",
  name: "Black vs d4",
  handle: { id: { id: "file-black-b" }, kind: "fileWorkspace" },
  numGames: 1,
  metadata: { type: "repertoire", tags: [] },
  lastModified: 1,
};

const keyA = fileWorkspaceKey(repFileA.handle);
const keyB = fileWorkspaceKey(repFileB.handle);

const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -";
const AFTER_E4_C5 = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -";
const AFTER_D4 = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq -";
const AFTER_D4_NF6 = "rnbqkb1r/pppppppp/5n2/8/3P4/8/PPP1PPPP/RNBQKBNR w KQkq -";

function statRow(move: string, white: number): PositionStats {
  return {
    move,
    white,
    draw: 0,
    black: 0,
    unknown: 0,
    last_played: "2026.05.10",
    year_counts: [],
    recent: [],
  };
}

function twoChapterSnapshot(): RepertoireSnapshot {
  return {
    files: [
      {
        workspaceKey: keyA,
        file: repFileA,
        partial: false,
        chapters: [
          {
            chapter: 0,
            headers: { orientation: "black", white: "Sicilian", black: "Mainline", event: "?" },
            nodes: [
              {
                boardState: INITIAL_BOARD_STATE,
                parent: -1,
                san: null,
                path: [],
                halfMoves: 0,
                hasContinuation: true,
              },
              {
                boardState: AFTER_E4,
                parent: 0,
                san: "e4",
                path: [0],
                halfMoves: 1,
                hasContinuation: true,
              },
              {
                boardState: AFTER_E4_C5,
                parent: 1,
                san: "c5",
                path: [0, 0],
                halfMoves: 2,
                hasContinuation: false,
              },
            ],
          },
        ],
      },
      {
        workspaceKey: keyB,
        file: repFileB,
        partial: false,
        chapters: [
          {
            chapter: 0,
            headers: { orientation: "black", white: "Indian", black: "Mainline", event: "?" },
            nodes: [
              {
                boardState: INITIAL_BOARD_STATE,
                parent: -1,
                san: null,
                path: [],
                halfMoves: 0,
                hasContinuation: true,
              },
              {
                boardState: AFTER_D4,
                parent: 0,
                san: "d4",
                path: [0],
                halfMoves: 1,
                hasContinuation: true,
              },
              {
                boardState: AFTER_D4_NF6,
                parent: 1,
                san: "Nf6",
                path: [0, 0],
                halfMoves: 2,
                hasContinuation: false,
              },
            ],
          },
        ],
      },
    ],
    partial: false,
    partialReason: null,
  };
}

function twoChapterStats(): Map<string, PositionStats[]> {
  return new Map([
    [INITIAL_BOARD_STATE, [statRow("e4", 10), statRow("d4", 6)]],
    [AFTER_E4, [statRow("c5", 10)]],
    [AFTER_E4_C5, [statRow("Nf3", 10)]],
    [AFTER_D4, [statRow("Nf6", 6)]],
    [AFTER_D4_NF6, [statRow("c4", 6)]],
  ]);
}

function makeStoredPosition(boardState: string, reps: number, weight?: number): Position {
  const card = createEmptyCard(new Date("2026-11-20T00:00:00Z"));
  return {
    fen: `${boardState} 0 1`,
    answer: "c5",
    card: { ...card, reps },
    weight,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let openedSeq = 0;

function installRealOwnerOpenFileMock(store: ReturnType<typeof createStore>) {
  harness.openFile.mockImplementation(
    async (
      file: FileMetadata,
      _setTabs: unknown,
      options: { ownerId?: string; gameNumber?: number },
    ) => {
      // Yield a macrotask so TimedRunOwner's watchOpenLeave / leftDuringOpen runs before mutation.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const ownerId = options.ownerId;
      const existingOwner = ownerId
        ? store.get(tabsAtom).find((tab) => tab.value === ownerId)
        : undefined;
      if (!ownerId || !existingOwner || existingOwner.type !== "new") {
        throw new Error(`Expected ownerId to name an existing new tab, got ${String(ownerId)}`);
      }
      // Mirror real replaceNewTab: replace the New Tab with a fresh tab id and activate it.
      const tabId = `opened-chapter-${++openedSeq}`;
      const opened: Tab = {
        value: tabId,
        name: file.name,
        type: "analysis",
        gameOrigin: { kind: "file", file, gameNumber: options.gameNumber ?? 0 },
      };
      store.set(
        tabsAtom,
        (prev) => prev.map((tab) => (tab.value === ownerId ? opened : tab)),
        tabId,
      );
      store.set(tabFamily(tabId), "practice");
      store.set(practiceTabFamily(tabId), "train");
      store.set(practiceSegmentGateFamily(tabId), { synced: true, status: "ready" });
      return tabId;
    },
  );
}

describe("PlayerPreparation training run", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetPracticeMigrationForTests();
    invalidateFileDeckAtoms(keyA);
    invalidateFileDeckAtoms(keyB);
    harness.createTabOverride = null;
    store = createStore();
    harness.store = store;
    store.set(fileWorkspaceAtom, workspace);
    store.set(opponentPreparationAtom, null);
    store.set(tabsAtom, []);
    store.set(activeTabAtom, null);
    store.set(timedRunLaunchAtom, null);
    store.set(timedRunAtom, null);
    store.set(practiceTrainMinutesAtom, 15);
    store.set(practiceNewPerSessionAtom, 2);

    harness.refreshRepertoireIndex.mockResolvedValue(undefined);
    harness.readRepertoireIndex.mockReturnValue(twoChapterSnapshot());
    harness.fetchBatchStatistics.mockResolvedValue(twoChapterStats());
    harness.openFile.mockReset();
    harness.closeTab.mockReset().mockResolvedValue(undefined);
    harness.navigate.mockResolvedValue(undefined);
    harness.tauri.listPracticeDecks.mockResolvedValue({ decks: [], anomalies: [] });
    harness.tauri.readPracticeEpoch.mockResolvedValue({ epoch: "epoch-1" });
    harness.tauri.loadPracticeDeck.mockResolvedValue({ epoch: "epoch-1", deck: null });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    invalidateFileDeckAtoms(keyA);
    invalidateFileDeckAtoms(keyB);
    harness.store = null;
  });

  const renderWithOwner = async (mountOwner = false) => {
    await act(async () => {
      root.render(
        <Provider store={store}>
          <MantineProvider>
            <PlayerPreparation player={player} file={cardDb} />
            {mountOwner && <TimedRunOwner />}
          </MantineProvider>
        </Provider>,
      );
    });
    await vi.waitFor(() => {
      expect(container.querySelector("[data-preparation-train]")).not.toBeNull();
    });
  };

  test("disables Train these lines with a reason when the preparation has no trainable candidate", async () => {
    // Only the root (opponent to move) is played -> no user-to-move continuing node in scope.
    harness.fetchBatchStatistics.mockResolvedValue(
      new Map([[INITIAL_BOARD_STATE, [statRow("e4", 5)]]]),
    );
    await renderWithOwner();

    const startBtn = container.querySelector<HTMLButtonElement>("[data-preparation-train-start]")!;
    expect(startBtn.disabled).toBe(true);
    expect(container.querySelector("[data-preparation-train-disabled-reason]")).not.toBeNull();
  });

  test("reads never-mounted decks, skips unreadable chapters with notification, keeps all unseen past new-per-session, and writes no deck", async () => {
    // Chapter A has 5 unseen positions (> practiceNewPerSessionAtom = 2) and a stored deck with 1 due card.
    const manyNodes: RepertoireChapterNode[] = [
      {
        boardState: INITIAL_BOARD_STATE,
        parent: -1,
        san: null,
        path: [],
        halfMoves: 0,
        hasContinuation: true,
      },
    ];
    const stats = new Map<string, PositionStats[]>([
      [INITIAL_BOARD_STATE, [statRow("e4", 10), statRow("d4", 6)]],
      [AFTER_D4, [statRow("Nf6", 6)]],
    ]);
    for (let i = 0; i < 5; i++) {
      const pos = `pos-black-${i} b - -`;
      manyNodes.push({
        boardState: pos,
        parent: 0,
        san: `m${i}`,
        path: [i],
        halfMoves: 1,
        hasContinuation: true,
      });
      stats.set(pos, [statRow("c5", 5 - i)]);
    }
    harness.readRepertoireIndex.mockReturnValue({
      files: [
        {
          workspaceKey: keyA,
          file: repFileA,
          partial: false,
          chapters: [
            {
              chapter: 0,
              headers: { orientation: "black", white: "Sicilian", black: "Mainline", event: "?" },
              nodes: manyNodes,
            },
          ],
        },
        twoChapterSnapshot().files[1],
      ],
      partial: false,
      partialReason: null,
    });
    harness.fetchBatchStatistics.mockResolvedValue(stats);

    // File A deck loads with 1 due card; File B deck fails to read.
    harness.tauri.loadPracticeDeck.mockImplementation((fileId: string) => {
      if (fileId === keyB) return Promise.reject(new Error("disk read failed"));
      return Promise.resolve({
        epoch: "epoch-1",
        deck: {
          generation: 0,
          revision: 1,
          positionsDocument: JSON.stringify({
            positions: [makeStoredPosition("pos-black-0 b - -", 2, 0.5)],
          }),
          unappliedReviews: 0,
          orphansAcknowledged: true,
        },
      });
    });

    await renderWithOwner();

    const startBtn = container.querySelector<HTMLButtonElement>("[data-preparation-train-start]")!;
    expect(startBtn.disabled).toBe(false);
    await act(async () => startBtn.click());

    await vi.waitFor(() => {
      expect(store.get(timedRunLaunchAtom)).not.toBeNull();
    });

    const launch = store.get(timedRunLaunchAtom)!;
    // 1 due + 4 unseen (exceeding practiceNewPerSessionAtom = 2 -> all 5 stay).
    expect(launch.candidates).toHaveLength(5);
    expect(launch.candidates[0]).toMatchObject({
      file: keyA,
      game: 0,
      positionKey: "pos-black-0 b - -",
      kind: "due",
    });
    expect(launch.candidates.slice(1).every((c) => c.kind === "unseen")).toBe(true);
    expect(launch.chapters).toEqual([{ file: keyA, game: 0, metadata: repFileA }]);

    // Notification reports 1 chapter left out.
    expect(harness.notifyShow).toHaveBeenCalledWith(
      expect.objectContaining({
        color: "warning",
        message: expect.stringContaining("ChaptersSkipped(count=1)"),
      }),
    );
    expect(harness.navigate).toHaveBeenCalledWith({ to: "/" });

    // No deck write and no prepareTimedRunWeights call.
    expect(harness.tauri.syncPracticePositions).not.toHaveBeenCalled();
    expect(harness.tauri.recordPracticeReview).not.toHaveBeenCalled();
    expect(harness.tauri.resetPracticeDeck).not.toHaveBeenCalled();
    expect(harness.prepareTimedRunWeights).not.toHaveBeenCalled();
  });

  test("when every deck is unreadable, launches nothing, opens no tab, stays on Preparation tab, and re-enables start", async () => {
    harness.tauri.loadPracticeDeck.mockRejectedValue(new Error("store unreadable"));

    await renderWithOwner();
    const startBtn = container.querySelector<HTMLButtonElement>("[data-preparation-train-start]")!;
    await act(async () => startBtn.click());

    await vi.waitFor(() => {
      expect(container.querySelector("[data-preparation-train-error]")).not.toBeNull();
    });
    expect(store.get(timedRunLaunchAtom)).toBeNull();
    expect(store.get(tabsAtom)).toEqual([]);
    expect(harness.navigate).not.toHaveBeenCalled();
    expect(startBtn.disabled).toBe(false);
  });

  test("when New Tab creation fails or is refused, launches nothing and reports only failures", async () => {
    await renderWithOwner();
    const startBtn = container.querySelector<HTMLButtonElement>("[data-preparation-train-start]")!;

    // 1. Failure (throws): reported like the "new tab" command, nothing launched, start re-enabled.
    const tabError = new Error("storage quota exceeded");
    harness.createTabOverride = async () => {
      throw tabError;
    };
    await act(async () => startBtn.click());
    await vi.waitFor(() => {
      expect(harness.notifyUnlessCancelled).toHaveBeenCalledWith("Common.Error", tabError);
    });
    expect(store.get(timedRunLaunchAtom)).toBeNull();
    expect(harness.navigate).not.toHaveBeenCalled();
    expect(startBtn.disabled).toBe(false);

    // 2. Refused / cancelled (returns null): reports nothing, nothing launched, start re-enabled.
    harness.notifyUnlessCancelled.mockClear();
    harness.createTabOverride = async () => null;
    await act(async () => startBtn.click());
    await vi.waitFor(() => {
      expect(startBtn.disabled).toBe(false);
    });
    expect(harness.notifyUnlessCancelled).not.toHaveBeenCalled();
    expect(store.get(timedRunLaunchAtom)).toBeNull();
    expect(harness.navigate).not.toHaveBeenCalled();
  });

  test("with real TimedRunOwner: reaches first segment when started with no board tab open", async () => {
    expect(store.get(tabsAtom)).toEqual([]);
    expect(store.get(activeTabAtom)).toBeNull();
    installRealOwnerOpenFileMock(store);

    await renderWithOwner(true);

    const startBtn = container.querySelector<HTMLButtonElement>("[data-preparation-train-start]")!;
    await act(async () => startBtn.click());

    await vi.waitFor(() => {
      const run = store.get(timedRunAtom);
      expect(run?.phase).toBe("running");
      expect(run?.currentSegment?.status).toBe("active");
    });

    const run = store.get(timedRunAtom)!;
    const tabId = run.currentSegment!.tabId!;
    // First segment replaced the New Tab created by the start.
    expect(store.get(tabsAtom).some((t) => t.value === run.newTabId)).toBe(false);
    expect(store.get(tabsAtom).some((t) => t.value === tabId)).toBe(true);
    const request = store.get(practiceRunRequestFamily(tabId));
    expect(request).toMatchObject({
      runId: run.id,
      positionKeys: [AFTER_E4],
    });
  });

  test("with real TimedRunOwner: reaches first segment when an analysis tab on another panel is active", async () => {
    const otherTab: Tab = {
      value: "other-analysis",
      name: "Other Game",
      type: "analysis",
      gameOrigin: { kind: "none" },
    };
    store.set(tabsAtom, [otherTab]);
    store.set(activeTabAtom, "other-analysis");
    store.set(tabFamily("other-analysis"), "info");
    installRealOwnerOpenFileMock(store);

    await renderWithOwner(true);

    const startBtn = container.querySelector<HTMLButtonElement>("[data-preparation-train-start]")!;
    await act(async () => startBtn.click());

    await vi.waitFor(() => {
      const run = store.get(timedRunAtom);
      expect(run?.phase).toBe("running");
      expect(run?.currentSegment?.status).toBe("active");
    });

    const run = store.get(timedRunAtom)!;
    const tabId = run.currentSegment!.tabId!;
    expect(store.get(tabsAtom).some((t) => t.value === run.newTabId)).toBe(false);
    expect(tabId).not.toBe("other-analysis");
    const request = store.get(practiceRunRequestFamily(tabId));
    expect(request).toMatchObject({
      runId: run.id,
      positionKeys: [AFTER_E4],
    });
  });

  test("with real TimedRunOwner: consumes the unused launch New Tab when the first candidate chapter is already open", async () => {
    const existingTab: Tab = {
      value: "existing-rep-a",
      name: repFileA.name,
      type: "analysis",
      gameOrigin: { kind: "file", file: repFileA, gameNumber: 0 },
    };
    store.set(tabsAtom, [existingTab]);
    store.set(activeTabAtom, "existing-rep-a");
    store.set(tabFamily("existing-rep-a"), "info");
    store.set(practiceTabFamily("existing-rep-a"), "build");
    store.set(practiceSegmentGateFamily("existing-rep-a"), { synced: true, status: "ready" });

    harness.closeTab.mockImplementation(async (tabId: string | null) => {
      if (!tabId) return;
      const current = store.get(tabsAtom);
      const index = current.findIndex((tab) => tab.value === tabId);
      if (index === -1) return;
      const remaining = current.filter((tab) => tab.value !== tabId);
      store.set(tabsAtom, remaining);
      if (store.get(activeTabAtom) === tabId) {
        store.set(activeTabAtom, remaining[index]?.value ?? remaining[index - 1]?.value ?? null);
      }
    });

    await renderWithOwner(true);

    const startBtn = container.querySelector<HTMLButtonElement>("[data-preparation-train-start]")!;
    await act(async () => startBtn.click());

    await vi.waitFor(() => {
      const run = store.get(timedRunAtom);
      expect(run?.phase).toBe("running");
      expect(run?.currentSegment?.status).toBe("active");
    });

    const run = store.get(timedRunAtom)!;
    expect(harness.openFile).not.toHaveBeenCalled();
    expect(harness.closeTab).toHaveBeenCalledWith(run.newTabId);
    expect(store.get(tabsAtom).some((t) => t.value === run.newTabId)).toBe(false);
    expect(store.get(tabsAtom).map((t) => t.value)).toEqual(["existing-rep-a"]);
    expect(store.get(activeTabAtom)).toBe("existing-rep-a");
    expect(run.currentSegment?.tabId).toBe("existing-rep-a");
    expect(store.get(practiceRunRequestFamily("existing-rep-a"))).toMatchObject({
      runId: run.id,
      positionKeys: [AFTER_E4],
    });
  });

  test("keeps Train these lines enabled when returning to a stored preparation while a repertoire refresh is in flight", async () => {
    await renderWithOwner();
    await act(async () => root.unmount());

    // Simulate Coach starting a repertoire refresh so readRepertoireIndex returns null.
    harness.readRepertoireIndex.mockReturnValue(null);
    root = createRoot(container);
    await renderWithOwner();

    const startBtn = container.querySelector<HTMLButtonElement>("[data-preparation-train-start]")!;
    expect(startBtn.disabled).toBe(false);
    expect(container.querySelector("[data-preparation-train-disabled-reason]")).toBeNull();
  });

  test("clears timedRunLaunchAtom when navigate rejects (without clearing a newer launch)", async () => {
    const navError = new Error("navigation failed");
    harness.navigate.mockRejectedValueOnce(navError);

    await renderWithOwner();
    const startBtn = container.querySelector<HTMLButtonElement>("[data-preparation-train-start]")!;
    await act(async () => startBtn.click());

    await vi.waitFor(() => {
      expect(harness.notifyUnlessCancelled).toHaveBeenCalledWith("Common.Error", navError);
    });
    expect(store.get(timedRunLaunchAtom)).toBeNull();

    // If a newer launch replaced timedRunLaunchAtom before navigate rejects, keep the newer one.
    const navGate = deferred<void>();
    harness.navigate.mockReturnValueOnce(navGate.promise);
    await act(async () => startBtn.click());
    await vi.waitFor(() => {
      expect(store.get(timedRunLaunchAtom)).not.toBeNull();
    });
    const newerLaunch = { ...store.get(timedRunLaunchAtom)!, id: "newer-launch" };
    store.set(timedRunLaunchAtom, newerLaunch);
    await act(async () => {
      navGate.reject(new Error("late nav failure"));
    });
    expect(store.get(timedRunLaunchAtom)?.id).toBe("newer-launch");
  });

  test("uses the minutes chosen in the duration control for launch.deadline", async () => {
    await renderWithOwner();

    const radio45 = container.querySelector<HTMLInputElement>(
      '[data-preparation-train] input[value="45"]',
    )!;
    await act(async () => radio45.click());

    const startBtn = container.querySelector<HTMLButtonElement>("[data-preparation-train-start]")!;
    await act(async () => startBtn.click());

    await vi.waitFor(() => {
      expect(store.get(timedRunLaunchAtom)).not.toBeNull();
    });
    const launch = store.get(timedRunLaunchAtom)!;
    expect(launch.deadline).toBe(launch.startedAt + 45 * 60 * 1000);
  });

  test("unmount during readPreparationDecks or createTab launches nothing", async () => {
    // 1. Unmount during deck read
    const deckGate = deferred<{ epoch: string; deck: null }>();
    harness.tauri.loadPracticeDeck.mockReturnValue(deckGate.promise);
    await renderWithOwner();

    const startBtn = container.querySelector<HTMLButtonElement>("[data-preparation-train-start]")!;
    await act(async () => startBtn.click());
    await vi.waitFor(() => {
      expect(harness.tauri.loadPracticeDeck).toHaveBeenCalled();
    });

    await act(async () => root.unmount());
    await act(async () => deckGate.resolve({ epoch: "epoch-1", deck: null }));
    expect(store.get(timedRunLaunchAtom)).toBeNull();
    expect(store.get(tabsAtom)).toEqual([]);
    expect(harness.navigate).not.toHaveBeenCalled();

    // 2. Unmount during createTab
    harness.tauri.loadPracticeDeck.mockResolvedValue({ epoch: "epoch-1", deck: null });
    const tabGate = deferred<string | null>();
    const createTabSpy = vi.fn(() => tabGate.promise);
    harness.createTabOverride = createTabSpy;
    root = createRoot(container);
    await renderWithOwner();

    const startBtn2 = container.querySelector<HTMLButtonElement>("[data-preparation-train-start]")!;
    await act(async () => startBtn2.click());
    await vi.waitFor(() => {
      expect(createTabSpy).toHaveBeenCalledTimes(1);
    });

    await act(async () => root.unmount());
    await act(async () => tabGate.resolve("late-new-tab"));
    expect(store.get(timedRunLaunchAtom)).toBeNull();
    expect(harness.navigate).not.toHaveBeenCalled();

    // Re-create root for afterEach cleanup.
    root = createRoot(container);
  });

  test("changing preparation during start aborts the launch, and a second click while starting launches only once", async () => {
    // 1. Changing preparation (Refresh) while deck read is in flight aborts launch.
    const deckGate = deferred<{ epoch: string; deck: null }>();
    harness.tauri.loadPracticeDeck.mockReturnValue(deckGate.promise);
    await renderWithOwner();

    const startBtn = container.querySelector<HTMLButtonElement>("[data-preparation-train-start]")!;
    await act(async () => startBtn.click());
    await vi.waitFor(() => {
      expect(harness.tauri.loadPracticeDeck).toHaveBeenCalled();
    });

    // Click Refresh to start a new preparation (changes preparationId).
    const refreshBtn = container.querySelector<HTMLButtonElement>("[data-preparation-refresh]")!;
    await act(async () => refreshBtn.click());
    await act(async () => deckGate.resolve({ epoch: "epoch-1", deck: null }));
    expect(store.get(timedRunLaunchAtom)).toBeNull();
    expect(harness.navigate).not.toHaveBeenCalled();

    // 2. Second click while starting launches only one run.
    await vi.waitFor(() => {
      expect(container.querySelector("[data-preparation-train-start]")).not.toBeNull();
    });
    const tabGate = deferred<string | null>();
    const createTabSpy = vi.fn(() => tabGate.promise);
    harness.createTabOverride = createTabSpy;
    harness.tauri.loadPracticeDeck.mockResolvedValue({ epoch: "epoch-1", deck: null });

    const startBtn2 = container.querySelector<HTMLButtonElement>("[data-preparation-train-start]")!;
    await act(async () => {
      startBtn2.click();
      startBtn2.click();
    });
    await vi.waitFor(() => {
      expect(createTabSpy).toHaveBeenCalledTimes(1);
    });
    await act(async () => tabGate.resolve("single-tab"));
    await vi.waitFor(() => {
      expect(store.get(timedRunLaunchAtom)?.newTabId).toBe("single-tab");
    });
    expect(createTabSpy).toHaveBeenCalledTimes(1);
  });
});
