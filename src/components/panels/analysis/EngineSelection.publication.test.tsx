import { MantineProvider } from "@mantine/core";
import { getDefaultStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { INITIAL_FEN } from "chessops/fen";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BestMovesPayload } from "@/bindings";
import EvalListener from "@/components/boards/EvalListener";
import {
  activeTabAtom,
  engineMovesFamily,
  enginesAtom,
  tabEngineSettingsFamily,
  tabsAtom,
  disposeTabAtoms,
} from "@/state/atoms";
import { resetEngineOwnerCoordinatorForTests } from "@/state/engineOwnerStorage";
import { WorkspaceTabScope } from "@/state/tabScope";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import EngineSelection from "./EngineSelection";

const mocks = vi.hoisted(() => ({
  reconcile: vi.fn(),
  prepare: vi.fn(),
  search: vi.fn(),
  release: vi.fn(),
  stop: vi.fn(),
  report: vi.fn(),
  listeners: new Set<(event: { payload: BestMovesPayload }) => void>(),
  moves: [] as string[],
  t: (key: string) => key,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }), Trans: () => null }));
vi.mock("@tanstack/react-router", () => ({ Link: () => null }));
vi.mock("@/state/persistError", () => ({ reportPersistError: mocks.report }));
vi.mock("@/platform/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/tauri")>();
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      reconcileEngineAttachments: mocks.reconcile,
      prepareEngineSearch: mocks.prepare,
      getBestMoves: mocks.search,
      releaseEngineSearch: mocks.release,
      stopEngine: mocks.stop,
    },
    tauriSubscriptions: {
      ...actual.tauriSubscriptions,
      bestMoves: async (listener: (event: { payload: BestMovesPayload }) => void) => {
        mocks.listeners.add(listener);
        return () => {
          mocks.listeners.delete(listener);
        };
      },
    },
  };
});
vi.mock("@/utils/chess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/chess")>()),
  getVariationLine: () => mocks.moves,
}));
vi.mock("zustand", () => ({
  useStore: (_store: unknown, selector: (state: unknown) => unknown) =>
    selector({ root: { fen: INITIAL_FEN }, position: [], setEngineScore: () => undefined }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();
const store = getDefaultStore();
const engine = {
  type: "local" as const,
  id: "unload-engine",
  name: "Twin name",
  version: "18",
  filename: "stockfish",
  handle: { id: { id: "same-path" }, kind: "engine" as const },
  loaded: true,
  legacyAssessment: null,
  go: { t: "Depth" as const, c: 10 },
};
const tab = "publication-listener";
let host: HTMLDivElement;
let root: Root;
let pendingRefusal: ((error: Error) => void) | undefined;
const lines = [
  {
    depth: 20,
    multipv: 1,
    score: { value: { type: "cp" as const, value: 30 }, wdl: null },
    nodes: 1n,
    nps: 1n,
    uciMoves: ["e2e4"],
    sanMoves: ["e4"],
  },
];

beforeEach(async () => {
  localStorage.clear();
  resetEngineOwnerCoordinatorForTests();
  vi.clearAllMocks();
  mocks.listeners.clear();
  mocks.reconcile.mockReset().mockResolvedValue(undefined);
  mocks.prepare.mockResolvedValue("owned-generation");
  mocks.search.mockImplementation(() => new Promise(() => undefined));
  mocks.release.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(true);
  if (!(await store.set(enginesAtom, [engine])).saved)
    throw new Error("listener fixture seed refused");
  store.set(tabsAtom, [
    { value: tab, name: "Analysis", type: "analysis", gameOrigin: { kind: "none" } },
  ]);
  store.set(activeTabAtom, tab);
  store.set(tabEngineSettingsFamily({ tab, engineId: engine.id }), {
    enabled: true,
    synced: true,
    settings: [],
    go: { t: "Depth", c: 10 },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <WorkspaceTabScope tabId={tab}>
          <EngineSelection />
          <EvalListener />
        </WorkspaceTabScope>
      </MantineProvider>,
    ),
  );
  await vi.waitFor(() => {
    if (mocks.search.mock.calls.length !== 1)
      throw new Error("listener fixture search not dispatched");
  });
});
afterEach(async () => {
  pendingRefusal?.(new Error("test cleanup"));
  pendingRefusal = undefined;
  await act(async () => root.unmount());
  host.remove();
  disposeTabAtoms(tab);
  disposeTabAtoms("unsynced-listener");
});

async function broadcast(bestLines = lines, generation = "owned-generation") {
  const payload: BestMovesPayload = {
    engine: engine.id,
    tab,
    fen: INITIAL_FEN,
    moves: [],
    generation,
    bestLines,
    progress: 50,
  };
  await act(async () => {
    for (const listener of mocks.listeners) listener({ payload });
  });
}
function toggle() {
  host
    .querySelector<HTMLInputElement>('input[type="checkbox"]')!
    .closest('[class*="Paper"]')!
    .dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

test.each(["saved", "saved-unsynchronized"])(
  "pending/refused unload keeps current generation live, %s unload releases that exact owner",
  async (exit) => {
    let reject!: (error: Error) => void;
    mocks.reconcile.mockImplementationOnce(
      () =>
        new Promise((_resolve, refuse) => {
          reject = refuse;
          pendingRefusal = refuse;
        }),
    );
    await act(async () => toggle());
    await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
    expect(store.get(enginesAtom)?.[0].loaded).toBe(true);
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    await broadcast();
    expect([...store.get(engineMovesFamily({ tab, engine: engine.id })).values()]).toContainEqual(
      lines,
    );
    await act(async () => {
      reject(new Error("prepare refused"));
    });
    await vi.waitFor(() => expect(mocks.report).toHaveBeenCalledOnce());
    const afterRefusal = [{ ...lines[0], depth: 23, sanMoves: ["d4"], uciMoves: ["d2d4"] }];
    await broadcast(afterRefusal);
    expect([...store.get(engineMovesFamily({ tab, engine: engine.id })).values()]).toEqual([
      afterRefusal,
    ]);
    expect(store.get(enginesAtom)?.[0].loaded).toBe(true);
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    if (exit === "saved-unsynchronized")
      mocks.reconcile
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("reconcile refused"));
    await act(async () => toggle());
    await vi.waitFor(() => expect(store.get(enginesAtom)?.[0].loaded).toBe(false));
    await vi.waitFor(() =>
      expect(mocks.release).toHaveBeenCalledExactlyOnceWith(engine.id, tab, "owned-generation"),
    );
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.search).toHaveBeenCalledOnce();
  },
);

test("panel-absent listener searches and fingerprints use committed synced defaults through pending, refusal and success", async () => {
  const settings = tabEngineSettingsFamily({ tab, engineId: engine.id });
  const isolated = tabEngineSettingsFamily({ tab: "unsynced-listener", engineId: engine.id });
  store.set(isolated, { enabled: true, synced: false, settings: [], go: { t: "Depth", c: 7 } });
  expect(mocks.search.mock.calls[0][3]).toEqual({ t: "Depth", c: 10 });
  await broadcast();
  let reject!: (error: Error) => void;
  mocks.reconcile.mockImplementationOnce(
    () =>
      new Promise((_resolve, refuse) => {
        reject = refuse;
        pendingRefusal = refuse;
      }),
  );
  let refused!: Promise<{ saved: boolean }>;
  await act(async () => {
    refused = store.set(enginesAtom, (current) =>
      current.map((item) => ({ ...item, go: { t: "Depth", c: 20 } })),
    );
  });
  await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
  expect(store.get(settings).go).toEqual({ t: "Depth", c: 10 });
  expect(mocks.search).toHaveBeenCalledOnce();
  await act(async () => {
    reject(new Error("default refused"));
    expect((await refused).saved).toBe(false);
  });
  const fresh = [{ ...lines[0], depth: 24 }];
  await broadcast(fresh);
  expect([...store.get(engineMovesFamily({ tab, engine: engine.id })).values()]).toEqual([fresh]);
  mocks.prepare.mockResolvedValueOnce("depth-20-generation");
  await act(async () => {
    await store.set(enginesAtom, (current) =>
      current.map((item) => ({ ...item, go: { t: "Depth", c: 20 } })),
    );
  });
  await vi.waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(2));
  expect(mocks.search.mock.calls[1][3]).toEqual({ t: "Depth", c: 20 });
  expect(store.get(settings).go).toEqual({ t: "Depth", c: 20 });
  expect(store.get(isolated).go).toEqual({ t: "Depth", c: 7 });
  expect(store.get(engineMovesFamily({ tab, engine: engine.id })).size).toBe(0);
  await broadcast(fresh);
  expect(store.get(engineMovesFamily({ tab, engine: engine.id })).size).toBe(0);
  await broadcast(fresh, "depth-20-generation");
  expect([...store.get(engineMovesFamily({ tab, engine: engine.id })).values()]).toEqual([fresh]);
});
