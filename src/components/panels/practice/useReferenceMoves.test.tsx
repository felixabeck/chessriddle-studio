import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DatabaseHandle } from "@/bindings";
import { getBoardState } from "@/utils/treeReducer";
import {
  useReferenceMoves,
  type DbMovesEntry,
  type UseReferenceMovesParams,
} from "./useReferenceMoves";

const mocks = vi.hoisted(() => ({
  fetchPositionMoves: vi.fn(),
  notificationShow: vi.fn(),
}));

vi.mock("@mantine/notifications", () => ({
  notifications: { show: mocks.notificationShow },
}));
vi.mock("@/utils/repertoire", async () => {
  const actual = await vi.importActual<typeof import("@/utils/repertoire")>("@/utils/repertoire");
  return {
    ...actual,
    fetchPositionMoves: mocks.fetchPositionMoves,
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const startBoardFen = getBoardState(startFen);
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

function baseParams(overrides: Partial<UseReferenceMovesParams> = {}): UseReferenceMovesParams {
  return {
    currentFen: startFen,
    referenceDb: database,
    selectedReferenceKey: "db:reference",
    referenceKey: "db:reference",
    currencyGeneration: undefined,
    currencyStatus: undefined,
    currencyError: undefined,
    currencyPending: false,
    errorTitle: "Common.Error",
    ...overrides,
  };
}

async function renderUseReferenceMoves(initialParams: UseReferenceMovesParams) {
  const result = { current: undefined as unknown as ReturnType<typeof useReferenceMoves> };
  function Harness({ params }: { params: UseReferenceMovesParams }) {
    result.current = useReferenceMoves(params);
    return null;
  }
  await act(async () => {
    root.render(<Harness params={initialParams} />);
  });
  return {
    result,
    rerender: async (nextParams: UseReferenceMovesParams) => {
      await act(async () => {
        root.render(<Harness params={nextParams} />);
      });
    },
  };
}

async function renderAbortedReferenceFetch() {
  const requests: {
    deferred: ReturnType<typeof createDeferred<DbMovesEntry>>;
    signal?: AbortSignal;
  }[] = [];
  mocks.fetchPositionMoves.mockImplementation((_db, _fen, signal?: AbortSignal) => {
    const deferred = createDeferred<DbMovesEntry>();
    requests.push({ deferred, signal });
    return deferred.promise;
  });

  const { result, rerender } = await renderUseReferenceMoves(baseParams());
  const active = requests.at(-1)!;
  expect(active.signal?.aborted).toBe(false);

  await rerender(
    baseParams({
      referenceDb: null,
      selectedReferenceKey: null,
      referenceKey: null,
    }),
  );
  expect(active.signal?.aborted).toBe(true);

  return { result, active };
}

test("a fetch whose controller was aborted by a reference change never writes the map", async () => {
  const { result, active } = await renderAbortedReferenceFetch();

  await act(async () => {
    active.deferred.resolve({
      moves: [{ move: "e4", white: 50, draw: 30, black: 20 }],
      total: 100,
    });
    await active.deferred.promise;
  });

  expect(result.current.dbMovesMap.has(startBoardFen)).toBe(false);
  expect(result.current.dbMovesMap.size).toBe(0);
});

test("a late fetch does not overwrite an entry coverage already filled", async () => {
  const requests: ReturnType<typeof createDeferred<DbMovesEntry>>[] = [];
  mocks.fetchPositionMoves.mockImplementation(() => {
    const deferred = createDeferred<DbMovesEntry>();
    requests.push(deferred);
    return deferred.promise;
  });

  const { result } = await renderUseReferenceMoves(baseParams());
  const active = requests.at(-1)!;

  const coverageEntry: DbMovesEntry = {
    moves: [{ move: "d4", white: 400, draw: 300, black: 300 }],
    total: 1000,
  };
  const lateFetchEntry: DbMovesEntry = {
    moves: [{ move: "e4", white: 1, draw: 0, black: 0 }],
    total: 1,
  };

  await act(async () => {
    // Queue coverage's map replacement and resolve the in-flight position fetch in the same batch,
    // before React commits the new map and aborts the fetch controller.
    result.current.replaceMoves(new Map([[startBoardFen, coverageEntry]]));
    active.resolve(lateFetchEntry);
    await Promise.resolve();
  });

  expect(result.current.dbMovesMap.get(startBoardFen)).toEqual(coverageEntry);
});

test("a change of reference identity clears a seeded map", async () => {
  mocks.fetchPositionMoves.mockReturnValue(new Promise(() => {}));
  const { result, rerender } = await renderUseReferenceMoves(baseParams());
  const coverageEntry: DbMovesEntry = {
    moves: [{ move: "d4", white: 1, draw: 0, black: 0 }],
    total: 1,
  };
  await act(async () => {
    result.current.replaceMoves(new Map([[startBoardFen, coverageEntry]]));
  });
  expect(result.current.dbMovesMap.get(startBoardFen)).toEqual(coverageEntry);
  await rerender(
    baseParams({
      selectedReferenceKey: "db:other",
      referenceKey: "db:other",
    }),
  );
  expect(result.current.dbMovesMap.size).toBe(0);
});

test("a fetch that rejects after its controller was aborted by a reference change does not notify", async () => {
  const { active } = await renderAbortedReferenceFetch();

  await act(async () => {
    active.deferred.reject(new Error("database read failed"));
    await active.deferred.promise.catch(() => {});
  });

  expect(mocks.notificationShow).not.toHaveBeenCalled();
});
