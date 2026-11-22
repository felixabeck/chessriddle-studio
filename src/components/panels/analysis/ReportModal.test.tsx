import { act, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createStore, Provider, type PrimitiveAtom } from "jotai";
import { enginesAtom, referenceDbAtom } from "@/state/atoms";

import ReportModal from "./ReportModal";
import { getMainLine } from "@/utils/chess";
import {
  closeTreeStore,
  createTreeStore,
  invalidateReportOwner,
  type TreeStore,
} from "@/state/store/tree";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { startFileRevisionPoll } from "@/state/fileFreshness";
import type { GameAnalysis } from "@/bindings";
import { parseUci } from "chessops";
import { createNode, defaultTree } from "@/utils/treeReducer";

const E4_FEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

/** A game of one move, 1.e4, from the standard start. */
function e4Tree() {
  const game = defaultTree();
  game.root.children.push(
    createNode({ fen: E4_FEN, move: parseUci("e2e4")!, san: "e4", halfMoves: 1 }),
  );
  // The cursor is on the last move, so a move played in a test extends the mainline.
  return { ...game, position: [0] };
}

const mocks = vi.hoisted(() => ({
  analyzeGame: vi.fn(),
  cancelAnalysis: vi.fn(),
  prepareAnalysis: vi.fn(),
  startProgress: vi.fn(),
  collection: vi.fn(async () => null as import("@/bindings").CollectionDescriptor | null),
  engines: [
    {
      type: "local" as const,
      id: "engine-id",
      name: "Stockfish",
      version: "17",
      filename: "stockfish",
      handle: { id: { id: "engine-handle" }, kind: "engine" as const },
      settings: [],
    },
    {
      type: "local" as const,
      id: "engine-id-2",
      name: "Komodo",
      version: "1",
      filename: "komodo",
      handle: { id: { id: "engine-handle-2" }, kind: "engine" as const },
      settings: [],
    },
  ],
  notifyUnlessCancelled: vi.fn(),
  notificationsShow: vi.fn(),
  reportPersistError: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({
    i18nKey,
    components,
  }: {
    i18nKey: string;
    components?: Record<string, React.ReactElement>;
  }) => (
    <>
      {i18nKey}
      {Object.entries(components ?? {}).map(([name, element]) => (
        <span key={name}>{element}</span>
      ))}
    </>
  ),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children?: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@/platform/tauri", () => ({
  tauri: {
    analyzeGame: mocks.analyzeGame,
    cancelAnalysis: mocks.cancelAnalysis,
    prepareAnalysis: mocks.prepareAnalysis,
    startProgress: mocks.startProgress,
    collectionForDatabase: mocks.collection,
  },
}));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: mocks.notificationsShow },
}));
vi.mock("@/components/files/notifyError", () => ({
  notifyUnlessCancelled: mocks.notifyUnlessCancelled,
}));
vi.mock("@/i18n", () => ({
  default: {
    t: (key: string, options?: { cause?: string }) =>
      options?.cause === undefined ? key : `${key}: ${options.cause}`,
  },
}));
vi.mock("@/state/persistError", () => ({ reportPersistError: mocks.reportPersistError }));
vi.mock("@/state/atoms", async () => {
  const { atom } = await import("jotai");
  return {
    enginesAtom: atom<typeof mocks.engines | undefined>(mocks.engines),
    referenceDbAtom: atom(null),
    // A move played in a test reaches the move sound.
    soundCollectionAtom: atom("standard"),
    soundVolumeAtom: atom(0),
  };
});
vi.mock("@mantine/core", () => ({
  Alert: ({ children }: { children: React.ReactNode }) => <div role="alert">{children}</div>,
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Checkbox: ({
    checked,
    onChange,
    label,
    description,
    disabled,
  }: {
    checked?: boolean;
    onChange?: React.ChangeEventHandler<HTMLInputElement>;
    label?: React.ReactNode;
    description?: React.ReactNode;
    disabled?: boolean;
  }) => (
    <label>
      <input
        type="checkbox"
        checked={!!checked}
        disabled={disabled}
        onChange={onChange}
        aria-label={typeof label === "string" ? label : undefined}
      />
      <span>{description}</span>
    </label>
  ),
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  NumberInput: ({ value, rightSection }: { value: number; rightSection?: React.ReactNode }) => (
    <>
      <input type="number" value={value} readOnly />
      {rightSection}
    </>
  ),
  Select: ({
    data,
    value,
    onChange,
  }: {
    data: (string | { value: string; label: string })[];
    value?: string;
    onChange?: (value: string) => void;
  }) => {
    const options = data.map((option) =>
      typeof option === "string" ? { value: option, label: option } : option,
    );
    if (value !== undefined && !options.some((item) => item.value === value)) {
      options.unshift({ value, label: value });
    }
    return (
      <select value={value} onChange={(event) => onChange?.(event.currentTarget.value)}>
        {options.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    );
  },
  Stack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../common/AppModal", () => ({
  default: ({ children, opened }: { children: React.ReactNode; opened: boolean }) =>
    opened ? <div>{children}</div> : null,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;
let tree: TreeStore;
let analysisPublished: ReturnType<typeof vi.spyOn>;
let setInProgress: ReturnType<typeof vi.fn<(value: boolean) => void>>;
let atomStore: ReturnType<typeof createStore>;

function selectReference(value: import("@/bindings").DatabaseHandle | null) {
  act(() => atomStore.set(referenceDbAtom, value));
}

beforeEach(() => {
  vi.resetAllMocks();
  atomStore = createStore();
  atomStore.set(enginesAtom, mocks.engines);
  mocks.collection.mockResolvedValue(null);
  mocks.prepareAnalysis.mockResolvedValue("report_tab-id_operation-uuid");
  mocks.cancelAnalysis.mockResolvedValue(undefined);
  mocks.analyzeGame.mockResolvedValue(emptyAnalysis);
  sessionStorage.removeItem("tab-id");
  tree = createTreeStore("tab-id");
  tree.getState().setState(e4Tree());
  analysisPublished = vi.spyOn(tree.getState(), "applyReport");
  setInProgress = vi.fn(tree.getState().setReportInProgress);
  localStorage.removeItem("report-settings");
  localStorage.setItem(
    "report-settings",
    JSON.stringify({
      novelty: false,
      reversed: true,
      variations: true,
      goMode: { t: "Time", c: 500 },
      engine: "engine-id",
    }),
  );
  vi.stubGlobal("crypto", { randomUUID: () => "operation-uuid" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  closeTreeStore("tab-id");
  localStorage.removeItem("report-settings");
  vi.unstubAllGlobals();
});

const MAX_STABLE_REPORT_RENDERS = 20;

function countReportRenders() {
  let renders = 0;
  return {
    onRender() {
      renders += 1;
      if (renders >= MAX_STABLE_REPORT_RENDERS) {
        throw new Error("report form exceeded stable render bound");
      }
    },
    get renders() {
      return renders;
    },
  };
}

async function renderReportModal({
  reportingMode = true,
}: {
  reportingMode?: boolean;
} = {}) {
  const renders = countReportRenders();
  await act(async () => {
    root.render(
      <Profiler id="report-modal" onRender={renders.onRender}>
        <Provider store={atomStore}>
          <TreeStateContext.Provider value={tree}>
            <ReportModal
              tab="tab-id"
              initialFen={tree.getState().root.fen}
              moves={getMainLine(tree.getState().root)}
              reportingMode={reportingMode}
              closeReportingMode={vi.fn()}
              setInProgress={setInProgress}
              registerOperation={tree.getState().setReportOperationId}
            />
          </TreeStateContext.Provider>
        </Provider>
      </Profiler>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return renders;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (cause: unknown) => void = () => undefined;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function linkedReference(generation = "first"): import("@/bindings").CollectionDescriptor {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Reference",
    file: { id: { id: "source" }, kind: "fileWorkspace" },
    database: atomStore.get(referenceDbAtom),
    status: "ready",
    generation,
    omitted: 0,
    account: null,
    retiredDatabase: null,
    fetchSinceMs: null,
  };
}

function collectionFocus() {
  let focus!: () => void;
  const stop = startFileRevisionPoll({
    getTabs: () => [],
    fileRevision: vi.fn(),
    subscribeFocus: (callback) => {
      focus = callback;
      return () => undefined;
    },
  });
  return { focus: () => focus(), stop };
}

const emptyAnalysis: GameAnalysis = { positions: [], novelty: { kind: "notRequested" } };

const e4Line = {
  nodes: 1n,
  depth: 1,
  score: { value: { type: "cp" as const, value: 123 }, wdl: null },
  uciMoves: ["e2e4"],
  sanMoves: ["e4"],
  multipv: 1,
  nps: 1n,
};

const e5Line = {
  nodes: 1n,
  depth: 1,
  score: { value: { type: "cp" as const, value: 20 }, wdl: null },
  uciMoves: ["e7e5"],
  sanMoves: ["e5"],
  multipv: 1,
  nps: 1n,
};

const completedAnalysis: GameAnalysis = {
  // Index 0 is the start position, which is never the novelty.
  positions: [
    { best: [e4Line], terminal: null, isSacrifice: false },
    { best: [e5Line], terminal: null, isSacrifice: false },
  ],
  novelty: { kind: "notRequested" },
};

// The report of a game with one move whose position is absent from the reference.
const noveltyAnalysis: GameAnalysis = {
  positions: [
    completedAnalysis.positions[0],
    {
      best: [
        {
          nodes: 1n,
          depth: 1,
          score: { value: { type: "cp", value: -40 }, wdl: null },
          uciMoves: ["e7e5"],
          sanMoves: ["e5"],
          multipv: 1,
          nps: 1n,
        },
      ],
      terminal: null,
      isSacrifice: true,
    },
  ],
  novelty: { kind: "found", position: 1 },
};

async function startUnmountedLinkedReport() {
  selectReference({ id: { id: "reference-A" }, kind: "database" });
  const collection = linkedReference();
  mocks.collection.mockResolvedValue(collection);
  const completion = deferred<GameAnalysis>();
  mocks.analyzeGame.mockReturnValueOnce(completion.promise);
  await renderReportModal();
  await act(async () => host.querySelector("button")!.click());
  expect(mocks.analyzeGame).toHaveBeenCalledOnce();
  expect(tree.getState().report.inProgress).toBe(true);
  await act(async () => root.render(<div>Database panel</div>));
  return { completion, collection };
}

test("switching report go mode resets Depth to 20 and Time to 500 without mutating the previous mode", async () => {
  await renderReportModal();
  const typeSelect = host.querySelectorAll("select")[1];
  expect(typeSelect).toHaveProperty("value", "Time");
  await act(async () => host.querySelector("button")!.click());
  const previousGoMode = mocks.analyzeGame.mock.calls[0][4];
  expect(previousGoMode).toEqual({ t: "Time", c: 500 });

  await act(async () => {
    typeSelect.value = "Depth";
    typeSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => host.querySelector("button")!.click());

  expect(mocks.analyzeGame).toHaveBeenCalledTimes(2);
  expect(mocks.analyzeGame.mock.calls[1][4]).toEqual({ t: "Depth", c: 20 });
  expect(mocks.analyzeGame.mock.calls[1][4]).not.toBe(previousGoMode);
  expect(previousGoMode).toEqual({ t: "Time", c: 500 });
  const depthGoMode = mocks.analyzeGame.mock.calls[1][4];

  await act(async () => {
    typeSelect.value = "Time";
    typeSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => host.querySelector("button")!.click());

  expect(mocks.analyzeGame).toHaveBeenCalledTimes(3);
  expect(mocks.analyzeGame.mock.calls[2][4]).toEqual({ t: "Time", c: 500 });
  expect(mocks.analyzeGame.mock.calls[2][4]).not.toBe(depthGoMode);
  expect(depthGoMode).toEqual({ t: "Depth", c: 20 });
  expect(previousGoMode).toEqual({ t: "Time", c: 500 });
});

function storeSettings(settings: Record<string, unknown>) {
  localStorage.setItem(
    "report-settings",
    JSON.stringify({
      novelty: false,
      variations: true,
      goMode: { t: "Time", c: 500 },
      engine: "engine-id",
      ...settings,
    }),
  );
}

test("a reference change during a run without novelty neither cancels it nor drops its result", async () => {
  const { completion } = await startUnmountedLinkedReport();
  selectReference({ id: { id: "reference-B" }, kind: "database" });
  await act(async () => completion.resolve(completedAnalysis));
  expect(mocks.cancelAnalysis).not.toHaveBeenCalled();
  expect(analysisPublished).toHaveBeenCalledOnce();
  expect(tree.getState().root.score).toEqual(e4Line.score);
  expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
  expect(tree.getState().report.inProgress).toBe(false);
});

test("a reference change during a run without novelty keeps its failure visible", async () => {
  const { completion } = await startUnmountedLinkedReport();
  selectReference({ id: { id: "reference-B" }, kind: "database" });
  const failure = new Error("current failure");
  await act(async () => completion.reject(failure));
  expect(mocks.cancelAnalysis).not.toHaveBeenCalled();
  expect(analysisPublished).not.toHaveBeenCalled();
  expect(mocks.notifyUnlessCancelled).toHaveBeenCalledExactlyOnceWith("Common.Error", failure);
  expect(tree.getState().report.inProgress).toBe(false);
});

test("an unchanged linked reference publishes the analysis and the novelty after panel unmount", async () => {
  storeSettings({ novelty: true });
  const { completion } = await startUnmountedLinkedReport();
  const reads = mocks.collection.mock.calls.length;
  await act(async () => completion.resolve(noveltyAnalysis));
  expect(mocks.collection).toHaveBeenCalledTimes(reads + 1);
  expect(analysisPublished).toHaveBeenCalledExactlyOnceWith(
    noveltyAnalysis,
    expect.objectContaining({
      operationId: "report_tab-id_operation-uuid",
      engine: "Stockfish",
      goMode: { t: "Time", c: 500 },
      marks: true,
      lines: true,
    }),
  );
  expect(tree.getState().root.score).toEqual(noveltyAnalysis.positions[0].best[0].score);
  expect(tree.getState().root.nags).toEqual([]);
  expect(tree.getState().root.children[0].nags).toContain(146);
  expect(tree.getState().report.summary).toMatchObject({ engine: "Stockfish", novelty: "found" });
  expect(tree.getState().report.inProgress).toBe(false);
  expect(mocks.cancelAnalysis).not.toHaveBeenCalled();
  expect(mocks.notificationsShow).not.toHaveBeenCalled();
});

test("current report failure after unmount still reports its first error", async () => {
  const { completion } = await startUnmountedLinkedReport();
  const failure = new Error("current A failure");
  await act(async () => completion.reject(failure));
  expect(mocks.notifyUnlessCancelled).toHaveBeenCalledExactlyOnceWith("Common.Error", failure);
  expect(tree.getState().report.inProgress).toBe(false);
});

test.each(["selection", "generation", "unavailable", "identity", "standalone", "rejected"])(
  "with novelty on, a reference %s change applies the result with the novelty unavailable",
  async (change) => {
    storeSettings({ novelty: true });
    const { completion, collection } = await startUnmountedLinkedReport();
    if (change === "selection") selectReference({ id: { id: "reference-B" }, kind: "database" });
    else if (change === "rejected")
      mocks.collection.mockRejectedValue(new Error("metadata unavailable"));
    else
      mocks.collection.mockResolvedValue(
        change === "standalone"
          ? null
          : {
              ...collection,
              ...(change === "generation" ? { generation: "second" } : {}),
              ...(change === "unavailable" ? { status: "unavailable" as const } : {}),
              ...(change === "identity" ? { id: "replacement-collection" } : {}),
            },
      );
    await act(async () => completion.resolve(noveltyAnalysis));
    expect(analysisPublished).toHaveBeenCalledExactlyOnceWith(
      { ...noveltyAnalysis, novelty: { kind: "unavailable" } },
      expect.anything(),
    );
    expect(tree.getState().root.score).toEqual(noveltyAnalysis.positions[0].best[0].score);
    expect(tree.getState().root.children[0].nags).not.toContain(146);
    expect(mocks.notificationsShow).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "Board.Analysis.Report.NoveltyUnavailable" }),
    );
    expect(mocks.cancelAnalysis).not.toHaveBeenCalled();
    expect(tree.getState().report.inProgress).toBe(false);
  },
);

test("a native failure is notified even when the reference check fails", async () => {
  storeSettings({ novelty: true });
  const { completion } = await startUnmountedLinkedReport();
  mocks.collection.mockRejectedValue(new Error("metadata unavailable"));
  const failure = new Error("engine failed");
  await act(async () => completion.reject(failure));
  expect(mocks.notifyUnlessCancelled).toHaveBeenCalledExactlyOnceWith("Common.Error", failure);
});

test.each(["operation", "tab", "root"])(
  "a %s change while the reference check is pending refuses publication",
  async (change) => {
    storeSettings({ novelty: true });
    const { completion, collection } = await startUnmountedLinkedReport();
    const validation = deferred<import("@/bindings").CollectionDescriptor | null>();
    mocks.collection.mockReturnValueOnce(validation.promise);
    await act(async () => completion.resolve(noveltyAnalysis));
    expect(tree.getState().report.inProgress).toBe(true);
    act(() => {
      if (change === "operation") tree.getState().setReportOperationId("successor-report");
      if (change === "tab") closeTreeStore("tab-id");
      if (change === "root") tree.getState().appendMove({ payload: parseUci("e7e5")! });
    });
    await act(async () => validation.resolve(collection));
    expect(analysisPublished).not.toHaveBeenCalled();
    expect(tree.getState().root.score).toBeNull();
    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
    expect(tree.getState().report.operationId).toBe(
      change === "operation" ? "successor-report" : "report_tab-id_operation-uuid",
    );
    // Only a changed game is reported, and its run is over; a successor keeps its flag.
    expect(mocks.notificationsShow.mock.calls.map(([notice]) => notice.message)).toEqual(
      change === "root" ? ["Board.Analysis.Report.GameChanged"] : [],
    );
    expect(tree.getState().report.inProgress).toBe(change !== "root");
  },
);

test("report currency consumer notifies once per outage with fresh native errors and resets on recovery or selection", async () => {
  selectReference({ id: { id: "reference-A" }, kind: "database" });
  let sequence = 0;
  mocks.collection.mockImplementation(async () => {
    throw new Error(`native outage ${++sequence}`);
  });
  const poll = collectionFocus();
  try {
    await renderReportModal();
    expect(mocks.notifyUnlessCancelled).toHaveBeenCalledTimes(1);
    await act(async () => poll.focus());
    await act(async () => poll.focus());
    expect(sequence).toBe(3);
    expect(mocks.notifyUnlessCancelled).toHaveBeenCalledTimes(1);
    // The reference never blocks Analyze.
    expect(host.querySelector("button")!.disabled).toBe(false);
    mocks.collection.mockResolvedValue(linkedReference());
    await act(async () => poll.focus());
    mocks.collection.mockImplementation(async () => {
      throw new Error(`second outage ${++sequence}`);
    });
    await act(async () => poll.focus());
    await act(async () => poll.focus());
    expect(mocks.notifyUnlessCancelled).toHaveBeenCalledTimes(2);
    selectReference({ id: { id: "reference-B" }, kind: "database" });
    await renderReportModal();
    expect(mocks.notifyUnlessCancelled).toHaveBeenCalledTimes(3);
  } finally {
    poll.stop();
  }
});

test.each(["selection", "generation", "status"])(
  "a reference %s change during preparation neither aborts it nor cancels the run",
  async (change) => {
    selectReference({ id: { id: "reference-first" }, kind: "database" });
    const collection = linkedReference();
    if (change !== "selection") mocks.collection.mockResolvedValue(collection);
    const prepared = deferred<string>();
    mocks.prepareAnalysis.mockReturnValueOnce(prepared.promise);
    mocks.analyzeGame.mockReturnValueOnce(deferred<GameAnalysis>().promise);
    const poll = collectionFocus();
    try {
      await renderReportModal();
      await act(async () => host.querySelector("button")!.click());
      const signal = mocks.prepareAnalysis.mock.calls[0][1].signal as AbortSignal;
      if (change === "selection") {
        selectReference({ id: { id: "reference-second" }, kind: "database" });
        await renderReportModal();
      } else {
        mocks.collection.mockResolvedValue({
          ...collection,
          ...(change === "generation" ? { generation: "second" } : { status: "missing" as const }),
        });
        await act(async () => poll.focus());
      }
      await act(async () => prepared.resolve("prepared-ticket"));
      expect(signal.aborted).toBe(false);
      expect(mocks.cancelAnalysis).not.toHaveBeenCalled();
      expect(mocks.analyzeGame).toHaveBeenCalledOnce();
      expect(mocks.analyzeGame.mock.calls[0][0]).toBe("prepared-ticket");
      expect(tree.getState().report).toMatchObject({
        inProgress: true,
        operationId: "prepared-ticket",
      });
    } finally {
      poll.stop();
    }
  },
);

test("Analyze does not wait for reference currency and a failing check is still shown", async () => {
  selectReference({ id: { id: "reference" }, kind: "database" });
  const check = deferred<import("@/bindings").CollectionDescriptor | null>();
  mocks.collection.mockReturnValueOnce(check.promise);
  await renderReportModal();
  expect(host.querySelector("button")!.disabled).toBe(false);
  await act(async () => check.reject(new Error("reference currency failed")));
  expect(host.textContent).toContain("Collections.Unavailable");
  expect(host.querySelector("button")!.disabled).toBe(false);
  expect(mocks.notifyUnlessCancelled).toHaveBeenCalledWith(
    "Common.Error",
    expect.objectContaining({ message: "reference currency failed" }),
  );
  await act(async () => host.querySelector("button")!.click());
  expect(mocks.prepareAnalysis).toHaveBeenCalledOnce();
});

test.each(["generation", "preservedOriginal"] as const)(
  "a linked reference %s change during a run without novelty never cancels it",
  async (change) => {
    selectReference({ id: { id: "linked-reference" }, kind: "database" });
    const collection = linkedReference();
    mocks.collection.mockResolvedValue(collection);
    const analysis = deferred<GameAnalysis>();
    mocks.analyzeGame.mockReturnValueOnce(analysis.promise);
    const poll = collectionFocus();
    try {
      await renderReportModal();
      await act(async () => host.querySelector("button")!.click());
      expect(mocks.analyzeGame).toHaveBeenCalledOnce();
      mocks.collection.mockResolvedValue(
        change === "generation"
          ? { ...collection, generation: "second" }
          : { ...collection, status: "preservedOriginal", database: null },
      );
      await act(async () => poll.focus());
      expect(mocks.cancelAnalysis).not.toHaveBeenCalled();
      await act(async () => analysis.resolve(completedAnalysis));
      expect(analysisPublished).toHaveBeenCalledOnce();
      expect(tree.getState().root.score).toEqual(e4Line.score);
      expect(tree.getState().report.inProgress).toBe(false);
    } finally {
      poll.stop();
    }
  },
);

test("a report the user cancelled stays silent and a later run shows its own failure", async () => {
  const old = deferred<GameAnalysis>();
  const current = deferred<GameAnalysis>();
  mocks.prepareAnalysis.mockResolvedValueOnce("old").mockResolvedValueOnce("current");
  mocks.analyzeGame.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  await renderReportModal();
  await act(async () => host.querySelector("button")!.click());
  // The panel's Cancel clears the operation and the run flag.
  act(() => {
    tree.getState().setReportOperationId(null);
    tree.getState().setReportInProgress(false);
  });
  await act(async () => host.querySelector("button")!.click());
  expect(tree.getState().report.operationId).toBe("current");
  const failure = {
    tag: "engine-failure",
    category: "engine-failure",
    message: "Engine terminated",
    engineFailure: {
      kind: "process-exit",
      exitStatus: { code: 1, signal: null },
      reason: "Safe report failure",
      entries: [],
    },
  };
  await act(async () => old.reject(failure));
  expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
  expect(mocks.notificationsShow).not.toHaveBeenCalled();
  await act(async () => current.reject(failure));
  expect(mocks.notifyUnlessCancelled).toHaveBeenCalledExactlyOnceWith(
    "Common.Error",
    expect.objectContaining({ message: "Safe report failure" }),
  );
});

test("an analysis cancel that arrives before the Cancel acknowledgement stays silent", async () => {
  const running = deferred<GameAnalysis>();
  mocks.analyzeGame.mockReturnValueOnce(running.promise);
  await renderReportModal();
  await act(async () => host.querySelector("button")!.click());
  expect(tree.getState().report.operationId).not.toBeNull();
  // The native side answers the run before the panel's Cancel clears the operation.
  await act(async () =>
    running.reject({
      tag: "backend-error",
      category: "cancellation",
      message: "Analysis cancelled",
    }),
  );
  expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
  expect(mocks.notificationsShow).not.toHaveBeenCalled();
  expect(tree.getState().report.inProgress).toBe(false);
});

test("a submit while the tab runs a report is refused", async () => {
  const running = deferred<GameAnalysis>();
  mocks.analyzeGame.mockReturnValueOnce(running.promise);
  await renderReportModal();
  await act(async () => host.querySelector("button")!.click());
  expect(tree.getState().report.inProgress).toBe(true);
  expect(host.querySelector("button")!.disabled).toBe(true);
  // The disabled button aside, a submit (shortcut, stale handler) starts nothing.
  await act(async () => {
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true }));
  });
  expect(mocks.prepareAnalysis).toHaveBeenCalledOnce();
  expect(mocks.analyzeGame).toHaveBeenCalledOnce();
});

test("a rejected reservation leaves no run flag and the dialog usable", async () => {
  mocks.prepareAnalysis.mockRejectedValueOnce(new Error("no reservation"));
  mocks.analyzeGame.mockReturnValueOnce(deferred<GameAnalysis>().promise);
  await renderReportModal();
  await act(async () => host.querySelector("button")!.click());
  expect(tree.getState().report).toMatchObject({ inProgress: false, operationId: null });
  expect(setInProgress).not.toHaveBeenCalled();
  expect(mocks.notifyUnlessCancelled).toHaveBeenCalledOnce();
  expect(host.querySelector("button")!.disabled).toBe(false);
  await act(async () => host.querySelector("button")!.click());
  expect(mocks.prepareAnalysis).toHaveBeenCalledTimes(2);
  expect(mocks.analyzeGame).toHaveBeenCalledOnce();
  expect(tree.getState().report.inProgress).toBe(true);
});

test("an edit to the mainline cancels the run at once, also with the panel unmounted", async () => {
  const completion = deferred<GameAnalysis>();
  mocks.analyzeGame.mockReturnValueOnce(completion.promise);
  await renderReportModal();
  await act(async () => host.querySelector("button")!.click());
  await act(async () => root.render(<div>Database panel</div>));
  expect(mocks.cancelAnalysis).not.toHaveBeenCalled();
  await act(async () => tree.getState().appendMove({ payload: parseUci("e7e5")! }));
  expect(mocks.cancelAnalysis).toHaveBeenCalledExactlyOnceWith("report_tab-id_operation-uuid");
  // The cancelled native run rejects; the user learns why once, without an error.
  await act(async () => completion.reject({ tag: "cancelled", message: "Cancellation" }));
  expect(analysisPublished).not.toHaveBeenCalled();
  expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
  expect(mocks.notificationsShow).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ message: "Board.Analysis.Report.GameChanged" }),
  );
  expect(tree.getState().report.inProgress).toBe(false);
});

test("a result that finishes after an edit is dropped with one notice", async () => {
  const completion = deferred<GameAnalysis>();
  const cancelled = deferred<void>();
  mocks.analyzeGame.mockReturnValueOnce(completion.promise);
  mocks.cancelAnalysis.mockReturnValueOnce(cancelled.promise);
  await renderReportModal();
  await act(async () => host.querySelector("button")!.click());
  act(() => tree.getState().appendMove({ payload: parseUci("e7e5")! }));
  // The finished result arrives before the cancellation takes effect.
  await act(async () => completion.resolve(completedAnalysis));
  await act(async () => cancelled.resolve());
  expect(analysisPublished).not.toHaveBeenCalled();
  expect(tree.getState().root.score).toBeNull();
  expect(mocks.notificationsShow).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ message: "Board.Analysis.Report.GameChanged" }),
  );
});

test("one notice names the positions without evaluation and the unavailable novelty", async () => {
  mocks.analyzeGame.mockResolvedValue({
    positions: [completedAnalysis.positions[0], { best: [], terminal: null, isSacrifice: false }],
    novelty: { kind: "unavailable" },
  });
  await renderReportModal();
  await act(async () => host.querySelector("button")!.click());
  expect(analysisPublished).toHaveBeenCalledOnce();
  expect(mocks.notificationsShow).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      title: "Board.Analysis.Report.Incomplete",
      message: "Board.Analysis.Report.MissingEvaluations Board.Analysis.Report.NoveltyUnavailable",
    }),
  );
  expect(tree.getState().report.summary?.missingEvaluations).toBe(1);
});

test("a complete report shows no notice and a terminal position counts as evaluated", async () => {
  mocks.analyzeGame.mockResolvedValue({
    positions: [completedAnalysis.positions[0], { best: [], terminal: "draw", isSacrifice: false }],
    novelty: { kind: "notRequested" },
  });
  await renderReportModal();
  await act(async () => host.querySelector("button")!.click());
  expect(analysisPublished).toHaveBeenCalledOnce();
  expect(mocks.notificationsShow).not.toHaveBeenCalled();
});

test("P2 superseded preparation rejection does not notify against the newer report", async () => {
  const old = deferred<string>();
  mocks.prepareAnalysis.mockReturnValueOnce(old.promise).mockResolvedValueOnce("current");
  mocks.analyzeGame.mockResolvedValue(emptyAnalysis);
  await renderReportModal();
  await act(async () => {
    host.querySelector("button")!.click();
    host.querySelector("button")!.click();
    await Promise.resolve();
  });
  await act(async () => old.reject(new Error("obsolete preparation")));
  expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
});

test("P2 a retired preparation's cleanup failure cannot notify against its successor", async () => {
  const old = deferred<string>();
  mocks.prepareAnalysis.mockReturnValueOnce(old.promise).mockResolvedValueOnce("current");
  mocks.analyzeGame.mockResolvedValue(emptyAnalysis);
  mocks.cancelAnalysis.mockRejectedValueOnce(new Error("obsolete cleanup failed"));
  await renderReportModal();
  await act(async () => {
    host.querySelector("button")!.click();
    host.querySelector("button")!.click();
    await Promise.resolve();
  });
  await act(async () => old.resolve("obsolete"));
  expect(mocks.cancelAnalysis).toHaveBeenCalledWith("obsolete");
  expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
});

test("completion survives modal unmount while an actual tab close rejects the late result", async () => {
  const completion = deferred<GameAnalysis>();
  mocks.analyzeGame.mockReturnValueOnce(completion.promise);
  await renderReportModal();
  await act(async () => {
    host.querySelector("button")!.click();
    await Promise.resolve();
    root.render(<div />);
  });
  await act(async () => completion.resolve(emptyAnalysis));
  expect(analysisPublished).toHaveBeenCalledOnce();

  const afterClose = deferred<GameAnalysis>();
  mocks.analyzeGame.mockReturnValueOnce(afterClose.promise);
  await renderReportModal();
  await act(async () => {
    host.querySelector("button")!.click();
    await Promise.resolve();
    invalidateReportOwner("tab-id");
    afterClose.resolve(emptyAnalysis);
  });
  expect(analysisPublished).toHaveBeenCalledTimes(1);
});

test("a close while preparation is pending cancels the eventual reservation before dispatch", async () => {
  const prepared = deferred<string>();
  mocks.prepareAnalysis.mockReturnValueOnce(prepared.promise);
  await renderReportModal();
  await act(async () => {
    host.querySelector("button")!.click();
    invalidateReportOwner("tab-id");
    prepared.resolve("late-ticket");
  });
  expect(mocks.cancelAnalysis).toHaveBeenCalledWith("late-ticket");
  expect(mocks.analyzeGame).not.toHaveBeenCalled();
});

test("modal unmount aborts pending preparation and cancels its eventual reservation", async () => {
  const prepared = deferred<string>();
  mocks.prepareAnalysis.mockReturnValueOnce(prepared.promise);
  await renderReportModal();
  await act(async () => {
    host.querySelector("button")!.click();
    await Promise.resolve();
    root.render(<div />);
  });
  await act(async () => {
    prepared.resolve("unmounted-ticket");
  });
  expect(mocks.prepareAnalysis.mock.calls[0][1].signal.aborted).toBe(true);
  expect(mocks.cancelAnalysis).toHaveBeenCalledWith("unmounted-ticket");
  expect(mocks.analyzeGame).not.toHaveBeenCalled();
});

test("a replacement request retains cancellation while the older preparation is pending", async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  mocks.prepareAnalysis.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  mocks.analyzeGame.mockResolvedValue(emptyAnalysis);
  await renderReportModal();
  await act(async () => {
    host.querySelector("button")!.click();
    host.querySelector("button")!.click();
    second.resolve("current-ticket");
    await Promise.resolve();
    first.resolve("superseded-ticket");
  });
  expect(mocks.prepareAnalysis.mock.calls[0][1].signal.aborted).toBe(true);
  expect(mocks.cancelAnalysis).toHaveBeenCalledWith("superseded-ticket");
  expect(mocks.analyzeGame).toHaveBeenCalledOnce();
  expect(mocks.analyzeGame).toHaveBeenCalledWith(
    "current-ticket",
    "tab-id",
    expect.anything(),
    "engine-id",
    expect.anything(),
    expect.anything(),
    [],
  );
});

test("passes the immutable engine id and catches analysis rejection", async () => {
  const failure = new Error("analysis failed");
  mocks.analyzeGame.mockRejectedValue(failure);

  await renderReportModal();
  await act(async () => {
    host.querySelector("button")!.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mocks.analyzeGame).toHaveBeenCalledWith(
    "report_tab-id_operation-uuid",
    "tab-id",
    { id: { id: "engine-handle" }, kind: "engine" },
    "engine-id",
    { t: "Time", c: 500 },
    expect.objectContaining({ fen: defaultTree().root.fen, moves: ["e2e4"] }),
    [],
  );
  expect(mocks.notifyUnlessCancelled).toHaveBeenCalledWith("Common.Error", failure);
  expect(mocks.startProgress).not.toHaveBeenCalled();
});

test("hydrates missing goMode with the default while preserving the selected engine", async () => {
  localStorage.setItem(
    "report-settings",
    JSON.stringify({ novelty: false, reversed: false, variations: true, engine: "engine-id" }),
  );
  mocks.analyzeGame.mockResolvedValue(emptyAnalysis);

  await renderReportModal();
  await act(async () => {
    host.querySelector("button")!.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mocks.analyzeGame).toHaveBeenCalledWith(
    "report_tab-id_operation-uuid",
    "tab-id",
    expect.anything(),
    "engine-id",
    { t: "Time", c: 500 },
    expect.anything(),
    [],
  );
  expect(JSON.parse(localStorage.getItem("report-settings")!)).toEqual({
    novelty: false,
    marks: true,
    variations: true,
    goMode: { t: "Time", c: 500 },
    engine: "engine-id",
  });
});

test("defaults an invalid goMode during hydration instead of crashing render", async () => {
  localStorage.setItem(
    "report-settings",
    JSON.stringify({
      novelty: false,
      reversed: true,
      variations: false,
      goMode: { t: "Unsupported", c: 500 },
      engine: "engine-id",
    }),
  );
  mocks.analyzeGame.mockResolvedValue(emptyAnalysis);

  await renderReportModal();
  expect(host.textContent).not.toContain("Cannot read properties");
  await act(async () => {
    host.querySelector("button")!.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mocks.analyzeGame).toHaveBeenCalledWith(
    expect.any(String),
    "tab-id",
    expect.anything(),
    "engine-id",
    { t: "Time", c: 500 },
    expect.anything(),
    [],
  );
});

test("hydrates an over-limit Time goMode to the default report go mode", async () => {
  localStorage.setItem(
    "report-settings",
    JSON.stringify({
      novelty: false,
      reversed: true,
      variations: false,
      goMode: { t: "Time", c: 86_400_001 },
      engine: "engine-id",
    }),
  );
  mocks.analyzeGame.mockResolvedValue(emptyAnalysis);

  await renderReportModal();
  await act(async () => {
    host.querySelector("button")!.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mocks.analyzeGame).toHaveBeenCalledWith(
    expect.any(String),
    "tab-id",
    expect.anything(),
    "engine-id",
    { t: "Time", c: 500 },
    expect.anything(),
    [],
  );
});

test("keeps a stored Nodes goMode of 100_000_000", async () => {
  localStorage.setItem(
    "report-settings",
    JSON.stringify({
      novelty: false,
      reversed: true,
      variations: false,
      goMode: { t: "Nodes", c: 100_000_000 },
      engine: "engine-id",
    }),
  );
  mocks.analyzeGame.mockResolvedValue(emptyAnalysis);

  await renderReportModal();
  await act(async () => {
    host.querySelector("button")!.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mocks.analyzeGame).toHaveBeenCalledWith(
    expect.any(String),
    "tab-id",
    expect.anything(),
    "engine-id",
    { t: "Nodes", c: 100_000_000 },
    expect.anything(),
    [],
  );
});

test("reports a quota-failed settings save while still starting the report", async () => {
  const quota = new DOMException("Storage quota exceeded", "QuotaExceededError");
  const originalSetItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    if (key === "report-settings") throw quota;
    return Reflect.apply(originalSetItem, this, [key, value]);
  });
  mocks.analyzeGame.mockResolvedValue(emptyAnalysis);

  await renderReportModal();
  await act(async () => {
    host.querySelector("button")!.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mocks.analyzeGame).toHaveBeenCalledOnce();
  expect(mocks.reportPersistError).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "Common.PreferenceSaveFailed: Common.StorageQuotaExceeded",
      cause: quota,
    }),
  );
});

test("report form render count stays bounded while closed and after an edit", async () => {
  const closed = await renderReportModal({ reportingMode: false });
  expect(closed.renders).toBeLessThan(MAX_STABLE_REPORT_RENDERS);

  const opened = await renderReportModal({ reportingMode: true });
  expect(opened.renders).toBeLessThan(MAX_STABLE_REPORT_RENDERS);

  const variations = host.querySelector(
    'input[aria-label="Board.Analysis.ShowVariations"]',
  ) as HTMLInputElement;
  await act(async () => variations.click());
  expect(opened.renders).toBeLessThan(MAX_STABLE_REPORT_RENDERS);
});

test("report form keeps checkbox and engine edits across renders", async () => {
  await renderReportModal();
  const variations = host.querySelector(
    'input[aria-label="Board.Analysis.ShowVariations"]',
  ) as HTMLInputElement;
  const engineSelect = host.querySelectorAll("select")[0] as HTMLSelectElement;

  await act(async () => variations.click());
  await act(async () => {
    engineSelect.value = "engine-id-2";
    engineSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
  });

  expect(variations.checked).toBe(false);
  expect(engineSelect.value).toBe("engine-id-2");

  await act(async () => host.querySelector("button")!.click());
  expect(mocks.analyzeGame).toHaveBeenCalledOnce();
  expect(mocks.analyzeGame.mock.calls[0][3]).toBe("engine-id-2");
  expect(mocks.analyzeGame.mock.calls[0][5]).not.toHaveProperty("reversed");
  expect(JSON.parse(localStorage.getItem("report-settings")!)).toEqual(
    expect.objectContaining({ variations: false, engine: "engine-id-2" }),
  );
});

test("keeps the stored engine when the engine list hydrates after mount", async () => {
  localStorage.setItem(
    "report-settings",
    JSON.stringify({
      novelty: false,
      reversed: true,
      variations: true,
      goMode: { t: "Time", c: 500 },
      engine: "engine-id-2",
    }),
  );
  atomStore.set(
    enginesAtom as unknown as PrimitiveAtom<typeof mocks.engines | undefined>,
    undefined,
  );
  await renderReportModal();
  const engineSelect = host.querySelectorAll("select")[0] as HTMLSelectElement;
  expect(engineSelect.value).toBe("engine-id-2");
  await act(async () => {
    host.querySelector("button")!.click();
    await Promise.resolve();
  });
  expect(mocks.analyzeGame).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem("report-settings")!).engine).toBe("engine-id-2");
  await act(async () => {
    atomStore.set(enginesAtom, mocks.engines);
  });

  expect(engineSelect.value).toBe("engine-id-2");
  await act(async () => host.querySelector("button")!.click());
  expect(mocks.analyzeGame).toHaveBeenCalledOnce();
  expect(mocks.analyzeGame.mock.calls[0][3]).toBe("engine-id-2");
});

test("clears the engine field when the loaded engine list is empty", async () => {
  localStorage.setItem(
    "report-settings",
    JSON.stringify({
      novelty: false,
      reversed: true,
      variations: true,
      goMode: { t: "Time", c: 500 },
      engine: "engine-id-2",
    }),
  );
  atomStore.set(enginesAtom, []);
  await renderReportModal();

  const engineSelect = host.querySelectorAll("select")[0] as HTMLSelectElement;
  expect(engineSelect.value).toBe("");

  await act(async () => {
    host.querySelector("button")!.click();
    await Promise.resolve();
  });
  expect(mocks.analyzeGame).not.toHaveBeenCalled();
});

test("falls back to the first installed engine without resetting a user-edited checkbox", async () => {
  localStorage.setItem(
    "report-settings",
    JSON.stringify({
      novelty: true,
      reversed: true,
      variations: true,
      goMode: { t: "Time", c: 500 },
      engine: "missing-engine",
    }),
  );
  await renderReportModal();
  const engineSelect = host.querySelectorAll("select")[0] as HTMLSelectElement;
  expect(engineSelect.value).toBe("engine-id");

  const variations = host.querySelector(
    'input[aria-label="Board.Analysis.ShowVariations"]',
  ) as HTMLInputElement;
  await act(async () => variations.click());
  expect(variations.checked).toBe(false);

  await act(async () => {
    atomStore.set(enginesAtom, [mocks.engines[1]]);
  });

  expect(engineSelect.value).toBe("engine-id-2");
  expect(variations.checked).toBe(false);
});

test("an old stored settings object with reversed and without marks loads and submits", async () => {
  localStorage.setItem(
    "report-settings",
    JSON.stringify({
      novelty: false,
      reversed: false,
      variations: true,
      goMode: { t: "Depth", c: 12 },
      engine: "engine-id",
    }),
  );
  mocks.analyzeGame.mockResolvedValue(completedAnalysis);
  await renderReportModal();
  expect(
    (host.querySelector('input[aria-label="Board.Analysis.MarkMoves"]') as HTMLInputElement)
      .checked,
  ).toBe(true);
  await act(async () => host.querySelector("button")!.click());
  expect(mocks.analyzeGame).toHaveBeenCalledOnce();
  expect(mocks.analyzeGame.mock.calls[0][5]).not.toHaveProperty("reversed");
  expect(analysisPublished).toHaveBeenCalledWith(
    completedAnalysis,
    expect.objectContaining({ marks: true, goMode: { t: "Depth", c: 12 } }),
  );
  expect(JSON.parse(localStorage.getItem("report-settings")!)).not.toHaveProperty("reversed");
});

test("without a reference the novelty option is off and the stored preference is kept", async () => {
  storeSettings({ novelty: true });
  await renderReportModal();
  const novelty = host.querySelector(
    'input[aria-label="Board.Analysis.AnnotateNovelties"]',
  ) as HTMLInputElement;
  expect(novelty.disabled).toBe(true);
  expect(novelty.checked).toBe(false);
  expect(host.textContent).toContain("Board.Analysis.AnnotateNovelties.NoReference");
  await act(async () => host.querySelector("button")!.click());
  expect(mocks.analyzeGame.mock.calls[0][5]).toEqual(
    expect.objectContaining({ annotateNovelties: false }),
  );
  expect(JSON.parse(localStorage.getItem("report-settings")!).novelty).toBe(true);
});

test("with a ready reference the stored novelty preference is used", async () => {
  storeSettings({ novelty: true });
  selectReference({ id: { id: "reference" }, kind: "database" });
  await renderReportModal();
  const novelty = host.querySelector(
    'input[aria-label="Board.Analysis.AnnotateNovelties"]',
  ) as HTMLInputElement;
  expect(novelty.disabled).toBe(false);
  expect(novelty.checked).toBe(true);
  await act(async () => host.querySelector("button")!.click());
  expect(mocks.analyzeGame.mock.calls[0][5]).toEqual(
    expect.objectContaining({ annotateNovelties: true }),
  );
});

test("Analyze is disabled without a local engine and while the engine list loads", async () => {
  atomStore.set(enginesAtom, []);
  await renderReportModal();
  expect(host.textContent).toContain("Engines.Selection.None");
  expect(host.querySelector('a[href="/engines"]')).not.toBeNull();
  expect(host.querySelector("button")!.disabled).toBe(true);

  atomStore.set(
    enginesAtom as unknown as PrimitiveAtom<typeof mocks.engines | undefined>,
    undefined,
  );
  await renderReportModal();
  expect(host.textContent).not.toContain("Engines.Selection.None");
  expect(host.querySelector("button")!.disabled).toBe(true);

  await act(async () => atomStore.set(enginesAtom, mocks.engines));
  expect(host.querySelector("button")!.disabled).toBe(false);
});
