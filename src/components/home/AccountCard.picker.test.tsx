import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider, createStore } from "jotai";
import { SWRConfig, type State } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AccountCompletion, AccountImportRequest, DatabaseHandle } from "@/bindings";
import type { DatabaseList } from "@/utils/db";
import {
  accountCompletionsAtom,
  accountDownloadsInFlightAtom,
  databaseConversionStateAtom,
} from "@/state/atoms";
import { runAccountImport } from "@/state/accountCompletions";
import { isErrorReported } from "@/platform/errors";
import { AccountCard } from "./AccountCard";
import english from "@/translation/en-US.json";

const mocks = vi.hoisted(() => ({
  issueDownloadDestination: vi.fn(),
  downloadDestinationIsKnown: vi.fn(),
  getDatabaseWorkspace: vi.fn(),
  listWorkspaceDatabases: vi.fn(),
  createWorkspaceDatabase: vi.fn(),
  importAccountGames: vi.fn(),
  pendingAccountCompletions: vi.fn(),
  acknowledgeAccountCompletion: vi.fn(),
  linkedCollectionsSupported: vi.fn(),
  prepareAccountCollection: vi.fn(),
  ensureFileWorkspace: vi.fn(),
  getDatabases: vi.fn(),
  logFailureSafely: vi.fn(),
  notify: vi.fn(),
  progress: vi.fn(),
  completionChanged: vi.fn(),
}));
vi.mock("@/platform/tauri", async (original) => ({
  ...(await original<typeof import("@/platform/tauri")>()),
  tauri: mocks,
  tauriSubscriptions: { progress: mocks.progress, completionChanged: mocks.completionChanged },
}));
vi.mock("@/utils/db", async (original) => ({
  ...(await original<typeof import("@/utils/db")>()),
  getDatabases: mocks.getDatabases,
}));
vi.mock("@/utils/files", () => ({ ensureFileWorkspace: mocks.ensureFileWorkspace }));
vi.mock("@/platform/errors", async (original) => ({
  ...(await original<typeof import("@/platform/errors")>()),
  logFailureSafely: mocks.logFailureSafely,
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.notify } }));
vi.mock("@/platform/native", () => ({ warn: vi.fn() }));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  default: {
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ??
      (key === "Home.Accounts.DownloadDurabilityUncertain" ? english.translation[key] : key),
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));
vi.mock("@/components/library/LinkedCollection", () => ({
  CollectionMigration: () => <div data-migration />,
}));
vi.mock("@/components/common/IconAction", () => ({
  IconAction: ({
    label,
    onClick,
    disabled,
    pending,
  }: {
    label: string;
    onClick?: () => void;
    disabled?: boolean;
    pending?: boolean;
  }) => (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      data-pending={pending ? "true" : undefined}
      onClick={onClick}
    >
      {label}
    </button>
  ),
}));
vi.mock("@mantine/core", async () => {
  const Wrapper = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return {
    useMatches: (await import("@/tests/matchMedia")).baseResponsiveValue,
    Alert: Wrapper,
    Badge: Wrapper,
    Card: Object.assign(Wrapper, { Section: Wrapper }),
    Group: Wrapper,
    SimpleGrid: Wrapper,
    Stack: Wrapper,
    Text: Wrapper,
    Tooltip: Wrapper,
    Progress: () => null,
    Button: Wrapper,
  };
});
vi.mock("lucide-react", () => ({
  ArrowDownRight: () => null,
  ArrowRight: () => null,
  ArrowUpRight: () => null,
  CircleCheckBig: () => null,
  Download: () => null,
  RefreshCw: () => null,
  Trash2: () => null,
}));
vi.mock("./LichessLogo", () => ({ default: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const database: DatabaseHandle = { id: { id: "database" }, kind: "database" };
const workspace = { id: { id: "workspace" }, kind: "fileWorkspace" as const };
const destination = { id: "destination" };
const request: AccountImportRequest = {
  provider: "chesscom",
  account: "Felix",
  accountHandle: null,
  destination,
  pendingBatch: null,
  sinceMs: null,
  target: { kind: "unlinked", database, title: "Felix Chess.com" },
};
function completion(
  state: "running" | "succeeded" | "failed" = "succeeded",
  overrides: Partial<AccountCompletion> = {},
): AccountCompletion {
  return {
    id: "account-operation",
    request,
    progressId: "opaque-download-ticket",
    attempt: 1,
    importing: false,
    outcome:
      state === "failed"
        ? {
            state,
            result: { tag: "backend-error", category: "database", message: "import failed" },
          }
        : state === "succeeded"
          ? { state, result: { collectionNotice: false } }
          : { state },
    publication: state === "running" ? null : { handle: workspace, durability: "Durable" },
    committedDatabase: null,
    deletionPending: false,
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
let root: Root;
let host: HTMLDivElement;
let store: ReturnType<typeof createStore>;
let cache: Map<string, State<DatabaseList>>;
let snapshot: AccountCompletion[];
let changed: () => void;
let unlisten: ReturnType<typeof vi.fn<() => void>>;
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  store = createStore();
  cache = new Map();
  snapshot = [];
  unlisten = vi.fn();
  mocks.progress.mockResolvedValue(vi.fn());
  mocks.completionChanged.mockImplementation(async (listener) => {
    changed = listener;
    return unlisten;
  });
  mocks.pendingAccountCompletions.mockImplementation(async () => snapshot);
  mocks.acknowledgeAccountCompletion.mockImplementation(async (id: string) => {
    snapshot = snapshot.filter((entry) => entry.id !== id || entry.deletionPending);
  });
  mocks.getDatabases.mockResolvedValue({
    databases: [],
    unread: [],
    root: { id: { id: "listing-root" }, kind: "databaseRoot" },
  });
  mocks.getDatabaseWorkspace.mockResolvedValue({
    root: { id: { id: "root" }, kind: "databaseRoot" },
    displayName: "Databases",
  });
  mocks.listWorkspaceDatabases.mockResolvedValue({
    entries: [{ handle: database, filename: "Felix_chesscom.db3" }],
    unread: [],
  });
  mocks.createWorkspaceDatabase.mockResolvedValue(database);
  mocks.issueDownloadDestination.mockResolvedValue(destination);
  mocks.downloadDestinationIsKnown.mockResolvedValue(true);
  mocks.linkedCollectionsSupported.mockResolvedValue(false);
  mocks.ensureFileWorkspace.mockResolvedValue(workspace);
  mocks.importAccountGames.mockImplementation(async (accepted: AccountImportRequest) => {
    const terminal = completion("succeeded", { request: accepted });
    snapshot = [terminal];
    return terminal;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function renderCards(cards: Partial<React.ComponentProps<typeof AccountCard>>[] = [{}]) {
  await act(async () =>
    root.render(
      <Provider store={store}>
        <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
          {cards.map((props, index) => (
            <AccountCard
              key={index}
              type="chesscom"
              database={null}
              title="Felix"
              updatedAt={0}
              total={0}
              stats={[]}
              logout={vi.fn()}
              reload={vi.fn()}
              {...props}
            />
          ))}
        </SWRConfig>
      </Provider>,
    ),
  );
}
function downloadButton(index = 0) {
  return host.querySelectorAll<HTMLButtonElement>(
    'button[aria-label="Home.Accounts.DownloadGames"]',
  )[index]!;
}
async function clickDownload() {
  await act(async () => downloadButton().click());
}
async function emitChanged() {
  await act(async () => changed());
}

test("a replacement document with an empty ticket map disables its retained running account", async () => {
  snapshot = [completion("running")];
  await renderCards();
  expect(store.get(accountDownloadsInFlightAtom).size).toBe(0);
  expect(downloadButton().disabled).toBe(true);
  expect(downloadButton().dataset.pending).toBe("true");
  await clickDownload();
  expect(mocks.importAccountGames).not.toHaveBeenCalled();
  expect(mocks.completionChanged.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.pendingAccountCompletions.mock.invocationCallOrder[0]!,
  );
});
test("subscription precedes the snapshot even when completion occurs during subscription", async () => {
  const subscription = deferred<() => void>();
  mocks.completionChanged.mockImplementation((listener) => {
    changed = listener;
    return subscription.promise;
  });
  await renderCards();
  expect(mocks.pendingAccountCompletions).not.toHaveBeenCalled();
  snapshot = [completion()];
  await act(async () => subscription.resolve(unlisten));
  expect(mocks.getDatabases).toHaveBeenCalledOnce();
  expect(mocks.acknowledgeAccountCompletion).toHaveBeenCalledExactlyOnceWith("account-operation");
});
test("one retained success refreshes once across repeated events and two matching surfaces", async () => {
  snapshot = [completion()];
  await renderCards([{}, {}]);
  await emitChanged();
  await emitChanged();
  expect(mocks.getDatabases).toHaveBeenCalledOnce();
  expect(cache.get("databases")?.data).toMatchObject({ databases: [] });
  expect(mocks.acknowledgeAccountCompletion).toHaveBeenCalledOnce();
  expect(mocks.notify).not.toHaveBeenCalled();
});
test("a failed conversion is acknowledged before the next download starts a fresh completion", async () => {
  snapshot = [completion("failed")];
  await renderCards();
  await emitChanged();
  await emitChanged();
  expect(mocks.getDatabases).toHaveBeenCalledOnce();
  expect(mocks.notify).toHaveBeenCalledOnce();
  expect(snapshot).toEqual([]);
  expect(store.get(accountCompletionsAtom).size).toBe(0);
  expect(mocks.acknowledgeAccountCompletion).toHaveBeenCalledOnce();
  mocks.importAccountGames.mockImplementation(async (accepted: AccountImportRequest) => {
    const fresh = completion("succeeded", { id: "fresh-operation", request: accepted });
    snapshot = [fresh];
    return fresh;
  });
  await clickDownload();
  expect(mocks.importAccountGames).toHaveBeenCalledOnce();
  expect(mocks.importAccountGames.mock.calls[0][0].pendingBatch).toBeNull();
  expect(mocks.getDatabases).toHaveBeenCalledTimes(2);
  expect(store.get(accountCompletionsAtom).size).toBe(0);
});
test("a retained uncertain failure shows both the do-not-retry notice and import error", async () => {
  snapshot = [
    completion("failed", {
      publication: {
        handle: workspace,
        durability: { DurabilityUncertain: "DownloadTargetReplacement" },
      },
    }),
  ];
  await renderCards();
  expect(mocks.notify.mock.calls.map(([notice]) => notice.message)).toEqual([
    english.translation["Home.Accounts.DownloadDurabilityUncertain"],
    "import failed",
  ]);
  expect(mocks.getDatabases).toHaveBeenCalledOnce();
  expect(mocks.notify.mock.invocationCallOrder.at(-1)).toBeLessThan(
    mocks.acknowledgeAccountCompletion.mock.invocationCallOrder[0]!,
  );
  expect(mocks.acknowledgeAccountCompletion).toHaveBeenCalledOnce();
});
test.each(["event-first", "command-first"])(
  "%s failure reports once and still rejects the live caller with a marked command error",
  async (order) => {
    await renderCards();
    const response = deferred<AccountCompletion>();
    mocks.importAccountGames.mockReturnValue(response.promise);
    const failed = completion("failed");
    let caught: unknown;
    const caller = runAccountImport(store, request).catch((error) => {
      caught = error;
    });
    if (order === "event-first") {
      snapshot = [failed];
      await emitChanged();
    }
    expect(mocks.notify).toHaveBeenCalledTimes(order === "event-first" ? 1 : 0);
    await act(async () => {
      if (order === "command-first") snapshot = [failed];
      response.resolve(structuredClone(failed));
      await caller;
    });
    if (order === "command-first") await emitChanged();
    expect(caught).toMatchObject({ name: "TauriCommandError", message: "import failed" });
    expect(caught).not.toBe(failed.outcome.state === "failed" ? failed.outcome.result : null);
    expect(isErrorReported(caught)).toBe(true);
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith({
      color: "danger",
      title: "Common.Error",
      message: "import failed",
    });
    expect(mocks.acknowledgeAccountCompletion).toHaveBeenCalledOnce();
  },
);
test.each(["event-first", "command-first"])(
  "the click handler preserves notifyUnlessCancelled with %s terminal failure",
  async (order) => {
    const response = deferred<AccountCompletion>();
    mocks.importAccountGames.mockReturnValue(response.promise);
    await renderCards();
    await clickDownload();
    const failed = completion("failed");
    if (order === "event-first") {
      snapshot = [failed];
      await emitChanged();
    }
    await act(async () => {
      if (order === "command-first") snapshot = [failed];
      response.resolve(structuredClone(failed));
    });
    if (order === "command-first") await emitChanged();
    expect(mocks.notify).toHaveBeenCalledOnce();
    expect(downloadButton().disabled).toBe(false);
    expect(store.get(accountDownloadsInFlightAtom).size).toBe(0);
  },
);
test("an acknowledged deletion failure stays retained, reports once per attempt, and can be retried", async () => {
  snapshot = [completion("failed", { deletionPending: true, committedDatabase: database })];
  await renderCards();
  await emitChanged();
  expect(mocks.notify).toHaveBeenCalledOnce();
  expect(snapshot).toHaveLength(1);
  expect(downloadButton().disabled).toBe(false);
  mocks.importAccountGames.mockImplementation(async (accepted) => {
    snapshot = [completion("succeeded", { request: accepted, attempt: 2 })];
    return snapshot[0];
  });
  await clickDownload();
  expect(mocks.importAccountGames).toHaveBeenCalledOnce();
  expect(mocks.acknowledgeAccountCompletion).toHaveBeenCalledTimes(2);
  expect(store.get(accountCompletionsAtom).size).toBe(0);
});
test("an importing snapshot registers the native conversion identity and clears only that entry", async () => {
  const local = {
    id: "conversion:local",
    totalGames: 4,
    elapsedSeconds: 1,
    targetDatabase: null,
    targetDatabaseTitle: null,
    sourceFileName: "local.pgn",
  };
  store.set(databaseConversionStateAtom, [local]);
  snapshot = [completion("running", { importing: true })];
  await renderCards();
  expect(store.get(databaseConversionStateAtom)).toEqual([
    local,
    expect.objectContaining({ id: "conversion:account-operation", targetDatabase: database }),
  ]);
  snapshot = [completion()];
  await emitChanged();
  expect(store.get(databaseConversionStateAtom)).toEqual([local]);
});
test("a finished progress frame neither imports nor refreshes databases", async () => {
  await renderCards();
  await act(async () =>
    mocks.progress.mock.calls[0]![0]({
      payload: { id: "chesscom_felix", progress: 100, finished: true },
    }),
  );
  expect(mocks.getDatabases).not.toHaveBeenCalled();
  expect(mocks.importAccountGames).not.toHaveBeenCalled();
});
test("unmount releases the completion subscription and drops late events", async () => {
  await renderCards();
  await act(async () => root.render(null));
  expect(unlisten).toHaveBeenCalledOnce();
  snapshot = [completion()];
  await emitChanged();
  expect(mocks.getDatabases).not.toHaveBeenCalled();
});
test.each(["lichess", "chesscom"] as const)(
  "%s admits the chosen handle and destination before native import",
  async (provider) => {
    await renderCards([
      { type: provider, accountUsername: "Canonical", accountHandle: "opaque-account" },
    ]);
    await clickDownload();
    expect(mocks.importAccountGames).toHaveBeenCalledExactlyOnceWith({
      ...request,
      provider,
      account: "Canonical",
      accountHandle: "opaque-account",
      target: {
        kind: "unlinked",
        database,
        title: provider === "lichess" ? "Felix Lichess" : "Felix Chess.com",
      },
    });
    expect(mocks.createWorkspaceDatabase.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.importAccountGames.mock.invocationCallOrder[0]!,
    );
    expect(mocks.getDatabases).toHaveBeenCalledOnce();
  },
);
test.each(["known", "stale", "invalid"])(
  "a %s saved destination is resolved before native admission",
  async (kind) => {
    const saved = { id: "saved" };
    localStorage.setItem(
      "download-destination-capability",
      kind === "invalid" ? "not-json" : JSON.stringify(saved),
    );
    mocks.downloadDestinationIsKnown.mockResolvedValue(kind === "known");
    await renderCards();
    await clickDownload();
    expect(mocks.importAccountGames).toHaveBeenCalledWith(
      expect.objectContaining({ destination: kind === "known" ? saved : destination }),
    );
    expect(mocks.downloadDestinationIsKnown).toHaveBeenCalledTimes(kind === "invalid" ? 0 : 1);
    expect(mocks.issueDownloadDestination).toHaveBeenCalledTimes(kind === "known" ? 0 : 1);
  },
);
test.each(["Cancellation", "picker failed"])(
  "destination rejection %s releases pending without admission",
  async (message) => {
    mocks.issueDownloadDestination.mockRejectedValue(new Error(message));
    await renderCards();
    await clickDownload();
    expect(mocks.importAccountGames).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledTimes(message === "Cancellation" ? 0 : 1);
    expect(downloadButton().disabled).toBe(false);
  },
);
test("a rejected destination query preserves its capability and does not reopen the picker", async () => {
  localStorage.setItem("download-destination-capability", JSON.stringify(destination));
  mocks.downloadDestinationIsKnown.mockRejectedValue(new Error("query failed"));
  await renderCards();
  await clickDownload();
  expect(mocks.issueDownloadDestination).not.toHaveBeenCalled();
  expect(mocks.importAccountGames).not.toHaveBeenCalled();
  expect(localStorage.getItem("download-destination-capability")).toBe(JSON.stringify(destination));
});

test("a rejected replacement picker is not retried and clears the stale destination first", async () => {
  const stale = { id: "stale" };
  localStorage.setItem("download-destination-capability", JSON.stringify(stale));
  mocks.downloadDestinationIsKnown.mockResolvedValue(false);
  let destinationAtPicker: string | null | undefined;
  mocks.issueDownloadDestination.mockImplementation(async () => {
    destinationAtPicker = localStorage.getItem("download-destination-capability");
    throw new Error("picker failed");
  });
  await renderCards();
  await clickDownload();
  expect(destinationAtPicker).toBe("null");
  expect(mocks.downloadDestinationIsKnown).toHaveBeenCalledExactlyOnceWith(stale);
  expect(mocks.issueDownloadDestination).toHaveBeenCalledOnce();
  expect(mocks.importAccountGames).not.toHaveBeenCalled();
  expect(mocks.notify).toHaveBeenCalledOnce();
  expect(localStorage.getItem("download-destination-capability")).toBe("null");
});

test("invalid persisted destination storage is repaired without querying native state", async () => {
  localStorage.setItem("download-destination-capability", "not-json");
  mocks.issueDownloadDestination.mockRejectedValue(new Error("picker failed"));
  await renderCards();
  await clickDownload();
  expect(mocks.downloadDestinationIsKnown).not.toHaveBeenCalled();
  expect(mocks.issueDownloadDestination).toHaveBeenCalledOnce();
  expect(mocks.importAccountGames).not.toHaveBeenCalled();
  expect(localStorage.getItem("download-destination-capability")).toBe("null");
});
test.each([401, 404, 429])(
  "a workflow rejection (%s) retains remote guidance and releases pending",
  async (status) => {
    const key =
      status === 401
        ? "Common.RemoteRequest.AuthorizationRejected"
        : status === 404
          ? "Common.RemoteRequest.NotFound"
          : "Common.RemoteRequest.RateLimited";
    const failed = completion("failed", {
      publication: null,
      outcome: {
        state: "failed",
        result: {
          tag: "backend-error",
          category: "network",
          message: "Remote HTTP request rejected",
          remoteHttpRejection: { status, authorizationSent: status === 401 },
        },
      },
    });
    mocks.importAccountGames.mockImplementation(async () => {
      snapshot = [failed];
      return failed;
    });
    await renderCards();
    await clickDownload();
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: english.translation[key] }),
    );
    expect(downloadButton().disabled).toBe(false);
    expect(mocks.getDatabases).not.toHaveBeenCalled();
  },
);
test.each([true, false])(
  "database acquisition preserves rootFailure presentation (%s)",
  async (labelled) => {
    mocks.getDatabaseWorkspace.mockRejectedValue({
      tag: "backend-error",
      category: "io",
      message: "native failure",
      ...(labelled ? { rootFailure: "missing" } : {}),
    });
    await renderCards();
    await clickDownload();
    expect(mocks.importAccountGames).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith({
      color: "danger",
      title: "Common.Error",
      message: labelled
        ? "This database folder is no longer available. Choose another."
        : "native failure",
    });
  },
);
test.each(["succeeded", "failed"] as const)(
  "a refresh failure after %s preserves primary reporting",
  async (state) => {
    mocks.getDatabases.mockRejectedValue(new Error("refresh failed"));
    snapshot = [completion(state)];
    await renderCards();
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith({
      color: "danger",
      title: "Common.Error",
      message: state === "failed" ? "import failed" : "refresh failed",
    });
    expect(mocks.logFailureSafely).toHaveBeenCalledTimes(state === "failed" ? 1 : 0);
  },
);
test.each(["migration", "unavailable", "pending-batch"])(
  "linked preparation %s is resolved before admission",
  async (mode) => {
    mocks.linkedCollectionsSupported.mockResolvedValue(true);
    mocks.prepareAccountCollection.mockResolvedValue({
      collection:
        mode === "migration"
          ? null
          : {
              id: "collection",
              status: mode === "unavailable" ? "stale" : "ready",
              fetchSinceMs: "123000",
            },
      migrationRequired: mode === "migration",
      destination,
      pendingBatch: mode === "pending-batch" ? workspace : null,
    });
    await renderCards();
    await clickDownload();
    expect(mocks.importAccountGames.mock.calls).toEqual(
      mode === "pending-batch"
        ? [
            [
              {
                ...request,
                pendingBatch: workspace,
                sinceMs: 123000n,
                target: { kind: "linked", collection: "collection" },
              },
            ],
          ]
        : [],
    );
    expect(mocks.getDatabaseWorkspace).not.toHaveBeenCalled();
  },
);
test("a retained linked success renders the existing committed-pending notice", async () => {
  snapshot = [
    completion("succeeded", {
      outcome: { state: "succeeded", result: { collectionNotice: true } },
    }),
  ];
  await renderCards();
  expect(host.textContent).toContain("Collections.CommittedPending");
});

test("declined collection migration admits the existing unlinked database", async () => {
  mocks.linkedCollectionsSupported.mockResolvedValue(true);
  mocks.prepareAccountCollection.mockResolvedValue(null);
  await renderCards();
  await clickDownload();
  expect(mocks.importAccountGames).toHaveBeenCalledExactlyOnceWith(request);
});

test("a delayed snapshot cannot report an acknowledged failure a second time", async () => {
  const failed = completion("failed");
  snapshot = [failed];
  await renderCards();
  expect(mocks.notify).toHaveBeenCalledOnce();
  await emitChanged();
  mocks.pendingAccountCompletions.mockResolvedValueOnce([structuredClone(failed)]);
  await emitChanged();
  expect(mocks.notify).toHaveBeenCalledOnce();
  expect(mocks.acknowledgeAccountCompletion).toHaveBeenCalledOnce();
});
test.each([
  { label: "Home.Accounts.UpdateStats", prop: "reload" },
  { label: "Home.Accounts.RemoveAccount", prop: "logout" },
] as const)("a rejecting $prop remains handled", async ({ label, prop }) => {
  const callback = vi.fn().mockRejectedValue(new Error(`${prop} failed`));
  await renderCards([{ [prop]: callback }]);
  await act(async () =>
    host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click(),
  );
  expect(mocks.notify).toHaveBeenCalledExactlyOnceWith({
    color: "danger",
    title: "Common.Error",
    message: `${prop} failed`,
  });
});
