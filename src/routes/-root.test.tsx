import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initializePathOwners: vi.fn(),
  startupLegacyDeckScanComplete: vi.fn(),
  ensureMigration: vi.fn(),
  runMigration: vi.fn(),
  retireMigratedKeys: vi.fn(),
  fileRevision: vi.fn(),
  windowFocus: vi.fn(),
}));

vi.mock("@/state/pathOwners", () => ({
  initializePathOwners: mocks.initializePathOwners,
  startupLegacyDeckScanComplete: mocks.startupLegacyDeckScanComplete,
}));
vi.mock("@/state/practiceStorage", () => ({
  ensurePracticeMigration: mocks.ensureMigration,
  runPracticeMigrationPass: mocks.runMigration,
  retireMigratedLegacyDeckKeysFromBrowser: mocks.retireMigratedKeys,
}));
vi.mock("@/state/atoms", () => ({ nativeBarAtom: {}, tabsAtom: {} }));
vi.mock("@/state/keybinds", () => ({ keyMapAtom: {} }));
vi.mock("@/platform/native", () => ({
  Menu: {},
  MenuItem: {},
  PredefinedMenuItem: {},
  Submenu: {},
  ask: vi.fn(),
  exit: vi.fn(),
  error: vi.fn().mockResolvedValue(undefined),
  warn: vi.fn().mockResolvedValue(undefined),
  getCurrentWindow: vi.fn(),
  getCurrentWebviewWindow: vi.fn(() => ({
    destroy: vi.fn(),
    onCloseRequested: async () => () => undefined,
  })),
  platform: vi.fn(() => "linux"),
}));
vi.mock("@/platform/tauri", () => ({
  tauri: {
    openAppLog: vi.fn(),
    openDocumentation: vi.fn(),
    fileRevision: mocks.fileRevision,
  },
  tauriSubscriptions: { windowFocus: mocks.windowFocus },
}));
vi.mock("@/components/About", () => ({ default: () => null }));
vi.mock("@/components/Sidebar", () => ({ SideBar: () => null }));
vi.mock("@/components/TopBar", () => ({ default: () => null }));
vi.mock("@/components/tabs/QuitConfirmModal", () => ({ default: () => null }));
vi.mock("@/utils/files", () => ({ openFile: vi.fn(), pickPgnFile: vi.fn() }));
vi.mock("@mantine/core", () => ({ AppShell: {} }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  Outlet: () => null,
  createRootRouteWithContext: () => (options: unknown) => options,
  useNavigate: () => vi.fn(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { clearSavedDataAfterConfirmation, startRootFileFreshnessPoll } from "./__root";
import { clearSavedDataFromMenu } from "./-appMenu";
import type { Tab } from "@/utils/tabs";

beforeEach(() => {
  mocks.initializePathOwners.mockReset().mockResolvedValue(undefined);
  mocks.startupLegacyDeckScanComplete.mockReset().mockReturnValue(true);
  mocks.ensureMigration.mockReset().mockResolvedValue({});
  mocks.runMigration.mockReset();
  mocks.retireMigratedKeys.mockReset();
  mocks.fileRevision.mockReset().mockResolvedValue("dev:ino:revision");
  mocks.windowFocus.mockReset().mockResolvedValue(vi.fn());
});

async function clearThroughProductionPath(
  result: unknown,
  clear: () => void | Promise<void>,
): Promise<void> {
  mocks.runMigration.mockResolvedValue(result);
  await clearSavedDataFromMenu({
    ask: async () => true,
    confirmMessage: "confirm",
    title: "title",
    clear: () =>
      clearSavedDataAfterConfirmation({
        blockedMessage: (decks) => `blocked: ${decks.join(", ")}`,
        clear,
      }),
  });
}

test("the production clear path refuses after a failed migration", async () => {
  const clear = vi.fn();
  const outcomes = [
    {
      key: "deck-failed-0",
      identity: { file: "failed", game: 0 },
      status: "failed",
    },
  ];

  await expect(
    clearThroughProductionPath(
      {
        outcomes,
        inventory: { decks: [], anomalies: [] },
        scanTrusted: true,
        inventoryTrusted: true,
      },
      clear,
    ),
  ).rejects.toThrow("failed (0)");
  expect(mocks.retireMigratedKeys).toHaveBeenCalledExactlyOnceWith(outcomes);
  expect(clear).not.toHaveBeenCalled();
});

test("the production clear path refuses when inventory reports a damaged deck", async () => {
  const clear = vi.fn();

  await expect(
    clearThroughProductionPath(
      {
        outcomes: [],
        inventory: {
          decks: [],
          anomalies: [{ kind: "OrphanShard", leaf: "orphan", fileId: "damaged", game: 2 }],
        },
        scanTrusted: true,
        inventoryTrusted: true,
      },
      clear,
    ),
  ).rejects.toThrow("damaged (2)");
  expect(clear).not.toHaveBeenCalled();
});

test("the production clear path does not name a repaired native deck", async () => {
  const clear = vi.fn();
  const outcomes = [
    {
      key: "deck-repaired-0",
      identity: { file: "repaired", game: 0 },
      status: "migrated",
    },
  ];

  await clearThroughProductionPath(
    {
      outcomes,
      inventory: {
        decks: [{ fileId: "repaired", game: 0 }],
        anomalies: [],
      },
      scanTrusted: true,
      inventoryTrusted: true,
    },
    clear,
  );

  expect(clear).toHaveBeenCalledOnce();
  expect(mocks.retireMigratedKeys).toHaveBeenCalledExactlyOnceWith(outcomes);
});

test("the production clear path waits for migration and runs a fresh pass before clearing", async () => {
  const migration = deferred<void>();
  const clear = vi.fn();
  mocks.ensureMigration.mockReturnValueOnce(migration.promise);
  mocks.runMigration.mockResolvedValueOnce({
    outcomes: [],
    inventory: { decks: [], anomalies: [] },
    scanTrusted: true,
    inventoryTrusted: true,
  });

  const clearing = clearSavedDataFromMenu({
    ask: async () => true,
    confirmMessage: "confirm",
    title: "title",
    clear: () =>
      clearSavedDataAfterConfirmation({
        blockedMessage: (decks) => `blocked: ${decks.join(", ")}`,
        clear,
      }),
  });
  await Promise.resolve();
  expect(clear).not.toHaveBeenCalled();
  expect(mocks.runMigration).not.toHaveBeenCalled();

  migration.resolve();
  await clearing;
  expect(mocks.runMigration).toHaveBeenCalledOnce();
  expect(clear).toHaveBeenCalledOnce();
});

test("the production clear path waits for path owners before migrating and retiring", async () => {
  const initialization = deferred<void>();
  const clear = vi.fn();
  const outcomes = [
    {
      key: "deck-migrated-0",
      identity: { file: "migrated", game: 0 },
      status: "migrated",
    },
  ];
  mocks.initializePathOwners.mockReturnValueOnce(initialization.promise);
  mocks.runMigration.mockResolvedValueOnce({
    outcomes,
    inventory: { decks: [], anomalies: [] },
    scanTrusted: true,
    inventoryTrusted: true,
  });

  const clearing = clearSavedDataAfterConfirmation({
    blockedMessage: (decks) => `blocked: ${decks.join(", ")}`,
    clear,
  });
  expect(mocks.initializePathOwners).toHaveBeenCalledOnce();
  expect(mocks.ensureMigration).not.toHaveBeenCalled();
  expect(mocks.runMigration).not.toHaveBeenCalled();
  expect(mocks.retireMigratedKeys).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();

  initialization.resolve();
  await clearing;

  expect(mocks.runMigration).toHaveBeenCalledOnce();
  expect(mocks.retireMigratedKeys).toHaveBeenCalledExactlyOnceWith(outcomes);
  expect(clear).toHaveBeenCalledOnce();
});

test("the production clear path still refuses failed migration when path owners reject", async () => {
  const clear = vi.fn();
  mocks.initializePathOwners.mockRejectedValueOnce(new Error("path owners failed"));

  await expect(
    clearThroughProductionPath(
      {
        outcomes: [
          {
            key: "deck-migrated-0",
            identity: { file: "migrated", game: 0 },
            status: "migrated",
          },
          {
            key: "deck-failed-0",
            identity: { file: "failed", game: 0 },
            status: "failed",
          },
        ],
        inventory: { decks: [], anomalies: [] },
        scanTrusted: true,
        inventoryTrusted: true,
      },
      clear,
    ),
  ).rejects.toThrow("blocked: failed (0)");

  expect(mocks.ensureMigration).toHaveBeenCalledOnce();
  expect(mocks.runMigration).toHaveBeenCalledOnce();
  expect(mocks.retireMigratedKeys).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
});

test("the production clear path clears clean migration without retirement when path owners reject", async () => {
  const clear = vi.fn();
  mocks.initializePathOwners.mockRejectedValueOnce(new Error("path owners failed"));

  await clearThroughProductionPath(
    {
      outcomes: [
        {
          key: "deck-migrated-0",
          identity: { file: "migrated", game: 0 },
          status: "migrated",
        },
      ],
      inventory: { decks: [], anomalies: [] },
      scanTrusted: true,
      inventoryTrusted: true,
    },
    clear,
  );

  expect(mocks.ensureMigration).toHaveBeenCalledOnce();
  expect(mocks.runMigration).toHaveBeenCalledOnce();
  expect(mocks.retireMigratedKeys).not.toHaveBeenCalled();
  expect(clear).toHaveBeenCalledOnce();
});

test("the root poll follows current file tabs, listens for focus, and stops its resources", async () => {
  vi.useFakeTimers();
  const handle = { id: { id: "root-poll-file" }, kind: "fileWorkspace" as const };
  const tab = {
    value: "root-poll-tab",
    gameOrigin: { kind: "file", file: { handle }, gameNumber: 0 },
  } as Tab;
  const getTabs = vi.fn(() => [tab]);
  const unsubscribe = vi.fn();
  let onFocus: (() => void) | undefined;
  mocks.windowFocus.mockImplementation(async (callback: () => void) => {
    onFocus = callback;
    return unsubscribe;
  });

  const stop = startRootFileFreshnessPoll(getTabs);
  await Promise.resolve();
  onFocus?.();
  await Promise.resolve();
  await Promise.resolve();

  expect(mocks.fileRevision).toHaveBeenCalledWith(handle, {
    signal: expect.any(AbortSignal),
  });
  expect(getTabs).toHaveBeenCalled();
  expect(mocks.windowFocus).toHaveBeenCalledOnce();

  stop();
  expect(unsubscribe).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(mocks.fileRevision).toHaveBeenCalledOnce();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
