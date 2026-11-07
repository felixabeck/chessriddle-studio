import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig, useSWRConfig, type Cache, type ScopedMutator } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DATABASE_LIST_KEY } from "@/hooks/useDatabaseList";
import { databaseConversionStateAtom, referenceDbAtom } from "@/state/atoms";
import { activeDatabaseViewStore } from "@/state/store/database";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { databaseHandleKey, type DatabaseList, type SuccessDatabaseInfo } from "@/utils/db";
import { useDatabaseLibrary } from "./useDatabaseLibrary";

const mocks = vi.hoisted(() => ({
  getDatabases: vi.fn(),
  pickPgnFile: vi.fn(),
  convertPgn: vi.fn(),
  deleteDatabase: vi.fn(),
  deleteDuplicatedGames: vi.fn(),
  clearGames: vi.fn(),
  editDbInfo: vi.fn(),
  notifyUnlessCancelled: vi.fn(),
}));

vi.mock("@/utils/db", async () => ({
  ...(await vi.importActual<typeof import("@/utils/db")>("@/utils/db")),
  getDatabases: mocks.getDatabases,
}));
vi.mock("@/utils/files", () => ({ pickPgnFile: mocks.pickPgnFile }));
vi.mock("@/platform/tauri", async () => ({
  ...(await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri")),
  tauri: mocks,
  withConversionTicket: (run: (ticket: string) => Promise<unknown>) => run("conversion-ticket"),
}));
vi.mock("@/components/files/notifyError", async () => ({
  ...(await vi.importActual<typeof import("@/components/files/notifyError")>(
    "@/components/files/notifyError",
  )),
  notifyUnlessCancelled: mocks.notifyUnlessCancelled,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a href="/databases/fixture">{children}</a>,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/common/AppModal", () => ({
  default: ({ opened, children }: { opened: boolean; children: ReactNode }) =>
    opened ? <div role="dialog">{children}</div> : null,
}));
vi.mock("./PlayerSearchInput", () => ({ PlayerSearchInput: () => null }));
vi.mock("./AddDatabase", () => ({ default: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

const database: SuccessDatabaseInfo = {
  type: "success",
  file: { id: { id: "database" }, kind: "database" },
  filename: "games.db3",
  title: "Games",
  description: "",
  indexed: false,
  game_count: 3,
  player_count: 2,
  event_count: 1,
  storage_size: "0",
};

function list(databases: SuccessDatabaseInfo[]): DatabaseList {
  return { databases, unread: [], root: { id: { id: "root" }, kind: "databaseRoot" } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let root: Root;
let host: HTMLDivElement;
let cache: Cache;
let mutate: ScopedMutator;
let store: ReturnType<typeof createStore>;

function Library() {
  const [selected, setSelected] = useState<string | null>(databaseHandleKey(database.file));
  const library = useDatabaseLibrary(selected, setSelected);
  mutate = useSWRConfig().mutate;
  return (
    <>
      <output data-selected>{selected ?? "none"}</output>
      {library.status}
      {library.progress}
      {library.detail}
      {library.dialogs}
    </>
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  mocks.getDatabases.mockResolvedValue(list([database]));
  mocks.pickPgnFile.mockResolvedValue({
    handle: { id: { id: "pgn" }, kind: "fileWorkspace" },
    name: "games.pgn",
  });
  mocks.convertPgn.mockResolvedValue(undefined);
  mocks.deleteDatabase.mockResolvedValue(undefined);
  mocks.deleteDuplicatedGames.mockResolvedValue(undefined);
  mocks.editDbInfo.mockResolvedValue(undefined);
  store = createStore();
  cache = new Map();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  activeDatabaseViewStore.getState().clearDatabase();
  localStorage.clear();
  sessionStorage.clear();
});

async function render() {
  await act(async () => {
    root.render(
      <Provider store={store}>
        <MantineProvider>
          <SWRConfig
            value={{
              provider: () => cache,
              dedupingInterval: 0,
              shouldRetryOnError: false,
              revalidateOnFocus: false,
              revalidateOnReconnect: false,
            }}
          >
            <Library />
          </SWRConfig>
        </MantineProvider>
      </Provider>,
    );
  });
}

function button(label: string, within: ParentNode = host) {
  const found = [...within.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label,
  );
  expect(found).toBeDefined();
  return found!;
}

async function click(label: string, within: ParentNode = host) {
  // Flush microtasks without awaiting the event handler's pending native/listing work.
  await act(async () => button(label, within).click());
}

async function confirmDelete() {
  await click("Common.Delete");
  const dialog = host.querySelector('[role="dialog"]')!;
  await click("Common.Delete", dialog);
}

async function startOldListing() {
  const old = deferred<DatabaseList>();
  mocks.getDatabases.mockReturnValueOnce(old.promise);
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = mutate(DATABASE_LIST_KEY);
    await Promise.resolve();
  });
  expect(mocks.getDatabases).toHaveBeenCalledTimes(2);
  return { old, pending };
}

test("add games keeps the fresh list after a pre-write listing settles", async () => {
  await render();
  const { old, pending } = await startOldListing();
  const fresh = list([{ ...database, game_count: 8 }]);
  mocks.getDatabases.mockResolvedValue(fresh);

  await click("Databases.Settings.AddGames");
  expect(mocks.convertPgn).toHaveBeenCalledOnce();
  expect(mocks.getDatabases.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(cache.get(DATABASE_LIST_KEY)?.data).toEqual(fresh);
  expect(store.get(databaseConversionStateAtom)).toEqual([]);

  await act(async () => {
    old.resolve(list([database]));
    await pending;
  });
  expect(cache.get(DATABASE_LIST_KEY)?.data).toEqual(fresh);
  expect(cache.get(DATABASE_LIST_KEY)?.error).toBeUndefined();
  expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
});

test("delete retires a pending pre-write listing before refreshing the list", async () => {
  await render();
  const { old, pending } = await startOldListing();
  const fresh = list([]);
  mocks.getDatabases.mockResolvedValue(fresh);

  await confirmDelete();
  expect(mocks.deleteDatabase).toHaveBeenCalledExactlyOnceWith(database.file);
  // Keep checking late delivery even when the writer failed to start a fresh read.
  expect.soft(mocks.getDatabases).toHaveBeenCalledTimes(3);
  expect(host.querySelector('[role="dialog"]')).toBeNull();

  await act(async () => {
    old.resolve(list([database]));
    await pending;
  });
  expect(cache.get(DATABASE_LIST_KEY)?.data).toEqual(fresh);
  expect(cache.get(DATABASE_LIST_KEY)?.error).toBeUndefined();
  expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
});

test("a failed post-delete list read preserves the committed deletion without notifying", async () => {
  await render();
  await act(async () => store.set(referenceDbAtom, database.file));
  const failure = new Error("post-delete listing failed");
  mocks.getDatabases.mockRejectedValue(failure);

  await confirmDelete();
  expect(mocks.deleteDatabase).toHaveBeenCalledExactlyOnceWith(database.file);
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(host.querySelector("[data-selected]")?.textContent).toBe("none");
  expect(store.get(referenceDbAtom)).toBeNull();
  expect(cache.get(DATABASE_LIST_KEY)?.error).toBe(failure);
  expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
});

async function waitForSettingsDebounce() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
}

function namedField(labelText: string, elementType: "input" | "textarea") {
  const label = [...host.querySelectorAll("label")].find((element) =>
    (element.textContent ?? "").includes(labelText),
  );
  expect(label).toBeTruthy();
  const labelled = label!.htmlFor ? host.querySelector(`[id="${label!.htmlFor}"]`) : null;
  const field = labelled ?? label!.querySelector(elementType);
  expect(field).toBeInstanceOf(elementType === "input" ? HTMLInputElement : HTMLTextAreaElement);
  return field as HTMLInputElement | HTMLTextAreaElement;
}

async function editNamedField(labelText: string, elementType: "input" | "textarea", value: string) {
  const field = namedField(labelText, elementType);
  const prototype =
    elementType === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(field.value).toBe(value);
}

async function revalidateListedDatabase(next: SuccessDatabaseInfo) {
  mocks.getDatabases.mockResolvedValue(list([next]));
  await act(async () => {
    await mutate(DATABASE_LIST_KEY);
  });
}

test("a same-handle refresh with new metadata shows the new values and does not write them back", async () => {
  await render();
  await waitForSettingsDebounce();
  expect(mocks.editDbInfo).not.toHaveBeenCalled();

  await revalidateListedDatabase({
    ...database,
    title: "External",
    description: "From disk",
  });
  await waitForSettingsDebounce();

  expect(mocks.editDbInfo).not.toHaveBeenCalled();
  expect(namedField("Common.Name", "input").value).toBe("External");
  expect(namedField("Common.Description", "textarea").value).toBe("From disk");
});

test("an unchanged same-handle revalidation does not write database metadata", async () => {
  await render();
  await waitForSettingsDebounce();
  mocks.getDatabases.mockResolvedValue(list([database]));
  await act(async () => {
    await mutate(DATABASE_LIST_KEY);
  });
  await waitForSettingsDebounce();
  expect(mocks.editDbInfo).not.toHaveBeenCalled();
  expect(namedField("Common.Name", "input").value).toBe("Games");
});

test("typing a title saves the typed title with the current description after debounce", async () => {
  let listed = database;
  mocks.getDatabases.mockImplementation(async () => list([listed]));
  mocks.editDbInfo.mockImplementation(
    async (_file: SuccessDatabaseInfo["file"], title: string, description: string) => {
      listed = { ...listed, title, description };
    },
  );
  await render();
  await editNamedField("Common.Name", "input", "Typed");
  expect(mocks.editDbInfo).not.toHaveBeenCalled();

  await waitForSettingsDebounce();
  expect(mocks.editDbInfo).toHaveBeenCalledExactlyOnceWith(database.file, "Typed", "");
  expect(namedField("Common.Name", "input").value).toBe("Typed");
});

test("after a title save round-trips, a later external title is shown and not written back", async () => {
  let listed = database;
  mocks.getDatabases.mockImplementation(async () => list([listed]));
  mocks.editDbInfo.mockImplementation(
    async (_file: SuccessDatabaseInfo["file"], title: string, description: string) => {
      listed = { ...listed, title, description };
    },
  );
  await render();
  await editNamedField("Common.Name", "input", "Mine");
  await waitForSettingsDebounce();
  expect(mocks.editDbInfo).toHaveBeenCalledExactlyOnceWith(database.file, "Mine", "");
  await act(async () => {
    await mutate(DATABASE_LIST_KEY);
  });
  await waitForSettingsDebounce();
  expect(namedField("Common.Name", "input").value).toBe("Mine");

  listed = { ...listed, title: "External later" };
  await act(async () => {
    await mutate(DATABASE_LIST_KEY);
  });
  await waitForSettingsDebounce();
  expect(mocks.editDbInfo).toHaveBeenCalledOnce();
  expect(namedField("Common.Name", "input").value).toBe("External later");
});

test("a failed post-cleanup list read preserves completed duplicate removal without notifying", async () => {
  await render();
  const failure = new Error("post-cleanup listing failed");
  mocks.getDatabases.mockRejectedValue(failure);

  await click("Databases.Settings.RemoveDup");
  expect(mocks.deleteDuplicatedGames).toHaveBeenCalledExactlyOnceWith(database.file);
  expect(button("Databases.Settings.RemoveDup").disabled).toBe(false);
  expect(cache.get(DATABASE_LIST_KEY)?.error).toBe(failure);
  expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
});
