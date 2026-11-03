import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, test, vi, type MockInstance } from "vitest";
import { getDefaultStore, Provider, useAtomValue } from "jotai";
import type { AccountCompletion, AccountImportRequest, DatabaseHandle } from "@/bindings";
import {
  databaseConversionStateAtom,
  databaseConversionRefreshFailedAtom,
  referenceDbAtom,
  type DatabaseConversionEntry,
} from "@/state/atoms";
import { activeDatabaseViewStore } from "@/state/store/database";
import { databaseHandleKey, type SuccessDatabaseInfo } from "@/utils/db";
import { useConversionProgress } from "@/hooks/useConversionProgress";

const mocks = vi.hoisted(() => ({
  convertPgn: vi.fn(),
  deleteDatabase: vi.fn(),
  cancelConversion: vi.fn().mockResolvedValue(true),
  withConversionTicket: vi.fn((run: (ticket: string) => Promise<unknown>) =>
    run(`conversion-ticket:${crypto.randomUUID()}`),
  ),
  getDatabaseWorkspace: vi.fn(),
  createWorkspaceDatabase: vi.fn(),
  listWorkspaceDatabases: vi.fn(),
  issuePgnWorkspace: vi.fn(),
  getDatabases: vi.fn(),
  pickPgnFile: vi.fn(),
  editDbInfo: vi.fn(),
  issueDownloadDestination: vi.fn(),
  beginNativeImport: vi.fn(),
  deleteEmptyGames: vi.fn(),
  deleteDuplicatedGames: vi.fn(),
  mergePlayers: vi.fn(),
  createIndexes: vi.fn(),
  deleteIndexes: vi.fn(),
  convertProgress: vi.fn(),
  progress: vi.fn(),
  importAccountGames: vi.fn(),
  pendingAccountCompletions: vi.fn(),
  acknowledgeAccountCompletion: vi.fn(),
  completionChanged: vi.fn(),
  notify: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/platform/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
  return {
    ...actual,
    withConversionTicket: mocks.withConversionTicket,
    tauri: {
      ...actual.tauri,
      linkedCollectionsSupported: vi.fn(async () => false),
      importAccountGames: mocks.importAccountGames,
      pendingAccountCompletions: mocks.pendingAccountCompletions,
      acknowledgeAccountCompletion: mocks.acknowledgeAccountCompletion,
      convertPgn: mocks.convertPgn,
      cancelConversion: mocks.cancelConversion,
      getDatabaseWorkspace: mocks.getDatabaseWorkspace,
      createWorkspaceDatabase: mocks.createWorkspaceDatabase,
      listWorkspaceDatabases: mocks.listWorkspaceDatabases,
      issuePgnWorkspace: mocks.issuePgnWorkspace,
      editDbInfo: mocks.editDbInfo,
      issueDownloadDestination: mocks.issueDownloadDestination,
      deleteEmptyGames: mocks.deleteEmptyGames,
      deleteDatabase: mocks.deleteDatabase,
      exportToPgn: vi.fn(),
      issuePgnExportDestination: vi.fn(),
      clearGames: vi.fn(),
      mergePlayers: mocks.mergePlayers,
      deleteDuplicatedGames: mocks.deleteDuplicatedGames,
      createIndexes: mocks.createIndexes,
      deleteIndexes: mocks.deleteIndexes,
      getPlayer: vi.fn(),
    },
    tauriSubscriptions: {
      ...actual.tauriSubscriptions,
      convertProgress: mocks.convertProgress,
      progress: mocks.progress,
      completionChanged: mocks.completionChanged,
    },
  };
});
vi.mock("@/utils/db", async () => {
  const actual = await vi.importActual<typeof import("@/utils/db")>("@/utils/db");
  return { ...actual, getDatabases: mocks.getDatabases };
});
vi.mock("@/utils/files", async () => {
  const actual = await vi.importActual<typeof import("@/utils/files")>("@/utils/files");
  return { ...actual, pickPgnFile: mocks.pickPgnFile };
});
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.notify } }));
vi.mock("@/platform/native", () => ({ error: mocks.logError }));
vi.mock("react-i18next", () => {
  const t = (key: string, options?: { number?: number }) =>
    options?.number === undefined ? key : `${key}:${options.number}`;
  return { useTranslation: () => ({ t }) };
});
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  default: { t: (key: string) => key },
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../common/AppModal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../common/FileInput", () => ({
  default: ({ onClick, filename }: { onClick: () => void; filename: string | null }) => (
    <button type="button" onClick={onClick}>
      {filename || "pick-pgn"}
    </button>
  ),
}));
vi.mock("../common/ConfirmModal", () => ({ default: () => null }));
vi.mock("../common/GenericCard", () => ({
  default: ({
    id,
    setSelected,
    Header,
    footer,
  }: {
    id: string;
    setSelected: (id: string) => void;
    Header: React.ReactNode;
    footer?: React.ReactNode;
  }) => (
    <div>
      <button type="button" data-testid={`select-${id}`} onClick={() => setSelected(id)}>
        {Header}
      </button>
      {footer}
    </div>
  ),
}));
vi.mock("../common/IconAction", () => ({
  IconAction: ({
    label,
    onClick,
    disabled,
  }: {
    label: string;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" aria-label={label} disabled={disabled} onClick={onClick}>
      {label}
    </button>
  ),
}));
vi.mock("../common/ProgressButton", () => ({
  default: () => null,
}));
vi.mock("./PlayerSearchInput", () => ({
  PlayerSearchInput: ({
    label,
    setValue,
  }: {
    label: string;
    setValue: (value: number | undefined) => void;
  }) => (
    <button type="button" onClick={() => setValue(label === "Databases.Player.One" ? 1 : 2)}>
      {label}
    </button>
  ),
}));
vi.mock("@/components/home/LichessLogo", () => ({ default: () => null }));
vi.mock("@mantine/core", async () => ({
  useMatches: (await import("@/tests/matchMedia")).baseResponsiveValue,
  Alert: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Box: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Button: ({
    children,
    loading,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) => (
    <button type="button" {...props} data-loading={loading ? "true" : undefined}>
      {children}
    </button>
  ),
  Card: Object.assign(({ children }: { children: React.ReactNode }) => <div>{children}</div>, {
    Section: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  }),
  Center: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Checkbox: ({
    label,
    ...props
  }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <input type="checkbox" aria-label={label} {...props} />
  ),
  Divider: () => <hr />,
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Loader: () => null,
  Paper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Progress: () => null,
  Rating: ({ value, count, onChange }: { value: number; count: number; onChange: () => void }) => (
    <input
      type="checkbox"
      data-reference-toggle
      data-count={count}
      checked={value === 1}
      onChange={onChange}
    />
  ),
  ScrollArea: Object.assign(
    ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    { Autosize: ({ children }: { children: React.ReactNode }) => <div>{children}</div> },
  ),
  SimpleGrid: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Skeleton: () => null,
  Stack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tabs: Object.assign(({ children }: { children: React.ReactNode }) => <div>{children}</div>, {
    List: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Tab: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
    Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  }),
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Textarea: ({
    label,
    ...props
  }: { label?: string } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <label>
      {label}
      <textarea {...props} />
    </label>
  ),
  TextInput: ({
    label,
    ...props
  }: { label?: string } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <label>
      {label}
      <input {...props} />
    </label>
  ),
  ThemeIcon: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Title: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("lucide-react", () => ({
  AlertCircle: () => null,
  ArrowDownRight: () => null,
  ArrowRight: () => null,
  ArrowUpRight: () => null,
  CircleCheckBig: () => null,
  Database: () => null,
  Download: () => null,
  Plus: () => null,
  RefreshCw: () => null,
  Search: () => null,
  Trash2: () => null,
}));

import { useDatabaseLibrary } from "./useDatabaseLibrary";
function DatabasesPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const source = useDatabaseLibrary(selected, setSelected);
  return (
    <>
      <button
        type="button"
        aria-label="Common.AddNew"
        onClick={source.add}
        disabled={source.conversionInProgress}
      >
        Add New
      </button>
      {source.status}
      {source.progress}
      {source.dialogs}
      {source.visibleDatabases.map(source.renderRow)}
      {source.detail}
    </>
  );
}
import { AccountCard } from "@/components/home/AccountCard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type ConvertProgress = {
  id: string;
  imported_games: number;
  elapsed_ms: number;
  source_file_name: string | null;
};

type ConvertCall = {
  args: unknown[];
  registeredAtCall: DatabaseConversionEntry | undefined;
  mintedAtCall: string[];
  resolve: () => void;
  reject: (error: unknown) => void;
};

const store = getDefaultStore();
const handleA: DatabaseHandle = { id: { id: "new-import" }, kind: "database" };
const handleB: DatabaseHandle = { id: { id: "games-dest" }, kind: "database" };
const accountHandle: DatabaseHandle = { id: { id: "account-db" }, kind: "database" };
const workspaceRoot = { id: { id: "database-root" }, kind: "databaseRoot" as const };
const localPgn = { id: { id: "local-pgn" }, kind: "fileWorkspace" as const };
const addGamesPgn = { id: { id: "add-games-pgn" }, kind: "fileWorkspace" as const };

function successDatabase(file: DatabaseHandle, title: string): SuccessDatabaseInfo {
  return {
    type: "success",
    title,
    description: "",
    player_count: 2,
    event_count: 2,
    game_count: 1,
    storage_size: "1",
    filename: `${databaseHandleKey(file)}.db3`,
    indexed: true,
    file,
  };
}

function ConversionProbe() {
  useConversionProgress();
  const state = useAtomValue(databaseConversionStateAtom);
  return state.map((entry) => (
    <output
      key={entry.id}
      data-id={entry.id}
      data-total={String(entry.totalGames)}
      data-target={entry.targetDatabase ? databaseHandleKey(entry.targetDatabase) : "none"}
      data-source={entry.sourceFileName ?? "none"}
    />
  ));
}

let root: Root;
let host: HTMLDivElement;
let convertCalls: ConvertCall[];
let randomUUIDSpy: MockInstance<typeof crypto.randomUUID>;
let convertProgressListener: ((event: { payload: ConvertProgress }) => void) | undefined;

function conversionState() {
  return store.get(databaseConversionStateAtom);
}

function conversionRows() {
  return [...host.querySelectorAll("span")]
    .filter((span) => span.textContent?.startsWith("Databases.Add.Convert:"))
    .map((span) => span.parentElement?.parentElement?.textContent?.replace(/Common.Cancel$/, ""));
}

function activeOperation(index: number) {
  const call = convertCalls[index];
  if (!call) throw new Error(`Missing convertPgn call ${index}`);
  const id = call.args[0];
  if (typeof id !== "string") throw new Error("Missing conversion id");
  const entry = conversionState().find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Missing registered conversion ${id}`);
  return entry;
}

function assertConversionCall(index: number) {
  const call = convertCalls[index];
  if (!call) throw new Error(`Missing convertPgn call ${index}`);
  const id = call.args[0];
  expect(id).toMatch(/^conversion:[0-9a-f-]{36}$/);
  expect(call.mintedAtCall).toContain(id);
  expect(call.registeredAtCall).toMatchObject({
    id,
    targetDatabase: call.args[2],
    totalGames: 0,
    elapsedSeconds: 0,
  });
}

function addNewDisabled() {
  return (host.querySelector('button[aria-label="Common.AddNew"]') as HTMLButtonElement).disabled;
}

function buttonByText(text: string) {
  return [...host.querySelectorAll("button")].find((button) => button.textContent === text);
}

async function emitConvertProgress(payload: ConvertProgress) {
  await act(async () => convertProgressListener?.({ payload }));
}

beforeEach(() => {
  vi.clearAllMocks();
  convertCalls = [];
  convertProgressListener = undefined;
  localStorage.clear();
  sessionStorage.clear();
  store.set(databaseConversionStateAtom, []);
  store.set(databaseConversionRefreshFailedAtom, false);
  mocks.cancelConversion.mockReset().mockResolvedValue(true);
  mocks.deleteDatabase.mockReset().mockResolvedValue(undefined);
  mocks.withConversionTicket
    .mockReset()
    .mockImplementation((run) => run(`conversion-ticket:${crypto.randomUUID()}`));
  mocks.convertPgn.mockImplementation((...args: unknown[]) => {
    const registered = conversionState().find((entry) => entry.id === args[0]);
    const registeredAtCall = registered ? { ...registered } : undefined;
    const mintedAtCall = randomUUIDSpy.mock.results.map((result) => `conversion:${result.value}`);
    return new Promise<void>((resolve, reject) => {
      convertCalls.push({ args, registeredAtCall, mintedAtCall, resolve, reject });
    });
  });
  mocks.convertProgress.mockImplementation(
    async (listener: (event: { payload: ConvertProgress }) => void) => {
      convertProgressListener = listener;
      return () => undefined;
    },
  );
  mocks.progress.mockResolvedValue(() => undefined);
  let accountSnapshot: AccountCompletion[] = [];
  let accountChanged: (() => void) | undefined;
  mocks.completionChanged.mockImplementation(async (listener) => {
    accountChanged = listener;
    return () => {
      accountChanged = undefined;
    };
  });
  mocks.pendingAccountCompletions.mockImplementation(async () => accountSnapshot);
  mocks.acknowledgeAccountCompletion.mockImplementation(async () => {
    accountSnapshot = [];
  });
  // Model the new native boundary while preserving this suite's real conversion-state consumers.
  mocks.importAccountGames.mockImplementation(async (request: AccountImportRequest) => {
    const id = crypto.randomUUID();
    const running: AccountCompletion = {
      id,
      request,
      progressId: `download:${id}`,
      attempt: 1,
      importing: true,
      outcome: { state: "running" },
      publication: null,
      committedDatabase: null,
      deletionPending: false,
    };
    accountSnapshot = [running];
    accountChanged?.();
    for (
      let turn = 0;
      turn < 100 && !conversionState().some((entry) => entry.id === `conversion:${id}`);
      turn++
    )
      await Promise.resolve();
    if (!conversionState().some((entry) => entry.id === `conversion:${id}`))
      throw new Error("The native conversion snapshot was not observed");
    let outcome: AccountCompletion["outcome"] = {
      state: "succeeded",
      result: { collectionNotice: false },
    };
    try {
      await mocks.beginNativeImport(running.progressId);
      await mocks.convertPgn(
        `conversion:${id}`,
        [{ id: { id: "account-pgn" }, kind: "fileWorkspace" }],
        accountHandle,
        "Felix Chess.com",
        null,
        null,
      );
    } catch {
      outcome = {
        state: "failed",
        result: { tag: "backend-error", category: "database", message: "convert failed" },
      };
    }
    const terminal: AccountCompletion = {
      ...running,
      outcome,
      importing: false,
      publication: {
        handle: { id: { id: "account-pgn" }, kind: "fileWorkspace" },
        durability: "Durable",
      },
    };
    accountSnapshot = [terminal];
    return terminal;
  });
  mocks.getDatabases.mockResolvedValue({
    databases: [successDatabase(handleB, "Existing")],
    unread: [],
    root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
  });
  mocks.getDatabaseWorkspace.mockResolvedValue(workspaceRoot);
  mocks.createWorkspaceDatabase.mockResolvedValue(handleA);
  mocks.listWorkspaceDatabases.mockResolvedValue({
    entries: [{ handle: accountHandle, filename: "Felix_chesscom.db3", availability: "available" }],
    unread: [],
  });
  mocks.issuePgnWorkspace.mockResolvedValue({ handle: localPgn, displayName: "imported.pgn" });
  mocks.pickPgnFile.mockResolvedValue({ handle: addGamesPgn, name: "more.pgn" });
  mocks.editDbInfo.mockResolvedValue(undefined);
  mocks.issueDownloadDestination.mockResolvedValue({ id: "dest" });
  mocks.beginNativeImport.mockResolvedValue(undefined);
  mocks.deleteEmptyGames.mockResolvedValue(undefined);
  mocks.deleteDuplicatedGames.mockResolvedValue(undefined);
  mocks.mergePlayers.mockResolvedValue(undefined);
  mocks.createIndexes.mockResolvedValue(undefined);
  mocks.deleteIndexes.mockResolvedValue(undefined);
  let nextId = 0;
  randomUUIDSpy = vi
    .spyOn(crypto, "randomUUID")
    .mockImplementation(() => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  activeDatabaseViewStore.getState().clearDatabase();
  sessionStorage.clear();
});

async function renderRoute(account = false) {
  await act(async () => {
    root.render(
      <Provider store={store}>
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <ConversionProbe />
          <DatabasesPage />
          {account ? (
            <AccountCard
              type="chesscom"
              database={null}
              title="Felix"
              updatedAt={0}
              total={0}
              stats={[]}
              logout={vi.fn()}
              reload={vi.fn()}
            />
          ) : null}
        </SWRConfig>
      </Provider>,
    );
  });
}

async function startAddDatabase() {
  const pick = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("pick-pgn"),
  )!;
  await act(async () => pick.click());
  const convert = buttonByText("Databases.Add.Convert")!;
  await act(async () => convert.click());
  await vi.waitFor(() => expect(convertCalls.length).toBeGreaterThanOrEqual(1));
}

test("the database overview ends the active database session on mount", async () => {
  activeDatabaseViewStore.getState().setDatabase(successDatabase(handleB, "Existing"));
  await renderRoute();
  expect(activeDatabaseViewStore.getState().database).toBeUndefined();
});

test("the database overview preserves a database set after mount", async () => {
  await renderRoute();
  const database = successDatabase(handleB, "Existing");
  await act(async () => activeDatabaseViewStore.getState().setDatabase(database));
  await renderRoute();
  expect(activeDatabaseViewStore.getState().database).toEqual(database);
});

test("DatabasesPage error cards have Delete but no reference toggle; successful cards retain the toggle", async () => {
  mocks.getDatabases.mockResolvedValue({
    databases: [
      {
        type: "error",
        file: handleA,
        filename: "unfinished.db3",
        error: "Import unfinished",
        indexed: false,
      },
      successDatabase(handleB, "Existing"),
    ],
    unread: [],
    root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
  });
  store.set(referenceDbAtom, null);
  await renderRoute();
  const errorCard = host.querySelector<HTMLButtonElement>(
    `[data-testid='select-${databaseHandleKey(handleA)}']`,
  )!;
  const successCard = host.querySelector<HTMLButtonElement>(
    `[data-testid='select-${databaseHandleKey(handleB)}']`,
  )!;
  expect(errorCard.textContent).toContain("Import unfinished");
  expect(errorCard.textContent).toContain("unfinished.db3");
  expect(errorCard.parentElement!.querySelector("[data-reference-toggle]")).toBeNull();
  const toggle =
    successCard.parentElement!.querySelector<HTMLInputElement>("[data-reference-toggle]")!;
  expect(toggle.getAttribute("data-count")).toBe("1");
  expect(toggle.checked).toBe(false);
  await act(async () => toggle.click());
  expect(store.get(referenceDbAtom)).toEqual(handleB);
  expect(
    successCard.parentElement!.querySelector<HTMLInputElement>("[data-reference-toggle]")!.checked,
  ).toBe(true);
  await act(async () =>
    successCard.parentElement!.querySelector<HTMLInputElement>("[data-reference-toggle]")!.click(),
  );
  expect(store.get(referenceDbAtom)).toBeNull();
  await act(async () => errorCard.click());
  expect(buttonByText("Common.Delete")).toBeTruthy();
  expect(buttonByText("Databases.Settings.Explore")).toBeUndefined();
  expect(buttonByText("Databases.Settings.AddGames")).toBeUndefined();
  expect(host.querySelector("[aria-label='Databases.Settings.Indexed']")).toBeNull();
});

async function selectExistingDatabase() {
  await act(async () => {
    (
      host.querySelector(
        `[data-testid='select-${databaseHandleKey(handleB)}']`,
      ) as HTMLButtonElement
    ).click();
  });
  await vi.waitFor(() => expect(buttonByText("Databases.Settings.AddGames")).toBeTruthy());
}

async function startAddGames() {
  const before = mocks.convertPgn.mock.calls.length;
  await act(async () => buttonByText("Databases.Settings.AddGames")!.click());
  await vi.waitFor(() => expect(mocks.convertPgn.mock.calls.length).toBe(before + 1));
}

test("row Cancel forwards its exact conversion ticket, deduplicates pending clicks and survives navigation", async () => {
  let releaseCancel!: () => void;
  mocks.cancelConversion.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      releaseCancel = resolve;
    }),
  );
  await renderRoute();
  await selectExistingDatabase();
  const add = buttonByText("Databases.Settings.AddGames")!;
  await act(async () => {
    add.click();
    add.click();
  });
  await vi.waitFor(() => expect(convertCalls).toHaveLength(2));
  const first = activeOperation(0);
  const second = activeOperation(1);
  expect(convertCalls[0].args[5]).not.toBe(convertCalls[1].args[5]);
  const cancel = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Common.Cancel: more.pgn"]',
  )!;
  await act(async () => {
    cancel.click();
    cancel.click();
  });
  expect(mocks.cancelConversion).toHaveBeenCalledExactlyOnceWith(convertCalls[0].args[5]);
  expect(cancel.disabled).toBe(true);
  expect(conversionState().find((entry) => entry.id === first.id)?.cancelPending).toBe(true);
  expect(conversionState().find((entry) => entry.id === second.id)?.cancelPending).toBe(false);
  // The route disappears while accepted imports and their owning callbacks remain live.
  await act(async () =>
    root.render(
      <Provider store={store}>
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <div>Other route</div>
        </SWRConfig>
      </Provider>,
    ),
  );
  await renderRoute();
  expect(
    host.querySelector<HTMLButtonElement>('button[aria-label="Common.Cancel: more.pgn"]')!.disabled,
  ).toBe(true);
  await act(async () => releaseCancel());
  await act(async () => convertCalls[0].reject(new Error("Cancellation")));
  expect(conversionState().map((entry) => entry.id)).toEqual([second.id]);
  expect(mocks.deleteDatabase).not.toHaveBeenCalled();
  expect(mocks.notify).not.toHaveBeenCalled();
  await act(async () => convertCalls[1].resolve());
  expect(conversionState()).toEqual([]);
});

test("cancel request rejection reports once and the row permits retry while transaction success remains authoritative", async () => {
  await renderRoute();
  await selectExistingDatabase();
  await startAddGames();
  mocks.cancelConversion.mockRejectedValueOnce(new Error("request failed"));
  const cancel = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Common.Cancel: more.pgn"]',
  )!;
  await act(async () => cancel.click());
  expect(mocks.notify).toHaveBeenCalledOnce();
  expect(cancel.disabled).toBe(false);
  await act(async () => cancel.click());
  expect(mocks.cancelConversion).toHaveBeenCalledTimes(2);
  await act(async () => convertCalls[0].resolve());
  expect(mocks.deleteDatabase).not.toHaveBeenCalled();
  expect(conversionState()).toEqual([]);
});

test.each(["delete", "refresh", "both"])(
  "cancelled new import with %s failure remains visible and offers reload recovery",
  async (failure) => {
    await renderRoute();
    await startAddDatabase();
    const cancel = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Common.Cancel: PGN"]',
    )!;
    await act(async () => cancel.click());
    const unfinished = {
      type: "error",
      file: handleA,
      filename: "unfinished.db3",
      error: "Import unfinished",
      indexed: false,
    };
    if (failure !== "refresh")
      mocks.deleteDatabase.mockRejectedValueOnce(new Error("cleanup failed"));
    if (failure !== "delete") mocks.getDatabases.mockRejectedValue(new Error("reload failed"));
    else
      mocks.getDatabases.mockResolvedValue({
        databases: [unfinished],
        unread: [],
        root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
      });
    await act(async () => convertCalls[0].reject(new Error("Cancellation")));
    expect(conversionState()).toEqual([]);
    expect(mocks.deleteDatabase).toHaveBeenCalledExactlyOnceWith(handleA);
    expect(mocks.notify.mock.calls.map(([notice]) => notice.message)).toEqual(
      failure === "both"
        ? ["cleanup failed", "reload failed"]
        : [failure === "delete" ? "cleanup failed" : "reload failed"],
    );
    const retry = buttonByText("Databases.LoadRetry");
    expect(Boolean(retry)).toBe(failure !== "delete");
    expect(store.get(databaseConversionRefreshFailedAtom)).toBe(failure !== "delete");
    if (retry) {
      mocks.getDatabases.mockResolvedValue({
        databases: failure === "both" ? [unfinished] : [successDatabase(handleB, "Existing")],
        unread: [],
        root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
      });
      await act(async () => retry.click());
    }
    const unfinishedCard = host.querySelector<HTMLButtonElement>(
      `[data-testid='select-${databaseHandleKey(handleA)}']`,
    );
    if (unfinishedCard) {
      await act(async () => unfinishedCard.click());
    }
    expect(store.get(databaseConversionRefreshFailedAtom)).toBe(false);
    expect(
      Boolean(host.querySelector(`[data-testid='select-${databaseHandleKey(handleA)}']`)),
    ).toBe(failure !== "refresh");
    expect(Boolean(buttonByText("Common.Delete"))).toBe(failure !== "refresh");
    expect(buttonByText("Databases.Settings.Explore")).toBeUndefined();
  },
);

test.each(["new import", "add games"])(
  "a committed %s keeps its database after reload failure and Retry recovers",
  async (route) => {
    await renderRoute();
    if (route === "new import") await startAddDatabase();
    else {
      await selectExistingDatabase();
      await startAddGames();
    }
    const target = route === "new import" ? handleA : handleB;
    expect(convertCalls[0].args[2]).toEqual(target);
    mocks.getDatabases.mockRejectedValueOnce(new Error("reload denied at /private/import.db3"));
    await act(async () => convertCalls[0].resolve());

    expect(conversionState()).toEqual([]);
    expect(mocks.deleteDatabase).not.toHaveBeenCalled();
    expect(store.get(databaseConversionRefreshFailedAtom)).toBe(true);
    expect(mocks.logError).toHaveBeenCalledExactlyOnceWith(
      "Failed import database refresh failed: reload denied at [path]",
    );
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith({
      color: "danger",
      title: "Common.Error",
      message: "reload denied at [path]",
    });
    expect(Boolean(buttonByText("Databases.Settings.AddGames"))).toBe(route === "add games");
    expect(host.querySelector(`[data-testid='select-${databaseHandleKey(handleB)}']`)).toBeTruthy();
    const retry = buttonByText("Databases.LoadRetry")!;
    expect(retry).toBeTruthy();
    const refreshed = [successDatabase(handleB, "Existing")];
    if (route === "new import") refreshed.push(successDatabase(handleA, "Imported"));
    mocks.getDatabases.mockResolvedValue({
      databases: refreshed,
      unread: [],
      root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
    });
    await act(async () => retry.click());

    expect(store.get(databaseConversionRefreshFailedAtom)).toBe(false);
    expect(buttonByText("Databases.LoadRetry")).toBeUndefined();
    expect(host.querySelector(`[data-testid='select-${databaseHandleKey(target)}']`)).toBeTruthy();
    expect(mocks.getDatabases).toHaveBeenCalledTimes(5);
    expect(mocks.convertPgn).toHaveBeenCalledOnce();
    expect(mocks.deleteDatabase).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledOnce();
  },
);

test("an ordinary load Retry revalidates once without import recovery", async () => {
  mocks.getDatabases.mockRejectedValueOnce(new Error("initial listing failed"));
  await renderRoute();
  expect(store.get(databaseConversionRefreshFailedAtom)).toBe(false);
  expect(mocks.getDatabases).toHaveBeenCalledOnce();
  const retry = buttonByText("Databases.LoadRetry")!;
  expect(retry).toBeTruthy();

  await act(async () => retry.click());

  expect(mocks.getDatabases).toHaveBeenCalledTimes(2);
  expect(store.get(databaseConversionRefreshFailedAtom)).toBe(false);
  expect(buttonByText("Databases.LoadRetry")).toBeUndefined();
  expect(host.querySelector(`[data-testid='select-${databaseHandleKey(handleB)}']`)).toBeTruthy();
  expect(mocks.convertPgn).not.toHaveBeenCalled();
  expect(mocks.notify).not.toHaveBeenCalled();
});

async function startAccountDownload() {
  const before = mocks.convertPgn.mock.calls.length;
  const download = host.querySelector(
    'button[aria-label="Home.Accounts.DownloadGames"]',
  ) as HTMLButtonElement;
  await act(async () => download.click());
  await vi.waitFor(() => expect(mocks.convertPgn.mock.calls.length).toBe(before + 1));
}

test("submitting a local conversion disables Add before the workspace handle exists", async () => {
  let resolveCreate!: (handle: DatabaseHandle) => void;
  mocks.createWorkspaceDatabase.mockReturnValue(
    new Promise((resolve) => {
      resolveCreate = resolve;
    }),
  );
  await renderRoute();
  const pick = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("pick-pgn"),
  )!;
  await act(async () => pick.click());
  await act(async () => buttonByText("Databases.Add.Convert")!.click());

  await vi.waitFor(() => {
    expect(conversionState()).toHaveLength(1);
    expect(conversionState()[0]?.targetDatabase).toBeNull();
    expect(conversionState()[0]?.id).toBe("conversion:00000000-0000-4000-8000-000000000001");
  });
  expect(
    (host.querySelector('button[aria-label="Common.AddNew"]') as HTMLButtonElement).disabled,
  ).toBe(true);

  await act(async () => resolveCreate(handleA));
  await vi.waitFor(() => expect(convertCalls).toHaveLength(1));
  assertConversionCall(0);
});

test.each(
  [
    {
      route: "AddDatabase",
      account: false,
      target: handleA,
      title: "Local target",
      source: "PGN",
      startup: [startAddDatabase, selectExistingDatabase],
    },
    {
      route: "AccountCard native import",
      account: true,
      target: accountHandle,
      title: "Account target",
      source: "Felix_chesscom.pgn",
      startup: [selectExistingDatabase, startAccountDownload],
    },
  ].flatMap((route) => ["success", "failure"].map((outcome) => ({ ...route, outcome }))),
)(
  "$route $outcome removes only its own entry beside Add games",
  async ({ account, target, title, source, startup, outcome }) => {
    mocks.getDatabases.mockResolvedValue({
      databases: [successDatabase(target, title), successDatabase(handleB, "Existing")],
      unread: [],
      root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
    });
    await renderRoute(account);
    for (const step of startup) await step();
    assertConversionCall(0);
    const owner = activeOperation(0);
    expect(owner.targetDatabase).toEqual(target);

    await startAddGames();
    assertConversionCall(1);
    const games = activeOperation(1);
    expect(mocks.convertPgn).toHaveBeenCalledWith(
      games.id,
      [addGamesPgn],
      handleB,
      "",
      null,
      expect.stringMatching(/^conversion-ticket:/),
    );
    expect(conversionState().map((entry) => entry.targetDatabase)).toEqual([target, handleB]);
    expect(conversionRows()).toEqual([
      `Databases.Add.Convert: ${source}`,
      "Databases.Add.Convert: more.pgn",
    ]);
    expect(host.querySelector(`[data-testid='select-${databaseHandleKey(handleB)}']`)).toBeNull();
    expect(host.querySelector(`[data-testid='select-${databaseHandleKey(target)}']`)).toBeNull();
    expect(addNewDisabled()).toBe(true);

    await act(async () =>
      outcome === "success"
        ? convertCalls[0]?.resolve()
        : convertCalls[0]?.reject(new Error("convert failed")),
    );
    await vi.waitFor(() => {
      expect(conversionState()).toEqual([games]);
    });
    expect(conversionRows()).toEqual(["Databases.Add.Convert: more.pgn"]);
    expect(addNewDisabled()).toBe(true);

    await emitConvertProgress({
      id: games.id,
      imported_games: 42,
      elapsed_ms: 2000,
      source_file_name: "more.pgn",
    });
    expect(host.querySelector("output")?.getAttribute("data-total")).toBe("42");
    expect(host.querySelector("output")?.getAttribute("data-target")).toBe(
      databaseHandleKey(handleB),
    );
    expect(conversionRows()).toEqual([
      "Databases.Add.Convert: more.pgnFiles.GameCountSuffix:42 • 21.0 games/s",
    ]);
    expect(addNewDisabled()).toBe(true);
    await act(async () => convertCalls[1]?.resolve());
    expect(conversionState()).toEqual([]);
    expect(addNewDisabled()).toBe(false);
  },
);

test("AccountCard native import failure clears the conversion it owns", async () => {
  await renderRoute(true);
  const download = host.querySelector(
    'button[aria-label="Home.Accounts.DownloadGames"]',
  ) as HTMLButtonElement;
  await act(async () => download.click());
  await vi.waitFor(() => expect(mocks.convertPgn).toHaveBeenCalled());
  assertConversionCall(0);
  await act(async () => convertCalls[0]?.reject(new Error("convert failed")));
  await vi.waitFor(() => {
    expect(conversionState()).toEqual([]);
  });
  expect(mocks.notify).toHaveBeenCalledWith({
    color: "danger",
    title: "Common.Error",
    message: "convert failed",
  });
});

test("two Add games runs into the same target retain independent ids, frames and rows", async () => {
  await renderRoute();
  await selectExistingDatabase();
  // Two picker admissions before the target becomes conversion-ineligible still own separate jobs.
  await act(async () => {
    const add = buttonByText("Databases.Settings.AddGames")!;
    add.click();
    add.click();
  });
  await vi.waitFor(() => expect(mocks.convertPgn).toHaveBeenCalledTimes(2));
  assertConversionCall(0);
  const first = activeOperation(0);
  expect(buttonByText("Databases.Settings.AddGames")).toBeUndefined();
  assertConversionCall(1);
  const second = activeOperation(1);
  expect(first.id).not.toBe(second.id);
  expect(conversionState().map((entry) => entry.id)).toEqual([first.id, second.id]);
  expect(conversionState().map((entry) => entry.targetDatabase)).toEqual([handleB, handleB]);
  await emitConvertProgress({
    id: first.id,
    imported_games: 20,
    elapsed_ms: 2000,
    source_file_name: "first.pgn",
  });
  await emitConvertProgress({
    id: second.id,
    imported_games: 42,
    elapsed_ms: 3000,
    source_file_name: "second.pgn",
  });
  expect(conversionRows()).toEqual([
    "Databases.Add.Convert: first.pgnFiles.GameCountSuffix:20 • 10.0 games/s",
    "Databases.Add.Convert: second.pgnFiles.GameCountSuffix:42 • 14.0 games/s",
  ]);
  const survivor = activeOperation(1);
  await act(async () => convertCalls[0]?.resolve());
  expect(conversionState()).toEqual([survivor]);
  expect(conversionRows()).toEqual([
    "Databases.Add.Convert: second.pgnFiles.GameCountSuffix:42 • 14.0 games/s",
  ]);
  expect(addNewDisabled()).toBe(true);
  expect(buttonByText("Databases.Add.Convert")?.disabled).toBe(true);
  await emitConvertProgress({
    id: second.id,
    imported_games: 60,
    elapsed_ms: 4000,
    source_file_name: null,
  });
  expect(conversionRows()).toEqual([
    "Databases.Add.Convert: second.pgnFiles.GameCountSuffix:60 • 15.0 games/s",
  ]);
  await act(async () => convertCalls[1]?.resolve());
  expect(conversionState()).toEqual([]);
  expect(conversionRows()).toEqual([]);
  expect(addNewDisabled()).toBe(false);
});

test.each(
  (["local", "account"] as const).flatMap((route) =>
    (["success", "failure"] as const).map((outcome) => ({ route, outcome })),
  ),
)(
  "Add games $outcome leaves the concurrent $route operation visible",
  async ({ route, outcome }) => {
    await renderRoute(route === "account");
    await selectExistingDatabase();
    if (route === "local") await startAddDatabase();
    else await startAccountDownload();
    assertConversionCall(0);
    const owner = activeOperation(0);
    await startAddGames();
    assertConversionCall(1);
    expect(conversionRows()).toHaveLength(2);
    await act(async () =>
      outcome === "success"
        ? convertCalls[1]?.resolve()
        : convertCalls[1]?.reject(new Error("convert failed")),
    );
    expect(conversionState()).toEqual([owner]);
    expect(conversionRows()).toEqual([`Databases.Add.Convert: ${owner.sourceFileName}`]);
    expect(addNewDisabled()).toBe(true);
    await emitConvertProgress({
      id: owner.id,
      imported_games: 30,
      elapsed_ms: 2000,
      source_file_name: "survivor.pgn",
    });
    expect(conversionRows()).toEqual([
      "Databases.Add.Convert: survivor.pgnFiles.GameCountSuffix:30 • 15.0 games/s",
    ]);
    await act(async () => convertCalls[0]?.resolve());
    expect(conversionState()).toEqual([]);
  },
);

test.each(["create", "native progress"] as const)(
  "%s failure before convertPgn removes only its registered entry",
  async (stage) => {
    let rejectSetup: ((error: unknown) => void) | undefined;
    const setup = new Promise((_resolve, reject) => {
      rejectSetup = reject;
    });
    if (stage === "create") mocks.createWorkspaceDatabase.mockReturnValue(setup);
    else mocks.beginNativeImport.mockReturnValue(setup);
    await renderRoute(stage === "native progress");
    await selectExistingDatabase();
    if (stage === "create") {
      const pick = [...host.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("pick-pgn"),
      );
      await act(async () => pick?.click());
      await act(async () => buttonByText("Databases.Add.Convert")?.click());
    } else {
      const download = host.querySelector<HTMLButtonElement>(
        'button[aria-label="Home.Accounts.DownloadGames"]',
      );
      await act(async () => download?.click());
    }
    await vi.waitFor(() => expect(conversionState()).toHaveLength(1));
    expect(mocks.convertPgn).not.toHaveBeenCalled();
    expect(addNewDisabled()).toBe(true);
    await startAddGames();
    assertConversionCall(0);
    const games = activeOperation(0);
    expect(conversionRows()).toHaveLength(2);
    if (!rejectSetup) throw new Error("Setup did not start");
    await act(async () => rejectSetup?.(new Error("setup failed")));
    expect(mocks.convertPgn).toHaveBeenCalledTimes(1);
    expect(conversionState()).toEqual([games]);
    expect(conversionRows()).toEqual(["Databases.Add.Convert: more.pgn"]);
    expect(addNewDisabled()).toBe(true);
    await act(async () => convertCalls[0]?.resolve());
    expect(conversionState()).toEqual([]);
  },
);

async function waitForSettingsDebounce() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
}

async function editDatabaseSetting(
  labelText: string,
  elementType: "input" | "textarea",
  value: string,
) {
  const label = [...host.querySelectorAll("label")]
    .filter((element) => element.textContent === labelText)
    .at(-1)!;
  const input = label.querySelector(elementType)!;
  const prototype =
    elementType === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(input.value).toBe(value);
}

test("selecting an existing database does not write its settings", async () => {
  await renderRoute();
  await selectExistingDatabase();
  await waitForSettingsDebounce();
  expect(mocks.editDbInfo).not.toHaveBeenCalled();
});

test("editing the database name writes once after the debounce and reloads the list", async () => {
  let database = successDatabase(handleB, "Existing");
  mocks.getDatabases.mockImplementation(async () => ({
    databases: [database],
    unread: [],
    root: workspaceRoot,
  }));
  mocks.editDbInfo.mockImplementation(async (_file: DatabaseHandle, title: string) => {
    database = { ...database, title };
  });
  await renderRoute();
  await selectExistingDatabase();
  await editDatabaseSetting("Common.Name", "input", "Renamed");
  expect(mocks.editDbInfo).not.toHaveBeenCalled();

  await waitForSettingsDebounce();
  expect(mocks.editDbInfo).toHaveBeenCalledExactlyOnceWith(handleB, "Renamed", "");
  expect(mocks.getDatabases).toHaveBeenCalledTimes(2);
});

test("editing only the database description writes once after the debounce with the unchanged title", async () => {
  let database = successDatabase(handleB, "Existing");
  mocks.getDatabases.mockImplementation(async () => ({
    databases: [database],
    unread: [],
    root: workspaceRoot,
  }));
  mocks.editDbInfo.mockImplementation(
    async (_file: DatabaseHandle, _title: string, description: string) => {
      database = { ...database, description };
    },
  );
  await renderRoute();
  await selectExistingDatabase();
  await editDatabaseSetting("Common.Description", "textarea", "Updated description");
  expect(mocks.editDbInfo).not.toHaveBeenCalled();

  await waitForSettingsDebounce();
  expect(mocks.editDbInfo).toHaveBeenCalledExactlyOnceWith(
    handleB,
    "Existing",
    "Updated description",
  );
  expect(mocks.getDatabases).toHaveBeenCalledTimes(2);
});

test("clearing the database name does not write an empty title", async () => {
  await renderRoute();
  await selectExistingDatabase();
  await editDatabaseSetting("Common.Name", "input", "");
  await waitForSettingsDebounce();
  expect(mocks.editDbInfo).not.toHaveBeenCalled();
});

test("a failed database rename surfaces an error notification", async () => {
  await renderRoute();
  await selectExistingDatabase();
  mocks.editDbInfo.mockRejectedValueOnce(new Error("rename failed"));
  await editDatabaseSetting("Common.Name", "input", "Renamed");
  await waitForSettingsDebounce();
  expect(mocks.notify).toHaveBeenCalledExactlyOnceWith({
    color: "danger",
    title: "Common.Error",
    message: "rename failed",
  });
});

test.each(
  (
    [
      ["Databases.Settings.RemoveEmpty", mocks.deleteEmptyGames],
      ["Databases.Settings.RemoveDup", mocks.deleteDuplicatedGames],
    ] as const
  ).flatMap(([label, action]) =>
    (["successful", "failed"] as const).map((outcome) => ({ label, action, outcome })),
  ),
)(
  "a $outcome $label cleanup reloads the list and reports only errors",
  async ({ label, action, outcome }) => {
    let resolveCleanup!: () => void;
    let rejectCleanup!: (error: unknown) => void;
    action.mockReturnValueOnce(
      new Promise<void>((resolve, reject) => {
        resolveCleanup = resolve;
        rejectCleanup = reject;
      }),
    );
    await renderRoute();
    await selectExistingDatabase();
    const reloads = mocks.getDatabases.mock.calls.length;
    const button = buttonByText(label)!;
    await act(async () => button.click());
    expect(action).toHaveBeenCalledExactlyOnceWith(handleB);
    expect(button.getAttribute("data-loading")).toBe("true");
    if (outcome === "failed") {
      await act(async () => rejectCleanup(new Error("cleanup failed")));
    } else {
      await act(async () => resolveCleanup());
    }
    expect(buttonByText(label)?.getAttribute("data-loading")).toBeNull();
    expect(mocks.notify.mock.calls).toEqual(
      outcome === "failed"
        ? [[{ color: "danger", title: "Common.Error", message: "cleanup failed" }]]
        : [],
    );
    expect(mocks.getDatabases).toHaveBeenCalledTimes(reloads + 1);
  },
);

test("a failed player merge surfaces an error notification", async () => {
  await renderRoute();
  await selectExistingDatabase();
  await act(async () => {
    buttonByText("Databases.Player.One")!.click();
    buttonByText("Databases.Player.Two")!.click();
  });
  mocks.mergePlayers.mockRejectedValueOnce(new Error("merge failed"));
  await act(async () => buttonByText("Databases.Settings.Merge")!.click());

  expect(mocks.mergePlayers).toHaveBeenCalledExactlyOnceWith(handleB, 1, 2);
  expect(mocks.notify).toHaveBeenCalledExactlyOnceWith({
    color: "danger",
    title: "Common.Error",
    message: "merge failed",
  });
});

function indexCheckbox() {
  return host.querySelector<HTMLInputElement>('[aria-label="Databases.Settings.Indexed"]')!;
}

test.each([
  { outcome: "failed", indexed: false },
  { outcome: "successful", indexed: false },
  { outcome: "successful", indexed: true },
] as const)(
  "a $outcome index toggle from indexed=$indexed re-enables the checkbox",
  async ({ outcome, indexed }) => {
    const database = { ...successDatabase(handleB, "Existing"), indexed };
    mocks.getDatabases.mockResolvedValue({
      databases: [database],
      unread: [],
      root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
    });
    const action = indexed ? mocks.deleteIndexes : mocks.createIndexes;
    const otherAction = indexed ? mocks.createIndexes : mocks.deleteIndexes;
    let resolveIndex!: () => void;
    let rejectIndex!: (error: unknown) => void;
    action.mockReturnValueOnce(
      new Promise<void>((resolve, reject) => {
        resolveIndex = resolve;
        rejectIndex = reject;
      }),
    );
    await renderRoute();
    await selectExistingDatabase();
    const reloads = mocks.getDatabases.mock.calls.length;
    const checkbox = indexCheckbox();
    expect(checkbox.checked).toBe(indexed);
    expect(checkbox.disabled).toBe(false);
    await act(async () => checkbox.click());
    expect(action).toHaveBeenCalledExactlyOnceWith(handleB);
    expect(otherAction).not.toHaveBeenCalled();
    expect(checkbox.disabled).toBe(true);
    expect(mocks.getDatabases).toHaveBeenCalledTimes(reloads);

    if (outcome === "failed") {
      await act(async () => rejectIndex(new Error("index failed")));
    } else {
      mocks.getDatabases.mockResolvedValue({
        databases: [{ ...database, indexed: !indexed }],
        unread: [],
        root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
      });
      await act(async () => resolveIndex());
    }
    expect(mocks.getDatabases).toHaveBeenCalledTimes(reloads + (outcome === "failed" ? 0 : 1));
    const reloadOptions = { signal: expect.any(AbortSignal) };
    expect(mocks.getDatabases.mock.calls.slice(reloads)).toEqual(
      outcome === "failed" ? [] : [[reloadOptions]],
    );
    expect(indexCheckbox().checked).toBe(outcome === "failed" ? indexed : !indexed);
    expect(mocks.notify.mock.calls).toEqual(
      outcome === "failed"
        ? [[{ color: "danger", title: "Common.Error", message: "index failed" }]]
        : [],
    );
    expect(indexCheckbox().disabled).toBe(false);
  },
);
