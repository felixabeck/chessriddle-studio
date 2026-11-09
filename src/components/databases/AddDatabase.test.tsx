import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getDefaultStore } from "jotai";
import { chessBaseGuideAtom } from "@/components/library/chessBaseGuideState";
import { databaseConversionStateAtom, databaseConversionRefreshFailedAtom } from "@/state/atoms";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CatalogVerificationError } from "@/utils/signedCatalog";
import { defaultDatabaseProgressId } from "@/utils/db";
import {
  clickProgressCancel,
  expectRestoredDownloadCancellation,
  reportRunningProgress,
  resetProgressButtonTestHarness,
} from "@/tests/progressButtonTestHarness";

const mocks = await vi.hoisted(async () => {
  const { createProgressButtonTestHarness } = await import("@/tests/progressButtonTestHarness");
  return Object.assign(createProgressButtonTestHarness(), {
    withConversionTicket: vi.fn((run: (ticket: string) => Promise<unknown>) =>
      run("conversion-ticket"),
    ),
    cancelConversion: vi.fn().mockResolvedValue(true),
    catalogError: undefined as unknown,
    getDatabaseWorkspace: vi.fn(),
    createWorkspaceDatabase: vi.fn(),
    listWorkspaceDatabases: vi.fn(),
    convertPgn: vi.fn(),
    deleteDatabase: vi.fn(),
    logError: vi.fn(),
    issuePgnWorkspace: vi.fn(),
    databaseDownloadDestination: vi.fn(),
    downloadFile: vi.fn(),
    withDownloadTicket: vi.fn((run: (ticket: string) => Promise<unknown>) =>
      run("prepared-ticket"),
    ),
    getDatabases: vi.fn(),
    notify: vi.fn(),
    linkedCollectionsSupported: vi.fn(),
    listLinkedCollections: vi.fn(),
    rebuildLinkedCollection: vi.fn(),
    defaultDatabases: [] as Array<{
      title: string;
      description: string;
      player_count: number;
      game_count: number;
      storage_size: number;
      downloadLink: string;
      sha256: string;
      signature: string;
    }>,
  });
});

vi.mock("@/platform/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
  return {
    ...actual,
    tauri: mocks,
    withDownloadTicket: mocks.withDownloadTicket,
    withConversionTicket: mocks.withConversionTicket,
    tauriSubscriptions: {
      progress: mocks.subscribeProgress,
    },
  };
});
vi.mock("@/utils/db", async () => {
  const actual = await vi.importActual<typeof import("@/utils/db")>("@/utils/db");
  return {
    ...actual,
    getDatabases: mocks.getDatabases,
    useDefaultDatabases: () => ({
      defaultDatabases: mocks.defaultDatabases,
      error: mocks.catalogError,
      isLoading: false,
    }),
  };
});
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.notify } }));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  default: {
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/platform/native", () => ({ error: mocks.logError }));
vi.mock("../common/AppModal", () => ({
  default: ({ children, opened }: { children: React.ReactNode; opened: boolean }) =>
    opened ? <div>{children}</div> : null,
}));
vi.mock("../common/FileInput", () => ({
  default: ({ onClick, filename }: { onClick: () => void; filename: string | null }) => (
    <button type="button" onClick={onClick}>
      {filename || "pick-pgn"}
    </button>
  ),
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
vi.mock("@mantine/core", () => ({
  Alert: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Box: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Center: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Divider: () => <hr />,
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Loader: () => null,
  Paper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Progress: ({ value }: { value: number }) => <output data-progress>{value}</output>,
  ScrollArea: { Autosize: ({ children }: { children: React.ReactNode }) => <div>{children}</div> },
  SimpleGrid: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Stack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tabs: Object.assign(({ children }: { children: React.ReactNode }) => <div>{children}</div>, {
    List: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Tab: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
    Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  }),
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  TextInput: ({
    label,
    ...props
  }: { label?: string } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <label>
      {label}
      <input {...props} />
    </label>
  ),
}));
vi.mock("lucide-react", () => ({ AlertCircle: () => null, X: () => null }));

import { TauriCommandError } from "@/platform/tauri";
import { convertLocalDatabase } from "./AddDatabase";

test("cleanup create does not recover, convert or publish a created database", async () => {
  const { TauriCommandError } = await import("@/platform/tauri");
  const cause = new TauriCommandError({
    tag: "backend-error",
    category: "operation-and-cleanup",
    message: "native failure",
  });
  mocks.getDatabaseWorkspace.mockResolvedValue({
    root: { id: { id: "root" }, kind: "databaseRoot" },
    displayName: "Databases",
  });
  mocks.createWorkspaceDatabase.mockRejectedValueOnce(cause);
  const onCreated = vi.fn();
  await expect(
    convertLocalDatabase("conversion:cleanup", [], "Imported", undefined, onCreated),
  ).rejects.toBe(cause);
  expect(mocks.createWorkspaceDatabase).toHaveBeenCalledOnce();
  expect(mocks.listWorkspaceDatabases).not.toHaveBeenCalled();
  expect(mocks.convertPgn).not.toHaveBeenCalled();
  expect(onCreated).not.toHaveBeenCalled();
});
import AddDatabase from "./AddDatabase";

test("the local guide link opens link mode and ChessBase selection cancels without notification", async () => {
  const store = getDefaultStore();
  store.set(chessBaseGuideAtom, "closed");
  await renderAddDatabase();
  const link = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "ChessBaseGuide.Title",
  );
  await act(async () => link?.click());
  expect(store.get(chessBaseGuideAtom)).toBe("link");
  mocks.issuePgnWorkspace.mockRejectedValueOnce(
    new TauriCommandError({
      tag: "backend-error",
      category: "invalid-input",
      message: "Export as PGN",
      chessBaseDatabase: true,
    }),
  );
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "pick-pgn")
      ?.click(),
  );
  expect(store.get(chessBaseGuideAtom)).toBe("selected");
  expect(mocks.notify).not.toHaveBeenCalled();
  expect(mocks.convertPgn).not.toHaveBeenCalled();
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const manifestDb = {
  title: "Lichess",
  description: "Games",
  player_count: 1,
  game_count: 2,
  storage_size: 3,
  downloadLink: "https://db.encroissant.org/lichess.db3",
  sha256: "a".repeat(64),
  signature: "sig",
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.linkedCollectionsSupported.mockReset().mockResolvedValue(false);
  mocks.listLinkedCollections.mockReset().mockResolvedValue([]);
  mocks.rebuildLinkedCollection.mockReset();
  mocks.catalogError = undefined;
  mocks.defaultDatabases = [];
  resetProgressButtonTestHarness(mocks);
  mocks.withDownloadTicket.mockReset().mockImplementation((run) => run("prepared-ticket"));
  mocks.withConversionTicket.mockReset().mockImplementation((run) => run("conversion-ticket"));
  mocks.deleteDatabase.mockReset().mockResolvedValue(undefined);
  mocks.logError.mockReset().mockResolvedValue(undefined);
  mocks.getDatabases.mockReset().mockResolvedValue({
    databases: [],
    unread: [],
    root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
  });
  getDefaultStore().set(databaseConversionStateAtom, []);
  getDefaultStore().set(databaseConversionRefreshFailedAtom, false);
  vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function renderAddDatabase(
  databases: Array<{ type: "success"; title: string }> = [],
  {
    setOpened = vi.fn(),
    reloadDatabases = vi.fn().mockResolvedValue(undefined),
  }: {
    setOpened?: ReturnType<typeof vi.fn<(opened: boolean) => void>>;
    reloadDatabases?: ReturnType<typeof vi.fn>;
  } = {},
) {
  await act(async () => {
    root.render(
      <AddDatabase
        databases={databases as never}
        opened
        setOpened={setOpened}
        disableLocalConversion={false}
        reloadDatabases={reloadDatabases as never}
      />,
    );
  });
  return { setOpened, reloadDatabases };
}

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
  "continues conversion with a handle recovered after an uncertain create via the $path",
  async ({ rejection }) => {
    const workspaceRoot = { id: { id: "database-root" }, kind: "databaseRoot" };
    const handle = { id: { id: "database" }, kind: "database" as const };
    const source = { id: { id: "source" }, kind: "fileWorkspace" } as const;
    mocks.getDatabaseWorkspace.mockResolvedValue({ root: workspaceRoot, displayName: "Databases" });
    mocks.createWorkspaceDatabase.mockRejectedValue(rejection);
    mocks.listWorkspaceDatabases.mockResolvedValue({
      entries: [
        {
          handle,
          filename: "00000000-0000-4000-8000-000000000001.db3",
          availability: "available",
        },
      ],
      unread: [],
    });
    mocks.convertPgn.mockResolvedValue(undefined);
    const onCreated = vi.fn();

    await expect(
      convertLocalDatabase("conversion:test", [source], "Imported", "notes", onCreated),
    ).resolves.toBe(handle);
    expect(onCreated).toHaveBeenCalledWith(handle);
    expect(mocks.convertPgn).toHaveBeenCalledWith(
      "conversion:test",
      [source],
      handle,
      "Imported",
      "notes",
      null,
    );
  },
);

test("wires installed state and progress id from the download URL", async () => {
  mocks.defaultDatabases = [manifestDb];
  await renderAddDatabase([{ type: "success", title: "Lichess" }]);
  expect(mocks.progressButtonProps?.id).toBe(defaultDatabaseProgressId(manifestDb.downloadLink));
  expect(mocks.progressButtonProps?.id).not.toBe("db_0");
  expect(mocks.progressButtonProps?.initInstalled).toBe(true);
});

test("installs a downloaded database with the URL-keyed progress id", async () => {
  mocks.defaultDatabases = [manifestDb];
  const workspaceRoot = { id: { id: "database-root" }, kind: "databaseRoot" };
  const destination = { id: { id: "destination" }, kind: "path" };
  mocks.getDatabaseWorkspace.mockResolvedValue({ root: workspaceRoot, displayName: "Databases" });
  mocks.databaseDownloadDestination.mockResolvedValue(destination);
  mocks.downloadFile.mockResolvedValue(undefined);
  const { reloadDatabases } = await renderAddDatabase();

  await act(async () => mocks.progressButtonProps!.onClick());

  expect(mocks.downloadFile).toHaveBeenCalledWith(
    defaultDatabaseProgressId(manifestDb.downloadLink),
    manifestDb.downloadLink,
    destination,
    "Lichess.db3",
    null,
    "prepared-ticket",
    { sha256: manifestDb.sha256, signature: manifestDb.signature },
  );
  expect(mocks.downloadFile.mock.calls[0]?.[0]).not.toBe("db_0");
  expect(mocks.progressButtonProps?.clearOnCancel).toBe(false);
  expect(mocks.getDatabases).not.toHaveBeenCalled();
  expect(reloadDatabases).toHaveBeenCalledExactlyOnceWith();
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("a running database with no local job renders Cancel and calls native lookup", async () => {
  mocks.defaultDatabases = [manifestDb];
  mocks.realProgressButton = true;
  await renderAddDatabase();
  await expectRestoredDownloadCancellation(
    mocks,
    host,
    defaultDatabaseProgressId(manifestDb.downloadLink),
  );
});

test("a downloaded database surfaces a rejected reload without listing inside the component", async () => {
  mocks.defaultDatabases = [manifestDb];
  mocks.getDatabaseWorkspace.mockResolvedValue({
    root: { id: { id: "root" }, kind: "databaseRoot" },
    displayName: "Databases",
  });
  mocks.databaseDownloadDestination.mockResolvedValue({ id: { id: "destination" } });
  mocks.downloadFile.mockResolvedValue(undefined);
  const reloadDatabases = vi.fn().mockRejectedValue(new Error("download refresh failed"));
  await renderAddDatabase([], { reloadDatabases });

  await act(async () => mocks.progressButtonProps!.onClick());

  expect(mocks.downloadFile).toHaveBeenCalledOnce();
  expect(reloadDatabases).toHaveBeenCalledExactlyOnceWith();
  expect(mocks.getDatabases).not.toHaveBeenCalled();
  expect(mocks.notify).toHaveBeenCalledExactlyOnceWith({
    color: "danger",
    title: "Common.Error",
    message: "download refresh failed",
  });
});

test("cancelling a pre-claim local attempt preserves the surviving bar and its next Cancel uses lookup", async () => {
  mocks.defaultDatabases = [manifestDb];
  mocks.realProgressButton = true;
  let rejectWorkspace!: (cause: unknown) => void;
  mocks.getDatabaseWorkspace.mockReturnValue(
    new Promise((_resolve, reject) => {
      rejectWorkspace = reject;
    }),
  );
  mocks.clearProgress.mockResolvedValue(7n);
  const { reloadDatabases } = await renderAddDatabase();
  await act(async () => mocks.progressButtonProps!.onClick());
  expect(mocks.getDatabaseWorkspace).toHaveBeenCalledOnce();
  expect(mocks.downloadFile).not.toHaveBeenCalled();
  await reportRunningProgress(mocks, defaultDatabaseProgressId(manifestDb.downloadLink));
  expect(host.querySelector("[data-progress]")?.textContent).toBe("45");
  mocks.cancelDownload.mockImplementation(async (ticket: string) => {
    expect(ticket).toBe("prepared-ticket");
    rejectWorkspace(new Error("Cancellation"));
    return true;
  });
  await clickProgressCancel(host);
  expect(mocks.cancelDownload).toHaveBeenCalledExactlyOnceWith("prepared-ticket");
  expect(mocks.clearProgress).toHaveBeenCalledExactlyOnceWith(
    defaultDatabaseProgressId(manifestDb.downloadLink),
  );
  expect(mocks.cancelDownloadForProgress).not.toHaveBeenCalled();
  expect(mocks.progressButtonProps?.inProgress).toBe(false);
  expect(host.querySelector("[data-progress]")?.textContent).toBe("45");
  expect(host.textContent).toContain("Common.Cancel");
  await reportRunningProgress(mocks, defaultDatabaseProgressId(manifestDb.downloadLink), 60);
  expect(host.querySelector("[data-progress]")?.textContent).toBe("60");
  await clickProgressCancel(host);
  expect(mocks.cancelDownloadForProgress).toHaveBeenCalledExactlyOnceWith(
    defaultDatabaseProgressId(manifestDb.downloadLink),
  );
  expect(mocks.cancelDownload).toHaveBeenCalledOnce();
  expect(mocks.clearProgress).toHaveBeenCalledOnce();
  expect(mocks.downloadFile).not.toHaveBeenCalled();
  expect(reloadDatabases).not.toHaveBeenCalled();
  expect(mocks.notify).not.toHaveBeenCalled();
  expect(host.querySelector("[data-progress]")).toBeNull();
});

test("keeps a cancelled database download destination silent", async () => {
  mocks.defaultDatabases = [manifestDb];
  mocks.getDatabaseWorkspace.mockResolvedValue({
    root: {
      id: { id: "database-root" },
      kind: "databaseRoot",
    },
    displayName: "Databases",
  });
  mocks.databaseDownloadDestination.mockRejectedValue(new Error("Cancellation"));
  const { reloadDatabases } = await renderAddDatabase();

  await act(async () => mocks.progressButtonProps!.onClick());

  expect(mocks.notify).not.toHaveBeenCalled();
  expect(reloadDatabases).not.toHaveBeenCalled();
});

test.each(["convert", "download"] as const)(
  "%s root acquisition uses the database sentence and preserves unlabelled errors",
  async (surface) => {
    if (surface === "download") mocks.defaultDatabases = [manifestDb];
    const { setOpened } = await renderAddDatabase();
    if (surface === "convert") {
      mocks.issuePgnWorkspace.mockResolvedValue({
        handle: { id: { id: "pgn" }, kind: "fileWorkspace" },
        displayName: "games.pgn",
      });
      await act(async () =>
        [...host.querySelectorAll("button")]
          .find((button) => button.textContent === "pick-pgn")!
          .click(),
      );
    }
    for (const labelled of [true, false]) {
      mocks.notify.mockClear();
      mocks.getDatabaseWorkspace.mockRejectedValue({
        tag: "backend-error",
        category: "io",
        message: "native failure",
        ...(labelled ? { rootFailure: "missing" } : {}),
      });
      await act(async () => {
        if (surface === "download") mocks.progressButtonProps!.onClick();
        else
          host
            .querySelector("form")!
            .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      expect(mocks.notify).toHaveBeenCalledExactlyOnceWith({
        color: "danger",
        title: "Common.Error",
        message: labelled
          ? "This database folder is no longer available. Choose another."
          : "native failure",
      });
      expect(setOpened).not.toHaveBeenCalled();
    }
  },
);

test("reports a failed database download destination without replacing the list", async () => {
  mocks.defaultDatabases = [manifestDb];
  mocks.getDatabaseWorkspace.mockResolvedValue({
    root: {
      id: { id: "database-root" },
      kind: "databaseRoot",
    },
    displayName: "Databases",
  });
  mocks.databaseDownloadDestination.mockRejectedValue(new Error("permission denied"));
  const { reloadDatabases } = await renderAddDatabase();

  await act(async () => mocks.progressButtonProps!.onClick());

  expect(mocks.notify).toHaveBeenCalledWith({
    color: "danger",
    title: "Common.Error",
    message: "permission denied",
  });
  expect(reloadDatabases).not.toHaveBeenCalled();
});

test("offers cancellation while setup is pending and keeps cancellation silent", async () => {
  mocks.defaultDatabases = [manifestDb];
  let rejectWorkspace!: (error: unknown) => void;
  mocks.getDatabaseWorkspace.mockReturnValue(
    new Promise((_resolve, reject) => {
      rejectWorkspace = reject;
    }),
  );
  await renderAddDatabase();
  await act(async () => mocks.progressButtonProps!.onClick());
  await vi.waitFor(() => expect(mocks.progressButtonProps?.onCancel).toEqual(expect.any(Function)));

  const onCancel = mocks.progressButtonProps!.onCancel!;
  mocks.cancelDownload.mockImplementation(async (ticket: string) => {
    expect(ticket).toBe("prepared-ticket");
    rejectWorkspace(new Error("Cancellation"));
    return true;
  });
  await act(async () => onCancel());

  expect(mocks.cancelDownload).toHaveBeenCalledWith("prepared-ticket");
  expect(mocks.progressButtonProps?.clearOnCancel).toBe(false);
  expect(mocks.downloadFile).not.toHaveBeenCalled();
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("reports a job failure once when cancellation is followed by that failure", async () => {
  mocks.defaultDatabases = [manifestDb];
  const failure = new Error("download failed after cancel");
  let rejectWorkspace!: (error: unknown) => void;
  mocks.getDatabaseWorkspace.mockReturnValue(
    new Promise((_resolve, reject) => {
      rejectWorkspace = reject;
    }),
  );
  await renderAddDatabase();
  await act(async () => mocks.progressButtonProps!.onClick());
  await vi.waitFor(() => expect(mocks.progressButtonProps?.onCancel).toEqual(expect.any(Function)));
  mocks.cancelDownload.mockImplementation(async () => {
    rejectWorkspace(failure);
    return true;
  });

  await expect(mocks.progressButtonProps!.onCancel!()).rejects.toBe(failure);
  expect(mocks.notify).toHaveBeenCalledTimes(1);
});

test("does not notify when cancellation loses the completed-job race", async () => {
  mocks.defaultDatabases = [manifestDb];
  let resolveWorkspace!: (value: unknown) => void;
  mocks.getDatabaseWorkspace.mockReturnValue(
    new Promise((resolve) => {
      resolveWorkspace = resolve;
    }),
  );
  mocks.databaseDownloadDestination.mockResolvedValue({ id: { id: "destination" } });
  mocks.downloadFile.mockResolvedValue(undefined);
  mocks.getDatabases.mockResolvedValue({
    databases: [],
    unread: [],
    root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
  });
  await renderAddDatabase();
  await act(async () => mocks.progressButtonProps!.onClick());
  await vi.waitFor(() => expect(mocks.progressButtonProps?.onCancel).toEqual(expect.any(Function)));
  mocks.cancelDownload.mockImplementation(async () => {
    resolveWorkspace({
      root: { id: { id: "root" }, kind: "databaseRoot" },
      displayName: "Databases",
    });
    return false;
  });

  await expect(mocks.progressButtonProps!.onCancel!()).rejects.toMatchObject({ reason: "lost" });
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("keeps the PGN picker silent on Cancellation and notifies a real failure", async () => {
  await renderAddDatabase();
  const pick = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("pick-pgn"),
  )!;

  mocks.issuePgnWorkspace.mockRejectedValueOnce(new Error("Cancellation"));
  await act(async () => pick.click());
  expect(mocks.notify).not.toHaveBeenCalled();

  mocks.issuePgnWorkspace.mockRejectedValueOnce(new Error("permission denied"));
  await act(async () => pick.click());
  expect(mocks.notify).toHaveBeenCalledWith({
    color: "danger",
    title: "Common.Error",
    message: "permission denied",
  });
});

test("commits a selected PGN workspace into the form", async () => {
  await renderAddDatabase();
  mocks.issuePgnWorkspace.mockResolvedValue({
    handle: { id: { id: "pgn" }, kind: "fileWorkspace" },
    displayName: "games.pgn",
  });
  const pick = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("pick-pgn"),
  )!;
  await act(async () => pick.click());
  expect(host.textContent).toContain("games.pgn");
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("keeps the modal open when local conversion fails", async () => {
  const { setOpened } = await renderAddDatabase();
  mocks.issuePgnWorkspace.mockResolvedValue({
    handle: { id: { id: "pgn" }, kind: "fileWorkspace" },
    displayName: "games.pgn",
  });
  mocks.getDatabaseWorkspace.mockResolvedValue({
    root: {
      id: { id: "database-root" },
      kind: "databaseRoot",
    },
    displayName: "Databases",
  });
  mocks.convertPgn.mockClear();
  mocks.createWorkspaceDatabase.mockImplementation(async () => {
    expect(getDefaultStore().get(databaseConversionStateAtom)).toEqual([
      expect.objectContaining({
        id: "conversion:00000000-0000-4000-8000-000000000001",
        targetDatabase: null,
      }),
    ]);
    throw new Error("permission denied");
  });
  const pick = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("pick-pgn"),
  )!;
  await act(async () => pick.click());

  const convert = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Databases.Add.Convert",
  )!;
  await act(async () => convert.click());

  expect(setOpened).not.toHaveBeenCalledWith(false);
  expect(mocks.convertPgn).not.toHaveBeenCalled();
  expect(getDefaultStore().get(databaseConversionStateAtom)).toEqual([]);
  expect(mocks.notify).toHaveBeenCalledWith({
    color: "danger",
    title: "Common.Error",
    message: "permission denied",
  });
});

async function submitLocalImport() {
  const pick = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("pick-pgn"),
  )!;
  await act(async () => pick.click());
  const convert = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Databases.Add.Convert",
  )!;
  await act(async () => convert.click());
}

const importHandle = { id: { id: "import-db" }, kind: "database" } as const;
const importSource = { id: { id: "pgn" }, kind: "fileWorkspace" } as const;

function setupLocalImport() {
  mocks.issuePgnWorkspace.mockResolvedValue({ handle: importSource, displayName: "games.pgn" });
  mocks.getDatabaseWorkspace.mockResolvedValue({
    root: { id: { id: "root" }, kind: "databaseRoot" },
    displayName: "Databases",
  });
  mocks.createWorkspaceDatabase.mockResolvedValue(importHandle);
}

const linkedImport = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Games",
  file: importSource,
  database: importHandle,
  account: null,
  status: "ready" as const,
  generation: "one",
  omitted: 0,
  retiredDatabase: null,
  fetchSinceMs: null,
};

test.each(["ready", "unavailable", "missing-cache"])(
  "local import resolves linked identity before conversion for %s",
  async (state) => {
    setupLocalImport();
    mocks.linkedCollectionsSupported.mockResolvedValue(true);
    mocks.listLinkedCollections.mockResolvedValue([
      {
        ...linkedImport,
        status: state === "ready" ? "ready" : "unavailable",
        database: state === "missing-cache" ? null : importHandle,
      },
    ]);
    mocks.rebuildLinkedCollection.mockResolvedValue(linkedImport);
    const created = vi.fn();
    await expect(
      convertLocalDatabase("import", [importSource], "Games", undefined, created),
    ).resolves.toEqual(importHandle);
    expect(mocks.createWorkspaceDatabase).not.toHaveBeenCalled();
    expect(mocks.convertPgn).not.toHaveBeenCalled();
    expect(created).toHaveBeenCalledExactlyOnceWith(importHandle);
    expect(mocks.rebuildLinkedCollection).toHaveBeenCalledExactlyOnceWith(linkedImport.id, false);
  },
);

test("an unavailable linked import preserves the typed refresh failure and never creates a standalone copy", async () => {
  setupLocalImport();
  mocks.linkedCollectionsSupported.mockResolvedValue(true);
  mocks.listLinkedCollections.mockResolvedValue([
    { ...linkedImport, status: "unavailable", database: null },
  ]);
  const failure = new TauriCommandError({
    tag: "backend-error",
    category: "missing-resource",
    message: "Source unavailable",
  });
  mocks.rebuildLinkedCollection.mockRejectedValue(failure);
  const created = vi.fn();
  await expect(
    convertLocalDatabase("import", [importSource], "Games", undefined, created),
  ).rejects.toBe(failure);
  expect(created).not.toHaveBeenCalled();
  expect(mocks.createWorkspaceDatabase).not.toHaveBeenCalled();
  expect(mocks.convertPgn).not.toHaveBeenCalled();
});

test.each(["plain", "external", "windows"])(
  "%s PGN import keeps independent conversion and its cancellation ticket",
  async (kind) => {
    setupLocalImport();
    mocks.linkedCollectionsSupported.mockResolvedValue(kind !== "windows");
    mocks.listLinkedCollections.mockResolvedValue(
      kind === "external"
        ? [{ ...linkedImport, file: { ...importSource, id: { id: "library-source" } } }]
        : [],
    );
    mocks.convertPgn.mockResolvedValueOnce(undefined);
    const created = vi.fn();
    await expect(
      convertLocalDatabase("import", [importSource], "Games", undefined, created, {
        ticket: "owned-ticket",
        throwIfCancelled: vi.fn(),
      }),
    ).resolves.toEqual(importHandle);
    expect(mocks.convertPgn).toHaveBeenCalledExactlyOnceWith(
      "import",
      [importSource],
      importHandle,
      "Games",
      null,
      "owned-ticket",
    );
    expect(created).toHaveBeenCalledExactlyOnceWith(importHandle);
    expect(mocks.rebuildLinkedCollection).not.toHaveBeenCalled();
    expect(mocks.listLinkedCollections).toHaveBeenCalledTimes(kind === "windows" ? 0 : 1);
  },
);

test("cancellation during linked refresh publishes no created target", async () => {
  setupLocalImport();
  mocks.linkedCollectionsSupported.mockResolvedValue(true);
  mocks.listLinkedCollections.mockResolvedValue([linkedImport]);
  let finish!: (value: typeof linkedImport) => void;
  mocks.rebuildLinkedCollection.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const cancelled = new Error("Cancellation");
  const created = vi.fn();
  let cancellation = false;
  const result = convertLocalDatabase("import", [importSource], "Games", undefined, created, {
    ticket: "ticket",
    throwIfCancelled: () => {
      if (cancellation) throw cancelled;
    },
  });
  await vi.waitFor(() => expect(mocks.rebuildLinkedCollection).toHaveBeenCalledOnce());
  cancellation = true;
  finish(linkedImport);
  await expect(result).rejects.toBe(cancelled);
  expect(created).not.toHaveBeenCalled();
  expect(mocks.createWorkspaceDatabase).not.toHaveBeenCalled();
});

test("a refresh that remains unavailable returns typed recovery without publishing a target", async () => {
  setupLocalImport();
  mocks.linkedCollectionsSupported.mockResolvedValue(true);
  mocks.listLinkedCollections.mockResolvedValue([
    { ...linkedImport, database: null, status: "unavailable" },
  ]);
  mocks.rebuildLinkedCollection.mockResolvedValue({
    ...linkedImport,
    database: null,
    status: "unavailable",
  });
  const created = vi.fn();
  await expect(
    convertLocalDatabase("import", [importSource], "Games", undefined, created),
  ).rejects.toMatchObject({ details: expect.objectContaining({ category: "not-found" }) });
  expect(created).not.toHaveBeenCalled();
  expect(mocks.createWorkspaceDatabase).not.toHaveBeenCalled();
  expect(mocks.convertPgn).not.toHaveBeenCalled();
});

test("a committed import closes its mounted modal after reloadDatabases fails and cannot resubmit the original form", async () => {
  setupLocalImport();
  mocks.convertPgn.mockResolvedValueOnce(undefined);
  const failure = new Error("reload denied at /private/import.db3");
  const reloadDatabases = vi.fn().mockRejectedValueOnce(failure);
  const setOpened = vi.fn();
  function MountedImport() {
    const [opened, updateOpened] = useState(true);
    return (
      <AddDatabase
        databases={[]}
        opened={opened}
        setOpened={(value) => {
          setOpened(value);
          updateOpened(value);
        }}
        disableLocalConversion={false}
        reloadDatabases={reloadDatabases}
      />
    );
  }
  await act(async () => root.render(<MountedImport />));
  const originalForm = host.querySelector("form")!;
  const originalSubmit = originalForm.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  await submitLocalImport();

  expect(setOpened).toHaveBeenCalledExactlyOnceWith(false);
  expect(host.querySelector("form")).toBeNull();
  expect(originalForm.isConnected).toBe(false);
  await act(async () => originalSubmit.click());
  expect(mocks.createWorkspaceDatabase).toHaveBeenCalledOnce();
  expect(mocks.convertPgn).toHaveBeenCalledOnce();
  expect(mocks.deleteDatabase).not.toHaveBeenCalled();
  expect(reloadDatabases).toHaveBeenCalledExactlyOnceWith();
  expect(mocks.getDatabases).not.toHaveBeenCalled();
  expect(getDefaultStore().get(databaseConversionStateAtom)).toEqual([]);
  expect(getDefaultStore().get(databaseConversionRefreshFailedAtom)).toBe(true);
  expect(mocks.logError).toHaveBeenCalledExactlyOnceWith(
    "Failed import database refresh failed: reload denied at [path]",
  );
  expect(mocks.notify).toHaveBeenCalledExactlyOnceWith({
    color: "danger",
    title: "Common.Error",
    message: "reload denied at [path]",
  });
});

test.each(["none", "delete", "reloadDatabases", "logger", "refreshLogger"])(
  "failed conversion preserves the backend message and clears state with %s failure",
  async (secondaryFailure) => {
    setupLocalImport();
    const failure = new TauriCommandError({
      tag: "backend-error",
      category: "invalid-input",
      message: "Invalid input: games.pgn: game 2 could not be read (unterminated comment or tag)",
    });
    mocks.convertPgn.mockRejectedValueOnce(failure);
    const reloadDatabases = vi.fn().mockResolvedValue(undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    if (secondaryFailure === "delete" || secondaryFailure === "logger") {
      mocks.deleteDatabase.mockRejectedValueOnce(
        new Error("cleanup denied at /private/orphan.db3"),
      );
    }
    if (secondaryFailure === "reloadDatabases" || secondaryFailure === "refreshLogger") {
      reloadDatabases.mockRejectedValueOnce(new Error("refresh denied"));
    }
    if (secondaryFailure === "logger" || secondaryFailure === "refreshLogger")
      mocks.logError.mockRejectedValueOnce(new Error("logger denied"));
    const { setOpened } = await renderAddDatabase([], { reloadDatabases });
    await submitLocalImport();

    expect(mocks.deleteDatabase).toHaveBeenCalledExactlyOnceWith(importHandle);
    expect(mocks.getDatabases).not.toHaveBeenCalled();
    expect(reloadDatabases).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith({
      color: "danger",
      title: "Common.Error",
      message: failure.message,
    });
    expect(setOpened).not.toHaveBeenCalledWith(false);
    expect(getDefaultStore().get(databaseConversionStateAtom)).toEqual([]);
    const cleanupFailed = secondaryFailure === "delete" || secondaryFailure === "logger";
    expect(mocks.logError.mock.calls).toEqual(
      secondaryFailure === "none"
        ? []
        : [
            [
              cleanupFailed
                ? "Failed import database cleanup failed: cleanup denied at [path]"
                : "Failed import database refresh failed: refresh denied",
            ],
          ],
    );
    const fallbackCalls =
      secondaryFailure === "logger"
        ? [
            [
              "Import cleanup logging failed",
              {
                operation: "failed import database cleanup",
                primaryFailure: { category: "permission", message: "cleanup denied at [path]" },
                loggerFailure: { category: "permission", message: "logger denied" },
              },
            ],
          ]
        : secondaryFailure === "refreshLogger"
          ? [
              [
                "Import refresh logging failed",
                {
                  operation: "failed import database refresh",
                  primaryFailure: { category: "permission", message: "refresh denied" },
                  loggerFailure: { category: "permission", message: "logger denied" },
                },
              ],
            ]
          : [];
    expect(consoleError.mock.calls).toEqual(fallbackCalls);
    consoleError.mockRestore();
  },
);

test("cancellation deletes the created database and rethrows the same error", async () => {
  setupLocalImport();
  const cancellation = new Error("Cancellation");
  mocks.convertPgn.mockRejectedValueOnce(cancellation);
  await expect(
    convertLocalDatabase("conversion:test", [importSource], "Games", undefined, vi.fn()),
  ).rejects.toBe(cancellation);
  expect(mocks.deleteDatabase).toHaveBeenCalledExactlyOnceWith(importHandle);
  expect(mocks.convertPgn).toHaveBeenCalledWith(
    "conversion:test",
    [importSource],
    importHandle,
    "Games",
    null,
    null,
  );
});

test("a cancelled local conversion removes its entry and keeps the modal open silently", async () => {
  setupLocalImport();
  mocks.convertPgn.mockRejectedValueOnce(new Error("Cancellation"));
  const { setOpened } = await renderAddDatabase();
  await submitLocalImport();
  expect(mocks.deleteDatabase).toHaveBeenCalledExactlyOnceWith(importHandle);
  expect(getDefaultStore().get(databaseConversionStateAtom)).toEqual([]);
  expect(setOpened).not.toHaveBeenCalledWith(false);
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("cancel during target creation skips native dispatch and retains the row through deletion and refresh", async () => {
  setupLocalImport();
  let created!: (handle: typeof importHandle) => void;
  let deleted!: () => void;
  let refreshed!: () => void;
  mocks.createWorkspaceDatabase.mockReturnValueOnce(
    new Promise((resolve) => {
      created = resolve;
    }),
  );
  mocks.deleteDatabase.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      deleted = resolve;
    }),
  );
  const reloadDatabases = vi.fn().mockReturnValueOnce(
    new Promise<void>((resolve) => {
      refreshed = resolve;
    }),
  );
  await renderAddDatabase([], { reloadDatabases });
  await submitLocalImport();
  const store = getDefaultStore();
  expect(store.get(databaseConversionStateAtom)).toHaveLength(1);
  await act(async () => store.get(databaseConversionStateAtom)[0].cancel!());
  await act(async () => created(importHandle));
  expect(mocks.convertPgn).not.toHaveBeenCalled();
  expect(mocks.deleteDatabase).toHaveBeenCalledExactlyOnceWith(importHandle);
  expect(store.get(databaseConversionStateAtom)).toHaveLength(1);
  expect(reloadDatabases).not.toHaveBeenCalled();
  await act(async () => deleted());
  expect(store.get(databaseConversionStateAtom)).toHaveLength(1);
  expect(reloadDatabases).toHaveBeenCalledExactlyOnceWith();
  await act(async () => refreshed());
  expect(store.get(databaseConversionStateAtom)).toEqual([]);
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("a successful new-target conversion wins a pending cancellation and keeps its database", async () => {
  setupLocalImport();
  let committed!: () => void;
  mocks.convertPgn.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      committed = resolve;
    }),
  );
  const { setOpened } = await renderAddDatabase();
  await submitLocalImport();
  const store = getDefaultStore();
  await act(async () => store.get(databaseConversionStateAtom)[0].cancel!());
  expect(mocks.cancelConversion).toHaveBeenCalledWith("conversion-ticket");
  await act(async () => committed());
  expect(mocks.deleteDatabase).not.toHaveBeenCalled();
  expect(setOpened).toHaveBeenCalledWith(false);
  expect(store.get(databaseConversionStateAtom)).toEqual([]);
});

test.each([false, true])(
  "cancellation preserves its object and safely reports cleanup failure=%s",
  async (cleanupFails) => {
    setupLocalImport();
    const cancellation = new TauriCommandError({
      tag: "backend-error",
      category: "cancellation",
      message: "Cancellation",
    });
    mocks.convertPgn.mockRejectedValueOnce(cancellation);
    if (cleanupFails) mocks.deleteDatabase.mockRejectedValueOnce(new Error("cleanup refused"));
    const secondary = vi.fn();
    await expect(
      convertLocalDatabase(
        "operation",
        [importSource],
        "Games",
        undefined,
        vi.fn(),
        { ticket: "ticket", throwIfCancelled: () => undefined },
        secondary,
      ),
    ).rejects.toBe(cancellation);
    expect(secondary).toHaveBeenCalledTimes(cleanupFails ? 1 : 0);
    expect(mocks.logError.mock.calls).toEqual(
      cleanupFails ? [["Failed import database cleanup failed: cleanup refused"]] : [],
    );
  },
);

test.each([false, true])(
  "successful conversion surfaces refresh failure=%s without deleting the database",
  async (refreshFails) => {
    setupLocalImport();
    mocks.convertPgn.mockResolvedValueOnce(undefined);
    const reloadDatabases = vi.fn().mockResolvedValue(undefined);
    if (refreshFails) reloadDatabases.mockRejectedValueOnce(new Error("success refresh failed"));
    const { setOpened } = await renderAddDatabase([], { reloadDatabases });
    await submitLocalImport();
    expect(mocks.deleteDatabase).not.toHaveBeenCalled();
    expect(mocks.getDatabases).not.toHaveBeenCalled();
    expect(getDefaultStore().get(databaseConversionStateAtom)).toEqual([]);
    expect(setOpened.mock.calls).toEqual([[false]]);
    expect(reloadDatabases).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.notify.mock.calls).toEqual(
      refreshFails
        ? [
            [
              {
                color: "danger",
                title: "Common.Error",
                message: "success refresh failed",
              },
            ],
          ]
        : [],
    );
  },
);

test("shows the catalog verification error instead of the fetch error", async () => {
  mocks.catalogError = new CatalogVerificationError(new Error("bad signature"));
  await renderAddDatabase();
  expect(host.textContent).toContain("Databases.Add.ErrorCatalog");
  expect(host.textContent).not.toContain("Databases.Add.ErrorFetch");
});

test("keeps the fetch error for other catalog failures", async () => {
  mocks.catalogError = new Error("offline");
  await renderAddDatabase();
  expect(host.textContent).toContain("Databases.Add.ErrorFetch");
  expect(host.textContent).not.toContain("Databases.Add.ErrorCatalog");
});
