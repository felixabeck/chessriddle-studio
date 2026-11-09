import { MantineProvider } from "@mantine/core";
import { getDefaultStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { accountDownloadsInFlightAtom } from "@/state/atoms";

const mocks = vi.hoisted(() => ({
  linkedCollectionsSupported: vi.fn(async () => false),
  getDatabaseWorkspace: vi.fn(),
  createWorkspaceDatabase: vi.fn(),
  listWorkspaceDatabases: vi.fn(),
  getDatabases: vi.fn(),
  progress: vi.fn(),
  notifyListenerError: vi.fn(),
  pendingAccountCompletions: vi.fn(async () => []),
  acknowledgeAccountCompletion: vi.fn(),
  completionChanged: vi.fn(async () => vi.fn()),
}));

vi.mock("@/platform/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
  return {
    ...actual,
    tauri: mocks,
    tauriSubscriptions: { progress: mocks.progress, completionChanged: mocks.completionChanged },
  };
});
vi.mock("@/utils/db", () => ({ getDatabases: mocks.getDatabases }));
vi.mock("@/components/files/notifyError", async () => {
  const actual = await vi.importActual<typeof import("@/components/files/notifyError")>(
    "@/components/files/notifyError",
  );
  return { ...actual, notifyListenerError: mocks.notifyListenerError };
});
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();

import { TauriCommandError } from "@/platform/tauri";
import { AccountCard, ensureAccountDatabaseHandle } from "./AccountCard";

test("cleanup create does not run account database recovery", async () => {
  const cause = new TauriCommandError({
    tag: "backend-error",
    category: "operation-and-cleanup",
    message: "native failure",
  });
  mocks.getDatabaseWorkspace.mockResolvedValue({
    root: { id: { id: "root" }, kind: "databaseRoot" },
    displayName: "Databases",
  });
  mocks.listWorkspaceDatabases.mockResolvedValueOnce({ entries: [], unread: [] });
  mocks.createWorkspaceDatabase.mockRejectedValueOnce(cause);
  await expect(ensureAccountDatabaseHandle(undefined, "Felix", "lichess")).rejects.toBe(cause);
  expect(mocks.createWorkspaceDatabase).toHaveBeenCalledOnce();
  expect(mocks.listWorkspaceDatabases).toHaveBeenCalledOnce();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.progress.mockResolvedValue(vi.fn());
  getDefaultStore().set(accountDownloadsInFlightAtom, new Map());
});

async function renderAccount(
  root: Root,
  cache = new Map(),
  database: import("@/utils/db").ManagedDatabaseInfo | null = null,
) {
  await act(async () => {
    root.render(
      <MantineProvider>
        <SWRConfig value={{ provider: () => cache }}>
          <AccountCard
            type="lichess"
            database={database}
            title="Felix"
            updatedAt={0}
            total={0}
            stats={[]}
            logout={vi.fn()}
            reload={vi.fn()}
          />
        </SWRConfig>
      </MantineProvider>,
    );
  });
}

test.each(["upgrading", "busy"] as const)(
  "a %s row displays its transient message and unknown count",
  async (transient) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const error =
      transient === "upgrading"
        ? "This database is being upgraded to the current format. Large databases can take several minutes."
        : "This database is in use and cannot be read right now. It is retried automatically.";
    try {
      await renderAccount(root, new Map(), {
        type: "error",
        file: { id: { id: "held" }, kind: "database" },
        filename: "Felix_lichess.db3",
        indexed: false,
        transient,
        error,
      });
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(error);
      expect(host.textContent).toContain("Common.Unknown");
      expect(host.textContent).not.toContain("0 / 0");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  },
);

test.each([
  {
    path: "structured backend-error",
    rejection: new TauriCommandError({
      tag: "backend-error",
      category: "durability",
      message: "Committed but durability uncertain: registry replacement",
    }),
  },
  {
    path: "string fallback",
    // Fallback-path coverage: classify() still matches this owned Display literal.
    rejection: new Error("Committed but durability uncertain: registry replacement"),
  },
])(
  "recovers an account database handle after an uncertain create via the $path",
  async ({ rejection }) => {
    const root = { id: { id: "database-root" }, kind: "databaseRoot" };
    const handle = { id: { id: "database" }, kind: "database" };
    mocks.getDatabaseWorkspace.mockResolvedValue({ root: root, displayName: "Databases" });
    mocks.listWorkspaceDatabases
      .mockResolvedValueOnce({ entries: [], unread: [] })
      .mockResolvedValueOnce({
        entries: [{ handle, filename: "Felix_lichess.db3", availability: "available" }],
        unread: [],
      });
    mocks.createWorkspaceDatabase.mockRejectedValue(rejection);

    await expect(ensureAccountDatabaseHandle(undefined, "Felix", "lichess")).resolves.toBe(handle);
    expect(mocks.createWorkspaceDatabase).toHaveBeenCalledWith(root, "Felix_lichess.db3");
    expect(mocks.listWorkspaceDatabases).toHaveBeenCalledTimes(2);
  },
);

test("a progress frame does not publish databases before or after unmount", async () => {
  let progressListener!: (event: {
    payload: { id: string; progress: number; finished: boolean };
  }) => void;
  const cache = new Map();
  mocks.progress.mockImplementation(async (listener) => {
    progressListener = listener;
    return vi.fn();
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await renderAccount(root, cache);
  act(() => {
    progressListener({ payload: { id: "lichess_Felix", progress: 100, finished: true } });
  });

  await act(async () => root.unmount());
  act(() => {
    progressListener({ payload: { id: "lichess_Felix", progress: 100, finished: true } });
  });

  expect(mocks.getDatabases).not.toHaveBeenCalled();
  expect(cache.get("databases")?.data).toBeUndefined();
  host.remove();
});

test("an adapter decoding error notifies only while mounted and leaves progress unchanged", async () => {
  let progressListener!: (event: { payload: { id: string; progress: number } }) => void;
  let reportError: ((error: unknown, event: { payload: unknown }) => void) | undefined;
  const unlisten = vi.fn();
  mocks.progress.mockImplementation(async (listener, onError) => {
    progressListener = listener;
    reportError = onError;
    return unlisten;
  });
  getDefaultStore().set(accountDownloadsInFlightAtom, new Map([["lichess_felix", "download-job"]]));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const error = new TypeError("generation must be a canonical unsigned u64 decimal string");
  const malformed = { payload: { id: "download-job", generation: "01", progress: 99 } };
  try {
    await renderAccount(root);
    await act(async () => progressListener({ payload: { id: "download-job", progress: 35 } }));
    expect(host.textContent).toContain("35%");

    // The adapter drops the frame and reports its decoding error through the supplied callback.
    await act(async () => reportError?.(error, malformed));
    expect(mocks.notifyListenerError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: error.message }),
      malformed,
    );
    expect(host.textContent).toContain("35%");
    expect(host.textContent).not.toContain("99%");

    await act(async () => root.render(null));
    expect(unlisten).toHaveBeenCalledOnce();
    await act(async () => {
      reportError?.(error, malformed);
      progressListener({ payload: { id: "download-job", progress: 99 } });
    });
    expect(mocks.notifyListenerError).toHaveBeenCalledOnce();
    expect(host.textContent).toBe("");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    getDefaultStore().set(accountDownloadsInFlightAtom, new Map());
  }
});
