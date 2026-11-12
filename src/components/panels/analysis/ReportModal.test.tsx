import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createStore, Provider } from "jotai";
import { enginesAtom, referenceDbAtom } from "@/state/atoms";

import ReportModal from "./ReportModal";
import {
  closeTreeStore,
  createTreeStore,
  invalidateReportOwner,
  type TreeStore,
} from "@/state/store/tree";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { startFileRevisionPoll } from "@/state/fileFreshness";
import type { MoveAnalysis } from "@/bindings";

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
  ],
  notifyUnlessCancelled: vi.fn(),
  reportPersistError: vi.fn(),
  formValues: undefined as Record<string, unknown> | undefined,
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/platform/tauri", () => ({
  tauri: {
    analyzeGame: mocks.analyzeGame,
    cancelAnalysis: mocks.cancelAnalysis,
    prepareAnalysis: mocks.prepareAnalysis,
    startProgress: mocks.startProgress,
    collectionForDatabase: mocks.collection,
  },
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
  return { enginesAtom: atom(mocks.engines), referenceDbAtom: atom(null) };
});
vi.mock("@mantine/form", async () => {
  const { useReducer, useState } = await import("react");
  return {
    useForm: ({ initialValues }: { initialValues: Record<string, unknown> }) => {
      const [, rerender] = useReducer((value: number) => value + 1, 0);
      const [form] = useState(() => {
        const values = { ...initialValues };
        return {
          values,
          setValues: vi.fn((next: Record<string, unknown>) => {
            Object.assign(values, next);
            rerender();
          }),
          setFieldValue: vi.fn((field: string, next: unknown) => {
            values[field] = next;
            rerender();
          }),
          getInputProps: () => ({}),
          onSubmit: (submit: () => void) => (event: React.FormEvent) => {
            event.preventDefault();
            submit();
          },
        };
      });
      mocks.formValues = form.values;
      return form;
    },
  };
});
vi.mock("@mantine/core", () => ({
  Alert: ({ children }: { children: React.ReactNode }) => <div role="alert">{children}</div>,
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Checkbox: () => <input type="checkbox" />,
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
  }) => (
    <select value={value} onChange={(event) => onChange?.(event.currentTarget.value)}>
      {data.map((option) => {
        const item = typeof option === "string" ? { value: option, label: option } : option;
        return (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        );
      })}
    </select>
  ),
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
  mocks.analyzeGame.mockResolvedValue([]);
  sessionStorage.removeItem("tab-id");
  tree = createTreeStore("tab-id");
  analysisPublished = vi.spyOn(tree.getState(), "addAnalysis");
  setInProgress = vi.fn(tree.getState().setReportInProgress);
  localStorage.removeItem("report-settings");
  localStorage.setItem(
    "report-settings",
    JSON.stringify({
      novelty: true,
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

async function renderReportModal(isCurrentOperation = (_id: string, _fingerprint: string) => true) {
  await act(async () => {
    root.render(
      <Provider store={atomStore}>
        <TreeStateContext.Provider value={tree}>
          <ReportModal
            tab="tab-id"
            initialFen="start-fen"
            moves={["e2e4"]}
            reportingMode
            closeReportingMode={vi.fn()}
            setInProgress={setInProgress}
            registerOperation={tree.getState().setReportOperationId}
            isCurrentOperation={(id, fingerprint) =>
              tree.getState().report.operationId === id && isCurrentOperation(id, fingerprint)
            }
          />
        </TreeStateContext.Provider>
      </Provider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
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

const completedAnalysis: MoveAnalysis[] = [
  {
    best: [
      {
        nodes: 1n,
        depth: 1,
        score: { value: { type: "cp", value: 123 }, wdl: null },
        uciMoves: ["e2e4"],
        sanMoves: ["e4"],
        multipv: 1,
        nps: 1n,
      },
    ],
    novelty: true,
    is_sacrifice: false,
  },
];

async function startUnmountedLinkedReport() {
  selectReference({ id: { id: "reference-A" }, kind: "database" });
  const collection = linkedReference();
  mocks.collection.mockResolvedValue(collection);
  const completion = deferred<MoveAnalysis[]>();
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
  const previousGoMode = mocks.formValues!.goMode;
  expect(previousGoMode).toEqual({ t: "Time", c: 500 });
  const typeSelect = host.querySelectorAll("select")[1];

  await act(async () => {
    typeSelect.value = "Depth";
    typeSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => host.querySelector("button")!.click());

  expect(mocks.analyzeGame).toHaveBeenCalledOnce();
  expect(mocks.analyzeGame.mock.calls[0][4]).toEqual({ t: "Depth", c: 20 });
  expect(mocks.analyzeGame.mock.calls[0][4]).not.toBe(previousGoMode);
  expect(previousGoMode).toEqual({ t: "Time", c: 500 });
  const depthGoMode = mocks.analyzeGame.mock.calls[0][4];

  await act(async () => {
    typeSelect.value = "Time";
    typeSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => host.querySelector("button")!.click());

  expect(mocks.analyzeGame).toHaveBeenCalledTimes(2);
  expect(mocks.analyzeGame.mock.calls[1][4]).toEqual({ t: "Time", c: 500 });
  expect(mocks.analyzeGame.mock.calls[1][4]).not.toBe(depthGoMode);
  expect(depthGoMode).toEqual({ t: "Depth", c: 20 });
  expect(previousGoMode).toEqual({ t: "Time", c: 500 });
});

test.each(["success", "failure"])(
  "unmounted report %s reads the live Jotai selection and settles only its matching progress",
  async (outcome) => {
    const { completion } = await startUnmountedLinkedReport();
    selectReference({ id: { id: "reference-B" }, kind: "database" });
    await act(async () => {
      if (outcome === "success") completion.resolve(completedAnalysis);
      else completion.reject(new Error("obsolete A failure"));
    });
    expect(analysisPublished).not.toHaveBeenCalled();
    expect(tree.getState().root.score).toBeNull();
    expect(tree.getState().root.nags).toEqual([]);
    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
    expect(tree.getState().report.inProgress).toBe(false);
    expect(mocks.cancelAnalysis).not.toHaveBeenCalled();
  },
);

test("unchanged linked reference publishes analysis and novelty after panel unmount", async () => {
  const { completion } = await startUnmountedLinkedReport();
  const reads = mocks.collection.mock.calls.length;
  await act(async () => completion.resolve(completedAnalysis));
  expect(mocks.collection).toHaveBeenCalledTimes(reads + 1);
  expect(analysisPublished).toHaveBeenCalledExactlyOnceWith(completedAnalysis, {
    showVariations: true,
  });
  expect(tree.getState().root.score).toEqual(completedAnalysis[0].best[0].score);
  expect(tree.getState().root.nags).toHaveLength(1);
  expect(tree.getState().report.inProgress).toBe(false);
  expect(mocks.cancelAnalysis).not.toHaveBeenCalled();
});

test("current report failure after unmount still reports its first error", async () => {
  const { completion } = await startUnmountedLinkedReport();
  const failure = new Error("current A failure");
  await act(async () => completion.reject(failure));
  expect(mocks.notifyUnlessCancelled).toHaveBeenCalledExactlyOnceWith("Common.Error", failure);
  expect(tree.getState().report.inProgress).toBe(false);
});

test.each(
  [
    "generation",
    "unavailable",
    "missing",
    "database",
    "identity",
    "standalone",
    "rejected",
  ].flatMap((change) => ["success", "failure"].map((outcome) => ({ change, outcome }))),
)(
  "unmounted report $outcome validates native reference $change before publishing or notifying",
  async ({ change, outcome }) => {
    const { completion, collection } = await startUnmountedLinkedReport();
    if (change === "rejected")
      mocks.collection.mockRejectedValue(new Error("metadata unavailable"));
    else
      mocks.collection.mockResolvedValue(
        change === "standalone"
          ? null
          : {
              ...collection,
              ...(change === "generation" ? { generation: "second" } : {}),
              ...(change === "unavailable" ? { status: "unavailable" as const } : {}),
              ...(change === "missing" ? { status: "missing" as const, database: null } : {}),
              ...(change === "identity" ? { id: "replacement-collection" } : {}),
              ...(change === "database"
                ? { database: { id: { id: "replacement-database" }, kind: "database" as const } }
                : {}),
            },
      );
    await act(async () => {
      if (outcome === "success") completion.resolve(completedAnalysis);
      else completion.reject(new Error("obsolete native analysis failure"));
    });
    expect(analysisPublished).not.toHaveBeenCalled();
    expect(tree.getState().root.score).toBeNull();
    expect(tree.getState().root.nags).toEqual([]);
    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
    expect(tree.getState().report.inProgress).toBe(false);
  },
);

test.each(
  ["selection", "operation", "tab", "root"].flatMap((change) =>
    ["during", "after"].flatMap((timing) =>
      ["success", "failure"].map((outcome) => ({ change, timing, outcome })),
    ),
  ),
)(
  "report $outcome with a live $change change $timing awaited reference validation refuses publication and preserves successors",
  async ({ change, timing, outcome }) => {
    const originalRoot = tree.getState().root;
    selectReference({ id: { id: "reference-A" }, kind: "database" });
    const collection = linkedReference();
    mocks.collection.mockResolvedValue(collection);
    const completion = deferred<MoveAnalysis[]>();
    mocks.analyzeGame.mockReturnValueOnce(completion.promise);
    await renderReportModal(() => tree.getState().root === originalRoot);
    await act(async () => host.querySelector("button")!.click());
    await act(async () => root.render(<div>Database panel</div>));
    const validation = deferred<import("@/bindings").CollectionDescriptor | null>();
    mocks.collection.mockReturnValueOnce(validation.promise);
    const reads = mocks.collection.mock.calls.length;
    await act(async () => {
      if (outcome === "success") completion.resolve(completedAnalysis);
      else completion.reject(new Error("obsolete report failure"));
    });
    expect(mocks.collection).toHaveBeenCalledTimes(reads + 1);
    expect(tree.getState().report.inProgress).toBe(true);
    const changeOwner = () =>
      act(() => {
        if (change === "selection")
          selectReference({ id: { id: "reference-B" }, kind: "database" });
        if (change === "operation") tree.getState().setReportOperationId("successor-report");
        if (change === "tab") closeTreeStore("tab-id");
        if (change === "root") tree.getState().setFen("8/8/8/8/8/8/8/K6k w - - 0 1");
      });
    if (timing === "during") changeOwner();
    else void validation.promise.then(changeOwner);
    await act(async () => validation.resolve(collection));
    expect(analysisPublished).not.toHaveBeenCalled();
    expect(tree.getState().root.score).toBeNull();
    expect(tree.getState().root.nags).toEqual([]);
    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
    expect(tree.getState().report).toMatchObject({
      operationId: change === "operation" ? "successor-report" : "report_tab-id_operation-uuid",
      inProgress: change === "operation" || change === "tab",
    });
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
    expect(host.querySelector("button")!.disabled).toBe(true);
    mocks.collection.mockResolvedValue(linkedReference());
    await act(async () => poll.focus());
    expect(host.querySelector("button")!.disabled).toBe(false);
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
  "a reference %s change aborts held preparation and cancels its reservation before native dispatch",
  async (change) => {
    selectReference({ id: { id: "reference-first" }, kind: "database" });
    const collection = linkedReference();
    if (change !== "selection") mocks.collection.mockResolvedValue(collection);
    const prepared = deferred<string>();
    mocks.prepareAnalysis.mockReturnValueOnce(prepared.promise);
    const poll = collectionFocus();
    try {
      await renderReportModal();
      await act(async () => host.querySelector("button")!.click());
      expect(mocks.prepareAnalysis).toHaveBeenCalledOnce();
      const signal = mocks.prepareAnalysis.mock.calls[0][1].signal as AbortSignal;
      expect(signal.aborted).toBe(false);
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
      await act(async () => prepared.resolve("obsolete-prepared"));
      // Obsolete preparation must never dispatch native analysis.
      expect(mocks.analyzeGame).not.toHaveBeenCalled();
      // Reference changes must abort the pending preparation.
      expect(signal.aborted).toBe(true);
      expect(mocks.cancelAnalysis).toHaveBeenCalledExactlyOnceWith("obsolete-prepared");
      expect(tree.getState().report.inProgress).toBe(false);
      expect(analysisPublished).not.toHaveBeenCalled();
    } finally {
      poll.stop();
    }
  },
);

test.each(["selection", "generation"])(
  "an old reference %s cancellation cannot clear a newer report and stale completion still settles progress",
  async (change) => {
    selectReference({ id: { id: "reference-first" }, kind: "database" });
    const collection = linkedReference();
    if (change === "generation") mocks.collection.mockResolvedValue(collection);
    const poll = collectionFocus();
    try {
      const old = deferred<never[]>();
      const current = deferred<never[]>();
      const cancelled = deferred<void>();
      mocks.prepareAnalysis
        .mockResolvedValueOnce("old-reference")
        .mockResolvedValueOnce("new-reference");
      mocks.analyzeGame.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
      mocks.cancelAnalysis.mockReturnValueOnce(cancelled.promise);
      await renderReportModal();
      await act(async () => host.querySelector("button")!.click());
      expect(tree.getState().report.inProgress).toBe(true);
      if (change === "selection") {
        selectReference({ id: { id: "reference-second" }, kind: "database" });
        await renderReportModal();
      } else {
        mocks.collection.mockResolvedValue({ ...collection, generation: "second" });
        await act(async () => poll.focus());
      }
      await act(async () => old.resolve([]));
      // A result from the previous selected reference is stale.
      expect(analysisPublished).not.toHaveBeenCalled();
      // Native completion must settle progress before cancellation acknowledgement.
      expect(tree.getState().report.inProgress).toBe(false);
      await act(async () => host.querySelector("button")!.click());
      expect(tree.getState().report).toMatchObject({
        inProgress: true,
        operationId: "new-reference",
      });
      await act(async () => cancelled.resolve());
      expect(tree.getState().report.inProgress).toBe(true);
      await act(async () => current.resolve([]));
      expect(analysisPublished).toHaveBeenCalledOnce();
      expect(tree.getState().report.inProgress).toBe(false);
      expect(mocks.cancelAnalysis).toHaveBeenCalledExactlyOnceWith("old-reference");
    } finally {
      poll.stop();
    }
  },
);

test.each(["selection", "generation"])(
  "a reference %s change preserves the successor while obsolete preparation is still held",
  async (change) => {
    selectReference({ id: { id: "reference-first" }, kind: "database" });
    const collection = linkedReference();
    if (change === "generation") mocks.collection.mockResolvedValue(collection);
    const prepared = deferred<string>();
    const current = deferred<never[]>();
    mocks.prepareAnalysis
      .mockReturnValueOnce(prepared.promise)
      .mockResolvedValueOnce("current-ticket");
    mocks.analyzeGame.mockReturnValueOnce(current.promise);
    const poll = collectionFocus();
    try {
      await renderReportModal();
      await act(async () => host.querySelector("button")!.click());
      if (change === "selection") {
        selectReference({ id: { id: "reference-second" }, kind: "database" });
        await renderReportModal();
      } else {
        mocks.collection.mockResolvedValue({ ...collection, generation: "second" });
        await act(async () => poll.focus());
      }
      await act(async () => host.querySelector("button")!.click());
      expect(tree.getState().report).toMatchObject({
        inProgress: true,
        operationId: "current-ticket",
      });
      await act(async () => prepared.resolve("obsolete-prepared"));
      expect(mocks.analyzeGame).toHaveBeenCalledExactlyOnceWith(
        "current-ticket",
        "tab-id",
        mocks.engines[0].handle,
        "engine-id",
        { t: "Time", c: 500 },
        expect.objectContaining({
          referenceDb: atomStore.get(referenceDbAtom),
          fen: "start-fen",
          moves: ["e2e4"],
        }),
        [],
      );
      expect(mocks.prepareAnalysis.mock.calls[0][1].signal.aborted).toBe(true);
      expect(mocks.cancelAnalysis).toHaveBeenCalledExactlyOnceWith("obsolete-prepared");
      expect(tree.getState().report.inProgress).toBe(true);
      await act(async () => current.resolve([]));
      expect(analysisPublished).toHaveBeenCalledOnce();
      expect(setInProgress.mock.calls.map(([value]) => value)).toEqual([true, false]);
      expect(tree.getState().report.inProgress).toBe(false);
    } finally {
      poll.stop();
    }
  },
);

test("Analyze withholds preparation until reference currency is known and shows an unavailable check failure", async () => {
  selectReference({ id: { id: "reference" }, kind: "database" });
  const check = deferred<import("@/bindings").CollectionDescriptor | null>();
  mocks.collection.mockReturnValueOnce(check.promise);
  await renderReportModal();
  // Analyze must wait for a current reference.
  expect(host.querySelector("button")!.disabled).toBe(true);
  await act(async () => check.reject(new Error("reference currency failed")));
  expect(host.textContent).toContain("Collections.Unavailable");
  expect(host.querySelector("button")!.disabled).toBe(true);
  expect(mocks.prepareAnalysis).not.toHaveBeenCalled();
  expect(mocks.notifyUnlessCancelled).toHaveBeenCalledWith(
    "Common.Error",
    expect.objectContaining({ message: "reference currency failed" }),
  );
});

test.each(["generation", "preservedOriginal"] as const)(
  "a linked reference %s change cancels the active report and rejects its late analysis",
  async (change) => {
    selectReference({ id: { id: "linked-reference" }, kind: "database" });
    const collection: import("@/bindings").CollectionDescriptor = {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Reference",
      file: { id: { id: "source" }, kind: "fileWorkspace" },
      database: atomStore.get(referenceDbAtom),
      status: "ready",
      generation: "first",
      omitted: 0,
      account: null,
      retiredDatabase: null,
      fetchSinceMs: null,
    };
    mocks.collection.mockResolvedValue(collection);
    mocks.cancelAnalysis.mockResolvedValue(undefined);
    const analysis = deferred<never[]>();
    mocks.analyzeGame.mockReturnValueOnce(analysis.promise);
    let focus!: () => void;
    const stop = startFileRevisionPoll({
      getTabs: () => [],
      fileRevision: vi.fn(),
      subscribeFocus: (callback) => {
        focus = callback;
        return () => undefined;
      },
    });
    try {
      await renderReportModal();
      await act(async () => {
        host.querySelector("button")!.click();
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(mocks.analyzeGame).toHaveBeenCalledOnce();
      expect(mocks.cancelAnalysis).not.toHaveBeenCalled();
      mocks.collection.mockResolvedValue(
        change === "generation"
          ? { ...collection, generation: "second" }
          : { ...collection, status: "preservedOriginal", database: null },
      );
      await act(async () => {
        focus();
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(mocks.cancelAnalysis).toHaveBeenCalledExactlyOnceWith("report_tab-id_operation-uuid");
      await act(async () => analysis.resolve([]));
      expect(analysisPublished).not.toHaveBeenCalled();
      expect(setInProgress).toHaveBeenLastCalledWith(false);
      expect(tree.getState().report.inProgress).toBe(false);
    } finally {
      stop();
    }
  },
);

test("P2 report replacement suppresses old failures and the current typed failure shows its safe reason", async () => {
  const old = deferred<never[]>();
  const current = deferred<never[]>();
  let currentId = "old";
  mocks.prepareAnalysis.mockResolvedValueOnce("old").mockResolvedValueOnce("current");
  mocks.analyzeGame.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  await renderReportModal((id) => id === currentId);
  await act(async () => {
    host.querySelector("button")!.click();
    await Promise.resolve();
  });
  currentId = "current";
  await act(async () => {
    host.querySelector("button")!.click();
    await Promise.resolve();
  });
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
  await act(async () => current.reject(failure));
  expect(mocks.notifyUnlessCancelled).toHaveBeenCalledExactlyOnceWith(
    "Common.Error",
    expect.objectContaining({ message: "Safe report failure" }),
  );
});

test("P2 changed root fingerprint suppresses the report failure notification", async () => {
  const result = deferred<never[]>();
  mocks.analyzeGame.mockReturnValueOnce(result.promise);
  let rootMatches = true;
  await renderReportModal(
    (_id, fingerprint) => rootMatches && fingerprint === "start-fen\u0000e2e4",
  );
  await act(async () => {
    host.querySelector("button")!.click();
    await Promise.resolve();
  });
  rootMatches = false;
  await act(async () => result.reject(new Error("obsolete root")));
  expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
});

test("P2 superseded preparation rejection does not notify against the newer report", async () => {
  const old = deferred<string>();
  mocks.prepareAnalysis.mockReturnValueOnce(old.promise).mockResolvedValueOnce("current");
  mocks.analyzeGame.mockResolvedValue([]);
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
  mocks.analyzeGame.mockResolvedValue([]);
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
  const completion = deferred<never[]>();
  mocks.analyzeGame.mockReturnValueOnce(completion.promise);
  await renderReportModal();
  await act(async () => {
    host.querySelector("button")!.click();
    await Promise.resolve();
    root.render(<div />);
  });
  await act(async () => completion.resolve([]));
  expect(analysisPublished).toHaveBeenCalledOnce();

  const afterClose = deferred<never[]>();
  mocks.analyzeGame.mockReturnValueOnce(afterClose.promise);
  await renderReportModal();
  await act(async () => {
    host.querySelector("button")!.click();
    await Promise.resolve();
    invalidateReportOwner("tab-id");
    afterClose.resolve([]);
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
  mocks.analyzeGame.mockResolvedValue([]);
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
    expect.objectContaining({ fen: "start-fen", moves: ["e2e4"] }),
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
  mocks.analyzeGame.mockResolvedValue([]);

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
    reversed: false,
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
  mocks.analyzeGame.mockResolvedValue([]);

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

test("reports a quota-failed settings save while still starting the report", async () => {
  const quota = new DOMException("Storage quota exceeded", "QuotaExceededError");
  const originalSetItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    if (key === "report-settings") throw quota;
    return Reflect.apply(originalSetItem, this, [key, value]);
  });
  mocks.analyzeGame.mockResolvedValue([]);

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
