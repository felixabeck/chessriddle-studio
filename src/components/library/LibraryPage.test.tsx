import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { createStore, Provider } from "jotai";
import { afterEach, assert, beforeEach, expect, test, vi } from "vitest";
import {
  fileWorkspaceAtom,
  fileWorkspaceDisplayNameAtom,
  databaseConversionStateAtom,
  referenceDbAtom,
} from "@/state/atoms";
import { activeDatabaseViewStore } from "@/state/store/database";
import { workspaceListingToEntries, type Entry } from "@/components/files/file";
import type { ManagedDatabaseInfo } from "@/utils/db";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import LibraryPage from "./LibraryPage";
import { libraryFilterAtom, librarySearchAtom, librarySelectionAtom } from "./memory";
import { chessBaseGuideAtom } from "./chessBaseGuideState";

const mocks = vi.hoisted(() => ({
  files: [] as Entry[] | undefined,
  databases: [] as ManagedDatabaseInfo[] | undefined,
  collections: [] as import("@/bindings").CollectionDescriptor[],
  unread: [] as { filename: string; error: string }[],
  fileError: undefined as unknown,
  databaseError: undefined as unknown,
  fileMutate: vi.fn(),
  databaseMutate: vi.fn(),
  createWorkspaceFile: vi.fn(),
  createWorkspaceDirectory: vi.fn(),
  moveWorkspaceEntry: vi.fn(),
  editDbInfo: vi.fn(),
  navigate: vi.fn(),
  openFile: vi.fn(),
  linkSupported: false,
  appendCollectionGames: vi.fn(),
  migrateLinkedCollection: vi.fn(),
  pickPgnFile: vi.fn(),
  notify: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock("swr", async () => {
  const actual = await vi.importActual<typeof import("swr")>("swr");
  return {
    ...actual,
    useSWRConfig: () => ({ ...actual.useSWRConfig(), mutate: mocks.mutate }),
    default: (key: unknown) =>
      key === "linkedCollectionsSupported"
        ? { data: mocks.linkSupported }
        : key === "databases"
          ? {
              data: mocks.databases
                ? {
                    databases: mocks.databases,
                    collections: mocks.collections,
                    unread: mocks.unread,
                    root: { id: { id: "library-db-root" }, kind: "databaseRoot" },
                  }
                : undefined,
              error: mocks.databaseError,
              mutate: mocks.databaseMutate,
            }
          : {
              data: key ? mocks.files : undefined,
              error: mocks.fileError,
              mutate: mocks.fileMutate,
            },
  };
});
vi.mock("react-i18next", async () => {
  const catalogue = (await import("@/translation/en-US.json")).default.translation as Record<
    string,
    string
  >;
  return {
    useTranslation: () => ({
      t: (key: string, options?: { defaultValue?: string }) =>
        catalogue[key] ?? options?.defaultValue ?? key,
    }),
  };
});
vi.mock("@/platform/tauri", async () => ({
  ...(await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri")),
  tauri: {
    createWorkspaceFile: mocks.createWorkspaceFile,
    createWorkspaceDirectory: mocks.createWorkspaceDirectory,
    moveWorkspaceEntry: mocks.moveWorkspaceEntry,
    editDbInfo: mocks.editDbInfo,
    clearGames: vi.fn(async () => undefined),
    linkedCollectionsSupported: vi.fn(async () => false),
    collectionForDatabase: vi.fn(
      async (file: import("@/bindings").DatabaseHandle) =>
        mocks.collections.find((collection) => collection.database?.id.id === file.id.id) ?? null,
    ),
    appendCollectionGames: mocks.appendCollectionGames,
    migrateLinkedCollection: mocks.migrateLinkedCollection,
  },
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="/databases/fixture">{children}</a>
  ),
}));
vi.mock("@/utils/files", async () => ({
  ...(await vi.importActual<typeof import("@/utils/files")>("@/utils/files")),
  openFile: mocks.openFile,
  pickPgnFile: mocks.pickPgnFile,
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.notify } }));
vi.mock("@/components/files/FileCard", () => ({
  default: ({ selected }: { selected: Entry }) => <output data-file-detail>{selected.name}</output>,
}));
vi.mock("@/components/databases/PlayerSearchInput", () => ({ PlayerSearchInput: () => null }));
vi.mock("@/components/databases/AddDatabase", () => ({
  default: ({
    opened,
    disableLocalConversion,
  }: {
    opened: boolean;
    disableLocalConversion: boolean;
  }) => (opened ? <output data-import data-disabled={disableLocalConversion} /> : null),
}));
vi.mock("@/components/common/AppModal", () => ({
  default: ({ opened, children }: { opened: boolean; children: React.ReactNode }) =>
    opened ? <div role="dialog">{children}</div> : null,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();
const workspace = { id: { id: "workspace" }, kind: "fileWorkspace" as const };
const file: Entry = {
  type: "file",
  handle: { id: { id: "same-id" }, kind: "fileWorkspace" },
  name: "Same name",
  metadata: { type: "repertoire", tags: [] },
  numGames: 2,
  lastModified: 0,
};
const database: ManagedDatabaseInfo = {
  type: "success",
  file: { id: { id: "same-id" }, kind: "database" },
  filename: "same.db3",
  title: "Same name",
  description: "Database description",
  indexed: false,
  game_count: 2,
  player_count: 2,
  event_count: 2,
  storage_size: "0",
};
let root: Root;
let host: HTMLDivElement;
let store: ReturnType<typeof createStore>;
const missingCollection: import("@/bindings").CollectionDescriptor = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Missing collection",
  file: { ...workspace, id: { id: "missing-source" } },
  database: null,
  account: null,
  status: "unavailable",
  generation: "",
  omitted: 0,
  retiredDatabase: null,
  fetchSinceMs: null,
};
async function render() {
  await act(async () =>
    root.render(
      <Provider store={store}>
        <MantineProvider>
          <LibraryPage />
        </MantineProvider>
      </Provider>,
    ),
  );
}
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.files = [file];
  mocks.databases = [database];
  mocks.collections = [];
  mocks.linkSupported = false;
  mocks.mutate.mockReset().mockResolvedValue(undefined);
  mocks.unread = [];
  mocks.fileError = undefined;
  mocks.databaseError = undefined;
  mocks.fileMutate.mockResolvedValue(undefined);
  mocks.databaseMutate.mockResolvedValue(undefined);
  store = createStore();
  store.set(fileWorkspaceAtom, workspace);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  activeDatabaseViewStore.getState().clearDatabase();
  localStorage.clear();
  sessionStorage.clear();
});
function rows() {
  return [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')];
}

async function leaveLibrary() {
  await act(async () => root.render(null));
}

test.each(["file", "directory", "database", "missingCollection"] as const)(
  "remount restores the %s detail, search and type filter, but a fresh renderer with retained storage starts empty",
  async (kind) => {
    if (kind === "directory")
      mocks.files = [
        { type: "directory", handle: workspace, name: "Folder", children: [], lastModified: 0 },
      ];
    if (kind === "missingCollection") mocks.collections = [missingCollection];
    await render();
    await click(rows()[kind === "database" || kind === "missingCollection" ? 1 : 0]);
    const selected = store.get(librarySelectionAtom);
    expect(selected).not.toBeNull();
    await input(host.querySelector('input[aria-label="Search"]')!, "hidden selection");
    await click(host.querySelector<HTMLInputElement>(".mantine-Select-input")!);
    await click(
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (node) => node.textContent === "Repertoire",
      )!,
    );
    await leaveLibrary();
    await render();
    expect(store.get(librarySelectionAtom)).toEqual(selected);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Search"]')?.value).toBe(
      "hidden selection",
    );
    expect(host.querySelector<HTMLInputElement>(".mantine-Select-input")?.value).toBe("Repertoire");
    const detailRestored = {
      file: host.querySelector("[data-file-detail]")?.textContent === file.name,
      directory: host.textContent?.includes("Entries: {{number}}"),
      database: button("Add Games") !== undefined,
      missingCollection: host.querySelector("[data-linked-collection]") !== null,
    }[kind];
    expect(detailRestored).toBe(true);
    await leaveLibrary();
    // Keep web storage from the previous renderer, including the workspace.
    store = createStore();
    await render();
    expect(host.textContent).toContain("Select a library item");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Search"]')?.value).toBe("");
    expect(host.querySelector<HTMLInputElement>(".mantine-Select-input")?.value).toBe("");
    expect(store.get(librarySelectionAtom)).toBeNull();
    expect(store.get(librarySearchAtom)).toBe("");
    expect(store.get(libraryFilterAtom)).toBe("");
  },
);

test.each(["file", "database"] as const)(
  "return retains %s before its listing loads, then clears a removed item",
  async (kind) => {
    await click(rows()[kind === "file" ? 0 : 1]);
    await leaveLibrary();
    if (kind === "file") mocks.files = undefined;
    else mocks.databases = undefined;
    await render();
    expect(store.get(librarySelectionAtom)).not.toBeNull();
    if (kind === "file") mocks.files = [];
    else mocks.databases = [];
    await render();
    expect(store.get(librarySelectionAtom)).toBeNull();
    expect(host.textContent).toContain("Select a library item");
  },
);

test("return to a changed collection clears only its remembered selection", async () => {
  await click(rows()[0]);
  await leaveLibrary();
  store.set(fileWorkspaceAtom, { ...workspace, id: { id: "changed-while-away" } });
  await render();
  expect(store.get(librarySelectionAtom)).toBeNull();
  expect(host.textContent).toContain("Select a library item");
});

test("unread peers use root and index keys, show category copy and leave healthy siblings usable", async () => {
  mocks.unread = [
    { filename: "�.db3", error: "ChessRiddle Studio is not allowed to read this database file" },
    { filename: "�.db3", error: "ChessRiddle Studio is not allowed to read this database file" },
  ];
  mocks.files = workspaceListingToEntries(
    {
      entries: [],
      unread: [
        { name: "�.pgn", kind: "file", category: "permission", parent: null },
        { name: "�.pgn", kind: "file", category: "permission", parent: null },
      ],
    },
    workspace,
  );
  await render();
  const unreadRows = rows().filter((row) => row.getAttribute("aria-label")?.startsWith("�"));
  expect(unreadRows).toHaveLength(4);
  for (const row of unreadRows) {
    expect(row.draggable).toBe(false);
    expect(row.querySelector("button")).toBeNull();
    await act(async () => {
      row.click();
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "m", bubbles: true }));
      row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
  }
  expect(mocks.openFile).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).not.toContain("Files could not be loaded");
  expect(host.textContent).toContain("ChessRiddle Studio is not allowed to read this file.");
  expect(host.textContent).toContain(
    "ChessRiddle Studio is not allowed to read this database file",
  );
  for (const row of unreadRows) {
    await act(async () => {
      row.focus();
      row.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: rows().at(-1) === row ? "ArrowUp" : "ArrowDown",
          bubbles: true,
        }),
      );
    });
    expect(document.activeElement).not.toBe(row);
  }
  const healthy = rows().find((row) => row.getAttribute("aria-label") === "Same name")!;
  await act(async () =>
    healthy.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/databases/$databaseId",
    params: { databaseId: "same-id" },
  });
});
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label,
  )!;
}
async function input(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("one tree distinguishes equal-name and equal-key file/database identities and detail actions", async () => {
  expect(host.querySelectorAll('[role="tree"]')).toHaveLength(1);
  expect(rows()).toHaveLength(2);
  expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual(["Same name", "Same name"]);
  await click(rows()[0]);
  expect(host.querySelector("[data-file-detail]")).not.toBeNull();
  expect(button("Trash")).toBeDefined();
  await click(rows()[1]);
  expect(host.querySelector("[data-file-detail]")).toBeNull();
  expect(button("Trash")).toBeUndefined();
  expect(host.querySelector('input[value="Same name"]')).not.toBeNull();
  expect(button("Add Games")).toBeDefined();
  expect(rows().map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "true"]);
});

test("section counts track displayed entries and filtering without changing the tree or hidden selection", async () => {
  const count = (name: string) =>
    [...host.querySelectorAll("h2")].find((heading) => heading.textContent?.startsWith(name))
      ?.lastElementChild?.textContent;
  const folder: Entry = {
    type: "directory",
    handle: { ...workspace, id: { id: "count-folder" } },
    name: "Folder",
    children: [file],
    lastModified: 0,
  };
  mocks.files = [folder];
  await render();
  expect(count("Files")).toBe("1");
  expect(count("Databases")).toBe("1");
  await click(rows()[0]);
  expect(count("Files")).toBe("2");
  expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual([
    "Folder",
    "Same name",
    "Same name",
  ]);
  await click(rows()[1]);
  await input(host.querySelector('input[aria-label="Search"]')!, "Database description");
  expect(count("Files")).toBe("0");
  expect(count("Databases")).toBe("1");
  expect(host.querySelector("[data-file-detail]")).not.toBeNull();
  expect(host.querySelectorAll('[role="tree"]')).toHaveLength(1);
  expect(rows()).toHaveLength(1);
  expect(rows()[0].tabIndex).toBe(0);
  await input(host.querySelector('input[aria-label="Search"]')!, "no matching entry");
  expect(count("Databases")).toBeUndefined();
  expect(host.querySelector('[role="tree"]')?.children.length).toBe(0);
  expect(host.textContent).toContain("No results");
});

test("an unavailable collection stays with Files and selects the existing recovery detail", async () => {
  mocks.collections = [missingCollection];
  await render();
  const missingRow = rows()[1];
  expect(missingRow.textContent).toContain("Select");
  expect(missingRow.textContent).toContain("The search index is unavailable");
  expect([...host.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
    "Files2",
    "Databases1",
  ]);
  await click(missingRow);
  expect(host.querySelector("[data-linked-collection]")).not.toBeNull();
  expect(button("Rebuild search index")).toBeDefined();
  expect(missingRow.getAttribute("aria-selected")).toBe("true");
  await act(async () => {
    missingRow.focus();
    missingRow.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  expect(document.activeElement).toBe(rows()[2]);
});

test("an unavailable collection prevents a false whole-library empty state", async () => {
  mocks.files = [];
  mocks.databases = [];
  mocks.collections = [missingCollection];
  await render();
  expect(rows()).toHaveLength(1);
  expect(rows()[0].getAttribute("aria-label")).toBe(missingCollection.name);
  expect(rows()[0].textContent).toContain("The search index is unavailable");
  expect(host.textContent).not.toContain("Your library is empty");
  await click(rows()[0]);
  expect(host.querySelector("[data-linked-collection]")).not.toBeNull();
  expect(button("Rebuild search index")).toBeDefined();
});

test.each(["padding", "header"])(
  "database card %s selects and double-click opens through the Library hook exactly once",
  async (surface) => {
    await click(rows()[0]);
    const databaseRow = rows()[1];
    const selection = databaseRow.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
    const card = selection.parentElement!;
    expect(card.tagName).toBe("DIV");
    expect(card.contains(button("Open database"))).toBe(true);
    const target = surface === "padding" ? card : selection.querySelector("p")!;
    await click(target);
    expect(rows().map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    expect(selection.getAttribute("aria-pressed")).toBe("true");
    expect(mocks.navigate).not.toHaveBeenCalled();
    await act(async () => {
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
      target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
    });
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/databases/$databaseId",
      params: { databaseId: "same-id" },
    });
    expect(activeDatabaseViewStore.getState().database?.file).toEqual(database.file);
  },
);

test("contained database footer actions preserve database selection and never nest in the selection button", async () => {
  await click(rows()[0]);
  const databaseRow = rows()[1];
  const selection = databaseRow.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
  const open = button("Open database");
  expect(selection.contains(open)).toBe(false);
  expect(selection.parentElement?.contains(open)).toBe(true);
  const favourite = databaseRow.querySelector<HTMLInputElement>('input[type="radio"][value="1"]')!;
  expect(favourite).not.toBeNull();
  await click(databaseRow.querySelector<HTMLLabelElement>(`label[for="${favourite.id}"]`)!);
  expect(store.get(referenceDbAtom)).toEqual(database.file);
  expect(rows().map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "true"]);
  await act(async () => favourite.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  const footer = open.parentElement!.parentElement!;
  expect(footer.parentElement).toBe(selection.parentElement);
  await click(footer);
  await act(async () => {
    footer.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
    open.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
  });
  expect(mocks.navigate).not.toHaveBeenCalled();
  await click(open);
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/databases/$databaseId",
    params: { databaseId: "same-id" },
  });
  expect(rows()[1].getAttribute("aria-selected")).toBe("true");
});

test("composed file selection refuses a mismatched second target and opens a subsequent matching pair", async () => {
  const other: Entry = { ...file, handle: { ...file.handle, id: { id: "other-file" } } };
  mocks.files = [file, other];
  mocks.databases = [];
  mocks.openFile.mockResolvedValue("file-tab");
  await render();
  const mouse = async (index: number, type: string, detail: number) => {
    await act(async () =>
      rows()[index].dispatchEvent(new MouseEvent(type, { bubbles: true, detail })),
    );
  };
  await mouse(0, "click", 1);
  await mouse(1, "click", 2);
  await mouse(1, "dblclick", 2);
  expect(mocks.openFile).not.toHaveBeenCalled();
  expect(rows().map((row) => row.getAttribute("aria-selected"))).toEqual(["true", "false"]);
  expect(host.querySelector("[data-file-detail]")).not.toBeNull();
  await mouse(1, "click", 1);
  await mouse(1, "click", 2);
  await mouse(1, "dblclick", 2);
  expect(mocks.openFile).toHaveBeenCalledExactlyOnceWith(other, expect.anything());
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/" });
  expect(rows().map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "true"]);
});

test.each([null, { provider: "lichess" as const, account: "player" }])(
  "a trashed collection has no missing peer row, including an account source",
  async (account) => {
    mocks.files = [];
    mocks.collections = [
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Trashed games",
        file: file.handle,
        database: database.file,
        account,
        status: "trashed",
        generation: "",
        omitted: 0,
        retiredDatabase: null,
        fetchSinceMs: null,
      },
    ];
    await render();
    expect(host.textContent).not.toContain("Trashed games");
    expect(host.textContent).not.toContain("The search index is unavailable");
  },
);

test("a linked collection composes one Library row and opens the existing explorer and reference routes", async () => {
  const linked: import("@/bindings").CollectionDescriptor = {
    id: "22222222-2222-4222-8222-222222222222",
    name: file.name,
    file: file.handle,
    database: database.file,
    account: null,
    status: "ready",
    generation: "source-one",
    omitted: 0,
    retiredDatabase: null,
    fetchSinceMs: null,
  };
  mocks.collections = [linked];
  mocks.databases = [{ ...database, collection: linked }];
  await render();
  expect(rows()).toHaveLength(1);
  await click(rows()[0]);
  expect(host.querySelector("[data-file-detail]")).not.toBeNull();
  expect(host.querySelector("[data-linked-collection]")).not.toBeNull();
  await vi.waitFor(() => expect(button("Explore").disabled).toBe(false));
  await click(button("Explore"));
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/databases/$databaseId",
    params: { databaseId: "same-id" },
  });
  await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
  expect(store.get(referenceDbAtom)).toEqual(database.file);
});

test("Database-choice original keeps its selected preview and role without old index actions", async () => {
  const original: import("@/bindings").CollectionDescriptor = {
    id: "22222222-2222-4222-8222-222222222222",
    name: file.name,
    file: file.handle,
    database: null,
    account: null,
    status: "preservedOriginal",
    generation: "",
    omitted: 0,
    retiredDatabase: null,
    fetchSinceMs: null,
  };
  mocks.collections = [original];
  mocks.databases = [];
  await render();
  await click(rows()[0]);
  expect(host.querySelector("[data-file-detail]")?.textContent).toBe(file.name);
  assert.isNotNull(
    host.querySelector("[data-preserved-original]"),
    "preserved original role is missing from the selected Library file",
  );
  expect(host.querySelector("[data-preserved-original]")?.textContent).toContain(
    "Preserved original",
  );
  expect(host.textContent).toContain("The database version is now the active collection");
  for (const action of ["Explore", "Rebuild search index", "Add Games", "Export to PGN"])
    expect(button(action)).toBeUndefined();
  expect(host.querySelector('[aria-label="Replacement player name"]')).toBeNull();
  expect(button("Trash")).toBeDefined();
});

test("keyboard focus traverses both kinds and Enter opens the database by capability", async () => {
  await act(async () => {
    rows()[0].focus();
    rows()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  expect(document.activeElement).toBe(rows()[1]);
  await act(async () =>
    rows()[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/databases/$databaseId",
    params: { databaseId: "same-id" },
  });
  expect(activeDatabaseViewStore.getState().database?.file).toEqual(database.file);
});

test.each(["warning", "error"])(
  "selecting linked B isolates held A append %s and pending form state",
  async (outcome) => {
    const second = {
      ...file,
      handle: { ...file.handle, id: { id: "source-b" } },
      name: "Collection B",
    };
    const collection = {
      id: "22222222-2222-4222-8222-222222222222",
      name: file.name,
      file: file.handle,
      database: database.file,
      account: null,
      status: "ready" as const,
      generation: "one",
      omitted: 0,
      retiredDatabase: null,
      fetchSinceMs: null,
    };
    mocks.files = [file, second];
    mocks.collections = [
      collection,
      {
        ...collection,
        id: "33333333-3333-4333-8333-333333333333",
        name: second.name,
        file: second.handle,
        database: { ...database.file, id: { id: "cache-b" } },
      },
    ];
    mocks.databases = [];
    mocks.pickPgnFile.mockResolvedValue({ handle: file.handle });
    let finish!: () => void;
    mocks.appendCollectionGames.mockReturnValueOnce(
      new Promise((resolve, reject) => {
        finish = () =>
          outcome === "warning"
            ? resolve({ indexReady: false, durabilityConfirmed: true })
            : reject(new Error("A append failed"));
      }),
    );
    await render();
    await click(rows()[0]);
    await vi.waitFor(() => expect(button("Add Games").disabled).toBe(false));
    const from = host.querySelector<HTMLInputElement>("input.mantine-TextInput-input")!;
    await input(from, "A player");
    await click(button("Add Games"));
    expect(mocks.appendCollectionGames).toHaveBeenCalledOnce();
    await click(rows()[1]);
    const inheritedPending = button("Rebuild search index").getAttribute("data-loading");
    const inheritedForm = host.querySelector<HTMLInputElement>(
      "input.mantine-TextInput-input",
    )!.value;
    await act(async () => finish());
    expect(
      host.querySelector("[data-linked-collection]")?.getAttribute("data-linked-collection"),
    ).toBe(mocks.collections[1].id);
    expect.soft(inheritedPending, "B must not inherit A loading state").toBeNull();
    expect.soft(inheritedForm, "B must start with its own form").toBe("");
    expect
      .soft(host.textContent, "B must not display A append warning")
      .not.toContain("The PGN was committed, but completion could not be fully confirmed");
    expect.soft(mocks.notify, "A obsolete failure must not notify B").not.toHaveBeenCalled();
  },
);

test.each([false, true])(
  "delayed migration preserves current reference ownership (changed=%s) and newer selection through the composed Library",
  async (changed) => {
    mocks.linkSupported = true;
    store.set(referenceDbAtom, database.file);
    let complete!: (value: unknown) => void;
    mocks.migrateLinkedCollection.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    await render();
    await click(rows()[1]);
    await click(button("Link existing collection"));
    await click(
      [...host.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
        (node) => node.textContent === "Link existing collection",
      )!,
    );
    expect(mocks.migrateLinkedCollection).toHaveBeenCalledOnce();
    const newer = { ...database.file, id: { id: "new-reference" } };
    if (changed) await act(async () => store.set(referenceDbAtom, newer));
    await click(rows()[0]);
    await act(async () =>
      complete({
        id: "migrated",
        database: { ...database.file, id: { id: "new-cache" } },
        retiredDatabase: database.file,
      }),
    );
    expect
      .soft(store.get(referenceDbAtom), "migration must preserve the current reference owner")
      .toEqual(changed ? newer : { ...database.file, id: { id: "new-cache" } });
    expect
      .soft(
        host.querySelector("[data-file-detail]")?.textContent,
        "migration must preserve the newer file selection",
      )
      .toBe(file.name);
    expect.soft(rows()[0].getAttribute("aria-selected")).toBe("true");
  },
);

test("search retains a hidden selection and relisting removes only the vanished item", async () => {
  await click(rows()[0]);
  await input(host.querySelector('input[aria-label="Search"]')!, "Database description");
  expect(rows()).toHaveLength(1);
  expect(host.querySelector("[data-file-detail]")).not.toBeNull();
  mocks.databases = [];
  await render();
  expect(host.querySelector("[data-file-detail]")).not.toBeNull();
  mocks.files = [];
  await render();
  expect(host.querySelector("[data-file-detail]")).toBeNull();
  expect(host.textContent).toContain("Select a library item");
  expect(host.textContent).toContain("No results");
});

test("workspace replacement clears its selection while preserving a database selection", async () => {
  await click(rows()[0]);
  await act(async () => store.set(fileWorkspaceAtom, { ...workspace, id: { id: "next-root" } }));
  expect(host.querySelector("[data-file-detail]")).toBeNull();
  await click(rows()[1]);
  await act(async () => store.set(fileWorkspaceAtom, null));
  expect(host.querySelector('input[value="Same name"]')).not.toBeNull();
});

test.each(["files", "databases"])(
  "a %s failure leaves the sibling selectable and exposes source-labelled recovery",
  async (source) => {
    const error = {
      tag: "backend-error",
      category: "io",
      message: "private diagnostic",
      rootFailure: "missing",
    };
    if (source === "files") mocks.fileError = error;
    else mocks.databaseError = error;
    await render();
    expect(host.querySelector(`[data-library-source="${source}"] [role="alert"]`)).not.toBeNull();
    expect(host.textContent).not.toContain("Your library is empty");
    await click(rows()[0]);
    expect(
      source === "files"
        ? host.querySelector('input[value="Same name"]')
        : host.querySelector("[data-file-detail]"),
    ).not.toBeNull();
  },
);

test("conversion hides actions and restores the same database selection after completion", async () => {
  await click(rows()[1]);
  await act(async () =>
    store.set(databaseConversionStateAtom, [
      {
        id: "conversion",
        targetDatabase: database.file,
        targetDatabaseTitle: "Same name",
        totalGames: 0,
        elapsedSeconds: 0,
        sourceFileName: "import.pgn",
      },
    ]),
  );
  expect(button("Add Games")).toBeUndefined();
  expect(host.textContent).toContain("This database is being converted");
  mocks.databases = [];
  await render();
  mocks.databases = [database];
  await render();
  await act(async () => store.set(databaseConversionStateAtom, []));
  expect(button("Add Games")).toBeDefined();
  expect(rows()[1].getAttribute("aria-selected")).toBe("true");
});

test("file creation uses a selected folder, and a database never becomes a file destination", async () => {
  const folder: Entry = {
    type: "directory",
    handle: { ...workspace, id: { id: "folder" } },
    name: "Folder",
    children: [],
    lastModified: 0,
  };
  mocks.files = [folder];
  await render();
  for (const [row, destination] of [
    [0, folder.handle],
    [1, workspace],
  ] as const) {
    await click(rows()[row]);
    await click(button("Create file"));
    await input(document.querySelector('[role="dialog"] input')!, "Created");
    await click(button("Confirm"));
    expect(mocks.createWorkspaceFile).toHaveBeenLastCalledWith(
      workspace,
      destination,
      "Created",
      { type: "game", tags: [] },
      { kind: "text", pgn: "*" },
    );
  }
  await click(button("Import or download database"));
  expect(host.querySelector("[data-import]")).not.toBeNull();
});

test("switching equal-filename database handles resets settings and suppresses pending stale edits", async () => {
  const other = {
    ...database,
    file: { ...database.file, id: { id: "other" } },
    title: "Other title",
  } as ManagedDatabaseInfo;
  mocks.databases = [database, other];
  await render();
  await click(rows()[1]);
  await input(host.querySelector('input[value="Same name"]')!, "Unsubmitted");
  await click(rows()[2]);
  expect(host.querySelector('input[value="Other title"]')).not.toBeNull();
  await act(async () => {
    await new Promise((done) => setTimeout(done, 350));
  });
  expect(mocks.editDbInfo).not.toHaveBeenCalled();
});

test("error metadata remains selectable with delete and without healthy-only operations", async () => {
  mocks.databases = [
    {
      type: "error",
      file: database.file,
      filename: "same.db3",
      indexed: false,
      error: "Corrupt metadata",
    },
  ];
  await render();
  await click(rows()[1]);
  expect(host.textContent).toContain("Corrupt metadata");
  expect(button("Delete")).toBeDefined();
  expect(button("Add Games")).toBeUndefined();
  expect(button("Open database")).toBeUndefined();
});

test.each(["upgrading", "busy"] as const)(
  "%s rows are searchable by filename and cannot be opened with Enter or double-click",
  async (transient) => {
    mocks.databases = [
      {
        type: "error",
        file: database.file,
        filename: "Large archive.db3",
        indexed: false,
        transient,
        error: "Transient explanation",
      },
    ];
    await render();
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search"]')!;
    await input(search, "Large archive");
    expect(rows()).toHaveLength(1);
    expect(rows()[0].getAttribute("aria-label")).toBe("Large archive.db3");
    await click(rows()[0]);
    await act(async () => {
      rows()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      rows()[0]
        .querySelector("button")!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(button("Open database")).toBeUndefined();
    expect(button("Delete")).toBeUndefined();
    expect(host.textContent).toContain("Transient explanation");
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(activeDatabaseViewStore.getState().database).toBeUndefined();
    await input(search, "Transient explanation");
    expect(rows()).toHaveLength(0);
  },
);

test("a pending Delete confirmation is retired when its selected row becomes transient", async () => {
  await click(rows()[1]);
  await click(button("Delete"));
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  mocks.databases = [
    {
      type: "error",
      file: database.file,
      filename: "same.db3",
      indexed: false,
      transient: "upgrading",
      error: "Upgrade underway",
    },
  ];
  await render();
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(button("Delete")).toBeUndefined();
  mocks.databases = [database];
  await render();
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(button("Delete")).toBeDefined();
});

test("empty success differs from loading and source failure", async () => {
  mocks.files = [];
  mocks.databases = [];
  await render();
  expect(host.textContent).toContain("Your library is empty");
  expect(host.textContent).not.toContain("Files ·");
  await act(async () => store.set(fileWorkspaceDisplayNameAtom, "Repertoire"));
  expect(host.textContent).toContain("Files · Repertoire");
  await click(button("Coming from ChessBase?"));
  expect(store.get(chessBaseGuideAtom)).toBe("link");
  await act(async () => store.set(librarySearchAtom, "missing"));
  expect(host.textContent).toContain("No results");
  expect(host.textContent).not.toContain("Coming from ChessBase?");
  await act(async () => store.set(librarySearchAtom, ""));
  mocks.databases = undefined;
  await render();
  expect(host.textContent).not.toContain("Your library is empty");
  expect(host.textContent).not.toContain("Coming from ChessBase?");
  expect(host.textContent).toContain("Loading games databases");
});

test("database rows cannot request a file move or carry a file drag payload", async () => {
  const databaseRow = rows()[1];
  expect(databaseRow.draggable).toBe(false);
  const setData = vi.fn();
  await act(async () => {
    databaseRow.dispatchEvent(new KeyboardEvent("keydown", { key: "m", bubbles: true }));
    const drag = new Event("dragstart", { bubbles: true });
    Object.assign(drag, { dataTransfer: { setData } });
    databaseRow.dispatchEvent(drag);
    databaseRow.dispatchEvent(new Event("drop", { bubbles: true }));
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(setData).not.toHaveBeenCalled();
  expect(mocks.moveWorkspaceEntry).not.toHaveBeenCalled();
});

test("an unavailable listing retains database identity without claiming conversion, and removal clears it", async () => {
  await click(rows()[1]);
  mocks.databases = undefined;
  await render();
  expect(host.textContent).toContain("Loading games databases");
  expect(host.textContent).not.toContain("This database is being converted");
  mocks.databases = [database];
  await render();
  expect(host.querySelector('input[value="Same name"]')).not.toBeNull();
  mocks.databases = [];
  await render();
  mocks.databases = [database];
  await render();
  expect(host.querySelector('input[value="Same name"]')).toBeNull();
  expect(host.textContent).toContain("Select a library item");
});

test("the clearable type filter hides rows while retaining detail and exposes an accessible reset", async () => {
  const typeFilter = host.querySelector<HTMLInputElement>(".mantine-Select-input")!;
  expect(typeFilter.placeholder).toBe("All types");
  const label = host.querySelector(`label[for="${typeFilter.id}"]`);
  expect(label?.textContent).toBe("File type");
  await click(rows()[1]);
  await click(host.querySelector<HTMLInputElement>(".mantine-Select-input")!);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (node) => node.textContent === "Repertoire",
  )!;
  await click(option);
  expect(rows()).toHaveLength(1);
  expect(rows()[0].getAttribute("aria-label")).toBe("Same name");
  expect(host.querySelector('input[value="Same name"]')).not.toBeNull();
  const clear = host.querySelector<HTMLButtonElement>('button[aria-label="Clear type filter"]')!;
  expect(clear.getAttribute("aria-hidden")).toBe("false");
  expect(clear.tabIndex).toBe(0);
  await click(clear);
  expect(rows()).toHaveLength(2);
  expect(rows()[1].getAttribute("aria-selected")).toBe("true");
});
