import { WorkspaceTabScope } from "@/state/tabScope";
import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TreeStateProvider } from "@/components/common/TreeStateContext";
import { closeTreeStore } from "@/state/store/tree";
import { activeTabAtom, coverageMinGamesAtom, referenceDbAtom, tabsAtom } from "@/state/atoms";
import type { computeTreeCoverage } from "@/utils/repertoire";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { defaultTree } from "@/utils/treeReducer";
import { usePracticeStatistics } from "./usePracticeStatistics";

installMatchMediaStub();

const mocks = vi.hoisted(() => ({
  computeTreeCoverage: vi.fn(),
  notificationShow: vi.fn(),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
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
vi.mock("@/platform/tauri", async (original) => {
  const actual = await original<typeof import("@/platform/tauri")>();
  return {
    ...actual,
    tauri: { ...actual.tauri, collectionForDatabase: vi.fn(async () => null) },
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type CoverageResult = Awaited<ReturnType<typeof computeTreeCoverage>>;

const database = { id: { id: "reference" }, kind: "database" as const };

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  closeTreeStore("practice-statistics");
  closeTreeStore("practice-statistics-retry");
  closeTreeStore("practice-statistics-reference");
  localStorage.clear();
  sessionStorage.clear();
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

async function renderStatistics(id = "practice-statistics") {
  const store = createStore();
  store.set(tabsAtom, [
    { name: "Repertoire", value: "tab", type: "analysis", gameOrigin: { kind: "none" } },
  ]);
  store.set(activeTabAtom, "tab");
  const result = { current: undefined as unknown as ReturnType<typeof usePracticeStatistics> };
  function Harness() {
    result.current = usePracticeStatistics();
    return null;
  }
  await act(async () => {
    root.render(
      <MantineProvider>
        <Provider store={store}>
          <TreeStateProvider id={id} initial={defaultTree()}>
            <WorkspaceTabScope tabId="tab">
              <Harness />
            </WorkspaceTabScope>
          </TreeStateProvider>
        </Provider>
      </MantineProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => store.set(referenceDbAtom, database));
  return { result, store };
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

  const { result, store } = await renderStatistics();
  expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(1);
  expect(result.current.statisticsStatus).toBe("loading");

  await act(async () => store.set(coverageMinGamesAtom, 100));
  expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(2);
  expect(signals[0]?.aborted).toBe(true);
  expect(signals[1]?.aborted).toBe(false);

  const staleResult = makeCoverageResult("stale");
  await act(async () => {
    first.resolve(staleResult);
    await first.promise;
  });

  expect(result.current.statisticsStatus).toBe("loading");
  expect(result.current.statisticsResult).toBeNull();

  const freshResult = makeCoverageResult("fresh");
  await act(async () => {
    second.resolve(freshResult);
    await second.promise;
  });

  expect(result.current.statisticsStatus).toBe("success");
  expect(result.current.statisticsResult).toBe(freshResult);
});

test("retryStatistics re-runs coverage computation after failure", async () => {
  const recovered = makeCoverageResult("recovered");
  mocks.computeTreeCoverage
    .mockRejectedValueOnce(new Error("transient failure"))
    .mockResolvedValueOnce(recovered);

  const { result } = await renderStatistics("practice-statistics-retry");
  expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(1);
  expect(result.current.statisticsStatus).toBe("error");
  expect(result.current.statisticsResult).toBeNull();
  expect(mocks.notificationShow).toHaveBeenCalledTimes(1);

  await act(async () => {
    result.current.retryStatistics();
  });

  expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(2);
  expect(result.current.statisticsStatus).toBe("success");
  expect(result.current.statisticsResult).toBe(recovered);
});

test("a change of reference cancels the in-flight request", async () => {
  const first = createDeferred<CoverageResult>();
  const signals: (AbortSignal | undefined)[] = [];
  mocks.computeTreeCoverage.mockImplementation(
    (_root, _orient, _db, _min, _start, _moves, signal?: AbortSignal) => {
      signals.push(signal);
      return first.promise;
    },
  );
  const { store } = await renderStatistics("practice-statistics-reference");
  expect(signals[0]?.aborted).toBe(false);
  await act(async () => store.set(referenceDbAtom, { id: { id: "other" }, kind: "database" }));
  expect(signals[0]?.aborted).toBe(true);
  expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(2);
});
