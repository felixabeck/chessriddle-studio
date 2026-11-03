import { MantineProvider } from "@mantine/core";
import { Provider, createStore, getDefaultStore } from "jotai";
import { act, Component, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AccountCompletion, AccountImportRequest } from "@/bindings";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { accountDownloadsInFlightAtom, sessionsAtom } from "@/state/atoms";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import Accounts from "./Accounts";
import { SessionPersistenceNotice } from "./SessionPersistenceNotice";
import {
  getSessionPersistenceSnapshot,
  initializePersistedSessions,
  savePublicSessions,
  sessionsSchema,
} from "@/utils/session";
import { deserializeStorageValue, serializeStorageValue } from "@/state/store/debouncedStorage";

const mocks = vi.hoisted(() => ({
  linkedCollectionsSupported: vi.fn(async () => false),
  listLinkedCollections: vi.fn(async () => [] as import("@/bindings").CollectionDescriptor[]),
  prepareAccountCollection: vi.fn(),
  importAccountGames: vi.fn(),
  pendingAccountCompletions: vi.fn(),
  acknowledgeAccountCompletion: vi.fn(),
  completionChanged: vi.fn(),
  collectionForDatabase: vi.fn(
    async () => null as import("@/bindings").CollectionDescriptor | null,
  ),
  getDatabaseWorkspace: vi.fn(),
  listWorkspaceDatabases: vi.fn(),
  getDbInfo: vi.fn(),
  getLatestGameTimestamp: vi.fn(),
  issueDownloadDestination: vi.fn(),
  progress: vi.fn(),
  notify: vi.fn(),
  warn: vi.fn(),
  listLichessAccounts: vi.fn(),
  getPublicLichessJson: vi.fn(),
  getAuthenticatedLichessAccount: vi.fn(),
  removeLichessAccount: vi.fn(),
  createWorkspaceDatabase: vi.fn(),
}));

vi.mock("@/platform/tauri", async (original) => ({
  ...(await original<typeof import("@/platform/tauri")>()),
  tauri: mocks,
  tauriSubscriptions: { progress: mocks.progress, completionChanged: mocks.completionChanged },
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.notify } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/platform/native", () => ({ warn: mocks.warn }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

let root: Root;
let host: HTMLDivElement;
let store: ReturnType<typeof createStore>;
let revalidate: ReturnType<typeof useSWRConfig>["mutate"];
let cache: ReturnType<typeof useSWRConfig>["cache"];
let switchRoot: () => Promise<void>;
let accountSnapshot: AccountCompletion[];
let accountCompletionChanged: (() => void) | undefined;

function accountCompletion(request: AccountImportRequest, running = false): AccountCompletion {
  const completion: AccountCompletion = {
    id: "account-import",
    request,
    progressId: "account-download",
    attempt: 1,
    importing: false,
    outcome: running
      ? { state: "running" }
      : { state: "succeeded", result: { collectionNotice: false } },
    publication: running
      ? null
      : { handle: { id: { id: "pgn" }, kind: "fileWorkspace" }, durability: "Durable" },
    committedDatabase: null,
    deletionPending: false,
  };
  accountSnapshot = [completion];
  return completion;
}

function RevalidationControl() {
  const config = useSWRConfig();
  const owner = useNativeRequestOwner("databases");
  revalidate = config.mutate;
  cache = config.cache;
  switchRoot = async () => {
    await owner!.supersede();
    await config.mutate("databases");
  };
  return null;
}

const oldInfo = {
  filename: "Felix_chesscom.db3",
  title: "Felix",
  description: "",
  player_count: 2,
  event_count: 1,
  game_count: 3,
  storage_size: "0",
  indexed: false,
};

const swrConfig = {
  provider: () => new Map(),
  dedupingInterval: 0,
  shouldRetryOnError: false,
};

class AccountRouteBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  render() {
    return this.state.crashed ? <div>Account route crashed</div> : this.props.children;
  }
}

async function renderAccounts(show = true) {
  await act(async () => {
    root.render(
      <MantineProvider>
        <Provider store={store}>
          <SWRConfig value={swrConfig}>
            {show && <RevalidationControl />}
            {show && (
              <AccountRouteBoundary>
                <Accounts />
              </AccountRouteBoundary>
            )}
            <SessionPersistenceNotice />
          </SWRConfig>
        </Provider>
      </MantineProvider>,
    );
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function downloadButton() {
  return host.querySelector<HTMLButtonElement>('button[aria-label="Home.Accounts.DownloadGames"]')!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.linkedCollectionsSupported.mockResolvedValue(false);
  mocks.listLinkedCollections.mockResolvedValue([]);
  mocks.collectionForDatabase.mockResolvedValue(null);
  localStorage.clear();
  sessionStorage.clear();
  store = createStore();
  store.set(accountDownloadsInFlightAtom, new Map());
  store.set(sessionsAtom, [
    {
      player: "Felix",
      updatedAt: 0,
      chessCom: { username: "Felix", stats: {} },
    },
  ]);
  mocks.getDatabaseWorkspace.mockResolvedValue({ id: { id: "root" }, kind: "databaseRoot" });
  const handle = { id: { id: "database" }, kind: "database" };
  mocks.listWorkspaceDatabases.mockResolvedValue({
    entries: [{ handle, filename: "Felix_chesscom.db3", availability: "available" }],
    unread: [],
  });
  mocks.issueDownloadDestination.mockResolvedValue({ id: "destination" });
  accountSnapshot = [];
  accountCompletionChanged = undefined;
  mocks.completionChanged.mockImplementation(async (listener) => {
    accountCompletionChanged = listener;
    return () => {
      accountCompletionChanged = undefined;
    };
  });
  mocks.pendingAccountCompletions.mockImplementation(async () => accountSnapshot);
  mocks.acknowledgeAccountCompletion.mockImplementation(async (id) => {
    accountSnapshot = accountSnapshot.filter((completion) => completion.id !== id);
  });
  mocks.importAccountGames.mockImplementation(async (request) => accountCompletion(request));
  mocks.progress.mockResolvedValue(vi.fn());
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test.each([{}, { username: "Felix" }, { username: "Foreign" }])(
  "real Accounts retain a unique legacy case variant with cached profile %j and canonical native identity",
  async (profile) => {
    store.set(
      sessionsAtom,
      sessionsSchema.parse([
        {
          player: "Coach",
          updatedAt: 0,
          lichess: { username: "felix", handle: "owned-handle", account: profile },
        },
      ]),
    );
    const handle = { id: { id: "legacy" }, kind: "database" as const };
    mocks.listWorkspaceDatabases.mockResolvedValue({
      entries: [{ handle, filename: "Felix_lichess.db3", availability: "available" }],
      unread: [],
    });
    mocks.getDbInfo.mockResolvedValue({ ...oldInfo, filename: "Felix_lichess.db3" });
    mocks.linkedCollectionsSupported.mockResolvedValue(true);
    mocks.listLinkedCollections.mockResolvedValue([]);
    mocks.prepareAccountCollection.mockRejectedValue(new Error("fixture preparation refused"));
    const atoms = await import("@/state/atoms");
    getDefaultStore().set(atoms.fileWorkspaceAtom, {
      id: { id: "library" },
      kind: "fileWorkspace",
    });
    await renderAccounts();
    expect(host.textContent).toContain("3 / 3");
    await act(async () => downloadButton().click());
    expect(mocks.prepareAccountCollection).toHaveBeenCalledExactlyOnceWith(
      { id: { id: "library" }, kind: "fileWorkspace" },
      { provider: "lichess", account: "felix" },
      handle,
    );
    expect(mocks.importAccountGames).not.toHaveBeenCalled();
  },
);

test.each(["conflict-readable", "conflict-unread", "unread-only", "loading", "failed"])(
  "real Accounts with %s evidence retain management and block preparation and new history",
  async (state) => {
    const held = deferred<import("@/bindings").DatabaseRootHandle>();
    mocks.linkedCollectionsSupported.mockResolvedValue(true);
    mocks.listLinkedCollections.mockResolvedValue([]);
    mocks.getDbInfo.mockImplementation(async (handle) => ({
      ...oldInfo,
      filename: handle.id.id === "second" ? "felix_chesscom.db3" : oldInfo.filename,
    }));
    mocks.listWorkspaceDatabases.mockResolvedValue({
      entries:
        state === "unread-only"
          ? []
          : [
              {
                handle: { id: { id: "first" }, kind: "database" },
                filename: "Felix_chesscom.db3",
                availability: "available",
              },
              ...(state === "conflict-readable"
                ? [
                    {
                      handle: { id: { id: "second" }, kind: "database" },
                      filename: "felix_chesscom.db3",
                      availability: "available",
                    },
                  ]
                : []),
            ],
      unread:
        state === "conflict-unread" || state === "unread-only"
          ? [{ filename: "felix_chesscom.db3", category: "permission" }]
          : [],
    });
    if (state === "loading") mocks.getDatabaseWorkspace.mockReturnValue(held.promise);
    if (state === "failed")
      mocks.getDatabaseWorkspace.mockRejectedValue(new Error("workspace refused"));
    await renderAccounts();
    expect(downloadButton().disabled).toBe(true);
    expect(host.textContent).toContain("Common.Unknown");
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(
      host.querySelector<HTMLButtonElement>('button[aria-label="Home.Accounts.UpdateStats"]')
        ?.disabled,
    ).toBe(false);
    expect(
      host.querySelector<HTMLButtonElement>('button[aria-label="Home.Accounts.RemoveAccount"]')
        ?.disabled,
    ).toBe(false);
    expect(host.textContent).toContain("Home.Accounts.Add");
    await act(async () => downloadButton().click());
    expect(mocks.prepareAccountCollection).not.toHaveBeenCalled();
    expect(mocks.importAccountGames).not.toHaveBeenCalled();
    expect(mocks.createWorkspaceDatabase).not.toHaveBeenCalled();
    if (state === "loading") {
      await act(async () => held.resolve({ id: { id: "root" }, kind: "databaseRoot" }));
    }
    if (state === "failed") {
      mocks.getDatabaseWorkspace.mockResolvedValue({ id: { id: "root" }, kind: "databaseRoot" });
      await act(async () =>
        [...host.querySelectorAll("button")]
          .find((button) => button.textContent === "Common.Retry")!
          .click(),
      );
    }
    await vi.waitFor(() =>
      expect(downloadButton().disabled).toBe(state !== "loading" && state !== "failed"),
    );
  },
);

test("unavailable history still refreshes and removes the owned partial profile while preserving its peer", async () => {
  const accepted = sessionsSchema.parse([
    {
      player: "Coach",
      updatedAt: 0,
      lichess: { username: "e2e-player", handle: "owned-handle", account: {} },
    },
    {
      player: "Coach",
      updatedAt: 0,
      lichess: { username: "peer", handle: "peer-handle", account: {} },
    },
  ]);
  store.set(sessionsAtom, accepted);
  mocks.listWorkspaceDatabases.mockResolvedValue({
    entries: [
      {
        handle: { id: { id: "legacy" }, kind: "database" },
        filename: "e2e-player_lichess.db3",
        availability: "available",
      },
    ],
    unread: [{ filename: "E2E-Player_lichess.db3", category: "permission" }],
  });
  mocks.getDbInfo.mockResolvedValue({ ...oldInfo, filename: "e2e-player_lichess.db3" });
  mocks.getAuthenticatedLichessAccount.mockResolvedValue(
    JSON.stringify({ id: "e2e-player", username: "E2E-Player" }),
  );
  mocks.removeLichessAccount.mockResolvedValue({
    state: "removed",
    revocation_pending: false,
    durability_uncertain: false,
  });
  await renderAccounts();
  expect(downloadButton().disabled).toBe(true);
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('button[aria-label="Home.Accounts.UpdateStats"]')!
      .click(),
  );
  expect(mocks.getAuthenticatedLichessAccount).toHaveBeenCalledExactlyOnceWith("owned-handle");
  expect(store.get(sessionsAtom)[0]?.lichess?.account.username).toBe("E2E-Player");
  expect(store.get(sessionsAtom)[1]).toEqual(accepted[1]);
  expect(downloadButton().disabled).toBe(true);
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('button[aria-label="Home.Accounts.RemoveAccount"]')!
      .click(),
  );
  expect(mocks.removeLichessAccount).toHaveBeenCalledExactlyOnceWith("owned-handle");
  expect(store.get(sessionsAtom)).toEqual([accepted[1]]);
  expect(mocks.prepareAccountCollection).not.toHaveBeenCalled();
  expect(mocks.importAccountGames).not.toHaveBeenCalled();
  expect(mocks.createWorkspaceDatabase).not.toHaveBeenCalled();
});

test("a failed refresh cannot authorize downloads from a retained older listing", async () => {
  mocks.getDbInfo.mockResolvedValue(oldInfo);
  await renderAccounts();
  expect(host.textContent).toContain("3 / 3");
  mocks.getDatabaseWorkspace.mockRejectedValue(new Error("workspace refused"));
  await act(async () => {
    // SWR retains the successful data while exposing this controlled refresh failure.
    await revalidate("databases").catch(() => undefined);
  });
  await vi.waitFor(() => expect(downloadButton().disabled).toBe(true));
  expect(cache.get("databases")?.data?.databases[0]?.game_count).toBe(3);
  expect(cache.get("databases")?.error).toBeDefined();
  expect(host.textContent).toContain("Common.Unknown");
  await act(async () => downloadButton().click());
  expect(mocks.prepareAccountCollection).not.toHaveBeenCalled();
  expect(mocks.importAccountGames).not.toHaveBeenCalled();
  expect(mocks.createWorkspaceDatabase).not.toHaveBeenCalled();
});

test.each([{}, { perfs: { blitz: { games: 2, rating: 1400 } } }])(
  "hydrated partial Lichess profile %j retains account and statistics retry controls when listing fails",
  async (profile) => {
    const accepted = sessionsSchema.parse([
      {
        player: "E2E Spieler",
        updatedAt: 0,
        lichess: { username: "e2e-player", account: profile },
      },
    ]);
    localStorage.setItem("sessions", serializeStorageValue(accepted));
    mocks.listLichessAccounts.mockResolvedValue([]);
    await initializePersistedSessions();
    mocks.getDatabaseWorkspace.mockRejectedValue(new Error("database workspace unavailable"));
    mocks.getPublicLichessJson.mockResolvedValue(
      JSON.stringify({ id: "e2e-player", username: "E2E-Player" }),
    );

    await renderAccounts();

    expect(host.querySelector('button[aria-label="Home.Accounts.UpdateStats"]')).not.toBeNull();
    expect(host.textContent).toContain("Home.Accounts.Add");
    expect(host.textContent).toContain("E2E Spieler");
    expect(host.textContent).toContain("e2e-player");
    expect(host.textContent).not.toContain("Account route crashed");
    expect(host.textContent).not.toContain("database workspace unavailable");
    expect(mocks.getDatabaseWorkspace).toHaveBeenCalled();
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Home.Accounts.UpdateStats"]')!
        .click(),
    );
    expect(mocks.getPublicLichessJson).toHaveBeenCalledExactlyOnceWith({
      kind: "account",
      username: "e2e-player",
    });
    expect(store.get(sessionsAtom)[0]).toMatchObject({
      player: "E2E Spieler",
      lichess: {
        username: "e2e-player",
        account: { id: "e2e-player", username: "E2E-Player" },
      },
    });
    expect(host.textContent).toContain("E2E-Player");
    expect(mocks.notify).not.toHaveBeenCalled();
  },
);

test.each([{}, { username: "DisplaySpelling" }, { username: 17 }])(
  "accepted Lichess profile %j matches canonical linked errors and retains handle and pending ownership",
  async (profile) => {
    store.set(
      sessionsAtom,
      sessionsSchema.parse([
        {
          player: "Coach",
          updatedAt: 0,
          lichess: { username: "e2e-player", handle: "owned-handle", account: profile },
        },
      ]),
    );
    store.set(accountDownloadsInFlightAtom, new Map([["lichess_e2e-player", "owned-ticket"]]));
    const linked: import("@/bindings").CollectionDescriptor = {
      id: "44444444-4444-4444-8444-444444444444",
      name: "Canonical history",
      file: { id: { id: "source" }, kind: "fileWorkspace" },
      database: { id: { id: "cache" }, kind: "database" },
      account: { provider: "lichess", account: "e2e-player" },
      status: "unavailable",
      generation: "current",
      omitted: 0,
      retiredDatabase: null,
      fetchSinceMs: null,
    };
    mocks.linkedCollectionsSupported.mockResolvedValue(true);
    mocks.listLinkedCollections.mockResolvedValue([
      {
        ...linked,
        id: "other-provider",
        status: "ready",
        account: { provider: "chesscom", account: "e2e-player" },
      },
      {
        ...linked,
        id: "other-player",
        status: "ready",
        account: { provider: "lichess", account: "displayspelling" },
      },
      linked,
    ]);
    mocks.collectionForDatabase.mockResolvedValue(linked);
    mocks.getDbInfo.mockResolvedValue(oldInfo);
    mocks.getAuthenticatedLichessAccount.mockResolvedValue(
      JSON.stringify({ id: "e2e-player", username: "E2E-Player" }),
    );

    await renderAccounts();

    expect(host.textContent).toContain("Common.Unknown");
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).toContain(
      "username" in profile && typeof profile.username === "string"
        ? profile.username
        : "e2e-player",
    );
    expect(host.textContent).toContain("Coach");
    expect(downloadButton().disabled).toBe(true);
    await act(async () => store.set(accountDownloadsInFlightAtom, new Map()));
    expect(downloadButton().disabled).toBe(false);
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Home.Accounts.UpdateStats"]')!
        .click(),
    );
    expect(mocks.getAuthenticatedLichessAccount).toHaveBeenCalledExactlyOnceWith("owned-handle");
    expect(store.get(sessionsAtom)[0]?.lichess).toMatchObject({
      username: "e2e-player",
      handle: "owned-handle",
      account: { id: "e2e-player", username: "E2E-Player" },
    });
    expect(host.textContent).toContain("Common.Unknown");
    expect(mocks.importAccountGames).not.toHaveBeenCalled();
  },
);

test("removing one partial Lichess profile retains the other canonical account and its handle", async () => {
  const accepted = sessionsSchema.parse([
    {
      player: "Coach",
      updatedAt: 0,
      lichess: { username: "e2e-player", handle: "owned-handle", account: {} },
    },
    {
      player: "Coach",
      updatedAt: 0,
      lichess: { username: "other-player", handle: "other-handle", account: {} },
    },
  ]);
  store.set(sessionsAtom, accepted);
  mocks.removeLichessAccount.mockResolvedValue({
    state: "removed",
    revocation_pending: false,
    durability_uncertain: false,
  });

  await renderAccounts();
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('button[aria-label="Home.Accounts.RemoveAccount"]')!
      .click(),
  );

  expect(mocks.removeLichessAccount).toHaveBeenCalledExactlyOnceWith("owned-handle");
  expect(store.get(sessionsAtom)).toEqual([accepted[1]]);
  expect(host.textContent).toContain("other-player");
  expect(host.textContent).not.toContain("e2e-player");
});

test.each([false, true])(
  "real Accounts preserve a linked account error instead of zero or legacy counts (legacy present: %s)",
  async (legacyPresent) => {
    store.set(sessionsAtom, [
      { player: "Coach", updatedAt: 0, chessCom: { username: "Felix", stats: {} } },
    ]);
    const linked: import("@/bindings").CollectionDescriptor = {
      id: "33333333-3333-4333-8333-333333333333",
      name: "Accumulated history",
      file: { id: { id: "source" }, kind: "fileWorkspace" },
      database: { id: { id: "cache" }, kind: "database" },
      account: { provider: "chesscom", account: "felix" },
      status: "unavailable",
      generation: "current",
      omitted: 0,
      retiredDatabase: null,
      fetchSinceMs: null,
    };
    mocks.linkedCollectionsSupported.mockResolvedValue(true);
    mocks.listLinkedCollections.mockResolvedValue([
      { ...linked, id: "wrong-provider", account: { provider: "lichess", account: "felix" } },
      { ...linked, id: "wrong-player", account: { provider: "chesscom", account: "coach" } },
      linked,
    ]);
    mocks.collectionForDatabase.mockResolvedValue(linked);
    if (!legacyPresent) mocks.listWorkspaceDatabases.mockResolvedValue({ entries: [], unread: [] });
    if (legacyPresent)
      mocks.listWorkspaceDatabases.mockResolvedValue({
        entries: [
          {
            handle: { id: { id: "legacy" }, kind: "database" },
            filename: "Felix_chesscom.db3",
            availability: "available",
          },
        ],
        unread: [{ filename: "felix_chesscom.db3", category: "permission" }],
      });
    mocks.getDbInfo.mockResolvedValue(oldInfo);

    await renderAccounts();

    expect(host.textContent).toContain("Coach");
    expect(host.textContent).toContain("Common.Unknown");
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).not.toContain("0 / 0");
    expect(host.textContent).not.toContain("3 / 3");
    await renderAccounts(false);
    await renderAccounts();
    expect(host.textContent).toContain("Common.Unknown");
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(mocks.importAccountGames).not.toHaveBeenCalled();
  },
);

test("linked account append survives an unsaved public list, consumer remount and latest-list retry", async () => {
  const source = { id: { id: "accumulated-pgn" }, kind: "fileWorkspace" as const };
  const cache = { id: { id: "linked-cache" }, kind: "database" as const };
  const linked: import("@/bindings").CollectionDescriptor = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Felix history",
    file: source,
    database: cache,
    account: { provider: "chesscom", account: "felix" },
    status: "ready",
    generation: "before",
    omitted: 0,
    retiredDatabase: { id: { id: "database" }, kind: "database" },
    fetchSinceMs: null,
  };
  mocks.linkedCollectionsSupported.mockResolvedValue(true);
  mocks.listLinkedCollections.mockResolvedValue([linked]);
  mocks.collectionForDatabase.mockImplementation(async () => linked);
  mocks.getDbInfo.mockResolvedValue({ ...oldInfo, game_count: 3 });
  mocks.prepareAccountCollection.mockResolvedValue({
    collection: linked,
    migrationRequired: false,
    pendingBatch: null,
    destination: { id: "private-batch-directory" },
  });
  mocks.importAccountGames.mockImplementation(async (request) => {
    mocks.getDbInfo.mockResolvedValue({ ...oldInfo, game_count: 8 });
    mocks.listLinkedCollections.mockResolvedValue([{ ...linked, generation: "after" }]);
    return accountCompletion(request);
  });
  const fileAtoms = await import("@/state/atoms");
  store.set(fileAtoms.fileWorkspaceAtom, { id: { id: "library" }, kind: "fileWorkspace" });
  getDefaultStore().set(fileAtoms.fileWorkspaceAtom, {
    id: { id: "library" },
    kind: "fileWorkspace",
  });
  const originalSet = Storage.prototype.setItem;
  const refusal = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key, value) {
      if (this === localStorage && key === "sessions")
        throw new DOMException("fixture quota", "QuotaExceededError");
      return originalSet.call(this, key, value);
    });
  try {
    await renderAccounts();
    await act(async () => downloadButton().click());
    expect(mocks.importAccountGames).toHaveBeenCalledExactlyOnceWith({
      provider: "chesscom",
      account: "Felix",
      accountHandle: null,
      destination: { id: "private-batch-directory" },
      pendingBatch: null,
      sinceMs: null,
      target: { kind: "linked", collection: linked.id },
    });
    expect(host.textContent).toContain("8 / 8");
    const latest = [
      { player: "Latest alias", updatedAt: 2, chessCom: { username: "Felix", stats: {} } },
    ];
    await act(async () => store.set(sessionsAtom, latest));
    expect(getSessionPersistenceSnapshot().status).toBe("unsaved");
    await renderAccounts(false);
    await renderAccounts();
    expect(host.textContent).toContain("Latest alias");
    expect(host.textContent).toContain("8 / 8");
    expect(host.textContent).toContain("Accounts.Persistence.Unsaved");
    refusal.mockRestore();
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Accounts.Persistence.TryAgain")!
        .click(),
    );
    expect(getSessionPersistenceSnapshot().status).toBe("saved");
    expect(deserializeStorageValue(localStorage.getItem("sessions")!)).toEqual(latest);
    expect(host.textContent).not.toContain("Accounts.Persistence.Unsaved");
    expect(mocks.importAccountGames).toHaveBeenCalledOnce();
  } finally {
    refusal.mockRestore();
    savePublicSessions([]);
  }
});

test("real Accounts retain post-cleanup counts across remount and revalidation of an older listing", async () => {
  const nativeImport = deferred<void>();
  const listing = deferred<typeof oldInfo>();
  const refresh = deferred<typeof oldInfo>();
  const newInfo = { ...oldInfo, game_count: 8 };
  const newDatabases = [
    { type: "success", ...newInfo, file: { id: { id: "database" }, kind: "database" } },
  ];
  mocks.importAccountGames.mockImplementation(async (request) => {
    accountCompletion(request, true);
    accountCompletionChanged?.();
    await nativeImport.promise;
    return accountCompletion(request);
  });
  mocks.getDbInfo
    .mockResolvedValueOnce(oldInfo)
    .mockReturnValueOnce(listing.promise)
    .mockReturnValueOnce(refresh.promise)
    .mockResolvedValue(newInfo);
  await renderAccounts();
  expect(host.textContent).toContain("3 / 3");

  await act(async () => downloadButton().click());
  expect(mocks.importAccountGames).toHaveBeenCalledExactlyOnceWith({
    provider: "chesscom",
    account: "Felix",
    accountHandle: null,
    destination: { id: "destination" },
    pendingBatch: null,
    sinceMs: null,
    target: {
      kind: "unlinked",
      database: { id: { id: "database" }, kind: "database" },
      title: "Felix Chess.com",
    },
  });
  expect(mocks.getDbInfo).toHaveBeenCalledTimes(1);
  expect(mocks.getLatestGameTimestamp).not.toHaveBeenCalled();

  await renderAccounts(false);
  await renderAccounts();
  await act(async () => {
    await vi.waitFor(() => {
      if (mocks.getDbInfo.mock.calls.length !== 2)
        throw new Error("Remounted Accounts have not started listing L");
    });
  });
  expect(host.textContent).toContain("3 / 3");
  expect(downloadButton().disabled).toBe(true);

  await act(async () => nativeImport.resolve());
  expect(mocks.getDbInfo).toHaveBeenCalledTimes(3);
  expect(downloadButton().disabled).toBe(true);
  await act(async () => refresh.resolve(newInfo));
  expect(host.textContent).toContain("8 / 8");
  expect(cache.get("databases")?.data?.databases).toEqual(newDatabases);
  expect(downloadButton().disabled).toBe(false);

  // DatabasesPage's mutate() must not rejoin L after the cleanup refresh.
  let revalidation!: Promise<unknown>;
  await act(async () => {
    revalidation = revalidate("databases");
  });
  await act(async () => {
    listing.resolve(oldInfo);
    await revalidation;
  });

  expect(host.textContent).toContain("8 / 8");
  expect(host.textContent).not.toContain("3 / 3");
  expect(cache.get("databases")?.data?.databases).toEqual(newDatabases);
  expect(mocks.notify).not.toHaveBeenCalled();
  expect(store.get(accountDownloadsInFlightAtom).size).toBe(0);
});

test("a remount that retires a pending import refresh receives the new counts after mutation settles", async () => {
  const refresh = deferred<typeof oldInfo>();
  const listing = deferred<typeof oldInfo>();
  const newInfo = { ...oldInfo, game_count: 8 };
  mocks.getDbInfo
    .mockResolvedValueOnce(oldInfo)
    .mockReturnValueOnce(refresh.promise)
    .mockReturnValueOnce(listing.promise)
    .mockResolvedValue(newInfo);
  const unhandled = vi.fn();
  window.addEventListener("unhandledrejection", unhandled);
  try {
    await renderAccounts();
    expect(host.textContent).toContain("3 / 3");

    await act(async () => downloadButton().click());
    expect(mocks.importAccountGames).toHaveBeenCalledTimes(1);
    expect(mocks.getDbInfo).toHaveBeenCalledTimes(2);
    expect(downloadButton().disabled).toBe(true);

    await renderAccounts(false);
    // Let the provider's zero-length dedupe interval expire before remounting.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await renderAccounts();
    await act(async () => {
      await vi.waitFor(() => {
        if (mocks.getDbInfo.mock.calls.length !== 3)
          throw new Error("Remounted Accounts have not started the replacement listing");
      });
    });
    expect(host.textContent).toContain("3 / 3");

    await act(async () => {
      listing.resolve(newInfo);
      refresh.resolve(newInfo);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain("8 / 8");
    expect(host.textContent).not.toContain("3 / 3");
    expect(cache.get("databases")?.data?.databases).toEqual([
      { type: "success", ...newInfo, file: { id: { id: "database" }, kind: "database" } },
    ]);
    expect(downloadButton().disabled).toBe(false);
    expect(store.get(accountDownloadsInFlightAtom).size).toBe(0);
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("unhandledrejection", unhandled);
  }
});

test("a root switch retires a pending successful import refresh and keeps root B's counts", async () => {
  const refresh = deferred<typeof oldInfo>();
  const rootAInfo = { ...oldInfo, game_count: 8 };
  const rootBInfo = { ...oldInfo, game_count: 13 };
  const rootB = { id: { id: "root-B" }, kind: "databaseRoot" };
  const rootBHandle = { id: { id: "database-B" }, kind: "database" };
  mocks.getDbInfo
    .mockResolvedValueOnce(oldInfo)
    .mockReturnValueOnce(refresh.promise)
    .mockResolvedValue(rootBInfo);
  const unhandled = vi.fn();
  window.addEventListener("unhandledrejection", unhandled);
  try {
    await renderAccounts();
    expect(host.textContent).toContain("3 / 3");

    await act(async () => downloadButton().click());
    expect(mocks.importAccountGames).toHaveBeenCalledTimes(1);
    expect(mocks.getDbInfo).toHaveBeenCalledTimes(2);
    expect(downloadButton().disabled).toBe(true);

    mocks.getDatabaseWorkspace.mockResolvedValue(rootB);
    mocks.listWorkspaceDatabases.mockResolvedValue({
      entries: [{ handle: rootBHandle, filename: "Felix_chesscom.db3", availability: "available" }],
      unread: [],
    });
    // Use DatabasesPage's root-switch sequence in this same SWR provider/cache.
    await act(async () => switchRoot());
    await act(async () => {
      refresh.resolve(rootAInfo);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.getDbInfo).toHaveBeenCalledTimes(3);
    expect(mocks.getDbInfo).toHaveBeenLastCalledWith(rootBHandle);
    expect(host.textContent).toContain("13 / 13");
    expect(host.textContent).not.toContain("8 / 8");
    expect(cache.get("databases")?.data?.databases).toEqual([
      { type: "success", ...rootBInfo, file: rootBHandle },
    ]);
    expect(downloadButton().disabled).toBe(false);
    expect(store.get(accountDownloadsInFlightAtom).size).toBe(0);
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("unhandledrejection", unhandled);
  }
});
