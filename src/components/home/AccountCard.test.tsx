import { MantineProvider } from "@mantine/core";
import { getDefaultStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import {
  accountCompletionsAtom,
  accountDownloadsInFlightAtom,
  accountDownloadsStartedEmptyAtom,
  downloadDestinationAtom,
} from "@/state/atoms";
import type { AccountCompletion, ProgressEvent } from "@/bindings";

const mocks = vi.hoisted(() => ({
  language: "en-US",
  linkedCollectionsSupported: vi.fn(async () => false),
  prepareAccountCollection: vi.fn(),
  ensureFileWorkspace: vi.fn(),
  getDatabaseWorkspace: vi.fn(),
  createWorkspaceDatabase: vi.fn(),
  listWorkspaceDatabases: vi.fn(),
  downloadDestinationIsKnown: vi.fn(async () => false),
  issueDownloadDestination: vi.fn(),
  importAccountGames: vi.fn(),
  getDatabases: vi.fn(),
  getProgress: vi.fn(async (): Promise<import("@/bindings").ProgressItem | null> => null),
  progress: vi.fn(),
  notifyListenerError: vi.fn(),
  pendingAccountCompletions: vi.fn(async (): Promise<AccountCompletion[]> => []),
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
vi.mock("@/utils/files", () => ({ ensureFileWorkspace: mocks.ensureFileWorkspace }));
vi.mock("@/components/files/notifyError", async () => {
  const actual = await vi.importActual<typeof import("@/components/files/notifyError")>(
    "@/components/files/notifyError",
  );
  return { ...actual, notifyListenerError: mocks.notifyListenerError };
});
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: { date?: string; loaded?: string; total?: string; count?: number },
    ) => {
      if (key === "Home.Accounts.LastUpdate") return `${key}: ${options?.date}`;
      if (key === "Common.LoadingGames") return "Loading games…";
      if (key === "Common.GamesLoadedOf") {
        return options?.count === 1
          ? `${options.loaded} of ${options.total} game loaded`
          : `${options?.loaded} of ${options?.total} games loaded`;
      }
      if (key === "Common.GamesLoaded") {
        return options?.count === 1
          ? `${options.loaded} game loaded`
          : `${options?.loaded} games loaded`;
      }
      return key;
    },
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
  mocks.linkedCollectionsSupported.mockResolvedValue(false);
  mocks.pendingAccountCompletions.mockResolvedValue([]);
  mocks.getProgress.mockResolvedValue(null);
  mocks.progress.mockResolvedValue(vi.fn());
  getDefaultStore().set(accountDownloadsInFlightAtom, new Map());
  getDefaultStore().set(accountDownloadsStartedEmptyAtom, new Set());
  getDefaultStore().set(accountCompletionsAtom, new Map());
});

function progressPayload(overrides: Partial<ProgressEvent> & { id: string }): ProgressEvent {
  return {
    generation: 1n,
    progress: 0,
    finished: false,
    state: "running",
    cleared: false,
    count: null,
    ...overrides,
  };
}

async function renderAccount(
  root: Root,
  cache = new Map(),
  database: import("@/utils/db").ManagedDatabaseInfo | null = null,
  updatedAt = 0,
  accountHandle?: string,
  total = 0,
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
            total={total}
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
  let progressListener!: (event: { payload: ProgressEvent }) => void;
  const cache = new Map();
  mocks.progress.mockImplementation(async (listener) => {
    progressListener = listener;
    return vi.fn();
  });
  getDefaultStore().set(accountDownloadsInFlightAtom, new Map([["lichess_felix", "download-job"]]));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await renderAccount(root, cache);
    await act(async () => {
      progressListener({
        payload: progressPayload({
          id: "download-job",
          progress: 100,
          finished: true,
          state: "succeeded",
          count: 10,
        }),
      });
    });

    await act(async () => root.unmount());
    await act(async () => {
      progressListener({
        payload: progressPayload({
          id: "download-job",
          progress: 100,
          finished: true,
          state: "succeeded",
          count: 10,
        }),
      });
    });

    expect(mocks.getDatabases).not.toHaveBeenCalled();
    expect(cache.get("databases")?.data).toBeUndefined();
  } finally {
    host.remove();
    getDefaultStore().set(accountDownloadsInFlightAtom, new Map());
  }
});

test("an adapter decoding error notifies only while mounted and leaves progress unchanged", async () => {
  let progressListener!: (event: { payload: ProgressEvent }) => void;
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
  const malformed = { payload: { id: "download-job", generation: "01", progress: 99, count: 99 } };
  try {
    await renderAccount(root);
    await act(async () =>
      progressListener({
        payload: progressPayload({ id: "download-job", progress: 35, count: 35 }),
      }),
    );
    expect(host.textContent).toContain("35 games loaded");
    expect(host.textContent).not.toContain("%");

    // The adapter drops the frame and reports its decoding error through the supplied callback.
    await act(async () => reportError?.(error, malformed));
    expect(mocks.notifyListenerError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: error.message }),
      malformed,
    );
    expect(host.textContent).toContain("35 games loaded");
    expect(host.textContent).not.toContain("99 games loaded");

    await act(async () => root.render(null));
    expect(unlisten).toHaveBeenCalledOnce();
    await act(async () => {
      reportError?.(error, malformed);
      progressListener({
        payload: progressPayload({ id: "download-job", progress: 99, count: 99 }),
      });
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

test("retrying a retained terminal completion hides the prior count when native reuses its progressId", async () => {
  let progressListener!: (event: { payload: ProgressEvent }) => void;
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
  const terminalAttempt1 = progressPayload({
    id: "ticket-1",
    generation: 1n,
    progress: 100,
    finished: true,
    state: "succeeded",
    count: 100,
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
    await act(async () =>
      progressListener({ payload: progressPayload({ id: "ticket-1", progress: 100, count: 100 }) }),
    );
    expect(host.textContent).toContain("100 games loaded");
    expect(host.textContent).not.toContain("%");

    // Attempt 1's terminal item remains in the native store when attempt 2 reuses ticket-1.
    mocks.getProgress.mockResolvedValue(terminalAttempt1);

    await act(async () => {
      store.set(accountCompletionsAtom, new Map([["lichess_felix", retainedTerminal]]));
      store.set(accountDownloadsInFlightAtom, new Map([["lichess_felix", null]]));
    });
    expect(host.textContent).toContain("Loading games…");
    expect(host.textContent).not.toContain("100 games loaded");

    await act(async () => {
      store.set(accountDownloadsInFlightAtom, new Map());
      store.set(accountCompletionsAtom, new Map([["lichess_felix", runningAttempt2]]));
    });
    await vi.waitFor(() => expect(mocks.getProgress).toHaveBeenCalledWith("ticket-1"));
    expect(host.textContent).toContain("Loading games…");
    expect(host.textContent).not.toContain("100 games loaded");

    // A later running item with a lower count is shown as 5, never latched at attempt 1's 100.
    await act(async () =>
      progressListener({
        payload: progressPayload({
          id: "ticket-1",
          generation: 2n,
          progress: 0,
          finished: false,
          state: "running",
          count: 5,
        }),
      }),
    );
    expect(host.textContent).toContain("5 games loaded");
    expect(host.textContent).not.toContain("100 games loaded");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    store.set(accountDownloadsInFlightAtom, new Map());
    store.set(accountCompletionsAtom, new Map());
  }
});

test("switching to a different completion id hides the previous run's count until a matching frame arrives", async () => {
  let progressListener!: (event: { payload: ProgressEvent }) => void;
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
    await act(async () =>
      progressListener({ payload: progressPayload({ id: "ticket-1", progress: 100, count: 100 }) }),
    );
    expect(host.textContent).toContain("100 games loaded");

    await act(async () => {
      store.set(
        accountCompletionsAtom,
        new Map([
          ["lichess_felix", accountCompletionFixture({ id: "op-2", progressId: "ticket-2" })],
        ]),
      );
    });
    expect(host.textContent).toContain("Loading games…");
    expect(host.textContent).not.toContain("100 games loaded");

    await act(async () =>
      progressListener({ payload: progressPayload({ id: "ticket-1", progress: 80, count: 80 }) }),
    );
    expect(host.textContent).not.toContain("80 games loaded");

    await act(async () =>
      progressListener({ payload: progressPayload({ id: "ticket-2", progress: 25, count: 25 }) }),
    );
    expect(host.textContent).toContain("25 games loaded");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    store.set(accountCompletionsAtom, new Map());
  }
});

test("two mounted AccountCards for the same accountKey never show attempt 1's count on attempt 2", async () => {
  const listeners = new Set<(event: { payload: ProgressEvent }) => void>();
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

  const emitProgress = async (id: string, count: number, generation = 1n) => {
    await act(async () => {
      for (const listener of listeners) {
        listener({ payload: progressPayload({ id, generation, count }) });
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
    expect(card0.textContent).toContain("100 games loaded");
    expect(card1.textContent).toContain("100 games loaded");

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
    expect(card0.textContent).not.toContain("100 games loaded");
    expect(card1.textContent).not.toContain("100 games loaded");

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
    expect(card0.textContent).toContain("Loading games…");
    expect(card1.textContent).toContain("Loading games…");

    await emitProgress("ticket-1", 0, 2n);
    expect(card0.textContent).toContain("0 games loaded");
    expect(card1.textContent).toContain("0 games loaded");

    await act(async () => {
      releaseWorkspace(new DOMException("Cancellation", "AbortError"));
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    store.set(accountDownloadsInFlightAtom, new Map());
    store.set(accountDownloadsStartedEmptyAtom, new Set());
    store.set(accountCompletionsAtom, new Map());
  }
});

test("Lichess card without accountHandle enables download and sends accountHandle: null", async () => {
  const rootHandle = { id: { id: "db-root" }, kind: "databaseRoot" as const };
  const dbHandle = { id: { id: "db-handle" }, kind: "database" as const };
  const destination = { id: "download-dest" };
  mocks.getDatabaseWorkspace.mockResolvedValue({
    root: rootHandle,
    displayName: "Databases",
  });
  mocks.listWorkspaceDatabases.mockResolvedValue({
    entries: [{ handle: dbHandle, filename: "Felix_lichess.db3", availability: "available" }],
    unread: [],
  });
  mocks.issueDownloadDestination.mockResolvedValue(destination);
  mocks.importAccountGames.mockResolvedValue(
    accountCompletionFixture({
      request: {
        provider: "lichess",
        account: "Felix",
        accountHandle: null,
        destination,
        pendingBatch: null,
        sinceMs: null,
        target: {
          kind: "unlinked",
          database: dbHandle,
          title: "Felix Lichess",
        },
      },
      outcome: { state: "succeeded", result: { collectionNotice: false } },
    }),
  );

  const store = getDefaultStore();
  store.set(downloadDestinationAtom, null);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await renderAccount(root, new Map(), null, 0, undefined);
    const button = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Home.Accounts.DownloadGames"]',
    )!;
    expect(button.disabled).toBe(false);

    await act(async () => {
      button.click();
    });

    expect(mocks.importAccountGames).toHaveBeenCalledExactlyOnceWith({
      provider: "lichess",
      account: "Felix",
      accountHandle: null,
      destination,
      pendingBatch: null,
      sinceMs: null,
      target: {
        kind: "unlinked",
        database: dbHandle,
        title: "Felix Lichess",
      },
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    store.set(accountDownloadsInFlightAtom, new Map());
    store.set(accountDownloadsStartedEmptyAtom, new Set());
    store.set(accountCompletionsAtom, new Map());
    store.set(downloadDestinationAtom, null);
  }
});

test("keeps the last count across a ticket change and count-less lease, stays running between chunks, and returns to idle row after", async () => {
  let progressListener!: (event: { payload: ProgressEvent }) => void;
  mocks.progress.mockImplementation(async (listener) => {
    progressListener = listener;
    return vi.fn();
  });

  const store = getDefaultStore();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await renderAccount(root, new Map(), null, 0, "lichess-account", 5000);
    expect(host.textContent).toContain("0 / 5000");

    // Chunk 1 starts on ticket-1.
    await act(async () => {
      store.set(
        accountCompletionsAtom,
        new Map([
          [
            "lichess_felix",
            accountCompletionFixture({ id: "op-1", attempt: 1, progressId: "ticket-1" }),
          ],
        ]),
      );
    });
    expect(host.textContent).toContain("Loading games…");
    expect(host.textContent).not.toContain("0 / 5000");

    await act(async () =>
      progressListener({ payload: progressPayload({ id: "ticket-1", count: 1200 }) }),
    );
    expect(host.textContent).toContain("1,200 games loaded");
    expect(host.textContent).not.toContain("%");

    // Chunk 1's lease finishes while the whole run is still pending: stays running (animated).
    await act(async () =>
      progressListener({
        payload: progressPayload({
          id: "ticket-1",
          progress: 100,
          finished: true,
          state: "succeeded",
          count: 1200,
        }),
      }),
    );
    expect(host.textContent).toContain("1,200 games loaded");
    expect(host.querySelector<HTMLElement>('[role="progressbar"]')?.dataset.animated).toBe("true");

    // Chunk 2 switches to ticket-2 within the same completion id + attempt: count is retained.
    await act(async () => {
      store.set(
        accountCompletionsAtom,
        new Map([
          [
            "lichess_felix",
            accountCompletionFixture({ id: "op-1", attempt: 1, progressId: "ticket-2" }),
          ],
        ]),
      );
    });
    expect(host.textContent).toContain("1,200 games loaded");

    // A count-less lease update on ticket-2 keeps the retained count.
    await act(async () =>
      progressListener({ payload: progressPayload({ id: "ticket-2", progress: 50, count: null }) }),
    );
    expect(host.textContent).toContain("1,200 games loaded");

    // A newer count on ticket-2 advances the line.
    await act(async () =>
      progressListener({ payload: progressPayload({ id: "ticket-2", progress: 75, count: 1500 }) }),
    );
    expect(host.textContent).toContain("1,500 games loaded");

    // Run ends: live line disappears and idle row returns.
    await act(async () => {
      store.set(accountCompletionsAtom, new Map());
    });
    expect(host.textContent).toContain("0 / 5000");
    expect(host.textContent).not.toContain("1,500 games loaded");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    store.set(accountDownloadsInFlightAtom, new Map());
    store.set(accountDownloadsStartedEmptyAtom, new Set());
    store.set(accountCompletionsAtom, new Map());
  }
});

test("shows total only for a run started here on a known-empty database, including after remount, and clears the start record when done", async () => {
  let progressListener!: (event: { payload: ProgressEvent }) => void;
  mocks.progress.mockImplementation(async (listener) => {
    progressListener = listener;
    return vi.fn();
  });
  const rootHandle = { id: { id: "db-root" }, kind: "databaseRoot" as const };
  const dbHandle = { id: { id: "db-handle" }, kind: "database" as const };
  const destination = { id: "download-dest" };
  mocks.getDatabaseWorkspace.mockResolvedValue({ root: rootHandle, displayName: "Databases" });
  mocks.listWorkspaceDatabases.mockResolvedValue({
    entries: [{ handle: dbHandle, filename: "Felix_lichess.db3", availability: "available" }],
    unread: [],
  });
  mocks.issueDownloadDestination.mockResolvedValue(destination);

  let finishImport!: (value: AccountCompletion) => void;
  mocks.importAccountGames.mockImplementation(
    () =>
      new Promise<AccountCompletion>((resolve) => {
        finishImport = resolve;
      }),
  );

  const store = getDefaultStore();
  store.set(downloadDestinationAtom, null);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await renderAccount(root, new Map(), null, 0, "lichess-account", 5000);
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Home.Accounts.DownloadGames"]')!
        .click();
    });

    expect(store.get(accountDownloadsStartedEmptyAtom).has("lichess_felix")).toBe(true);
    const running = accountCompletionFixture({ progressId: "ticket-1" });
    mocks.pendingAccountCompletions.mockResolvedValue([running]);
    await act(async () => {
      store.set(accountCompletionsAtom, new Map([["lichess_felix", running]]));
    });
    await act(async () =>
      progressListener({ payload: progressPayload({ id: "ticket-1", count: 1234 }) }),
    );
    expect(host.textContent).toContain("1,234 of 5,000 games loaded");

    // Remount while still running: total eligibility survives via accountDownloadsStartedEmptyAtom.
    await act(async () => root.render(null));
    mocks.getProgress.mockResolvedValueOnce(progressPayload({ id: "ticket-1", count: 1234 }));
    await renderAccount(root, new Map(), null, 0, "lichess-account", 5000);
    await vi.waitFor(() => expect(host.textContent).toContain("1,234 of 5,000 games loaded"));

    // Finish the run: start record is removed.
    mocks.pendingAccountCompletions.mockResolvedValue([]);
    await act(async () => {
      finishImport(
        accountCompletionFixture({
          outcome: { state: "succeeded", result: { collectionNotice: false } },
        }),
      );
    });
    expect(store.get(accountDownloadsStartedEmptyAtom).has("lichess_felix")).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    store.set(accountDownloadsInFlightAtom, new Map());
    store.set(accountDownloadsStartedEmptyAtom, new Set());
    store.set(accountCompletionsAtom, new Map());
    store.set(downloadDestinationAtom, null);
  }
});

test.each([
  {
    name: "known-empty loaded database (game_count === 0)",
    database: {
      type: "success" as const,
      file: { id: { id: "empty-db" }, kind: "database" as const },
      filename: "Felix_lichess.db3",
      title: "Felix Lichess",
      description: "",
      player_count: 0,
      event_count: 0,
      game_count: 0,
      storage_size: "0",
      indexed: false,
    },
    total: 5000,
    expectedLine: "42 of 5,000 games loaded",
  },
  {
    name: "non-empty loaded database (incremental update, game_count > 0)",
    database: {
      type: "success" as const,
      file: { id: { id: "existing-db" }, kind: "database" as const },
      filename: "Felix_lichess.db3",
      title: "Felix Lichess",
      description: "",
      player_count: 2,
      event_count: 1,
      game_count: 10,
      storage_size: "1024",
      indexed: false,
    },
    total: 5000,
    expectedLine: "42 games loaded",
  },
  {
    name: "errored database",
    database: {
      type: "error" as const,
      file: { id: { id: "err-db" }, kind: "database" as const },
      filename: "Felix_lichess.db3",
      indexed: false,
      error: "corrupt",
    },
    total: 5000,
    expectedLine: "42 games loaded",
  },
  {
    name: "zero total",
    database: null,
    total: 0,
    expectedLine: "42 games loaded",
  },
])("total eligibility for a run started on $name", async ({ database, total, expectedLine }) => {
  let progressListener!: (event: { payload: ProgressEvent }) => void;
  mocks.progress.mockImplementation(async (listener) => {
    progressListener = listener;
    return vi.fn();
  });
  const rootHandle = { id: { id: "db-root" }, kind: "databaseRoot" as const };
  const dbHandle = { id: { id: "db-handle" }, kind: "database" as const };
  const destination = { id: "download-dest" };
  mocks.getDatabaseWorkspace.mockResolvedValue({ root: rootHandle, displayName: "Databases" });
  mocks.listWorkspaceDatabases.mockResolvedValue({
    entries: [{ handle: dbHandle, filename: "Felix_lichess.db3", availability: "available" }],
    unread: [],
  });
  mocks.issueDownloadDestination.mockResolvedValue(destination);

  let finishImport!: (value: AccountCompletion) => void;
  mocks.importAccountGames.mockImplementation(
    () =>
      new Promise<AccountCompletion>((resolve) => {
        finishImport = resolve;
      }),
  );

  const store = getDefaultStore();
  store.set(downloadDestinationAtom, null);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await renderAccount(root, new Map(), database, 0, "lichess-account", total);
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Home.Accounts.DownloadGames"]')!
        .click();
    });
    await act(async () => {
      store.set(
        accountCompletionsAtom,
        new Map([["lichess_felix", accountCompletionFixture({ progressId: "ticket-1" })]]),
      );
    });
    await act(async () =>
      progressListener({ payload: progressPayload({ id: "ticket-1", count: 42 }) }),
    );
    expect(host.querySelector('[role="status"]')?.textContent).toBe(expectedLine);

    await act(async () => {
      finishImport(
        accountCompletionFixture({
          outcome: { state: "succeeded", result: { collectionNotice: false } },
        }),
      );
    });
    expect(store.get(accountDownloadsStartedEmptyAtom).has("lichess_felix")).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    store.set(accountDownloadsInFlightAtom, new Map());
    store.set(accountDownloadsStartedEmptyAtom, new Set());
    store.set(accountCompletionsAtom, new Map());
    store.set(downloadDestinationAtom, null);
  }
});

test("clears the start record after an abandoned start such as migration required", async () => {
  mocks.linkedCollectionsSupported.mockResolvedValue(true);
  mocks.ensureFileWorkspace.mockResolvedValue({
    id: { id: "ws" },
    kind: "fileWorkspace",
  });
  mocks.prepareAccountCollection.mockResolvedValue({
    collection: null,
    migrationRequired: true,
    destination: { id: "dest" },
    pendingBatch: null,
  });

  const store = getDefaultStore();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await renderAccount(root, new Map(), null, 0, "lichess-account", 5000);
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Home.Accounts.DownloadGames"]')!
        .click();
    });
    expect(mocks.importAccountGames).not.toHaveBeenCalled();
    expect(store.get(accountDownloadsStartedEmptyAtom).has("lichess_felix")).toBe(false);
    expect(store.get(accountDownloadsInFlightAtom).has("lichess_felix")).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    store.set(accountDownloadsInFlightAtom, new Map());
    store.set(accountDownloadsStartedEmptyAtom, new Set());
    store.set(accountCompletionsAtom, new Map());
  }
});
