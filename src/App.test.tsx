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
    closeSplashscreen: vi.fn(),
    getDefaultStore: vi.fn(),
    getMatches: vi.fn(),
    info: vi.fn(),
    preloadReferenceDb: vi.fn(),
    reconcileStartupPathOwners: vi.fn(),
    reconcileEngineAttachments: vi.fn(),
    warn: vi.fn(),
    referenceDbAtom,
    fontSizeAtom,
    pieceSetAtom,
    pieceSizeAtom,
    spellCheckAtom,
  };
});

vi.mock("@/platform/native", () => ({
  ask: mocks.ask,
  attachConsole: mocks.attachConsole,
  check: mocks.check,
  getMatches: mocks.getMatches,
  info: mocks.info,
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

/** An available update whose install can be driven by the test. */
function mockUpdate(downloadAndInstall: () => Promise<void> = () => Promise.resolve()) {
  const update = {
    version: "9.9.9",
    downloadAndInstall: vi.fn(downloadAndInstall),
    close: vi.fn(() => Promise.resolve()),
  };
  mocks.check.mockResolvedValue(update);
  return update;
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

  mocks.createAppTheme.mockReset().mockReturnValue({});
  mocks.useConversionProgress.mockReset();
  mocks.useDatabaseContentValidation.mockReset();
  mocks.useDocumentLanguage.mockReset();
  mocks.sessionPersistenceNotice.mockClear();
  mocks.useAtomValue.mockReset();

  storeValues = { referenceDb: undefined };
  mocks.getDefaultStore.mockReturnValue({
    get: (atom: object) => {
      if (atom === mocks.referenceDbAtom) return storeValues.referenceDb;
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
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(update.close).toHaveBeenCalledOnce();
  });

  test("downloads, installs and relaunches when the user accepts", async () => {
    mockLaunchWithoutCliFile();
    const update = mockUpdate();
    mocks.ask.mockResolvedValue(true);

    await act(async () => root.render(<Probe />));

    expect(update.downloadAndInstall).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(update.downloadAndInstall.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.relaunch.mock.invocationCallOrder[0],
    );
  });

  test("notifies the user and does not relaunch when the install fails", async () => {
    mockLaunchWithoutCliFile();
    mockUpdate(() => Promise.reject(new Error("signature mismatch")));
    mocks.ask.mockResolvedValue(true);

    await act(async () => root.render(<Probe />));

    expect(mocks.showNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Updater.InstallFailed",
        message: expect.stringContaining("signature mismatch"),
      }),
    );
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  test("does not relaunch when the install settles after unmount", async () => {
    mockLaunchWithoutCliFile();
    let finishInstall: () => void = () => undefined;
    const update = mockUpdate(
      () =>
        new Promise<void>((resolve) => {
          finishInstall = resolve;
        }),
    );
    mocks.ask.mockResolvedValue(true);

    await act(async () => root.render(<Probe />));
    expect(update.downloadAndInstall).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
    await act(async () => finishInstall());

    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(mocks.showNotification).not.toHaveBeenCalled();
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
    expect(mocks.useDatabaseContentValidation).toHaveBeenCalled();
    expect(mocks.useDocumentLanguage).toHaveBeenCalled();
  });
});
