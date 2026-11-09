import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UseFormReturnType } from "@mantine/form";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { EngineCompletion, EngineInstallRequest, ErrorPayload } from "@/bindings";
import { defaultEngineProgressId, type LocalEngine } from "@/utils/engines";
import AddEngine from "./AddEngine";
import CatalogEngineCard from "./CatalogEngineCard";
import {
  expectRestoredDownloadCancellation,
  resetProgressButtonTestHarness,
} from "@/tests/progressButtonTestHarness";

const mocks = await vi.hoisted(async () => {
  const { createProgressButtonTestHarness } = await import("@/tests/progressButtonTestHarness");
  return Object.assign(createProgressButtonTestHarness(), {
    engines: [] as Array<{
      id: string;
      type: "local";
      name: string;
      downloadLink?: string;
    }>,
    setEngines: vi.fn(),
    saveEngines: vi.fn(),
    submitLocal: undefined as undefined | ((value: unknown) => Promise<unknown>),
    localSaved: undefined as undefined | (() => void),
    form: undefined as UseFormReturnType<LocalEngine> | undefined,
    defaultEngines: [
      {
        type: "local" as const,
        id: "manifest-1",
        name: "Stockfish",
        version: "17",
        path: "stockfish-17/stockfish",
        sha256: "a".repeat(64),
        signature: "sig",
        downloadLink: "https://example.com/engines/stockfish.zip",
      },
    ],
    installDefaultEngine: vi.fn(),
    installJob: vi.fn(),
    withDownloadTicket: vi.fn((run: (ticket: string) => Promise<unknown>) =>
      run("prepared-ticket"),
    ),
    notifyUnlessCancelled: vi.fn(),
    notificationShow: vi.fn(),
    getEngineWorkspace: vi.fn(),
    engineArchiveDestination: vi.fn(),
    downloadEngineArchive: vi.fn(),
    registerInstalledEngine: vi.fn(),
    getEngineConfig: vi.fn(),
    completionRecords: new Map<string, EngineCompletion>(),
    pendingEngineCompletions: vi.fn(),
    acknowledgeEngineCompletion: vi.fn(),
    installEngineWorkflow: vi.fn(),
    completionChanged: undefined as (() => void) | undefined,
  });
});

vi.mock("@/state/catalogEngineCompletion", async () => {
  const { runDownloadJob } = await import("@/hooks/downloadJobs");
  const { notifyUnlessCancelled } = await import("@/components/files/notifyError");
  // Surface harness retains controllable completion timing. The real action has its own suite.
  mocks.installJob.mockImplementation(async (engine, id, upgrade, store) => {
    try {
      await runDownloadJob(id, (ticket) =>
        mocks.installDefaultEngine(engine, id, ticket, upgrade, store),
      );
      return true;
    } catch (error) {
      notifyUnlessCancelled("Common.Error", error, "engine");
      return false;
    }
  });
  return {
    installCatalogEngineJob: mocks.installJob,
    usePendingEngineCompletion: () => undefined,
  };
});
vi.mock("@/state/atoms", () => ({
  enginesAtom: Symbol("enginesAtom"),
}));
vi.mock("jotai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jotai")>()),
  useAtom: () => [mocks.engines, mocks.saveEngines],
}));
vi.mock("@/utils/engines", async () => {
  const actual = await vi.importActual<typeof import("@/utils/engines")>("@/utils/engines");
  return {
    ...actual,
    useDefaultEngines: () => ({
      defaultEngines: mocks.defaultEngines,
      error: undefined,
      isLoading: false,
    }),
    installDefaultEngine: mocks.installDefaultEngine,
  };
});
vi.mock("@/utils/files", () => ({
  usePlatform: () => ({ os: "linux" }),
}));
vi.mock("@/platform/tauri", () => ({
  tauri: {
    clearProgress: mocks.clearProgress,
    cancelDownload: mocks.cancelDownload,
    cancelDownloadForProgress: mocks.cancelDownloadForProgress,
    getProgress: mocks.getProgress,
    getEngineWorkspace: mocks.getEngineWorkspace,
    engineArchiveDestination: mocks.engineArchiveDestination,
    downloadEngineArchive: mocks.downloadEngineArchive,
    registerInstalledEngine: mocks.registerInstalledEngine,
    getEngineConfig: mocks.getEngineConfig,
    pendingEngineCompletions: mocks.pendingEngineCompletions,
    acknowledgeEngineCompletion: mocks.acknowledgeEngineCompletion,
    installEngineWorkflow: mocks.installEngineWorkflow,
  },
  tauriSubscriptions: {
    progress: mocks.subscribeProgress,
    completionChanged: async (callback: () => void) => {
      mocks.completionChanged = callback;
      return () => {
        mocks.completionChanged = undefined;
      };
    },
  },
  withDownloadTicket: mocks.withDownloadTicket,
  cancellationError: () => new Error("Cancellation"),
}));
vi.mock("@/components/files/notifyError", async (original) => {
  const actual = await original<typeof import("@/components/files/notifyError")>();
  mocks.notifyUnlessCancelled.mockImplementation(actual.notifyUnlessCancelled);
  return { ...actual, notifyUnlessCancelled: mocks.notifyUnlessCancelled };
});
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.notificationShow } }));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  default: {
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key.startsWith("Common.Require") || key === "Common.NameAlreadyUsed"
        ? `translated:${key}`
        : key,
  }),
}));
vi.mock("../common/AppModal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../common/ProgressButton", async (original) => {
  const { mockProgressButton } = await import("@/tests/progressButtonTestHarness");
  return mockProgressButton(
    mocks,
    await original<typeof import("../common/ProgressButton")>(),
    "progress",
  );
});
vi.mock("../common/IconAction", () => ({
  default: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      {label}
    </button>
  ),
}));
vi.mock("./EngineForm", () => ({
  default: ({
    onSubmit,
    onSaved,
    form,
  }: {
    onSubmit: (value: unknown) => Promise<unknown>;
    onSaved?: () => void;
    form: UseFormReturnType<LocalEngine>;
  }) => {
    mocks.submitLocal = onSubmit;
    mocks.localSaved = onSaved;
    mocks.form = form;
    return (
      <form onSubmit={form.onSubmit(() => undefined)}>
        <input aria-label="name" {...form.getInputProps("name")} />
        <input aria-label="filename" {...form.getInputProps("filename")} />
        <output data-testid="name-error">{form.errors.name}</output>
        <output data-testid="filename-error">{form.errors.filename}</output>
        <button type="submit">submit</button>
      </form>
    );
  },
}));
vi.mock("@mantine/core", () => ({
  Alert: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Box: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Button: ({
    children,
    onClick,
    disabled,
    className,
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} disabled={disabled} className={className}>
      {children}
    </button>
  ),
  Center: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Image: () => null,
  Loader: () => null,
  Paper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Progress: ({ value }: { value: number }) => <output data-progress>{value}</output>,
  ScrollArea: { Autosize: ({ children }: { children: React.ReactNode }) => <div>{children}</div> },
  SimpleGrid: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tabs: Object.assign(({ children }: { children: React.ReactNode }) => <div>{children}</div>, {
    List: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Tab: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
    Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  }),
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("lucide-react", () => ({
  AlertCircle: () => null,
  Database: () => null,
  Trophy: () => null,
  X: () => null,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.engines = [];
  resetProgressButtonTestHarness(mocks);
  mocks.submitLocal = undefined;
  mocks.localSaved = undefined;
  mocks.form = undefined;
  mocks.saveEngines.mockReset().mockResolvedValue({ saved: true, synchronized: true });
  mocks.getEngineWorkspace
    .mockReset()
    .mockResolvedValue({ root: { id: { id: "root" } }, displayName: "Engines" });
  mocks.engineArchiveDestination.mockReset().mockResolvedValue({ id: "destination" });
  mocks.downloadEngineArchive.mockReset().mockResolvedValue(undefined);
  mocks.registerInstalledEngine
    .mockReset()
    .mockResolvedValue({ id: { id: "binary" }, kind: "engine" });
  mocks.getEngineConfig.mockReset().mockResolvedValue({ name: "Stockfish", options: [] });
  mocks.completionRecords.clear();
  mocks.completionChanged = undefined;
  mocks.pendingEngineCompletions
    .mockReset()
    .mockImplementation(async () => structuredClone([...mocks.completionRecords.values()]));
  mocks.acknowledgeEngineCompletion.mockReset().mockImplementation(async (id: string) => {
    mocks.completionRecords.delete(id);
  });
  mocks.installEngineWorkflow.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test.each([false, true])("catalog recovery keeps label wrapping when busy is %s", async (busy) => {
  await act(async () =>
    root.render(
      <CatalogEngineCard
        engine={{ ...mocks.defaultEngines[0], os: "linux", bmi2: false }}
        layout="add"
        progressId="recovery"
        initInstalled={false}
        recovery={{ busy, retry: () => undefined }}
        labels={{ completed: "Installed", action: "Install", inProgress: "Downloading" }}
        onClick={() => undefined}
        inProgress={false}
        setInProgress={() => undefined}
      />,
    ),
  );
  const button = host.querySelector("button")!;
  expect(button.classList.contains("wrap-button")).toBe(true);
  expect(button.textContent).toBe(busy ? "Common.Extracting" : "Common.Install");
  expect(button.disabled).toBe(busy);
});

test("wires installed state and progress id from the download URL", async () => {
  mocks.engines = [
    {
      id: "existing",
      type: "local",
      name: "My Fish",
      downloadLink: mocks.defaultEngines[0].downloadLink,
    },
  ];

  await act(async () => {
    root.render(<AddEngine opened setOpened={() => undefined} />);
  });
  expect(mocks.progressButtonProps?.id).toBe(
    defaultEngineProgressId(mocks.defaultEngines[0].downloadLink),
  );
  expect(mocks.progressButtonProps?.id).not.toBe("engine_0");
  expect(mocks.progressButtonProps?.initInstalled).toBe(true);
  expect(mocks.progressButtonProps?.completeOnProgressSuccess).toBe(false);
});

test("a running engine download with no local job renders Cancel and calls native lookup", async () => {
  mocks.realProgressButton = true;
  await act(async () => root.render(<AddEngine opened setOpened={() => undefined} />));
  await expectRestoredDownloadCancellation(
    mocks,
    host,
    defaultEngineProgressId(mocks.defaultEngines[0].downloadLink),
  );
});

test("renders translated validation errors from actual local form validation", async () => {
  mocks.engines = [{ id: "existing", type: "local", name: "Stockfish" }];
  await act(async () => root.render(<AddEngine opened setOpened={() => undefined} />));

  const form = host.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(host.querySelector('[data-testid="name-error"]')?.textContent).toBe(
    "translated:Common.RequireName",
  );
  expect(host.querySelector('[data-testid="filename-error"]')?.textContent).toBe(
    "translated:Common.RequirePath",
  );

  await act(async () => {
    mocks.form?.setValues({ name: "Stockfish", filename: "stockfish" });
  });
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(host.querySelector('[data-testid="name-error"]')?.textContent).toBe(
    "translated:Common.NameAlreadyUsed",
  );
  expect(host.querySelector('[data-testid="filename-error"]')?.textContent).toBe("");
});

test("a succeeded download that fails to register is not treated as installed", async () => {
  mocks.installDefaultEngine.mockRejectedValue(new Error("register failed"));
  mocks.clearProgress.mockRejectedValue(new Error("clear failed"));

  await act(async () => {
    root.render(<AddEngine opened setOpened={() => undefined} />);
  });
  expect(mocks.progressButtonProps?.initInstalled).toBe(false);
  expect(mocks.progressButtonProps?.clearOnCancel).toBe(false);
  await act(async () => {
    mocks.progressButtonProps?.onClick();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(mocks.notifyUnlessCancelled).toHaveBeenCalledWith(
    "Common.Error",
    expect.any(Error),
    "engine",
  );
  expect(mocks.clearProgress).toHaveBeenCalledWith(
    defaultEngineProgressId(mocks.defaultEngines[0].downloadLink),
  );
  expect(mocks.progressButtonProps?.initInstalled).toBe(false);
});

test("an application failure shows an error and returns the card to its action", async () => {
  mocks.installDefaultEngine.mockRejectedValue(new Error("Engines.SaveError"));
  await act(async () => root.render(<AddEngine opened setOpened={() => undefined} />));
  await act(async () => mocks.progressButtonProps!.onClick());
  expect(mocks.installJob).toHaveBeenCalledWith(
    mocks.defaultEngines[0],
    defaultEngineProgressId(mocks.defaultEngines[0].downloadLink),
    undefined,
    expect.anything(),
  );
  expect(mocks.saveEngines).not.toHaveBeenCalled();
  expect(mocks.notifyUnlessCancelled).toHaveBeenCalledWith(
    "Common.Error",
    expect.any(Error),
    "engine",
  );
  expect(mocks.progressButtonProps?.initInstalled).toBe(false);
  expect(mocks.progressButtonProps?.inProgress).toBe(false);
  expect(mocks.engines).toEqual([]);
});

async function startFailedCatalogResponse(
  category: "network" | "cancellation",
  order: "event-first" | "command-first",
) {
  const completions = await import("@/state/engineCompletions");
  completions.resetEngineCompletionsForTests();
  const { completeCatalogEngine } = await vi.importActual<
    typeof import("@/state/catalogEngineCompletion")
  >("@/state/catalogEngineCompletion");
  mocks.installDefaultEngine.mockImplementation(completeCatalogEngine);
  const failure: ErrorPayload = {
    tag: "backend-error",
    category,
    message: category === "cancellation" ? "Cancellation" : "Remote server rejected the download",
    ...(category === "network"
      ? { remoteHttpRejection: { status: 403, authorizationSent: false } }
      : {}),
  };
  let response!: () => void;
  mocks.installEngineWorkflow.mockImplementation((id: string, request: EngineInstallRequest) => {
    const completion: EngineCompletion = {
      id,
      request,
      retired: false,
      outcome: { state: "failed", result: failure },
    };
    mocks.completionRecords.set(id, completion);
    return new Promise<EngineCompletion>((resolve) => {
      response = () => resolve(completion);
    });
  });
  await act(async () => root.render(<AddEngine opened setOpened={() => undefined} />));
  await act(async () => mocks.progressButtonProps!.onClick());
  await vi.waitFor(() => expect(mocks.installEngineWorkflow).toHaveBeenCalledOnce());
  if (order === "event-first") {
    await act(async () => mocks.completionChanged!());
    await vi.waitUntil(() => mocks.acknowledgeEngineCompletion.mock.calls.length > 0);
    await act(async () => {
      await completions.observeEngineCompletions();
    });
  }
  expect(mocks.acknowledgeEngineCompletion).toHaveBeenCalledTimes(order === "event-first" ? 1 : 0);
  expect(mocks.completionRecords.size).toBe(order === "event-first" ? 0 : 1);
  expect(mocks.progressButtonProps?.initInstalled).toBe(false);
  return { completions, failure, response, order };
}

async function finishFailedCatalogResponse(
  run: Awaited<ReturnType<typeof startFailedCatalogResponse>>,
) {
  await act(async () => run.response());
  if (run.order === "command-first") {
    await act(async () => mocks.completionChanged!());
    await act(async () => {
      await run.completions.observeEngineCompletions();
    });
  }
}

function expectUninstalledCatalogCard() {
  expect(mocks.acknowledgeEngineCompletion).toHaveBeenCalledOnce();
  expect(mocks.completionRecords.size).toBe(0);
  expect(mocks.progressButtonProps?.initInstalled).toBe(false);
  expect(mocks.progressButtonProps?.inProgress).toBe(false);
  expect(mocks.engines).toEqual([]);
  expect(mocks.saveEngines).not.toHaveBeenCalled();
}

test.each(["event-first", "command-first"] as const)(
  "a network command response with %s ordering never marks the catalog card installed",
  async (order) => {
    const run = await startFailedCatalogResponse("network", order);
    try {
      await finishFailedCatalogResponse(run);
      expect(mocks.notifyUnlessCancelled).toHaveBeenCalledWith(
        "Common.Error",
        run.failure,
        "engine",
      );
      expect(mocks.notificationShow).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          color: "danger",
          title: "Common.Error",
          message: "The service denied access to this request.",
        }),
      );
      expectUninstalledCatalogCard();
    } finally {
      run.completions.resetEngineCompletionsForTests();
    }
  },
);

test.each(["event-first", "command-first"] as const)(
  "a cancellation command response with %s ordering never marks the catalog card installed",
  async (order) => {
    const run = await startFailedCatalogResponse("cancellation", order);
    try {
      const cancellation = Promise.resolve(mocks.progressButtonProps!.onCancel!());
      // Observe the same promise below after delivering the held command response.
      void cancellation.catch(() => undefined);
      await finishFailedCatalogResponse(run);
      await expect(cancellation).resolves.toEqual({ clearedGeneration: 1n });
      expect(mocks.notificationShow).not.toHaveBeenCalled();
      expectUninstalledCatalogCard();
    } finally {
      run.completions.resetEngineCompletionsForTests();
    }
  },
);

test("the catalog card becomes installed only after its completion is acknowledged", async () => {
  mocks.installDefaultEngine.mockResolvedValue({ id: "installed" });
  let finishSave!: (receipt: { saved: boolean; synchronized: boolean }) => void;
  mocks.installDefaultEngine.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishSave = resolve;
      }),
  );
  await act(async () => root.render(<AddEngine opened setOpened={() => undefined} />));
  await act(async () => mocks.progressButtonProps!.onClick());
  expect(mocks.saveEngines).not.toHaveBeenCalled();
  expect(mocks.progressButtonProps?.initInstalled).toBe(false);
  expect(mocks.progressButtonProps?.inProgress).toBe(true);
  await act(async () => finishSave({ saved: true, synchronized: true }));
  expect(mocks.progressButtonProps?.initInstalled).toBe(true);
  expect(mocks.progressButtonProps?.inProgress).toBe(false);
  expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
});

test("cancelling while engine setup is pending loses the race without clearing or notifying", async () => {
  let finishInstall!: (engine: unknown) => void;
  const installed = { ...mocks.defaultEngines[0], id: "installed" };
  mocks.installDefaultEngine.mockReturnValue(
    new Promise((resolve) => {
      finishInstall = resolve;
    }),
  );

  await act(async () => root.render(<AddEngine opened setOpened={() => undefined} />));
  await act(async () => mocks.progressButtonProps!.onClick());
  await vi.waitFor(() => expect(mocks.progressButtonProps?.onCancel).toEqual(expect.any(Function)));
  const onCancel = mocks.progressButtonProps!.onCancel!;
  mocks.cancelDownload.mockImplementation(async (ticket: string) => {
    expect(ticket).toBe("prepared-ticket");
    finishInstall(installed);
    return false;
  });

  await expect(onCancel()).rejects.toMatchObject({ reason: "lost" });
  expect(mocks.installDefaultEngine).toHaveBeenCalledWith(
    mocks.defaultEngines[0],
    defaultEngineProgressId(mocks.defaultEngines[0].downloadLink),
    "prepared-ticket",
    undefined,
    expect.anything(),
  );
  expect(mocks.saveEngines).not.toHaveBeenCalled();
  expect(mocks.clearProgress).not.toHaveBeenCalled();
  expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
});

test("reports a failed cancellation request once", async () => {
  let finishInstall!: (engine: unknown) => void;
  mocks.installDefaultEngine.mockReturnValue(
    new Promise((resolve) => {
      finishInstall = resolve;
    }),
  );
  await act(async () => root.render(<AddEngine opened setOpened={() => undefined} />));
  await act(async () => mocks.progressButtonProps!.onClick());
  await vi.waitFor(() => expect(mocks.progressButtonProps?.onCancel).toEqual(expect.any(Function)));
  mocks.cancelDownload.mockRejectedValue(new Error("cancel IPC failed"));

  await expect(mocks.progressButtonProps!.onCancel!()).rejects.toMatchObject({
    reason: "request",
  });
  expect(mocks.notifyUnlessCancelled).toHaveBeenCalledOnce();
  finishInstall({ ...mocks.defaultEngines[0], id: "installed" });
  await act(async () => Promise.resolve());
});

test("reports a job failure after cancellation once, without a second cancel notification", async () => {
  const failure = new Error("engine configuration failed");
  let rejectInstall!: (error: unknown) => void;
  mocks.installDefaultEngine.mockReturnValue(
    new Promise((_resolve, reject) => {
      rejectInstall = reject;
    }),
  );
  await act(async () => root.render(<AddEngine opened setOpened={() => undefined} />));
  await act(async () => mocks.progressButtonProps!.onClick());
  await vi.waitFor(() => expect(mocks.progressButtonProps?.onCancel).toEqual(expect.any(Function)));
  mocks.cancelDownload.mockImplementation(async () => {
    rejectInstall(failure);
    return true;
  });

  await expect(mocks.progressButtonProps!.onCancel!()).rejects.toBe(failure);
  expect(mocks.notifyUnlessCancelled).toHaveBeenCalledOnce();
});

test("a remounted engine card keeps the cancel action for a registered job", async () => {
  let finishInstall!: (engine: unknown) => void;
  mocks.installDefaultEngine.mockReturnValue(
    new Promise((resolve) => {
      finishInstall = resolve;
    }),
  );
  await act(async () => root.render(<AddEngine opened setOpened={() => undefined} />));
  await act(async () => mocks.progressButtonProps!.onClick());
  await vi.waitFor(() => expect(mocks.progressButtonProps?.onCancel).toEqual(expect.any(Function)));

  await act(async () => root.unmount());
  root = createRoot(host);
  mocks.progressButtonProps = null;
  await act(async () => root.render(<AddEngine opened setOpened={() => undefined} />));
  await vi.waitFor(() => expect(mocks.progressButtonProps?.onCancel).toEqual(expect.any(Function)));
  const remountedProps = mocks.progressButtonProps!;
  expect(remountedProps.clearOnCancel).toBe(false);

  finishInstall({ ...mocks.defaultEngines[0], id: "installed" });
  await act(async () => Promise.resolve());
});

test("local add closes only for the receipt returned by its exact write", async () => {
  const setOpened = vi.fn();
  mocks.saveEngines
    .mockResolvedValueOnce({ saved: false, synchronized: false })
    .mockResolvedValueOnce({ saved: true, synchronized: true });
  await act(async () => root.render(<AddEngine opened setOpened={setOpened} />));
  const local = {
    type: "local",
    id: "draft",
    name: "Stockfish",
    version: "17",
    handle: { id: { id: "binary" }, kind: "engine" },
    filename: "stockfish",
  };

  await act(async () => {
    await mocks.submitLocal?.(local);
  });
  expect(setOpened).not.toHaveBeenCalled();

  await act(async () => {
    await mocks.submitLocal?.(local);
  });
  expect(setOpened).not.toHaveBeenCalled();
  mocks.localSaved?.();
  expect(setOpened).toHaveBeenCalledWith(false);
});
