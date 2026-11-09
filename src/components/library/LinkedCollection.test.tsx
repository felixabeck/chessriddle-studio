import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";
import { referenceDbAtom, tabsAtom } from "@/state/atoms";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, assert, beforeEach, expect, test, vi } from "vitest";
import type { CollectionDescriptor } from "@/bindings";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import enUS from "@/translation/en-US.json";
import { CollectionMigration, LinkedCollection } from "./LinkedCollection";

const mocks = vi.hoisted(() => ({
  collectionForDatabase: vi.fn(),
  rebuildLinkedCollection: vi.fn(),
  appendCollectionGames: vi.fn(),
  editLinkedCollection: vi.fn(),
  issuePgnExportDestination: vi.fn(),
  exportToPgn: vi.fn(),
  getDatabaseWorkspace: vi.fn(),
  createWorkspaceDatabase: vi.fn(),
  restoreCollectionArchive: vi.fn(),
  reselectLinkedCollection: vi.fn(),
  migrateLinkedCollection: vi.fn(),
  pickPgnFile: vi.fn(),
  navigate: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("@/platform/tauri", () => ({ tauri: mocks }));
vi.mock("@/utils/files", () => ({ pickPgnFile: mocks.pickPgnFile }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: mocks.notify } }));
vi.mock("react-i18next", async () => {
  const english = (await import("@/translation/en-US.json")).default.translation as Record<
    string,
    string
  >;
  return {
    useTranslation: () => ({
      t: (key: string, options?: { defaultValue?: string }) =>
        english[key] ?? options?.defaultValue ?? key,
    }),
  };
});
const source = {
  type: "file" as const,
  name: "Source",
  handle: { id: { id: "source" }, kind: "fileWorkspace" as const },
  numGames: 2,
  metadata: { type: "game" as const, tags: [] },
  lastModified: 0,
};
const workspace = { id: { id: "workspace" }, kind: "fileWorkspace" as const };
const collection: CollectionDescriptor = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Source",
  file: source.handle,
  database: { id: { id: "cache" }, kind: "database" },
  account: null,
  status: "ready",
  generation: "one",
  omitted: 0,
  retiredDatabase: { id: { id: "old" }, kind: "database" },
  fetchSinceMs: null,
};
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let jotai: ReturnType<typeof createStore>;
const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
const label = (key: string) => (enUS.translation as Record<string, string>)[key] ?? key;
const button = (key: string) =>
  [...document.querySelectorAll("button")].find((node) => node.textContent === label(key))!;
const input = (key: string) =>
  document.getElementById(
    [...document.querySelectorAll("label")].find((node) => node.textContent === label(key))!
      .htmlFor,
  ) as HTMLInputElement;
async function fill(key: string, value: string) {
  await act(async () => {
    const node = input(key);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function select(key: string, text: string) {
  await act(async () => input(key).click());
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((node) => node.textContent === text)!
      .click(),
  );
}
async function render(child: React.ReactNode) {
  await act(async () =>
    root.render(
      <MantineProvider>
        <Provider store={jotai}>
          <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
            {child}
          </SWRConfig>
        </Provider>
      </MantineProvider>,
    ),
  );
}
beforeEach(() => {
  jotai = createStore();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  installMatchMediaStub();
  installResizeObserverStub();
  vi.clearAllMocks();
  mocks.collectionForDatabase.mockResolvedValue(collection);
  mocks.pickPgnFile.mockResolvedValue(source);
  mocks.appendCollectionGames.mockResolvedValue({
    appended: 1,
    committed: true,
    indexReady: false,
    durabilityConfirmed: true,
  });
  mocks.issuePgnExportDestination.mockResolvedValue({ handle: source.handle });
  mocks.getDatabaseWorkspace.mockResolvedValue({
    root: { id: { id: "root" }, kind: "databaseRoot" },
    displayName: "Databases",
  });
  mocks.createWorkspaceDatabase.mockResolvedValue({ id: { id: "restored" }, kind: "database" });
  mocks.migrateLinkedCollection.mockResolvedValue(collection);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  if (originalScroll) Object.defineProperty(Element.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

test("linked controls dispatch file-domain append, lossless export, bulk edits, rebuild and archive restore", async () => {
  await render(
    <LinkedCollection
      collection={{ ...collection, omitted: 1 }}
      workspace={workspace}
      files={[source]}
    />,
  );
  await act(async () => button("Databases.Explore").click());
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/databases/$databaseId",
    params: { databaseId: "cache" },
  });
  await act(async () => button("Databases.Settings.AddGames").click());
  expect(mocks.appendCollectionGames).toHaveBeenCalledWith(collection.id, source.handle);
  expect(host.textContent).toContain(label("Collections.CommittedPending"));
  await act(async () => button("Databases.Settings.ExportPGN").click());
  expect(mocks.exportToPgn).toHaveBeenCalledWith(collection.database, source.handle);
  await act(async () => button("Databases.Settings.RemoveEmpty").click());
  await act(async () => button("Databases.Settings.RemoveDup").click());
  expect(mocks.editLinkedCollection).toHaveBeenCalledWith(collection.id, collection.generation, {
    kind: "cleanup",
    empty: true,
    duplicates: false,
  });
  expect(mocks.editLinkedCollection).toHaveBeenCalledWith(collection.id, collection.generation, {
    kind: "cleanup",
    empty: false,
    duplicates: true,
  });
  await fill("Collections.PlayerFrom", "Player");
  await fill("Collections.PlayerTo", "Edited Player");
  await act(async () => button("Common.Save").click());
  expect(mocks.editLinkedCollection).toHaveBeenLastCalledWith(
    collection.id,
    collection.generation,
    { kind: "renamePlayer", from: "Player", to: "Edited Player" },
  );
  await act(async () => button("Collections.Rebuild").click());
  expect(mocks.rebuildLinkedCollection).toHaveBeenCalledWith(collection.id, true);
  await act(async () => button("Collections.Restore").click());
  expect(mocks.restoreCollectionArchive).toHaveBeenCalledWith(collection.id, {
    id: { id: "restored" },
    kind: "database",
  });
});

test("New game in ready linked detail creates the same database draft and does not append", async () => {
  await render(<LinkedCollection collection={collection} workspace={workspace} files={[source]} />);
  expect(button("Databases.NewGame").disabled).toBe(false);
  await act(async () => button("Databases.NewGame").click());
  expect(
    jotai
      .get(tabsAtom)
      .some(
        (tab) =>
          tab.type === "analysis" &&
          tab.gameOrigin.kind === "databaseDraft" &&
          tab.gameOrigin.database.id.id === collection.database!.id.id,
      ),
  ).toBe(true);
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/" });
  expect(mocks.appendCollectionGames).not.toHaveBeenCalled();
});

test.each(["unavailable", "retired"] as const)(
  "New game refuses a %s linked collection",
  async (status) => {
    mocks.collectionForDatabase.mockResolvedValue({ ...collection, status });
    await render(
      <LinkedCollection
        collection={{ ...collection, status }}
        workspace={workspace}
        files={[source]}
      />,
    );
    expect(button("Databases.NewGame").disabled).toBe(true);
  },
);

test("Library recovery resumes the preserved native batch without selecting or substituting another input", async () => {
  const owned = { id: { id: "owned-pending-input" }, kind: "fileWorkspace" as const };
  const pending = { ...collection, pendingBatch: owned };
  mocks.collectionForDatabase.mockResolvedValue(pending);
  await render(<LinkedCollection collection={pending} workspace={workspace} files={[source]} />);
  expect(host.textContent).toContain(label("Collections.PendingAppend"));
  await act(async () => button("Common.Retry").click());
  expect(mocks.appendCollectionGames).toHaveBeenCalledExactlyOnceWith(collection.id, owned);
  expect(mocks.pickPgnFile).not.toHaveBeenCalled();
});

test("unavailable linked collection requires explicit source selection and keeps failed actions retryable", async () => {
  const unavailable = { ...collection, status: "unavailable" as const };
  mocks.collectionForDatabase.mockResolvedValue(unavailable);
  await render(
    <LinkedCollection collection={unavailable} workspace={workspace} files={[source]} />,
  );
  expect(button("Databases.Explore").disabled).toBe(true);
  await select("Collections.Source", source.name);
  await act(async () => button("Collections.Relink").click());
  expect(mocks.reselectLinkedCollection).toHaveBeenCalledWith(
    collection.id,
    workspace,
    source.handle,
  );
  mocks.rebuildLinkedCollection.mockRejectedValueOnce(new Error("index unavailable"));
  await act(async () => button("Collections.Rebuild").click());
  expect(mocks.notify).toHaveBeenCalled();
  expect(button("Collections.Rebuild").disabled).toBe(false);
});

test("migration exports an entire database without a PGN, retains its request on refusal and supports explicit decline", async () => {
  const complete = vi.fn();
  const close = vi.fn();
  const database = {
    type: "success" as const,
    file: collection.retiredDatabase!,
    title: "Prior history",
    description: "",
    filename: "old.db3",
    game_count: 8,
    player_count: 2,
    event_count: 1,
    storage_size: "4096",
    indexed: false,
  };
  mocks.migrateLinkedCollection.mockRejectedValueOnce(new Error("archive unavailable"));
  jotai.set(referenceDbAtom, database.file);
  await render(
    <CollectionMigration
      database={database}
      workspace={workspace}
      files={[]}
      opened
      onClose={close}
      onComplete={complete}
    />,
  );
  await act(async () => button("Collections.Migrate").click());
  expect(close).not.toHaveBeenCalled();
  await act(async () => button("Collections.Migrate").click());
  const [first, second] = mocks.migrateLinkedCollection.mock.calls;
  expect(first[0]).toBe(second[0]);
  expect(second.slice(1, 7)).toEqual([
    workspace,
    database.file,
    null,
    "database",
    null,
    "Prior history-linked",
  ]);
  expect(complete).toHaveBeenCalledWith(collection);
  expect(jotai.get(referenceDbAtom)).toEqual(collection.database);
  mocks.migrateLinkedCollection.mockResolvedValueOnce(null);
  await act(async () => button("Collections.Decline").click());
  expect(mocks.migrateLinkedCollection.mock.calls.at(-1)![4]).toBe("decline");
});

test("pair migration explicitly selects the PGN version and passes its native capability", async () => {
  const database = {
    type: "success" as const,
    file: collection.retiredDatabase!,
    title: "Prior",
    description: "",
    filename: "old.db3",
    game_count: 1,
    player_count: 2,
    event_count: 1,
    storage_size: "4096",
    indexed: false,
  };
  await render(
    <CollectionMigration
      database={database}
      workspace={workspace}
      files={[source]}
      opened
      onClose={vi.fn()}
      onComplete={vi.fn()}
    />,
  );
  await select("Collections.Source", `${source.name} (${source.numGames})`);
  await select("Collections.FutureSource", label("Collections.PgnVersion"));
  expect(document.body.textContent).toContain("Original versions are preserved before linking");
  expect(document.body.textContent).not.toContain("Originals are archived");
  await act(async () => button("Collections.Migrate").click());
  expect(mocks.migrateLinkedCollection.mock.calls[0].slice(1, 5)).toEqual([
    workspace,
    database.file,
    source.handle,
    "pgn",
  ]);
});

test("migration database replacement resets its form and request while obsolete refusal cannot notify or close the new owner", async () => {
  const database = {
    type: "success" as const,
    file: collection.retiredDatabase!,
    title: "First",
    description: "",
    filename: "same.db3",
    game_count: 1,
    player_count: 2,
    event_count: 1,
    storage_size: "4096",
    indexed: false,
  };
  const second = {
    ...database,
    file: { ...database.file, id: { id: "second-database" } },
    title: "Second",
  };
  const close = vi.fn();
  const complete = vi.fn();
  const pane = (value: typeof database) => (
    <CollectionMigration
      database={value}
      workspace={workspace}
      files={[source]}
      opened
      onClose={close}
      onComplete={complete}
    />
  );
  let refuse!: (error: unknown) => void;
  mocks.migrateLinkedCollection.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      refuse = reject;
    }),
  );
  await render(pane(database));
  await fill("Common.Name", "First custom name");
  await select("Collections.Source", `${source.name} (${source.numGames})`);
  await select("Collections.FutureSource", label("Collections.PgnVersion"));
  await act(async () => button("Collections.Migrate").click());
  const requestA = mocks.migrateLinkedCollection.mock.calls[0][0];
  await render(pane(second));
  const inheritedPending = button("Collections.Migrate").disabled;
  await act(async () => refuse(new Error("old archive refused")));
  assert.isNotNull(
    document.querySelector('input[value="Second-linked"]'),
    "the new database owns a fresh migration form",
  );
  expect(input("Collections.Source").value).toBe("");
  expect(inheritedPending).toBe(false);
  expect(mocks.notify).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  mocks.migrateLinkedCollection.mockRejectedValueOnce(new Error("new archive refused"));
  await act(async () => button("Collections.Migrate").click());
  expect(mocks.migrateLinkedCollection.mock.calls[1][0]).not.toBe(requestA);
  mocks.migrateLinkedCollection.mockResolvedValueOnce(null);
  await act(async () => button("Collections.Migrate").click());
  expect(mocks.migrateLinkedCollection.mock.calls[2][0]).toBe(
    mocks.migrateLinkedCollection.mock.calls[1][0],
  );
  expect(mocks.migrateLinkedCollection.mock.calls[2].slice(1, 7)).toEqual([
    workspace,
    second.file,
    null,
    "database",
    null,
    "Second-linked",
  ]);
});
