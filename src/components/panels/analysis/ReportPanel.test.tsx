import { WorkspaceTabScope } from "@/state/tabScope";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { tabStorage } from "@/state/store/tabStorage";
import {
  closeTreeStore,
  createTreeStore,
  invalidateReportOwner,
  restoreReportOwner,
  type TreeStore,
} from "@/state/store/tree";
import { getMainLine } from "@/utils/chess";
import ReportPanel from "./ReportPanel";

const mocks = vi.hoisted(() => ({
  activeTabAtom: Symbol("activeTabAtom"),
  enginesAtom: Symbol("enginesAtom"),
  referenceDbAtom: Symbol("referenceDbAtom"),
  reportModalOpenAtom: Symbol("reportModalOpenAtom"),
  reportSettingsAtom: Symbol("reportSettingsAtom"),
  cancelAnalysis: vi.fn(),
  getProgress: vi.fn(),
  startProgress: vi.fn(),
  analyzeGame: vi.fn(),
  prepareAnalysis: vi.fn(),
  notifyUnlessCancelled: vi.fn(),
  setReportingMode: vi.fn(),
  setReportSettings: vi.fn(),
  reportingMode: false,
  progressId: undefined as string | undefined,
  progress: {
    finished: false,
    progress: 0,
    isActive: false,
    item: null as null,
    clear: vi.fn(),
  },
  progressButtonProps: null as null | {
    id: string;
    completeOnProgressSuccess?: boolean;
    onCancel?: () => void | Promise<void>;
  },
  reportModalProps: null as null | {
    registerOperation: (id: string) => void;
    isCurrentOperation: (id: string, fingerprint: string) => boolean;
  },
  reportSettings: {
    novelty: false,
    reversed: false,
    variations: true,
    goMode: { t: "Time" as const, c: 500 },
    engine: "engine-id",
  },
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
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/useProgress", () => ({
  useProgress: (id: string) => {
    mocks.progressId = id;
    return mocks.progress;
  },
}));
vi.mock("@/platform/tauri", () => ({
  tauri: {
    cancelAnalysis: mocks.cancelAnalysis,
    getProgress: mocks.getProgress,
    startProgress: mocks.startProgress,
    analyzeGame: mocks.analyzeGame,
    prepareAnalysis: mocks.prepareAnalysis,
  },
}));
vi.mock("@/state/atoms", async () => ({
  activeTabAtom: mocks.activeTabAtom,
  reportModalOpenFamily: () => mocks.reportModalOpenAtom,
  enginesAtom: mocks.enginesAtom,
  referenceDbAtom: (await import("jotai")).atom(null),
}));
vi.mock("jotai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jotai")>()),
  useAtomValue: (atom: symbol) => {
    if (atom === mocks.activeTabAtom) return "tab-1";
    if (atom === mocks.enginesAtom) return mocks.engines;
    if (atom === mocks.referenceDbAtom) return null;
    return undefined;
  },
  useAtom: (atom: symbol) => {
    if (atom === mocks.reportModalOpenAtom) return [mocks.reportingMode, mocks.setReportingMode];
    return [mocks.reportSettings, mocks.setReportSettings];
  },
}));
vi.mock("jotai/utils", () => ({ atomWithStorage: () => mocks.reportSettingsAtom }));
vi.mock("@/components/files/notifyError", () => ({
  notifyUnlessCancelled: mocks.notifyUnlessCancelled,
}));
vi.mock("@/components/common/EvalChart", () => ({ default: () => null }));
vi.mock("@/components/common/ProgressButton", () => ({
  default: (props: {
    id: string;
    completeOnProgressSuccess?: boolean;
    onCancel?: () => void | Promise<void>;
  }) => {
    mocks.progressButtonProps = props;
    return (
      <button type="button" onClick={props.onCancel}>
        progress
      </button>
    );
  },
}));
vi.mock("./ReportModal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ReportModal")>();
  const Actual = actual.default;
  return {
    ...actual,
    default: (props: {
      registerOperation: (id: string) => void;
      isCurrentOperation: (id: string, fingerprint: string) => boolean;
    }) => {
      mocks.reportModalProps = props;
      return <Actual {...(props as any)} />;
    },
  };
});
vi.mock("@mantine/form", () => ({
  useForm: () => ({
    values: mocks.reportSettings,
    getValues: () => mocks.reportSettings,
    setValues: vi.fn(),
    setFieldValue: vi.fn(),
    getInputProps: () => ({}),
    onSubmit: (submit: () => void) => (event: React.FormEvent) => {
      event.preventDefault();
      submit();
    },
  }),
}));
vi.mock("../../common/AppModal", () => ({
  default: ({ children, opened }: { children: React.ReactNode; opened: boolean }) =>
    opened ? <div>{children}</div> : null,
}));
vi.mock("@mantine/core", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Checkbox: () => <input type="checkbox" />,
  Grid: Object.assign(({ children }: { children: React.ReactNode }) => <div>{children}</div>, {
    Col: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  }),
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  NumberInput: () => <input type="number" />,
  Paper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Select: () => <select />,
  Stack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("lucide-react", () => ({ ScanSearch: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type ProgressItem = {
  id: string;
  generation: bigint;
  progress: number;
  finished: boolean;
  state: "running" | "succeeded" | "failed" | "cancelled";
};

function runningItem(id: string): ProgressItem {
  return { id, generation: 1n, progress: 40, finished: false, state: "running" };
}

function finishedItem(id: string): ProgressItem {
  return { id, generation: 2n, progress: 100, finished: true, state: "succeeded" };
}

function fingerprintOf(store: TreeStore) {
  const root = store.getState().root;
  return `${root.fen}\u0000${getMainLine(root).join("\u0000")}`;
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

test.each(["replacement", "root"])(
  "P2 an old progress failure cannot notify after %s",
  async (change) => {
    const lookup = deferred<null>();
    mocks.getProgress.mockReturnValueOnce(lookup.promise);
    store.getState().setReportOperationId("old");
    store.getState().setReportInProgress(true);
    await renderPanel();
    await act(async () => {
      if (change === "replacement") store.getState().setReportOperationId("current");
      else store.getState().setFen("8/8/8/8/8/8/8/K6k w - - 0 1");
      lookup.reject(new Error("obsolete lookup"));
    });
    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
  },
);

test("P2 a late cancel failure cannot notify against its successor", async () => {
  const cancellation = deferred<void>();
  mocks.cancelAnalysis.mockReturnValueOnce(cancellation.promise);
  await renderPanel();
  await act(async () => {
    mocks.reportModalProps!.registerOperation("old");
    store.getState().setReportInProgress(true);
  });
  const outcome = Promise.resolve(mocks.progressButtonProps!.onCancel!()).catch(() => undefined);
  await act(async () => {
    store.getState().setReportOperationId("current");
    cancellation.reject(new Error("obsolete cancellation"));
    await outcome;
  });
  expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
  expect(store.getState().report.operationId).toBe("current");
});

test.each(["replacement", "root"])(
  "P2 the actual report owner rejects old analysis failures after %s",
  async (change) => {
    mocks.reportingMode = true;
    const old = deferred<never[]>();
    const current = deferred<never[]>();
    mocks.prepareAnalysis
      .mockResolvedValueOnce("old-report")
      .mockResolvedValueOnce("current-report");
    mocks.analyzeGame.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await renderPanel();
    await act(async () => {
      host.querySelector<HTMLButtonElement>("button[type='submit']")!.click();
      await Promise.resolve();
    });
    expect(mocks.analyzeGame.mock.calls.map(([id]) => id)).toEqual(["old-report"]);
    expect(store.getState().report).toMatchObject({ operationId: "old-report", inProgress: true });
    await act(async () => {
      if (change === "replacement")
        host.querySelector<HTMLButtonElement>("button[type='submit']")!.click();
      else store.getState().setFen("8/8/8/8/8/8/8/K6k w - - 0 1");
      await Promise.resolve();
    });
    expect(mocks.analyzeGame.mock.calls.map(([id]) => id)).toEqual(
      change === "replacement" ? ["old-report", "current-report"] : ["old-report"],
    );
    const failure = {
      tag: "engine-failure",
      category: "engine-failure",
      message: "Engine terminated",
      engineFailure: {
        kind: "protocol-failure",
        exitStatus: null,
        reason: "Safe report reason",
        entries: [],
      },
    };
    await act(async () => old.reject(failure));
    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
    expect(store.getState().report.operationId).toBe(
      change === "replacement" ? "current-report" : "old-report",
    );
    expect(store.getState().report.inProgress).toBe(change === "replacement");
    if (change === "replacement") await act(async () => current.reject(failure));
    expect(mocks.notifyUnlessCancelled.mock.calls.map(([_title, cause]) => cause.message)).toEqual(
      change === "replacement" ? ["Safe report reason"] : [],
    );
    expect(store.getState().report.inProgress).toBe(false);
  },
);

const completedAnalysis = [
  {
    best: [
      {
        nodes: 1n,
        depth: 1,
        score: { value: { type: "cp" as const, value: 123 }, wdl: null },
        uciMoves: ["e2e4"],
        sanMoves: ["e4"],
        multipv: 1,
        nps: 1n,
      },
    ],
    novelty: false,
    is_sacrifice: false,
  },
];

let host: HTMLDivElement;
let root: Root;
let store: TreeStore;

async function renderPanel() {
  await act(async () => {
    root.render(
      <TreeStateContext.Provider value={store}>
        <WorkspaceTabScope tabId={"tab-1"}>
          <ReportPanel />
        </WorkspaceTabScope>
      </TreeStateContext.Provider>,
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of [
    mocks.prepareAnalysis,
    mocks.analyzeGame,
    mocks.getProgress,
    mocks.cancelAnalysis,
  ])
    mock.mockReset();
  mocks.prepareAnalysis.mockResolvedValue("report_tab-1_operation-uuid");
  mocks.reportingMode = false;
  mocks.progressId = undefined;
  mocks.progress.finished = false;
  mocks.progress.progress = 0;
  mocks.progress.isActive = false;
  mocks.progress.item = null;
  mocks.progressButtonProps = null;
  mocks.reportModalProps = null;
  mocks.getProgress.mockResolvedValue(null);
  mocks.analyzeGame.mockResolvedValue([]);
  vi.stubGlobal("crypto", { randomUUID: () => "operation-uuid" });
  store = createTreeStore();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  tabStorage.flush();
  tabStorage.remove("tab-1");
  closeTreeStore("tab-1");
});

test("ProgressButton subscribes to the registered operation id without treating success as complete", async () => {
  await renderPanel();
  expect(mocks.progressButtonProps?.id).toBe("report_tab-1");
  expect(mocks.progressButtonProps?.completeOnProgressSuccess).toBe(false);

  await act(async () => {
    mocks.reportModalProps!.registerOperation("report_tab-1_uuid");
  });

  expect(mocks.progressButtonProps?.id).toBe("report_tab-1_uuid");
  expect(mocks.progressButtonProps?.completeOnProgressSuccess).toBe(false);
});

test("cancel after remount against the same tree store cancels the registered id", async () => {
  await renderPanel();
  await act(async () => {
    mocks.reportModalProps!.registerOperation("report_tab-1_uuid");
  });

  await act(async () => root.unmount());
  root = createRoot(host);
  await renderPanel();

  expect(mocks.progressButtonProps?.id).toBe("report_tab-1_uuid");
  await act(async () => {
    mocks.progressButtonProps?.onCancel?.();
  });
  expect(mocks.cancelAnalysis).toHaveBeenCalledWith("report_tab-1_uuid");
  expect(store.getState().report.operationId).toBeNull();
  expect(store.getState().report.inProgress).toBe(false);
});

test("cancel after a board-tab provider remount uses the stable registered report owner", async () => {
  store = createTreeStore("tab-1");
  const firstStore = store;
  await renderPanel();
  await act(async () => {
    mocks.reportModalProps!.registerOperation("report_tab-1_uuid");
  });
  tabStorage.flush();

  await act(async () => root.unmount());
  store = createTreeStore("tab-1");
  expect(store).toBe(firstStore);
  root = createRoot(host);
  await renderPanel();

  expect(mocks.progressButtonProps?.id).toBe("report_tab-1_uuid");
  await act(async () => {
    mocks.progressButtonProps?.onCancel?.();
  });
  expect(mocks.cancelAnalysis).toHaveBeenCalledWith("report_tab-1_uuid");
});

test("cancel rejection retains the active report and reports the failure once", async () => {
  const failure = new Error("cancel failed");
  mocks.cancelAnalysis.mockRejectedValueOnce(failure);
  await renderPanel();
  await act(async () => {
    mocks.reportModalProps!.registerOperation("report_tab-1_uuid");
    store.getState().setReportInProgress(true);
  });

  await expect(Promise.resolve(mocks.progressButtonProps!.onCancel!())).rejects.toBe(failure);
  expect(store.getState().report.operationId).toBe("report_tab-1_uuid");
  expect(store.getState().report.inProgress).toBe(true);
  expect(mocks.notifyUnlessCancelled).toHaveBeenCalledOnce();
  expect(mocks.notifyUnlessCancelled).toHaveBeenCalledWith("Common.Error", failure);
});

test("report failure shows the snapshot reason and the cleanup warning", async () => {
  const failure = {
    tag: "engine-failure",
    category: "operation-and-cleanup",
    message: "Engine failed. Temporary cleanup also failed",
    engineFailure: {
      kind: "process-exit",
      exitStatus: null,
      reason: "Safe engine reason",
      entries: [],
    },
  };
  mocks.cancelAnalysis.mockRejectedValueOnce(failure);
  await renderPanel();
  await act(async () => {
    mocks.reportModalProps!.registerOperation("report_tab-1_uuid");
    store.getState().setReportInProgress(true);
  });
  await expect(Promise.resolve(mocks.progressButtonProps!.onCancel!())).rejects.toBe(failure);
  expect(mocks.notifyUnlessCancelled).toHaveBeenCalledWith(
    "Common.Error",
    expect.objectContaining({
      message: "Safe engine reason Board.Analysis.EngineCleanupFailed",
    }),
  );
});

test("a late cancel acknowledgement cannot clear a replacement report", async () => {
  let acknowledge: () => void = () => undefined;
  mocks.cancelAnalysis.mockReturnValueOnce(new Promise<void>((resolve) => (acknowledge = resolve)));
  await renderPanel();
  await act(async () => {
    mocks.reportModalProps!.registerOperation("report-A");
    store.getState().setReportInProgress(true);
  });

  const cancellation = Promise.resolve(mocks.progressButtonProps!.onCancel!());
  await act(async () => {
    store.getState().setReportOperationId("report-B");
    acknowledge();
    await cancellation;
  });
  expect(store.getState().report.operationId).toBe("report-B");
  expect(store.getState().report.inProgress).toBe(true);
});

test("isCurrentOperation reads the live store, not a render snapshot", async () => {
  await renderPanel();
  const isCurrent = mocks.reportModalProps!.isCurrentOperation;
  const fingerprint = fingerprintOf(store);

  await act(async () => {
    mocks.reportModalProps!.registerOperation("report_tab-1_uuid");
  });

  expect(isCurrent("report_tab-1_uuid", fingerprint)).toBe(true);
  expect(isCurrent("report_other", fingerprint)).toBe(false);
  expect(isCurrent("report_tab-1_uuid", "different-fingerprint")).toBe(false);

  await act(async () => root.unmount());
  root = createRoot(host);
  await renderPanel();
  store.getState().setFen("8/8/8/8/8/8/8/K6k w - - 0 1");
  expect(isCurrent("report_tab-1_uuid", fingerprint)).toBe(false);
});

test("a finished progress item clears inProgress while leaving the operation id", async () => {
  await renderPanel();
  await act(async () => {
    mocks.reportModalProps!.registerOperation("op-1");
    store.getState().setReportInProgress(true);
  });

  mocks.progress.finished = true;
  await renderPanel();

  expect(mocks.progressId).toBe("op-1");
  expect(store.getState().report.inProgress).toBe(false);
  expect(store.getState().report.operationId).toBe("op-1");
});

test("inProgress with no operationId is treated as not running", async () => {
  store.getState().setReportInProgress(true);
  await renderPanel();
  await act(async () => {
    await Promise.resolve();
  });

  expect(store.getState().report.inProgress).toBe(false);
  expect(store.getState().report.operationId).toBeNull();
  expect(mocks.getProgress).not.toHaveBeenCalled();
});

test("a finished progress lookup keeps report identity until result publication", async () => {
  mocks.getProgress.mockResolvedValue(finishedItem("op-1"));
  store.getState().setReportOperationId("op-1");
  store.getState().setReportInProgress(true);

  await renderPanel();
  await act(async () => {
    await Promise.resolve();
  });

  expect(store.getState().report.inProgress).toBe(false);
  expect(store.getState().report.operationId).toBe("op-1");
});

test("an absent progress lookup leaves a running report intact", async () => {
  mocks.getProgress.mockResolvedValue(null);
  store.getState().setReportOperationId("op-1");
  store.getState().setReportInProgress(true);

  await renderPanel();
  await act(async () => {
    await Promise.resolve();
  });

  expect(store.getState().report.inProgress).toBe(true);
  expect(store.getState().report.operationId).toBe("op-1");
});

test("a running progress lookup leaves a running report intact", async () => {
  mocks.getProgress.mockResolvedValue(runningItem("op-1"));
  store.getState().setReportOperationId("op-1");
  store.getState().setReportInProgress(true);

  await renderPanel();
  await act(async () => {
    await Promise.resolve();
  });

  expect(store.getState().report.inProgress).toBe(true);
  expect(store.getState().report.operationId).toBe("op-1");
});

test("a rejected progress lookup leaves a running report intact", async () => {
  mocks.getProgress.mockRejectedValue(new Error("lookup failed"));
  store.getState().setReportOperationId("op-1");
  store.getState().setReportInProgress(true);

  await renderPanel();
  await act(async () => {
    await Promise.resolve();
  });

  expect(store.getState().report.inProgress).toBe(true);
  expect(store.getState().report.operationId).toBe("op-1");
});

test("a lookup for operation A that resolves after B is current does not clear B", async () => {
  let resolveA: (value: ProgressItem) => void = () => undefined;
  mocks.getProgress.mockImplementation((id: string) => {
    if (id === "op-A") {
      return new Promise<ProgressItem>((resolve) => {
        resolveA = resolve;
      });
    }
    return Promise.resolve(runningItem(id));
  });
  store.getState().setReportOperationId("op-A");
  store.getState().setReportInProgress(true);

  await renderPanel();
  await act(async () => {
    store.getState().setReportOperationId("op-B");
  });
  await act(async () => {
    resolveA(finishedItem("op-A"));
    await Promise.resolve();
  });

  expect(store.getState().report.operationId).toBe("op-B");
  expect(store.getState().report.inProgress).toBe(true);
});

test("ReportModal does not take a progress lease when starting analysis", async () => {
  mocks.reportingMode = true;
  await renderPanel();
  await act(async () => {
    host.querySelector<HTMLButtonElement>("button[type='submit']")!.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mocks.analyzeGame).toHaveBeenCalled();
  expect(mocks.startProgress).not.toHaveBeenCalled();
  expect(store.getState().report.operationId).toBe("report_tab-1_operation-uuid");
});

test("report completion waits for a pending close that rejects, then settles the live store", async () => {
  const completion = deferred<typeof completedAnalysis>();
  mocks.reportingMode = true;
  mocks.analyzeGame.mockReturnValueOnce(completion.promise);
  store = createTreeStore("tab-1");
  await renderPanel();
  await act(async () => {
    host.querySelector<HTMLButtonElement>("button[type='submit']")!.click();
    await Promise.resolve();
  });
  const close = invalidateReportOwner("tab-1");

  await act(async () => {
    completion.resolve(completedAnalysis);
    await Promise.resolve();
  });
  expect(store.getState().root.score).toBeNull();
  expect(store.getState().report.inProgress).toBe(true);

  await act(async () => {
    restoreReportOwner("tab-1", close);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(store.getState().root.score).toEqual(completedAnalysis[0].best[0].score);
  expect(store.getState().report.inProgress).toBe(false);
});

test("report completion waits for a pending close that succeeds, then discards the result", async () => {
  const completion = deferred<typeof completedAnalysis>();
  mocks.reportingMode = true;
  mocks.analyzeGame.mockReturnValueOnce(completion.promise);
  store = createTreeStore("tab-1");
  await renderPanel();
  await act(async () => {
    host.querySelector<HTMLButtonElement>("button[type='submit']")!.click();
    await Promise.resolve();
  });
  invalidateReportOwner("tab-1");

  await act(async () => {
    completion.resolve(completedAnalysis);
    await Promise.resolve();
  });
  expect(store.getState().root.score).toBeNull();

  await act(async () => {
    closeTreeStore("tab-1");
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(store.getState().root.score).toBeNull();
  expect(createTreeStore("tab-1")).not.toBe(store);
});

test("close between rollback decision and report continuation cannot republish the result", async () => {
  const completion = deferred<typeof completedAnalysis>();
  mocks.reportingMode = true;
  mocks.analyzeGame.mockReturnValueOnce(completion.promise);
  store = createTreeStore("tab-1");
  await renderPanel();
  await act(async () => {
    host.querySelector<HTMLButtonElement>("button[type='submit']")!.click();
    await Promise.resolve();
  });
  const close = invalidateReportOwner("tab-1");
  await act(async () => {
    completion.resolve(completedAnalysis);
    await Promise.resolve();
  });

  await act(async () => {
    restoreReportOwner("tab-1", close);
    queueMicrotask(() => closeTreeStore("tab-1"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(store.getState().root.score).toBeNull();
  expect(createTreeStore("tab-1")).not.toBe(store);
});
