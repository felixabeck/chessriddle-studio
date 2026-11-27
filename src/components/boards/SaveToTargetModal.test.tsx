import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { StoreApi } from "zustand";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FileMetadata } from "@/components/files/file";
import { useWorkspaceListing } from "@/components/library/useWorkspaceListing";
import { useDatabaseList } from "@/hooks/useDatabaseList";
import { fileWorkspaceAtom } from "@/state/atoms";
import type { TreeStoreState } from "@/state/store/tree";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import type { SuccessDatabaseInfo } from "@/utils/db";
import { saveToDatabase, saveToFile, saveToLibraryFile, type Tab } from "@/utils/tabs";
import SaveToTargetModal from "./SaveToTargetModal";

vi.mock("@/hooks/useDatabaseList", () => ({ useDatabaseList: vi.fn() }));
vi.mock("@/components/library/useWorkspaceListing", () => ({
  useWorkspaceListing: vi.fn(),
}));
vi.mock("@/utils/tabs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/tabs")>();
  return {
    ...actual,
    useTabActions: () => ({ getTab: vi.fn(), updateTab: vi.fn() }),
    saveToFile: vi.fn(),
    saveToDatabase: vi.fn(),
    saveToLibraryFile: vi.fn(),
  };
});
vi.mock("@/components/common/AppModal", async () => ({
  default: (await import("@/tests/appModal")).PendingAppModal,
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();
let host: HTMLDivElement;
let root: Root;
function emptyListing() {
  return {
    data: undefined,
    error: undefined,
    isLoading: false,
    mutate: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useWorkspaceListing).mockReturnValue(
    emptyListing() as unknown as ReturnType<typeof useWorkspaceListing>,
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

const workspace = { id: { id: "library" }, kind: "fileWorkspace" as const };

const repertoireFile: FileMetadata = {
  type: "file",
  handle: { id: { id: "collection-file" }, kind: "fileWorkspace" },
  name: "Caro Kann",
  numGames: 3,
  metadata: { type: "repertoire", tags: [] },
  lastModified: 1,
};

const otherFile: FileMetadata = {
  type: "file",
  handle: { id: { id: "other-file" }, kind: "fileWorkspace" },
  name: "Games",
  numGames: 1,
  metadata: { type: "game", tags: [] },
  lastModified: 2,
};

async function renderModal(
  onClose: () => void = vi.fn(),
  libraryWorkspace: typeof workspace | null = null,
  tab: Tab | undefined = undefined,
) {
  const jotai = createStore();
  jotai.set(fileWorkspaceAtom, libraryWorkspace);
  await act(async () =>
    root.render(
      <Provider store={jotai}>
        <MantineProvider env="test">
          <SaveToTargetModal
            opened
            onClose={onClose}
            tab={tab}
            store={{} as StoreApi<TreeStoreState>}
          />
        </MantineProvider>
      </Provider>,
    ),
  );
}

const readyTarget: SuccessDatabaseInfo = {
  type: "success",
  file: { id: { id: "database" }, kind: "database" },
  filename: "games.db3",
  title: "Ready database",
  description: "",
  player_count: 0,
  event_count: 0,
  game_count: 0,
  storage_size: "0",
  indexed: false,
  collection: {
    id: "collection",
    name: "Games",
    file: { id: { id: "collection-file" }, kind: "fileWorkspace" },
    database: { id: { id: "database" }, kind: "database" },
    account: null,
    status: "ready",
    generation: "generation",
    omitted: 0,
    retiredDatabase: null,
    fetchSinceMs: null,
  },
};

async function selectReadyTarget(onClose: () => void) {
  const mutate = vi.fn().mockResolvedValue(undefined);
  vi.mocked(useDatabaseList).mockReturnValue({
    data: {
      databases: [readyTarget],
      unread: [],
      root: { id: { id: "root" }, kind: "databaseRoot" },
    },
    error: undefined,
    isLoading: false,
    mutate,
  } as unknown as ReturnType<typeof useDatabaseList>);
  await renderModal(onClose);
  await act(async () => host.querySelector("input")!.click());
  const option = document.querySelector<HTMLElement>('[role="option"]')!;
  expect(option.textContent).toBe(readyTarget.title);
  await act(async () => option.click());
  expect(host.querySelector("input")?.value).toBe(readyTarget.title);
  return mutate;
}

function saveButton() {
  return Array.from(host.querySelectorAll("button")).find(
    (button) => button.textContent === "Common.Save",
  )!;
}

function noTargetsAlert() {
  return [...host.querySelectorAll('[role="alert"]')].find(
    (alert) => alert.textContent === "Board.Database.NoTargets",
  );
}

function deferredSave() {
  let resolve!: (value: Awaited<ReturnType<typeof saveToDatabase>>) => void;
  const promise = new Promise<Awaited<ReturnType<typeof saveToDatabase>>>((resolvePromise) => {
    resolve = resolvePromise;
  });
  vi.mocked(saveToDatabase).mockReturnValue(promise);
  return { resolve };
}

test("pending save prevents dismissal and repeated saves, then completes once and clears pending", async () => {
  const save = deferredSave();
  const onClose = vi.fn();
  const mutate = await selectReadyTarget(onClose);
  const button = saveButton();
  expect(button.disabled).toBe(false);

  await act(async () => {
    button.click();
    button.click();
  });

  expect(saveToDatabase).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ database: readyTarget.file }),
  );
  expect(host.querySelector('[role="dialog"]')?.getAttribute("data-pending")).toBe("true");
  expect(host.querySelector('[aria-label="Close dialog"]')).toBeNull();
  expect(host.querySelector("input")?.disabled).toBe(true);
  expect(button.hasAttribute("data-loading")).toBe(true);
  expect(button.disabled).toBe(true);
  expect(
    Array.from(host.querySelectorAll("button")).find((item) => item.textContent === "Common.Cancel")
      ?.disabled,
  ).toBe(true);
  await act(async () => button.click());
  expect(saveToDatabase).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();
  expect(notifications.show).not.toHaveBeenCalled();

  await act(async () => save.resolve("saved"));

  expect(onClose).toHaveBeenCalledOnce();
  expect(notifications.show).toHaveBeenCalledExactlyOnceWith({ message: "Board.SavedTo" });
  expect(mutate).toHaveBeenCalledOnce();
  expect(host.querySelector('[role="dialog"]')?.getAttribute("data-pending")).toBe("false");
  expect(host.querySelector('[aria-label="Close dialog"]')).not.toBeNull();
  expect(host.querySelector("input")?.disabled).toBe(false);
  expect(button.hasAttribute("data-loading")).toBe(false);
  expect(button.disabled).toBe(false);
});

test("unmount during a pending save still announces success and skips late close", async () => {
  const save = deferredSave();
  const onClose = vi.fn();
  const mutate = await selectReadyTarget(onClose);
  await act(async () => saveButton().click());
  expect(saveToDatabase).toHaveBeenCalledOnce();
  expect(host.querySelector('[role="dialog"]')?.getAttribute("data-pending")).toBe("true");

  await act(async () => root.unmount());
  await act(async () => save.resolve("saved"));

  expect(onClose).not.toHaveBeenCalled();
  expect(notifications.show).toHaveBeenCalledExactlyOnceWith({ message: "Board.SavedTo" });
  expect(mutate).not.toHaveBeenCalled();
});

test.each([
  ["missing", "This database folder is no longer available. Choose another."],
  ["permission", "ChessRiddle Studio is not allowed to read this database folder. Choose another."],
  ["changed", "This database folder changed. Choose another."],
  ["too-large", "This database folder is too large to list. Choose another."],
] as const)(
  "shows Library recovery guidance for a typed %s listing failure",
  async (rootFailure, message) => {
    vi.mocked(useDatabaseList).mockReturnValue({
      error: { tag: "backend-error", category: "io", message: "private diagnostic", rootFailure },
      isLoading: false,
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useDatabaseList>);
    await renderModal();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(host.textContent).not.toContain("private diagnostic");
    expect(host.querySelector("input")?.disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);
  },
);

const standaloneDatabase: SuccessDatabaseInfo = {
  ...readyTarget,
  file: { id: { id: "standalone" }, kind: "database" },
  title: "Standalone",
  collection: undefined,
};

function mockDatabases(
  databases: SuccessDatabaseInfo[],
  collections: NonNullable<SuccessDatabaseInfo["collection"]>[] = [],
  error?: unknown,
) {
  vi.mocked(useDatabaseList).mockReturnValue({
    data: error
      ? undefined
      : {
          databases,
          unread: [],
          root: { id: { id: "root" }, kind: "databaseRoot" },
          collections,
        },
    error,
    isLoading: false,
    mutate: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReturnType<typeof useDatabaseList>);
}

function mockFiles(files: FileMetadata[], error?: unknown) {
  vi.mocked(useWorkspaceListing).mockReturnValue({
    data: error ? undefined : files,
    error,
    isLoading: false,
    mutate: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReturnType<typeof useWorkspaceListing>);
}

function optionValues() {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(
    (option) => option.getAttribute("value") ?? option.getAttribute("data-value"),
  );
}

async function chooseOption(label: string) {
  await act(async () => host.querySelector("input")!.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
    item.textContent?.includes(label),
  )!;
  await act(async () => option.click());
}

test("lists files and databases in two groups with namespaced values and omits a collection-backed database", async () => {
  mockFiles([repertoireFile, { ...otherFile, readError: "permission" }]);
  mockDatabases([readyTarget, standaloneDatabase], [readyTarget.collection!]);
  await renderModal(vi.fn(), workspace);
  await act(async () => host.querySelector("input")!.click());
  expect(host.textContent).toContain("Files");
  expect(host.textContent).toContain("Databases");
  expect(optionValues()).toEqual(["file:collection-file", "database:standalone"]);
  expect(host.textContent).toContain("Caro Kann");
  expect(host.textContent).toContain("Repertoire");
  expect(host.textContent).toContain("Standalone");
  expect(host.textContent).not.toContain(readyTarget.title);
  expect(host.textContent).not.toContain("Games");
});

test("saving a collection-backed file uses its real metadata", async () => {
  mockFiles([repertoireFile]);
  mockDatabases([readyTarget], [readyTarget.collection!]);
  vi.mocked(saveToLibraryFile).mockResolvedValue("saved");
  const onClose = vi.fn();
  await renderModal(onClose, workspace);
  await chooseOption("Caro Kann");
  await act(async () => saveButton().click());
  expect(saveToLibraryFile).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ file: repertoireFile }),
  );
  expect(saveToDatabase).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
  expect(notifications.show).toHaveBeenCalledExactlyOnceWith({ message: "Board.SavedTo" });
});

test("a files-only library can save to a file", async () => {
  mockFiles([otherFile]);
  mockDatabases([]);
  vi.mocked(saveToLibraryFile).mockResolvedValue("saved");
  await renderModal(vi.fn(), workspace);
  expect(noTargetsAlert()).toBeUndefined();
  await chooseOption("Games");
  expect(saveButton().disabled).toBe(false);
  await act(async () => saveButton().click());
  expect(saveToLibraryFile).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ file: otherFile }),
  );
  expect(saveToDatabase).not.toHaveBeenCalled();
});

test("a databases-only library keeps saving to a database", async () => {
  mockFiles([]);
  mockDatabases([standaloneDatabase]);
  vi.mocked(saveToDatabase).mockResolvedValue("saved");
  await renderModal(vi.fn(), workspace);
  expect(noTargetsAlert()).toBeUndefined();
  await chooseOption("Standalone");
  await act(async () => saveButton().click());
  expect(saveToDatabase).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ database: standaloneDatabase.file }),
  );
  expect(saveToLibraryFile).not.toHaveBeenCalled();
});

test("shows NoTargets when both listings succeed with zero targets", async () => {
  mockFiles([]);
  mockDatabases([]);
  await renderModal(vi.fn(), workspace);
  expect(noTargetsAlert()?.textContent).toBe("Board.Database.NoTargets");
});

test("a files listing failure uses files-domain copy and still saves a selected database", async () => {
  mockFiles([], {
    tag: "backend-error",
    category: "io",
    message: "private diagnostic",
    rootFailure: "missing",
  });
  mockDatabases([standaloneDatabase]);
  vi.mocked(saveToDatabase).mockResolvedValue("saved");
  await renderModal(vi.fn(), workspace);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "This collection is no longer available. Choose another.",
  );
  expect(host.textContent).not.toContain("private diagnostic");
  expect(host.querySelector("input")?.disabled).toBe(false);
  await chooseOption("Standalone");
  expect(saveButton().disabled).toBe(false);
  await act(async () => saveButton().click());
  expect(saveToDatabase).toHaveBeenCalledOnce();
  expect(saveToLibraryFile).not.toHaveBeenCalled();
});

test("a database listing failure still saves a selected file", async () => {
  mockFiles([repertoireFile]);
  mockDatabases([], [], {
    tag: "backend-error",
    category: "io",
    message: "private diagnostic",
    rootFailure: "missing",
  });
  vi.mocked(saveToLibraryFile).mockResolvedValue("saved");
  await renderModal(vi.fn(), workspace);
  expect(host.textContent).toContain(
    "This database folder is no longer available. Choose another.",
  );
  await chooseOption("Caro Kann");
  expect(saveButton().disabled).toBe(false);
  await act(async () => saveButton().click());
  expect(saveToLibraryFile).toHaveBeenCalledOnce();
  expect(saveToDatabase).not.toHaveBeenCalled();
});

test("a failed file save keeps the dialog open and notifies", async () => {
  mockFiles([repertoireFile]);
  mockDatabases([]);
  vi.mocked(saveToLibraryFile).mockResolvedValue({
    status: "failed",
    error: { category: "unexpected", message: "disk full" },
  });
  const onClose = vi.fn();
  await renderModal(onClose, workspace);
  await chooseOption("Caro Kann");
  await act(async () => saveButton().click());
  expect(onClose).not.toHaveBeenCalled();
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  expect(notifications.show).toHaveBeenCalledWith(
    expect.objectContaining({ color: "danger", message: "disk full" }),
  );
});

test("a thrown file save is caught, keeps the dialog open, and notifies", async () => {
  mockFiles([repertoireFile]);
  mockDatabases([]);
  vi.mocked(saveToLibraryFile).mockRejectedValue(new Error("boom"));
  const onClose = vi.fn();
  await renderModal(onClose, workspace);
  await chooseOption("Caro Kann");
  await act(async () => saveButton().click());
  expect(onClose).not.toHaveBeenCalled();
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ color: "danger" }));
});

test("selecting the origin database updates in place via saveToFile", async () => {
  const tab: Tab = {
    value: "tab-db",
    type: "analysis",
    name: "Game",
    gameOrigin: { kind: "database", database: standaloneDatabase.file, gameId: 7 },
  };
  mockFiles([]);
  mockDatabases([standaloneDatabase]);
  vi.mocked(saveToFile).mockResolvedValue("saved");
  const onClose = vi.fn();
  await renderModal(onClose, workspace, tab);
  await chooseOption("Standalone");
  await act(async () => saveButton().click());
  expect(saveToFile).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ tab, isUserSave: true }),
  );
  expect(saveToDatabase).not.toHaveBeenCalled();
  expect(saveToLibraryFile).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
  expect(notifications.show).toHaveBeenCalledExactlyOnceWith({ message: "Board.SavedTo" });
});

test("selecting a different database keeps calling saveToDatabase", async () => {
  const tab: Tab = {
    value: "tab-db",
    type: "analysis",
    name: "Game",
    gameOrigin: {
      kind: "database",
      database: { id: { id: "origin-db" }, kind: "database" },
      gameId: 7,
    },
  };
  mockFiles([]);
  mockDatabases([standaloneDatabase]);
  vi.mocked(saveToDatabase).mockResolvedValue("saved");
  await renderModal(vi.fn(), workspace, tab);
  await chooseOption("Standalone");
  await act(async () => saveButton().click());
  expect(saveToDatabase).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ tab, database: standaloneDatabase.file }),
  );
  expect(saveToFile).not.toHaveBeenCalled();
});

test("selecting the origin file updates in place via saveToFile", async () => {
  const tab: Tab = {
    value: "tab-file",
    type: "analysis",
    name: "Game",
    gameOrigin: { kind: "file", file: repertoireFile, gameNumber: 1 },
  };
  mockFiles([repertoireFile, otherFile]);
  mockDatabases([]);
  vi.mocked(saveToFile).mockResolvedValue("saved");
  const onClose = vi.fn();
  await renderModal(onClose, workspace, tab);
  await chooseOption("Caro Kann");
  await act(async () => saveButton().click());
  expect(saveToFile).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ tab, isUserSave: true }),
  );
  expect(saveToLibraryFile).not.toHaveBeenCalled();
  expect(saveToDatabase).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
  expect(notifications.show).toHaveBeenCalledExactlyOnceWith({ message: "Board.SavedTo" });
});

test("selecting a different file keeps calling saveToLibraryFile", async () => {
  const tab: Tab = {
    value: "tab-file",
    type: "analysis",
    name: "Game",
    gameOrigin: { kind: "file", file: repertoireFile, gameNumber: 1 },
  };
  mockFiles([repertoireFile, otherFile]);
  mockDatabases([]);
  vi.mocked(saveToLibraryFile).mockResolvedValue("saved");
  await renderModal(vi.fn(), workspace, tab);
  await chooseOption("Games");
  await act(async () => saveButton().click());
  expect(saveToLibraryFile).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ tab, file: otherFile }),
  );
  expect(saveToFile).not.toHaveBeenCalled();
});

test("selecting a collection-backed database when files listing failed updates the file origin via saveToFile", async () => {
  const tab: Tab = {
    value: "tab-linked",
    type: "analysis",
    name: "Game",
    gameOrigin: { kind: "file", file: repertoireFile, gameNumber: 0 },
  };
  mockFiles([], {
    tag: "backend-error",
    category: "io",
    message: "private diagnostic",
    rootFailure: "missing",
  });
  mockDatabases([readyTarget], [readyTarget.collection!]);
  vi.mocked(saveToFile).mockResolvedValue("saved");
  const onClose = vi.fn();
  await renderModal(onClose, workspace, tab);
  await chooseOption(readyTarget.title);
  await act(async () => saveButton().click());
  expect(saveToFile).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ tab, isUserSave: true }),
  );
  expect(saveToDatabase).not.toHaveBeenCalled();
  expect(saveToLibraryFile).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
});

test("a conflict result closes the dialog without a success toast", async () => {
  const tab: Tab = {
    value: "tab-db",
    type: "analysis",
    name: "Game",
    gameOrigin: { kind: "database", database: standaloneDatabase.file, gameId: 7 },
  };
  mockFiles([]);
  mockDatabases([standaloneDatabase]);
  vi.mocked(saveToFile).mockResolvedValue("conflict");
  const onClose = vi.fn();
  await renderModal(onClose, workspace, tab);
  await chooseOption("Standalone");
  await act(async () => saveButton().click());
  expect(saveToFile).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ tab, isUserSave: true }),
  );
  expect(onClose).toHaveBeenCalledOnce();
  expect(notifications.show).not.toHaveBeenCalled();
});

test("a databaseDraft tab selecting its draft database calls saveToDatabase, not saveToFile", async () => {
  const tab: Tab = {
    value: "tab-db-draft",
    type: "analysis",
    name: "Game",
    gameOrigin: { kind: "databaseDraft", database: standaloneDatabase.file },
  };
  mockFiles([]);
  mockDatabases([standaloneDatabase]);
  vi.mocked(saveToDatabase).mockResolvedValue("saved");
  await renderModal(vi.fn(), workspace, tab);
  await chooseOption("Standalone");
  await act(async () => saveButton().click());
  expect(saveToDatabase).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ tab, database: standaloneDatabase.file }),
  );
  expect(saveToFile).not.toHaveBeenCalled();
});

test("a fileDraft tab selecting its draft file calls saveToLibraryFile, not saveToFile", async () => {
  const tab: Tab = {
    value: "tab-file-draft",
    type: "analysis",
    name: "Game",
    gameOrigin: { kind: "fileDraft", file: repertoireFile },
  };
  mockFiles([repertoireFile, otherFile]);
  mockDatabases([]);
  vi.mocked(saveToLibraryFile).mockResolvedValue("saved");
  await renderModal(vi.fn(), workspace, tab);
  await chooseOption("Caro Kann");
  await act(async () => saveButton().click());
  expect(saveToLibraryFile).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ tab, file: repertoireFile }),
  );
  expect(saveToFile).not.toHaveBeenCalled();
});

test("a temp_file tab selecting its source file calls saveToLibraryFile, not saveToFile", async () => {
  const tab: Tab = {
    value: "tab-temp-file",
    type: "analysis",
    name: "Game",
    gameOrigin: { kind: "temp_file", file: repertoireFile, gameNumber: 0 },
  };
  mockFiles([repertoireFile, otherFile]);
  mockDatabases([]);
  vi.mocked(saveToLibraryFile).mockResolvedValue("saved");
  await renderModal(vi.fn(), workspace, tab);
  await chooseOption("Caro Kann");
  await act(async () => saveButton().click());
  expect(saveToLibraryFile).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ tab, file: repertoireFile }),
  );
  expect(saveToFile).not.toHaveBeenCalled();
});
