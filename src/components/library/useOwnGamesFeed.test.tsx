import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CollectionDescriptor, NormalizedGame, QueryResponse } from "@/bindings";
import { query_games } from "@/utils/db";
import { useOwnGamesFeed } from "./useOwnGamesFeed";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({ currencies: vi.fn() }));
vi.mock("@/utils/db", () => ({ query_games: vi.fn() }));
vi.mock("@/state/linkedCollections", () => ({ useCollectionCurrencies: mocks.currencies }));
let root: Root;
let host: HTMLDivElement;
let latest: ReturnType<typeof useOwnGamesFeed>;
function collection(
  generation: string,
  status: CollectionDescriptor["status"] = "ready",
): CollectionDescriptor {
  return {
    id: "own",
    name: "Own",
    file: { kind: "fileWorkspace", id: { id: "file" } },
    database: { kind: "database", id: { id: "db" } },
    status,
    generation,
    omitted: 0,
    account: null,
    retiredDatabase: null,
    fetchSinceMs: null,
  };
}
function game(id: number): NormalizedGame {
  return {
    id,
    date: "2026.11.09",
    fen: "",
    event: "",
    event_id: 0,
    site: "",
    site_id: 0,
    white: "",
    white_id: 0,
    black: "",
    black_id: 0,
    result: "*",
    moves: "",
  };
}
function Consumer({
  collections,
  query,
  active,
}: {
  collections?: CollectionDescriptor[];
  query: string;
  active: boolean;
}) {
  latest = useOwnGamesFeed(collections, query, active);
  return null;
}
async function render(collections: CollectionDescriptor[] | undefined, query = "", active = true) {
  await act(async () =>
    root.render(<Consumer collections={collections} query={query} active={active} />),
  );
}
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(query_games).mockReset();
  mocks.currencies.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test("absent collections and inactive filters never query or subscribe to collections", async () => {
  await render(undefined);
  expect(latest.active).toBe(false);
  expect(query_games).not.toHaveBeenCalled();
  expect(mocks.currencies).toHaveBeenLastCalledWith([]);
  await render([collection("one")], "", false);
  expect(latest.active).toBe(false);
  expect(query_games).not.toHaveBeenCalled();
  expect(mocks.currencies).toHaveBeenLastCalledWith([]);
});

test("resets on generation and player-query changes, aborts superseded loads and discards their results", async () => {
  const pending: {
    signal: AbortSignal;
    resolve: (result: QueryResponse<NormalizedGame[]>) => void;
  }[] = [];
  vi.mocked(query_games).mockImplementation(
    (_database, _query, options) =>
      new Promise((resolve) => {
        pending.push({ signal: options!.signal!, resolve });
      }),
  );
  await render([collection("one")]);
  expect(pending).toHaveLength(1);
  await render([collection("two")]);
  expect(pending[0].signal.aborted).toBe(true);
  expect(pending).toHaveLength(2);
  await act(async () => pending[0].resolve({ data: [game(1)], count: null }));
  expect(latest.games).toEqual([]);
  await act(async () => pending[1].resolve({ data: [game(2)], count: null }));
  expect(latest.games.map((item) => item.game.id)).toEqual([2]);
  await render([collection("two")], "Felix Beck");
  expect(latest.games).toEqual([]);
  expect(pending[1].signal.aborted).toBe(true);
  expect(query_games).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ playerName: "Felix Beck" }),
    expect.anything(),
  );
  await act(async () => root.render(null));
  expect(pending[2].signal.aborted).toBe(true);
  await act(async () => pending[2].resolve({ data: [game(3)], count: null }));
});

test("a stale or unavailable descriptor reports incompleteness with no ready queries", async () => {
  await render([collection("one", "stale"), { ...collection("two", "unavailable"), id: "other" }]);
  expect(latest.games).toEqual([]);
  expect(latest.incompleteCount).toBe(2);
  expect(latest.loading).toBe(false);
  expect(query_games).not.toHaveBeenCalled();
});
