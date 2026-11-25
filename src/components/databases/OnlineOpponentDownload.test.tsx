import { MantineProvider } from "@mantine/core";
import { createStore, Provider } from "jotai";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ScopedMutator } from "swr";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  DatabaseHandle,
  ErrorPayload,
  OpponentAccount,
  OpponentImportOutcome,
  OpponentImportRequest,
} from "@/bindings";
import { opponentImportsAtom, opponentLinksAtom, pendingPlayerCardAtom } from "@/state/atoms";
import { catalogueI18n } from "@/tests/catalogues";
import { installInlineComputedStyleStub } from "@/tests/computedStyle";
import { installMatchMediaStub } from "@/tests/matchMedia";
import type { DatabaseList, SuccessDatabaseInfo } from "@/utils/db";
import type { DatabaseRouteTarget } from "./databaseRoute";

const mocks = vi.hoisted(() => ({
  publishDatabaseList: vi.fn(),
  opponentPlayers: vi.fn(),
  importOpponentGames: vi.fn(),
  withDownloadTicket: vi.fn(),
  getDatabaseWorkspace: vi.fn(),
  listWorkspaceDatabases: vi.fn(),
  deleteDatabase: vi.fn(),
  cancelDownload: vi.fn(),
  forgetDeletedDatabase: vi.fn(),
  notify: vi.fn(),
  notifyHide: vi.fn(),
  warn: vi.fn(),
  translate: (key: string, options?: Record<string, unknown>) =>
    String(options?.defaultValue ?? key),
}));

vi.mock("@/platform/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      importOpponentGames: mocks.importOpponentGames,
      getDatabaseWorkspace: mocks.getDatabaseWorkspace,
      listWorkspaceDatabases: mocks.listWorkspaceDatabases,
      deleteDatabase: mocks.deleteDatabase,
      cancelDownload: mocks.cancelDownload,
    },
    withDownloadTicket: mocks.withDownloadTicket,
  };
});
vi.mock("@/hooks/useDatabaseList", () => ({
  publishDatabaseList: mocks.publishDatabaseList,
}));
vi.mock("./opponentLookup", () => ({
  opponentPlayers: mocks.opponentPlayers,
}));
vi.mock("./forgetDeletedDatabase", () => ({
  forgetDeletedDatabase: mocks.forgetDeletedDatabase,
}));
vi.mock("@/hooks/useProgress", () => ({ useProgress: () => ({ progress: 45 }) }));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: mocks.notify, hide: mocks.notifyHide },
}));
vi.mock("@/platform/errors", async (original) => ({
  ...(await original<typeof import("@/platform/errors")>()),
  warnSafely: mocks.warn,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => mocks.translate(key, options),
  }),
}));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  default: {
    t: (key: string, options?: Record<string, unknown>) => mocks.translate(key, options),
  },
}));

import { enterOnlineOpponent, onlineOpponentDownloadAtom } from "./onlineOpponent";
import OnlineOpponentDownload from "./OnlineOpponentDownload";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub({ matches: () => false });
installInlineComputedStyleStub();

const ROOT = { id: { id: "db-root" }, kind: "databaseRoot" } as const;
const DB_FILE: DatabaseHandle = { id: { id: "opponent-db-1" }, kind: "database" };
const LICHESS: OpponentAccount = { provider: "lichess", username: "DrNykterstein" };

function successDatabase(filename: string): SuccessDatabaseInfo {
  return {
    type: "success",
    file: DB_FILE,
    filename,
    title: "DrNykterstein (online)",
    description: "",
    player_count: 1,
    event_count: 1,
    game_count: 10,
    storage_size: "1024",
    indexed: false,
  };
}

let store: ReturnType<typeof createStore>;
let root: Root;
let container: HTMLDivElement;
let navigate: ReturnType<typeof vi.fn<(target: DatabaseRouteTarget) => unknown>>;
let mutateCache: ScopedMutator;
let t: Awaited<ReturnType<typeof catalogueI18n>>["t"];
let pendingSettlements: Array<() => void> = [];

function button(name: string) {
  const found = [...document.body.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );
  if (!found) throw new Error(`no button named ${name}`);
  return found;
}

async function click(name: string) {
  await act(async () => button(name).click());
}

function deferredImport() {
  let resolve!: (outcome: OpponentImportOutcome) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<OpponentImportOutcome>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  pendingSettlements.push(() =>
    reject({ tag: "backend-error", category: "cancellation", message: "Cancellation" }),
  );
  mocks.importOpponentGames.mockReturnValueOnce(promise);
  return { resolve, reject };
}

async function renderModal() {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <Provider store={store}>
          <OnlineOpponentDownload />
        </Provider>
      </MantineProvider>,
    ),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  pendingSettlements = [];
  const i18n = await catalogueI18n("en-US");
  t = i18n.t.bind(i18n);
  mocks.translate = (key, options) => i18n.t(key, options);
  store = createStore();
  navigate = vi.fn<(target: DatabaseRouteTarget) => unknown>();
  mutateCache = vi.fn() as unknown as ScopedMutator;
  mocks.publishDatabaseList.mockResolvedValue({
    databases: [],
    unread: [],
    workspaceFilenames: [],
    root: ROOT,
  } satisfies DatabaseList);
  mocks.opponentPlayers.mockResolvedValue([{ id: 42, name: "DrNykterstein" }]);
  mocks.getDatabaseWorkspace.mockResolvedValue({ root: ROOT, displayName: "Databases" });
  mocks.listWorkspaceDatabases.mockResolvedValue({ entries: [], unread: [] });
  mocks.deleteDatabase.mockResolvedValue(null);
  mocks.cancelDownload.mockResolvedValue(true);
  mocks.withDownloadTicket.mockImplementation((run: (ticket: string) => Promise<unknown>) =>
    run("ticket-1"),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await renderModal();
});

afterEach(async () => {
  for (const settle of pendingSettlements) settle();
  await act(async () => root.unmount());
  container.remove();
});

function expectOpenActionNotice(
  expectedMessage: string,
  expectedDatabaseId: string,
): Promise<void> {
  const shown = mocks.notify.mock.calls[0][0] as { id?: string; message: ReactNode };
  const noticeHost = document.createElement("div");
  document.body.append(noticeHost);
  const noticeRoot = createRoot(noticeHost);
  return (async () => {
    try {
      act(() => {
        noticeRoot.render(<MantineProvider env="test">{shown.message}</MantineProvider>);
      });
      expect(noticeHost.textContent).toContain(expectedMessage);
      const openButton = [...noticeHost.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === "Open",
      )!;
      expect(openButton).toBeDefined();
      await act(async () => {
        openButton.click();
      });
      expect(mocks.notifyHide).toHaveBeenCalledWith(shown.id);
      await vi.waitFor(() =>
        expect(navigate).toHaveBeenCalledExactlyOnceWith({
          to: "/databases/$databaseId",
          params: { databaseId: expectedDatabaseId },
        }),
      );
      expect(store.get(pendingPlayerCardAtom)).toEqual({
        database: expectedDatabaseId,
        playerId: 42,
        playerName: "DrNykterstein",
      });
    } finally {
      act(() => noticeRoot.unmount());
      noticeHost.remove();
    }
  })();
}

describe("OnlineOpponentDownload", () => {
  test("shows link title and background copy, disables Cancel before a ticket exists, and cancels once a ticket arrives", async () => {
    let issueTicket!: () => void;
    mocks.withDownloadTicket.mockImplementationOnce(
      (run: (ticket: string) => Promise<unknown>) =>
        new Promise((res) => {
          issueTicket = () => res(run("ticket-99"));
        }),
    );
    const { resolve } = deferredImport();

    await act(async () => {
      await enterOnlineOpponent({ store, navigate, mutateCache, t }, LICHESS);
    });

    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("Downloading DrNykterstein");
    expect(dialog.textContent).toContain(
      "Downloading online games. Closing this dialog keeps the download running.",
    );
    expect(button("Cancel").disabled).toBe(true);
    expect(document.body.querySelector('[role="progressbar"]')).toBeNull();

    await act(async () => {
      issueTicket();
    });

    await vi.waitFor(() => expect(button("Cancel").disabled).toBe(false));
    expect(document.body.querySelector('[role="progressbar"]')).not.toBeNull();

    await click("Cancel");
    expect(mocks.cancelDownload).toHaveBeenCalledExactlyOnceWith("ticket-99");

    await act(async () => {
      resolve({ kind: "imported", database: null, accounts: [], merged: true });
    });
    await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull());
  });

  test("reports a refused cancel via notifyUnlessCancelled", async () => {
    mocks.cancelDownload.mockRejectedValueOnce(new Error("cancel failed"));
    const { resolve } = deferredImport();

    await act(async () => {
      await enterOnlineOpponent({ store, navigate, mutateCache, t }, LICHESS);
    });

    await click("Cancel");

    await vi.waitFor(() =>
      expect(mocks.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          color: "danger",
          title: "Error",
        }),
      ),
    );

    resolve({ kind: "imported", database: null, accounts: [], merged: true });
    await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull());
  });

  test("closing keeps the run; later success shows Open action instead of navigating and opens card on click", async () => {
    const { resolve } = deferredImport();

    await act(async () => {
      await enterOnlineOpponent({ store, navigate, mutateCache, t }, LICHESS);
    });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    await click("Close");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.cancelDownload).not.toHaveBeenCalled();

    const filename = (mocks.importOpponentGames.mock.calls[0][0] as OpponentImportRequest).filename;
    mocks.publishDatabaseList.mockResolvedValue({
      databases: [successDatabase(filename)],
      unread: [],
      workspaceFilenames: [filename],
      root: ROOT,
    } satisfies DatabaseList);

    await act(async () => {
      resolve({
        kind: "imported",
        database: DB_FILE,
        accounts: [{ account: LICHESS, games: 8 }],
        merged: true,
      });
    });

    await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalledOnce());
    expect(navigate).not.toHaveBeenCalled();

    await expectOpenActionNotice("Downloaded 8 online games.", "opponent-db-1");
  });

  test("unmounting while the run is going shows Open action on finish and does not navigate", async () => {
    const { resolve } = deferredImport();

    await act(async () => {
      await enterOnlineOpponent({ store, navigate, mutateCache, t }, LICHESS);
    });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    // User leaves the Library while the download is still running.
    await act(async () => root.render(null));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    const filename = (mocks.importOpponentGames.mock.calls[0][0] as OpponentImportRequest).filename;
    mocks.publishDatabaseList.mockResolvedValue({
      databases: [successDatabase(filename)],
      unread: [],
      workspaceFilenames: [filename],
      root: ROOT,
    } satisfies DatabaseList);

    await act(async () => {
      resolve({
        kind: "imported",
        database: DB_FILE,
        accounts: [{ account: LICHESS, games: 8 }],
        merged: true,
      });
    });

    await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalledOnce());
    expect(navigate).not.toHaveBeenCalled();
    expect(store.get(onlineOpponentDownloadAtom)).toBeNull();

    await expectOpenActionNotice("Downloaded 8 online games.", "opponent-db-1");
  });

  test("a second entry while the run is going shows the modal again on the same run", async () => {
    const { resolve } = deferredImport();

    await act(async () => {
      await enterOnlineOpponent({ store, navigate, mutateCache, t }, LICHESS);
    });
    await click("Close");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      await enterOnlineOpponent({ store, navigate, mutateCache, t }, LICHESS);
    });

    expect(mocks.importOpponentGames).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.querySelector('[role="progressbar"]')).not.toBeNull();

    const filename = (mocks.importOpponentGames.mock.calls[0][0] as OpponentImportRequest).filename;
    mocks.publishDatabaseList.mockResolvedValue({
      databases: [successDatabase(filename)],
      unread: [],
      workspaceFilenames: [filename],
      root: ROOT,
    } satisfies DatabaseList);

    await act(async () => {
      resolve({
        kind: "imported",
        database: DB_FILE,
        accounts: [{ account: LICHESS, games: 5 }],
        merged: true,
      });
    });

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  test.each([
    [
      "noGames",
      (resolve: (o: OpponentImportOutcome) => void) =>
        resolve({ kind: "imported", database: null, accounts: [], merged: true }),
      { color: "warning", message: "No game matches the period and time controls." },
    ],
    [
      "accountFailed",
      (resolve: (o: OpponentImportOutcome) => void) =>
        resolve({
          kind: "accountFailed",
          account: LICHESS,
          error: {
            tag: "backend-error",
            category: "network",
            message: "404",
            remoteHttpRejection: { status: 404, authorizationSent: false },
          },
        }),
      { color: "danger", message: "Lichess has no account named DrNykterstein." },
    ],
    [
      "failed",
      (_resolve: (o: OpponentImportOutcome) => void, reject: (e: unknown) => void) =>
        reject({
          tag: "backend-error",
          category: "database",
          message: "disk I/O",
        } satisfies ErrorPayload),
      { color: "danger", title: "Error" },
    ],
  ] as const)(
    "closes the modal and reports on terminal outcome %s",
    async (_label, settle, expectedNotice) => {
      const { resolve, reject } = deferredImport();

      await act(async () => {
        await enterOnlineOpponent({ store, navigate, mutateCache, t }, LICHESS);
      });
      expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

      await act(async () => settle(resolve, reject));

      await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull());
      expect(store.get(onlineOpponentDownloadAtom)).toBeNull();
      expect(store.get(opponentLinksAtom)).toHaveLength(1);
      expect(store.get(opponentImportsAtom).size).toBe(0);
      expect(navigate).not.toHaveBeenCalled();
      expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining(expectedNotice));
    },
  );

  test("closes the modal silently on cancelled", async () => {
    const { reject } = deferredImport();

    await act(async () => {
      await enterOnlineOpponent({ store, navigate, mutateCache, t }, LICHESS);
    });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () =>
      reject({
        tag: "backend-error",
        category: "cancellation",
        message: "Cancellation",
      } satisfies ErrorPayload),
    );

    await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull());
    expect(store.get(onlineOpponentDownloadAtom)).toBeNull();
    expect(store.get(opponentLinksAtom)).toHaveLength(1);
    expect(store.get(opponentImportsAtom).size).toBe(0);
    expect(navigate).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  test("closes the modal on imported even when the card cannot be opened", async () => {
    const { resolve } = deferredImport();
    mocks.opponentPlayers.mockResolvedValue([]);

    await act(async () => {
      await enterOnlineOpponent({ store, navigate, mutateCache, t }, LICHESS);
    });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    const filename = (mocks.importOpponentGames.mock.calls[0][0] as OpponentImportRequest).filename;
    mocks.publishDatabaseList.mockResolvedValue({
      databases: [successDatabase(filename)],
      unread: [],
      workspaceFilenames: [filename],
      root: ROOT,
    } satisfies DatabaseList);

    await act(async () => {
      resolve({
        kind: "imported",
        database: DB_FILE,
        accounts: [{ account: LICHESS, games: 3 }],
        merged: true,
      });
    });

    await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull());
    await vi.waitFor(() =>
      expect(mocks.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          color: "danger",
          title: "Error",
          message: "The online games could not be read.",
        }),
      ),
    );
    expect(navigate).not.toHaveBeenCalled();
  });
});
