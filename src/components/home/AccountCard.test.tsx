import { MantineProvider } from "@mantine/core";
import { getDefaultStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { accountCompletionsAtom, accountDownloadsInFlightAtom } from "@/state/atoms";
import type { AccountCompletion } from "@/bindings";

const mocks = vi.hoisted(() => ({
  language: "en-US",
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
  useTranslation: () => ({
    t: (key: string, options?: { date?: string }) =>
      key === "Home.Accounts.LastUpdate" ? `${key}: ${options?.date}` : key,
    i18n: { language: mocks.language },
  }),
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
  mocks.language = "en-US";
  mocks.progress.mockResolvedValue(vi.fn());
  getDefaultStore().set(accountDownloadsInFlightAtom, new Map());
  getDefaultStore().set(accountCompletionsAtom, new Map());
});

async function renderAccount(
  root: Root,
  cache = new Map(),
  database: import("@/utils/db").ManagedDatabaseInfo | null = null,
  updatedAt = 0,
  accountHandle?: string,
) {
  await act(async () => {
    root.render(
      <MantineProvider>
        <SWRConfig value={{ provider: () => cache }}>
          <AccountCard
            type="lichess"
            database={database}
            title="Felix"
            updatedAt={updatedAt}
            total={0}
            stats={[]}
            logout={vi.fn()}
            reload={vi.fn()}
            accountHandle={accountHandle}
          />
        </SWRConfig>
      </MantineProvider>,
    );
  });
}

test("account last update uses the interface language", async () => {
  mocks.language = "de-DE";
  const updatedAt = new Date("2024-06-22T12:00:00Z").getTime();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await renderAccount(root, new Map(), null, updatedAt);
    expect(host.textContent).toContain(new Date(updatedAt).toLocaleDateString("de-DE"));
    expect(host.textContent).not.toContain(new Date(updatedAt).toLocaleDateString("en-US"));
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

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

function accountCompletionFixture(overrides: Partial<AccountCompletion> = {}): AccountCompletion {
  return {
    id: "op-1",
    request: {
      provider: "lichess",
      account: "Felix",
      accountHandle: "lichess-account",
      destination: { id: "dest" },
      pendingBatch: null,
      sinceMs: null,
      target: {
        kind: "unlinked",
        database: { id: { id: "db" }, kind: "database" },
        title: "Felix Lichess",
      },
    },
    progressId: "ticket-1",
    attempt: 1,
    importing: false,
    outcome: { state: "running" },
    publication: null,
    committedDatabase: null,
    deletionPending: false,
    ...overrides,
  };
}

test("retrying a retained terminal completion hides 100% when native reuses its progressId and renders 0%", async () => {
  let progressListener!: (event: { payload: { id: string; progress: number } }) => void;
  mocks.progress.mockImplementation(async (listener) => {
    progressListener = listener;
    return vi.fn();
  });

  const runningAttempt1 = accountCompletionFixture({ attempt: 1, outcome: { state: "running" } });
  const retainedTerminal = accountCompletionFixture({
    attempt: 1,
    outcome: {
      state: "failed",
      result: { tag: "backend-error", category: "database", message: "cleanup pending" },
    },
    deletionPending: true,
  });
  const runningAttempt2 = accountCompletionFixture({
    attempt: 2,
    outcome: { state: "running" },
    deletionPending: true,
  });

  const store = getDefaultStore();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await renderAccount(root, new Map(), null, 0, "lichess-account");

    await act(async () => {
      store.set(accountCompletionsAtom, new Map([["lichess_felix", runningAttempt1]]));
    });
    await act(async () => progressListener({ payload: { id: "ticket-1", progress: 100 } }));
    expect(host.textContent).toContain("100%");

    await act(async () => {
      store.set(accountCompletionsAtom, new Map([["lichess_felix", retainedTerminal]]));
      store.set(accountDownloadsInFlightAtom, new Map([["lichess_felix", null]]));
    });
    expect(host.textContent).not.toContain("100%");

    await act(async () => progressListener({ payload: { id: "ticket-1", progress: 95 } }));
    expect(host.textContent).not.toContain("95%");

    await act(async () => {
      store.set(accountDownloadsInFlightAtom, new Map());
      store.set(accountCompletionsAtom, new Map([["lichess_felix", runningAttempt2]]));
    });
    expect(host.textContent).not.toContain("100%");
    expect(host.textContent).not.toContain("95%");

    await act(async () => progressListener({ payload: { id: "ticket-1", progress: 0 } }));
    expect(host.textContent).toContain("0%");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    store.set(accountDownloadsInFlightAtom, new Map());
    store.set(accountCompletionsAtom, new Map());
  }
});

test("switching to a running completion with a different progressId hides 100% until a matching frame arrives", async () => {
  let progressListener!: (event: { payload: { id: string; progress: number } }) => void;
  mocks.progress.mockImplementation(async (listener) => {
    progressListener = listener;
    return vi.fn();
  });

  const store = getDefaultStore();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await renderAccount(root, new Map(), null, 0, "lichess-account");

    await act(async () => {
      store.set(
        accountCompletionsAtom,
        new Map([["lichess_felix", accountCompletionFixture({ progressId: "ticket-1" })]]),
      );
    });
    await act(async () => progressListener({ payload: { id: "ticket-1", progress: 100 } }));
    expect(host.textContent).toContain("100%");

    await act(async () => {
      store.set(
        accountCompletionsAtom,
        new Map([
          ["lichess_felix", accountCompletionFixture({ id: "op-2", progressId: "ticket-2" })],
        ]),
      );
    });
    expect(host.textContent).not.toContain("100%");

    await act(async () => progressListener({ payload: { id: "ticket-1", progress: 80 } }));
    expect(host.textContent).not.toContain("80%");

    await act(async () => progressListener({ payload: { id: "ticket-2", progress: 25 } }));
    expect(host.textContent).toContain("25%");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    store.set(accountCompletionsAtom, new Map());
  }
});

test("two mounted AccountCards for the same accountKey never show attempt 1's 100% on attempt 2", async () => {
  const listeners = new Set<(event: { payload: { id: string; progress: number } }) => void>();
  mocks.progress.mockImplementation(async (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  let releaseWorkspace!: (reason?: unknown) => void;
  mocks.getDatabaseWorkspace.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        releaseWorkspace = reject;
      }),
  );

  const emitProgress = async (id: string, progress: number) => {
    await act(async () => {
      for (const listener of listeners) {
        listener({ payload: { id, progress } });
      }
    });
  };

  const store = getDefaultStore();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <MantineProvider>
          <SWRConfig value={{ provider: () => new Map() }}>
            <div data-card="0">
              <AccountCard
                type="lichess"
                database={null}
                title="Felix"
                updatedAt={0}
                total={0}
                stats={[]}
                logout={vi.fn()}
                reload={vi.fn()}
                accountHandle="lichess-account"
              />
            </div>
            <div data-card="1">
              <AccountCard
                type="lichess"
                database={null}
                title="Felix"
                updatedAt={0}
                total={0}
                stats={[]}
                logout={vi.fn()}
                reload={vi.fn()}
                accountHandle="lichess-account"
              />
            </div>
          </SWRConfig>
        </MantineProvider>,
      );
    });

    const card0 = host.querySelector<HTMLElement>('[data-card="0"]')!;
    const card1 = host.querySelector<HTMLElement>('[data-card="1"]')!;

    await act(async () => {
      store.set(
        accountCompletionsAtom,
        new Map([["lichess_felix", accountCompletionFixture({ attempt: 1 })]]),
      );
    });
    await emitProgress("ticket-1", 100);
    expect(card0.textContent).toContain("100%");
    expect(card1.textContent).toContain("100%");

    await act(async () => {
      store.set(
        accountCompletionsAtom,
        new Map([
          [
            "lichess_felix",
            accountCompletionFixture({
              attempt: 1,
              outcome: {
                state: "failed",
                result: { tag: "backend-error", category: "database", message: "cleanup pending" },
              },
              deletionPending: true,
            }),
          ],
        ]),
      );
    });
    expect(card0.textContent).not.toContain("100%");
    expect(card1.textContent).not.toContain("100%");

    // Trigger retry from card 0 only; card 1 receives no click.
    await act(async () => {
      card0
        .querySelector<HTMLButtonElement>('button[aria-label="Home.Accounts.DownloadGames"]')!
        .click();
    });
    await act(async () => {
      store.set(
        accountCompletionsAtom,
        new Map([
          ["lichess_felix", accountCompletionFixture({ attempt: 2, deletionPending: true })],
        ]),
      );
    });
    expect(card0.textContent).not.toContain("100%");
    expect(card1.textContent).not.toContain("100%");

    await emitProgress("ticket-1", 0);
    expect(card0.textContent).toContain("0%");
    expect(card1.textContent).toContain("0%");

    await act(async () => {
      releaseWorkspace(new DOMException("Cancellation", "AbortError"));
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    store.set(accountDownloadsInFlightAtom, new Map());
    store.set(accountCompletionsAtom, new Map());
  }
});
