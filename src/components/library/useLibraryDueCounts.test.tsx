import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { atom, createStore, Provider, type PrimitiveAtom } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createEmptyCard } from "ts-fsrs";
import type { PracticeDeckValue } from "@/state/practiceStorage";
import type { LibraryRow } from "./libraryData";
import {
  LIBRARY_DECK_CONCURRENCY,
  projectLibraryDueCounts,
  useLibraryDueCounts,
} from "./useLibraryDueCounts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type DeckParam = { file: string; game: number };
type FamilyEvent = {
  type: "CREATE" | "REMOVE";
  param: DeckParam;
  atom?: PrimitiveAtom<PracticeDeckValue>;
};

const mocks = vi.hoisted(() => ({
  family: Object.assign(vi.fn(), {
    getParams: () => [] as Iterable<DeckParam>,
    unstable_listen: (_listener: (event: FamilyEvent) => void) => () => {},
  }),
  listeners: new Set<(event: FamilyEvent) => void>(),
  params: new Map<string, DeckParam>(),
  ensurePracticeMigration: vi.fn(),
  listPracticeDecks: vi.fn(),
}));
vi.mock("@/state/atoms", () => ({ deckAtomFamily: mocks.family }));
vi.mock("@/state/practiceStorage", () => ({
  ensurePracticeMigration: mocks.ensurePracticeMigration,
  listPracticeDecks: mocks.listPracticeDecks,
}));

let root: Root;
let host: HTMLDivElement;
let store: ReturnType<typeof createStore>;
let latest: ReturnType<typeof useLibraryDueCounts>;
let decks: Map<string, PrimitiveAtom<PracticeDeckValue>>;
let mounted: Set<string>;
let pending: Set<string>;
let peak: number;

function id(file: string, game = 0) {
  return `${file}\u0000${game}`;
}
function deck(
  status: PracticeDeckValue["status"] = "ready",
  positions: PracticeDeckValue["positions"] = [],
): PracticeDeckValue {
  return {
    status,
    positions,
    revision: 0,
    generation: 0,
    unappliedReviews: 0,
    orphansAcknowledged: false,
  };
}
function repertoire(index: number): Extract<LibraryRow, { kind: "file" }> {
  const key = `file-${index}`;
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
function position(due: number, reps: number) {
  return { fen: "", answer: "", card: { ...createEmptyCard(new Date(due)), reps } };
}
function emit(type: "CREATE" | "REMOVE", param: DeckParam) {
  for (const listener of [...mocks.listeners]) {
    listener({ type, param, atom: decks.get(id(param.file, param.game)) });
  }
}
function Consumer({ rows }: { rows: LibraryRow[] }) {
  latest = useLibraryDueCounts(rows);
  return <span>{latest.total}</span>;
}
async function render(rows: LibraryRow[]) {
  await act(async () =>
    root.render(
      <Provider store={store}>
        <Consumer rows={rows} />
      </Provider>,
    ),
  );
}
async function settle(key: string, value: PracticeDeckValue) {
  pending.delete(key);
  await act(async () => store.set(decks.get(key)!, value));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  store = createStore();
  decks = new Map();
  mounted = new Set();
  pending = new Set();
  peak = 0;
  mocks.listeners.clear();
  mocks.params.clear();
  mocks.family.mockReset();
  mocks.family.getParams = () => mocks.params.values();
  mocks.family.unstable_listen = (listener: (event: FamilyEvent) => void) => {
    mocks.listeners.add(listener);
    return () => {
      mocks.listeners.delete(listener);
    };
  };
  mocks.family.mockImplementation(({ file, game }: DeckParam) => {
    const key = id(file, game);
    let value = decks.get(key);
    if (!value) {
      value = atom(deck("loading"));
      value.onMount = () => {
        mounted.add(key);
        pending.add(key);
        peak = Math.max(peak, pending.size);
        return () => {
          mounted.delete(key);
          pending.delete(key);
        };
      };
      decks.set(key, value);
      mocks.params.set(key, { file, game });
      emit("CREATE", { file, game });
    }
    return value;
  });
  mocks.ensurePracticeMigration.mockReset();
  mocks.ensurePracticeMigration.mockResolvedValue({});
  mocks.listPracticeDecks.mockReset();
  mocks.listPracticeDecks.mockResolvedValue({ decks: [], anomalies: [] });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

test("hydrates twelve repertoires through four slots, keeps subscriptions live, and counts due only", async () => {
  const rows = Array.from({ length: 12 }, (_, index) => repertoire(index));
  await render(rows);
  expect(pending.size).toBe(LIBRARY_DECK_CONCURRENCY);
  expect(mounted.size).toBe(4);
  for (let index = 0; index < 12; index++) {
    expect(decks.has(id(rows[index].key))).toBe(true);
    await settle(
      id(rows[index].key),
      deck("ready", [position(Date.now() - 1000, 0), position(Date.now() - 1000, 2)]),
    );
    expect(pending.size).toBeLessThanOrEqual(4);
  }
  expect(peak).toBe(4);
  expect(mounted.size).toBe(12);
  expect(latest.total).toBe(12);
  expect(latest.rows[11].count).toBe(1);
  expect(latest.incomplete).toBe(false);
  await act(async () => store.set(decks.get(id(rows[11].key))!, deck()));
  expect(latest.total).toBe(11);
  await render([]);
  expect(mounted.size).toBe(0);
});

test("includes an unloadable deck in Due and marks the total incomplete", async () => {
  const row = repertoire(0);
  await render([row]);
  await settle(id(row.key), deck("read-failed"));
  expect(latest.dueRows.map((entry) => entry.file.key)).toEqual([row.key]);
  expect(latest.dueRows[0].failed).toBe(true);
  expect(latest.dueRows[0].count).toBeNull();
  expect(latest.incomplete).toBe(true);
});

test("reports the earliest future boundary from a zero-due deck and refreshes when it crosses", async () => {
  const first = repertoire(0);
  const second = repertoire(1);
  await render([first, second]);
  const earliest = Date.now() + 1000;
  await settle(id(first.key), deck("ready", [position(earliest, 2)]));
  await settle(id(second.key), deck("ready", [position(earliest + 1000, 2)]));
  expect(latest.total).toBe(0);
  expect(latest.nextDue?.getTime()).toBe(earliest);
  await act(async () => vi.advanceTimersByTime(1002));
  expect(latest.total).toBe(1);
  expect(latest.nextDue?.getTime()).toBe(earliest + 1000);
});

test("unmount releases live subscriptions and prevents queued hydrations and old deliveries", async () => {
  await render(Array.from({ length: 12 }, (_, index) => repertoire(index)));
  const old = decks.get(id("file-0"))!;
  await render([repertoire(99)]);
  expect(mounted).toEqual(new Set([id("file-99")]));
  await act(async () => store.set(old, deck("ready", [position(Date.now() - 1, 2)])));
  expect(latest.rows.map((row) => row.file.key)).toEqual(["file-99"]);
  await act(async () => root.render(null));
  expect(mounted.size).toBe(0);
  expect(decks.has(id("file-4"))).toBe(false);
});

test("pure due projection excludes never-trained positions", () => {
  const row = repertoire(0);
  expect(
    projectLibraryDueCounts(
      [row],
      new Map([[row.key, new Map([[0, deck("ready", [position(Date.now() - 1, 0)])]])]]),
      "complete",
    ).total,
  ).toBe(0);
});

test("due in a later inventory chapter includes the repertoire once settled", async () => {
  const row = repertoire(0);
  mocks.listPracticeDecks.mockResolvedValue({
    decks: [{ fileId: row.key, game: 1 }],
    anomalies: [],
  });
  await render([row]);
  await settle(id(row.key, 0), deck("ready"));
  await settle(id(row.key, 1), deck("ready", [position(Date.now() - 1000, 2)]));
  expect(latest.dueRows.map((entry) => entry.file.key)).toEqual([row.key]);
  expect(latest.dueRows[0].count).toBe(1);
  expect(latest.total).toBe(1);
  expect(latest.incomplete).toBe(false);
});

test("sums due across chapters and takes the earliest nextDue", async () => {
  const row = repertoire(0);
  const earlier = Date.now() + 1000;
  const later = earlier + 1000;
  mocks.listPracticeDecks.mockResolvedValue({
    decks: [
      { fileId: row.key, game: 0 },
      { fileId: row.key, game: 1 },
    ],
    anomalies: [],
  });
  await render([row]);
  await settle(id(row.key, 0), deck("ready", [position(Date.now() - 1000, 2), position(later, 2)]));
  await settle(
    id(row.key, 1),
    deck("ready", [position(Date.now() - 1000, 2), position(earlier, 2)]),
  );
  expect(latest.rows[0].count).toBe(2);
  expect(latest.total).toBe(2);
  expect(latest.nextDue?.getTime()).toBe(earlier);
  expect(latest.incomplete).toBe(false);
});

test("inventory listing failure still shows game-0 counts and stays incomplete", async () => {
  const row = repertoire(0);
  mocks.listPracticeDecks.mockRejectedValue(new Error("inventory unavailable"));
  await render([row]);
  await settle(id(row.key, 0), deck("ready", [position(Date.now() - 1000, 2)]));
  expect(latest.rows[0].count).toBe(1);
  expect(latest.total).toBe(1);
  expect(latest.incomplete).toBe(true);
  expect(decks.has(id(row.key, 1))).toBe(false);
});

test("CREATE subscribes a repertoire chapter and ignores a non-repertoire file", async () => {
  const row = repertoire(0);
  await render([row]);
  await settle(id(row.key, 0), deck("ready"));
  expect(latest.total).toBe(0);
  const calls = mocks.family.mock.calls.length;
  await act(async () => emit("CREATE", { file: row.key, game: 1 }));
  await settle(id(row.key, 1), deck("ready", [position(Date.now() - 1000, 2)]));
  expect(latest.total).toBe(1);
  expect(latest.rows[0].count).toBe(1);
  await act(async () => emit("CREATE", { file: "other-file", game: 0 }));
  expect(mocks.family.mock.calls.length).toBeGreaterThan(calls);
  expect(decks.has(id("other-file"))).toBe(false);
  expect(mocks.family.mock.calls.some(([{ file }]) => file === "other-file")).toBe(false);
});

test("REMOVE of a subscribed identity restarts the effect and lists the inventory again", async () => {
  const row = repertoire(0);
  await render([row]);
  expect(mocks.listPracticeDecks).toHaveBeenCalledTimes(1);
  await settle(id(row.key, 0), deck("ready"));
  expect(mounted).toEqual(new Set([id(row.key, 0)]));
  await act(async () => emit("REMOVE", { file: row.key, game: 0 }));
  expect(mocks.listPracticeDecks).toHaveBeenCalledTimes(2);
  expect(mounted).toEqual(new Set([id(row.key, 0)]));
});

test("anomaly-only chapter is subscribed and counted; a null game is not", async () => {
  const row = repertoire(0);
  mocks.listPracticeDecks.mockResolvedValue({
    decks: [],
    anomalies: [
      { kind: "DamagedDeck", leaf: "x", fileId: row.key, game: 1 },
      { kind: "DamagedDeck", leaf: "y", fileId: row.key, game: null },
    ],
  });
  await render([row]);
  await settle(id(row.key, 0), deck("ready"));
  await settle(id(row.key, 1), deck("ready", [position(Date.now() - 1000, 2)]));
  expect(latest.dueRows.map((entry) => entry.file.key)).toEqual([row.key]);
  expect(latest.dueRows[0].count).toBe(1);
  expect(latest.total).toBe(1);
  expect(decks.has(id(row.key, 1))).toBe(true);
  expect(mocks.family.mock.calls.some(([{ game }]) => game == null)).toBe(false);
});

test("pre-existing family params subscribe and count while inventory listing is still pending", async () => {
  const row = repertoire(0);
  mocks.params.set(id(row.key, 1), { file: row.key, game: 1 });
  mocks.listPracticeDecks.mockReturnValue(new Promise(() => {}));
  await render([row]);
  expect(decks.has(id(row.key, 1))).toBe(true);
  await settle(id(row.key, 0), deck("ready"));
  await settle(id(row.key, 1), deck("ready", [position(Date.now() - 1000, 2)]));
  expect(latest.dueRows.map((entry) => entry.file.key)).toEqual([row.key]);
  expect(latest.dueRows[0].count).toBe(1);
  expect(latest.total).toBe(1);
  expect(latest.incomplete).toBe(true);
  expect(latest.inventoryFailed).toBe(false);
});

test("pre-existing family params subscribe even when inventory listing rejects", async () => {
  const row = repertoire(0);
  mocks.params.set(id(row.key, 1), { file: row.key, game: 1 });
  mocks.listPracticeDecks.mockRejectedValue(new Error("inventory unavailable"));
  await render([row]);
  await settle(id(row.key, 0), deck("ready"));
  await settle(id(row.key, 1), deck("ready", [position(Date.now() - 1000, 2)]));
  expect(decks.has(id(row.key, 1))).toBe(true);
  expect(latest.dueRows.map((entry) => entry.file.key)).toEqual([row.key]);
  expect(latest.dueRows[0].count).toBe(1);
  expect(latest.inventoryFailed).toBe(true);
  expect(latest.incomplete).toBe(true);
});

test("unresolved inventory keeps game-0 due visible until later chapters settle", async () => {
  const row = repertoire(0);
  let resolveInventory!: (value: {
    decks: { fileId: string; game: number }[];
    anomalies: never[];
  }) => void;
  mocks.listPracticeDecks.mockReturnValue(
    new Promise((resolve) => {
      resolveInventory = resolve;
    }),
  );
  await render([row]);
  await settle(id(row.key, 0), deck("ready", [position(Date.now() - 1000, 2)]));
  expect(latest.dueRows.map((entry) => entry.file.key)).toEqual([row.key]);
  expect(latest.dueRows[0].count).toBe(1);
  expect(latest.incomplete).toBe(true);

  await act(async () => {
    resolveInventory({ decks: [{ fileId: row.key, game: 1 }], anomalies: [] });
  });
  expect(latest.dueRows.map((entry) => entry.file.key)).toEqual([row.key]);
  expect(latest.dueRows[0].count).toBe(1);
  expect(latest.incomplete).toBe(true);

  await settle(id(row.key, 1), deck("ready"));
  expect(latest.dueRows.map((entry) => entry.file.key)).toEqual([row.key]);
  expect(latest.dueRows[0].count).toBe(1);
  expect(latest.incomplete).toBe(false);
});

test("a failed sibling nulls the file count and keeps the row in Due", async () => {
  const row = repertoire(0);
  mocks.listPracticeDecks.mockResolvedValue({
    decks: [
      { fileId: row.key, game: 0 },
      { fileId: row.key, game: 1 },
    ],
    anomalies: [],
  });
  await render([row]);
  await settle(id(row.key, 0), deck("ready", [position(Date.now() - 1000, 2)]));
  await settle(id(row.key, 1), deck("read-failed"));
  expect(latest.dueRows.map((entry) => entry.file.key)).toEqual([row.key]);
  expect(latest.dueRows[0].failed).toBe(true);
  expect(latest.dueRows[0].count).toBeNull();
  expect(latest.incomplete).toBe(true);
});

test("REMOVE restart recounts due from the new inventory", async () => {
  const row = repertoire(0);
  mocks.listPracticeDecks.mockResolvedValue({
    decks: [0, 1, 2].map((game) => ({ fileId: row.key, game })),
    anomalies: [],
  });
  await render([row]);
  await settle(id(row.key, 0), deck("ready"));
  await settle(id(row.key, 1), deck("ready"));
  await settle(id(row.key, 2), deck("ready", [position(Date.now() - 1000, 2)]));
  expect(latest.total).toBe(1);

  mocks.listPracticeDecks.mockResolvedValue({
    decks: [
      { fileId: row.key, game: 0 },
      { fileId: row.key, game: 1 },
    ],
    anomalies: [],
  });
  mocks.params.delete(id(row.key, 2));
  await act(async () => emit("REMOVE", { file: row.key, game: 2 }));
  await settle(id(row.key, 0), deck("ready"));
  await settle(id(row.key, 1), deck("ready", [position(Date.now() - 1000, 2)]));
  expect(latest.total).toBe(1);
  expect(latest.rows[0].count).toBe(1);
  expect(mounted.has(id(row.key, 2))).toBe(false);
});

test("inventory failure sets inventoryFailed", async () => {
  const row = repertoire(0);
  mocks.listPracticeDecks.mockRejectedValue(new Error("inventory unavailable"));
  await render([row]);
  await settle(id(row.key, 0), deck("ready"));
  expect(latest.inventoryFailed).toBe(true);
});

test("inventory success leaves inventoryFailed false", async () => {
  const row = repertoire(0);
  mocks.listPracticeDecks.mockResolvedValue({ decks: [], anomalies: [] });
  await render([row]);
  await settle(id(row.key, 0), deck("ready"));
  expect(latest.inventoryFailed).toBe(false);
  expect(latest.incomplete).toBe(false);
});

test("concurrency bound holds across chapters of several repertoires", async () => {
  const rows = [repertoire(0), repertoire(1), repertoire(2)];
  mocks.listPracticeDecks.mockResolvedValue({
    decks: rows.flatMap((row) => [0, 1, 2].map((game) => ({ fileId: row.key, game }))),
    anomalies: [],
  });
  await render(rows);
  expect(pending.size).toBe(LIBRARY_DECK_CONCURRENCY);
  let steps = 0;
  while (pending.size > 0 || mounted.size < 9) {
    expect(pending.size).toBeLessThanOrEqual(LIBRARY_DECK_CONCURRENCY);
    const key = pending.values().next().value as string | undefined;
    expect(key).toBeDefined();
    await settle(key!, deck("ready", [position(Date.now() - 1000, 2)]));
    steps += 1;
    expect(steps).toBeLessThan(20);
  }
  expect(peak).toBe(LIBRARY_DECK_CONCURRENCY);
  expect(mounted.size).toBe(9);
  expect(latest.total).toBe(9);
  expect(latest.incomplete).toBe(false);
});
