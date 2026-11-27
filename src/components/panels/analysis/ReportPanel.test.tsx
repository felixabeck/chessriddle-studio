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
import ReportPanel from "./ReportPanel";
import { getMainLine, reportRootFingerprint } from "@/utils/chess";
import type { GameAnalysis } from "@/bindings";

const mocks = vi.hoisted(() => ({
  t: vi.fn((key: string, _options?: Record<string, unknown>) => key),
  activeTabAtom: Symbol("activeTabAtom"),
  enginesAtom: Symbol("enginesAtom"),
  referenceDbAtom: Symbol("referenceDbAtom"),
  reportModalOpenAtom: Symbol("reportModalOpenAtom"),
  reviewFocusAtom: Symbol("reviewFocusAtom"),
  reportSettingsAtom: Symbol("reportSettingsAtom"),
  cancelAnalysis: vi.fn(),
  getProgress: vi.fn(),
  startProgress: vi.fn(),
  analyzeGame: vi.fn(),
  prepareAnalysis: vi.fn(),
  notifyUnlessCancelled: vi.fn(),
  setReportingMode: vi.fn(),
  setReviewFocus: vi.fn(),
  setReportSettings: vi.fn(),
  reportingMode: false,
  reviewFocus: null as unknown,
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
  },
  reportSettings: {
    novelty: false,
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

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t, i18n: { language: "en-US" } }),
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
    getOpeningFromFens: vi.fn().mockResolvedValue(""),
    coachAvailable: vi.fn().mockResolvedValue(false),
    coachHasConnection: vi.fn().mockResolvedValue(false),
  },
}));
vi.mock("@/state/atoms", async () => {
  const { atom } = await import("jotai");
  return {
    activeTabAtom: mocks.activeTabAtom,
    reportModalOpenFamily: () => mocks.reportModalOpenAtom,
    matchesReviewFocus: () => false,
    reviewFocusFamily: () => mocks.reviewFocusAtom,
    coachExplainRequestFamily: () => atom(null),
    enginesAtom: mocks.enginesAtom,
    referenceDbAtom: atom(null),
    fileWorkspaceAtom: atom(null),
    sessionsAtom: atom([]),
  };
});
vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  return {
    ...actual,
    useAtomValue: (target: unknown) => {
      if (target === mocks.activeTabAtom) return "tab-1";
      if (target === mocks.enginesAtom) return mocks.engines;
      if (typeof target === "symbol") return undefined;
      return actual.useAtomValue(target as Parameters<typeof actual.useAtomValue>[0]);
    },
    useAtom: (target: unknown) => {
      if (target === mocks.reportModalOpenAtom)
        return [mocks.reportingMode, mocks.setReportingMode];
      if (target === mocks.reviewFocusAtom) return [mocks.reviewFocus, mocks.setReviewFocus];
      return [mocks.reportSettings, mocks.setReportSettings];
    },
  };
});
vi.mock("jotai/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jotai/utils")>()),
  atomWithStorage: () => mocks.reportSettingsAtom,
}));
vi.mock("@/state/repertoireIndex", () => ({
  refreshRepertoireIndex: vi.fn().mockResolvedValue(undefined),
  readRepertoireIndex: vi.fn().mockReturnValue(null),
}));
vi.mock("@/state/stripTab", () => ({
  selectStripTab: vi.fn(),
}));
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
    default: (props: { registerOperation: (id: string) => void }) => {
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
type Box = { children?: React.ReactNode; "data-testid"?: string };
type BoxTag = "div" | "span" | "table" | "thead" | "tbody" | "tr" | "th" | "td";
// Hoisted with the module mocks that use it.
const box = vi.hoisted(() => (Tag: BoxTag) => ({ children, "data-testid": testId }: Box) => (
  <Tag data-testid={testId}>{children}</Tag>
));
vi.mock("@mantine/core", () => ({
  Alert: box("div"),
  Button: ({
    children,
    variant: _variant,
    size: _size,
    leftSection: _leftSection,
    rightSection: _rightSection,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    size?: string;
    leftSection?: React.ReactNode;
    rightSection?: React.ReactNode;
  }) => <button {...props}>{children}</button>,
  Checkbox: () => <input type="checkbox" />,
  Grid: Object.assign(({ children }: { children: React.ReactNode }) => <div>{children}</div>, {
    Col: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  }),
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  NumberInput: () => <input type="number" />,
  Paper: box("div"),
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SegmentedControl: ({
    data,
    value,
    onChange,
  }: {
    data: { value: string; label: string }[];
    value: string;
    onChange?: (value: string) => void;
  }) => (
    <div>
      {data.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={value === item.value}
          onClick={() => onChange?.(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
  Select: () => <select />,
  Stack: box("div"),
  Table: Object.assign(box("table"), {
    Thead: box("thead"),
    Tbody: box("tbody"),
    Tr: box("tr"),
    Th: box("th"),
    Td: box("td"),
  }),
  Text: box("span"),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  UnstyledButton: ({
    children,
    c: _c,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { c?: string }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  VisuallyHidden: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/components/common/iconCatalog", () => ({
  AiChatIcon: () => null,
}));
vi.mock("lucide-react", () => ({
  ChevronLeft: () => null,
  ChevronRight: () => null,
  Info: () => null,
  RotateCcw: () => null,
  ScanSearch: () => null,
}));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));

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
  "with the actual owner, a %s during a run starts nothing new and stays correct",
  async (change) => {
    mocks.reportingMode = true;
    const old = deferred<GameAnalysis>();
    mocks.prepareAnalysis.mockResolvedValueOnce("old-report");
    mocks.analyzeGame.mockReturnValueOnce(old.promise);
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
    // A second submit is refused; a changed game cancels the run at once.
    expect(mocks.prepareAnalysis).toHaveBeenCalledOnce();
    expect(mocks.analyzeGame.mock.calls.map(([id]) => id)).toEqual(["old-report"]);
    expect(mocks.cancelAnalysis.mock.calls.map(([id]) => id)).toEqual(
      change === "root" ? ["old-report"] : [],
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
    expect(mocks.notifyUnlessCancelled.mock.calls.map(([_title, cause]) => cause.message)).toEqual(
      change === "replacement" ? ["Safe report reason"] : [],
    );
    expect(store.getState().report.operationId).toBe("old-report");
    expect(store.getState().report.inProgress).toBe(false);
  },
);

const completedAnalysis: GameAnalysis = {
  positions: [
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
      terminal: null,
      isSacrifice: false,
    },
  ],
  novelty: { kind: "notRequested" },
};

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
  mocks.analyzeGame.mockResolvedValue({ positions: [], novelty: { kind: "notRequested" } });
  vi.stubGlobal("crypto", { randomUUID: () => "operation-uuid" });
  store = createTreeStore();
  // A game with one move: the Report tab offers a report only for a game with moves.
  store.getState().makeMoves({ payload: ["e4"] });
  store.getState().goToStart();
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

test("annotation counts are labelled buttons that jump to the move; zero counts are plain text", async () => {
  // 1. e4 e5?? 2. Nf3?? Nc6 3. Bb5?? — two White blunders, one Black blunder.
  store.getState().reset();
  store.getState().makeMoves({ payload: ["e4", "e5", "Nf3", "Nc6", "Bb5"], mainline: true });
  for (const path of [
    [0, 0],
    [0, 0, 0],
    [0, 0, 0, 0, 0],
  ]) {
    store.getState().goToMove(path);
    store.getState().setAnnotation("??");
  }
  store.getState().goToStart();
  await renderPanel();

  const white = host.querySelector<HTMLButtonElement>(
    "button[aria-label='Board.Analysis.NextAnnotationByWhite']",
  );
  const black = host.querySelector<HTMLButtonElement>(
    "button[aria-label='Board.Analysis.NextAnnotationByBlack']",
  );
  expect(white?.textContent).toBe("2");
  expect(black?.textContent).toBe("1");
  expect(mocks.t).toHaveBeenCalledWith("Board.Analysis.NextAnnotationByWhite", {
    annotation: "Annotate.Blunder",
    total: 2,
  });
  expect(mocks.t).toHaveBeenCalledWith("Board.Analysis.NextAnnotationByBlack", {
    annotation: "Annotate.Blunder",
    total: 1,
  });
  // The ten zero counts (five other annotations, both sides) are text, never controls.
  const buttons = [...host.querySelectorAll("button")];
  expect(buttons.filter((button) => button.textContent === "0")).toEqual([]);
  expect(
    buttons.filter((button) =>
      button.getAttribute("aria-label")?.startsWith("Board.Analysis.NextAnnotation"),
    ),
  ).toHaveLength(2);
  expect(
    [...host.querySelectorAll("td")].filter(
      (cell) => cell.childElementCount === 0 && cell.textContent === "0",
    ),
  ).toHaveLength(10);
  // The table names its columns.
  expect([...host.querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual([
    "Common.WHITE",
    "Board.Analysis.Report.Metric",
    "Common.BLACK",
  ]);

  await act(async () => white!.click());
  expect(store.getState().position).toEqual([0, 0, 0]);
  await act(async () => white!.click());
  expect(store.getState().position).toEqual([0, 0, 0, 0, 0]);
  await act(async () => black!.click());
  expect(store.getState().position).toEqual([0, 0]);
});

test("the shipped en-US catalogue names the count buttons in full", async () => {
  const { createInstance } = await import("i18next");
  const { default: enUS } = await import("@/translation/en-US.json");
  const i18n = createInstance();
  await i18n.init({
    lng: "en-US",
    fallbackLng: false,
    keySeparator: false,
    nsSeparator: false,
    resources: { "en-US": enUS },
  });
  expect(i18n.t("Board.Analysis.NextAnnotationByWhite", { annotation: "Blunder", total: 2 })).toBe(
    "Go to White's next Blunder (2 total)",
  );
  expect(i18n.t("Board.Analysis.NextAnnotationByBlack", { annotation: "Blunder", total: 1 })).toBe(
    "Go to Black's next Blunder (1 total)",
  );
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
  store.getState().makeMoves({ payload: ["e4"] });
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
  expect(store.getState().root.score).toEqual(completedAnalysis.positions[0].best[0].score);
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

const cp = (value: number) => ({ value: { type: "cp" as const, value }, wdl: null });

test("one side without a scored move shows a dash beside the other side's card", async () => {
  store.setState((state) => ({
    ...state,
    root: { ...state.root, children: [{ ...state.root.children[0], score: cp(20) }] },
  }));
  await renderPanel();
  const cards = host.querySelectorAll('[data-testid="report-accuracy"]');
  expect(cards).toHaveLength(2);
  expect(cards[0].textContent).toContain("%");
  expect(cards[1].textContent).toContain("–");
  expect(cards[1].textContent).not.toContain("%");
});

test("neither side scored hides both cards and offers the report in the chart area", async () => {
  await renderPanel();
  expect(host.querySelectorAll('[data-testid="report-accuracy"]')).toHaveLength(0);
  const empty = host.querySelector('[data-testid="report-not-analysed"]')!;
  expect(empty.textContent).toContain("Board.Analysis.Report.NotAnalysed");
  await act(async () => empty.querySelector("button")!.click());
  expect(mocks.setReportingMode).toHaveBeenCalledWith(true);
});

test("a game without moves says that a report needs moves", async () => {
  store
    .getState()
    .setState({ ...store.getState(), root: { ...store.getState().root, children: [] } });
  await renderPanel();
  expect(host.querySelector('[data-testid="report-needs-moves"]')?.textContent).toBe(
    "Board.Analysis.Report.NeedsMoves",
  );
  expect(mocks.progressButtonProps).toBeNull();
});

const summary = {
  engine: "Stockfish 17",
  goMode: { t: "Depth" as const, c: 18 },
  createdAt: Date.UTC(2026, 10, 22),
  missingEvaluations: 2,
  novelty: "notFound" as const,
};

test("a summary of the current game shows its provenance and the quiet regenerate action", async () => {
  const { root } = store.getState();
  store.setState((state) => ({
    report: {
      ...state.report,
      summary: { ...summary, fingerprint: reportRootFingerprint(root.fen, getMainLine(root)) },
    },
  }));
  await renderPanel();
  expect(host.querySelector('[data-testid="report-provenance"]')).not.toBeNull();
  expect(mocks.t).toHaveBeenCalledWith(
    "Board.Analysis.Report.Provenance",
    expect.objectContaining({ engine: "Stockfish 17", limit: "Board.Analysis.Report.Limit.Depth" }),
  );
  expect(mocks.t).toHaveBeenCalledWith("Board.Analysis.Report.MissingEvaluations", {
    positions: 2,
  });
  expect(host.querySelector('[data-testid="report-outdated"]')).toBeNull();
  expect(mocks.progressButtonProps).toBeNull();
  const regenerate = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Board.Analysis.Report.Regenerate",
  );
  expect(regenerate).toBeDefined();
  await act(async () => regenerate!.click());
  expect(mocks.setReportingMode).toHaveBeenCalledWith(true);
});

test("during an active run on a current report, the progress control stays visible", async () => {
  const { root } = store.getState();
  store.setState((state) => ({
    report: {
      ...state.report,
      inProgress: true,
      operationId: "op-running",
      summary: { ...summary, fingerprint: reportRootFingerprint(root.fen, getMainLine(root)) },
    },
  }));
  await renderPanel();
  expect(mocks.progressButtonProps).toMatchObject({
    id: "op-running",
    labels: { action: "Board.Analysis.GenerateReport" },
  });
});

test("a summary of another game shows the changed-game hint instead", async () => {
  store.setState((state) => ({
    report: { ...state.report, summary: { ...summary, fingerprint: "another game" } },
  }));
  await renderPanel();
  expect(host.querySelector('[data-testid="report-provenance"]')).toBeNull();
  expect(host.querySelector('[data-testid="report-outdated"]')?.textContent).toBe(
    "Board.Analysis.Report.Outdated",
  );
  expect(mocks.progressButtonProps).toMatchObject({
    labels: { action: "Board.Analysis.GenerateReport" },
  });
});

test("a key moment row goes to the position before its move and links the better move", async () => {
  store.getState().makeMoves({ payload: ["e5"] });
  store.getState().goToStart();
  store.getState().makeMoves({ payload: ["d4"] });
  store.setState((state) => {
    const [e4, d4] = state.root.children;
    return {
      root: {
        ...state.root,
        score: cp(20),
        children: [
          { ...e4, nags: [2], score: cp(-80) },
          { ...d4, reportLine: true as const },
        ],
      },
    };
  });
  store.getState().goToMove([0]);
  await renderPanel();
  const rows = host.querySelectorAll('[data-testid="report-key-moment"]');
  expect(rows).toHaveLength(1);
  expect(rows[0].textContent).toContain("1. e4?");
  expect(rows[0].textContent).toContain("+0.20 → -0.80");
  expect(rows[0].textContent).toContain("Board.Analysis.Report.BetterMove");
  expect(mocks.t).toHaveBeenCalledWith("Board.Analysis.Report.BetterMove", { move: "d4" });
  const rowButtons = rows[0].querySelectorAll<HTMLButtonElement>("button");
  await act(async () => rowButtons[0].click());
  // D4: focusing a moment goes to the position before the move.
  expect(store.getState().position).toEqual([]);
  expect(mocks.setReviewFocus).toHaveBeenCalledWith(
    expect.objectContaining({
      documentId: store.getState().documentId,
      path: [],
      fen: store.getState().root.fen,
      summaryCreatedAt: null,
      playedSan: "e4",
      betterSan: "d4",
    }),
  );
  // Clicking the better-line link goes to that child move.
  await act(async () => rowButtons[1].click());
  expect(store.getState().position).toEqual([1]);
});
