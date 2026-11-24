import { MantineProvider } from "@mantine/core";
import { createEmptyCard } from "ts-fsrs";
import { Provider, createStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { LibraryRow } from "@/components/library/libraryData";
import {
  deckAtomFamily,
  practiceNewPerSessionAtom,
  practiceTrainMinutesAtom,
  referenceDbAtom,
  timedRunLaunchAtom,
} from "@/state/atoms";
import type { PracticeDeckValue } from "@/state/practiceStorage";
import type { Position } from "@/utils/practicePosition";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import TrainOpeningsPopover, { type TrainOpeningsDue } from "./TrainOpeningsPopover";

vi.mock("@/state/atoms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/atoms")>();
  const { atom } = await import("jotai");
  const { atomFamily } = await import("jotai/utils");
  const emptyDeck = (): PracticeDeckValue => ({
    status: "ready",
    positions: [],
    revision: 1,
    generation: 0,
    unappliedReviews: 0,
    orphansAcknowledged: true,
  });
  const deckAtomFamily = atomFamily(
    (_identity: { file: string; game: number }) => {
      const inner = atom(emptyDeck());
      return atom(
        (get) => get(inner),
        (get, set, update: PracticeDeckValue | { type: "sync"; positions: Position[] }) => {
          if (update && typeof update === "object" && "type" in update && update.type === "sync") {
            const current = get(inner);
            set(inner, { ...current, status: "ready", positions: update.positions });
          } else {
            set(inner, update as PracticeDeckValue);
          }
          return Promise.resolve();
        },
      );
    },
    (left, right) => left.file === right.file && left.game === right.game,
  );
  return { ...actual, deckAtomFamily };
});

const mocks = vi.hoisted(() => ({
  resolution: {
    selectedReference: null as { id: { id: string }; kind: "database" } | null,
    selectedReferenceKey: null as string | null,
    referenceDb: null as { id: { id: string }; kind: "database" } | null,
    referenceKey: null as string | null,
    currencyGeneration: undefined as number | undefined,
    currencyStatus: undefined as string | undefined,
    currencyError: undefined as unknown,
    currencyPending: false,
  },
  prepare: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("./useReferenceResolution", () => ({
  useReferenceResolution: () => mocks.resolution,
}));
vi.mock("./prepareTimedRun", () => ({
  prepareTimedRunWeights: (...args: unknown[]) => mocks.prepare(...args),
}));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: mocks.notify },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: { minutes?: number; count?: number; positions?: string; repertoires?: string },
    ) =>
      options?.minutes != null
        ? `${key}:${options.minutes}`
        : options?.count != null
          ? `${key}#${options.count}`
          : options?.positions != null
            ? `${key}(${options.positions}|${options.repertoires})`
            : key,
    i18n: { language: "en-US" },
  }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

let host: HTMLDivElement;
let root: Root;
let store: ReturnType<typeof createStore>;

function repertoireRow(key: string): Extract<LibraryRow, { kind: "file" }> {
  return {
    kind: "file",
    key,
    name: key,
    modified: 0,
    file: {
      type: "file",
      handle: { kind: "fileWorkspace", id: { id: key } },
      name: key,
      metadata: { type: "repertoire", tags: [] },
      lastModified: 0,
      numGames: 1,
    },
  };
}

function readyDeck(due: boolean): PracticeDeckValue {
  return {
    status: "ready",
    positions: [
      {
        fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
        answer: "e5",
        card: {
          ...createEmptyCard(new Date(due ? Date.now() - 1000 : Date.now() + 86_400_000)),
          reps: due ? 1 : 0,
        },
      },
    ],
    revision: 1,
    generation: 0,
    unappliedReviews: 0,
    orphansAcknowledged: true,
  };
}

function failedDeck(): PracticeDeckValue {
  return {
    status: "read-failed",
    positions: [],
    revision: 0,
    generation: 0,
    unappliedReviews: 0,
    orphansAcknowledged: false,
    error: { category: "unexpected", message: "failed" },
  };
}

function dueState(overrides: Partial<TrainOpeningsDue> = {}): TrainOpeningsDue {
  const row = repertoireRow("file-a");
  const decks = new Map([[row.key, new Map([[0, readyDeck(true)]])]]);
  return {
    rows: [{ file: row, count: 1, failed: false }],
    total: 1,
    incomplete: false,
    inventoryFailed: false,
    discoveryPending: false,
    decks,
    ...overrides,
  };
}

async function renderPopover(due: TrainOpeningsDue, listingInFlight = false) {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <Provider store={store}>
          <TrainOpeningsPopover
            newTabId="home"
            due={due}
            listingInFlight={listingInFlight}
            discoveryFailed={false}
            trigger={
              <button type="button" data-train-openings-trigger>
                Home.Card.TrainOpenings.Title
              </button>
            }
          />
        </Provider>
      </MantineProvider>,
    ),
  );
}

function dropdown() {
  return document.body.querySelector("[data-train-openings]");
}

async function open() {
  await act(async () => {
    host.querySelector<HTMLButtonElement>("[data-train-openings-trigger]")!.click();
  });
}

async function clickStart() {
  const start = [...(dropdown()?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Home.TrainOpenings.Start",
  )!;
  await act(async () => {
    start.click();
  });
  return start;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolution.selectedReference = null;
  mocks.resolution.referenceDb = null;
  mocks.prepare.mockReset();
  mocks.notify.mockReset();
  localStorage.clear();
  sessionStorage.clear();
  store = createStore();
  store.set(practiceTrainMinutesAtom, 30);
  store.set(practiceNewPerSessionAtom, 10);
  store.set(referenceDbAtom, null);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  sessionStorage.clear();
});

test("the minute choice persists", async () => {
  await renderPopover(dueState());
  await open();
  const fortyFive = [...(dropdown()?.querySelectorAll("label, button, input") ?? [])].find((node) =>
    node.textContent?.includes("Home.TrainOpenings.Minutes:45"),
  );
  expect(fortyFive).toBeTruthy();
  await act(async () => {
    (fortyFive as HTMLElement).click();
  });
  expect(store.get(practiceTrainMinutesAtom)).toBe(45);
  await act(async () => root.unmount());
  const next = createStore();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <Provider store={next}>
          <TrainOpeningsPopover
            newTabId="home"
            due={dueState()}
            listingInFlight={false}
            discoveryFailed={false}
            trigger={
              <button type="button" data-train-openings-trigger>
                Home.Card.TrainOpenings.Title
              </button>
            }
          />
        </Provider>
      </MantineProvider>,
    ),
  );
  expect(next.get(practiceTrainMinutesAtom)).toBe(45);
});

test("Start is disabled while discovery is in flight", async () => {
  await renderPopover(dueState({ discoveryPending: true }));
  await open();
  const start = [...(dropdown()?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Home.TrainOpenings.Start",
  )!;
  expect(start.disabled).toBe(true);
});

test("Start is disabled while the Library listing is in flight", async () => {
  await renderPopover(dueState({ discoveryPending: false }), true);
  await open();
  const start = [...(dropdown()?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Home.TrainOpenings.Start",
  )!;
  expect(start.disabled).toBe(true);
});

test("Start is disabled when a failed sibling sits beside a chapter with no eligible card", async () => {
  const row = repertoireRow("file-a");
  const unseen = readyDeck(false);
  store.set(practiceNewPerSessionAtom, 0);
  store.set(deckAtomFamily({ file: row.key, game: 0 }), unseen);
  store.set(deckAtomFamily({ file: row.key, game: 1 }), failedDeck());
  await renderPopover(
    dueState({
      decks: new Map([
        [
          row.key,
          new Map([
            [0, unseen],
            [1, failedDeck()],
          ]),
        ],
      ]),
      incomplete: true,
      total: 0,
      rows: [{ file: row, count: 0, failed: true }],
    }),
  );
  await open();
  let start = [...(dropdown()?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Home.TrainOpenings.Start",
  )!;
  expect(start.disabled).toBe(true);
  expect(dropdown()?.textContent).toContain("Home.DuePractice.Incomplete");
  expect(dropdown()?.textContent).toContain("Home.DuePractice.NothingDue");

  await act(async () => root.unmount());
  store = createStore();
  store.set(practiceTrainMinutesAtom, 30);
  store.set(practiceNewPerSessionAtom, 0);
  store.set(referenceDbAtom, null);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const due = readyDeck(true);
  store.set(deckAtomFamily({ file: row.key, game: 0 }), due);
  store.set(deckAtomFamily({ file: row.key, game: 1 }), failedDeck());
  await renderPopover(
    dueState({
      decks: new Map([
        [
          row.key,
          new Map([
            [0, due],
            [1, failedDeck()],
          ]),
        ],
      ]),
      incomplete: true,
      total: 1,
      rows: [{ file: row, count: 1, failed: true }],
    }),
  );
  await open();
  start = [...(dropdown()?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Home.TrainOpenings.Start",
  )!;
  expect(start.disabled).toBe(false);
  expect(dropdown()?.textContent).toContain("Home.DuePractice.Incomplete");
  expect(dropdown()?.textContent).not.toContain("Home.DuePractice.NothingDue");
});

test("Start stays enabled beside a failed sibling deck", async () => {
  const row = repertoireRow("file-a");
  const decks = new Map([
    [
      row.key,
      new Map([
        [0, readyDeck(true)],
        [1, failedDeck()],
      ]),
    ],
  ]);
  await renderPopover(
    dueState({
      decks,
      incomplete: true,
      rows: [{ file: row, count: 1, failed: true }],
    }),
  );
  await open();
  const start = [...(dropdown()?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Home.TrainOpenings.Start",
  )!;
  expect(start.disabled).toBe(false);
  expect(dropdown()?.textContent).toContain("Home.DuePractice.Incomplete");
});

test("the due total pluralises positions and the repertoires that have a count", async () => {
  await renderPopover(
    dueState({
      rows: [
        { file: repertoireRow("file-a"), count: 5, failed: false },
        { file: repertoireRow("file-b"), count: 0, failed: false },
        { file: repertoireRow("file-c"), count: null, failed: true },
      ],
      total: 5,
    }),
  );
  await open();
  expect(dropdown()?.textContent).toContain(
    "Home.DuePractice.Total(Home.DuePractice.Positions#5|Home.DuePractice.Repertoires#2)",
  );
});

test("Start is disabled when inventory failed and nothing is eligible", async () => {
  const row = repertoireRow("file-a");
  const unseen = readyDeck(false);
  store.set(practiceNewPerSessionAtom, 0);
  store.set(deckAtomFamily({ file: row.key, game: 0 }), unseen);
  await renderPopover(
    dueState({
      decks: new Map([[row.key, new Map([[0, unseen]])]]),
      inventoryFailed: true,
      incomplete: true,
      total: 0,
      rows: [{ file: row, count: 0, failed: false }],
    }),
  );
  await open();
  const start = [...(dropdown()?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Home.TrainOpenings.Start",
  )!;
  expect(start.disabled).toBe(true);
  expect(dropdown()?.textContent).toContain("Home.DuePractice.Incomplete");
  expect(dropdown()?.textContent).toContain("Home.DuePractice.NothingDue");
});

test("Start stays enabled when inventory failed beside an eligible card", async () => {
  await renderPopover(
    dueState({
      inventoryFailed: true,
      incomplete: true,
    }),
  );
  await open();
  const start = [...(dropdown()?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Home.TrainOpenings.Start",
  )!;
  expect(start.disabled).toBe(false);
  expect(dropdown()?.textContent).toContain("Home.DuePractice.Incomplete");
  expect(dropdown()?.textContent).not.toContain("Home.DuePractice.NothingDue");
});

test("the nothing-due message appears only when Start is disabled for an empty library", async () => {
  const row = repertoireRow("file-a");
  const empty: PracticeDeckValue = {
    status: "ready",
    positions: [],
    revision: 1,
    generation: 0,
    unappliedReviews: 0,
    orphansAcknowledged: true,
  };
  await renderPopover(
    dueState({
      decks: new Map([[row.key, new Map([[0, empty]])]]),
      total: 0,
      rows: [{ file: row, count: 0, failed: false }],
    }),
  );
  await open();
  const start = [...(dropdown()?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Home.TrainOpenings.Start",
  )!;
  expect(start.disabled).toBe(true);
  expect(dropdown()?.textContent).toContain("Home.DuePractice.NothingDue");
});

test("shows the reference hint when none is selected", async () => {
  await renderPopover(dueState());
  await open();
  expect(dropdown()?.textContent).toContain("Home.TrainOpenings.NoReference");
  expect(dropdown()?.textContent).not.toContain("Collections.Unavailable");
});

test("shows the unavailable line when a selected reference is unusable", async () => {
  mocks.resolution.selectedReference = { id: { id: "db" }, kind: "database" };
  mocks.resolution.referenceDb = null;
  await renderPopover(dueState());
  await open();
  expect(dropdown()?.textContent).toContain("Collections.Unavailable");
  expect(dropdown()?.textContent).not.toContain("Home.TrainOpenings.NoReference");
});

test("Start writes timedRunLaunchAtom only after preparation deck writes resolve", async () => {
  const due = dueState();
  const row = due.rows[0]!.file;
  store.set(deckAtomFamily({ file: row.key, game: 0 }), readyDeck(true));
  mocks.resolution.selectedReference = { id: { id: "db" }, kind: "database" };
  mocks.resolution.referenceDb = { id: { id: "db" }, kind: "database" };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mocks.prepare.mockImplementation(
    async (options: {
      signal: AbortSignal;
      deps: { writeDeck: (file: string, game: number, positions: unknown) => Promise<void> };
    }) => {
      await gate;
      if (options.signal.aborted) return { status: "aborted" };
      await options.deps.writeDeck(row.key, 0, readyDeck(true).positions);
      return { status: "ready", statsFailed: false };
    },
  );
  await renderPopover(due);
  await open();
  await clickStart();
  expect(store.get(timedRunLaunchAtom)).toBeNull();
  await act(async () => {
    release();
    await Promise.resolve();
    await Promise.resolve();
  });
  const launched = store.get(timedRunLaunchAtom);
  expect(launched).toMatchObject({ newTabId: "home" });
  expect(launched?.candidates.length).toBeGreaterThan(0);
});

test("aborting preparation creates no launch", async () => {
  const due = dueState();
  const row = due.rows[0]!.file;
  store.set(deckAtomFamily({ file: row.key, game: 0 }), readyDeck(true));
  mocks.resolution.selectedReference = { id: { id: "db" }, kind: "database" };
  mocks.resolution.referenceDb = { id: { id: "db" }, kind: "database" };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mocks.prepare.mockImplementation(async (options: { signal: AbortSignal }) => {
    await gate;
    if (options.signal.aborted) return { status: "aborted" };
    return { status: "ready", statsFailed: false };
  });
  await renderPopover(due);
  await open();
  await clickStart();
  await act(async () => {
    host.querySelector<HTMLButtonElement>("[data-train-openings-trigger]")!.click();
  });
  await act(async () => {
    release();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(store.get(timedRunLaunchAtom)).toBeNull();
});

test("a failed statistics request notifies once and still launches", async () => {
  const due = dueState();
  const row = due.rows[0]!.file;
  store.set(deckAtomFamily({ file: row.key, game: 0 }), readyDeck(true));
  mocks.resolution.selectedReference = { id: { id: "db" }, kind: "database" };
  mocks.resolution.referenceDb = { id: { id: "db" }, kind: "database" };
  mocks.prepare.mockResolvedValue({
    status: "ready",
    statsFailed: true,
    statsError: new Error("stats down"),
  });
  await renderPopover(due);
  await open();
  await clickStart();
  expect(mocks.notify).toHaveBeenCalledTimes(1);
  expect(store.get(timedRunLaunchAtom)?.candidates.length).toBeGreaterThan(0);
});

test("Start stays enabled for unseen-only chapters and disabled when nothing is eligible", async () => {
  const row = repertoireRow("file-a");
  const unseen = readyDeck(false);
  store.set(deckAtomFamily({ file: row.key, game: 0 }), unseen);
  await renderPopover(
    dueState({
      decks: new Map([[row.key, new Map([[0, unseen]])]]),
      total: 0,
      rows: [{ file: row, count: 0, failed: false }],
    }),
  );
  await open();
  let start = [...(dropdown()?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Home.TrainOpenings.Start",
  )!;
  expect(start.disabled).toBe(false);
  expect(dropdown()?.textContent).not.toContain("Home.DuePractice.NothingDue");
  await clickStart();
  expect(store.get(timedRunLaunchAtom)).toBeTruthy();

  await act(async () => root.unmount());
  store = createStore();
  store.set(practiceTrainMinutesAtom, 30);
  store.set(practiceNewPerSessionAtom, 0);
  store.set(referenceDbAtom, null);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await renderPopover(
    dueState({
      decks: new Map([[row.key, new Map([[0, unseen]])]]),
      total: 0,
      rows: [{ file: row, count: 0, failed: false }],
    }),
  );
  await open();
  start = [...(dropdown()?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Home.TrainOpenings.Start",
  )!;
  expect(start.disabled).toBe(true);
  expect(dropdown()?.textContent).toContain("Home.DuePractice.NothingDue");
});

const E4_FEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const D4_FEN = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1";

function duePosition(fen: string, answer: string, weight: number): Position {
  return {
    fen,
    answer,
    weight,
    card: {
      ...createEmptyCard(new Date(Date.now() - 1000)),
      reps: 1,
    },
  };
}

function readyWeighted(fen: string, answer: string, weight: number): PracticeDeckValue {
  return {
    status: "ready",
    positions: [duePosition(fen, answer, weight)],
    revision: 1,
    generation: 0,
    unappliedReviews: 0,
    orphansAcknowledged: true,
  };
}

function writeBlocked(positions: Position[]): PracticeDeckValue {
  return {
    status: "write-blocked",
    positions,
    revision: 1,
    generation: 0,
    unappliedReviews: 0,
    orphansAcknowledged: true,
    error: { category: "unexpected", message: "write failed" },
  };
}

test("a deck whose write fails is left out of the launch", async () => {
  const rowA = repertoireRow("file-a");
  const rowB = repertoireRow("file-b");
  const decks = new Map([
    [rowA.key, new Map([[0, readyWeighted(E4_FEN, "e5", 0.4)]])],
    [rowB.key, new Map([[0, readyWeighted(D4_FEN, "d5", 0.3)]])],
  ]);
  store.set(deckAtomFamily({ file: rowA.key, game: 0 }), readyWeighted(E4_FEN, "e5", 0.4));
  store.set(deckAtomFamily({ file: rowB.key, game: 0 }), readyWeighted(D4_FEN, "d5", 0.3));
  mocks.resolution.selectedReference = { id: { id: "db" }, kind: "database" };
  mocks.resolution.referenceDb = { id: { id: "db" }, kind: "database" };
  mocks.prepare.mockImplementation(
    async (options: {
      deps: { writeDeck: (file: string, game: number, positions: Position[]) => Promise<void> };
    }) => {
      await options.deps.writeDeck(rowA.key, 0, [duePosition(E4_FEN, "e5", 0.5)]);
      await options.deps.writeDeck(rowB.key, 0, [duePosition(D4_FEN, "d5", 0.6)]);
      store.set(
        deckAtomFamily({ file: rowA.key, game: 0 }),
        writeBlocked([duePosition(E4_FEN, "e5", 0.5)]),
      );
      return { status: "ready", statsFailed: false };
    },
  );
  await renderPopover(
    dueState({
      decks,
      rows: [
        { file: rowA, count: 1, failed: false },
        { file: rowB, count: 1, failed: false },
      ],
      total: 2,
    }),
  );
  await open();
  await clickStart();
  const launched = store.get(timedRunLaunchAtom);
  expect(launched?.chapters.map((chapter) => chapter.file)).toEqual([rowB.key]);
  expect(launched?.candidates.map((candidate) => candidate.file)).toEqual([rowB.key]);
});

test("the launch order reflects newly written weights", async () => {
  const rowA = repertoireRow("file-a");
  const rowB = repertoireRow("file-b");
  const decks = new Map([
    [rowA.key, new Map([[0, readyWeighted(E4_FEN, "e5", 0.8)]])],
    [rowB.key, new Map([[0, readyWeighted(D4_FEN, "d5", 0.3)]])],
  ]);
  store.set(deckAtomFamily({ file: rowA.key, game: 0 }), readyWeighted(E4_FEN, "e5", 0.8));
  store.set(deckAtomFamily({ file: rowB.key, game: 0 }), readyWeighted(D4_FEN, "d5", 0.3));
  mocks.resolution.selectedReference = { id: { id: "db" }, kind: "database" };
  mocks.resolution.referenceDb = { id: { id: "db" }, kind: "database" };
  mocks.prepare.mockImplementation(
    async (options: {
      deps: { writeDeck: (file: string, game: number, positions: Position[]) => Promise<void> };
    }) => {
      await options.deps.writeDeck(rowA.key, 0, [duePosition(E4_FEN, "e5", 0.2)]);
      await options.deps.writeDeck(rowB.key, 0, [duePosition(D4_FEN, "d5", 0.9)]);
      return { status: "ready", statsFailed: false };
    },
  );
  await renderPopover(
    dueState({
      decks,
      rows: [
        { file: rowA, count: 1, failed: false },
        { file: rowB, count: 1, failed: false },
      ],
      total: 2,
    }),
  );
  await open();
  await clickStart();
  const launched = store.get(timedRunLaunchAtom);
  expect(launched?.candidates.map((candidate) => candidate.file)).toEqual([rowB.key, rowA.key]);
  expect(launched?.candidates.map((candidate) => candidate.weight)).toEqual([0.9, 0.2]);
});
