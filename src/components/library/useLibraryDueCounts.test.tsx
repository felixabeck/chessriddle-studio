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

const mocks = vi.hoisted(() => ({ family: vi.fn() }));
vi.mock("@/state/atoms", () => ({ deckAtomFamily: mocks.family }));

let root: Root;
let host: HTMLDivElement;
let store: ReturnType<typeof createStore>;
let latest: ReturnType<typeof useLibraryDueCounts>;
let decks: Map<string, PrimitiveAtom<PracticeDeckValue>>;
let mounted: Set<string>;
let pending: Set<string>;
let peak: number;

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
  mocks.family.mockReset();
  mocks.family.mockImplementation(({ file, game }: { file: string; game: number }) => {
    expect(game).toBe(0);
    let value = decks.get(file);
    if (!value) {
      value = atom(deck("loading"));
      value.onMount = () => {
        mounted.add(file);
        pending.add(file);
        peak = Math.max(peak, pending.size);
        return () => {
          mounted.delete(file);
          pending.delete(file);
        };
      };
      decks.set(file, value);
    }
    return value;
  });
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
    expect(decks.has(rows[index].key)).toBe(true);
    await settle(
      rows[index].key,
      deck("ready", [position(Date.now() - 1000, 0), position(Date.now() - 1000, 2)]),
    );
    expect(pending.size).toBeLessThanOrEqual(4);
  }
  expect(peak).toBe(4);
  expect(mounted.size).toBe(12);
  expect(latest.total).toBe(12);
  expect(latest.rows[11].count).toBe(1);
  expect(latest.incomplete).toBe(false);
  await act(async () => store.set(decks.get(rows[11].key)!, deck()));
  expect(latest.total).toBe(11);
  await render([]);
  expect(mounted.size).toBe(0);
});

test("includes an unloadable deck in Due and marks the total incomplete", async () => {
  const row = repertoire(0);
  await render([row]);
  await settle(row.key, deck("read-failed"));
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
  await settle(first.key, deck("ready", [position(earliest, 2)]));
  await settle(second.key, deck("ready", [position(earliest + 1000, 2)]));
  expect(latest.total).toBe(0);
  expect(latest.nextDue?.getTime()).toBe(earliest);
  await act(async () => vi.advanceTimersByTime(1002));
  expect(latest.total).toBe(1);
  expect(latest.nextDue?.getTime()).toBe(earliest + 1000);
});

test("unmount releases live subscriptions and prevents queued hydrations and old deliveries", async () => {
  await render(Array.from({ length: 12 }, (_, index) => repertoire(index)));
  const old = decks.get("file-0")!;
  await render([repertoire(99)]);
  expect(mounted).toEqual(new Set(["file-99"]));
  await act(async () => store.set(old, deck("ready", [position(Date.now() - 1, 2)])));
  expect(latest.rows.map((row) => row.file.key)).toEqual(["file-99"]);
  await act(async () => root.render(null));
  expect(mounted.size).toBe(0);
  expect(decks.has("file-4")).toBe(false);
});

test("pure due projection excludes never-trained positions", () => {
  const row = repertoire(0);
  expect(
    projectLibraryDueCounts(
      [row],
      new Map([[row.key, deck("ready", [position(Date.now() - 1, 0)])]]),
    ).total,
  ).toBe(0);
});
