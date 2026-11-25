import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  WorkspaceSessionFixedLeaves,
  WorkspaceSessionNames,
  WorkspaceSessionReadEntry,
} from "@/bindings";
import { RESTORE_OPEN_TABS_KEY } from "@/state/restoreOpenTabs";
import { serializeStorageValue } from "@/state/store/debouncedStorage";
import { TREE_STORAGE_VERSION } from "@/state/store/tabStorage";
import type { Workspace } from "@/state/workspace";
import type { Tab } from "@/state/workspaceTypes";
import { defaultTree } from "@/utils/treeReducer";

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  createRoot: vi.fn(),
  reconcileStartupPathOwners: vi.fn(),
  readWorkspaceSessionFixed: vi.fn<() => Promise<WorkspaceSessionFixedLeaves>>(),
  readWorkspaceSessionLeaves: vi.fn<(keys: string[]) => Promise<WorkspaceSessionReadEntry[]>>(),
  listWorkspaceSessionNames: vi.fn<() => Promise<WorkspaceSessionNames>>(),
  releasePreviousDocumentOperations: vi.fn().mockResolvedValue(null),
  initializePersistedSessions: vi.fn().mockResolvedValue(undefined),
  initializeI18n: vi.fn().mockResolvedValue(undefined),
  initializeDownloadFailures: vi.fn().mockResolvedValue(undefined),
  initializeEngineCompletions: vi.fn().mockResolvedValue(undefined),
  logFailureSafely: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("react-dom/client", () => ({
  createRoot: (...args: unknown[]) => {
    mocks.createRoot(...args);
    return { render: mocks.render };
  },
}));
vi.mock("@/App", () => ({ default: () => null }));
vi.mock("@/i18n", () => ({ default: {}, initializeI18n: mocks.initializeI18n }));
vi.mock("react-i18next", () => ({
  I18nextProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/utils/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/session")>()),
  initializePersistedSessions: mocks.initializePersistedSessions,
}));
vi.mock("@/hooks/downloadJobs", () => ({
  initializeDownloadFailures: mocks.initializeDownloadFailures,
}));
vi.mock("@/state/engineCompletions", () => ({
  initializeEngineCompletions: mocks.initializeEngineCompletions,
}));
vi.mock("@/platform/native", () => ({
  warn: vi.fn().mockResolvedValue(undefined),
  error: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/platform/errors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/errors")>()),
  logFailureSafely: mocks.logFailureSafely,
}));
vi.mock("@/platform/tauri", () => ({
  tauri: {
    releasePreviousDocumentOperations: mocks.releasePreviousDocumentOperations,
    reconcileStartupPathOwners: mocks.reconcileStartupPathOwners,
    reconcileStartupEngineAttachments: vi.fn().mockResolvedValue(null),
    practiceEpoch: vi.fn().mockResolvedValue("epoch-1"),
    listPracticeDecks: vi.fn().mockResolvedValue({ decks: [], anomalies: [] }),
    readWorkspaceSessionFixed: mocks.readWorkspaceSessionFixed,
    readWorkspaceSessionLeaves: mocks.readWorkspaceSessionLeaves,
    listWorkspaceSessionNames: mocks.listWorkspaceSessionNames,
    quarantineWorkspaceSessionLeaves: vi.fn().mockResolvedValue({
      bucket: null,
      moved: [],
      failed: [],
    }),
    writeWorkspaceSessionLeaf: vi.fn().mockResolvedValue(null),
    removeWorkspaceSessionLeaf: vi.fn().mockResolvedValue(null),
    clearWorkspaceSession: vi.fn().mockResolvedValue([]),
    closeSplashscreen: vi.fn().mockResolvedValue(undefined),
  },
}));

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  localStorage.clear();
  sessionStorage.clear();
  vi.resetModules();
  mocks.render.mockClear();
  mocks.createRoot.mockClear();
  mocks.reconcileStartupPathOwners.mockReset().mockResolvedValue(null);
  mocks.readWorkspaceSessionFixed.mockReset();
  mocks.readWorkspaceSessionLeaves.mockReset();
  mocks.listWorkspaceSessionNames.mockReset();
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

test("startApplication seeds durable file and database tabs before path-owner snapshotting and reports both refs to reconcileStartupPathOwners", async () => {
  const fileTabId = crypto.randomUUID();
  const dbTabId = crypto.randomUUID();
  const fileTab: Tab = {
    value: fileTabId,
    name: "repertoire.pgn",
    type: "analysis",
    gameOrigin: {
      kind: "file",
      file: {
        type: "file",
        handle: { id: { id: "file-ref-from-store" }, kind: "fileWorkspace" },
        name: "repertoire.pgn",
        numGames: 1,
        metadata: { type: "game", tags: [] },
        lastModified: 1,
      },
      gameNumber: 0,
    },
  };
  const dbTab: Tab = {
    value: dbTabId,
    name: "master.db3",
    type: "analysis",
    gameOrigin: {
      kind: "database",
      database: { id: { id: "db-ref-from-store" }, kind: "database" },
      gameId: 7,
    },
  };
  const ws: Workspace = { version: 1, tabs: [fileTab, dbTab], activeTab: fileTabId };
  const tree = serializeStorageValue({ version: TREE_STORAGE_VERSION, state: defaultTree() });

  // Place a legacy key that initializeRendererState() scrubs; verifying it is still present
  // when readWorkspaceSessionFixed runs proves reading the preference did not initialize
  // rendererState or snapshot path owners before seeding.
  localStorage.setItem(RESTORE_OPEN_TABS_KEY, "true");
  localStorage.setItem("telemetry-enabled", "true");

  let telemetryPresentDuringRestore = false;
  mocks.readWorkspaceSessionFixed.mockImplementation(async () => {
    telemetryPresentDuringRestore = localStorage.getItem("telemetry-enabled") === "true";
    return {
      workspace: { kind: "record", content: serializeStorageValue(ws) },
      pageTabs: { kind: "absent" },
    };
  });
  mocks.listWorkspaceSessionNames.mockResolvedValue({ names: [fileTabId, dbTabId], omitted: 0 });
  mocks.readWorkspaceSessionLeaves.mockResolvedValue([
    { key: fileTabId, state: { kind: "record", content: tree } },
    { key: dbTabId, state: { kind: "record", content: tree } },
  ]);

  const { startApplication } = await import("@/bootstrap");
  const { workspaceStartedFresh } = await import("@/state/atoms/tabs");
  await startApplication();

  expect(telemetryPresentDuringRestore).toBe(true);
  expect(localStorage.getItem("telemetry-enabled")).toBeNull();
  expect(workspaceStartedFresh()).toBe(true);
  expect(mocks.reconcileStartupPathOwners).toHaveBeenCalledOnce();
  const [owners] = mocks.reconcileStartupPathOwners.mock.calls[0] as [
    { retainedIds: Array<{ id: string }>; trustedFamilies: string[] },
  ];
  const retainedIds = owners.retainedIds.map((entry) => entry.id);
  expect(retainedIds).toContain("file-ref-from-store");
  expect(retainedIds).toContain("db-ref-from-store");
  expect(owners.trustedFamilies).toContain("sessionWorkspace");
  expect(mocks.render).toHaveBeenCalledOnce();
});
