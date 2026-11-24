import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DatabaseHandle } from "@/bindings";
import { createTreeStore } from "@/state/store/tree";
import type { computeTreeCoverage } from "@/utils/repertoire";
import { defaultTree } from "@/utils/treeReducer";
import { useRepertoireCoverage, type UseRepertoireCoverageParams } from "./useRepertoireCoverage";

const mocks = vi.hoisted(() => ({
  computeTreeCoverage: vi.fn(),
  notificationShow: vi.fn(),
}));

vi.mock("@mantine/notifications", () => ({
  notifications: { show: mocks.notificationShow },
}));
vi.mock("@/utils/repertoire", async () => {
  const actual = await vi.importActual<typeof import("@/utils/repertoire")>("@/utils/repertoire");
  return {
    ...actual,
    computeTreeCoverage: mocks.computeTreeCoverage,
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type CoverageResult = Awaited<ReturnType<typeof computeTreeCoverage>>;

const database: DatabaseHandle = { id: { id: "reference" }, kind: "database" };

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.resetAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeCoverageResult(label: string): CoverageResult {
  return {
    coverageMap: new Map([[label, 1]]),
    gamesMap: new Map([[label, 100]]),
    missingGamesMap: new Map(),
    dbMovesMap: new Map([[label, { moves: [], total: 100 }]]),
  };
}

function baseParams(
  overrides: Partial<UseRepertoireCoverageParams> = {},
): UseRepertoireCoverageParams {
  const tree = defaultTree();
  return {
    store: createTreeStore(undefined, tree),
    root: tree.root,
    orientation: "white",
    referenceDb: database,
    selectedReferenceKey: "db:reference",
    currencyGeneration: undefined,
    currencyStatus: undefined,
    currencyError: undefined,
    currencyPending: false,
    minGames: 50,
    startPath: [],
    startStateMoves: new Map(),
    replaceMoves: vi.fn(),
    errorTitle: "Common.Error",
    ...overrides,
  };
}

async function renderUseRepertoireCoverage(initialParams: UseRepertoireCoverageParams) {
  const result = { current: undefined as unknown as ReturnType<typeof useRepertoireCoverage> };
  function Harness({ params }: { params: UseRepertoireCoverageParams }) {
    result.current = useRepertoireCoverage(params);
    return null;
  }
  await act(async () => {
    root.render(<Harness params={initialParams} />);
  });
  return {
    result,
    rerender: async (nextParams: UseRepertoireCoverageParams) => {
      await act(async () => {
        root.render(<Harness params={nextParams} />);
      });
    },
  };
}

test("an outcome from a superseded input is discarded", async () => {
  const first = createDeferred<CoverageResult>();
  const second = createDeferred<CoverageResult>();
  const signals: (AbortSignal | undefined)[] = [];
  mocks.computeTreeCoverage
    .mockImplementationOnce((_root, _orient, _db, _min, _start, _moves, signal?: AbortSignal) => {
      signals.push(signal);
      return first.promise;
    })
    .mockImplementationOnce((_root, _orient, _db, _min, _start, _moves, signal?: AbortSignal) => {
      signals.push(signal);
      return second.promise;
    });

  const replaceMoves = vi.fn();
  const initial = baseParams({ replaceMoves, minGames: 50 });
  const { result, rerender } = await renderUseRepertoireCoverage(initial);
  expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(1);
  expect(result.current.coverageStatus).toBe("loading");

  await rerender({ ...initial, minGames: 100 });
  expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(2);
  expect(signals[0]?.aborted).toBe(true);
  expect(signals[1]?.aborted).toBe(false);

  const staleResult = makeCoverageResult("stale");
  await act(async () => {
    first.resolve(staleResult);
    await first.promise;
  });

  expect(result.current.coverageStatus).toBe("loading");
  expect(result.current.coverageResult).toBeNull();
  expect(replaceMoves).not.toHaveBeenCalled();

  const freshResult = makeCoverageResult("fresh");
  await act(async () => {
    second.resolve(freshResult);
    await second.promise;
  });

  expect(result.current.coverageStatus).toBe("success");
  expect(result.current.coverageResult).toBe(freshResult);
  expect(replaceMoves).toHaveBeenCalledExactlyOnceWith(freshResult.dbMovesMap);
});

test("retryCoverage re-runs coverage computation after failure", async () => {
  const recovered = makeCoverageResult("recovered");
  const replaceMoves = vi.fn();
  mocks.computeTreeCoverage
    .mockRejectedValueOnce(new Error("transient failure"))
    .mockResolvedValueOnce(recovered);

  const { result } = await renderUseRepertoireCoverage(baseParams({ replaceMoves }));
  expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(1);
  expect(result.current.coverageStatus).toBe("error");
  expect(result.current.coverageResult).toBeNull();
  expect(mocks.notificationShow).toHaveBeenCalledTimes(1);

  await act(async () => {
    result.current.retryCoverage();
  });

  expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(2);
  expect(result.current.coverageStatus).toBe("success");
  expect(result.current.coverageResult).toBe(recovered);
  expect(replaceMoves).toHaveBeenCalledExactlyOnceWith(recovered.dbMovesMap);
});
