import { MantineProvider } from "@mantine/core";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DatabaseHandle, FileWorkspaceHandle, Player, PositionStats } from "@/bindings";
import type { FileMetadata } from "@/components/files/file";
import {
  activeTabAtom,
  fileWorkspaceAtom,
  opponentPreparationAtom,
  tabPreparationViewFamily,
  tabsAtom,
} from "@/state/atoms";
import { activeDatabaseViewStore } from "@/state/store/database";
import type { RepertoireSnapshot } from "@/state/repertoireIndex";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { INITIAL_BOARD_STATE } from "@/utils/opponentPreparation";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import type { Tab } from "@/utils/tabs";
import PersonalPlayerCard from "../home/PersonalCard";
import { DatabaseViewStateContext } from "./DatabaseViewStateContext";
import type { OnlineGames } from "./useOnlineGames";
import PlayerPreparation from "./PlayerPreparation";

const mocks = vi.hoisted(() => ({
  refreshRepertoireIndex: vi.fn(),
  readRepertoireIndex: vi.fn(),
  fetchBatchStatistics: vi.fn(),
  useOnlineGames: vi.fn(),
  openFile: vi.fn(),
  navigate: vi.fn(),
  notifyUnlessCancelled: vi.fn(),
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
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@/components/panels/database/DatabaseLoader", () => ({
  default: ({ label, progressId }: { label: string; progressId: string }) => (
    <div data-database-loader data-progress-id={progressId}>
      {label}
    </div>
  ),
}));
vi.mock("@/state/repertoireIndex", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/repertoireIndex")>()),
  refreshRepertoireIndex: mocks.refreshRepertoireIndex,
  readRepertoireIndex: mocks.readRepertoireIndex,
}));
vi.mock("@/utils/repertoire", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/repertoire")>()),
  fetchBatchStatistics: mocks.fetchBatchStatistics,
}));
vi.mock("./useOnlineGames", () => ({
  useOnlineGames: mocks.useOnlineGames,
}));
vi.mock("@/utils/openFile", () => ({
  openFile: mocks.openFile,
}));
vi.mock("@/components/files/notifyError", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/files/notifyError")>()),
  notifyUnlessCancelled: mocks.notifyUnlessCancelled,
}));
vi.mock("../common/FideInfo", () => ({ default: () => null }));
vi.mock("./PlayerOpeningTree", () => ({ default: () => null }));
vi.mock("../home/PersonalCardPanels/OverviewPanel", () => ({ default: () => null }));
vi.mock("../home/PersonalCardPanels/RatingsPanel", () => ({ default: () => null }));
vi.mock("../home/PersonalCardPanels/OpeningsPanel", () => ({ default: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

const workspace: FileWorkspaceHandle = { id: { id: "ws-1" }, kind: "fileWorkspace" };
const cardDb: DatabaseHandle = { id: { id: "db-otb" }, kind: "database" };
const onlineDb: DatabaseHandle = { id: { id: "db-online" }, kind: "database" };
const player: Player = { id: 7, name: "Carlsen, Magnus", elo: 2830, game_count: 50 };

const repFile: FileMetadata = {
  type: "file",
  name: "Black vs e4",
  handle: { id: { id: "file-black" }, kind: "fileWorkspace" },
  numGames: 1,
  metadata: { type: "repertoire", tags: [] },
  lastModified: 1,
};

const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -";
const AFTER_E4_C5 = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -";

function makeSnapshot(overrides?: Partial<RepertoireSnapshot>): RepertoireSnapshot {
  return {
    files: [
      {
        workspaceKey: fileWorkspaceKey(repFile.handle),
        file: repFile,
        partial: false,
        chapters: [
          {
            chapter: 0,
            headers: {
              orientation: "black",
              white: "Sicilian",
              black: "Mainline",
              event: "?",
            },
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
    ],
    partial: false,
    partialReason: null,
    ...overrides,
  };
}

function statRow(move: string, white: number, last_played = "2026.05.10"): PositionStats {
  return {
    move,
    white,
    draw: 0,
    black: 0,
    unknown: 0,
    last_played,
    year_counts: [],
  };
}

function makeStatsMap(): Map<string, PositionStats[]> {
  return new Map([
    [INITIAL_BOARD_STATE, [statRow("e4", 10), statRow("d4", 4)]],
    [AFTER_E4, [statRow("c5", 6)]],
    [AFTER_E4_C5, [statRow("Nf3", 6, "2026.08.01")]],
  ]);
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

describe("PlayerPreparation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createStore();
    store.set(fileWorkspaceAtom, workspace);
    store.set(opponentPreparationAtom, null);
    store.set(tabsAtom, []);
    store.set(activeTabAtom, null);
    mocks.useOnlineGames.mockReturnValue(undefined);
    mocks.refreshRepertoireIndex.mockResolvedValue(undefined);
    mocks.readRepertoireIndex.mockReturnValue(makeSnapshot());
    mocks.fetchBatchStatistics.mockResolvedValue(makeStatsMap());
    mocks.navigate.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const renderTab = async (online?: OnlineGames, targetPlayer: Player = player) => {
    mocks.useOnlineGames.mockReturnValue(online);
    await act(async () => {
      root.render(
        <Provider store={store}>
          <MantineProvider>
            <PlayerPreparation player={targetPlayer} file={cardDb} />
          </MantineProvider>
        </Provider>,
      );
    });
  };

  test("unreadable repertoire shows failure state with Retry and never 'no repertoire'", async () => {
    mocks.readRepertoireIndex.mockReturnValue(
      makeSnapshot({ files: [], partial: true, partialReason: "listing-failed" }),
    );
    await renderTab();

    await vi.waitFor(() => {
      expect(container.querySelector("[data-preparation-repertoire-error]")).not.toBeNull();
    });
    expect(container.querySelector("[data-preparation-empty-repertoire]")).toBeNull();
    expect(mocks.fetchBatchStatistics).not.toHaveBeenCalled();

    // Retry recovers when repertoire becomes readable.
    mocks.readRepertoireIndex.mockReturnValue(makeSnapshot());
    const retryBtn = container.querySelector<HTMLButtonElement>(
      "[data-preparation-repertoire-error] button",
    )!;
    await act(async () => retryBtn.click());

    await vi.waitFor(() => {
      expect(container.querySelector("[data-preparation-lines]")).not.toBeNull();
    });
    expect(mocks.fetchBatchStatistics).toHaveBeenCalledTimes(1);
  });

  test("partial index with no chapters of user's colour is reported as repertoire failure", async () => {
    mocks.readRepertoireIndex.mockReturnValue(
      makeSnapshot({ files: [], partial: true, partialReason: "read-failed" }),
    );
    await renderTab();

    await vi.waitFor(() => {
      expect(container.querySelector("[data-preparation-repertoire-error]")).not.toBeNull();
    });
    expect(container.querySelector("[data-preparation-empty-repertoire]")).toBeNull();
    expect(mocks.fetchBatchStatistics).not.toHaveBeenCalled();
  });

  test("empty repertoire states (no workspace, no files, no matching colour) start no search", async () => {
    // 1. No workspace
    store.set(fileWorkspaceAtom, null);
    await renderTab();
    expect(
      container.querySelector('[data-preparation-empty-repertoire="no-workspace"]'),
    ).not.toBeNull();
    expect(mocks.fetchBatchStatistics).not.toHaveBeenCalled();

    // 2. No files
    store.set(fileWorkspaceAtom, workspace);
    mocks.readRepertoireIndex.mockReturnValue({
      files: [],
      partial: false,
      partialReason: null,
    });
    await renderTab();
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-preparation-empty-repertoire="no-files"]'),
      ).not.toBeNull();
    });
    expect(mocks.fetchBatchStatistics).not.toHaveBeenCalled();

    // 3. No chapters of user's colour (opponent plays White -> user needs Black, only White exists)
    mocks.readRepertoireIndex.mockReturnValue(
      makeSnapshot({
        files: [
          {
            ...makeSnapshot().files[0],
            chapters: [
              {
                ...makeSnapshot().files[0].chapters[0],
                headers: { orientation: "white", white: "White rep", black: "?", event: "?" },
              },
            ],
          },
        ],
      }),
    );
    const refreshBtn = container.querySelector<HTMLButtonElement>("[data-preparation-refresh]")!;
    await act(async () => refreshBtn.click());
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-preparation-empty-repertoire="no-color-chapters"]'),
      ).not.toBeNull();
    });
    expect(mocks.fetchBatchStatistics).not.toHaveBeenCalled();
  });

  test("partial repertoire with chapters shows results alongside a partial notice", async () => {
    mocks.readRepertoireIndex.mockReturnValue(
      makeSnapshot({ partial: true, partialReason: "bound-reached" }),
    );
    await renderTab();

    await vi.waitFor(() => {
      expect(container.querySelector("[data-preparation-partial]")).not.toBeNull();
      expect(container.querySelector("[data-preparation-lines]")).not.toBeNull();
      expect(container.querySelector("[data-preparation-gaps]")).not.toBeNull();
    });
  });

  test("opponent with no games shows empty state naming the selection", async () => {
    mocks.fetchBatchStatistics.mockResolvedValue(new Map());
    await renderTab();

    await vi.waitFor(() => {
      const noGames = container.querySelector("[data-preparation-no-games]");
      expect(noGames).not.toBeNull();
      expect(noGames?.textContent).toContain("Carlsen");
    });
  });

  test("card search failure shows inline error with Retry and aborts the same run's online search", async () => {
    const otbDeferred = deferred<Map<string, PositionStats[]>>();
    const onlineDeferred = deferred<Map<string, PositionStats[]>>();
    let onlineSignal: AbortSignal | undefined;

    mocks.fetchBatchStatistics.mockImplementation(
      (_fens: string[], db: DatabaseHandle, _filter: unknown, signal?: AbortSignal) => {
        if (db.id.id === onlineDb.id.id) {
          onlineSignal = signal;
          return onlineDeferred.promise;
        }
        return otbDeferred.promise;
      },
    );

    await renderTab({
      file: onlineDb,
      accounts: [{ provider: "lichess", username: "DrNykterstein" }],
      lookup: { kind: "found", player: 99 },
    });

    await vi.waitFor(() => {
      expect(mocks.fetchBatchStatistics).toHaveBeenCalledTimes(2);
    });
    expect(onlineSignal?.aborted).toBe(false);

    await act(async () => {
      otbDeferred.reject(new Error("database corrupt"));
    });

    await vi.waitFor(() => {
      expect(container.querySelector("[data-preparation-search-error]")).not.toBeNull();
    });
    expect(onlineSignal?.aborted).toBe(true);

    // Retry works.
    mocks.fetchBatchStatistics.mockResolvedValue(makeStatsMap());
    const retryBtn = container.querySelector<HTMLButtonElement>(
      "[data-preparation-search-error] button",
    )!;
    await act(async () => retryBtn.click());
    await vi.waitFor(() => {
      expect(container.querySelector("[data-preparation-lines]")).not.toBeNull();
    });
  });

  test("online unavailable or failed keeps OTB results, disables Online & Both, and shows notice", async () => {
    // Case 1: lookup unavailable
    await renderTab({
      file: onlineDb,
      accounts: [{ provider: "lichess", username: "DrNykterstein" }],
      lookup: { kind: "unavailable" },
    });

    await vi.waitFor(() => {
      expect(container.querySelector("[data-preparation-lines]")).not.toBeNull();
    });
    expect(container.querySelector("[data-preparation-online-unavailable]")).not.toBeNull();
    expect(
      container.querySelector<HTMLInputElement>('[data-preparation-source] input[value="online"]')
        ?.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLInputElement>('[data-preparation-source] input[value="both"]')
        ?.disabled,
    ).toBe(true);

    // Case 2: lookup found, online search fails
    store.set(opponentPreparationAtom, null);
    mocks.fetchBatchStatistics.mockImplementation((_fens: string[], db: DatabaseHandle) => {
      if (db.id.id === onlineDb.id.id) {
        return Promise.reject(new Error("online db error"));
      }
      return Promise.resolve(makeStatsMap());
    });
    await renderTab({
      file: onlineDb,
      accounts: [{ provider: "lichess", username: "DrNykterstein" }],
      lookup: { kind: "found", player: 99 },
    });

    await vi.waitFor(() => {
      expect(container.querySelector("[data-preparation-online-unavailable]")).not.toBeNull();
      expect(container.querySelector("[data-preparation-lines]")).not.toBeNull();
    });
    expect(
      container.querySelector<HTMLInputElement>('[data-preparation-source] input[value="online"]')
        ?.disabled,
    ).toBe(true);
  });

  test("stale result after identity change is dropped", async () => {
    const whiteRun = deferred<Map<string, PositionStats[]>>();
    const blackRun = deferred<Map<string, PositionStats[]>>();
    let whiteSignal: AbortSignal | undefined;

    mocks.readRepertoireIndex.mockReturnValue(
      makeSnapshot({
        files: [
          {
            ...makeSnapshot().files[0],
            chapters: [
              makeSnapshot().files[0].chapters[0],
              {
                chapter: 1,
                headers: { orientation: "white", white: "White vs c5", black: "?", event: "?" },
                nodes: [
                  {
                    boardState: INITIAL_BOARD_STATE,
                    parent: -1,
                    san: null,
                    path: [],
                    halfMoves: 0,
                    hasContinuation: false,
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    mocks.fetchBatchStatistics.mockImplementation(
      (
        _fens: string[],
        _db: DatabaseHandle,
        filter: { player1?: number | null; player2?: number | null },
        signal?: AbortSignal,
      ) => {
        if (filter.player1 != null) {
          whiteSignal = signal;
          return whiteRun.promise;
        }
        return blackRun.promise;
      },
    );

    await renderTab();
    await vi.waitFor(() => expect(mocks.fetchBatchStatistics).toHaveBeenCalledTimes(1));

    // Switch opponent colour to Black before White run finishes.
    const blackRadio = container.querySelector<HTMLInputElement>(
      '[data-preparation-toolbar] input[value="black"]',
    )!;
    await act(async () => blackRadio.click());
    await vi.waitFor(() => expect(mocks.fetchBatchStatistics).toHaveBeenCalledTimes(2));
    expect(whiteSignal?.aborted).toBe(true);

    // Late arrival from first run is ignored.
    await act(async () => {
      whiteRun.resolve(makeStatsMap());
    });
    expect(store.get(opponentPreparationAtom)).toBeNull();

    // Current run settles and applies.
    await act(async () => {
      blackRun.resolve(new Map([[INITIAL_BOARD_STATE, [statRow("e4", 3)]]]));
    });
    await vi.waitFor(() => {
      expect(store.get(opponentPreparationAtom)?.opponentColor).toBe("black");
    });
  });

  test("Refresh aborts earlier run and drops its late result", async () => {
    const firstRun = deferred<Map<string, PositionStats[]>>();
    const secondRun = deferred<Map<string, PositionStats[]>>();
    let firstSignal: AbortSignal | undefined;
    let callCount = 0;

    mocks.fetchBatchStatistics.mockImplementation(
      (_fens: string[], _db: DatabaseHandle, _filter: unknown, signal?: AbortSignal) => {
        callCount += 1;
        if (callCount === 1) {
          firstSignal = signal;
          return firstRun.promise;
        }
        return secondRun.promise;
      },
    );

    await renderTab();
    await vi.waitFor(() => expect(callCount).toBe(1));

    const refreshBtn = container.querySelector<HTMLButtonElement>("[data-preparation-refresh]")!;
    await act(async () => refreshBtn.click());
    await vi.waitFor(() => expect(callCount).toBe(2));
    expect(firstSignal?.aborted).toBe(true);

    // First run resolves late -> ignored.
    await act(async () => {
      firstRun.resolve(new Map([[INITIAL_BOARD_STATE, [statRow("e4", 99)]]]));
    });
    expect(store.get(opponentPreparationAtom)).toBeNull();

    // Second run resolves -> applied.
    await act(async () => {
      secondRun.resolve(makeStatsMap());
    });
    await vi.waitFor(() => {
      expect(store.get(opponentPreparationAtom)?.views.otb.total).toBe(14);
    });
  });

  test("unmounting aborts the in-flight search", async () => {
    const run = deferred<Map<string, PositionStats[]>>();
    let capturedSignal: AbortSignal | undefined;
    mocks.fetchBatchStatistics.mockImplementation(
      (_fens: string[], _db: DatabaseHandle, _filter: unknown, signal?: AbortSignal) => {
        capturedSignal = signal;
        return run.promise;
      },
    );

    await renderTab();
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    expect(capturedSignal?.aborted).toBe(false);

    await act(async () => root.unmount());
    expect(capturedSignal?.aborted).toBe(true);
    // Re-create root for afterEach cleanup.
    root = createRoot(container);
  });

  test("opening a line reuses an existing chapter tab and sets its preparation view", async () => {
    const existingTab: Tab = {
      name: "Sicilian",
      value: "existing-tab-1",
      type: "analysis",
      gameOrigin: { kind: "file", file: repFile, gameNumber: 0 },
    };
    store.set(tabsAtom, [existingTab]);
    await renderTab();

    await vi.waitFor(() => {
      expect(container.querySelector("[data-preparation-line-row]")).not.toBeNull();
    });

    const row = container.querySelector<HTMLTableRowElement>("[data-preparation-line-row]")!;
    await act(async () => row.click());

    expect(mocks.openFile).not.toHaveBeenCalled();
    expect(store.get(activeTabAtom)).toBe("existing-tab-1");
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/" });
    const view = store.get(tabPreparationViewFamily("existing-tab-1"));
    expect(view).toEqual({
      preparationId: store.get(opponentPreparationAtom)!.id,
      landing: { path: [0, 0], boardState: AFTER_E4_C5 },
      showAllLines: false,
    });
  });

  test("opening a line opens a new tab, ignores overlapping activation, and reports failures without navigating", async () => {
    const openDeferred = deferred<string | null>();
    mocks.openFile.mockReturnValue(openDeferred.promise);
    await renderTab();

    await vi.waitFor(() => {
      expect(container.querySelector("[data-preparation-line-row]")).not.toBeNull();
    });

    const row = container.querySelector<HTMLTableRowElement>("[data-preparation-line-row]")!;
    // First click starts opening; second click while opening is ignored.
    await act(async () => {
      row.click();
      row.click();
    });
    expect(mocks.openFile).toHaveBeenCalledTimes(1);

    await act(async () => {
      openDeferred.resolve("new-tab-2");
    });
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/" });
    expect(store.get(tabPreparationViewFamily("new-tab-2"))).toEqual({
      preparationId: store.get(opponentPreparationAtom)!.id,
      landing: { path: [0, 0], boardState: AFTER_E4_C5 },
      showAllLines: false,
    });

    // Failure: stays on Preparation tab, sets no preparation view, reports failure via files domain.
    mocks.navigate.mockClear();
    const failure = new Error("file missing");
    mocks.openFile.mockRejectedValueOnce(failure);
    await act(async () => row.click());
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.notifyUnlessCancelled).toHaveBeenCalledWith("Common.Error", failure, "files");

    // Refused/cancelled tab creation (resolves null): reports nothing and does not navigate.
    mocks.notifyUnlessCancelled.mockClear();
    mocks.openFile.mockResolvedValueOnce(null);
    await act(async () => row.click());
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
  });

  test("selected Online source survives a period change and remount as the single owner in opponentPreparationAtom", async () => {
    const otbStats = new Map([
      [INITIAL_BOARD_STATE, [statRow("e4", 10)]],
      [AFTER_E4, [statRow("c5", 6)]],
      [AFTER_E4_C5, [statRow("Nf3", 6, "2026.08.01")]],
    ]);
    const onlineStats = new Map([
      [INITIAL_BOARD_STATE, [statRow("e4", 20), statRow("d4", 5)]],
      [AFTER_E4, [statRow("c5", 15)]],
      [AFTER_E4_C5, [statRow("Nc3", 15, "2026.10.01")]],
    ]);
    mocks.fetchBatchStatistics.mockImplementation((_fens: string[], db: DatabaseHandle) =>
      Promise.resolve(db.id.id === onlineDb.id.id ? onlineStats : otbStats),
    );
    const online: OnlineGames = {
      file: onlineDb,
      accounts: [{ provider: "lichess", username: "DrNykterstein" }],
      lookup: { kind: "found", player: 99 },
    };

    await renderTab(online);
    await vi.waitFor(() => {
      expect(container.querySelector("[data-preparation-lines]")).not.toBeNull();
    });

    // Switch to Online.
    const onlineRadio = container.querySelector<HTMLInputElement>(
      '[data-preparation-source] input[value="online"]',
    )!;
    await act(async () => onlineRadio.click());
    expect(store.get(opponentPreparationAtom)?.source).toBe("online");

    // Change period -> new run finishes -> Online stays stored and selected.
    const select = container.querySelector<HTMLSelectElement>("[data-preparation-toolbar] select")!;
    await act(async () => {
      select.value = "1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(store.get(opponentPreparationAtom)?.period).toBe(1);
    });
    expect(store.get(opponentPreparationAtom)?.source).toBe("online");
    expect(
      container.querySelector<HTMLInputElement>('[data-preparation-source] input[value="online"]')
        ?.checked,
    ).toBe(true);

    // Remount -> Online stays shown and stored.
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderTab(online);
    expect(store.get(opponentPreparationAtom)?.source).toBe("online");
    expect(
      container.querySelector<HTMLInputElement>('[data-preparation-source] input[value="online"]')
        ?.checked,
    ).toBe(true);
  });

  test("refused existing-tab activation stays on Preparation tab and sets no preparation view", async () => {
    const existingTab: Tab = {
      name: "Sicilian",
      value: "existing-tab-refused",
      type: "analysis",
      gameOrigin: { kind: "file", file: repFile, gameNumber: 0 },
    };
    store.set(tabsAtom, [existingTab]);
    await renderTab();
    await vi.waitFor(() => {
      expect(container.querySelector("[data-preparation-line-row]")).not.toBeNull();
    });

    // Simulate sessionStorage refusing the active-tab commit so `atoms.set(activeTabAtom, ...)` returns false.
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    try {
      const row = container.querySelector<HTMLTableRowElement>("[data-preparation-line-row]")!;
      await act(async () => row.click());
      expect(mocks.navigate).not.toHaveBeenCalled();
      expect(store.get(tabPreparationViewFamily("existing-tab-refused"))).toBeNull();
    } finally {
      setItemSpy.mockRestore();
    }
  });

  test("backend-initiated cancellation while run is current surfaces failure for card and online searches", async () => {
    // Card search backend-initiated cancellation (isCurrent() is still true) -> shows search failure with Retry.
    mocks.fetchBatchStatistics.mockRejectedValueOnce(
      new DOMException("Cancellation", "AbortError"),
    );
    await renderTab();
    await vi.waitFor(() => {
      expect(container.querySelector("[data-preparation-search-error]")).not.toBeNull();
    });
    expect(container.querySelector("[data-preparation-loading]")).toBeNull();
    expect(container.querySelector("[data-preparation-search-error]")?.textContent).toContain(
      "Databases.LoadError.Title",
    );
    expect(
      container.querySelector("[data-preparation-search-error] button")?.textContent,
    ).toContain("Common.Retry");

    // Online search backend-initiated cancellation while card search succeeds -> treated as online failure.
    store.set(opponentPreparationAtom, null);
    mocks.fetchBatchStatistics.mockImplementation((_fens: string[], db: DatabaseHandle) => {
      if (db.id.id === onlineDb.id.id) {
        return Promise.reject(new DOMException("Cancellation", "AbortError"));
      }
      return Promise.resolve(makeStatsMap());
    });
    await renderTab({
      file: onlineDb,
      accounts: [{ provider: "lichess", username: "DrNykterstein" }],
      lookup: { kind: "found", player: 99 },
    });
    await vi.waitFor(() => {
      expect(container.querySelector("[data-preparation-online-unavailable]")).not.toBeNull();
      expect(container.querySelector("[data-preparation-lines]")).not.toBeNull();
    });
    expect(
      container.querySelector<HTMLInputElement>('[data-preparation-source] input[value="online"]')
        ?.disabled,
    ).toBe(true);
  });

  test("OTB + Online shows counts on switch, switches views without refetching, and pending disables Online/Both without unavailable alert", async () => {
    // Pending online lookup disables Online/Both without showing the unavailable alert.
    await renderTab({
      file: onlineDb,
      accounts: [{ provider: "lichess", username: "DrNykterstein" }],
      lookup: { kind: "pending" },
    });
    await vi.waitFor(() => {
      expect(container.querySelector("[data-preparation-lines]")).not.toBeNull();
    });
    expect(container.querySelector("[data-preparation-online-unavailable]")).toBeNull();
    expect(
      container.querySelector<HTMLInputElement>('[data-preparation-source] input[value="online"]')
        ?.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLInputElement>('[data-preparation-source] input[value="both"]')
        ?.disabled,
    ).toBe(true);

    // Found online player: OTB + Online run populates all three views; switching triggers zero fetches.
    const otbStats = new Map([
      [INITIAL_BOARD_STATE, [statRow("e4", 10)]],
      [AFTER_E4, [statRow("c5", 6)]],
      [AFTER_E4_C5, [statRow("Nf3", 6)]],
    ]);
    const onlineStats = new Map([
      [INITIAL_BOARD_STATE, [statRow("e4", 20), statRow("d4", 5)]],
      [AFTER_E4, [statRow("c5", 15)]],
      [AFTER_E4_C5, [statRow("Nc3", 15)]],
    ]);
    mocks.fetchBatchStatistics.mockReset();
    mocks.fetchBatchStatistics.mockImplementation((_fens: string[], db: DatabaseHandle) =>
      Promise.resolve(db.id.id === onlineDb.id.id ? onlineStats : otbStats),
    );
    await renderTab({
      file: onlineDb,
      accounts: [{ provider: "lichess", username: "DrNykterstein" }],
      lookup: { kind: "found", player: 99 },
    });
    await vi.waitFor(() => {
      expect(container.querySelector("[data-preparation-source]")?.textContent).toContain("· 10");
      expect(container.querySelector("[data-preparation-source]")?.textContent).toContain("· 25");
      expect(container.querySelector("[data-preparation-source]")?.textContent).toContain("· 35");
    });
    expect(mocks.fetchBatchStatistics).toHaveBeenCalledTimes(2);

    // Switch to Online and Both without triggering any additional fetch.
    const onlineRadio = container.querySelector<HTMLInputElement>(
      '[data-preparation-source] input[value="online"]',
    )!;
    await act(async () => onlineRadio.click());
    expect(container.querySelector("[data-preparation-gaps]")?.textContent).toContain("Nc3");
    expect(container.querySelector("[data-preparation-gaps]")?.textContent).not.toContain("Nf3");

    const bothRadio = container.querySelector<HTMLInputElement>(
      '[data-preparation-source] input[value="both"]',
    )!;
    await act(async () => bothRadio.click());
    expect(container.querySelector("[data-preparation-gaps]")?.textContent).toContain("Nc3");
    expect(container.querySelector("[data-preparation-gaps]")?.textContent).toContain("Nf3");
    expect(mocks.fetchBatchStatistics).toHaveBeenCalledTimes(2);
  });

  test("stored preparation matching identity is reused on remount without refetching and restores selection", async () => {
    await renderTab();
    await vi.waitFor(() => {
      expect(container.querySelector("[data-preparation-lines]")).not.toBeNull();
    });
    // Change period to 5 years and wait for it to finish.
    const select = container.querySelector<HTMLSelectElement>("[data-preparation-toolbar] select")!;
    await act(async () => {
      select.value = "5";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(store.get(opponentPreparationAtom)?.period).toBe(5);
    });
    const callsBeforeRemount = mocks.fetchBatchStatistics.mock.calls.length;

    // Unmount and remount -> no new fetch, 5-year selection restored.
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderTab();
    expect(mocks.fetchBatchStatistics).toHaveBeenCalledTimes(callsBeforeRemount);
    expect(
      container.querySelector<HTMLSelectElement>("[data-preparation-toolbar] select")?.value,
    ).toBe("5");
    expect(container.querySelector("[data-preparation-lines]")).not.toBeNull();
  });

  test("filter carries 3-year startDate by default, includeUnknownResults true, and updates with period selector", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T12:00:00Z"));
    try {
      await renderTab();
      await vi.waitFor(() => {
        expect(mocks.fetchBatchStatistics).toHaveBeenCalledTimes(1);
      });
      expect(mocks.fetchBatchStatistics.mock.calls[0]?.[2]).toEqual({
        player1: player.id,
        player2: null,
        startDate: "2023.11.08",
        includeUnknownResults: true,
      });

      const select = container.querySelector<HTMLSelectElement>(
        "[data-preparation-toolbar] select",
      )!;
      await act(async () => {
        select.value = "1";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await vi.waitFor(() => {
        expect(mocks.fetchBatchStatistics).toHaveBeenCalledTimes(2);
      });
      expect(mocks.fetchBatchStatistics.mock.calls[1]?.[2]).toEqual({
        player1: player.id,
        player2: null,
        startDate: "2025.11.08",
        includeUnknownResults: true,
      });

      await act(async () => {
        select.value = "all";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await vi.waitFor(() => {
        expect(mocks.fetchBatchStatistics).toHaveBeenCalledTimes(3);
      });
      expect(mocks.fetchBatchStatistics.mock.calls[2]?.[2]).toEqual({
        player1: player.id,
        player2: null,
        startDate: null,
        includeUnknownResults: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("more than 30 lines/gaps render 30 rows with Show all, and caller-initiated abort is not shown as a failure", async () => {
    const manyNodes = [
      {
        boardState: INITIAL_BOARD_STATE,
        parent: -1,
        san: null,
        path: [],
        halfMoves: 0,
        hasContinuation: true,
      },
      ...Array.from({ length: 35 }, (_, i) => ({
        boardState: `fen-line-${i} w - -`,
        parent: 0,
        san: `M${i}`,
        path: [i],
        halfMoves: 1,
        hasContinuation: false,
      })),
    ];
    mocks.readRepertoireIndex.mockReturnValue(
      makeSnapshot({
        files: [
          {
            workspaceKey: fileWorkspaceKey(repFile.handle),
            file: repFile,
            partial: false,
            chapters: [
              {
                chapter: 0,
                headers: { orientation: "black", white: "Many", black: "?", event: "?" },
                nodes: manyNodes,
              },
            ],
          },
        ],
      }),
    );
    const manyStats = new Map<string, PositionStats[]>([
      [INITIAL_BOARD_STATE, Array.from({ length: 35 }, (_, i) => statRow(`Gap${i}`, 40 - i))],
      ...Array.from({ length: 35 }, (_, i): [string, PositionStats[]] => [
        `fen-line-${i} w - -`,
        [statRow("x", 40 - i)],
      ]),
    ]);
    mocks.fetchBatchStatistics.mockResolvedValue(manyStats);

    await renderTab();
    await vi.waitFor(() => {
      expect(container.querySelectorAll("[data-preparation-line-row]").length).toBe(30);
      expect(container.querySelectorAll("[data-preparation-gap-row]").length).toBe(30);
    });

    const showAllLinesBtn = container.querySelector<HTMLButtonElement>(
      "[data-preparation-show-all-lines]",
    )!;
    await act(async () => showAllLinesBtn.click());
    expect(container.querySelectorAll("[data-preparation-line-row]").length).toBe(35);

    const showAllGapsBtn = container.querySelector<HTMLButtonElement>(
      "[data-preparation-show-all-gaps]",
    )!;
    await act(async () => showAllGapsBtn.click());
    expect(container.querySelectorAll("[data-preparation-gap-row]").length).toBe(35);

    // Caller-initiated abort (Refresh while first run is in flight) never shows a search failure.
    const abortedRun = deferred<Map<string, PositionStats[]>>();
    const nextRun = deferred<Map<string, PositionStats[]>>();
    let call = 0;
    mocks.fetchBatchStatistics.mockImplementation(() => {
      call += 1;
      return call === 1 ? abortedRun.promise : nextRun.promise;
    });
    const refreshBtn = container.querySelector<HTMLButtonElement>("[data-preparation-refresh]")!;
    await act(async () => refreshBtn.click());
    await vi.waitFor(() => expect(call).toBe(1));
    await act(async () => refreshBtn.click());
    await vi.waitFor(() => expect(call).toBe(2));
    await act(async () => {
      abortedRun.reject(new DOMException("Aborted", "AbortError"));
    });
    expect(container.querySelector("[data-preparation-search-error]")).toBeNull();
  });

  test("switching player on a mounted PersonalCard resets colour, period, source and Show all state", async () => {
    const manyNodes = [
      {
        boardState: INITIAL_BOARD_STATE,
        parent: -1,
        san: null,
        path: [],
        halfMoves: 0,
        hasContinuation: true,
      },
      ...Array.from({ length: 35 }, (_, i) => ({
        boardState: `fen-card-${i} w - -`,
        parent: 0,
        san: `M${i}`,
        path: [i],
        halfMoves: 1,
        hasContinuation: false,
      })),
    ];
    mocks.readRepertoireIndex.mockReturnValue(
      makeSnapshot({
        files: [
          {
            workspaceKey: fileWorkspaceKey(repFile.handle),
            file: repFile,
            partial: false,
            chapters: [
              {
                chapter: 0,
                headers: { orientation: "black", white: "Black rep", black: "?", event: "?" },
                nodes: manyNodes,
              },
              {
                chapter: 1,
                headers: { orientation: "white", white: "White rep", black: "?", event: "?" },
                nodes: manyNodes,
              },
            ],
          },
        ],
      }),
    );
    const manyStats = new Map<string, PositionStats[]>([
      [INITIAL_BOARD_STATE, [statRow("e4", 40)]],
      ...Array.from({ length: 35 }, (_, i): [string, PositionStats[]] => [
        `fen-card-${i} w - -`,
        [statRow("x", 40 - i)],
      ]),
    ]);
    mocks.fetchBatchStatistics.mockResolvedValue(manyStats);

    const playerB: Player = { id: 42, name: "Nakamura, Hikaru", elo: 2800, game_count: 60 };
    const onlineA: OnlineGames = {
      file: onlineDb,
      accounts: [{ provider: "lichess", username: "DrNykterstein" }],
      lookup: { kind: "found", player: 99 },
    };
    const onlineB: OnlineGames = {
      file: onlineDb,
      accounts: [{ provider: "chesscom", username: "Hikaru" }],
      lookup: { kind: "found", player: 100 },
    };

    activeDatabaseViewStore.getState().setPlayersActiveTab("preparation");
    const renderCard = async (targetPlayer: Player, online: OnlineGames) => {
      mocks.useOnlineGames.mockReturnValue(online);
      await act(async () => {
        root.render(
          <Provider store={store}>
            <MantineProvider>
              <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
                <PersonalPlayerCard
                  name={targetPlayer.name ?? ""}
                  info={{ site_stats_data: [] }}
                  isDatabase
                  databasePlayer={{ player: targetPlayer, file: cardDb }}
                />
              </DatabaseViewStateContext.Provider>
            </MantineProvider>
          </Provider>,
        );
      });
    };

    try {
      await renderCard(player, onlineA);
      await vi.waitFor(() => {
        expect(container.querySelectorAll("[data-preparation-line-row]").length).toBe(30);
      });

      // Change colour to Black, period to 1 year, source to Online, and expand Show all.
      const blackRadio = container.querySelector<HTMLInputElement>(
        '[data-preparation-toolbar] input[value="black"]',
      )!;
      await act(async () => blackRadio.click());
      const select = container.querySelector<HTMLSelectElement>(
        "[data-preparation-toolbar] select",
      )!;
      await act(async () => {
        select.value = "1";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await vi.waitFor(() => {
        expect(store.get(opponentPreparationAtom)?.opponentColor).toBe("black");
        expect(store.get(opponentPreparationAtom)?.period).toBe(1);
      });
      const onlineRadio = container.querySelector<HTMLInputElement>(
        '[data-preparation-source] input[value="online"]',
      )!;
      await act(async () => onlineRadio.click());
      expect(store.get(opponentPreparationAtom)?.source).toBe("online");
      const showAllBtn = container.querySelector<HTMLButtonElement>(
        "[data-preparation-show-all-lines]",
      )!;
      await act(async () => showAllBtn.click());
      expect(container.querySelectorAll("[data-preparation-line-row]").length).toBe(35);

      // Switch to player B on the same mounted card -> White, 3 years, Over the board, 30-row cap.
      await renderCard(playerB, onlineB);
      await vi.waitFor(() => {
        expect(store.get(opponentPreparationAtom)?.playerId).toBe(playerB.id);
      });
      expect(
        container.querySelector<HTMLInputElement>('[data-preparation-toolbar] input[value="white"]')
          ?.checked,
      ).toBe(true);
      expect(
        container.querySelector<HTMLSelectElement>("[data-preparation-toolbar] select")?.value,
      ).toBe("3");
      expect(
        container.querySelector<HTMLInputElement>('[data-preparation-source] input[value="otb"]')
          ?.checked,
      ).toBe(true);
      expect(store.get(opponentPreparationAtom)?.source).toBe("otb");
      expect(container.querySelectorAll("[data-preparation-line-row]").length).toBe(30);
    } finally {
      activeDatabaseViewStore.getState().setPlayersActiveTab("overview");
    }
  });
});
