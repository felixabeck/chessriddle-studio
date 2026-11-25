import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig, type Cache } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { NormalizedGame, PositionStats } from "@/bindings";
import { normalizeError } from "@/platform/errors";
import { recordDatabaseWrite } from "@/platform/databaseWrites";
import { databaseHandleKey, type LocalOptions } from "@/utils/db";
import { MAX_SAMPLE_GAMES, mergeLocalOpenings, useLocalExplorer } from "./useLocalExplorer";

const mocks = vi.hoisted(() => ({
  searchPosition: vi.fn(),
  generation: "1" as string | null,
  unavailable: false,
  linked: true,
  pending: false,
}));
vi.mock("@/platform/tauri", () => ({ tauri: { searchPosition: mocks.searchPosition } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  default: { t: (key: string) => key },
}));
vi.mock("@/state/linkedCollections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/linkedCollections")>();
  const { useDatabaseWriteRevision } = await import("@/platform/databaseWrites");
  return {
    ...actual,
    useDatabaseContentRevision: (file: import("@/bindings").DatabaseHandle | null | undefined) => {
      const writes = useDatabaseWriteRevision(file);
      const generation = mocks.linked ? mocks.generation : null;
      return {
        revision: mocks.pending ? null : ([generation, writes] as const),
        unavailable: mocks.unavailable,
      };
    },
  };
});

const options: LocalOptions = {
  path: { id: { id: "database" }, kind: "database" },
  fen: "start",
  type: "exact",
  player: 42,
  player_database: databaseHandleKey({ id: { id: "database" }, kind: "database" }),
  color: "white",
  result: "any",
  include_unknown_results: true,
  sample_order: "date",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function Consumer({
  fen = "start",
  enabled = true,
  sampleOrder = "date",
}: {
  fen?: string;
  enabled?: boolean;
  sampleOrder?: LocalOptions["sample_order"];
}) {
  const result = useLocalExplorer(
    { ...options, fen, sample_order: sampleOrder },
    enabled,
    "progress",
  );
  return <span>{JSON.stringify(result)}</span>;
}
let root: Root;
let container: HTMLDivElement;
let cache: Cache;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => {
  mocks.searchPosition.mockReset().mockResolvedValue([[], []]);
  mocks.generation = "1";
  mocks.unavailable = false;
  mocks.linked = true;
  mocks.pending = false;
  cache = new Map();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(
  first: boolean,
  second: boolean,
  fen = "start",
  enabled = true,
  sampleOrder?: LocalOptions["sample_order"],
) {
  await act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false }}>
        {first && <Consumer key="first" fen={fen} enabled={enabled} sampleOrder={sampleOrder} />}
        {second && <Consumer key="second" fen={fen} enabled={enabled} sampleOrder={sampleOrder} />}
      </SWRConfig>,
    ),
  );
}
test("replacement aborts the old request and discards its late result", async () => {
  const old = deferred<[PositionStats[], []]>();
  const fresh = deferred<[PositionStats[], []]>();
  mocks.searchPosition.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  await render(true, false);
  const signal = mocks.searchPosition.mock.calls[0][3].signal;
  await render(true, false, "next");
  expect(signal.aborted).toBe(true);
  await act(async () =>
    fresh.resolve([
      [
        {
          move: "fresh",
          white: 1,
          draw: 0,
          black: 0,
          unknown: 0,
          last_played: null,
          year_counts: [],
          recent: [],
        },
      ],
      [],
    ]),
  );
  await act(async () =>
    old.resolve([
      [
        {
          move: "stale",
          white: 999,
          draw: 0,
          black: 0,
          unknown: 0,
          last_played: null,
          year_counts: [],
          recent: [],
        },
      ],
      [],
    ]),
  );
  expect(container.textContent).toContain("fresh");
  expect(container.textContent).not.toContain("stale");
});
test("a surviving subscriber retains the shared native request and its sorted unknown counts", async () => {
  const pending = deferred<[PositionStats[], []]>();
  mocks.searchPosition.mockReturnValue(pending.promise);
  await render(true, true);
  expect(mocks.searchPosition).toHaveBeenCalledExactlyOnceWith(
    options.path,
    expect.objectContaining({ player1: 42, includeUnknownResults: true, sampleOrder: "date" }),
    "progress",
    { signal: expect.any(AbortSignal) },
  );
  const signal = mocks.searchPosition.mock.calls[0][3].signal;
  await render(false, true);
  expect(signal.aborted).toBe(false);
  await act(async () =>
    pending.resolve([
      [
        {
          move: "e4",
          white: 1,
          draw: 0,
          black: 0,
          unknown: 0,
          last_played: null,
          year_counts: [],
          recent: [],
        },
        {
          move: "d4",
          white: 0,
          draw: 0,
          black: 0,
          unknown: 5,
          last_played: null,
          year_counts: [],
          recent: [],
        },
      ],
      [],
    ]),
  );
  const result = JSON.parse(container.textContent!);
  expect(result.openings.map((row: PositionStats) => row.move)).toEqual(["d4", "e4"]);
  expect(result.openings[0].unknown).toBe(5);
  expect(result.progressId).toBe("progress");
  expect(result.loading).toBe(false);
  expect(mocks.searchPosition).toHaveBeenCalledOnce();
});
test("linked generation changes the key and disabled or unavailable searches do not run", async () => {
  mocks.pending = true;
  await render(true, false);
  expect(mocks.searchPosition).not.toHaveBeenCalled();
  expect(JSON.parse(container.textContent!).loading).toBe(true);
  mocks.pending = false;
  await render(true, false, "start", false);
  expect(mocks.searchPosition).not.toHaveBeenCalled();
  await render(true, false);
  expect(mocks.searchPosition).toHaveBeenCalledOnce();
  mocks.generation = "2";
  await render(true, false);
  expect(mocks.searchPosition).toHaveBeenCalledTimes(2);
  mocks.unavailable = true;
  await render(true, false);
  expect(mocks.searchPosition).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain('"loading":false');
  expect(JSON.parse(container.textContent!).error).toBe("Collections.Unavailable");
});
test.each([
  [new Error("Search failed"), "Databases.LoadError.Title"],
  [new Error("Cancellation"), undefined],
  [
    normalizeError({
      tag: "backend-error",
      category: "io",
      message: "private database diagnostic",
      rootFailure: "permission",
    }),
    "Databases.LoadError.RootPermission",
  ],
])("native error %s terminates loading with safe guidance", async (error, expected) => {
  mocks.searchPosition.mockRejectedValue(error);
  await render(true, false);
  const result = JSON.parse(container.textContent!);
  expect(result.loading).toBe(false);
  expect(result.error).toBe(expected);
});

test("sample options distinguish cache entries and the last subscriber cancels work", async () => {
  const pending = deferred<[PositionStats[], []]>();
  mocks.searchPosition.mockReturnValue(pending.promise);
  await render(true, false);
  const originalSignal = mocks.searchPosition.mock.calls[0][3].signal;
  await render(true, false, "start", true, "elo");
  expect(mocks.searchPosition).toHaveBeenCalledTimes(2);
  expect(originalSignal.aborted).toBe(true);
  expect(mocks.searchPosition.mock.lastCall?.[1].sampleOrder).toBe("elo");
  const finalSignal = mocks.searchPosition.mock.lastCall?.[3].signal;
  await render(false, false);
  expect(finalSignal.aborted).toBe(true);
  await act(async () => pending.resolve([[], []]));
});

function opening(white: number): PositionStats {
  return {
    move: "e4",
    white,
    draw: 0,
    black: 0,
    unknown: 0,
    last_played: null,
    year_counts: [],
    recent: [],
  };
}

test("a write to a plain database busts the shared explorer cache on remount", async () => {
  mocks.linked = false;
  mocks.searchPosition
    .mockResolvedValueOnce([[opening(1)], []])
    .mockResolvedValueOnce([[opening(2)], []]);
  await render(true, false);
  expect(JSON.parse(container.textContent!).openings[0].white).toBe(1);
  await render(false, false);
  await act(async () => recordDatabaseWrite([options.path]));
  await render(true, false);
  expect(JSON.parse(container.textContent!).openings[0].white).toBe(2);
  expect(mocks.searchPosition).toHaveBeenCalledTimes(2);
});

test("remounting a plain database without a write keeps the cached explorer result", async () => {
  mocks.linked = false;
  mocks.searchPosition
    .mockResolvedValueOnce([[opening(1)], []])
    .mockResolvedValueOnce([[opening(2)], []]);
  await render(true, false);
  expect(JSON.parse(container.textContent!).openings[0].white).toBe(1);
  await render(false, false);
  await render(true, false);
  expect(JSON.parse(container.textContent!).openings[0].white).toBe(1);
  expect(mocks.searchPosition).toHaveBeenCalledOnce();
});

const stats = (move: string, overrides: Partial<PositionStats> = {}): PositionStats => ({
  move,
  white: 0,
  draw: 0,
  black: 0,
  unknown: 0,
  last_played: null,
  year_counts: [],
  recent: [],
  ...overrides,
});
const sample = (id: number, date: string | null) => ({ id, date }) as unknown as NormalizedGame;

test("merging sums moves across sources and orders them by total games", () => {
  const merged = mergeLocalOpenings([
    {
      source: "a",
      openings: [
        stats("e4", {
          white: 3,
          draw: 1,
          last_played: "2025.03.01",
          year_counts: [
            { year: 2024, count: 1 },
            { year: 2025, count: 3 },
          ],
        }),
        stats("d4", {
          black: 1,
          last_played: "2026.01.01",
          year_counts: [{ year: 2026, count: 1 }],
        }),
      ],
      games: [],
    },
    {
      source: "b",
      openings: [
        stats("d4", {
          white: 4,
          unknown: 2,
          last_played: null,
          year_counts: [{ year: 2023, count: 6 }],
        }),
        stats("e4", {
          black: 2,
          last_played: "2026.02.02",
          year_counts: [{ year: 2025, count: 2 }],
        }),
      ],
      games: [],
    },
  ]);
  expect(merged.openings).toEqual([
    stats("d4", {
      white: 4,
      black: 1,
      unknown: 2,
      last_played: "2026.01.01",
      year_counts: [
        { year: 2023, count: 6 },
        { year: 2026, count: 1 },
      ],
    }),
    stats("e4", {
      white: 3,
      draw: 1,
      black: 2,
      last_played: "2026.02.02",
      year_counts: [
        { year: 2024, count: 1 },
        { year: 2025, count: 5 },
      ],
    }),
  ]);
});

test("merging never mutates the rows of its sources", () => {
  const row = stats("e4", { white: 1, year_counts: [{ year: 2025, count: 1 }] });
  mergeLocalOpenings([
    { source: "a", openings: [row], games: [] },
    {
      source: "b",
      openings: [stats("e4", { white: 2, year_counts: [{ year: 2025, count: 2 }] })],
      games: [],
    },
  ]);
  expect(row).toEqual(stats("e4", { white: 1, year_counts: [{ year: 2025, count: 1 }] }));
});

test("merged samples are newest first with unknown dates last and keep their source", () => {
  const merged = mergeLocalOpenings([
    {
      source: "a",
      openings: [],
      games: [sample(1, "2025.05.01"), sample(2, "????.??.??"), sample(3, null)],
    },
    {
      source: "b",
      openings: [],
      games: [sample(1, "2026.01.01"), sample(4, "2025.??.??"), sample(5, "2025.05.02")],
    },
  ]);
  expect(merged.games.map(({ source, game }) => `${source}:${game.id}`)).toEqual([
    "b:1",
    "b:5",
    "a:1",
    "b:4",
    "a:2",
    "a:3",
  ]);
});

test("merged dates are padded before they are compared and a partial date never beats a full one", () => {
  const merged = mergeLocalOpenings([
    {
      source: "a",
      openings: [stats("e4", { white: 1, last_played: "2025.05.01" })],
      games: [sample(1, "2026.9.30"), sample(2, "2026.10.01")],
    },
    {
      source: "b",
      openings: [stats("e4", { white: 1, last_played: "2025.??.??" })],
      games: [sample(3, "2026.12.1")],
    },
  ]);
  expect(merged.openings[0].last_played).toBe("2025.05.01");
  expect(merged.games.map(({ game }) => game.id)).toEqual([3, 2, 1]);
});

test("merged samples keep the native cap and one source keeps its native order", () => {
  const many = (source: string, year: number) => ({
    source,
    openings: [],
    games: Array.from({ length: MAX_SAMPLE_GAMES }, (_, id) => sample(id, `${year}.01.01`)),
  });
  const merged = mergeLocalOpenings([many("old", 2020), many("new", 2026)]);
  expect(merged.games).toHaveLength(MAX_SAMPLE_GAMES);
  expect(new Set(merged.games.map(({ source }) => source))).toEqual(new Set(["new"]));

  const single = {
    source: "only",
    openings: [stats("e4", { white: 1 })],
    games: [sample(2, null), sample(1, "2026.01.01")],
  };
  const alone = mergeLocalOpenings([single]);
  expect(alone.openings).toBe(single.openings);
  expect(alone.games.map(({ game }) => game.id)).toEqual([2, 1]);
  expect(mergeLocalOpenings([])).toEqual({ openings: [], games: [] });
});
