import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => {
  const referenceDbAtom = {};
  const fontSizeAtom = {};
  const pieceSetAtom = {};
  const pieceSizeAtom = {};
  const spellCheckAtom = {};
  const tabsAtom = {};

  return {
    createAppTheme: vi.fn(() => ({})),
    useAtomValue: vi.fn((_atom: object): unknown => undefined),
    ask: vi.fn(),
    check: vi.fn(),
    relaunch: vi.fn(),
    showNotification: vi.fn(),
    attachConsole: vi.fn(),
    useConversionProgress: vi.fn(),
    useDatabaseContentValidation: vi.fn(),
    useDocumentLanguage: vi.fn(),
    sessionPersistenceNotice: vi.fn(() => null),
    automaticStockfishNotice: vi.fn(() => null),
    closeSplashscreen: vi.fn(),
    getDefaultStore: vi.fn(),
    getMatches: vi.fn(),
    info: vi.fn(),
    preloadReferenceDb: vi.fn(),
    reconcileStartupPathOwners: vi.fn(),
    reconcileEngineAttachments: vi.fn(),
    warn: vi.fn(),
    platform: vi.fn(),
    scanBlockingTabs: vi.fn(),
    isQuitGateInProgress: vi.fn(),
    referenceDbAtom,
    fontSizeAtom,
    pieceSetAtom,
    pieceSizeAtom,
    spellCheckAtom,
    tabsAtom,
  };
});

vi.mock("@/platform/native", () => ({
  ask: mocks.ask,
  attachConsole: mocks.attachConsole,
  check: mocks.check,
  getMatches: mocks.getMatches,
  info: mocks.info,
  platform: mocks.platform,
  relaunch: mocks.relaunch,
  warn: mocks.warn,
}));
vi.mock("@/i18n", () => ({
  default: {
    t: (key: string, options?: { version?: string }) =>
      options?.version ? `${key}:${options.version}` : key,
  },
}));
vi.mock("@/platform/tauri", () => ({
  tauri: {
    closeSplashscreen: mocks.closeSplashscreen,
    preloadReferenceDb: mocks.preloadReferenceDb,
    reconcileStartupPathOwners: mocks.reconcileStartupPathOwners,
    reconcileEngineAttachments: mocks.reconcileEngineAttachments,
  },
}));
vi.mock("@/state/atoms", () => ({
  fontSizeAtom: mocks.fontSizeAtom,
  pieceSetAtom: mocks.pieceSetAtom,
  pieceSizeAtom: mocks.pieceSizeAtom,
  referenceDbAtom: mocks.referenceDbAtom,
  spellCheckAtom: mocks.spellCheckAtom,
  tabsAtom: mocks.tabsAtom,
}));
vi.mock("./state/quitGate", () => ({
  scanBlockingTabs: mocks.scanBlockingTabs,
  isQuitGateInProgress: mocks.isQuitGateInProgress,
}));
vi.mock("jotai", () => ({
  getDefaultStore: mocks.getDefaultStore,
  useAtomValue: mocks.useAtomValue,
}));
vi.mock("@mantine/core", () => ({
  MantineProvider: ({ children }: { children: React.ReactNode }) => children,
  localStorageColorSchemeManager: vi.fn(() => ({})),
}));
vi.mock("@mantine/notifications", () => ({
  Notifications: () => null,
  notifications: { show: mocks.showNotification },
}));
vi.mock("@tanstack/react-router", () => ({
  RouterProvider: () => null,
  createRouter: vi.fn(() => ({})),
}));
vi.mock("mantine-contextmenu", () => ({
  ContextMenuProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("react-dnd", () => ({
  DndProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("react-dnd-html5-backend", () => ({ HTML5Backend: {} }));
vi.mock("@/components/ErrorComponent", () => ({ default: () => null }));
vi.mock("@/hooks/useConversionProgress", () => ({
  useConversionProgress: mocks.useConversionProgress,
}));

vi.mock("@/hooks/useDatabaseContentValidation", () => ({
  useDatabaseContentValidation: mocks.useDatabaseContentValidation,
}));
vi.mock("@/hooks/useDocumentLanguage", () => ({
  useDocumentLanguage: mocks.useDocumentLanguage,
}));
vi.mock("./components/home/SessionPersistenceNotice", () => ({
  SessionPersistenceNotice: mocks.sessionPersistenceNotice,
}));
vi.mock("./components/home/AutomaticStockfishNotice", () => ({
  AutomaticStockfishNotice: mocks.automaticStockfishNotice,
}));
vi.mock("./routeTree.gen", () => ({ routeTree: {} }));
vi.mock("./styles/theme", () => ({
  appCssVariablesResolver: {},
  createAppTheme: mocks.createAppTheme,
}));

import App, { UPDATE_CHECK_TIMEOUT_MS, useAppStartup } from "./App";
import { resetEngineOwnerCoordinatorForTests } from "./state/engineOwnerStorage";
import { resetPathOwnerInitializationForTests } from "./state/pathOwners";

let root: Root;
let container: HTMLDivElement;
let storeValues: { referenceDb: string | undefined };
let atomValues: Map<object, unknown>;
let tabsInStore: unknown[] = [];

/** Distinct tab list the update-check suite feeds through the store into `scanBlockingTabs`. */
const storedTabs = [{ value: "t1", name: "Analysis", type: "analysis" }];

function Probe() {
  useAppStartup();
  return null;
}

/** The CLI match shape for a launch without a file argument, which is every case but one. */
const noCliFileArgs = { args: { file: { occurrences: 0, value: "" } } };

/** Wires the native call a startup must get past before the branch under test. */
function mockLaunchWithoutCliFile() {
  mocks.getMatches.mockResolvedValue(noCliFileArgs);
}

/** An available update whose download and install can be driven by the test. */
function mockUpdate({
  download = () => Promise.resolve(),
  install = () => Promise.resolve(),
}: {
  download?: () => Promise<void>;
  install?: () => Promise<void>;
} = {}) {
  const update = {
    version: "9.9.9",
    download: vi.fn(download),
    install: vi.fn(install),
    close: vi.fn(() => Promise.resolve()),
  };
  mocks.check.mockResolvedValue(update);
  return update;
}

/** Models Windows `install()` never returning because the process exits. */
function neverResolves(): Promise<void> {
  return new Promise(() => undefined);
}

beforeEach(() => {
  mocks.ask.mockReset().mockResolvedValue(false);
  mocks.check.mockReset().mockResolvedValue(null);
  mocks.relaunch.mockReset().mockResolvedValue(undefined);
  mocks.showNotification.mockReset();
  mocks.attachConsole.mockReset();
  mocks.closeSplashscreen.mockReset();
  mocks.getDefaultStore.mockReset();
  mocks.getMatches.mockReset();
  mocks.info.mockReset();
  mocks.reconcileStartupPathOwners.mockReset().mockResolvedValue(null);
  mocks.reconcileEngineAttachments.mockReset().mockResolvedValue(null);
  resetPathOwnerInitializationForTests();
  resetEngineOwnerCoordinatorForTests();
  mocks.preloadReferenceDb.mockReset();
  mocks.warn.mockReset();
  mocks.platform.mockReset().mockReturnValue("linux");
  mocks.scanBlockingTabs.mockReset().mockReturnValue([]);
  mocks.isQuitGateInProgress.mockReset().mockReturnValue(false);

  mocks.createAppTheme.mockReset().mockReturnValue({});
  mocks.useConversionProgress.mockReset();
  mocks.useDatabaseContentValidation.mockReset();
  mocks.useDocumentLanguage.mockReset();
  mocks.sessionPersistenceNotice.mockClear();
  mocks.automaticStockfishNotice.mockClear();
  mocks.useAtomValue.mockReset();

  storeValues = { referenceDb: undefined };
  tabsInStore = [];
  mocks.getDefaultStore.mockReturnValue({
    get: (atom: object) => {
      if (atom === mocks.referenceDbAtom) return storeValues.referenceDb;
      if (atom === mocks.tabsAtom) return tabsInStore;
      return undefined;
    },
  });
  atomValues = new Map<object, unknown>([
    [mocks.fontSizeAtom, 120],
    [mocks.pieceSetAtom, "staunty"],
    [mocks.pieceSizeAtom, 100],
    [mocks.spellCheckAtom, true],
  ]);
  mocks.useAtomValue.mockImplementation((atom: object) => atomValues.get(atom));
  mocks.preloadReferenceDb.mockResolvedValue(undefined);

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.documentElement.style.removeProperty("--piece-size");
  vi.useRealTimers();
});

describe("useAppStartup", () => {
  test("shares path reconciliation across simultaneous and remounted startup callers", async () => {
    let resolveOwners: () => void = () => {};
    mocks.reconcileStartupPathOwners.mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          resolveOwners = () => resolve(null);
        }),
    );

    await act(async () =>
      root.render(
        <>
          <Probe />
          <Probe />
        </>,
      ),
    );
    expect(mocks.reconcileStartupPathOwners).toHaveBeenCalledOnce();
    await act(async () => resolveOwners());
    expect(mocks.reconcileEngineAttachments).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Probe />));
    expect(mocks.reconcileStartupPathOwners).toHaveBeenCalledOnce();
    expect(mocks.reconcileEngineAttachments).toHaveBeenCalledOnce();
  });

  test("reports reconciliation failure and still tears down the splash", async () => {
    mocks.reconcileStartupPathOwners.mockRejectedValue(new Error("registry unavailable"));
    mockLaunchWithoutCliFile();

    await act(async () => root.render(<Probe />));

    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("registry unavailable"));
    expect(mocks.closeSplashscreen).toHaveBeenCalledOnce();
  });

  test("reports attachment reconciliation failure and still tears down the splash", async () => {
    mocks.reconcileEngineAttachments.mockRejectedValue(
      new Error("attachment registry unavailable"),
    );
    mockLaunchWithoutCliFile();

    await act(async () => root.render(<Probe />));

    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining("attachment registry unavailable"),
    );
    expect(mocks.closeSplashscreen).toHaveBeenCalledOnce();
  });

  test("logs the CLI file argument", async () => {
    mocks.getMatches.mockResolvedValue({
      args: { file: { occurrences: 1, value: "/games/opening.pgn" } },
    });

    await act(async () => root.render(<Probe />));

    expect(mocks.info).toHaveBeenCalledWith("Opening file from command line: /games/opening.pgn");
    expect(mocks.closeSplashscreen).toHaveBeenCalledOnce();
  });

  test("leaves optional startup work untouched when nothing is configured", async () => {
    mockLaunchWithoutCliFile();

    await act(async () => root.render(<Probe />));

    expect(mocks.info).not.toHaveBeenCalledWith(
      expect.stringContaining("Opening file from command line"),
    );
    expect(mocks.preloadReferenceDb).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalledWith(
      expect.stringContaining("Preloading reference database"),
    );
    expect(mocks.closeSplashscreen).toHaveBeenCalledOnce();
  });

  test("preloads the configured reference database", async () => {
    storeValues.referenceDb = "reference.db3";
    mockLaunchWithoutCliFile();

    await act(async () => root.render(<Probe />));

    expect(mocks.preloadReferenceDb).toHaveBeenCalledWith(
      "reference.db3",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.info).toHaveBeenCalledWith("Preloading reference database: reference.db3");
    expect(mocks.closeSplashscreen).toHaveBeenCalledOnce();
  });

  test("reports a reference database preload failure without failing startup", async () => {
    storeValues.referenceDb = "reference.db3";
    mockLaunchWithoutCliFile();
    mocks.preloadReferenceDb.mockRejectedValue(new Error("database missing"));

    await act(async () => root.render(<Probe />));

    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to preload reference database: Error: database missing"),
    );
    expect(mocks.closeSplashscreen).toHaveBeenCalledOnce();
  });

  test("stays silent when the reference preload rejects because startup was cancelled", async () => {
    storeValues.referenceDb = "reference.db3";
    mockLaunchWithoutCliFile();

    let rejectPreload: (error: Error) => void = () => undefined;
    mocks.preloadReferenceDb.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectPreload = reject;
        }),
    );

    await act(async () => root.render(<Probe />));
    expect(mocks.preloadReferenceDb).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
    await act(async () => {
      rejectPreload(new Error("aborted"));
    });

    expect(mocks.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("Failed to preload reference database"),
    );
    expect(mocks.closeSplashscreen).not.toHaveBeenCalled();
  });

  test("skips the reference preload when startup was cancelled before it began", async () => {
    storeValues.referenceDb = "reference.db3";

    let resolveMatches: (matches: {
      args: { file: { occurrences: number; value: string } };
    }) => void = () => undefined;
    mocks.getMatches.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMatches = resolve;
        }),
    );

    await act(async () => root.render(<Probe />));
    await act(async () => root.unmount());
    await act(async () => {
      resolveMatches(noCliFileArgs);
    });

    expect(mocks.preloadReferenceDb).not.toHaveBeenCalled();
    expect(mocks.closeSplashscreen).not.toHaveBeenCalled();
  });

  test("stops before CLI handling when startup is cancelled during reconciliation", async () => {
    let resolveOwners: () => void = () => {};
    mocks.reconcileStartupPathOwners.mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          resolveOwners = () => resolve(null);
        }),
    );

    await act(async () => root.render(<Probe />));
    await act(async () => root.unmount());
    await act(async () => resolveOwners());

    expect(mocks.getMatches).not.toHaveBeenCalled();
    expect(mocks.closeSplashscreen).not.toHaveBeenCalled();
  });

  test("reports unreadable CLI arguments and still finishes startup", async () => {
    mocks.getMatches.mockRejectedValue(new Error("argv unavailable"));

    await act(async () => root.render(<Probe />));

    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to parse CLI args: Error: argv unavailable"),
    );
    expect(mocks.closeSplashscreen).toHaveBeenCalledOnce();
  });

  test("reports a startup failure when the splashscreen refuses to close", async () => {
    mockLaunchWithoutCliFile();
    mocks.closeSplashscreen.mockRejectedValue(new Error("splash window gone"));

    await act(async () => root.render(<Probe />));

    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining("Application startup failed: Error: splash window gone"),
    );
  });

  test("does not subscribe the renderer to native log records", async () => {
    mockLaunchWithoutCliFile();

    await act(async () => root.render(<Probe />));

    expect(mocks.attachConsole).not.toHaveBeenCalled();
    expect(mocks.closeSplashscreen).toHaveBeenCalledOnce();
  });
});

describe("startup update check", () => {
  beforeEach(() => {
    tabsInStore = storedTabs;
  });

  test("shows no dialog when no update is available", async () => {
    mockLaunchWithoutCliFile();

    await act(async () => root.render(<Probe />));

    expect(mocks.check).toHaveBeenCalledOnce();
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  test("closes the splash before a hanging check reaches its timeout, then warns", async () => {
    vi.useFakeTimers();
    mockLaunchWithoutCliFile();
    mocks.check.mockReturnValue(new Promise(() => undefined));

    await act(async () => root.render(<Probe />));

    expect(mocks.check).toHaveBeenCalledOnce();
    expect(mocks.closeSplashscreen).toHaveBeenCalledOnce();
    expect(mocks.warn).not.toHaveBeenCalledWith(expect.stringContaining("Update check failed"));

    await act(async () => vi.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS));

    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("Update check failed"));
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  test("closes an update delivered after unmount before timeout without prompting", async () => {
    vi.useFakeTimers();
    mockLaunchWithoutCliFile();
    const update = mockUpdate();
    let resolveCheck: (value: typeof update) => void = () => undefined;
    mocks.check.mockReturnValue(
      new Promise<typeof update>((resolve) => {
        resolveCheck = resolve;
      }),
    );

    await act(async () => root.render(<Probe />));
    expect(mocks.closeSplashscreen).toHaveBeenCalledOnce();
    expect(mocks.check).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
    await act(async () => vi.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS - 1));
    expect(update.close).not.toHaveBeenCalled();
    await act(async () => resolveCheck(update));

    expect(update.close).toHaveBeenCalledOnce();
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(update.download).not.toHaveBeenCalled();
    expect(update.install).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    "closes an update delivered after timeout without prompting (unmounted: %s)",
    async (unmount) => {
      vi.useFakeTimers();
      mockLaunchWithoutCliFile();
      const update = mockUpdate();
      let resolveCheck: (value: typeof update) => void = () => undefined;
      mocks.check.mockReturnValue(
        new Promise<typeof update>((resolve) => {
          resolveCheck = resolve;
        }),
      );

      await act(async () => root.render(<Probe />));
      await act(async () => vi.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS));

      expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("Update check failed"));
      expect(update.close).not.toHaveBeenCalled();
      if (unmount) await act(async () => root.unmount());
      await act(async () => resolveCheck(update));

      expect(update.close).toHaveBeenCalledOnce();
      expect(mocks.ask).not.toHaveBeenCalled();
      expect(update.download).not.toHaveBeenCalled();
      expect(update.install).not.toHaveBeenCalled();
      expect(mocks.relaunch).not.toHaveBeenCalled();
    },
  );

  test("handles a check rejection delivered after timeout", async () => {
    vi.useFakeTimers();
    mockLaunchWithoutCliFile();
    let rejectCheck: (error: Error) => void = () => undefined;
    mocks.check.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectCheck = reject;
      }),
    );

    await act(async () => root.render(<Probe />));
    await act(async () => vi.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS));
    await act(async () => rejectCheck(new Error("late network failure")));

    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("Update check failed"));
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  test("warns and continues when the check fails", async () => {
    mockLaunchWithoutCliFile();
    mocks.check.mockRejectedValue(new Error("latest.json missing"));

    await act(async () => root.render(<Probe />));

    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("latest.json missing"));
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(mocks.closeSplashscreen).toHaveBeenCalledOnce();
  });

  test("does not download when the user declines", async () => {
    mockLaunchWithoutCliFile();
    const update = mockUpdate();

    await act(async () => root.render(<Probe />));

    expect(mocks.ask).toHaveBeenCalledWith("Updater.Available:9.9.9", expect.any(Object));
    expect(update.download).not.toHaveBeenCalled();
    expect(update.install).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(update.close).toHaveBeenCalledOnce();
  });

  test("downloads, installs and relaunches when the user accepts", async () => {
    mockLaunchWithoutCliFile();
    const update = mockUpdate();
    mocks.ask.mockResolvedValue(true);

    await act(async () => root.render(<Probe />));

    expect(update.download).toHaveBeenCalledOnce();
    expect(update.install).toHaveBeenCalledOnce();
    expect(mocks.scanBlockingTabs).toHaveBeenCalledOnce();
    expect(mocks.scanBlockingTabs).toHaveBeenCalledWith(storedTabs);
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(update.close).toHaveBeenCalledOnce();
    expect(update.download.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.scanBlockingTabs.mock.invocationCallOrder[0],
    );
    expect(update.install.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.relaunch.mock.invocationCallOrder[0],
    );
  });

  test("does not relaunch when a blocking tab has unsaved work", async () => {
    mockLaunchWithoutCliFile();
    const update = mockUpdate();
    mocks.ask.mockResolvedValue(true);
    mocks.scanBlockingTabs.mockImplementation((tabs) =>
      tabs === storedTabs ? [{ value: "t1", name: "Analysis", uninspectable: false }] : [],
    );

    await act(async () => root.render(<Probe />));

    expect(update.install).toHaveBeenCalledOnce();
    expect(update.install.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.scanBlockingTabs.mock.invocationCallOrder[0],
    );
    expect(mocks.scanBlockingTabs).toHaveBeenCalledWith(storedTabs);
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(mocks.showNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Updater.Installed",
        message: "Updater.RestartToApply:9.9.9",
        autoClose: false,
      }),
    );
    expect(mocks.info).toHaveBeenCalledWith("Update restart deferred: unsaved work in open tabs");
    expect(update.close).toHaveBeenCalledOnce();
  });

  test("does not relaunch when the quit gate is in progress", async () => {
    mockLaunchWithoutCliFile();
    const update = mockUpdate();
    mocks.ask.mockResolvedValue(true);
    mocks.isQuitGateInProgress.mockReturnValue(true);

    await act(async () => root.render(<Probe />));

    expect(update.install).toHaveBeenCalledOnce();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(mocks.showNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Updater.Installed",
      }),
    );
    expect(mocks.info).toHaveBeenCalledWith(
      "Update restart deferred: a quit is already in progress",
    );
    expect(update.close).toHaveBeenCalledOnce();
  });

  test("does not relaunch when scanning blocking tabs throws", async () => {
    mockLaunchWithoutCliFile();
    const update = mockUpdate();
    mocks.ask.mockResolvedValue(true);
    mocks.scanBlockingTabs.mockImplementation(() => {
      throw new Error("store unavailable");
    });

    await act(async () => root.render(<Probe />));

    expect(update.install).toHaveBeenCalledOnce();
    expect(update.install.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.scanBlockingTabs.mock.invocationCallOrder[0],
    );
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(mocks.showNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Updater.Installed",
      }),
    );
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("store unavailable"));
    expect(mocks.info).not.toHaveBeenCalledWith(
      "Update restart deferred: unsaved work in open tabs",
    );
    expect(update.close).toHaveBeenCalledOnce();
  });

  test("notifies the user and does not install when the download fails", async () => {
    mockLaunchWithoutCliFile();
    const update = mockUpdate({
      download: () => Promise.reject(new Error("signature mismatch")),
    });
    mocks.ask.mockResolvedValue(true);

    await act(async () => root.render(<Probe />));

    expect(mocks.showNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Updater.InstallFailed",
        message: expect.stringContaining("signature mismatch"),
      }),
    );
    expect(update.install).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(update.close).toHaveBeenCalledOnce();
  });

  test("notifies the user and does not relaunch when the install fails", async () => {
    mockLaunchWithoutCliFile();
    const update = mockUpdate({
      install: () => Promise.reject(new Error("installer refused")),
    });
    mocks.ask.mockResolvedValue(true);

    await act(async () => root.render(<Probe />));

    expect(mocks.showNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Updater.InstallFailed",
        message: expect.stringContaining("installer refused"),
      }),
    );
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(update.close).toHaveBeenCalledOnce();
  });

  test("does not relaunch when the install settles after unmount", async () => {
    mockLaunchWithoutCliFile();
    let finishInstall: () => void = () => undefined;
    const update = mockUpdate({
      install: () =>
        new Promise<void>((resolve) => {
          finishInstall = resolve;
        }),
    });
    mocks.ask.mockResolvedValue(true);

    await act(async () => root.render(<Probe />));
    expect(update.install).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
    await act(async () => finishInstall());

    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(mocks.showNotification).not.toHaveBeenCalled();
    expect(update.close).toHaveBeenCalledOnce();
  });

  test("on Windows postpones install when a blocking tab has unsaved work", async () => {
    mocks.platform.mockReturnValue("windows");
    mockLaunchWithoutCliFile();
    const update = mockUpdate({ install: neverResolves });
    mocks.ask.mockResolvedValue(true);
    mocks.scanBlockingTabs.mockImplementation((tabs) =>
      tabs === storedTabs ? [{ value: "t1", name: "Analysis", uninspectable: false }] : [],
    );

    await act(async () => root.render(<Probe />));

    expect(update.install).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(mocks.showNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Updater.Postponed",
        message: "Updater.SaveToInstall:9.9.9",
        autoClose: false,
      }),
    );
    expect(update.download.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.scanBlockingTabs.mock.invocationCallOrder[0],
    );
    expect(update.close).toHaveBeenCalledOnce();
  });

  test("on Windows postpones install when the quit gate is in progress", async () => {
    mocks.platform.mockReturnValue("windows");
    mockLaunchWithoutCliFile();
    const update = mockUpdate({ install: neverResolves });
    mocks.ask.mockResolvedValue(true);
    mocks.isQuitGateInProgress.mockReturnValue(true);

    await act(async () => root.render(<Probe />));

    expect(update.install).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(mocks.showNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Updater.Postponed",
      }),
    );
    expect(update.close).toHaveBeenCalledOnce();
  });

  test("on Windows does not install when scanning blocking tabs throws", async () => {
    mocks.platform.mockReturnValue("windows");
    mockLaunchWithoutCliFile();
    const update = mockUpdate({ install: neverResolves });
    mocks.ask.mockResolvedValue(true);
    mocks.scanBlockingTabs.mockImplementation(() => {
      throw new Error("store unavailable");
    });

    await act(async () => root.render(<Probe />));

    expect(update.install).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(mocks.showNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Updater.Postponed",
        message: "Updater.SaveToInstall:9.9.9",
        autoClose: false,
      }),
    );
    expect(update.close).toHaveBeenCalledOnce();
  });

  test("on Windows scans for unsaved work before installing", async () => {
    mocks.platform.mockReturnValue("windows");
    mockLaunchWithoutCliFile();
    const update = mockUpdate({ install: neverResolves });
    mocks.ask.mockResolvedValue(true);

    await act(async () => root.render(<Probe />));

    expect(mocks.scanBlockingTabs.mock.invocationCallOrder[0]).toBeLessThan(
      update.install.mock.invocationCallOrder[0],
    );
    expect(update.install).toHaveBeenCalledOnce();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  test("skips the check when startup was cancelled", async () => {
    let resolveOwners: () => void = () => {};
    mocks.reconcileStartupPathOwners.mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          resolveOwners = () => resolve(null);
        }),
    );

    await act(async () => root.render(<Probe />));
    await act(async () => root.unmount());
    await act(async () => resolveOwners());

    expect(mocks.check).not.toHaveBeenCalled();
  });
});

describe("App", () => {
  test("installs native context menu suppression and removes it on unmount", async () => {
    mockLaunchWithoutCliFile();
    await act(async () => root.render(<App />));
    const plain = document.createElement("div");
    const input = document.createElement("input");
    container.append(plain, input);
    const dispatch = (element: Element) => {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(dispatch(plain)).toBe(true);
    expect(dispatch(input)).toBe(false);
    await act(async () => root.render(null));
    // Keep the same plain element attached so the event still reaches window after unmount.
    container.append(plain);
    expect(dispatch(plain)).toBe(false);
  });

  test("applies the persisted font size and theme settings", async () => {
    mockLaunchWithoutCliFile();

    await act(async () => root.render(<App />));

    expect(document.documentElement.style.fontSize).toBe("120%");
    expect(document.documentElement.style.getPropertyValue("--piece-size")).toBe("100%");
    expect(mocks.createAppTheme).toHaveBeenCalledExactlyOnceWith({
      spellCheck: true,
      fontSize: 120,
    });
    expect(mocks.closeSplashscreen).toHaveBeenCalledOnce();
  });

  test("applies the persisted piece size on the document root", async () => {
    mockLaunchWithoutCliFile();

    await act(async () => root.render(<App />));
    expect(document.documentElement.style.getPropertyValue("--piece-size")).toBe("100%");

    atomValues.set(mocks.pieceSizeAtom, 70);
    await act(async () => root.render(<App />));
    expect(document.documentElement.style.getPropertyValue("--piece-size")).toBe("70%");
  });

  test("rebuilds the theme when the mounted app's font scale changes", async () => {
    mockLaunchWithoutCliFile();
    await act(async () => root.render(<App />));
    await act(async () => root.render(<App />));
    expect(mocks.createAppTheme).toHaveBeenCalledTimes(1);

    atomValues.set(mocks.fontSizeAtom, 200);
    await act(async () => root.render(<App />));

    expect(document.documentElement.style.fontSize).toBe("200%");
    expect(mocks.createAppTheme).toHaveBeenCalledTimes(2);
    expect(mocks.createAppTheme).toHaveBeenLastCalledWith({
      spellCheck: true,
      fontSize: 200,
    });
  });

  /** `convert_progress` was lost once because a listener was deleted from this composition file
   * and nothing noticed (`.claude/rules/ipc-events.md`). Coverage cannot see that: a deleted hook
   * call leaves no uncovered line behind. These assertions are what does. */
  test("keeps the renderer-side subscriptions wired", async () => {
    mockLaunchWithoutCliFile();

    await act(async () => root.render(<App />));

    expect(mocks.useConversionProgress).toHaveBeenCalled();
    expect(mocks.sessionPersistenceNotice).toHaveBeenCalled();
    expect(mocks.automaticStockfishNotice).toHaveBeenCalled();
    expect(mocks.useDatabaseContentValidation).toHaveBeenCalled();
    expect(mocks.useDocumentLanguage).toHaveBeenCalled();
  });
});
