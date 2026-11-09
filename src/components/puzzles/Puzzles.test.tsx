import { WorkspaceTabScope } from "@/state/tabScope";
import { MantineProvider } from "@mantine/core";
import { Provider, createStore, useAtom } from "jotai";
import { act, useContext, type ComponentProps } from "react";
import type { Config } from "@lichess-org/chessground/config";
import type { DrawShape } from "@lichess-org/chessground/draw";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  ErrorCategory,
  TrainingPuzzle,
  TrainingVerdict,
  Puzzle as NativePuzzle,
  PuzzleDatabaseInfo,
  PuzzleRootDescriptor,
} from "@/bindings";
import { TreeStateContext, TreeStateProvider } from "@/components/common/TreeStateContext";
import {
  validateMoveSequence,
  closeTreeStore,
  retargetTreeStore,
  type TreeStore,
} from "@/state/store/tree";
import { makeUci, parseSquare } from "chessops";
import type { Key } from "@lichess-org/chessground/types";
import { positionFromFen } from "@/utils/chessops";
import { INITIAL_FEN } from "chessops/fen";
import { getPuzzleProgress, type Puzzle } from "@/utils/puzzles";
import { defaultTree, getNodeAtPath, type TreeState } from "@/utils/treeReducer";
import {
  puzzleTimerFamily,
  eraseDrawablesOnClickAtom,
  jumpToNextPuzzleAtom,
  puzzleRatingRangeAtom,
  puzzleThemeAtom,
  puzzleWorkspaceGenerationAtom,
  selectedPuzzleDbAtom,
  trackPuzzleTimeAtom,
  tabsAtom,
} from "@/state/atoms";
import { chessRiddleTrainingSessions as sessions } from "@/state/chessRiddleTraining";
import * as puzzleSessions from "@/state/puzzleSession";
import { TauriCommandError } from "@/platform/tauri";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { catalogueI18n, shippedCatalogues } from "@/tests/catalogues";
import i18n from "@/i18n";
import type { SupportedLocale } from "@/i18n";
import deDECatalogue from "@/translation/de-DE.json";
import Puzzles from "./Puzzles";
import type AddPuzzle from "./AddPuzzle";
import {
  selectedPuzzleIndex,
  puzzleSchema,
  puzzleSessionBytes,
  MAX_PUZZLE_ATTEMPTS,
  MAX_PUZZLE_SESSION_BYTES,
  type PuzzleSession,
} from "@/state/puzzleSession";
import { tabStorage } from "@/state/store/tabStorage";
import { deserializeStorageValue, serializeStorageValue } from "@/state/store/debouncedStorage";

const mocks = vi.hoisted(() => ({
  chessriddleTrainingAvailable: vi.fn(),
  chessriddleTrainingNext: vi.fn(),
  chessriddleTrainingSubmit: vi.fn(),
  chessriddleMistakeCount: vi.fn(),
  chessriddleAccount: vi.fn(),
  connectChessriddle: vi.fn(),
  getPuzzleWorkspace: vi.fn(),
  listPuzzleDatabases: vi.fn(),
  getPuzzleThemes: vi.fn(),
  getPuzzle: vi.fn(),
  getSoundServerPort: vi.fn(),
  deletePuzzleDatabase: vi.fn(),
  getThemesForPuzzle: vi.fn(),
  notificationShow: vi.fn(),
  playSound: vi.fn(),
  board: null as Config | null,
  selectedDatabase: null as string | null,
  addPuzzleProps: null as ComponentProps<typeof AddPuzzle> | null,
}));

vi.mock("@/utils/sound", () => ({ playSound: mocks.playSound }));
vi.mock("@/platform/native", async () => ({
  ...(await vi.importActual<typeof import("@/platform/native")>("@/platform/native")),
  platform: () => "linux",
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  default: {
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  },
}));
vi.mock("@/platform/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
  return {
    ...actual,
    tauri: {
      chessriddleTrainingAvailable: mocks.chessriddleTrainingAvailable,
      chessriddleTrainingNext: mocks.chessriddleTrainingNext,
      chessriddleTrainingSubmit: mocks.chessriddleTrainingSubmit,
      chessriddleMistakeCount: mocks.chessriddleMistakeCount,
      chessriddleAccount: mocks.chessriddleAccount,
      connectChessriddle: mocks.connectChessriddle,
      getPuzzleWorkspace: mocks.getPuzzleWorkspace,
      listPuzzleDatabases: mocks.listPuzzleDatabases,
      getPuzzleThemes: mocks.getPuzzleThemes,
      getPuzzle: mocks.getPuzzle,
      getSoundServerPort: mocks.getSoundServerPort,
      deletePuzzleDatabase: mocks.deletePuzzleDatabase,
      getThemesForPuzzle: mocks.getThemesForPuzzle,
    },
  };
});
vi.mock("@mantine/notifications", () => ({
  notifications: { show: mocks.notificationShow },
}));
vi.mock("@/chessground/Chessground", () => ({
  Chessground: (props: Config) => {
    mocks.board = props;
    return (
      <div
        data-testid="actual-puzzle-board"
        data-fen={props.fen}
        data-orientation={props.orientation}
      />
    );
  },
}));
vi.mock("@/components/boards/BoardFrame", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@mantine/core", async (original) => {
  const actual = await original<typeof import("@mantine/core")>();
  return {
    ...actual,
    Select: (props: ComponentProps<typeof actual.Select>) => {
      if (props.placeholder === "Puzzle.SelectDatabase")
        mocks.selectedDatabase = props.value ?? null;
      return <actual.Select {...props} />;
    },
  };
});
vi.mock("./AddPuzzle", () => ({
  default: (props: ComponentProps<typeof AddPuzzle>) => {
    mocks.addPuzzleProps = props;
    return <div data-testid="puzzle-database-count">{props.puzzleDbs.length}</div>;
  },
}));
vi.mock("../common/ConfirmModal", () => ({
  default: ({ opened, onConfirm }: { opened: boolean; onConfirm: () => Promise<void> }) =>
    opened ? (
      <button type="button" data-testid="confirm-delete" onClick={() => void onConfirm()}>
        confirm
      </button>
    ) : null,
}));
vi.mock("../common/GameNotation", () => ({ default: () => null }));
vi.mock("../common/ChallengeHistory", async (original) => {
  const actual = await original<typeof import("../common/ChallengeHistory")>();
  return {
    default: (props: ComponentProps<typeof actual.default>) => (
      <div
        data-testid="puzzle-state"
        data-count={props.challenges.length}
        data-current={props.current}
        data-database={mocks.selectedDatabase ?? "none"}
        data-themes={((props.challenges[0] as Puzzle | undefined)?.themes ?? []).join(",")}
      >
        <actual.default {...props} />
      </div>
    ),
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub({
  matches: (query) => query.includes("prefers-reduced-motion"),
  media: (query) => query,
});
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, "ResizeObserver", {
  writable: true,
  value: ResizeObserverStub,
});
Object.defineProperty(Element.prototype, "scrollIntoView", {
  configurable: true,
  value: () => undefined,
});

const selectedDb = { id: "puzzle-db-1" };
const selectedDatabase: PuzzleDatabaseInfo = {
  title: "Tactics.db3",
  description: "Tactics",
  puzzleCount: 1,
  storageSize: 1n,
  path: selectedDb,
};
const otherDb = { id: "puzzle-db-2" };
const otherDatabase: PuzzleDatabaseInfo = {
  ...selectedDatabase,
  title: "Other.db3",
  path: otherDb,
};
const workspace: PuzzleRootDescriptor = {
  root: { id: { id: "puzzle-root" }, kind: "puzzleRoot" },
  displayName: "Puzzles",
};
const trainingPuzzle: TrainingPuzzle = {
  id: 123,
  source: "tactics",
  preEntranceFen: INITIAL_FEN,
  entranceMove: "e2e4",
  decisionFen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
  sideToMove: "black",
  puzzleRating: 1500,
  solutionPlyCount: 3,
};
const connectedAccount = {
  status: "connected",
  account: { handle: "account", username: "Alex", plan: "gold" },
  durability_uncertain: false,
};

test.each(shippedCatalogues())(
  "puzzle source and connection strings resolve in $locale without fallback",
  async ({ locale }) => {
    const instance = await catalogueI18n(locale as SupportedLocale);
    for (const key of [
      "Puzzle.Source.Label",
      "Puzzle.Source.ChessRiddle",
      "Puzzle.Source.Offline",
      "Puzzle.Source.UseOffline",
      "Training.ConnectPrompt",
      "Training.TryAgain",
    ]) {
      expect(instance.t(key)).not.toBe(key);
      expect(instance.t(key).trim()).not.toBe("");
    }
  },
);

async function renderSource(puzzleSource?: "chessriddle" | "offline") {
  const atoms = createStore();
  atoms.set(tabsAtom, [
    {
      value: "puzzles-test",
      type: "puzzles",
      name: "Puzzles",
      gameOrigin: { kind: "none" },
      ...(puzzleSource ? { puzzleSource } : {}),
    },
  ]);
  await renderPuzzles({ atoms });
  return atoms;
}
async function clickTraining(key: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === key,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

test.each([undefined, "offline", "chessriddle"] as const)(
  "effective source for stored %s during and after availability",
  async (source) => {
    const pending = deferred<boolean>();
    mocks.chessriddleTrainingAvailable.mockReturnValueOnce(pending.promise);
    const atoms = await renderSource(source);
    expect(document.querySelector("[data-training-panel]") !== null).toBe(source === "chessriddle");
    for (const available of [true, false]) {
      await act(async () => {
        if (available) pending.resolve(true);
        else {
          mocks.chessriddleTrainingAvailable.mockResolvedValue(false);
          await sessions.available("puzzles-test");
        }
      });
      expect(document.querySelector("[data-training-panel]") !== null).toBe(
        source === "chessriddle" && available,
      );
      expect(document.querySelector('[aria-label="Puzzle.Source.Label"]') !== null).toBe(available);
      expect(atoms.get(tabsAtom)[0].puzzleSource).toBe(source);
    }
  },
);

test("ChessRiddle is usable after offline restore fails, and switching keeps both sessions", async () => {
  mocks.chessriddleTrainingAvailable.mockResolvedValue(true);
  mocks.getPuzzle.mockResolvedValue({
    id: 7,
    fen: INITIAL_FEN,
    moves: "e2e4 e7e5",
    rating: 1200,
    rating_deviation: 50,
    popularity: 1,
    nb_plays: 1,
  });
  const restore = vi.spyOn(puzzleSessions, "restorePuzzleSession").mockImplementation(() => {
    throw new Error("offline restore refused");
  });
  const atoms = await renderSource("offline");
  await act(async () => atoms.set(jumpToNextPuzzleAtom, false));
  expect(document.body.textContent).toContain("TreeRecovery.Retry");
  const restoreAttempts = restore.mock.calls.length;
  await act(async () =>
    document.querySelector<HTMLInputElement>('input[value="chessriddle"]')!.click(),
  );
  expect(document.querySelector("[data-training-panel]")).not.toBeNull();
  expect(mocks.chessriddleTrainingNext).toHaveBeenCalledOnce();
  expect(restore).toHaveBeenCalledTimes(restoreAttempts);
  restore.mockRestore();
  await act(async () => sessions.append("puzzles-test", "e7e5"));
  const training = sessions.get("puzzles-test");
  await act(async () =>
    document.querySelector<HTMLInputElement>('input[value="offline"]')!.click(),
  );
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Puzzle.NewPuzzle"]')!.click(),
  );
  await act(async () => mocks.board!.movable!.events!.after!("e7", "e5", { premove: false }));
  const offline = treeStore.getState().puzzleSession;
  expect(offline?.attempts).toHaveLength(1);
  expect(offline?.attempts[0].puzzle.completion).toBe("correct");
  await act(async () =>
    document.querySelector<HTMLInputElement>('input[value="chessriddle"]')!.click(),
  );
  expect(atoms.get(tabsAtom)[0].puzzleSource).toBe("chessriddle");
  expect(sessions.get("puzzles-test")).toBe(training);
  expect(treeStore.getState().puzzleSession).toBe(offline);
  await act(async () =>
    document.querySelector<HTMLInputElement>('input[value="offline"]')!.click(),
  );
  expect(treeStore.getState().puzzleSession).toEqual(offline);
  expect(treeStore.getState().currentNode().san).toBe("e5");
  expect(mocks.chessriddleTrainingNext).toHaveBeenCalledOnce();
});

test("the rendered source control disables during submission and enables after settlement", async () => {
  mocks.chessriddleTrainingAvailable.mockResolvedValue(true);
  await renderSource("chessriddle");
  const pending = deferred<TrainingVerdict>();
  mocks.chessriddleTrainingSubmit.mockReturnValue(pending.promise);
  await clickTraining("Training.ShowSolution");
  const inputs = () => [
    ...document.querySelectorAll<HTMLInputElement>('[aria-label="Puzzle.Source.Label"] input'),
  ];
  expect(inputs()).toHaveLength(2);
  expect(inputs().every((node) => node.disabled)).toBe(true);
  await act(async () =>
    pending.resolve({
      isCorrect: false,
      tooShort: false,
      ratingChange: 0,
      playerRating: null,
      puzzleRating: 1500,
      rated: false,
      ratingPending: false,
      feedbackCode: "incorrect",
      feedbackContext: "analysis",
      correctVariation: [],
      incorrectMove: null,
      correctMove: null,
    }),
  );
  expect(inputs().every((node) => !node.disabled)).toBe(true);
});

test("failed availability renders its typed error, Retry and a working offline escape", async () => {
  mocks.chessriddleTrainingAvailable.mockRejectedValue("server");
  const atoms = await renderSource("chessriddle");
  expect(document.body.textContent).toContain("Training.Error.Server");
  expect(document.body.textContent).toContain("Training.Retry");
  expect(document.querySelector('[aria-label="Puzzle.Source.Label"]')).toBeNull();
  await clickTraining("Puzzle.Source.UseOffline");
  expect(atoms.get(tabsAtom)[0].puzzleSource).toBe("offline");
  expect(document.querySelector("[data-training-panel]")).toBeNull();
  expect(mocks.chessriddleTrainingAvailable).toHaveBeenCalledOnce();
});

test("an offline tab retries failed availability when its view mounts again", async () => {
  mocks.chessriddleTrainingAvailable.mockRejectedValueOnce("server");
  const atoms = await renderSource("offline");
  expect(document.querySelector('[aria-label="Puzzle.Source.Label"]')).toBeNull();
  expect(document.body.textContent).not.toContain("Training.Error.Server");
  await act(async () => root.render(null));
  mocks.chessriddleTrainingAvailable.mockResolvedValue(true);
  await renderPuzzles({ atoms });
  expect(document.querySelector('[aria-label="Puzzle.Source.Label"]')).not.toBeNull();
  expect(mocks.chessriddleTrainingAvailable).toHaveBeenCalledTimes(2);
  expect(mocks.chessriddleTrainingNext).not.toHaveBeenCalled();
});

test.each(["notConnected", "authentication", "invalidGrant"])(
  "%s prompt loads after user connect and Try again",
  async (error) => {
    mocks.chessriddleTrainingAvailable.mockResolvedValue(true);
    mocks.chessriddleTrainingNext.mockRejectedValueOnce(error);
    await renderSource("chessriddle");
    expect(document.body.textContent).toContain("Training.ConnectPrompt");
    const panel = document.querySelector("[data-training-panel]")!;
    expect(panel.querySelector("h3")).toBeNull();
    expect(panel.textContent).not.toContain("Training.Tactics");
    expect(panel.textContent).not.toContain("Training.Mistakes");
    const secondary = panel.querySelector("[data-training-secondary-actions]")!;
    expect(
      [...secondary.querySelectorAll("button")].map((button) => button.dataset.variant),
    ).toEqual(["default", "subtle"]);
    expect(panel.querySelectorAll('button[data-variant="filled"]')).toHaveLength(1);
    await clickTraining("Home.ChessRiddle.Connect");
    expect(mocks.chessriddleTrainingNext).toHaveBeenCalledTimes(2);
    expect(mocks.chessriddleMistakeCount).toHaveBeenCalledTimes(2);
    expect(panel.textContent).toContain("Training.Title");
    expect(panel.textContent).toContain("Training.Tactics");
    mocks.chessriddleTrainingNext.mockRejectedValueOnce(error);
    await clickTraining("Training.Tactics");
    await clickTraining("Training.TryAgain");
    expect(sessions.get("puzzles-test")?.phase).toBe("solving");
  },
);

test("an uncertain connection keeps its warning until Try again loads a puzzle", async () => {
  mocks.chessriddleTrainingAvailable.mockResolvedValue(true);
  mocks.chessriddleTrainingNext.mockRejectedValueOnce("notConnected");
  mocks.connectChessriddle.mockResolvedValue({ ...connectedAccount, durability_uncertain: true });
  await renderSource("chessriddle");
  const panel = document.querySelector("[data-training-panel]")!;
  await clickTraining("Home.ChessRiddle.Connect");
  expect(panel.textContent).toContain("Home.ChessRiddle.ConnectionDurabilityUncertain");
  expect(panel.textContent).toContain("Training.TryAgain");
  expect(mocks.chessriddleTrainingNext).toHaveBeenCalledOnce();
  expect(mocks.chessriddleMistakeCount).toHaveBeenCalledOnce();
  await clickTraining("Training.TryAgain");
  expect(mocks.chessriddleTrainingNext).toHaveBeenCalledTimes(2);
  expect(sessions.get("puzzles-test")?.phase).toBe("solving");
  expect(sessions.get("puzzles-test")?.puzzle).toEqual(trainingPuzzle);
});

test("account errors after submission hide the retained puzzle details in the prompt", async () => {
  mocks.chessriddleTrainingAvailable.mockResolvedValue(true);
  mocks.chessriddleTrainingSubmit.mockRejectedValue("authentication");
  await renderSource("chessriddle");
  await clickTraining("Training.ShowSolution");
  const panel = document.querySelector("[data-training-panel]")!;
  expect(sessions.get("puzzles-test")?.puzzle).toEqual(trainingPuzzle);
  expect(panel.textContent).toContain("Training.ConnectPrompt");
  expect(panel.textContent).not.toContain("Training.EnterBothSides");
  expect(panel.textContent).not.toContain("Training.MoveCount");
  expect(panel.textContent).not.toContain("Training.PuzzleRating");
  expect(panel.querySelector("h3")).toBeNull();
});

test("the card initial connected read never loops on training authentication errors", async () => {
  mocks.chessriddleTrainingAvailable.mockResolvedValue(true);
  mocks.chessriddleTrainingNext.mockRejectedValue("authentication");
  mocks.chessriddleAccount.mockResolvedValue(connectedAccount);
  await renderSource("chessriddle");
  expect(mocks.chessriddleTrainingNext).toHaveBeenCalledOnce();
  expect(mocks.chessriddleAccount).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("Training.ConnectPrompt");
  await clickTraining("Home.ChessRiddle.Refresh");
  expect(mocks.chessriddleTrainingNext).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).toContain("Training.ConnectPrompt");
});
const otherWorkspace: PuzzleRootDescriptor = {
  root: { id: { id: "other-puzzle-root" }, kind: "puzzleRoot" },
  displayName: "Other puzzles",
};

function solutionButton() {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Puzzle.ViewSolution",
  )!;
}

function previousButton() {
  return document.querySelector<HTMLButtonElement>('[aria-label="Common.MoveControls.Previous"]')!;
}

function nextButton() {
  return document.querySelector<HTMLButtonElement>('[aria-label="Common.MoveControls.Next"]')!;
}

function hintButton() {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Puzzle.GetAHint",
  )!;
}

function puzzleRow(overrides: Partial<Puzzle> = {}): Puzzle {
  return {
    id: 10,
    fen: INITIAL_FEN,
    moves: ["e2e4", "e7e5"],
    completion: "incomplete",
    rating: 1200,
    rating_deviation: 50,
    popularity: 1,
    nb_plays: 1,
    ...overrides,
  };
}

function testSession(rows: Puzzle[], index = 0): PuzzleSession {
  return {
    version: 1,
    attempts: rows
      .filter((row) => puzzleSchema.safeParse(row).success)
      .map((puzzle, i) => ({ attemptId: `test-${i}`, puzzle })),
    selectedAttemptId:
      rows[index] && puzzleSchema.safeParse(rows[index]).success ? `test-${index}` : null,
  };
}

function storedPuzzles(): Puzzle[] {
  const bytes = sessionStorage.getItem("puzzles-test");
  if (bytes)
    return (
      deserializeStorageValue<{ state: TreeState }>(bytes)?.state.puzzleSession?.attempts.map(
        (attempt) => attempt.puzzle,
      ) ?? []
    );
  return JSON.parse(sessionStorage.getItem("puzzles-test-puzzles") ?? "[]");
}

function storedHistoryBytes() {
  const bytes = sessionStorage.getItem("puzzles-test");
  return serializeStorageValue(
    bytes ? deserializeStorageValue<{ state: TreeState }>(bytes)?.state.puzzleSession : null,
  );
}

function ownedTimer(
  startedAt: number,
  attemptId = treeStore.getState().puzzleSession?.selectedAttemptId ?? "previous-attempt",
) {
  return { attemptId, startedAt };
}

async function newPuzzle() {
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Puzzle.NewPuzzle"]')!.click();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

async function humanMove(from: Key, to: Key) {
  await act(async () => mocks.board!.movable!.events!.after!(from, to, { premove: false }));
}

async function selectIncomplete(index: number) {
  await act(async () => {
    document
      .querySelectorAll<HTMLButtonElement>('[aria-label="ChallengeHistory.Incomplete"]')
      [index]!.click();
  });
}

const puzzleB = () => puzzleRow({ moves: ["g1f3", "d7d5"] });

function trackingSwitch() {
  return [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) =>
    [...(input.labels ?? [])].some((label) =>
      label.textContent?.includes("Puzzle.TrackPuzzleTime"),
    ),
  )!;
}

test.each(["correct", "incorrect"] as const)(
  "timer cleanup cannot overwrite the first %s completion after the clock advances",
  async (completion) => {
    const query = deferred<string[]>();
    const atoms = await renderPriorPuzzle([puzzleRow()], 0, ["e4"]);
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    await act(async () => {
      atoms.set(jumpToNextPuzzleAtom, false);
      atoms.set(trackPuzzleTimeAtom, true);
      atoms.set(puzzleTimerFamily("puzzles-test"), ownedTimer(9000));
    });
    mocks.getThemesForPuzzle.mockImplementationOnce(() => {
      expect(storedPuzzles()[0].completion).toBe(completion);
      expect(storedPuzzles()[0].timeSpent).toBe(1000);
      vi.setSystemTime(10_100);
      return query.promise;
    });
    await humanMove(completion === "correct" ? "e7" : "c7", completion === "correct" ? "e5" : "c5");
    expect(Date.now()).toBe(10_100);
    expect(storedPuzzles()[0].completion).toBe(completion);
    expect(storedPuzzles()[0].timeSpent).toBe(1000);
    expect(atoms.get(puzzleTimerFamily("puzzles-test"))).toBeNull();
    vi.setSystemTime(12_000);
    await act(async () => query.resolve(["fork"]));
    expect(storedPuzzles()[0].timeSpent).toBe(1000);
    await act(async () => root.unmount());
    expect(storedPuzzles()[0].timeSpent).toBe(1000);
    expect(storedPuzzles()[0].completion).toBe(completion);
    expect(mocks.notificationShow).not.toHaveBeenCalled();
  },
);

test.each(["incomplete", "correct", "removed"] as const)(
  "timer cleanup cannot write over a %s record at its reused index",
  async (replacement) => {
    const atoms = await renderPriorPuzzle([puzzleRow()], 0, ["e4"]);
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    await act(async () => {
      atoms.set(trackPuzzleTimeAtom, true);
      atoms.set(puzzleTimerFamily("puzzles-test"), ownedTimer(9000));
    });
    vi.setSystemTime(10_100);
    const rows =
      replacement === "removed" ? [] : [puzzleRow({ completion: replacement, timeSpent: 4321 })];
    await act(async () => {
      treeStore.getState().transitionPuzzleSession((draft) => {
        draft.puzzleSession = {
          ...testSession(rows),
          attempts: testSession(rows).attempts.map((attempt) => ({
            ...attempt,
            attemptId: `replacement-${attempt.attemptId}`,
          })),
          selectedAttemptId: rows.length ? "replacement-test-0" : null,
        };
      });
      atoms.set(trackPuzzleTimeAtom, false);
    });
    expect(storedPuzzles()).toEqual(rows);
    await act(async () => root.unmount());
    expect(storedPuzzles()).toEqual(rows);
    expect(mocks.notificationShow).not.toHaveBeenCalled();
  },
);

test.each(["tracking", "selection", "unmount"] as const)(
  "incomplete timer cleanup preserves elapsed time on %s",
  async (exit) => {
    const atoms = await renderPriorPuzzle([puzzleRow(), puzzleB()], 0, ["e4"]);
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    await act(async () => {
      atoms.set(trackPuzzleTimeAtom, true);
      atoms.set(puzzleTimerFamily("puzzles-test"), ownedTimer(9000));
    });
    vi.setSystemTime(10_100);
    if (exit === "tracking") await act(async () => trackingSwitch().click());
    else if (exit === "selection") await selectIncomplete(1);
    else await act(async () => root.unmount());
    expect(storedPuzzles()[0].completion).toBe("incomplete");
    expect(storedPuzzles()[0].timeSpent).toBe(1100);
    expect(storedPuzzles()[1].timeSpent).toBeUndefined();
    expect(mocks.getThemesForPuzzle).not.toHaveBeenCalled();
    expect(mocks.notificationShow).not.toHaveBeenCalled();
  },
);

test("timer cleanup resumes a replacement's own elapsed time without reusing the previous owner's start", async () => {
  const atoms = await renderPriorPuzzle([puzzleRow()], 0, ["e4"]);
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  await act(async () => {
    atoms.set(trackPuzzleTimeAtom, true);
    atoms.set(puzzleTimerFamily("puzzles-test"), ownedTimer(9000));
  });
  const replacement = puzzleRow({ timeSpent: 4321 });
  await act(async () => {
    treeStore.getState().transitionPuzzleSession((draft) => {
      draft.puzzleSession = {
        version: 1,
        attempts: [{ attemptId: "replacement", puzzle: replacement }],
        selectedAttemptId: "replacement",
      };
    });
  });
  expect(storedPuzzles()[0]).toEqual(replacement);
  vi.setSystemTime(10_100);
  await act(async () => root.unmount());
  expect(storedPuzzles()[0]).toEqual({ ...replacement, timeSpent: 4421 });
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

const castlingFen = "4k3/8/8/8/8/8/8/4K2R b K - 0 1";
test.each([
  ["g1", false],
  ["h1", false],
  ["g1", true],
  ["h1", true],
] as const)(
  "castling to %s is accepted and retains its move with immediate advance %s",
  async (destination, advance) => {
    sessionStorage.setItem("puzzles-test-puzzles", JSON.stringify([puzzleB()]));
    const atoms = await loadPlaybackPuzzle("e8e7 e1g1", castlingFen);
    await act(async () => atoms.set(jumpToNextPuzzleAtom, advance));
    expect(validateMoveSequence(castlingFen, ["e8e7", "e1g1"]).success).toBe(true);
    expect(mocks.board?.orientation).toBe("white");
    expect(treeStore.getState().currentNode().san).toBe("Ke7");
    const states: ReturnType<TreeStore["getState"]>[] = [];
    const unsubscribe = treeStore.subscribe((state) => states.push(state));
    mocks.playSound.mockClear();
    try {
      await humanMove("e1", destination);
    } finally {
      unsubscribe();
    }
    const castled = states[0];
    const castledNode = getNodeAtPath(castled.root, castled.position);
    expect(castled.position).toEqual([0, 0]);
    expect(castledNode.san).toBe("O-O");
    expect(makeUci(castledNode.move!)).toBe(`e1${destination}`);
    const [pos] = positionFromFen(castledNode.fen);
    expect(pos?.board.get(parseSquare("g1")!)).toMatchObject({ role: "king", color: "white" });
    expect(pos?.board.get(parseSquare("f1")!)).toMatchObject({ role: "rook", color: "white" });
    expect(storedPuzzles()[1].completion).toBe("correct");
    expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(advance ? 0 : 1);
    expect(treeStore.getState().currentNode().san).toBe(advance ? "Nf3" : "O-O");
    expect(mocks.getThemesForPuzzle).toHaveBeenCalledOnce();
    expect(mocks.playSound).toHaveBeenCalledTimes(advance ? 2 : 1);
    expect(mocks.notificationShow).not.toHaveBeenCalled();
  },
);

test.each([
  ["e1g1", "e1h1"],
  ["e1h1", "e1g1"],
] as const)(
  "normalized recorded castling %s matches solution %s for frontier and hints",
  async (actual, expected) => {
    const atoms = await loadPlaybackPuzzle(`e8e7 ${expected} e7e6 f1e1`, castlingFen);
    await act(async () => {
      atoms.set(jumpToNextPuzzleAtom, false);
      expect(
        treeStore.getState().makeMoves({ payload: [actual, "e7e6"], changeHeaders: false }).success,
      ).toBe(true);
    });
    expect(makeUci(treeStore.getState().root.children[0].children[0].move!)).toBe(actual);
    expect(treeStore.getState().position).toEqual([0, 0, 0]);
    expect(mocks.board?.movable?.color).toBe("white");
    expect(hintButton().disabled).toBe(false);
    await act(async () => hintButton().click());
    expect(treeStore.getState().currentNode().shapes).toEqual([
      { orig: "f1", dest: undefined, brush: "green" },
    ]);
    await act(async () => hintButton().click());
    expect(treeStore.getState().currentNode().shapes).toEqual([
      { orig: "f1", dest: "e1", brush: "green" },
    ]);
    await humanMove("f1", "e1");
    expect(treeStore.getState().position).toEqual([0, 0, 0, 0]);
    expect(treeStore.getState().currentNode().san).toBe("Re1+");
    expect(storedPuzzles()[0].completion).toBe("incorrect");
    expect(mocks.notificationShow).not.toHaveBeenCalled();
  },
);

test("a legal ordinary king step does not satisfy a castling solution", async () => {
  await loadPlaybackPuzzle("e8e7 e1g1", castlingFen);
  await humanMove("e1", "f1");
  expect(treeStore.getState().position).toEqual([0]);
  expect(treeStore.getState().root.children[0].children[0].san).toBe("Kf1");
  expect(storedPuzzles()[0].completion).toBe("incorrect");
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

test.each(["queen", "rook"] as const)(
  "normalized %s promotion retains its completion against the stored queen promotion",
  async (role) => {
    const fen = "7k/P7/8/8/8/8/8/7K b - - 0 1";
    const atoms = await loadPlaybackPuzzle("h8g8 a7a8q", fen);
    await act(async () => atoms.set(jumpToNextPuzzleAtom, false));
    await humanMove("a7", "a8");
    const dialog = document.querySelector<HTMLElement>(
      '[aria-label="Board.Promotion.DialogLabel"]',
    )!;
    expect(dialog).not.toBeNull();
    await act(async () =>
      dialog.querySelectorAll<HTMLButtonElement>("button")[role === "queen" ? 0 : 2].click(),
    );
    const node = treeStore.getState().root.children[0].children[0];
    expect(makeUci(node.move!)).toBe(role === "queen" ? "a7a8q" : "a7a8r");
    expect(treeStore.getState().position).toEqual(role === "queen" ? [0, 0] : [0]);
    expect(storedPuzzles()[0].completion).toBe(role === "queen" ? "correct" : "incorrect");
    expect(mocks.notificationShow).not.toHaveBeenCalled();
  },
);

test.each(["resolve", "cancel", "error"] as const)(
  "first wrong c5 then d5 preserve elapsed time while metadata is pending and after %s",
  async (outcome) => {
    const completion = deferred<string[]>();
    mocks.getThemesForPuzzle.mockReturnValueOnce(completion.promise);
    const atoms = await renderPriorPuzzle([puzzleRow()], 0, ["e4"]);
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    await act(async () => {
      atoms.set(trackPuzzleTimeAtom, true);
      atoms.set(puzzleTimerFamily("puzzles-test"), ownedTimer(Date.now() - 1000));
    });
    await humanMove("c7", "c5");
    const firstTime = storedPuzzles()[0].timeSpent;
    expect(firstTime).toBe(1000);
    expect(storedPuzzles()[0].completion).toBe("incorrect");
    expect(atoms.get(puzzleTimerFamily("puzzles-test"))).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await humanMove("d7", "d5");
    expect(treeStore.getState().position).toEqual([0]);
    expect(treeStore.getState().root.children[0].children.map((node) => node.san)).toEqual([
      "c5",
      "d5",
    ]);
    expect(storedPuzzles()[0].timeSpent).toBe(firstTime);
    expect(storedPuzzles()[0].completion).toBe("incorrect");
    expect(mocks.getThemesForPuzzle).toHaveBeenCalledOnce();
    const before = treeStore.getState();
    const rows = storedHistoryBytes();
    mocks.playSound.mockClear();
    await act(async () => {
      if (outcome === "resolve") completion.resolve(["fork"]);
      else
        completion.reject(
          commandError(
            outcome === "cancel" ? "cancellation" : "database",
            "old wrong metadata failed",
          ),
        );
    });
    expect(treeStore.getState()).toBe(before);
    expect(storedHistoryBytes()).toBe(rows);
    expect(mocks.notificationShow).not.toHaveBeenCalled();
    expect(mocks.playSound).not.toHaveBeenCalled();
    await humanMove("c7", "c6");
    expect(storedPuzzles()[0].timeSpent).toBe(firstTime);
    expect(storedPuzzles()[0].completion).toBe("incorrect");
    expect(mocks.getThemesForPuzzle).toHaveBeenCalledOnce();
  },
);

test("previously incorrect reopened puzzles retain their first time across wrong inputs", async () => {
  const atoms = await renderPriorPuzzle(
    [puzzleRow({ completion: "incorrect", timeSpent: 4321 })],
    0,
    ["e4"],
  );
  await act(async () => atoms.set(puzzleTimerFamily("puzzles-test"), null));
  await humanMove("c7", "c5");
  await humanMove("d7", "d5");
  expect(storedPuzzles()[0].completion).toBe("incorrect");
  expect(storedPuzzles()[0].timeSpent).toBe(4321);
  expect(atoms.get(puzzleTimerFamily("puzzles-test"))).toBeNull();
  expect(mocks.getThemesForPuzzle).not.toHaveBeenCalled();
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

test("different puzzles each retain their own first wrong attempt", async () => {
  const oldCompletion = deferred<string[]>();
  mocks.getThemesForPuzzle.mockReturnValueOnce(oldCompletion.promise);
  const atoms = await renderPriorPuzzle([puzzleRow(), puzzleB()], 0, ["e4"]);
  await act(async () =>
    atoms.set(puzzleTimerFamily("puzzles-test"), ownedTimer(Date.now() - 1000)),
  );
  await humanMove("c7", "c5");
  const firstTime = storedPuzzles()[0].timeSpent;
  expect(firstTime).toBeGreaterThanOrEqual(1000);
  await selectIncomplete(0);
  await act(async () =>
    atoms.set(puzzleTimerFamily("puzzles-test"), ownedTimer(Date.now() - 2000)),
  );
  await humanMove("e7", "e5");
  const secondTime = storedPuzzles()[1].timeSpent;
  expect(secondTime).toBeGreaterThanOrEqual(2000);
  await humanMove("c7", "c5");
  await act(async () => oldCompletion.resolve(["old fork"]));
  expect(storedPuzzles().map((puzzle) => puzzle.completion)).toEqual(["incorrect", "incorrect"]);
  expect(storedPuzzles().map((puzzle) => puzzle.timeSpent)).toEqual([firstTime, secondTime]);
  expect(mocks.getThemesForPuzzle).toHaveBeenCalledTimes(2);
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

test("a still-owned first wrong metadata failure reports once without losing elapsed time", async () => {
  const completion = deferred<string[]>();
  mocks.getThemesForPuzzle.mockReturnValueOnce(completion.promise);
  const atoms = await renderPriorPuzzle([puzzleRow()], 0, ["e4"]);
  await act(async () =>
    atoms.set(puzzleTimerFamily("puzzles-test"), ownedTimer(Date.now() - 1000)),
  );
  await humanMove("c7", "c5");
  const timeSpent = storedPuzzles()[0].timeSpent;
  await act(async () => completion.reject(commandError("database", "owned wrong metadata failed")));
  expect(storedPuzzles()[0].timeSpent).toBe(timeSpent);
  expect(storedPuzzles()[0].completion).toBe("incorrect");
  expect(mocks.notificationShow).toHaveBeenCalledExactlyOnceWith({
    title: "Common.Error",
    message: "owned wrong metadata failed",
    color: "danger",
  });
  await humanMove("d7", "d5");
  expect(storedPuzzles()[0].timeSpent).toBe(timeSpent);
  expect(mocks.getThemesForPuzzle).toHaveBeenCalledOnce();
});

async function replaceCurrentPuzzle(row: Puzzle) {
  await act(async () => {
    treeStore.getState().transitionPuzzleSession((draft) => {
      draft.puzzleSession = {
        version: 1,
        attempts: [{ attemptId: crypto.randomUUID(), puzzle: row }],
        selectedAttemptId: null,
      };
      draft.puzzleSession.selectedAttemptId = draft.puzzleSession.attempts[0].attemptId;
    });
    treeStore.getState().setFen(row.fen);
    expect(
      treeStore.getState().makeMoves({ payload: [row.moves[0]], changeHeaders: false }).success,
    ).toBe(true);
  });
}

test.each(["history", "cached"] as const)(
  "database themes publish the saved fork filter across %s selection",
  async (selection) => {
    const themes = deferred<string[]>();
    mocks.getPuzzleThemes.mockReturnValue(themes.promise);
    const atoms = await renderPriorPuzzle([puzzleRow(), puzzleB()], 0, ["e4"]);
    await act(async () => {
      atoms.set(puzzleThemeAtom, "fork");
      atoms.set(jumpToNextPuzzleAtom, selection === "cached");
    });
    if (selection === "history") await selectIncomplete(1);
    else await humanMove("e7", "e5");
    expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(1);
    expect(treeStore.getState().currentNode().san).toBe("Nf3");
    await act(async () => themes.resolve(["fork"]));
    expect(mocks.getPuzzleThemes).toHaveBeenCalledOnce();
    expect(atoms.get(puzzleThemeAtom)).toBe("fork");
    await newPuzzle();
    expect(mocks.getPuzzle).toHaveBeenCalledWith(
      selectedDb,
      expect.any(Number),
      expect.any(Number),
      "fork",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.notificationShow).not.toHaveBeenCalled();
  },
);

test.each(["resolve", "cancel", "error"] as const)(
  "puzzle B survives A completion %s with the same FEN and id",
  async (outcome) => {
    const completion = deferred<string[]>();
    mocks.getThemesForPuzzle.mockReturnValueOnce(completion.promise);
    const atoms = await renderPriorPuzzle([puzzleRow(), puzzleB()], 0, ["e4"]);
    await act(async () => atoms.set(jumpToNextPuzzleAtom, false));
    await humanMove("e7", "e5");
    expect(storedPuzzles()[0].completion).toBe("correct");
    await selectIncomplete(0);
    expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(1);
    const before = treeStore.getState();
    const rows = storedHistoryBytes();
    const timer = atoms.get(puzzleTimerFamily("puzzles-test"));
    mocks.playSound.mockClear();
    await act(async () => {
      if (outcome === "resolve") completion.resolve(["fork"]);
      else
        completion.reject(
          commandError(outcome === "cancel" ? "cancellation" : "database", "old completion failed"),
        );
    });
    expect(treeStore.getState()).toBe(before);
    expect(storedHistoryBytes()).toBe(rows);
    expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(1);
    expect(atoms.get(puzzleTimerFamily("puzzles-test"))).toBe(timer);
    expect(storedPuzzles()[1].completion).toBe("incomplete");
    expect(mocks.board?.movable?.color).toBe("black");
    expect(mocks.playSound).not.toHaveBeenCalled();
    expect(mocks.notificationShow).not.toHaveBeenCalled();
    await humanMove("e7", "e5");
    expect(storedPuzzles()[1].completion).toBe("incorrect");
    expect(mocks.getThemesForPuzzle).toHaveBeenCalledTimes(2);
    await humanMove("c7", "c5");
    expect(mocks.getThemesForPuzzle).toHaveBeenCalledTimes(2);
  },
);

test.each(["position", "tree", "unmount"] as const)(
  "a final completion cannot continue after %s replacement",
  async (replacement) => {
    const completion = deferred<string[]>();
    mocks.getThemesForPuzzle.mockReturnValueOnce(completion.promise);
    const atoms = await renderPriorPuzzle([puzzleRow()], 0, ["e4"]);
    await act(async () => atoms.set(jumpToNextPuzzleAtom, false));
    await humanMove("e7", "e5");
    await act(async () => {
      if (replacement === "position")
        treeStore.getState().goToMove([...treeStore.getState().position]);
      else if (replacement === "tree") treeStore.getState().reset();
      else root.unmount();
    });
    const before = treeStore.getState();
    const rows = storedHistoryBytes();
    mocks.playSound.mockClear();
    await act(async () => completion.resolve(["fork"]));
    expect(treeStore.getState()).toBe(before);
    expect(storedHistoryBytes()).toBe(rows);
    expect(mocks.playSound).not.toHaveBeenCalled();
    expect(mocks.notificationShow).not.toHaveBeenCalled();
    expect(mocks.getPuzzle).not.toHaveBeenCalled();
  },
);

test("a stale wrong completion preserves the recorded first attempt after tree replacement", async () => {
  const completion = deferred<string[]>();
  mocks.getThemesForPuzzle.mockReturnValueOnce(completion.promise);
  const atoms = await renderPriorPuzzle([puzzleRow()], 0, ["e4"]);
  await act(async () => atoms.set(jumpToNextPuzzleAtom, false));
  await humanMove("c7", "c5");
  expect(storedPuzzles()[0].completion).toBe("incorrect");
  await act(async () => {
    treeStore.getState().setFen(INITIAL_FEN);
    treeStore.getState().makeMove({ payload: "e4" });
  });
  const before = treeStore.getState();
  const rows = storedHistoryBytes();
  const timeSpent = storedPuzzles()[0].timeSpent;
  mocks.playSound.mockClear();
  await act(async () => completion.resolve(["fork"]));
  expect(treeStore.getState()).toBe(before);
  expect(storedHistoryBytes()).toBe(rows);
  expect(mocks.notificationShow).not.toHaveBeenCalled();
  expect(mocks.playSound).not.toHaveBeenCalled();
  await humanMove("c7", "c5");
  expect(storedPuzzles()[0].completion).toBe("incorrect");
  expect(storedPuzzles()[0].timeSpent).toBe(timeSpent);
  expect(mocks.getThemesForPuzzle).toHaveBeenCalledOnce();
});

test.each(["resolve", "cancel"] as const)(
  "a stale correct continuation cannot restart replacement puzzle timing after %s",
  async (outcome) => {
    const completion = deferred<string[]>();
    mocks.getThemesForPuzzle.mockReturnValueOnce(completion.promise);
    const atoms = await renderPriorPuzzle([puzzleRow()], 0, ["e4"]);
    await act(async () => atoms.set(jumpToNextPuzzleAtom, false));
    await humanMove("e7", "e5");
    expect(treeStore.getState().currentNode().san).toBe("e5");
    const committed = treeStore.getState();
    await replaceCurrentPuzzle(puzzleB());
    expect(treeStore.getState()).not.toBe(committed);
    expect(treeStore.getState().currentNode().san).toBe("Nf3");
    await humanMove("e7", "e5");
    expect(storedPuzzles()[0].completion).toBe("incorrect");
    const timeSpent = storedPuzzles()[0].timeSpent;
    await act(async () =>
      atoms.set(puzzleTimerFamily("puzzles-test"), ownedTimer(Date.now() - 100)),
    );
    const timer = atoms.get(puzzleTimerFamily("puzzles-test"));
    const before = treeStore.getState();
    const rows = storedHistoryBytes();
    mocks.playSound.mockClear();
    await act(async () => {
      if (outcome === "resolve") completion.resolve(["mate"]);
      else completion.reject(commandError("cancellation", "old completion cancelled"));
    });
    expect(treeStore.getState()).toBe(before);
    expect(storedHistoryBytes()).toBe(rows);
    expect(mocks.playSound).not.toHaveBeenCalled();
    expect(mocks.notificationShow).not.toHaveBeenCalled();
    await humanMove("c7", "c5");
    expect(storedPuzzles()[0].completion).toBe("incorrect");
    expect(storedPuzzles()[0].timeSpent).toBe(timeSpent);
    expect(atoms.get(puzzleTimerFamily("puzzles-test"))).toBe(timer);
    expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(0);
  },
);

test("a captured old-board human callback cannot commit to the replacement puzzle", async () => {
  const atoms = await renderPriorPuzzle([puzzleRow(), puzzleB()], 0, ["e4"]);
  const after = mocks.board!.movable!.events!.after!;
  await selectIncomplete(1);
  const before = treeStore.getState();
  const rows = storedHistoryBytes();
  const timer = atoms.get(puzzleTimerFamily("puzzles-test"));
  mocks.playSound.mockClear();
  await act(async () => after("e7", "e5", { premove: false }));
  expect(treeStore.getState()).toBe(before);
  expect(treeStore.getState().currentNode().san).toBe("Nf3");
  expect(storedHistoryBytes()).toBe(rows);
  expect(atoms.get(puzzleTimerFamily("puzzles-test"))).toBe(timer);
  expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(1);
  expect(mocks.getThemesForPuzzle).not.toHaveBeenCalled();
  expect(mocks.playSound).not.toHaveBeenCalled();
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

test.each(["resolve", "error"] as const)(
  "still-owned final completion %s keeps the move committed while metadata is pending",
  async (outcome) => {
    const completion = deferred<string[]>();
    mocks.getThemesForPuzzle.mockReturnValueOnce(completion.promise);
    const atoms = await renderPriorPuzzle([puzzleRow()], 0, ["e4"]);
    await act(async () => atoms.set(jumpToNextPuzzleAtom, false));
    const before = treeStore.getState();
    await humanMove("e7", "e5");
    expect(treeStore.getState()).not.toBe(before);
    expect(treeStore.getState().position).toEqual([0, 0]);
    expect(treeStore.getState().currentNode().san).toBe("e5");
    expect(treeStore.getState().headers).toEqual(before.headers);
    expect(storedPuzzles()[0].completion).toBe("correct");
    expect(atoms.get(puzzleTimerFamily("puzzles-test"))).toBeNull();
    expect(mocks.playSound).toHaveBeenCalledOnce();
    const committed = treeStore.getState();
    await act(async () => {
      if (outcome === "resolve") completion.resolve(["fork"]);
      else completion.reject(commandError("database", "owned metadata failed"));
    });
    expect(treeStore.getState().position).toEqual([0, 0]);
    expect(treeStore.getState().root).toEqual(committed.root);
    expect(treeStore.getState().currentNode().san).toBe("e5");
    expect(storedPuzzles()[0].completion).toBe("correct");
    expect(mocks.playSound).toHaveBeenCalledOnce();
    expect(mocks.notificationShow.mock.calls).toEqual(
      outcome === "error"
        ? [[{ title: "Common.Error", message: "owned metadata failed", color: "danger" }]]
        : [],
    );
  },
);

test.each([
  ["position", "resolve"],
  ["tree", "resolve"],
  ["position", "error"],
  ["tree", "error"],
] as const)(
  "stale immediate advance after %s replacement has quiet query %s",
  async (replacement, outcome) => {
    const query = deferred<NativePuzzle>();
    mocks.getPuzzle.mockReturnValueOnce(query.promise);
    const atoms = await renderPriorPuzzle([puzzleRow()], 0, ["e4"]);
    await act(async () => atoms.set(jumpToNextPuzzleAtom, true));
    const original = treeStore.getState();
    await humanMove("e7", "e5");
    expect(mocks.getPuzzle).toHaveBeenCalledOnce();
    expect(treeStore.getState()).not.toBe(original);
    expect(treeStore.getState().currentNode().san).toBe("e5");
    expect(mocks.playSound).toHaveBeenCalledOnce();
    mocks.playSound.mockClear();
    await act(async () => {
      if (replacement === "position")
        treeStore.getState().goToMove([...treeStore.getState().position]);
      else treeStore.getState().setFen(INITIAL_FEN);
    });
    const before = treeStore.getState();
    const rows = storedHistoryBytes();
    const timer = atoms.get(puzzleTimerFamily("puzzles-test"));
    await act(async () => {
      if (outcome === "resolve") query.resolve({ ...puzzleB(), moves: "g1f3 d7d5" });
      else query.reject(commandError("database", "stale advance failed"));
    });
    expect(treeStore.getState()).toBe(before);
    expect(storedHistoryBytes()).toBe(rows);
    expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(0);
    expect(atoms.get(puzzleTimerFamily("puzzles-test"))).toBe(timer);
    expect(mocks.playSound).not.toHaveBeenCalled();
    expect(mocks.notificationShow).not.toHaveBeenCalled();
  },
);

test("an earlier accepted mate stops timing and immediately advances through the terminal branch", async () => {
  const moves = ["h7h8", "g5e5", "h8h7", "e5h5"];
  expect(validateMoveSequence(mateFen, moves).success).toBe(true);
  sessionStorage.setItem("puzzles-test-puzzles", JSON.stringify([puzzleB()]));
  mocks.getPuzzle.mockResolvedValue({ ...puzzleRow(), fen: mateFen, moves: moves.join(" ") });
  const completion = deferred<string[]>();
  mocks.getThemesForPuzzle.mockReturnValueOnce(completion.promise);
  const atoms = await renderPuzzles({ trackTime: true });
  await act(async () => atoms.set(jumpToNextPuzzleAtom, true));
  await newPuzzle();
  expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(1);
  mocks.playSound.mockClear();
  await humanMove("g5", "h5");
  expect(treeStore.getState().currentNode().san).toBe("Qh5#");
  expect(treeStore.getState().currentNode().children).toEqual([]);
  expect(storedPuzzles()[1].completion).toBe("correct");
  expect(atoms.get(puzzleTimerFamily("puzzles-test"))).toBeNull();
  expect(mocks.playSound).toHaveBeenCalledOnce();
  await act(async () => completion.resolve(["mate"]));
  expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(0);
  expect(treeStore.getState().currentNode().san).toBe("Nf3");
  expect(storedPuzzles()[1].completion).toBe("correct");
  expect(storedPuzzles()[1].themes).toEqual(["mate"]);
  expect(atoms.get(puzzleTimerFamily("puzzles-test"))).not.toBeNull();
  expect(mocks.playSound).toHaveBeenCalledTimes(2);
  expect(mocks.getPuzzle).toHaveBeenCalledOnce();
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

test.each(["resolve", "error"] as const)(
  "a stale immediate advance query cannot publish or notify after remount %s",
  async (outcome) => {
    const query = deferred<NativePuzzle>();
    mocks.getPuzzle.mockReturnValueOnce(query.promise);
    const atoms = await renderPriorPuzzle([puzzleRow()], 0, ["e4"]);
    await act(async () => atoms.set(jumpToNextPuzzleAtom, true));
    await humanMove("e7", "e5");
    const oldStore = treeStore;
    const oldCommitted = oldStore.getState();
    expect(oldCommitted.currentNode().san).toBe("e5");
    await act(async () => root.unmount());
    root = createRoot(host);
    closeTreeStore("puzzles-test");
    tabStorage.remove("puzzles-test");
    sessionStorage.setItem("puzzles-test-puzzles", JSON.stringify([puzzleB()]));
    const replacementAtoms = await renderPuzzles();
    await act(async () => {
      expect(treeStore.getState().makeMoves({ payload: ["g1f3"] }).success).toBe(true);
      replacementAtoms.set(puzzleTimerFamily("puzzles-test"), ownedTimer(Date.now() - 1000));
    });
    expect(treeStore).not.toBe(oldStore);
    const before = treeStore.getState();
    const rows = storedHistoryBytes();
    const timer = replacementAtoms.get(puzzleTimerFamily("puzzles-test"));
    mocks.playSound.mockClear();
    await act(async () => {
      if (outcome === "resolve") query.resolve({ ...puzzleRow(), moves: "e2e4 e7e5" });
      else query.reject(commandError("database", "old advance failed after remount"));
    });
    expect(oldStore.getState()).toBe(oldCommitted);
    expect(treeStore.getState()).toBe(before);
    expect(storedHistoryBytes()).toBe(rows);
    expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(0);
    expect(replacementAtoms.get(puzzleTimerFamily("puzzles-test"))).toBe(timer);
    expect(mocks.playSound).not.toHaveBeenCalled();
    expect(mocks.notificationShow).not.toHaveBeenCalled();
    await humanMove("e7", "e5");
    expect(storedPuzzles()[0].completion).toBe("incorrect");
    expect(replacementAtoms.get(puzzleTimerFamily("puzzles-test"))).toBeNull();
    expect(storedPuzzles()[0].timeSpent).toBeGreaterThanOrEqual(1000);
  },
);

test.each([false, true])(
  "an earlier accepted mate retains incorrect classification with immediate advance %s",
  async (advance) => {
    const moves = ["h7h8", "g5e5", "h8h7", "e5h5"];
    expect(validateMoveSequence(mateFen, moves).success).toBe(true);
    const failed = puzzleRow({ fen: mateFen, moves, completion: "incorrect", timeSpent: 4321 });
    sessionStorage.setItem("puzzles-test-puzzles", JSON.stringify([failed, puzzleB()]));
    const atoms = await renderPuzzles({ initial: defaultTree(mateFen) });
    await act(async () => {
      atoms.set(jumpToNextPuzzleAtom, advance);
      treeStore.getState().makeMove({ payload: "Kh8", changeHeaders: false });
    });
    expect(treeStore.getState().currentNode().san).toBe("Kh8");
    const headers = treeStore.getState().headers;
    const changes: string[] = [];
    const unsubscribe = treeStore.subscribe((state) => changes.push(state.currentNode().san!));
    mocks.playSound.mockClear();
    try {
      await humanMove("g5", "h5");
    } finally {
      unsubscribe();
    }
    expect(changes[0]).toBe("Qh5#");
    expect(storedPuzzles()[0].completion).toBe("incorrect");
    expect(storedPuzzles()[0].timeSpent).toBe(4321);
    expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(advance ? 1 : 0);
    expect(treeStore.getState().currentNode().san).toBe(advance ? "Nf3" : "Qh5#");
    expect(treeStore.getState().headers.result).toBe(headers.result);
    expect(mocks.getThemesForPuzzle).not.toHaveBeenCalled();
    expect(mocks.playSound).toHaveBeenCalledTimes(advance ? 2 : 1);
    expect(mocks.notificationShow).not.toHaveBeenCalled();
  },
);

const mateFen = "8/5K1k/8/6Q1/8/8/8/8 b - - 0 1";
test("a still-owned human move installs the normal stored reply through the actual parent", async () => {
  const atoms = await renderPriorPuzzle(
    [puzzleRow({ moves: ["e2e4", "e7e5", "g1f3", "b8c6"] })],
    0,
    ["e4"],
  );
  await act(async () => atoms.set(jumpToNextPuzzleAtom, false));
  await humanMove("e7", "e5");
  expect(treeStore.getState().position).toEqual([0, 0, 0]);
  expect(treeStore.getState().currentNode().san).toBe("Nf3");
  expect(storedPuzzles()[0].completion).toBe("incomplete");
  expect(mocks.getThemesForPuzzle).not.toHaveBeenCalled();
  expect(mocks.playSound).toHaveBeenCalledOnce();
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

test("still-owned immediate advance keeps the final move visible until admitting a fetched successor", async () => {
  const query = deferred<NativePuzzle>();
  mocks.getPuzzle.mockReturnValueOnce(query.promise);
  const atoms = await renderPriorPuzzle([puzzleRow()], 0, ["e4"]);
  await act(async () => atoms.set(jumpToNextPuzzleAtom, true));
  const before = treeStore.getState();
  await humanMove("e7", "e5");
  expect(treeStore.getState()).not.toBe(before);
  expect(treeStore.getState().position).toEqual([0, 0]);
  expect(treeStore.getState().currentNode().san).toBe("e5");
  expect(storedPuzzles()[0].completion).toBe("correct");
  expect(mocks.playSound).toHaveBeenCalledOnce();
  await act(async () => query.resolve({ ...puzzleB(), moves: "g1f3 d7d5" }));
  expect(storedPuzzles()).toHaveLength(2);
  expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(1);
  expect(treeStore.getState().position).toEqual([0]);
  expect(treeStore.getState().currentNode().san).toBe("Nf3");
  expect(treeStore.getState().root.children[0].children).toEqual([]);
  expect(mocks.playSound).toHaveBeenCalledTimes(2);
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

test.each([
  ["final alternative", ["h7h8", "g5g7"], "correct"],
  ["earlier alternative", ["h7h8", "g5e5", "h8h7", "e5h5"], "correct"],
] as const)(
  "accepted %s mate installs Qh5# without a synthetic reply",
  async (_name, moves, completion) => {
    expect(validateMoveSequence(mateFen, [...moves]).success).toBe(true);
    mocks.getPuzzle.mockResolvedValue({ ...puzzleRow(), fen: mateFen, moves: moves.join(" ") });
    const atoms = await renderPuzzles();
    await act(async () => atoms.set(jumpToNextPuzzleAtom, false));
    await newPuzzle();
    expect(treeStore.getState().currentNode().san).toBe("Kh8");
    mocks.playSound.mockClear();
    const completionQuery = deferred<string[]>();
    mocks.getThemesForPuzzle.mockReturnValueOnce(completionQuery.promise);
    await act(async () =>
      atoms.set(puzzleTimerFamily("puzzles-test"), ownedTimer(Date.now() - 1000)),
    );
    await humanMove("g5", "h5");
    const state = treeStore.getState();
    expect(state.position).toEqual([0, 0]);
    expect(state.currentNode().san).toBe("Qh5#");
    expect(makeUci(state.currentNode().move!)).toBe("g5h5");
    expect(state.currentNode().children).toEqual([]);
    const [pos] = positionFromFen(state.currentNode().fen);
    expect(pos?.board.get(parseSquare("h5")!)).toEqual({
      role: "queen",
      color: "white",
      promoted: false,
    });
    expect(pos?.isCheckmate()).toBe(true);
    expect(storedPuzzles()[0].completion).toBe(completion);
    expect(atoms.get(puzzleTimerFamily("puzzles-test"))).toBeNull();
    expect(storedPuzzles()[0].timeSpent).toBeGreaterThanOrEqual(1000);
    expect(mocks.getThemesForPuzzle).toHaveBeenCalledTimes(completion === "correct" ? 1 : 0);
    expect(mocks.playSound).toHaveBeenCalledOnce();
    expect(mocks.notificationShow).not.toHaveBeenCalled();
    expect(state.headers.result).toBe("*");
    expect(mocks.board?.movable?.color).toBeUndefined();
    expect(mocks.board?.movable?.dests?.size).toBe(0);
    expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(0);
    expect(mocks.getPuzzle).toHaveBeenCalledOnce();
    await act(async () => completionQuery.resolve(["mate"]));
    expect(treeStore.getState().root).toEqual(state.root);
    expect(treeStore.getState().position).toEqual(state.position);
    expect(storedPuzzles()[0].themes).toEqual(["mate"]);
    tabStorage.flush();
    const saved = deserializeStorageValue<{ state: TreeState }>(
      sessionStorage.getItem("puzzles-test")!,
    )!.state;
    const selectedIdentity = saved.puzzleSession!.selectedAttemptId;
    const firstResult = { ...saved.puzzleSession!.attempts[0].puzzle };
    await act(async () => root.unmount());
    closeTreeStore("puzzles-test");
    root = createRoot(host);
    const reopenedAtoms = await renderPuzzles({ trackTime: true });
    const reopened = treeStore.getState();
    expect(reopened.puzzleSession!.selectedAttemptId).toBe(selectedIdentity);
    expect(selectedPuzzleIndex(reopened.puzzleSession)).toBe(0);
    expect(reopened.root).toEqual(saved.root);
    expect(reopened.position).toEqual(saved.position);
    expect(reopened.currentNode().san).toBe("Qh5#");
    expect(positionFromFen(reopened.currentNode().fen)[0]?.isCheckmate()).toBe(true);
    expect(getPuzzleProgress(firstResult, reopened.root, reopened.position).nextMove).toBeNull();
    expect(reopened.puzzleSession!.attempts[0].puzzle).toEqual(firstResult);
    expect(reopenedAtoms.get(puzzleTimerFamily("puzzles-test"))).toBeNull();
    expect(mocks.board?.fen).toBe(reopened.currentNode().fen);
    expect(mocks.board?.movable?.color).toBeUndefined();
    await humanMove("h8", "h7");
    expect(treeStore.getState()).toBe(reopened);
    expect(storedPuzzles()[0]).toEqual(firstResult);
  },
);

async function loadPlaybackPuzzle(moves = "e2e4 e7e5 g1f3", fen = INITIAL_FEN) {
  const initialCount = storedPuzzles().length;
  mocks.getPuzzle.mockResolvedValue({
    id: 10,
    fen,
    moves,
    rating: 1200,
    rating_deviation: 50,
    popularity: 1,
    nb_plays: 1,
  });
  const atoms = await renderPuzzles();
  await act(async () => atoms.set(trackPuzzleTimeAtom, false));
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Puzzle.NewPuzzle"]')!.click();
  });
  expect(document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-count")).toBe(
    String(initialCount + 1),
  );
  return atoms;
}

test.each([
  ["promoteToMainline", "replay"],
  ["promoteVariation", "replay"],
  ["promoteToMainline", "current branch"],
  ["promoteVariation", "current branch"],
] as const)("reordered solution remains usable after %s at %s", async (promotion, navigation) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(10000);
  const atoms = await loadPlaybackPuzzle("e2e4 e7e5 g1f3 b8c6");
  await act(async () => {
    atoms.set(jumpToNextPuzzleAtom, false);
    atoms.set(puzzleTimerFamily("puzzles-test"), ownedTimer(9000));
  });
  await humanMove("c7", "c5");
  const firstAttempt = storedPuzzles()[0];
  expect(firstAttempt.completion).toBe("incorrect");
  expect(firstAttempt.timeSpent).toBe(1000);
  const wrongBranch = treeStore.getState().root.children[0].children[0];
  expect(wrongBranch.san).toBe("c5");
  await humanMove("e7", "e5");
  expect(treeStore.getState().position).toEqual([0, 0, 0]);
  expect(treeStore.getState().currentNode().san).toBe("Nf3");
  const headers = treeStore.getState().headers;
  await act(async () => treeStore.getState()[promotion]([0, 1]));
  expect(treeStore.getState().position).toEqual([0, 1, 0]);
  if (navigation === "replay") {
    await act(async () => treeStore.getState().goToMove([0]));
  }
  expect(mocks.board?.movable?.color).toBe("black");
  if (navigation === "replay") await humanMove("e7", "e5");
  expect(treeStore.getState().position).toEqual([0, 1, 0]);
  expect(treeStore.getState().currentNode().san).toBe("Nf3");
  expect(mocks.board?.movable?.color).toBe("black");
  expect(hintButton().disabled).toBe(false);
  await act(async () => hintButton().click());
  expect(treeStore.getState().currentNode().shapes).toEqual([
    { orig: "b8", dest: undefined, brush: "green" },
  ]);
  vi.setSystemTime(15000);
  await humanMove("b8", "c6");
  const state = treeStore.getState();
  expect(state.position).toEqual([0, 1, 0, 0]);
  expect(state.currentNode().san).toBe("Nc6");
  expect(state.root.children[0].children.map((node) => node.san)).toEqual(["c5", "e5"]);
  expect(state.root.children[0].children[0]).toEqual(wrongBranch);
  expect(state.headers).toEqual(headers);
  expect(state.headers.result).toBe("*");
  expect(storedPuzzles()[0]).toEqual(firstAttempt);
  expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(0);
  expect(hintButton().disabled).toBe(true);
  expect(mocks.board?.movable?.color).toBe("white");
  expect(mocks.getThemesForPuzzle).toHaveBeenCalledOnce();
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

test.each(["earlier solution", "wrong branch", "invalid path"] as const)(
  "reordered %s cursor blocks play while preserving only matched hints",
  async (mode) => {
    await loadPlaybackPuzzle("e2e4 e7e5 g1f3 b8c6");
    await humanMove("c7", "c5");
    await humanMove("e7", "e5");
    await act(async () => {
      treeStore.getState().promoteToMainline([0, 1]);
      treeStore
        .getState()
        .goToMove(
          mode === "earlier solution" ? [0, 1] : mode === "wrong branch" ? [0, 0] : [0, 99],
        );
    });
    const before = treeStore.getState();
    const progress = getPuzzleProgress(storedPuzzles()[0], before.root, before.position);
    expect(progress.step).toBe(mode === "earlier solution" ? 2 : null);
    expect(progress.atFrontier).toBe(false);
    expect(mocks.board?.movable?.color).toBeUndefined();
    expect(hintButton().disabled).toBe(mode !== "earlier solution");
    mocks.playSound.mockClear();
    await humanMove("g1", "f3");
    expect(treeStore.getState()).toBe(before);
    expect(mocks.playSound).not.toHaveBeenCalled();
    expect(mocks.notificationShow).not.toHaveBeenCalled();
    await act(async () => hintButton().click());
    expect(treeStore.getState().currentNode().shapes).toEqual(
      mode === "earlier solution" ? [{ orig: "g1", dest: undefined, brush: "green" }] : [],
    );
  },
);

test("a terminal alternate mate offers no hint or bogus shape", async () => {
  const atoms = await loadPlaybackPuzzle("h7h8 g5g7", mateFen);
  await act(async () => atoms.set(jumpToNextPuzzleAtom, false));
  await humanMove("g5", "h5");
  expect(treeStore.getState().currentNode().san).toBe("Qh5#");
  const before = treeStore.getState();
  const rows = storedHistoryBytes();
  expect(hintButton().disabled).toBe(true);
  await act(async () => hintButton().click());
  expect(treeStore.getState()).toBe(before);
  expect(treeStore.getState().currentNode().shapes).toEqual([]);
  expect(storedHistoryBytes()).toBe(rows);
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

test.each([true, false])(
  "puzzle drawings stay editable through progressive hints with erase preference %s",
  async (erase) => {
    const atoms = await loadPlaybackPuzzle();
    await act(async () => atoms.set(eraseDrawablesOnClickAtom, erase));
    const marks: DrawShape[] = [
      { orig: "c4", brush: "green" },
      { orig: "d4", brush: "green" },
      { orig: "a3", dest: "a5", brush: "green" },
    ];
    expect(mocks.board?.drawable?.eraseOnMovablePieceClick).toBe(erase);
    expect(mocks.board?.drawable?.onChange).toEqual(expect.any(Function));
    await act(async () => mocks.board!.drawable!.onChange!(marks));
    expect(treeStore.getState().currentNode().shapes).toEqual(marks);
    for (const hint of [
      [{ orig: "e7", dest: undefined, brush: "green" }],
      [{ orig: "e7", dest: "e5", brush: "green" }],
      [],
    ]) {
      await act(async () => hintButton().click());
      expect(mocks.board?.drawable?.shapes).toEqual([...marks, ...hint]);
      expect(mocks.board?.drawable?.autoShapes).toEqual([]);
      expect(treeStore.getState().currentNode().shapes).toEqual([...marks, ...hint]);
    }
    // Chessground reports its complete remaining editable layer when toggling or clearing.
    await act(async () => mocks.board!.drawable!.onChange!(marks.slice(1)));
    expect(treeStore.getState().currentNode().shapes).toEqual(marks.slice(1));
    expect(mocks.board?.drawable?.shapes).toEqual(marks.slice(1));
    await act(async () => mocks.board!.drawable!.onChange!([]));
    expect(treeStore.getState().currentNode().shapes).toEqual([]);
    expect(mocks.board?.drawable?.shapes).toEqual([]);
  },
);

test("the second Nf3 occurrence hints d7-d5 from the live cursor with progressive shapes", async () => {
  const moves = "e2e4 g8f6 g1f3 f6g8 f3g1 g8f6 g1f3 d7d5";
  expect(validateMoveSequence(INITIAL_FEN, moves.split(" ")).success).toBe(true);
  await loadPlaybackPuzzle(moves);
  await act(async () => {
    expect(
      treeStore.getState().makeMoves({ payload: moves.split(" ").slice(1), changeHeaders: false })
        .success,
    ).toBe(true);
    treeStore.getState().goToMove([0, 0, 0]);
  });
  expect(treeStore.getState().currentNode().san).toBe("Nf3");
  expect(hintButton().disabled).toBe(false);
  await act(async () => {
    treeStore.getState().goToMove([0, 0, 0, 0, 0, 0, 0]);
    hintButton().click();
  });
  expect(treeStore.getState().currentNode().san).toBe("Nf3");
  expect(treeStore.getState().currentNode().shapes).toEqual([
    { orig: "d7", dest: undefined, brush: "green" },
  ]);
  await act(async () => hintButton().click());
  expect(treeStore.getState().currentNode().shapes).toEqual([
    { orig: "d7", dest: "d5", brush: "green" },
  ]);
  await act(async () => hintButton().click());
  expect(treeStore.getState().currentNode().shapes).toEqual([]);
  expect(mocks.board?.movable?.color).toBeUndefined();
  expect(mocks.getThemesForPuzzle).toHaveBeenCalledOnce();
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

test("hints use relative progress at a Black-to-move nonstandard initial ply", async () => {
  const atoms = await loadPlaybackPuzzle("e7e5 g1f3", blackPuzzleFen);
  await act(async () => atoms.set(jumpToNextPuzzleAtom, false));
  expect(treeStore.getState().root.halfMoves).toBe(45);
  expect(treeStore.getState().currentNode().halfMoves).toBe(46);
  expect(mocks.board?.movable?.color).toBe("white");
  expect(hintButton().disabled).toBe(false);
  await act(async () => hintButton().click());
  expect(treeStore.getState().currentNode().shapes).toEqual([
    { orig: "g1", dest: undefined, brush: "green" },
  ]);
  await act(async () => hintButton().click());
  expect(treeStore.getState().currentNode().shapes).toEqual([
    { orig: "g1", dest: "f3", brush: "green" },
  ]);
  await humanMove("g1", "f3");
  expect(treeStore.getState().currentNode().san).toBe("Nf3");
  expect(storedPuzzles()[0].completion).toBe("incorrect");
  expect(hintButton().disabled).toBe(true);
});

test("root and no-last-move positions offer no continuation hint", async () => {
  await loadPlaybackPuzzle();
  await act(async () => treeStore.getState().goToMove([]));
  const before = treeStore.getState();
  expect(before.currentNode().move).toBeNull();
  expect(hintButton().disabled).toBe(true);
  await act(async () => hintButton().click());
  expect(treeStore.getState()).toBe(before);
  expect(storedPuzzles()[0].completion).toBe("incomplete");
  expect(mocks.getThemesForPuzzle).not.toHaveBeenCalled();
});

test.each(["earlier", "variation", "prefix mismatch", "root mismatch"] as const)(
  "puzzle play remains frontier-only at %s and unmatched cursors offer no hint",
  async (mode) => {
    await loadPlaybackPuzzle();
    await act(async () => {
      treeStore.getState().makeMoves({ payload: ["e7e5", "g1f3"], changeHeaders: false });
      if (mode === "earlier") treeStore.getState().goToMove([0]);
      else if (mode === "variation") {
        treeStore.getState().goToMove([0]);
        treeStore.getState().makeMove({ payload: "c5" });
      } else if (mode === "prefix mismatch") {
        treeStore.getState().setFen(INITIAL_FEN);
        treeStore.getState().makeMove({ payload: "d4" });
      } else {
        treeStore.getState().setFen(blackPuzzleFen);
        treeStore.getState().makeMove({ payload: "e5" });
      }
    });
    const before = treeStore.getState();
    expect(mocks.board?.movable?.color).toBeUndefined();
    expect(hintButton().disabled).toBe(mode !== "earlier");
    mocks.playSound.mockClear();
    await humanMove(
      mode === "variation" || mode === "root mismatch" ? "g1" : "e7",
      mode === "variation" || mode === "root mismatch" ? "f3" : "e6",
    );
    expect(treeStore.getState()).toBe(before);
    expect(mocks.getThemesForPuzzle).not.toHaveBeenCalled();
    expect(mocks.playSound).not.toHaveBeenCalled();
    expect(mocks.notificationShow).not.toHaveBeenCalled();
  },
);

test("atomic pair rejection reports a malformed live suffix through the real store result", async () => {
  await loadPlaybackPuzzle("e2e4 e7e5 g1f3");
  expect(validateMoveSequence(INITIAL_FEN, ["e2e4", "e7e5", "g1f3"]).success).toBe(true);
  await act(async () => {
    const state = treeStore.getState();
    treeStore.getState().setState({
      ...state,
      root: {
        ...state.root,
        children: [
          {
            ...state.root.children[0],
            fen: "rnbqkbnr/pppppppp/8/8/4P3/7N/PPPP1PPP/RNBQKB1R b KQkq - 1 1",
          },
        ],
      },
    });
  });
  expect(mocks.board?.movable?.color).toBe("black");
  const before = treeStore.getState();
  const rows = storedHistoryBytes();
  mocks.playSound.mockClear();
  await humanMove("e7", "e5");
  expect(treeStore.getState()).toBe(before);
  expect(storedHistoryBytes()).toBe(rows);
  expect(mocks.playSound).not.toHaveBeenCalled();
  expect(mocks.getThemesForPuzzle).not.toHaveBeenCalled();
  expect(mocks.getPuzzle).toHaveBeenCalledOnce();
  expect(mocks.notificationShow).toHaveBeenCalledExactlyOnceWith({
    title: "Common.Error",
    message: "MoveInput.InvalidMove (2)",
    color: "danger",
  });
});

test("Previous during solution playback preserves e4 and prevents a wrong promoted mainline", async () => {
  await loadPlaybackPuzzle("e2e4 e7e5 g1f3 b8c6");
  vi.useFakeTimers();
  await act(async () => solutionButton().click());
  const committed = treeStore.getState();
  expect(committed.currentNode().san).toBe("e4");
  await act(async () => previousButton().click());
  const navigated = treeStore.getState();
  expect(navigated).not.toBe(committed);
  expect(navigated.position).not.toBe(committed.position);
  expect(navigated.position).toEqual([]);
  mocks.playSound.mockClear();
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(treeStore.getState()).toBe(navigated);
  expect(treeStore.getState().root.children.map((node) => node.san)).toEqual(["e4"]);
  expect(treeStore.getState().root.children[0].children).toEqual([]);
  expect(mocks.playSound).not.toHaveBeenCalled();
  expect(mocks.notificationShow).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => nextButton().click());
  expect(treeStore.getState().currentNode().san).toBe("e4");
  expect(hintButton().disabled).toBe(false);
});

test("a playback metadata failure after Previous is quiet and cannot change the navigated tree", async () => {
  await loadPlaybackPuzzle("e2e4 e7e5 g1f3 b8c6");
  const completion = deferred<string[]>();
  mocks.getThemesForPuzzle.mockReturnValueOnce(completion.promise);
  vi.useFakeTimers();
  await act(async () => solutionButton().click());
  await act(async () => previousButton().click());
  const before = treeStore.getState();
  const rows = storedHistoryBytes();
  mocks.playSound.mockClear();
  await act(async () =>
    completion.reject(commandError("database", "stale playback metadata failed")),
  );
  expect(mocks.notificationShow).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(treeStore.getState()).toBe(before);
  expect(storedHistoryBytes()).toBe(rows);
  expect(mocks.notificationShow).not.toHaveBeenCalled();
  expect(mocks.playSound).not.toHaveBeenCalled();
  await act(async () => nextButton().click());
  expect(hintButton().disabled).toBe(false);
});

test.each(["same cursor", "tree", "selection", "clear"] as const)(
  "%s replacement during playback stops late moves and settles only its owner",
  async (replacement) => {
    sessionStorage.setItem("puzzles-test-puzzles", JSON.stringify([puzzleB()]));
    await loadPlaybackPuzzle("e2e4 e7e5 g1f3 b8c6");
    vi.useFakeTimers();
    await act(async () => solutionButton().click());
    const committed = treeStore.getState();
    await act(async () => {
      if (replacement === "same cursor") treeStore.getState().goToMove([...committed.position]);
      else if (replacement === "tree") treeStore.getState().setFen(INITIAL_FEN);
      else if (replacement === "selection")
        document
          .querySelector<HTMLButtonElement>('[aria-label="ChallengeHistory.Incomplete"]')!
          .click();
      else document.querySelector<HTMLButtonElement>('[aria-label="Puzzle.ClearSession"]')!.click();
    });
    const replaced = treeStore.getState();
    expect(replaced).not.toBe(committed);
    const rows = storedHistoryBytes();
    mocks.playSound.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(treeStore.getState()).toBe(replaced);
    expect(storedHistoryBytes()).toBe(rows);
    expect(mocks.playSound).not.toHaveBeenCalled();
    expect(mocks.notificationShow).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

test.each(["declared start", "invalid path", "unrelated root"] as const)(
  "solution playback rejects %s without resetting or publishing the tree",
  async (mismatch) => {
    await loadPlaybackPuzzle("e2e4 e7e5 g1f3 b8c6");
    await act(async () => {
      if (mismatch === "declared start") treeStore.getState().setStart([0]);
      else if (mismatch === "invalid path") treeStore.getState().setStart([99]);
      else treeStore.getState().setFen(blackPuzzleFen);
    });
    const before = treeStore.getState();
    const rows = storedHistoryBytes();
    mocks.playSound.mockClear();
    await act(async () => solutionButton().click());
    expect(treeStore.getState()).toBe(before);
    expect(storedHistoryBytes()).toBe(rows);
    expect(mocks.getThemesForPuzzle).not.toHaveBeenCalled();
    expect(mocks.playSound).not.toHaveBeenCalled();
    expect(mocks.notificationShow).not.toHaveBeenCalled();
  },
);

test("still-owned playback preserves an existing variation and its comment", async () => {
  await loadPlaybackPuzzle("e2e4 e7e5 g1f3 b8c6");
  await act(async () => {
    treeStore.getState().goToMove([]);
    treeStore.getState().makeMove({ payload: "d4" });
    treeStore.getState().setComment("retained variation");
    treeStore.getState().goToMove([0]);
  });
  const variation = treeStore.getState().root.children[1];
  expect(variation.san).toBe("d4");
  vi.useFakeTimers();
  await act(async () => solutionButton().click());
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(treeStore.getState().position).toEqual([0, 0, 0, 0]);
  expect(treeStore.getState().currentNode().san).toBe("Nc6");
  expect(treeStore.getState().root.children[1]).toEqual(variation);
  expect(variation.comment).toBe("retained variation");
  expect(mocks.notificationShow).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  ["malformed middle", "e2e4 g7z5 g1f3", 2, "g7z5"],
  ["malformed suffix", "e2e4 e7e5 g1z3", 3, "g1z3"],
  ["illegal middle", "e2e4 e7e4 g1f3", 2, "e7e4"],
  ["illegal suffix", "e2e4 e7e5 g1g3", 3, "g1g3"],
] as const)(
  "View solution rejects persisted %s without mutation or sound",
  async (_name, moves, _index, _token) => {
    sessionStorage.setItem(
      "puzzles-test-puzzles",
      JSON.stringify([puzzleRow({ moves: moves.split(" ") })]),
    );
    await renderPuzzles();
    expect(mocks.notificationShow).not.toHaveBeenCalled();
    expect(treeStore.getState().root.children).toEqual([]);
    expect(treeStore.getState().dirty).toBe(false);
    const before = treeStore.getState();
    mocks.notificationShow.mockClear();
    mocks.playSound.mockClear();
    await act(async () => solutionButton().click());
    expect(treeStore.getState()).toBe(before);
    expect(treeStore.getState()).toEqual(before);
    expect(mocks.playSound).not.toHaveBeenCalled();
    expect(storedPuzzles()).toEqual([]);
    expect(solutionButton().disabled).toBe(true);
    expect(mocks.notificationShow).not.toHaveBeenCalled();
    expect(mocks.getThemesForPuzzle).not.toHaveBeenCalled();
    await act(async () => solutionButton().click());
    expect(mocks.notificationShow).not.toHaveBeenCalled();
    expect(treeStore.getState()).toBe(before);
  },
);

test("View solution preserves 500 ms playback and normal completion", async () => {
  await loadPlaybackPuzzle();
  vi.useFakeTimers();
  mocks.playSound.mockClear();
  await act(async () => solutionButton().click());
  expect(treeStore.getState().position).toEqual([0]);
  expect(hintButton().disabled).toBe(true);
  expect(mocks.getThemesForPuzzle).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTimeAsync(499));
  expect(treeStore.getState().position).toEqual([0]);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(treeStore.getState().position).toEqual([0, 0]);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(treeStore.getState().position).toEqual([0, 0, 0]);
  expect(treeStore.getState().currentNode().san).toBe("Nf3");
  expect(mocks.playSound).toHaveBeenCalledTimes(3);
  expect(mocks.notificationShow).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("View solution reports a thrown store subscriber and releases playing ownership", async () => {
  await loadPlaybackPuzzle();
  const unsubscribe = treeStore.subscribe((state) => {
    if (state.currentNode().move) throw new Error("playback subscriber failed");
  });
  try {
    await act(async () => solutionButton().click());
    expect(mocks.notificationShow).toHaveBeenCalledWith(
      expect.objectContaining({
        color: "danger",
        message: "playback subscriber failed",
      }),
    );
    expect(hintButton().disabled).toBe(false);
  } finally {
    unsubscribe();
  }
});

test("a superseded View solution cannot clear or advance its successor", async () => {
  await loadPlaybackPuzzle();
  vi.useFakeTimers();
  await act(async () => solutionButton().click());
  await act(async () => vi.advanceTimersByTimeAsync(250));
  await act(async () => solutionButton().click());
  const successor = treeStore.getState();
  mocks.playSound.mockClear();
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(treeStore.getState()).toBe(successor);
  expect(mocks.playSound).not.toHaveBeenCalled();
  expect(hintButton().disabled).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(treeStore.getState().position).toEqual([0, 0]);
  expect(hintButton().disabled).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(treeStore.getState().position).toEqual([0, 0, 0]);
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

test("a stale thrown playback cannot notify or clear its replacement's playing state", async () => {
  await loadPlaybackPuzzle();
  vi.useFakeTimers();
  let replaced = false;
  const previousPlaybackPosition = treeStore.getState().position;
  const unsubscribe = treeStore.subscribe((state) => {
    if (
      !replaced &&
      state.position.length === 1 &&
      state.puzzleSession?.attempts[0].puzzle.completion === "incorrect" &&
      state.position !== previousPlaybackPosition
    ) {
      replaced = true;
      solutionButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      throw new Error("stale playback subscriber failed");
    }
  });
  try {
    await act(async () => solutionButton().click());
    expect(replaced).toBe(true);
    expect(hintButton().disabled).toBe(true);
    expect(mocks.notificationShow).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(treeStore.getState().position).toEqual([0, 0]);
    expect(hintButton().disabled).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(treeStore.getState().position).toEqual([0, 0, 0]);
    expect(mocks.notificationShow).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
  }
});

test.each(["new puzzle", "database", "unmount"] as const)(
  "%s cancels View solution without late moves or errors",
  async (replacement) => {
    const atoms = await loadPlaybackPuzzle();
    vi.useFakeTimers();
    await act(async () => solutionButton().click());
    await act(async () => {
      if (replacement === "new puzzle") {
        document.querySelector<HTMLButtonElement>('[aria-label="Puzzle.NewPuzzle"]')!.click();
      } else if (replacement === "database") {
        atoms.set(selectedPuzzleDbAtom, otherDb);
      } else {
        root.unmount();
      }
    });
    const before = treeStore.getState();
    mocks.playSound.mockClear();
    mocks.notificationShow.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(treeStore.getState()).toBe(before);
    expect(mocks.playSound).not.toHaveBeenCalled();
    expect(mocks.notificationShow).not.toHaveBeenCalled();
  },
);

function commandError(category: ErrorCategory, message: string) {
  return new TauriCommandError({
    tag: "backend-error",
    category,
    message,
  });
}

const blackPuzzleFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 23";
const rejectedCandidates = [
  ["malformed FEN", { fen: "invalid", moves: ["e2e4"] }, "Board.Analysis.InvalidPosition"],
  [
    "invalid setup",
    { fen: "8/8/8/8/8/8/8/8 w - - 0 1", moves: ["e2e4"] },
    "Board.Analysis.InvalidPosition",
  ],
  [
    "Black-to-move illegal suffix",
    { fen: blackPuzzleFen, moves: ["e7e5", "g1g3"] },
    "MoveInput.InvalidMove (2)",
  ],
  [
    "Black-to-move malformed suffix",
    { fen: blackPuzzleFen, moves: ["e7e5", "g1z3"] },
    "MoveInput.InvalidMove (2)",
  ],
] as const;

async function renderPriorPuzzle(rows: Puzzle[], index = 0, line = ["e4", "e5", "Nf3"]) {
  const initial = defaultTree();
  initial.puzzleSession = testSession(rows, index);
  const atoms = await renderPuzzles({ initial });
  await act(async () => {
    treeStore.getState().transitionPuzzleSession((draft) => {
      draft.puzzleSession!.selectedAttemptId =
        draft.puzzleSession!.attempts[index]?.attemptId ?? null;
    });
    treeStore.getState().makeMoves({ payload: line });
    treeStore.getState().goToMove([0]);
    treeStore.getState().setStart([0]);
    treeStore.getState().setPracticePath(line.length > 1 ? [0, 0] : [0]);
    treeStore.getState().setResult("1-0");
    treeStore.getState().save();
    atoms.set(puzzleTimerFamily("puzzles-test"), ownedTimer(1234));
  });
  mocks.playSound.mockClear();
  mocks.notificationShow.mockClear();
  return atoms;
}

test.each(rejectedCandidates)(
  "admission rejects fetched %s before any publication with the real PuzzleBoard",
  async (_name, candidate, message) => {
    const rows = [
      puzzleRow({ id: 1, completion: "correct" }),
      puzzleRow({ id: 2, completion: "correct" }),
    ];
    const atoms = await renderPriorPuzzle(rows, 1);
    const before = treeStore.getState();
    const previousRows = storedHistoryBytes();
    const previousBoard = mocks.board;
    const treeChanged = vi.fn();
    const indexChanged = vi.fn();
    const timerChanged = vi.fn();
    const unsubscribeTree = treeStore.subscribe(treeChanged);
    const unsubscribeIndex = treeStore.subscribe((next, prior) => {
      if (next.puzzleSession?.selectedAttemptId !== prior.puzzleSession?.selectedAttemptId)
        indexChanged();
    });
    const unsubscribeTimer = atoms.sub(puzzleTimerFamily("puzzles-test"), timerChanged);
    const write = vi.spyOn(Storage.prototype, "setItem");
    mocks.getPuzzle.mockResolvedValue({
      ...puzzleRow(),
      ...candidate,
      moves: candidate.moves.join(" "),
    });
    try {
      await newPuzzle();
      expect(storedHistoryBytes()).toBe(previousRows);
      expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(1);
      expect(atoms.get(puzzleTimerFamily("puzzles-test"))).toEqual(ownedTimer(1234));
      expect(treeStore.getState()).toBe(before);
      expect(treeStore.getState()).toEqual(before);
      expect(treeChanged).not.toHaveBeenCalled();
      expect(indexChanged).not.toHaveBeenCalled();
      expect(timerChanged).not.toHaveBeenCalled();
      expect(write.mock.calls.filter(([key]) => key === "puzzles-test-puzzles")).toEqual([]);
      expect(mocks.board?.fen).toBe(previousBoard?.fen);
      expect(mocks.board?.orientation).toBe(previousBoard?.orientation);
      expect(mocks.playSound).not.toHaveBeenCalled();
      expect(mocks.getThemesForPuzzle).not.toHaveBeenCalled();
      expect(mocks.notificationShow).toHaveBeenCalledExactlyOnceWith({
        color: "danger",
        title: "Common.Error",
        message,
      });
      await act(async () => Promise.resolve());
      expect(mocks.notificationShow).toHaveBeenCalledOnce();
    } finally {
      unsubscribeTree();
      unsubscribeIndex();
      unsubscribeTimer();
      write.mockRestore();
    }
  },
);

test.each(rejectedCandidates)(
  "legacy history independently drops %s while preserving valid neighbors",
  async (_name, candidate) => {
    sessionStorage.setItem(
      "puzzles-test-puzzles",
      JSON.stringify([
        puzzleRow({ completion: "correct" }),
        { ...puzzleRow(), ...candidate },
        puzzleB(),
      ]),
    );
    await renderPuzzles({ legacy: true });
    expect(storedPuzzles()).toEqual([puzzleRow({ completion: "correct" }), puzzleB()]);
    expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(-1);
    expect(treeStore.getState().root.children).toEqual([]);
    expect(mocks.board?.movable?.color).toBeUndefined();
    expect(solutionButton().disabled).toBe(true);
    expect(mocks.notificationShow).not.toHaveBeenCalled();
  },
);

test.each(rejectedCandidates)(
  "admission rejects fetched next %s without erasing the committed current move",
  async (_name, candidate, message) => {
    const query = deferred<NativePuzzle>();
    mocks.getPuzzle.mockReturnValueOnce(query.promise);
    const atoms = await renderPriorPuzzle([puzzleRow()], 0, ["e4"]);
    await act(async () => atoms.set(jumpToNextPuzzleAtom, true));
    const before = treeStore.getState();
    await humanMove("e7", "e5");
    const committed = treeStore.getState();
    expect(committed).not.toBe(before);
    expect(committed.position).toEqual([0, 0]);
    expect(committed.currentNode().san).toBe("e5");
    expect(committed.headers).toEqual(before.headers);
    expect(mocks.playSound).toHaveBeenCalledOnce();
    const rows = storedHistoryBytes();
    const treeChanged = vi.fn();
    const unsubscribe = treeStore.subscribe(treeChanged);
    try {
      await act(async () =>
        query.resolve({ ...puzzleRow(), ...candidate, moves: candidate.moves.join(" ") }),
      );
      expect(treeStore.getState()).toBe(committed);
      expect(treeChanged).not.toHaveBeenCalled();
      expect(storedHistoryBytes()).toBe(rows);
      expect(storedPuzzles()).toHaveLength(1);
      expect(storedPuzzles()[0].completion).toBe("correct");
      expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(0);
      expect(atoms.get(puzzleTimerFamily("puzzles-test"))).toBeNull();
      expect(mocks.playSound).toHaveBeenCalledOnce();
      expect(mocks.notificationShow).toHaveBeenCalledExactlyOnceWith({
        color: "danger",
        title: "Common.Error",
        message,
      });
    } finally {
      unsubscribe();
    }
  },
);

test("admission suppresses a stale malformed fetched row after valid history selection", async () => {
  const valid = puzzleRow({ id: 99, fen: blackPuzzleFen, moves: ["e7e5", "g1f3"] });
  await renderPriorPuzzle([puzzleRow({ completion: "correct" }), valid]);
  let resolvePuzzle!: (puzzle: NativePuzzle) => void;
  let signal!: AbortSignal;
  mocks.getPuzzle.mockImplementation(
    (
      _db: unknown,
      _min: unknown,
      _max: unknown,
      _theme: unknown,
      options: { signal: AbortSignal },
    ) => {
      signal = options.signal;
      return new Promise<NativePuzzle>((resolve) => {
        resolvePuzzle = resolve;
      });
    },
  );
  await newPuzzle();
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[aria-label="ChallengeHistory.Incomplete"]')!
      .click(),
  );
  expect(signal.aborted).toBe(true);
  expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(1);
  expect(treeStore.getState().root.fen).toBe(blackPuzzleFen);
  expect(treeStore.getState().currentNode().san).toBe("e5");
  expect(mocks.board?.orientation).toBe("white");
  expect(mocks.board?.movable?.color).toBe("white");
  const before = treeStore.getState();
  const previousRows = storedHistoryBytes();
  mocks.playSound.mockClear();
  await act(async () => resolvePuzzle({ ...valid, fen: "invalid", moves: "e2e4" }));
  expect(treeStore.getState()).toBe(before);
  expect(storedHistoryBytes()).toBe(previousRows);
  expect(mocks.playSound).not.toHaveBeenCalled();
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

test("database dropdown cancels a fetched malformed candidate without stale notification", async () => {
  mocks.listPuzzleDatabases.mockResolvedValue([selectedDatabase, otherDatabase]);
  const atoms = await renderPriorPuzzle([puzzleRow({ completion: "correct" })]);
  let resolvePuzzle!: (puzzle: NativePuzzle) => void;
  let signal!: AbortSignal;
  mocks.getPuzzle.mockImplementation(
    (
      _db: unknown,
      _min: unknown,
      _max: unknown,
      _theme: unknown,
      options: { signal: AbortSignal },
    ) => {
      signal = options.signal;
      return new Promise<NativePuzzle>((resolve) => {
        resolvePuzzle = resolve;
      });
    },
  );
  await newPuzzle();
  await act(async () =>
    document.querySelector<HTMLInputElement>('[placeholder="Puzzle.SelectDatabase"]')!.click(),
  );
  await act(async () => {
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === "Other")!
      .click();
  });
  expect(atoms.get(selectedPuzzleDbAtom)).toEqual(otherDb);
  expect(signal.aborted).toBe(true);
  const before = treeStore.getState();
  const previousRows = storedHistoryBytes();
  await act(async () => resolvePuzzle({ ...puzzleRow(), fen: "invalid", moves: "e2e4" }));
  expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(0);
  expect(atoms.get(puzzleTimerFamily("puzzles-test"))).toEqual(ownedTimer(1234));
  expect(treeStore.getState()).toBe(before);
  expect(storedHistoryBytes()).toBe(previousRows);
  expect(mocks.playSound).not.toHaveBeenCalled();
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

test("admission installs a valid fetched Black-to-move puzzle and preserves normal completion", async () => {
  const atoms = await renderPriorPuzzle([puzzleRow({ completion: "correct" })]);
  await act(async () => atoms.set(jumpToNextPuzzleAtom, false));
  const candidate = puzzleRow({ id: 99, fen: blackPuzzleFen, moves: ["e7e5", "g1f3"] });
  mocks.getPuzzle.mockResolvedValue({ ...candidate, moves: candidate.moves.join(" ") });
  await newPuzzle();
  expect(storedPuzzles()).toHaveLength(2);
  expect(storedPuzzles()[1]).toEqual(candidate);
  expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(1);
  expect(treeStore.getState().root.fen).toBe(blackPuzzleFen);
  expect(treeStore.getState().root.halfMoves).toBe(45);
  expect(treeStore.getState().currentNode().halfMoves).toBe(46);
  expect(treeStore.getState().currentNode().san).toBe("e5");
  expect(treeStore.getState().position).toEqual([0]);
  expect(mocks.board?.orientation).toBe("white");
  expect(mocks.board?.movable?.color).toBe("white");
  expect(mocks.playSound).toHaveBeenCalledOnce();
  await act(async () => mocks.board!.movable!.events!.after!("g1", "f3", { premove: false }));
  expect(storedPuzzles()[1].completion).toBe("correct");
  expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(1);
  expect(treeStore.getState().position).toEqual([0, 0]);
  expect(treeStore.getState().currentNode().san).toBe("Nf3");
  expect(mocks.playSound).toHaveBeenCalledTimes(2);
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

test("admission installs a valid cached next puzzle through immediate advance", async () => {
  const cached = puzzleRow({ id: 99, fen: blackPuzzleFen, moves: ["e7e5", "g1f3"] });
  const atoms = await renderPriorPuzzle([puzzleRow(), cached], 0, ["e4"]);
  await act(async () => atoms.set(jumpToNextPuzzleAtom, true));
  await act(async () => mocks.board!.movable!.events!.after!("e7", "e5", { premove: false }));
  expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(1);
  expect(storedPuzzles()[0].completion).toBe("correct");
  expect(storedPuzzles()[1]).toEqual(cached);
  expect(treeStore.getState().root.fen).toBe(blackPuzzleFen);
  expect(treeStore.getState().currentNode().san).toBe("e5");
  expect(treeStore.getState().position).toEqual([0]);
  expect(mocks.board?.orientation).toBe("white");
  expect(mocks.playSound).toHaveBeenCalledTimes(2);
  expect(mocks.getPuzzle).not.toHaveBeenCalled();
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

test("a malformed persisted FEN renders safely and cannot record an incorrect attempt", async () => {
  const row = puzzleRow({ fen: "invalid", moves: ["e7e5", "g1z3"] });
  const atoms = await renderPriorPuzzle([row], 0, ["e4"]);
  const before = treeStore.getState();
  const previousRows = storedHistoryBytes();
  expect(mocks.board?.movable?.color).toBeUndefined();
  expect(
    document.querySelector<HTMLButtonElement>('[aria-label="Puzzle.AnalyzePosition"]')?.disabled,
  ).toBe(true);
  await act(async () => mocks.board!.movable!.events!.after!("e7", "e5", { premove: false }));
  expect(treeStore.getState()).toBe(before);
  expect(storedHistoryBytes()).toBe(previousRows);
  expect(atoms.get(puzzleTimerFamily("puzzles-test"))).toEqual(ownedTimer(1234));
  expect(mocks.getThemesForPuzzle).not.toHaveBeenCalled();
  expect(mocks.playSound).not.toHaveBeenCalled();
  expect(mocks.notificationShow).not.toHaveBeenCalled();
  expect(hintButton().disabled).toBe(true);
  await act(async () => hintButton().click());
  expect(treeStore.getState()).toBe(before);
  expect(storedHistoryBytes()).toBe(previousRows);
  expect(atoms.get(puzzleTimerFamily("puzzles-test"))).toEqual(ownedTimer(1234));
  expect(mocks.getThemesForPuzzle).not.toHaveBeenCalled();
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

function outdatedAlert() {
  return [...document.querySelectorAll('[role="alert"]')].find((element) =>
    element.textContent?.includes("Puzzle.DatabaseOutdated"),
  );
}

let treeStore: TreeStore;
function CaptureTreeStore() {
  treeStore = useContext(TreeStateContext)!;
  return null;
}

let root: Root;
let host: HTMLDivElement;
let portals: HTMLDivElement;

beforeEach(() => {
  vi.resetAllMocks();
  sessions.remove("puzzles-test");
  mocks.chessriddleTrainingAvailable.mockResolvedValue(false);
  mocks.chessriddleTrainingNext.mockResolvedValue(trainingPuzzle);
  mocks.chessriddleMistakeCount.mockResolvedValue(2);
  mocks.chessriddleAccount.mockResolvedValue({ status: "disconnected" });
  mocks.connectChessriddle.mockResolvedValue(connectedAccount);
  mocks.board = null;
  mocks.selectedDatabase = null;
  mocks.addPuzzleProps = null;
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("puzzle-db", JSON.stringify(selectedDb));
  mocks.getPuzzleWorkspace.mockResolvedValue(workspace);
  mocks.listPuzzleDatabases.mockResolvedValue([selectedDatabase]);
  mocks.getPuzzleThemes.mockResolvedValue([]);
  mocks.getPuzzle.mockResolvedValue({
    id: 1,
    fen: "8/8/8/8/8/8/8/K6k w - - 0 1",
    moves: "a1a2",
    rating: 1200,
    rating_deviation: 50,
    popularity: 1,
    nb_plays: 1,
  });
  mocks.getThemesForPuzzle.mockResolvedValue([]);
  mocks.deletePuzzleDatabase.mockResolvedValue(undefined);
  mocks.getSoundServerPort.mockRejectedValue(new Error("sound disabled in test"));
  host = document.createElement("div");
  portals = document.createElement("div");
  portals.innerHTML = `<div id="left"></div><div id="topRight"></div><div id="bottomRight"></div>`;
  document.body.append(portals, host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  sessions.remove("puzzles-test");
  closeTreeStore("puzzles-test");
  vi.restoreAllMocks();
  vi.useRealTimers();
  host.remove();
  portals.remove();
  localStorage.clear();
  sessionStorage.clear();
});

async function renderPuzzles({
  initial,
  trackTime = false,
  legacy = false,
  atoms,
}: {
  initial?: TreeState;
  trackTime?: boolean;
  legacy?: boolean;
  atoms?: ReturnType<typeof createStore>;
} = {}) {
  const store = atoms ?? createStore();
  if (!atoms) {
    store.set(selectedPuzzleDbAtom, selectedDb);
    store.set(trackPuzzleTimeAtom, trackTime);
  }
  if (!legacy && !initial && sessionStorage.getItem("puzzles-test-puzzles")) {
    initial = defaultTree();
    initial.puzzleSession = testSession(
      JSON.parse(sessionStorage.getItem("puzzles-test-puzzles")!),
      0,
    );
  }
  if (initial) tabStorage.seed("puzzles-test", initial);
  await act(async () => {
    root.render(
      <MantineProvider>
        <Provider store={store}>
          <WorkspaceTabScope tabId="puzzles-test">
            <TreeStateProvider id="puzzles-test" initial={initial}>
              <CaptureTreeStore />
              <Puzzles id="puzzles-test" />
            </TreeStateProvider>
          </WorkspaceTabScope>
        </Provider>
      </MantineProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    const settings = document.querySelector<HTMLButtonElement>('[aria-label="SideBar.Settings"]');
    settings?.click();
  });
  return store;
}

async function openAndConfirmDeletion() {
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Puzzle.DeleteDatabase"]')?.click();
  });
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[data-testid="confirm-delete"]')?.click();
    await Promise.resolve();
  });
}

test("durable consumers restore selected B after A with duplicate row IDs, played progress and annotated variations", async () => {
  await renderPuzzles();
  mocks.getPuzzle.mockResolvedValueOnce({ ...puzzleB(), moves: "g1f3 d7d5" });
  await newPuzzle();
  mocks.getPuzzle.mockResolvedValueOnce({ ...puzzleRow(), moves: "e2e4 e7e5 g1f3 b8c6" });
  await newPuzzle();
  await humanMove("c7", "c5");
  await humanMove("e7", "e5");
  await act(async () => {
    treeStore.getState().setComment("selected B progress");
    treeStore.getState().setShapes([{ orig: "b8", dest: "c6", brush: "green" }]);
  });
  tabStorage.flush();
  const saved = deserializeStorageValue<{ state: TreeState }>(
    sessionStorage.getItem("puzzles-test")!,
  )!.state;
  expect(saved.puzzleSession!.attempts.map(({ puzzle }) => puzzle.id)).toEqual([10, 10]);
  expect(new Set(saved.puzzleSession!.attempts.map(({ attemptId }) => attemptId)).size).toBe(2);
  expect(saved.root.children[0].children.map((node) => node.san)).toEqual(["e5", "c5"]);
  await act(async () => root.unmount());
  closeTreeStore("puzzles-test");
  root = createRoot(host);
  await renderPuzzles();
  expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(1);
  expect(treeStore.getState().root).toEqual(saved.root);
  expect(treeStore.getState().position).toEqual([0, 0, 0]);
  expect(mocks.board?.fen).toBe(saved.root.children[0].children[0].children[0].fen);
  expect(mocks.board?.movable?.color).toBe("black");
  expect(sessionStorage.getItem("puzzles-test-puzzles")).toBeNull();
});

test.each(["unique", "ambiguous", "missing", "incompatible"] as const)(
  "real persisted restoration preserves the played tree with %s ownership",
  async (ownership) => {
    const memory = (await import("@/state/store/tree")).createTreeStore();
    memory.getState().makeMove({ payload: "e4" });
    memory.getState().setComment("never reset this tree");
    const saved = { ...memory.getState() };
    if (ownership === "incompatible")
      saved.puzzleSession = testSession([
        puzzleRow({ fen: blackPuzzleFen, moves: ["e7e5", "g1f3"] }),
      ]);
    tabStorage.seed("puzzles-test", saved);
    if (ownership === "unique" || ownership === "ambiguous")
      sessionStorage.setItem(
        "puzzles-test-puzzles",
        JSON.stringify(
          ownership === "unique"
            ? [null, puzzleB(), puzzleRow(), { id: "bad" }]
            : [puzzleRow(), puzzleRow()],
        ),
      );
    await renderPuzzles({ legacy: true });
    expect(treeStore.getState().root).toEqual(saved.root);
    expect(treeStore.getState().position).toEqual([0]);
    expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(
      ownership === "unique" ? 1 : -1,
    );
    expect(mocks.board?.movable?.color).toBe(ownership === "unique" ? "black" : undefined);
    if (ownership === "ambiguous") {
      await selectIncomplete(1);
    }
    expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(
      ownership === "ambiguous" || ownership === "unique" ? 1 : -1,
    );
    expect(treeStore.getState().currentNode().comment).toBe(
      ownership === "ambiguous" ? "" : "never reset this tree",
    );
    expect(sessionStorage.getItem("puzzles-test-puzzles")).toBeNull();
  },
);

function refusePuzzleTreeWrites() {
  const original = Storage.prototype.setItem;
  return vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key, value) {
      if (key === "puzzles-test") throw new DOMException("puzzle quota", "QuotaExceededError");
      original.call(this, key, value);
    });
}

function retentionBoundarySession(cachedSuccessor: boolean): PuzzleSession {
  // Deterministic, schema-valid metadata fills the real compressed budget.
  let seed = 123456789;
  const noise = Array.from({ length: 32_768 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return String.fromCharCode(33 + ((seed >>> 16) % 94));
  }).join("");
  const candidate = (length: number, completed = false) => {
    const rows = [
      puzzleRow({ id: 11, themes: noise.slice(0, length).match(/.{1,256}/g) ?? [] }),
      ...(cachedSuccessor ? [puzzleB()] : []),
      puzzleRow({
        id: 22,
        ...(completed ? { completion: "correct", timeSpent: 1000 } : {}),
      }),
    ];
    return testSession(rows, rows.length - 1);
  };
  let low = 0;
  let high = noise.length;
  expect(puzzleSessionBytes(candidate(high))).toBeGreaterThan(MAX_PUZZLE_SESSION_BYTES);
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (puzzleSessionBytes(candidate(middle)) <= MAX_PUZZLE_SESSION_BYTES) low = middle;
    else high = middle;
  }
  for (let length = low; length >= low - 64; length--) {
    const session = candidate(length);
    if (
      puzzleSessionBytes(session) <= MAX_PUZZLE_SESSION_BYTES &&
      puzzleSessionBytes(candidate(length, true)) > MAX_PUZZLE_SESSION_BYTES
    )
      return session;
  }
  throw new Error("Could not stage the completion retention boundary");
}

async function completePuzzleWithRetention(cachedSuccessor: boolean) {
  const session = retentionBoundarySession(cachedSuccessor);
  const selectedIndex = selectedPuzzleIndex(session);
  const selected = session.selectedAttemptId;
  const evicted = session.attempts[0];
  const cached = cachedSuccessor ? session.attempts[selectedIndex - 1] : null;
  const atoms = await renderPriorPuzzle(
    session.attempts.map(({ puzzle }) => puzzle),
    selectedIndex,
    ["e4"],
  );
  expect(treeStore.getState().puzzleSession!.attempts).toHaveLength(cachedSuccessor ? 3 : 2);
  expect(puzzleSessionBytes(treeStore.getState().puzzleSession!)).toBeLessThanOrEqual(
    MAX_PUZZLE_SESSION_BYTES,
  );
  expect(treeStore.getState().puzzleSession!.selectedAttemptId).toBe(selected);
  const boardElement = document.querySelector('[data-testid="actual-puzzle-board"]');
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(10_000);
  await act(async () => {
    atoms.set(jumpToNextPuzzleAtom, true);
    atoms.set(trackPuzzleTimeAtom, true);
    atoms.set(puzzleTimerFamily("puzzles-test"), ownedTimer(9000));
  });
  const themes = deferred<string[]>();
  const successor = deferred<NativePuzzle>();
  mocks.getThemesForPuzzle.mockReturnValueOnce(themes.promise);
  mocks.getPuzzle.mockReturnValueOnce(successor.promise);
  await humanMove("e7", "e5");
  const completed = treeStore.getState();
  expect(completed.puzzleSession!.attempts.map(({ attemptId }) => attemptId)).toEqual(
    session.attempts
      .filter(({ attemptId }) => attemptId !== evicted.attemptId)
      .map(({ attemptId }) => attemptId),
  );
  expect(completed.puzzleSession!.selectedAttemptId).toBe(selected);
  expect(selectedPuzzleIndex(completed.puzzleSession)).toBe(selectedIndex - 1);
  expect(completed.currentNode().san).toBe("e5");
  expect(completed.position).toEqual([0, 0]);
  expect(
    completed.puzzleSession!.attempts.find(({ attemptId }) => attemptId === selected)?.puzzle,
  ).toMatchObject({
    id: 22,
    completion: "correct",
    timeSpent: 1000,
  });
  expect(document.querySelector('[data-testid="actual-puzzle-board"]')).toBe(boardElement);
  expect(mocks.getThemesForPuzzle).toHaveBeenCalledOnce();
  const themeSignal = mocks.getThemesForPuzzle.mock.calls[0][2].signal as AbortSignal;
  expect(themeSignal.aborted).toBe(false);
  expect(mocks.getPuzzle).not.toHaveBeenCalled();
  expect(atoms.get(puzzleTimerFamily("puzzles-test"))).toBeNull();
  vi.setSystemTime(15_000);
  await act(async () => themes.resolve(["fork"]));
  const history = treeStore.getState().puzzleSession!;
  expect(history.attempts.find(({ attemptId }) => attemptId === selected)?.puzzle).toMatchObject({
    id: 22,
    completion: "correct",
    timeSpent: 1000,
    themes: ["fork"],
  });
  return { history, completed, selected, cached, evicted, successor };
}

function expectRetainedPuzzleSession(evicted: PuzzleSession["attempts"][number]) {
  const finalSession = treeStore.getState().puzzleSession!;
  expect(
    finalSession.attempts.some(
      ({ attemptId, puzzle }) => attemptId === evicted.attemptId || puzzle.id === evicted.puzzle.id,
    ),
  ).toBe(false);
  expect(finalSession.attempts).toHaveLength(2);
  expect(finalSession.attempts.length).toBeLessThanOrEqual(MAX_PUZZLE_ATTEMPTS);
  expect(puzzleSessionBytes(finalSession)).toBeLessThanOrEqual(MAX_PUZZLE_SESSION_BYTES);
  expect(storedPuzzles()).toEqual(finalSession.attempts.map(({ puzzle }) => puzzle));
  expect(mocks.notificationShow).not.toHaveBeenCalled();
}

test("completion retention keeps B's board and fetches a native successor after A eviction", async () => {
  const { history, completed, selected, evicted, successor } =
    await completePuzzleWithRetention(false);
  expect(mocks.getPuzzle).toHaveBeenCalledOnce();
  expect(history.selectedAttemptId).toBe(selected);
  expect(treeStore.getState().root).toEqual(completed.root);
  expect(treeStore.getState().position).toEqual(completed.position);
  await act(async () => successor.resolve({ ...puzzleB(), moves: "g1f3 d7d5" }));
  expect(treeStore.getState().currentNode().san).toBe("Nf3");
  expect(treeStore.getState().puzzleSession!.selectedAttemptId).not.toBe(selected);
  expectRetainedPuzzleSession(evicted);
});

test("completion retention keeps B's board and selects cached previous C after A eviction", async () => {
  const { history, cached, evicted } = await completePuzzleWithRetention(true);
  expect(mocks.getPuzzle).not.toHaveBeenCalled();
  expect(history.selectedAttemptId).toBe(cached!.attemptId);
  expect(selectedPuzzleIndex(history)).toBe(0);
  expect(treeStore.getState().currentNode().san).toBe("Nf3");
  expectRetainedPuzzleSession(evicted);
});

test("real storage admission refusal preserves selection and queued progress then retries without stale overwrite", async () => {
  const atoms = await renderPriorPuzzle([puzzleRow()], 0, ["e4"]);
  await act(async () => treeStore.getState().setComment("pending latest edit"));
  const previous = treeStore.getState();
  const previousTimer = atoms.get(puzzleTimerFamily("puzzles-test"));
  const bytes = sessionStorage.getItem("puzzles-test");
  const refuse = refusePuzzleTreeWrites();
  mocks.getPuzzle.mockResolvedValue({ ...puzzleB(), moves: "g1f3 d7d5" });
  await newPuzzle();
  expect(treeStore.getState()).toBe(previous);
  expect(atoms.get(puzzleTimerFamily("puzzles-test"))).toBe(previousTimer);
  expect(sessionStorage.getItem("puzzles-test")).toBe(bytes);
  expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(0);
  refuse.mockRestore();
  await newPuzzle();
  expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(1);
  tabStorage.flush();
  const saved = deserializeStorageValue<{ state: TreeState }>(
    sessionStorage.getItem("puzzles-test")!,
  )!.state;
  expect(saved.puzzleSession!.attempts).toHaveLength(2);
  expect(saved.root.children[0].san).toBe("Nf3");
  expect(saved.root.children[0].comment).toBe("");
});

test("real completion refusal retains accepted move and reply without successor admission", async () => {
  const atoms = await renderPriorPuzzle([puzzleRow()], 0, ["e4"]);
  await act(async () => atoms.set(jumpToNextPuzzleAtom, true));
  const refuse = refusePuzzleTreeWrites();
  await humanMove("e7", "e5");
  expect(treeStore.getState().currentNode().san).toBe("e5");
  expect(treeStore.getState().puzzleSession!.attempts[0].puzzle.completion).toBe("incomplete");
  expect(mocks.getThemesForPuzzle).not.toHaveBeenCalled();
  expect(mocks.getPuzzle).not.toHaveBeenCalled();
  refuse.mockRestore();
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Board.Practice.Retry")!
      .click(),
  );
  expect(treeStore.getState().puzzleSession!.attempts[0].puzzle.completion).toBe("correct");
  expect(mocks.getThemesForPuzzle).toHaveBeenCalledOnce();
  expect(mocks.getPuzzle).toHaveBeenCalledOnce();
});

test("refused theme metadata can retry its own immutable owner before admitting a successor", async () => {
  const atoms = await renderPriorPuzzle([puzzleRow()], 0, ["e4"]);
  await act(async () => atoms.set(jumpToNextPuzzleAtom, true));
  const themes = deferred<string[]>();
  mocks.getThemesForPuzzle.mockReturnValueOnce(themes.promise);
  await humanMove("e7", "e5");
  const refuse = refusePuzzleTreeWrites();
  await act(async () => themes.resolve(["fork"]));
  expect(storedPuzzles()[0].completion).toBe("correct");
  expect(storedPuzzles()[0].themes).toBeUndefined();
  expect(mocks.getPuzzle).not.toHaveBeenCalled();
  refuse.mockRestore();
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Board.Practice.Retry")!
      .click(),
  );
  expect(storedPuzzles()[0].themes).toEqual(["fork"]);
  expect(mocks.getThemesForPuzzle).toHaveBeenCalledOnce();
  expect(mocks.getPuzzle).toHaveBeenCalledOnce();
  expect(selectedPuzzleIndex(treeStore.getState().puzzleSession)).toBe(1);
});

test.each(["hint", "playback"] as const)(
  "a refused %s completion keeps the first incorrect time stable through retry",
  async (action) => {
    const atoms = await renderPriorPuzzle(
      [puzzleRow({ moves: ["e2e4", "e7e5", "g1f3", "b8c6"] })],
      0,
      ["e4"],
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(10_000);
    await act(async () => {
      atoms.set(trackPuzzleTimeAtom, true);
      atoms.set(puzzleTimerFamily("puzzles-test"), ownedTimer(9000));
    });
    await act(async () => treeStore.getState().setStart([]));
    const beforeAttempt = treeStore.getState();
    const refuse = refusePuzzleTreeWrites();
    await act(async () => (action === "hint" ? hintButton() : solutionButton()).click());
    expect(treeStore.getState()).toBe(beforeAttempt);
    expect(storedPuzzles()[0].completion).toBe("incomplete");
    expect(mocks.board?.movable?.dests?.get("e7")).toContain("e5");
    const refusedBytes = sessionStorage.getItem("puzzles-test");
    vi.setSystemTime(10_500);
    await humanMove("e7", "e5");
    expect(treeStore.getState()).toBe(beforeAttempt);
    expect(treeStore.getState().root).toBe(beforeAttempt.root);
    expect(treeStore.getState().position).toEqual([0]);
    expect(mocks.board?.movable?.color).toBeUndefined();
    expect(sessionStorage.getItem("puzzles-test")).toBe(refusedBytes);
    expect(storedPuzzles()[0].timeSpent).toBeUndefined();
    refuse.mockRestore();
    vi.setSystemTime(11_000);
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Board.Practice.Retry")!
        .click(),
    );
    expect(storedPuzzles()[0].completion).toBe("incorrect");
    expect(storedPuzzles()[0].timeSpent).toBe(1000);
  },
);

test("legacy migration read and save refusals preserve sources until existing retry succeeds", async () => {
  const raw = JSON.stringify([puzzleRow()]);
  sessionStorage.setItem("puzzles-test-puzzles", raw);
  const read = Storage.prototype.getItem;
  const deniedRead = vi
    .spyOn(Storage.prototype, "getItem")
    .mockImplementation(function (this: Storage, key) {
      if (key === "puzzles-test-puzzles") throw new Error("history unavailable");
      return read.call(this, key);
    });
  await renderPuzzles({ legacy: true });
  expect(document.querySelector('[data-testid="actual-puzzle-board"]')).toBeNull();
  deniedRead.mockRestore();
  const deniedWrite = refusePuzzleTreeWrites();
  const retry = () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "TreeRecovery.Retry",
    )!;
  await act(async () => retry().click());
  expect(sessionStorage.getItem("puzzles-test-puzzles")).toBe(raw);
  expect(document.querySelector('[data-testid="actual-puzzle-board"]')).toBeNull();
  deniedWrite.mockRestore();
  await act(async () => retry().click());
  expect(storedPuzzles()).toEqual([puzzleRow()]);
  expect(document.querySelector('[data-testid="actual-puzzle-board"]')).not.toBeNull();
  expect(sessionStorage.getItem("puzzles-test-puzzles")).toBeNull();
});

test("timer close cleanup cannot recreate a retired physical tree", async () => {
  const atoms = await renderPriorPuzzle([puzzleRow()], 0, ["e4"]);
  await act(async () => {
    atoms.set(trackPuzzleTimeAtom, true);
    atoms.set(puzzleTimerFamily("puzzles-test"), ownedTimer(Date.now() - 1000));
  });
  closeTreeStore("puzzles-test");
  tabStorage.remove("puzzles-test");
  const newerTimer = ownedTimer(Date.now(), "replacement-owner");
  await act(async () => atoms.set(puzzleTimerFamily("puzzles-test"), newerTimer));
  await act(async () => root.unmount());
  tabStorage.flush();
  expect(sessionStorage.getItem("puzzles-test")).toBeNull();
  expect(sessionStorage.getItem("puzzles-test-puzzles")).toBeNull();
  expect(atoms.get(puzzleTimerFamily("puzzles-test"))).toBe(newerTimer);
});

test("UI refused tracking stop excludes the paused interval after resume", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(9000);
  const initial = defaultTree();
  initial.puzzleSession = testSession([puzzleRow()], -1);
  await renderPuzzles({ initial, trackTime: true });
  await selectIncomplete(0);
  const selected = treeStore.getState().puzzleSession!.selectedAttemptId;
  const selectedTree = treeStore.getState().root;
  vi.setSystemTime(10_000);
  const previous = treeStore.getState();
  const bytes = sessionStorage.getItem("puzzles-test");
  const refuse = refusePuzzleTreeWrites();
  await act(async () => trackingSwitch().click());
  expect(trackingSwitch().checked).toBe(false);
  expect(treeStore.getState()).toBe(previous);
  expect(sessionStorage.getItem("puzzles-test")).toBe(bytes);
  refuse.mockRestore();
  vi.setSystemTime(20_000);
  await act(async () => trackingSwitch().click());
  vi.setSystemTime(21_000);
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(storedPuzzles()[0].timeSpent).toBe(2000);
  expect(treeStore.getState().puzzleSession!.selectedAttemptId).toBe(selected);
  expect(treeStore.getState().root).toEqual(selectedTree);
  expect(treeStore.getState().position).toEqual([0]);
});

test.each(["paused", "resumed while refused"] as const)(
  "UI refused tracking stop recovers while %s without charging disabled time",
  async (recovery) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(9000);
    const initial = defaultTree();
    initial.puzzleSession = testSession([puzzleRow()], -1);
    await renderPuzzles({ initial, trackTime: true });
    await selectIncomplete(0);
    const selectedTree = treeStore.getState().root;
    vi.setSystemTime(10_000);
    const refuse = refusePuzzleTreeWrites();
    await act(async () => trackingSwitch().click());
    const previous = treeStore.getState();
    const bytes = sessionStorage.getItem("puzzles-test");
    vi.setSystemTime(20_000);
    if (recovery === "resumed while refused") {
      await act(async () => trackingSwitch().click());
    }
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(trackingSwitch().checked).toBe(recovery === "resumed while refused");
    expect(treeStore.getState()).toBe(previous);
    expect(sessionStorage.getItem("puzzles-test")).toBe(bytes);
    refuse.mockRestore();
    vi.setSystemTime(21_000);
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(storedPuzzles()[0].timeSpent).toBe(recovery === "paused" ? 1000 : 2000);
    expect(treeStore.getState().puzzleSession!.selectedAttemptId).toBe("test-0");
    expect(treeStore.getState().root).toEqual(selectedTree);
    expect(treeStore.getState().position).toEqual([0]);
  },
);

test("paused admission saves the previous owner's held elapsed before selection", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(9000);
  const initial = defaultTree();
  initial.puzzleSession = testSession([puzzleRow(), puzzleB()], -1);
  await renderPuzzles({ initial, trackTime: true });
  await selectIncomplete(0);
  vi.setSystemTime(10_000);
  const refuse = refusePuzzleTreeWrites();
  await act(async () => trackingSwitch().click());
  const previous = treeStore.getState();
  const bytes = sessionStorage.getItem("puzzles-test");
  vi.setSystemTime(20_000);
  await selectIncomplete(1);
  expect(treeStore.getState()).toBe(previous);
  expect(sessionStorage.getItem("puzzles-test")).toBe(bytes);
  refuse.mockRestore();
  await selectIncomplete(1);
  expect(trackingSwitch().checked).toBe(false);
  expect(storedPuzzles().map(({ timeSpent }) => timeSpent)).toEqual([1000, undefined]);
  expect(treeStore.getState().puzzleSession!.selectedAttemptId).toBe("test-1");
  expect(treeStore.getState().currentNode().san).toBe("Nf3");
});

test("paused first completion retains held time through refusal and retry", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(9000);
  const initial = defaultTree();
  initial.puzzleSession = testSession([puzzleRow({ moves: ["e2e4", "e7e5", "g1f3", "b8c6"] })], -1);
  const atoms = await renderPuzzles({ initial, trackTime: true });
  await act(async () => atoms.set(jumpToNextPuzzleAtom, false));
  await selectIncomplete(0);
  vi.setSystemTime(10_000);
  const refuse = refusePuzzleTreeWrites();
  await act(async () => trackingSwitch().click());
  const previous = treeStore.getState();
  const bytes = sessionStorage.getItem("puzzles-test");
  vi.setSystemTime(20_000);
  await act(async () => hintButton().click());
  expect(treeStore.getState()).toBe(previous);
  expect(sessionStorage.getItem("puzzles-test")).toBe(bytes);
  refuse.mockRestore();
  vi.setSystemTime(30_000);
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Board.Practice.Retry")!
      .click(),
  );
  expect(storedPuzzles()[0]).toMatchObject({ completion: "incorrect", timeSpent: 1000 });
  expect(treeStore.getState().puzzleSession!.selectedAttemptId).toBe("test-0");
  expect(treeStore.getState().root).toEqual(previous.root);
  expect(treeStore.getState().position).toEqual(previous.position);
});

function OtherTrackingView() {
  const [tracking, setTracking] = useAtom(trackPuzzleTimeAtom);
  return (
    <input
      aria-label="Other view tracking"
      type="checkbox"
      checked={tracking}
      onChange={(event) => setTracking(event.currentTarget.checked)}
    />
  );
}

test.each(["enabled", "disabled in another view"] as const)(
  "actual refused unmount retains elapsed across a cached remount with tracking %s",
  async (preference) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(9000);
    const initial = defaultTree();
    initial.puzzleSession = testSession([puzzleRow()], -1);
    const atoms = await renderPuzzles({ initial, trackTime: true });
    await selectIncomplete(0);
    const cachedTree = treeStore;
    const previous = treeStore.getState();
    const bytes = sessionStorage.getItem("puzzles-test");
    vi.setSystemTime(10_000);
    const refuse = refusePuzzleTreeWrites();
    await act(async () =>
      root.render(
        <Provider store={atoms}>
          <OtherTrackingView />
        </Provider>,
      ),
    );
    expect(document.querySelector('[data-testid="actual-puzzle-board"]')).toBeNull();
    expect(cachedTree.getState()).toBe(previous);
    expect(sessionStorage.getItem("puzzles-test")).toBe(bytes);
    vi.setSystemTime(15_000);
    if (preference === "disabled in another view") {
      await act(async () =>
        document.querySelector<HTMLInputElement>('[aria-label="Other view tracking"]')!.click(),
      );
    }
    expect(
      document.querySelector<HTMLInputElement>('[aria-label="Other view tracking"]')!.checked,
    ).toBe(preference === "enabled");
    refuse.mockRestore();
    vi.setSystemTime(20_000);
    expect(await renderPuzzles({ atoms })).toBe(atoms);
    expect(treeStore).toBe(cachedTree);
    expect(treeStore.getState().puzzleSession!.selectedAttemptId).toBe("test-0");
    expect(treeStore.getState().root).toEqual(previous.root);
    expect(treeStore.getState().position).toEqual(previous.position);
    expect(trackingSwitch().checked).toBe(preference === "enabled");
    expect(storedPuzzles()[0].timeSpent).toBe(preference === "enabled" ? undefined : 1000);
    if (preference === "disabled in another view") {
      await act(async () => trackingSwitch().click());
    }
    vi.setSystemTime(21_000);
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(storedPuzzles()[0].timeSpent).toBe(2000);
    expect(treeStore.getState().root).toEqual(previous.root);
    expect(treeStore.getState().position).toEqual(previous.position);
  },
);

test("cold reopen after a refused unmount restores only durable elapsed", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(9000);
  const initial = defaultTree();
  initial.puzzleSession = testSession([puzzleRow({ timeSpent: 500 })], -1);
  await renderPuzzles({ initial, trackTime: true });
  await selectIncomplete(0);
  const selectedTree = treeStore.getState().root;
  const bytes = sessionStorage.getItem("puzzles-test");
  vi.setSystemTime(10_000);
  const refuse = refusePuzzleTreeWrites();
  await act(async () => root.unmount());
  expect(sessionStorage.getItem("puzzles-test")).toBe(bytes);
  expect(storedPuzzles()[0].timeSpent).toBe(500);
  refuse.mockRestore();
  closeTreeStore("puzzles-test");
  root = createRoot(host);
  vi.setSystemTime(100_000);
  await renderPuzzles({ trackTime: true });
  expect(treeStore.getState().puzzleSession!.selectedAttemptId).toBe("test-0");
  expect(treeStore.getState().root).toEqual(selectedTree);
  expect(storedPuzzles()[0].timeSpent).toBe(500);
  vi.setSystemTime(100_500);
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(storedPuzzles()[0].timeSpent).toBe(1000);
});

test("cold mount honors persisted tracking off before publishing a resumed timer", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(9000);
  localStorage.setItem("track-puzzle-time", "false");
  const atoms = createStore();
  const memory = (await import("@/state/store/tree")).createTreeStore();
  expect(memory.getState().makeMoves({ payload: ["e4"], changeHeaders: false }).success).toBe(true);
  const initial = {
    ...memory.getState(),
    puzzleSession: testSession([puzzleRow({ timeSpent: 500 })]),
  };
  await renderPuzzles({ initial, atoms });
  expect(trackingSwitch().checked).toBe(false);
  expect(storedPuzzles()[0].timeSpent).toBe(500);
  expect(treeStore.getState().puzzleSession!.selectedAttemptId).toBe("test-0");
  expect(treeStore.getState().root).toEqual(initial.root);
  expect(treeStore.getState().position).toEqual([0]);
  const bytes = sessionStorage.getItem("puzzles-test");
  vi.setSystemTime(20_000);
  expect(trackingSwitch().checked).toBe(false);
  expect(storedPuzzles()[0].timeSpent).toBe(500);
  expect(sessionStorage.getItem("puzzles-test")).toBe(bytes);
  await act(async () => trackingSwitch().click());
  expect(trackingSwitch().checked).toBe(true);
  vi.setSystemTime(21_000);
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(storedPuzzles()[0].timeSpent).toBe(1500);
  expect(treeStore.getState().puzzleSession!.selectedAttemptId).toBe("test-0");
  expect(treeStore.getState().root).toEqual(initial.root);
  expect(treeStore.getState().position).toEqual([0]);
});

test("UI history selection starts elapsed timing only when tracking is enabled", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(10_000);
  const initial = defaultTree();
  initial.puzzleSession = testSession([puzzleRow(), { ...puzzleB(), timeSpent: 1000 }], -1);
  await renderPuzzles({ initial });
  expect(trackingSwitch().checked).toBe(false);
  await selectIncomplete(1);
  const selected = treeStore.getState().puzzleSession!.selectedAttemptId;
  const selectedTree = treeStore.getState().root;
  expect(selected).toBe("test-1");
  expect(treeStore.getState().currentNode().san).toBe("Nf3");
  expect(storedPuzzles()[1].timeSpent).toBe(1000);
  vi.setSystemTime(20_000);
  await act(async () => trackingSwitch().click());
  expect(trackingSwitch().checked).toBe(true);
  vi.setSystemTime(21_000);
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(storedPuzzles()[1].timeSpent).toBe(2000);
  expect(treeStore.getState().puzzleSession!.selectedAttemptId).toBe(selected);
  expect(treeStore.getState().root).toEqual(selectedTree);
  expect(treeStore.getState().position).toEqual([0]);
});

test("untracked B-to-A-to-B history revisits discard a retained running start", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(10_000);
  const initial = defaultTree();
  initial.puzzleSession = testSession([puzzleRow(), { ...puzzleB(), timeSpent: 1000 }], -1);
  const atoms = await renderPuzzles({ initial });
  await selectIncomplete(1);
  // A retained transient value must not resume when its owner is revisited untracked.
  await act(async () => atoms.set(puzzleTimerFamily("puzzles-test"), ownedTimer(9000)));
  vi.setSystemTime(12_000);
  await selectIncomplete(0);
  expect(atoms.get(puzzleTimerFamily("puzzles-test"))).toBeNull();
  vi.setSystemTime(15_000);
  await selectIncomplete(1);
  const selected = treeStore.getState().puzzleSession!.selectedAttemptId;
  const selectedTree = treeStore.getState().root;
  expect(selected).toBe("test-1");
  expect(atoms.get(puzzleTimerFamily("puzzles-test"))).toBeNull();
  expect(trackingSwitch().checked).toBe(false);
  expect(storedPuzzles().map(({ timeSpent }) => timeSpent)).toEqual([undefined, 1000]);
  vi.setSystemTime(20_000);
  await act(async () => trackingSwitch().click());
  vi.setSystemTime(21_000);
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(storedPuzzles().map(({ timeSpent }) => timeSpent)).toEqual([undefined, 2000]);
  expect(treeStore.getState().puzzleSession!.selectedAttemptId).toBe(selected);
  expect(treeStore.getState().root).toEqual(selectedTree);
  expect(treeStore.getState().position).toEqual([0]);
});

test("deferred native admission uses tracking disabled before its response", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(10_000);
  const query = deferred<NativePuzzle>();
  mocks.getPuzzle.mockReturnValueOnce(query.promise);
  await renderPuzzles({ trackTime: true });
  await newPuzzle();
  expect(mocks.getPuzzle).toHaveBeenCalledOnce();
  vi.setSystemTime(12_000);
  await act(async () => trackingSwitch().click());
  expect(trackingSwitch().checked).toBe(false);
  vi.setSystemTime(15_000);
  await act(async () => query.resolve({ ...puzzleB(), moves: "g1f3 d7d5" }));
  const selected = treeStore.getState().puzzleSession!.selectedAttemptId;
  const selectedTree = treeStore.getState().root;
  expect(selected).not.toBeNull();
  expect(storedPuzzles()).toHaveLength(1);
  expect(treeStore.getState().currentNode().san).toBe("Nf3");
  expect(storedPuzzles()[0].timeSpent).toBeUndefined();
  vi.setSystemTime(20_000);
  await act(async () => trackingSwitch().click());
  vi.setSystemTime(21_000);
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(storedPuzzles()[0].timeSpent).toBe(1000);
  expect(treeStore.getState().puzzleSession!.selectedAttemptId).toBe(selected);
  expect(treeStore.getState().root).toEqual(selectedTree);
  expect(treeStore.getState().position).toEqual([0]);
});

test("cached successor admission uses tracking disabled during completion metadata", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(10_000);
  const initial = defaultTree();
  initial.puzzleSession = testSession([puzzleRow(), { ...puzzleB(), timeSpent: 1000 }], -1);
  const atoms = await renderPuzzles({ initial, trackTime: true });
  await act(async () => atoms.set(jumpToNextPuzzleAtom, true));
  await selectIncomplete(0);
  const themes = deferred<string[]>();
  mocks.getThemesForPuzzle.mockReturnValueOnce(themes.promise);
  vi.setSystemTime(11_000);
  await humanMove("e7", "e5");
  expect(storedPuzzles()[0]).toMatchObject({ completion: "correct", timeSpent: 1000 });
  vi.setSystemTime(12_000);
  await act(async () => trackingSwitch().click());
  expect(trackingSwitch().checked).toBe(false);
  vi.setSystemTime(15_000);
  await act(async () => themes.resolve(["fork"]));
  const selected = treeStore.getState().puzzleSession!.selectedAttemptId;
  const selectedTree = treeStore.getState().root;
  expect(selected).toBe("test-1");
  expect(treeStore.getState().currentNode().san).toBe("Nf3");
  expect(mocks.getPuzzle).not.toHaveBeenCalled();
  expect(storedPuzzles()[0]).toMatchObject({
    completion: "correct",
    timeSpent: 1000,
    themes: ["fork"],
  });
  expect(storedPuzzles()[1].timeSpent).toBe(1000);
  vi.setSystemTime(20_000);
  await act(async () => trackingSwitch().click());
  vi.setSystemTime(21_000);
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(storedPuzzles()[1].timeSpent).toBe(2000);
  expect(treeStore.getState().puzzleSession!.selectedAttemptId).toBe(selected);
  expect(treeStore.getState().root).toEqual(selectedTree);
  expect(treeStore.getState().position).toEqual([0]);
});

test("UI history selection preserves elapsed across equal timer starts and a cold reopen", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(9000);
  const initial = defaultTree();
  initial.puzzleSession = testSession([puzzleRow(), { ...puzzleB(), timeSpent: 1000 }], -1);
  await renderPuzzles({ initial, trackTime: true });
  expect(treeStore.getState().puzzleSession!.selectedAttemptId).toBeNull();
  await selectIncomplete(0);
  expect(treeStore.getState().currentNode().san).toBe("e4");
  vi.setSystemTime(10_000);
  await selectIncomplete(1);
  const selected = treeStore.getState().puzzleSession!.selectedAttemptId;
  const selectedTree = treeStore.getState().root;
  expect(selected).toBe("test-1");
  expect(treeStore.getState().currentNode().san).toBe("Nf3");
  expect(storedPuzzles().map(({ timeSpent }) => timeSpent)).toEqual([1000, 1000]);
  vi.setSystemTime(11_000);
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(storedPuzzles()[0].timeSpent).toBe(1000);
  expect(storedPuzzles()[1].timeSpent).toBe(2000);
  expect(treeStore.getState().puzzleSession!.selectedAttemptId).toBe(selected);
  expect(treeStore.getState().root).toEqual(selectedTree);
  expect(treeStore.getState().position).toEqual([0]);
  await act(async () => root.unmount());
  closeTreeStore("puzzles-test");
  root = createRoot(host);
  vi.setSystemTime(110_000);
  await renderPuzzles({ trackTime: true });
  expect(treeStore.getState().puzzleSession!.selectedAttemptId).toBe(selected);
  expect(treeStore.getState().root).toEqual(selectedTree);
  expect(treeStore.getState().position).toEqual([0]);
  expect(storedPuzzles().map(({ timeSpent }) => timeSpent)).toEqual([1000, 2000]);
  vi.setSystemTime(110_500);
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(storedPuzzles().map(({ timeSpent }) => timeSpent)).toEqual([1000, 2500]);
});

test.each([
  { outcome: "subscriber throw", startedAt: 9000, elapsed: 2000 },
  { outcome: "subscriber retarget and throw", startedAt: 5000, elapsed: 6000 },
])(
  "admission retains the selected timer owner after $outcome",
  async ({ outcome, startedAt, elapsed }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(9000);
    const initial = defaultTree();
    initial.puzzleSession = testSession([puzzleRow(), { ...puzzleB(), timeSpent: 1000 }], -1);
    const atoms = await renderPuzzles({ initial, trackTime: true });
    await selectIncomplete(0);
    const previousTimer = atoms.get(puzzleTimerFamily("puzzles-test"));
    let observedTimer: typeof previousTimer = null;
    let notified = false;
    let physical = "puzzles-test";
    const newerTimer = ownedTimer(startedAt, "test-1");
    const unsubscribe = treeStore.subscribe((state) => {
      if (notified || state.puzzleSession?.selectedAttemptId !== "test-1") return;
      notified = true;
      observedTimer = atoms.get(puzzleTimerFamily("puzzles-test"));
      if (outcome === "subscriber retarget and throw") {
        physical = crypto.randomUUID();
        const replacement = {
          ...defaultTree(),
          root: state.root,
          position: state.position,
          puzzleSession: state.puzzleSession,
        };
        tabStorage.seed(physical, replacement);
        retargetTreeStore("puzzles-test", physical, replacement);
        atoms.set(puzzleTimerFamily("puzzles-test"), newerTimer);
      }
      throw new Error("admission subscriber failed");
    });
    vi.setSystemTime(10_000);
    try {
      await selectIncomplete(1);
    } finally {
      unsubscribe();
    }
    expect(notified).toBe(true);
    expect(observedTimer).toBe(previousTimer);
    expect(observedTimer).toEqual(ownedTimer(9000, "test-0"));
    expect(treeStore.getState().puzzleSession!.selectedAttemptId).toBe("test-1");
    expect(treeStore.getState().currentNode().san).toBe("Nf3");
    expect(atoms.get(puzzleTimerFamily("puzzles-test"))).toEqual(newerTimer);
    expect(mocks.notificationShow).toHaveBeenCalledExactlyOnceWith({
      color: "danger",
      title: "Common.Error",
      message: "admission subscriber failed",
    });
    vi.setSystemTime(11_000);
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(
      treeStore.getState().puzzleSession!.attempts.map(({ puzzle }) => puzzle.timeSpent),
    ).toEqual([1000, elapsed]);
    expect(
      tabStorage
        .read<TreeState>(physical)!
        .state.puzzleSession!.attempts.map(({ puzzle }) => puzzle.timeSpent),
    ).toEqual([1000, elapsed]);
  },
);

test("elapsed cleanup cannot clear a newer timer installed by its save subscriber", async () => {
  const atoms = await renderPriorPuzzle([puzzleRow()], 0, ["e4"]);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(10_000);
  await act(async () => {
    atoms.set(trackPuzzleTimeAtom, true);
    atoms.set(puzzleTimerFamily("puzzles-test"), ownedTimer(9000));
  });
  const newerTimer = ownedTimer(10_000);
  let replaced = false;
  const unsubscribe = treeStore.subscribe((state) => {
    if (replaced || state.puzzleSession!.attempts[0].puzzle.timeSpent !== 2000) return;
    replaced = true;
    atoms.set(puzzleTimerFamily("puzzles-test"), newerTimer);
  });
  vi.setSystemTime(11_000);
  try {
    await act(async () => window.dispatchEvent(new Event("pagehide")));
  } finally {
    unsubscribe();
  }
  expect(replaced).toBe(true);
  expect(atoms.get(puzzleTimerFamily("puzzles-test"))).toBe(newerTimer);
  expect(storedPuzzles()[0].timeSpent).toBe(2000);
  vi.setSystemTime(15_000);
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(storedPuzzles()[0].timeSpent).toBe(5000);
});

test("incomplete elapsed time resumes after a cold reload without application downtime", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(10_000);
  const atoms = await renderPriorPuzzle([puzzleRow()], 0, ["e4"]);
  await act(async () => {
    atoms.set(trackPuzzleTimeAtom, true);
    atoms.set(puzzleTimerFamily("puzzles-test"), ownedTimer(9000));
  });
  vi.setSystemTime(10_100);
  await act(async () => root.unmount());
  expect(storedPuzzles()[0].timeSpent).toBe(1100);
  closeTreeStore("puzzles-test");
  vi.setSystemTime(110_100);
  root = createRoot(host);
  const reloaded = await renderPuzzles({ trackTime: true });
  expect(reloaded.get(puzzleTimerFamily("puzzles-test"))).toEqual(ownedTimer(109_000));
  await humanMove("c7", "c5");
  expect(storedPuzzles()[0].timeSpent).toBe(1100);
});

test.each(["beforeunload", "pagehide"] as const)(
  "%s saves elapsed duration through a real refusal and retry without requiring React unmount",
  async (event) => {
    const atoms = await renderPriorPuzzle([puzzleRow()], 0, ["e4"]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(10_000);
    await act(async () => {
      atoms.set(trackPuzzleTimeAtom, true);
      atoms.set(puzzleTimerFamily("puzzles-test"), ownedTimer(9000));
    });
    const previous = treeStore.getState();
    const refuse = refusePuzzleTreeWrites();
    await act(async () => window.dispatchEvent(new Event(event)));
    expect(treeStore.getState()).toBe(previous);
    expect(atoms.get(puzzleTimerFamily("puzzles-test"))).toEqual(ownedTimer(9000));
    refuse.mockRestore();
    vi.setSystemTime(10_100);
    await act(async () => window.dispatchEvent(new Event(event)));
    expect(storedPuzzles()[0].timeSpent).toBe(1100);
    expect(document.querySelector('[data-testid="actual-puzzle-board"]')).not.toBeNull();
  },
);

test("legacy inference retains an old selected attempt before bounding more than 100 rows", async () => {
  const memory = (await import("@/state/store/tree")).createTreeStore();
  memory.getState().makeMove({ payload: "e4" });
  tabStorage.seed("puzzles-test", memory.getState());
  sessionStorage.setItem(
    "puzzles-test-puzzles",
    JSON.stringify([puzzleRow(), ...Array.from({ length: 105 }, () => puzzleB())]),
  );
  await renderPuzzles({ legacy: true });
  const session = treeStore.getState().puzzleSession!;
  expect(session.attempts).toHaveLength(100);
  expect(session.selectedAttemptId).toBe(session.attempts[0].attemptId);
  expect(session.attempts[0].puzzle.moves).toEqual(["e2e4", "e7e5"]);
  expect(treeStore.getState().position).toEqual([0]);
});

test("an oversized incoming puzzle reports the German quota message and leaves the current owner and tree intact", async () => {
  const translator = await catalogueI18n("de-DE");
  vi.spyOn(i18n, "t").mockImplementation(translator.t);
  await renderPriorPuzzle([puzzleRow()], 0, ["e4"]);
  const before = treeStore.getState();
  let entropy = 42;
  const themes = Array.from({ length: 128 }, () =>
    Array.from({ length: 256 }, () => {
      entropy = (Math.imul(entropy, 1664525) + 1013904223) >>> 0;
      return String.fromCharCode(32 + ((entropy >>> 16) % 90));
    }).join(""),
  );
  mocks.getPuzzle.mockResolvedValue({ ...puzzleB(), themes, moves: "g1f3 d7d5" });
  // Snapshot the completed setup write, not a value awaiting the storage debounce.
  tabStorage.flush();
  const bytes = sessionStorage.getItem("puzzles-test");
  await newPuzzle();
  expect(treeStore.getState()).toBe(before);
  expect(sessionStorage.getItem("puzzles-test")).toBe(bytes);
  expect(mocks.notificationShow).toHaveBeenCalledExactlyOnceWith({
    color: "danger",
    title: deDECatalogue.translation["Common.Error"],
    message: deDECatalogue.translation["Common.StorageQuotaExceeded"],
  });
  expect(mocks.playSound).not.toHaveBeenCalled();
});

test.each(["workspace", "listing"] as const)(
  "%s refusal clears the puzzle list and preserves unlabelled diagnostics",
  async (surface) => {
    const store = await renderPuzzles();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="puzzle-database-count"]')?.textContent).toBe(
        "1",
      ),
    );
    for (const labelled of [true, false]) {
      const failure = new TauriCommandError({
        tag: "backend-error",
        category: "io",
        message: "native failure",
        ...(labelled ? { rootFailure: "missing" as const } : {}),
      });
      mocks[
        surface === "workspace" ? "getPuzzleWorkspace" : "listPuzzleDatabases"
      ].mockRejectedValue(failure);
      mocks.notificationShow.mockClear();
      await act(async () =>
        store.set(puzzleWorkspaceGenerationAtom, (generation) => generation + 1),
      );
      await vi.waitFor(() =>
        expect(mocks.notificationShow).toHaveBeenCalledWith({
          color: "danger",
          title: "Common.Error",
          message: labelled
            ? "This puzzle folder is no longer available. Choose another in Settings."
            : "native failure",
        }),
      );
      expect(document.querySelector('[data-testid="puzzle-database-count"]')?.textContent).toBe(
        "0",
      );
    }
  },
);

test.each(["permission", "child", "cancellation"] as const)(
  "listing %s keeps saved selection and puzzle history",
  async (outcome) => {
    const store = await renderPriorPuzzle([puzzleRow()]);
    const selection = localStorage.getItem("puzzle-db");
    const history = storedHistoryBytes();
    mocks.notificationShow.mockClear();
    mocks.listPuzzleDatabases.mockRejectedValue(
      new TauriCommandError({
        tag: "backend-error",
        category: outcome === "cancellation" ? "cancellation" : "permission",
        message: outcome === "cancellation" ? "Cancellation" : "I/O failure",
        ...(outcome === "permission" ? { rootFailure: "permission" as const } : {}),
      }),
    );
    await act(async () => store.set(puzzleWorkspaceGenerationAtom, (generation) => generation + 1));
    expect(mocks.notificationShow.mock.calls).toEqual(
      outcome === "cancellation"
        ? []
        : [
            [
              {
                color: "danger",
                title: "Common.Error",
                message:
                  outcome === "permission"
                    ? "ChessRiddle Studio is not allowed to read this puzzle folder. Choose another in Settings."
                    : "I/O failure",
              },
            ],
          ],
    );
    expect(localStorage.getItem("puzzle-db")).toBe(selection);
    expect(storedHistoryBytes()).toBe(history);
  },
);

test("shows the outdated-database alert for puzzle-themes-unavailable", async () => {
  // Message is neither the old Diesel substring nor the variant Display.
  mocks.getPuzzleThemes.mockRejectedValue(
    commandError("puzzle-themes-unavailable", "native failed"),
  );
  await renderPuzzles();
  await vi.waitFor(() => {
    expect(outdatedAlert()).toBeTruthy();
  });
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

test("reports a current theme database failure without showing the unavailable alert", async () => {
  mocks.getPuzzleThemes.mockRejectedValue(commandError("database", "no such table: themes"));
  await renderPuzzles();
  await vi.waitFor(() => {
    expect(mocks.notificationShow).toHaveBeenCalledWith(
      expect.objectContaining({ color: "danger", message: "no such table: themes" }),
    );
  });
  expect(outdatedAlert()).toBeUndefined();
});

test("reports an ordinary missing-resource theme failure without the unavailable alert", async () => {
  mocks.getPuzzleThemes.mockRejectedValue(commandError("missing-resource", "native failed"));
  await renderPuzzles();
  await vi.waitFor(() => {
    expect(mocks.notificationShow).toHaveBeenCalledWith(
      expect.objectContaining({ color: "danger", message: "native failed" }),
    );
  });
  expect(outdatedAlert()).toBeUndefined();
});

test("keeps a current cancelled theme request quiet", async () => {
  mocks.getPuzzleThemes.mockRejectedValue(commandError("cancellation", "Cancellation"));
  await renderPuzzles();
  await vi.waitFor(() => expect(mocks.getPuzzleThemes).toHaveBeenCalled());
  expect(mocks.notificationShow).not.toHaveBeenCalled();
  expect(outdatedAlert()).toBeUndefined();
});

test("does not show the alert when puzzle themes load", async () => {
  mocks.getPuzzleThemes.mockResolvedValue(["fork"]);
  await renderPuzzles();
  await vi.waitFor(() => {
    expect(mocks.getPuzzleThemes).toHaveBeenCalled();
  });
  expect(outdatedAlert()).toBeUndefined();
});

test("successful puzzle requests retain the saved theme and rating range", async () => {
  mocks.getPuzzleThemes.mockResolvedValue(["fork"]);
  const store = await renderPuzzles();
  await act(async () => {
    store.set(puzzleThemeAtom, "fork");
    store.set(puzzleRatingRangeAtom, [1000, 1400]);
  });
  await vi.waitFor(() => expect(mocks.getPuzzleThemes).toHaveBeenCalled());
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Puzzle.NewPuzzle"]')?.click();
  });
  await vi.waitFor(() =>
    expect(mocks.getPuzzle).toHaveBeenCalledWith(
      selectedDb,
      1000,
      1400,
      "fork",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ),
  );
  expect(document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-count")).toBe(
    "1",
  );
});

test("reports a current puzzle request failure", async () => {
  mocks.getPuzzleThemes.mockResolvedValue(["fork"]);
  mocks.getPuzzle.mockRejectedValue(commandError("database", "puzzle query failed"));
  await renderPuzzles();
  await vi.waitFor(() => expect(mocks.getPuzzleThemes).toHaveBeenCalled());
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Puzzle.NewPuzzle"]')?.click();
  });
  await vi.waitFor(() =>
    expect(mocks.notificationShow).toHaveBeenCalledWith(
      expect.objectContaining({ color: "danger", message: "puzzle query failed" }),
    ),
  );
  expect(document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-count")).toBe(
    "0",
  );
});

test("keeps a stale puzzle request failure quiet after database replacement", async () => {
  mocks.getPuzzleThemes.mockResolvedValue(["fork"]);
  let rejectPuzzle!: (error: unknown) => void;
  mocks.getPuzzle.mockImplementation(
    () => new Promise((_resolve, reject) => (rejectPuzzle = reject)),
  );
  const store = await renderPuzzles();
  await vi.waitFor(() => expect(mocks.getPuzzleThemes).toHaveBeenCalled());
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Puzzle.NewPuzzle"]')?.click();
  });
  await vi.waitFor(() => expect(mocks.getPuzzle).toHaveBeenCalled());
  await act(async () => store.set(selectedPuzzleDbAtom, otherDb));
  await act(async () => rejectPuzzle(commandError("database", "stale puzzle failure")));
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

test("keeps a stale theme failure quiet after database replacement", async () => {
  let rejectThemes!: (error: unknown) => void;
  mocks.getPuzzleThemes.mockImplementation(
    () => new Promise((_resolve, reject) => (rejectThemes = reject)),
  );
  const store = await renderPuzzles();
  await vi.waitFor(() => expect(mocks.getPuzzleThemes).toHaveBeenCalled());
  await act(async () => store.set(selectedPuzzleDbAtom, otherDb));
  await act(async () => rejectThemes(commandError("database", "stale theme failure")));
  expect(mocks.notificationShow).not.toHaveBeenCalled();
  expect(outdatedAlert()).toBeUndefined();
});

test("unmount cancels the held native puzzle database listing", async () => {
  let signal!: AbortSignal;
  mocks.listPuzzleDatabases.mockImplementation(
    ({ signal: next }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal = next;
        next.addEventListener("abort", () => reject(commandError("cancellation", "cancelled")), {
          once: true,
        });
      }),
  );
  await renderPuzzles();
  await vi.waitFor(() => expect(mocks.listPuzzleDatabases).toHaveBeenCalledOnce());
  await act(async () => root.unmount());
  expect(signal.aborted).toBe(true);
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

test("database replacement cancels held theme and puzzle requests and rejects stale publication", async () => {
  let themeSignal!: AbortSignal;
  let puzzleSignal!: AbortSignal;
  let resolvePuzzle!: (value: NativePuzzle) => void;
  mocks.getPuzzleThemes.mockImplementation(
    (_database: unknown, { signal }: { signal: AbortSignal }) => {
      themeSignal = signal;
      return new Promise(() => undefined);
    },
  );
  mocks.getPuzzle.mockImplementation(
    (
      _database: unknown,
      _min: unknown,
      _max: unknown,
      _theme: unknown,
      { signal }: { signal: AbortSignal },
    ) => {
      puzzleSignal = signal;
      return new Promise((done) => {
        resolvePuzzle = done;
      });
    },
  );
  const store = await renderPuzzles();
  await vi.waitFor(() => expect(mocks.getPuzzleThemes).toHaveBeenCalledOnce());
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Puzzle.NewPuzzle"]')?.click();
  });
  await vi.waitFor(() => expect(mocks.getPuzzle).toHaveBeenCalledOnce());
  await act(async () => store.set(selectedPuzzleDbAtom, otherDb));
  expect(themeSignal.aborted).toBe(true);
  expect(puzzleSignal.aborted).toBe(true);
  resolvePuzzle({
    id: 99,
    fen: "8/8/8/8/8/8/8/8 w - - 0 1",
    moves: "e2e4",
    rating: 1200,
    rating_deviation: 10,
    popularity: 1,
    nb_plays: 1,
  });
  await act(async () => Promise.resolve());
  expect(document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-count")).toBe(
    "0",
  );
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

test("puzzle or database replacement cancels completed-theme ownership and refuses stale themes", async () => {
  mocks.getPuzzleThemes.mockResolvedValue(["fork"]);
  mocks.getPuzzle.mockResolvedValue({
    id: 1,
    fen: INITIAL_FEN,
    moves: "e2e4 e7e5",
    rating: 1200,
    rating_deviation: 10,
    popularity: 1,
    nb_plays: 1,
  });
  let completedSignal!: AbortSignal;
  let resolveThemes!: (value: string[]) => void;
  mocks.getThemesForPuzzle.mockImplementation(
    (_database: unknown, _id: unknown, { signal }: { signal: AbortSignal }) =>
      new Promise((done) => {
        completedSignal = signal;
        resolveThemes = done;
      }),
  );
  const store = await renderPuzzles();
  await vi.waitFor(() => expect(mocks.getPuzzleThemes).toHaveBeenCalledOnce());
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Puzzle.NewPuzzle"]')?.click();
  });
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-count")).toBe(
      "1",
    ),
  );
  await act(async () => {
    mocks.board!.movable!.events!.after!("e7", "e5", { premove: false });
  });
  await vi.waitFor(() => expect(mocks.getThemesForPuzzle).toHaveBeenCalledOnce());
  await act(async () => store.set(selectedPuzzleDbAtom, otherDb));
  expect(completedSignal.aborted).toBe(true);
  resolveThemes(["stale-theme"]);
  await act(async () => Promise.resolve());
  expect(document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-themes")).toBe(
    "",
  );
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

test("retains a stored database across workspace switches and restores it on return", async () => {
  const store = await renderPuzzles();
  await vi.waitFor(() => {
    expect(
      document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-database"),
    ).toBe(selectedDb.id);
  });

  mocks.getPuzzleWorkspace.mockResolvedValue(otherWorkspace);
  mocks.listPuzzleDatabases.mockResolvedValue([otherDatabase]);
  await act(async () => {
    store.set(puzzleWorkspaceGenerationAtom, store.get(puzzleWorkspaceGenerationAtom) + 1);
  });

  expect(
    document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-database"),
  ).toBe("none");
  await vi.waitFor(() => {
    expect(document.querySelector('[data-testid="puzzle-database-count"]')?.textContent).toBe("1");
  });
  expect(store.get(selectedPuzzleDbAtom)).toEqual(selectedDb);
  expect(mocks.getPuzzleThemes).toHaveBeenCalledTimes(1);

  mocks.getPuzzleWorkspace.mockResolvedValue(workspace);
  mocks.listPuzzleDatabases.mockResolvedValue([selectedDatabase]);
  await act(async () => {
    store.set(puzzleWorkspaceGenerationAtom, store.get(puzzleWorkspaceGenerationAtom) + 1);
  });

  await vi.waitFor(() => {
    expect(
      document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-database"),
    ).toBe(selectedDb.id);
  });
  expect(store.get(selectedPuzzleDbAtom)).toEqual(selectedDb);
  expect(mocks.getPuzzleThemes).toHaveBeenCalledTimes(2);
});

test.each([
  ["missing", () => mocks.listPuzzleDatabases.mockResolvedValue([])],
  ["offline", () => mocks.listPuzzleDatabases.mockRejectedValue(new Error("offline"))],
])("keeps the stored database but does not use it when the listing is %s", async (_case, setup) => {
  setup();
  const store = await renderPuzzles();

  await vi.waitFor(() => expect(mocks.listPuzzleDatabases).toHaveBeenCalled());
  expect(store.get(selectedPuzzleDbAtom)).toEqual(selectedDb);
  expect(
    document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-database"),
  ).toBe("none");
  expect(mocks.getPuzzleThemes).not.toHaveBeenCalled();
  expect(
    document.querySelector<HTMLButtonElement>('[aria-label="Puzzle.NewPuzzle"]')?.disabled,
  ).toBe(true);
});

test("ignores a stale workspace listing after a newer generation restores the selection", async () => {
  const store = await renderPuzzles();
  await vi.waitFor(() => expect(mocks.getPuzzleThemes).toHaveBeenCalledTimes(1));

  let finishStaleListing: (databases: PuzzleDatabaseInfo[]) => void = () => undefined;
  mocks.getPuzzleWorkspace.mockResolvedValue(otherWorkspace);
  mocks.listPuzzleDatabases.mockImplementation(
    () =>
      new Promise<PuzzleDatabaseInfo[]>((resolve) => {
        finishStaleListing = resolve;
      }),
  );
  await act(async () => {
    store.set(puzzleWorkspaceGenerationAtom, store.get(puzzleWorkspaceGenerationAtom) + 1);
  });
  expect(
    document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-database"),
  ).toBe("none");

  mocks.getPuzzleWorkspace.mockResolvedValue(workspace);
  mocks.listPuzzleDatabases.mockResolvedValue([selectedDatabase]);
  await act(async () => {
    store.set(puzzleWorkspaceGenerationAtom, store.get(puzzleWorkspaceGenerationAtom) + 1);
  });
  await vi.waitFor(() => {
    expect(
      document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-database"),
    ).toBe(selectedDb.id);
  });

  await act(async () => finishStaleListing([otherDatabase]));
  expect(
    document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-database"),
  ).toBe(selectedDb.id);
  expect(store.get(selectedPuzzleDbAtom)).toEqual(selectedDb);
});

test("a late download inventory from the previous workspace cannot reactivate its database", async () => {
  const store = await renderPuzzles();
  await vi.waitFor(() => {
    expect(
      document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-database"),
    ).toBe(selectedDb.id);
  });

  const staleListing = deferred<PuzzleDatabaseInfo[]>();
  mocks.listPuzzleDatabases.mockReturnValueOnce(staleListing.promise);
  const refresh = mocks.addPuzzleProps!.refreshPuzzleDbs();

  mocks.getPuzzleWorkspace.mockResolvedValue(otherWorkspace);
  mocks.listPuzzleDatabases.mockResolvedValue([otherDatabase]);
  await act(async () => mocks.addPuzzleProps!.onWorkspaceChanged());
  await vi.waitFor(() => {
    expect(document.querySelector('[data-testid="puzzle-database-count"]')?.textContent).toBe("1");
    expect(
      document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-database"),
    ).toBe("none");
  });

  await act(async () => {
    staleListing.resolve([selectedDatabase]);
    await refresh;
  });
  expect(
    document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-database"),
  ).toBe("none");
  expect(store.get(selectedPuzzleDbAtom)).toEqual(selectedDb);
  expect(document.querySelector('[data-testid="puzzle-database-count"]')?.textContent).toBe("1");
  await act(async () =>
    document.querySelector<HTMLInputElement>('[placeholder="Puzzle.SelectDatabase"]')!.click(),
  );
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(
    (option) => option.textContent,
  );
  expect(options).toContain("Other");
  expect(options).not.toContain("Tactics");
  expect(
    document.querySelector<HTMLButtonElement>('[aria-label="Puzzle.NewPuzzle"]')?.disabled,
  ).toBe(true);
  await newPuzzle();
  expect(mocks.getPuzzle).not.toHaveBeenCalled();
});

test("an unchanged-workspace download refresh publishes the new inventory", async () => {
  const store = await renderPuzzles();
  await vi.waitFor(() => {
    expect(
      document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-database"),
    ).toBe(selectedDb.id);
  });

  mocks.listPuzzleDatabases.mockResolvedValue([selectedDatabase, otherDatabase]);
  await act(async () => mocks.addPuzzleProps!.refreshPuzzleDbs());

  expect(document.querySelector('[data-testid="puzzle-database-count"]')?.textContent).toBe("2");
  expect(
    document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-database"),
  ).toBe(selectedDb.id);
  expect(store.get(selectedPuzzleDbAtom)).toEqual(selectedDb);
});

test("successful deletion clears the selected puzzle session and closes the modal", async () => {
  sessionStorage.setItem(
    "puzzles-test-puzzles",
    JSON.stringify([
      puzzleRow({ fen: "8/8/8/8/8/8/8/K6k w - - 0 1", moves: ["a1a2"], completion: "correct" }),
    ]),
  );
  const store = await renderPuzzles();
  await act(async () => {
    store.set(trackPuzzleTimeAtom, true);
    store.set(puzzleTimerFamily("puzzles-test"), ownedTimer(123));
  });

  await openAndConfirmDeletion();

  await vi.waitFor(() => {
    expect(mocks.deletePuzzleDatabase).toHaveBeenCalledWith(selectedDb);
    expect(store.get(selectedPuzzleDbAtom)).toBeNull();
    expect(document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-count")).toBe(
      "0",
    );
  });
  expect(store.get(puzzleTimerFamily("puzzles-test"))).toBeNull();
  expect(document.querySelector('[data-testid="puzzle-database-count"]')?.textContent).toBe("0");
  expect(document.querySelector('[data-testid="confirm-delete"]')).toBeNull();
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

test("pre-delete failure preserves selection, list, session, timer and modal", async () => {
  const failure = commandError("io", "delete failed before removal");
  mocks.deletePuzzleDatabase.mockRejectedValue(failure);
  sessionStorage.setItem(
    "puzzles-test-puzzles",
    JSON.stringify([
      puzzleRow({ fen: "8/8/8/8/8/8/8/K6k w - - 0 1", moves: ["a1a2"], completion: "correct" }),
    ]),
  );
  const store = await renderPuzzles();
  await act(async () => {
    store.set(trackPuzzleTimeAtom, true);
    store.set(puzzleTimerFamily("puzzles-test"), ownedTimer(123));
  });

  await openAndConfirmDeletion();

  await vi.waitFor(() => expect(mocks.notificationShow).toHaveBeenCalled());
  expect(store.get(selectedPuzzleDbAtom)).toEqual(selectedDb);
  expect(store.get(puzzleTimerFamily("puzzles-test"))).toEqual(ownedTimer(123));
  expect(document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-count")).toBe(
    "1",
  );
  expect(document.querySelector('[data-testid="puzzle-database-count"]')?.textContent).toBe("1");
  expect(document.querySelector('[data-testid="confirm-delete"]')).toBeTruthy();
});

test("applied deletion converges state, closes the modal and still reports cleanup failure", async () => {
  const applied = commandError(
    "partial-removal",
    "Partially removed: 1 entries were deleted before failing: conflict",
  );
  mocks.deletePuzzleDatabase.mockRejectedValue(applied);
  sessionStorage.setItem(
    "puzzles-test-puzzles",
    JSON.stringify([
      puzzleRow({ fen: "8/8/8/8/8/8/8/K6k w - - 0 1", moves: ["a1a2"], completion: "correct" }),
    ]),
  );
  const store = await renderPuzzles();
  await act(async () => {
    store.set(trackPuzzleTimeAtom, true);
    store.set(puzzleTimerFamily("puzzles-test"), ownedTimer(123));
  });

  await openAndConfirmDeletion();

  await vi.waitFor(() => {
    expect(store.get(selectedPuzzleDbAtom)).toBeNull();
    expect(mocks.notificationShow).toHaveBeenCalledWith(
      expect.objectContaining({ color: "danger", message: applied.message }),
    );
  });
  expect(store.get(puzzleTimerFamily("puzzles-test"))).toBeNull();
  expect(document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-count")).toBe(
    "0",
  );
  expect(document.querySelector('[data-testid="puzzle-database-count"]')?.textContent).toBe("0");
  expect(document.querySelector('[data-testid="confirm-delete"]')).toBeNull();
});

test("landed deletion does not clear a concurrently selected different database", async () => {
  mocks.listPuzzleDatabases.mockResolvedValue([selectedDatabase, otherDatabase]);
  let finishDeletion: () => void = () => undefined;
  mocks.deletePuzzleDatabase.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishDeletion = resolve;
      }),
  );
  const store = await renderPuzzles();

  await openAndConfirmDeletion();
  await act(async () => store.set(selectedPuzzleDbAtom, otherDb));
  await vi.waitFor(() => {
    expect(
      document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-database"),
    ).toBe(otherDb.id);
  });

  let finishPuzzle: (puzzle: NativePuzzle) => void = () => undefined;
  mocks.getPuzzle.mockImplementation(
    () =>
      new Promise<NativePuzzle>((resolve) => {
        finishPuzzle = (puzzle) => resolve(puzzle);
      }),
  );
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Puzzle.NewPuzzle"]')?.click();
  });
  await vi.waitFor(() =>
    expect(mocks.getPuzzle).toHaveBeenCalledWith(
      otherDb,
      expect.any(Number),
      expect.any(Number),
      null,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ),
  );

  await act(async () => {
    finishDeletion();
    finishPuzzle({
      id: 7,
      fen: "8/8/8/8/8/8/8/K6k w - - 0 1",
      moves: "a1a2",
      rating: 1200,
      rating_deviation: 50,
      popularity: 1,
      nb_plays: 1,
    });
    await Promise.resolve();
  });

  await vi.waitFor(() => {
    expect(store.get(selectedPuzzleDbAtom)).toEqual(otherDb);
    expect(document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-count")).toBe(
      "1",
    );
  });
  expect(
    document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-database"),
  ).toBe(otherDb.id);
  expect(document.querySelector('[data-testid="puzzle-database-count"]')?.textContent).toBe("1");
  expect(document.querySelector('[data-testid="confirm-delete"]')).toBeNull();
});

test("landed deletion clears its retained selection after the workspace view switches", async () => {
  let finishDeletion: () => void = () => undefined;
  mocks.deletePuzzleDatabase.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishDeletion = resolve;
      }),
  );
  const store = await renderPuzzles();
  await openAndConfirmDeletion();

  mocks.getPuzzleWorkspace.mockResolvedValue(otherWorkspace);
  mocks.listPuzzleDatabases.mockResolvedValue([otherDatabase]);
  await act(async () => {
    store.set(puzzleWorkspaceGenerationAtom, store.get(puzzleWorkspaceGenerationAtom) + 1);
  });
  await vi.waitFor(() => {
    expect(store.get(selectedPuzzleDbAtom)).toEqual(selectedDb);
    expect(
      document.querySelector('[data-testid="puzzle-state"]')?.getAttribute("data-database"),
    ).toBe("none");
  });

  await act(async () => finishDeletion());

  await vi.waitFor(() => expect(store.get(selectedPuzzleDbAtom)).toBeNull());
  expect(document.querySelector('[data-testid="puzzle-database-count"]')?.textContent).toBe("1");
  expect(document.querySelector('[data-testid="confirm-delete"]')).toBeNull();
});
