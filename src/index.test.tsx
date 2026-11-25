import type { ReactElement } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import App from "./App";
import { StartupStorageFailure } from "./components/home/StartupStorageFailure";
import { WorkspaceReadFailure } from "./components/home/WorkspaceReadFailure";
import i18n from "./i18n";
import "./bootstrap";

const {
  render,
  createRoot,
  logFailureSafely,
  closeSplashscreen,
  initializeI18n,
  releasePreviousDocumentOperations,
  restoreWorkspaceSessionAtStart,
  markWorkspaceSessionRestoreFailed,
  initializeWorkspace,
  initializeDownloadFailures,
  initializeEngineCompletions,
  initializePathOwners,
} = vi.hoisted(() => {
  const render = vi.fn();
  return {
    render,
    createRoot: vi.fn(() => ({ render })),
    logFailureSafely: vi.fn().mockResolvedValue(undefined),
    closeSplashscreen: vi.fn().mockResolvedValue(undefined),
    initializeI18n: vi.fn().mockResolvedValue(undefined),
    releasePreviousDocumentOperations: vi.fn().mockResolvedValue(null),
    restoreWorkspaceSessionAtStart: vi.fn().mockResolvedValue({ kind: "empty" }),
    markWorkspaceSessionRestoreFailed: vi.fn(),
    initializeWorkspace: vi.fn(),
    initializeDownloadFailures: vi.fn().mockResolvedValue(undefined),
    initializeEngineCompletions: vi.fn().mockResolvedValue(undefined),
    initializePathOwners: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("react-dom/client", () => ({ createRoot }));
vi.mock("./App", () => ({ default: () => null }));
vi.mock("./state/workspaceSession", () => ({
  restoreWorkspaceSessionAtStart,
  markWorkspaceSessionRestoreFailed,
}));
vi.mock("./state/pathOwners", () => ({
  initializePathOwners,
}));
vi.mock("./state/engineCompletions", () => ({
  initializeEngineCompletions,
}));
vi.mock("./hooks/downloadJobs", () => ({ initializeDownloadFailures }));
vi.mock("./state/atoms", () => ({ initializeWorkspace }));
vi.mock("./components/home/StartupStorageFailure", () => ({ StartupStorageFailure: () => null }));
vi.mock("./components/home/WorkspaceReadFailure", () => ({ WorkspaceReadFailure: () => null }));
vi.mock("./platform/errors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./platform/errors")>()),
  logFailureSafely,
}));
vi.mock("./platform/tauri", () => ({
  tauri: { closeSplashscreen, releasePreviousDocumentOperations },
}));
// Only the bootstrap call is stubbed. `SessionSanitizationError` stays the real
// class so the terminal branch is pinned to the error the product actually throws.
vi.mock("./utils/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils/session")>()),
  initializePersistedSessions: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./i18n", () => ({ default: {}, initializeI18n }));
vi.mock("react-i18next", () => ({
  I18nextProvider: ({ children }: { children: React.ReactNode }) => children,
}));

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  createRoot.mockClear();
  render.mockClear();
  initializeI18n.mockClear();
  logFailureSafely.mockClear();
  closeSplashscreen.mockClear();
  releasePreviousDocumentOperations.mockReset().mockResolvedValue(null);
  restoreWorkspaceSessionAtStart.mockReset().mockResolvedValue({ kind: "empty" });
  markWorkspaceSessionRestoreFailed.mockReset();
  initializeWorkspace.mockReset();
  initializeDownloadFailures.mockReset().mockResolvedValue(undefined);
  initializeEngineCompletions.mockReset().mockResolvedValue(undefined);
  initializePathOwners.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
  vi.resetModules();
});

test("importing bootstrap leaves document startup untouched", async () => {
  await import("./bootstrap");
  expect(initializeWorkspace).not.toHaveBeenCalled();
  expect(createRoot).not.toHaveBeenCalled();
  expect(releasePreviousDocumentOperations).not.toHaveBeenCalled();
  expect(initializeI18n).not.toHaveBeenCalled();
  expect(initializeDownloadFailures).not.toHaveBeenCalled();
  expect(initializePathOwners).not.toHaveBeenCalled();
  expect(initializeEngineCompletions).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
});

test("awaits path owners before engines and mount and starts each document only once", async () => {
  let finishPaths!: () => void;
  initializePathOwners.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finishPaths = resolve;
    }),
  );
  const { startApplication } = await import("./bootstrap");
  const startup = startApplication();
  expect(startApplication()).toBe(startup);
  await vi.waitFor(() => expect(initializePathOwners).toHaveBeenCalledOnce());
  expect(initializeEngineCompletions).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
  finishPaths();
  await startup;
  expect(startApplication()).toBe(startup);
  expect(createRoot).toHaveBeenCalledOnce();
  expect(releasePreviousDocumentOperations).toHaveBeenCalledOnce();
  expect(initializeDownloadFailures).toHaveBeenCalledOnce();
  expect(initializePathOwners).toHaveBeenCalledOnce();
  expect(initializeEngineCompletions).toHaveBeenCalledOnce();
  expect(render).toHaveBeenCalledOnce();
  expect(initializePathOwners.mock.invocationCallOrder[0]).toBeLessThan(
    initializeEngineCompletions.mock.invocationCallOrder[0]!,
  );
  expect(initializeEngineCompletions.mock.invocationCallOrder[0]).toBeLessThan(
    render.mock.invocationCallOrder[0]!,
  );
});

test("a rejected path initialization skips engines and still mounts App", async () => {
  initializePathOwners.mockRejectedValueOnce(new Error("path initialization failed"));
  const { startApplication } = await import("./bootstrap");
  await startApplication();
  expect(initializeEngineCompletions).not.toHaveBeenCalled();
  expect(renderedChild().type).toBe(App);
  expect(logFailureSafely).toHaveBeenCalledOnce();
});

test("awaits the previous-document sweep before sessions, i18n and rendering", async () => {
  const sessions = await import("./utils/session");
  vi.mocked(sessions.initializePersistedSessions).mockClear();
  let finishSweep!: () => void;
  releasePreviousDocumentOperations.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finishSweep = resolve;
    }),
  );
  const { startApplication } = await import("./bootstrap");
  const applicationStartup = startApplication();
  await vi.waitFor(() => expect(releasePreviousDocumentOperations).toHaveBeenCalledOnce());
  expect(restoreWorkspaceSessionAtStart).toHaveBeenCalledExactlyOnceWith();
  expect(initializeWorkspace).toHaveBeenCalledExactlyOnceWith();
  expect(restoreWorkspaceSessionAtStart.mock.invocationCallOrder[0]).toBeLessThan(
    initializeWorkspace.mock.invocationCallOrder[0] ?? 0,
  );
  expect(initializeWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
    releasePreviousDocumentOperations.mock.invocationCallOrder[0] ?? 0,
  );
  expect(releasePreviousDocumentOperations).toHaveBeenCalledExactlyOnceWith();
  expect(sessions.initializePersistedSessions).not.toHaveBeenCalled();
  expect(initializeI18n).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
  finishSweep();
  await applicationStartup;
  expect(sessions.initializePersistedSessions).toHaveBeenCalledTimes(1);
  expect(initializeI18n).toHaveBeenCalledTimes(1);
  expect(renderedChild().type).toBe(App);
});

test("an unexpected workspace exception propagates without caching startup", async () => {
  const failure = new DOMException("workspace read refused", "SecurityError");
  initializeWorkspace.mockImplementationOnce(() => {
    throw failure;
  });
  const sessions = await import("./utils/session");
  vi.mocked(sessions.initializePersistedSessions).mockClear();

  const { startApplication } = await import("./bootstrap");
  await expect(startApplication()).rejects.toThrow(failure);

  expect(releasePreviousDocumentOperations).not.toHaveBeenCalled();
  expect(sessions.initializePersistedSessions).not.toHaveBeenCalled();
  expect(initializeI18n).not.toHaveBeenCalled();
  expect(createRoot).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
  await startApplication();
  expect(createRoot).toHaveBeenCalledOnce();
});

test.each([false, true])(
  "a workspace read refusal renders and reveals one retry screen even when i18n rejects: %s",
  async (i18nRejects) => {
    const { WorkspaceReadError } = await import("./state/workspace");
    initializeWorkspace.mockImplementation(() => {
      throw new WorkspaceReadError(new DOMException("read refused", "SecurityError"));
    });
    if (i18nRejects) initializeI18n.mockRejectedValueOnce(new Error("locale load failed"));
    const sessions = await import("./utils/session");
    vi.mocked(sessions.initializePersistedSessions).mockClear();
    const { startApplication } = await import("./bootstrap");

    const startup = startApplication();
    expect(startApplication()).toBe(startup);
    await expect(startup).resolves.toBeUndefined();
    expect(startApplication()).toBe(startup);

    expect(initializeWorkspace).toHaveBeenCalledOnce();
    expect(createRoot).toHaveBeenCalledOnce();
    expect(initializeI18n).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledOnce();
    expect(renderedChild().type).toBe(WorkspaceReadFailure);
    expect(renderedChild().type).not.toBe(App);
    expect(closeSplashscreen).toHaveBeenCalledExactlyOnceWith();
    expect(initializeI18n.mock.invocationCallOrder[0]).toBeLessThan(
      render.mock.invocationCallOrder[0]!,
    );
    expect(render.mock.invocationCallOrder[0]).toBeLessThan(
      closeSplashscreen.mock.invocationCallOrder[0]!,
    );
    expect(releasePreviousDocumentOperations).not.toHaveBeenCalled();
    expect(sessions.initializePersistedSessions).not.toHaveBeenCalled();
    expect(initializeDownloadFailures).not.toHaveBeenCalled();
    expect(initializePathOwners).not.toHaveBeenCalled();
    expect(initializeEngineCompletions).not.toHaveBeenCalled();
    expect(logFailureSafely).not.toHaveBeenCalled();
  },
);

test("a workspace refusal logs the existing splash-close diagnostic when reveal fails", async () => {
  const { WorkspaceReadError } = await import("./state/workspace");
  initializeWorkspace.mockImplementationOnce(() => {
    throw new WorkspaceReadError(new Error("read refused"));
  });
  closeSplashscreen.mockRejectedValueOnce(new Error("reveal failed"));
  const { startApplication } = await import("./bootstrap");
  await expect(startApplication()).resolves.toBeUndefined();
  expect(renderedChild().type).toBe(WorkspaceReadFailure);
  expect(logFailureSafely).toHaveBeenCalledExactlyOnceWith(
    "StartupWindowRevealError",
    {
      operation: "closeSplashscreen",
      primaryFailure: { category: "unexpected", message: "StartupWindowRevealError" },
    },
    "Startup window reveal failed",
  );
});

test("logs a rejected previous-document sweep and still renders the application", async () => {
  releasePreviousDocumentOperations.mockRejectedValueOnce({
    tag: "backend-error",
    category: "network",
    message: "native registry request failed at /home/private/registry token=secret-registry-token",
  });
  const { startApplication } = await import("./bootstrap");
  const applicationStartup = startApplication();
  await expect(applicationStartup).resolves.toBeUndefined();
  expect(logFailureSafely).toHaveBeenCalledExactlyOnceWith(
    "StartupReservationReleaseError: network: native registry request failed at [path] token=[redacted]",
    {
      operation: "releasePreviousDocumentOperations",
      primaryFailure: {
        category: "network",
        message: "native registry request failed at [path] token=[redacted]",
      },
    },
    "Startup reservation release failed",
  );
  expect(initializeI18n).toHaveBeenCalledTimes(1);
  expect(render).toHaveBeenCalledTimes(1);
  expect(renderedChild().type).toBe(App);
});

test("initialises the browser application root", async () => {
  const { startApplication } = await import("./bootstrap");
  const applicationStartup = startApplication();
  await applicationStartup;

  expect(createRoot).toHaveBeenCalledWith(document.getElementById("app"));
  expect(render).toHaveBeenCalledTimes(1);
  expect(initializeI18n).toHaveBeenCalledTimes(1);
  expect(renderedChild().type).toBe(App);
  expect(closeSplashscreen).not.toHaveBeenCalled();
  expect(logFailureSafely).not.toHaveBeenCalled();
  expect(initializeDownloadFailures).toHaveBeenCalledExactlyOnceWith();
  expect(initializeDownloadFailures.mock.invocationCallOrder[0]).toBeLessThan(
    initializeEngineCompletions.mock.invocationCallOrder[0] ?? 0,
  );
  expect(initializeDownloadFailures.mock.invocationCallOrder[0]).toBeLessThan(
    render.mock.invocationCallOrder[0] ?? 0,
  );
});

test.each(["observer", "engine"])("isolates %s recovery failure", async (failure) => {
  (failure === "observer"
    ? initializeDownloadFailures
    : initializeEngineCompletions
  ).mockRejectedValueOnce(new Error("recovery failed"));
  const { startApplication } = await import("./bootstrap");
  const applicationStartup = startApplication();
  await applicationStartup;
  expect(initializeDownloadFailures).toHaveBeenCalledExactlyOnceWith();
  expect(initializeEngineCompletions).toHaveBeenCalledExactlyOnceWith();
  expect(renderedChild().type).toBe(App);
  expect(logFailureSafely).toHaveBeenCalledTimes(1);
});

function renderedChild() {
  const provider = render.mock.calls[0]?.[0] as ReactElement<{
    i18n: unknown;
    children: ReactElement;
  }>;
  expect(provider.props.i18n).toBe(i18n);
  return provider.props.children;
}

test.each([
  [false, true],
  [true, true],
  [true, false],
])(
  "renders the terminal view for summary %s/%s without exposing credentials",
  async (legacySignInFound, allRevoked) => {
    const sessions = await import("./utils/session");
    const token = "secret-legacy-bearer-token";
    const username = "private-account-name";
    localStorage.setItem(
      "sessions",
      JSON.stringify([{ lichess: { accessToken: token, username } }]),
    );
    const unresolvedReasons = allRevoked ? [] : ["unreachable", "rejected"];
    const error = new sessions.SessionSanitizationError(legacySignInFound, allRevoked, [
      ...unresolvedReasons,
      token,
      username,
      ...unresolvedReasons,
    ]);
    error.unresolvedReasons.push(token as never);
    error.message = `${token} ${username}`;
    vi.mocked(sessions.initializePersistedSessions).mockRejectedValueOnce(error);

    const { startApplication } = await import("./bootstrap");
    const applicationStartup = startApplication();

    await expect(applicationStartup).resolves.toBeUndefined();
    expect(initializeI18n).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);
    expect(renderedChild().type).toBe(StartupStorageFailure);
    expect(renderedChild().type).not.toBe(App);
    expect(renderedChild().props).toEqual({ legacySignInFound, allRevoked, unresolvedReasons });
    expect(initializeDownloadFailures).not.toHaveBeenCalled();
    expect(initializePathOwners).not.toHaveBeenCalled();
    expect(initializeEngineCompletions).not.toHaveBeenCalled();
    expect(closeSplashscreen).toHaveBeenCalledExactlyOnceWith();
    expect(logFailureSafely).toHaveBeenCalledTimes(1);
    const diagnostic = `SessionSanitizationError: legacySignInFound=${legacySignInFound}, allRevoked=${allRevoked}, unresolvedReasons=${unresolvedReasons.join(",")}`;
    expect(logFailureSafely).toHaveBeenCalledWith(
      diagnostic,
      {
        operation: "initializePersistedSessions",
        primaryFailure: { category: "unexpected", message: diagnostic },
      },
      "Session sanitization failed",
    );
    expect(JSON.stringify(logFailureSafely.mock.calls)).not.toContain(token);
    expect(JSON.stringify(logFailureSafely.mock.calls)).not.toContain(username);
    expect(initializeI18n.mock.invocationCallOrder[0]).toBeLessThan(
      render.mock.invocationCallOrder[0] ?? 0,
    );
    expect(render.mock.invocationCallOrder[0]).toBeLessThan(
      closeSplashscreen.mock.invocationCallOrder[0] ?? 0,
    );
    expect(closeSplashscreen.mock.invocationCallOrder[0]).toBeLessThan(
      logFailureSafely.mock.invocationCallOrder[0] ?? 0,
    );
  },
);

test("renders and reveals the terminal view even when i18n initialization rejects", async () => {
  const sessions = await import("./utils/session");
  vi.mocked(sessions.initializePersistedSessions).mockRejectedValueOnce(
    new sessions.SessionSanitizationError(true, false),
  );
  initializeI18n.mockRejectedValueOnce(new Error("locale load failed"));
  const { startApplication } = await import("./bootstrap");
  const applicationStartup = startApplication();
  await expect(applicationStartup).resolves.toBeUndefined();
  expect(initializeI18n).toHaveBeenCalledTimes(1);
  expect(render).toHaveBeenCalledTimes(1);
  expect(renderedChild().type).toBe(StartupStorageFailure);
  expect(renderedChild().props).toEqual({
    legacySignInFound: true,
    allRevoked: false,
    unresolvedReasons: ["unconfirmed"],
  });
  expect(closeSplashscreen).toHaveBeenCalledExactlyOnceWith();
  expect(logFailureSafely).toHaveBeenCalledTimes(1);
});

test("logs a sanitized reveal failure and resolves startup", async () => {
  const sessions = await import("./utils/session");
  vi.mocked(sessions.initializePersistedSessions).mockRejectedValueOnce(
    new sessions.SessionSanitizationError(),
  );
  closeSplashscreen.mockRejectedValueOnce(new Error("token=secret username=private"));
  const { startApplication } = await import("./bootstrap");
  const applicationStartup = startApplication();
  await expect(applicationStartup).resolves.toBeUndefined();
  expect(render).toHaveBeenCalledTimes(1);
  expect(renderedChild().type).toBe(StartupStorageFailure);
  expect(closeSplashscreen).toHaveBeenCalledExactlyOnceWith();
  expect(logFailureSafely).toHaveBeenCalledTimes(2);
  expect(logFailureSafely).toHaveBeenNthCalledWith(
    1,
    "StartupWindowRevealError",
    {
      operation: "closeSplashscreen",
      primaryFailure: { category: "unexpected", message: "StartupWindowRevealError" },
    },
    "Startup window reveal failed",
  );
  const diagnostic =
    "SessionSanitizationError: legacySignInFound=false, allRevoked=true, unresolvedReasons=";
  expect(logFailureSafely).toHaveBeenNthCalledWith(
    2,
    diagnostic,
    {
      operation: "initializePersistedSessions",
      primaryFailure: { category: "unexpected", message: diagnostic },
    },
    "Session sanitization failed",
  );
  expect(closeSplashscreen.mock.invocationCallOrder[0]).toBeLessThan(
    logFailureSafely.mock.invocationCallOrder[0] ?? 0,
  );
});

test("mounts after a non-sensitive reconciliation failure", async () => {
  const sessions = await import("./utils/session");
  vi.mocked(sessions.initializePersistedSessions).mockRejectedValueOnce(
    new Error("native account lookup failed"),
  );

  const { startApplication } = await import("./bootstrap");
  const applicationStartup = startApplication();
  await applicationStartup;

  expect(initializeI18n).toHaveBeenCalledTimes(1);
  expect(render).toHaveBeenCalledTimes(1);
  expect(renderedChild().type).toBe(App);
  expect(closeSplashscreen).not.toHaveBeenCalled();
  expect(logFailureSafely).not.toHaveBeenCalled();
});

test("mounts App after a recoverable public save outcome", async () => {
  const sessions = await import("./utils/session");
  vi.mocked(sessions.initializePersistedSessions).mockResolvedValueOnce({
    status: "unsaved",
    sessions: [{ alias: "Public alias", updatedAt: 1 }],
  });
  const { startApplication } = await import("./bootstrap");
  const applicationStartup = startApplication();
  await applicationStartup;
  expect(renderedChild().type).toBe(App);
  expect(logFailureSafely).not.toHaveBeenCalled();
});

test("startup removes the obsolete accent preference once without hydrating it", async () => {
  localStorage.setItem("mantine-primary-color", '"red"');
  const remove = vi.spyOn(Storage.prototype, "removeItem");
  try {
    const { startApplication } = await import("./bootstrap");
    await startApplication();
    await startApplication();
    expect(localStorage.getItem("mantine-primary-color")).toBeNull();
    expect(remove.mock.calls.filter(([key]) => key === "mantine-primary-color")).toHaveLength(1);
    expect(renderedChild().type).toBe(App);
  } finally {
    remove.mockRestore();
  }
});

test("refused obsolete-accent removal never blocks startup", async () => {
  const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation((key) => {
    if (key === "mantine-primary-color") throw new Error("storage refused");
  });
  try {
    const { startApplication } = await import("./bootstrap");
    await expect(startApplication()).resolves.toBeUndefined();
    expect(initializeWorkspace).toHaveBeenCalledOnce();
    expect(renderedChild().type).toBe(App);
  } finally {
    remove.mockRestore();
  }
});

test("an unexpected restoreWorkspaceSessionAtStart throw fails closed into store-unavailable mode", async () => {
  const error = new Error("unexpected restore crash");
  restoreWorkspaceSessionAtStart.mockRejectedValueOnce(error);
  const { startApplication } = await import("./bootstrap");
  await expect(startApplication()).resolves.toBeUndefined();
  expect(markWorkspaceSessionRestoreFailed).toHaveBeenCalledExactlyOnceWith(error);
  expect(logFailureSafely).toHaveBeenCalledOnce();
  expect(renderedChild().type).toBe(App);
});
