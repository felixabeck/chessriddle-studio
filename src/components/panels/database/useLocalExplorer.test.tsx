import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig, type Cache } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PositionStats } from "@/bindings";
import type { LocalOptions } from "@/utils/db";
import { useLocalExplorer } from "./useLocalExplorer";

const mocks = vi.hoisted(() => ({ searchPosition: vi.fn(), generation: 1, unavailable: false }));
vi.mock("@/platform/tauri", () => ({ tauri: { searchPosition: mocks.searchPosition } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/state/linkedCollections", () => ({
  useCollectionCurrency: () => ({
    collection: { generation: mocks.generation, status: mocks.unavailable ? "failed" : "ready" },
  }),
}));

const options: LocalOptions = {
  path: { id: { id: "database" }, kind: "database" },
  fen: "start",
  type: "exact",
  player: 42,
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
  return <span>{JSON.stringify({ ...result, error: result.error?.message })}</span>;
}
let root: Root;
let container: HTMLDivElement;
let cache: Cache;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => {
  mocks.searchPosition.mockReset().mockResolvedValue([[], []]);
  mocks.generation = 1;
  mocks.unavailable = false;
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
    fresh.resolve([[{ move: "fresh", white: 1, draw: 0, black: 0, unknown: 0 }], []]),
  );
  await act(async () =>
    old.resolve([[{ move: "stale", white: 999, draw: 0, black: 0, unknown: 0 }], []]),
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
    expect.objectContaining({ player1: 42, include_unknown_results: true, sample_order: "date" }),
    "progress",
    { signal: expect.any(AbortSignal) },
  );
  const signal = mocks.searchPosition.mock.calls[0][3].signal;
  await render(false, true);
  expect(signal.aborted).toBe(false);
  await act(async () =>
    pending.resolve([
      [
        { move: "e4", white: 1, draw: 0, black: 0, unknown: 0 },
        { move: "d4", white: 0, draw: 0, black: 0, unknown: 5 },
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
  await render(true, false, "start", false);
  expect(mocks.searchPosition).not.toHaveBeenCalled();
  await render(true, false);
  expect(mocks.searchPosition).toHaveBeenCalledOnce();
  mocks.generation = 2;
  await render(true, false);
  expect(mocks.searchPosition).toHaveBeenCalledTimes(2);
  mocks.unavailable = true;
  await render(true, false);
  expect(mocks.searchPosition).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain('"loading":false');
});
test("native errors terminate loading and remain available to the consumer", async () => {
  mocks.searchPosition.mockRejectedValue(new Error("Search failed"));
  await render(true, false);
  expect(container.textContent).toContain('"loading":false');
  expect(container.textContent).toContain('"error":"Search failed"');
});

test("sample options distinguish cache entries and the last subscriber cancels work", async () => {
  const pending = deferred<[PositionStats[], []]>();
  mocks.searchPosition.mockReturnValue(pending.promise);
  await render(true, false);
  const originalSignal = mocks.searchPosition.mock.calls[0][3].signal;
  await render(true, false, "start", true, "elo");
  expect(mocks.searchPosition).toHaveBeenCalledTimes(2);
  expect(originalSignal.aborted).toBe(true);
  expect(mocks.searchPosition.mock.lastCall?.[1].sample_order).toBe("elo");
  const finalSignal = mocks.searchPosition.mock.lastCall?.[3].signal;
  await render(false, false);
  expect(finalSignal.aborted).toBe(true);
  await act(async () => pending.resolve([[], []]));
});
