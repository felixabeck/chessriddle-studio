import { MantineProvider } from "@mantine/core";
import i18n from "i18next";
import { Provider, createStore } from "jotai";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { catalogueI18n, shippedCatalogues } from "@/tests/catalogues";
import type { SupportedLocale } from "@/i18n";
import type { CollectionDescriptor, DatabaseInfoResult, NormalizedGame } from "@/bindings";
import type { Entry, FileMetadata } from "@/components/files/file";
import type { DatabaseList } from "@/utils/db";
import type { OwnGame } from "@/components/library/ownGamesFeed";
import type { LibraryRow } from "@/components/library/libraryData";
import { lastOpenedAtom, recentFilesAtom, tabsAtom } from "@/state/atoms";
import { databaseGameOpenedKey } from "@/state/lastOpened";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { chessRiddleTrainingSessions as trainingSessions } from "@/state/chessRiddleTraining";
import { StaleFileGameError } from "@/state/fileStructureChange";
import NewTabHome from "./NewTabHome";

const mocks = vi.hoisted(() => ({
  available: vi.fn(),
  listing: { data: undefined as Entry[] | undefined, isLoading: true, error: undefined as unknown },
  databases: {
    data: undefined as DatabaseList | undefined,
    isLoading: false,
    error: undefined as unknown,
  },
  due: {} as Record<string, { count: number | null; failed: boolean }>,
  feed: { games: [] as OwnGame[], loading: false, hasMore: false, incompleteCount: 0 },
  feedArgs: vi.fn(),
  showMore: vi.fn(),
  count: vi.fn(),
  readGames: vi.fn(),
  getGame: vi.fn(),
  info: vi.fn(),
  query: vi.fn(),
  openFile: vi.fn(),
  openGame: vi.fn(),
  openDatabase: vi.fn(),
  navigate: vi.fn(),
  notify: vi.fn(),
  importModal: vi.fn(),
}));
vi.mock("@/components/library/useWorkspaceListing", () => ({
  useWorkspaceListing: () => mocks.listing,
}));
vi.mock("@/hooks/useDatabaseList", () => ({ useDatabaseList: () => mocks.databases }));
vi.mock("swr", () => ({ useSWRConfig: () => ({ mutate: vi.fn() }) }));
vi.mock("@/components/library/useLibraryDueCounts", () => ({
  useLibraryDueCounts: (rows: LibraryRow[]) => {
    const values = rows
      .filter(
        (row) =>
          row.kind === "file" &&
          ("metadata" in row.file ? row.file.metadata.type : row.file.type) === "repertoire",
      )
      .map((file) => ({ file, ...(mocks.due[file.name] ?? { count: 0, failed: false }) }));
    return {
      rows: values,
      dueRows: values.filter((row) => row.failed || (row.count ?? 0) > 0),
      total: values.reduce((sum, row) => sum + (row.count ?? 0), 0),
      incomplete: values.some((row) => row.count === null),
    };
  },
}));
vi.mock("@/components/library/useOwnGamesFeed", () => ({
  useOwnGamesFeed: (collections: unknown, query: string, active: boolean) => {
    mocks.feedArgs(collections, query, active);
    return { ...mocks.feed, active: active && collections !== undefined, showMore: mocks.showMore };
  },
}));
vi.mock("@/platform/tauri", () => ({
  tauri: {
    countPgnGames: mocks.count,
    readGames: mocks.readGames,
    getDbGame: mocks.getGame,
    getDbInfo: mocks.info,
    chessriddleTrainingAvailable: mocks.available,
  },
}));
vi.mock("@/utils/db", async (original) => ({
  ...(await original<typeof import("@/utils/db")>()),
  query_games: mocks.query,
}));
vi.mock("@/utils/files", () => ({ openFile: mocks.openFile }));
vi.mock("@/utils/chess", async (original) => ({
  ...(await original<typeof import("@/utils/chess")>()),
  parsePGN: async (pgn: string) => {
    const { defaultTree } = await import("@/utils/treeReducer");
    const tree = defaultTree();
    tree.headers.event = pgn;
    return tree;
  },
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 60,
    measure: () => undefined,
    getVirtualItems: () => [0, 1].map((index) => ({ index, size: 30, start: index * 30 })),
  }),
}));
vi.mock("@/utils/databaseGame", async (original) => ({
  ...(await original<typeof import("@/utils/databaseGame")>()),
  openDatabaseGame: mocks.openGame,
}));
vi.mock("@/components/library/openDatabaseTable", () => ({
  openDatabaseTable: mocks.openDatabase,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@/components/files/notifyError", () => ({ notifyUnlessCancelled: mocks.notify }));
vi.mock("react-i18next", () => {
  const t = (key: string, values?: unknown) => (values ? key + JSON.stringify(values) : key);
  return { useTranslation: () => ({ t, i18n: { language: "en-US" } }) };
});
vi.mock("./CreateRepertoireModal", () => ({ default: () => null }));
vi.mock("./ImportModal", () => ({
  default: (props: unknown) => {
    mocks.importModal(props);
    return null;
  },
}));

installMatchMediaStub();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let store: ReturnType<typeof createStore>;
const handle = (id: string) => ({ kind: "fileWorkspace" as const, id: { id } });
const database = { kind: "database" as const, id: { id: "database" } };
const collection: CollectionDescriptor = {
  id: "collection",
  name: "Own games",
  file: handle("own"),
  database,
  status: "ready",
  generation: "generation",
  omitted: 0,
  account: null,
  retiredDatabase: null,
  fetchSinceMs: null,
};
const game = { id: 7, white: "White", black: "Black", moves: "*", linked: null } as NormalizedGame;
function file(name: string, type: "game" | "repertoire" = "game"): FileMetadata {
  return {
    type: "file",
    name,
    handle: handle(name),
    numGames: 1,
    metadata: { type, tags: [] },
    lastModified: 10,
  };
}
async function render() {
  await act(async () =>
    root.render(
      <MantineProvider>
        <Provider store={store}>
          <NewTabHome id="home" />
        </Provider>
      </MantineProvider>,
    ),
  );
}
async function click(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label,
  )!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
async function filter(value: string) {
  await act(async () => host.querySelector<HTMLInputElement>(`input[value="${value}"]`)!.click());
}
async function search(value: string) {
  const input = host.querySelector<HTMLInputElement>('input[placeholder="Home.Library.Search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const rows = () => [...host.querySelectorAll<HTMLButtonElement>("[data-library-row]")];
async function open(name: string) {
  await act(async () =>
    rows()
      .find((row) => row.textContent?.includes(name))!
      .click(),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  trainingSessions.remove("home");
  mocks.available.mockReset().mockResolvedValue(false);
  vi.spyOn(i18n, "t").mockImplementation((...args: Parameters<typeof i18n.t>) => String(args[0]));
  localStorage.clear();
  sessionStorage.clear();
  store = createStore();
  store.set(tabsAtom, [{ value: "home", name: "Home", type: "new", gameOrigin: { kind: "none" } }]);
  mocks.listing = { data: undefined, isLoading: true, error: undefined };
  mocks.databases = { data: undefined, isLoading: false, error: undefined };
  mocks.due = {};
  mocks.feed = { games: [], loading: false, hasMore: false, incompleteCount: 0 };
  mocks.count.mockReset().mockResolvedValue(1);
  mocks.readGames.mockReset().mockResolvedValue(chapterGames());
  mocks.openFile.mockReset().mockResolvedValue("opened");
  mocks.openGame.mockResolvedValue("opened");
  mocks.info.mockResolvedValue({ status: "ready", game_count: 1, title: "Own games" });
  mocks.query.mockResolvedValue({ data: [game] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  trainingSessions.remove("home");
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("recents remain visible and open with owner while the workspace listing stays pending", async () => {
  store.set(recentFilesAtom, [
    { name: "Recent", type: "game", handle: handle("recent"), lastOpened: 1 },
  ]);
  await render();
  expect(rows()).toHaveLength(1);
  expect(host.textContent).toContain("Common.Loading");
  await open("Recent");
  expect(mocks.openFile).toHaveBeenCalledWith(
    expect.objectContaining({ name: "Recent" }),
    expect.any(Function),
    { ownerId: "home", store },
  );
});

test("a never-opened Library file renders its native modification seconds as a recent date", async () => {
  mocks.listing = {
    data: [{ ...file("Unopened"), lastModified: Math.floor(Date.now() / 1000) - 86_400 }],
    isLoading: false,
    error: undefined,
  };
  await render();
  expect(rows()[0].textContent).toContain("a day ago");
  expect(rows()[0].textContent).not.toMatch(/\d+ years ago/);
});

test("Library listing rows supply the file name for recents and let openFile derive the chapter tab name", async () => {
  mocks.listing = { data: [file("Raw file name.pgn")], isLoading: false, error: undefined };
  await render();
  await open("Raw file name");
  expect(mocks.openFile).toHaveBeenCalledWith(
    expect.objectContaining({ name: "Raw file name.pgn" }),
    expect.any(Function),
    { ownerId: "home", store },
  );
  expect(mocks.openFile.mock.calls[0][2]).not.toHaveProperty("tabName");
});

test.each(["all", "repertoires", "due"])(
  "repertoire opens with owner from %s and Practice only from Due",
  async (value) => {
    mocks.listing = {
      data: [file("Repertoire", "repertoire")],
      isLoading: false,
      error: undefined,
    };
    mocks.due.Repertoire = { count: 2, failed: false };
    await render();
    await filter(value);
    await open("Repertoire");
    expect(mocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { type: "repertoire", tags: [] } }),
      expect.any(Function),
      {
        ownerId: "home",
        store,
        ...(value === "due" ? { panel: "practice" } : {}),
      },
    );
  },
);

test("Due omits the total line when no repertoire has overdue positions", async () => {
  mocks.listing = { data: [file("Done", "repertoire")], isLoading: false, error: undefined };
  await render();
  await filter("due");
  expect(rows()).toHaveLength(0);
  expect(host.textContent).toContain("Home.DuePractice.NothingDue");
  expect(host.textContent).not.toContain("Home.DuePractice.Total");
});

test("Due sorts overdue counts, includes failed decks, and keeps their whole row operable", async () => {
  mocks.listing = {
    data: ["Done", "Failed", "Two", "Five"].map((name) => file(name, "repertoire")),
    isLoading: false,
    error: undefined,
  };
  mocks.due = {
    Done: { count: 0, failed: false },
    Failed: { count: null, failed: true },
    Two: { count: 2, failed: false },
    Five: { count: 5, failed: false },
  };
  await render();
  await filter("due");
  expect(rows().map((row) => row.querySelector("p")?.textContent)).toEqual([
    "Five",
    "Two",
    "Failed",
  ]);
  expect(host.textContent).toContain('Home.DuePractice.Total{"positions":7,"repertoires":2}');
  expect(host.textContent).toContain("Home.DuePractice.Incomplete");
  expect(rows().every((row) => row.tagName === "BUTTON" && !row.disabled)).toBe(true);
  await open("Failed");
  expect(mocks.openFile.mock.calls[0][2].panel).toBe("practice");
});

test.each(["listing", "unreadable", "metadata", "database-listing", "unread-database"])(
  "Due treats %s discovery failure as incomplete with both empty and partial results",
  async (failure) => {
    const entries: Entry[] =
      failure === "unreadable"
        ? [{ type: "unreadable", name: "Unreadable", category: "permission", key: "unreadable" }]
        : failure === "metadata"
          ? [{ ...file("Unreadable", "repertoire"), readError: "permission" }]
          : [];
    mocks.listing = {
      data: entries,
      isLoading: false,
      error: failure === "listing" ? new Error("Workspace listing failed") : undefined,
    };
    mocks.databases.error =
      failure === "database-listing" ? new Error("Database listing failed") : undefined;
    mocks.databases.data = {
      databases: [],
      unread:
        failure === "unread-database"
          ? [{ filename: "Unreadable.db3", error: "Permission denied" }]
          : [],
      root: { kind: "databaseRoot", id: { id: "root" } },
    };
    await render();
    await filter("due");
    expect(rows()).toHaveLength(0);
    expect(host.textContent).toContain("Home.Library.LoadFailed");
    expect(host.textContent).not.toContain("Home.DuePractice.NothingDue");

    mocks.listing.data = [...entries, file("Known", "repertoire")];
    mocks.due.Known = { count: 3, failed: false };
    await render();
    expect(rows()).toHaveLength(1);
    const total = [...host.querySelectorAll("p")].find((item) =>
      item.textContent?.includes("Home.DuePractice.Total"),
    );
    expect(total?.textContent).toContain('Home.DuePractice.Total{"positions":3,"repertoires":1}');
    expect(total?.textContent).toContain("Home.DuePractice.Incomplete");
  },
);

test("search finds a Library file absent from recents and activates player search only where required", async () => {
  mocks.listing = {
    data: [file("Sicilian", "repertoire"), file("French", "repertoire")],
    isLoading: false,
    error: undefined,
  };
  await render();
  await search("Sicilian");
  expect(rows()).toHaveLength(1);
  expect(mocks.feedArgs).toHaveBeenLastCalledWith(undefined, "Sicilian", true);
  await open("Sicilian");
  await filter("repertoires");
  expect(mocks.feedArgs).toHaveBeenLastCalledWith(undefined, "Sicilian", false);
});

test.each([1, 4])("a collection of %s games opens a game or its table", async (count) => {
  mocks.databases.data = {
    collections: [collection],
    databases: [],
    unread: [],
    root: { kind: "databaseRoot", id: { id: "root" } },
  };
  mocks.info.mockResolvedValue({ status: "ready", game_count: count, title: "Own games" });
  await render();
  await open("Own games");
  const opener = count === 1 ? mocks.openGame : mocks.openDatabase;
  const expected =
    count === 1 ? { ownerId: "home", store, game, database } : { file: database, collection };
  expect(opener.mock.calls[0][0]).toEqual(expect.objectContaining(expected));
  expect(mocks.openGame).toHaveBeenCalledTimes(count === 1 ? 1 : 0);
  expect(mocks.openDatabase).toHaveBeenCalledTimes(count === 1 ? 0 : 1);
});

test.each(["Meine Partien.pgn", "Meine Partien.PGN", "Meine Partien"])(
  "collection %s omits the PGN extension from rows and opened-game recent titles",
  async (name) => {
    const ownCollection = { ...collection, name };
    mocks.databases.data = {
      collections: [ownCollection],
      databases: [],
      unread: [],
      root: { kind: "databaseRoot", id: { id: "root" } },
    };
    mocks.feed.games = [{ collection: ownCollection, game }];
    await render();
    expect(rows()[0].querySelector("p")?.textContent).toBe("Meine Partien");
    await open("Meine Partien");
    expect(mocks.openGame).toHaveBeenCalledWith(
      expect.objectContaining({ game, database, databaseTitle: "Meine Partien" }),
    );

    mocks.openGame.mockClear();
    await filter("games");
    expect([...rows()[0].querySelectorAll("p")].map((text) => text.textContent)).toEqual([
      "White - Black",
      "Meine Partien",
    ]);
    await open("White - Black");
    expect(mocks.openGame).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ game, database, databaseTitle: "Meine Partien" }),
    );
    expect(ownCollection.name).toBe(name);
  },
);

test("Games puts reference databases first, then own games, and opens each by kind", async () => {
  mocks.listing.isLoading = false;
  mocks.databases.data = {
    collections: [collection],
    databases: [
      {
        type: "success",
        file: database,
        title: "Reference",
        game_count: 10,
        player_count: 2,
        event_count: 1,
        storage_size: "0",
        filename: "reference.db3",
        description: "",
        indexed: true,
      },
    ],
    unread: [],
    root: { kind: "databaseRoot", id: { id: "root" } },
  };
  mocks.feed.games = [{ collection, game }];
  mocks.feed.hasMore = true;
  await render();
  await filter("games");
  expect(rows().map((row) => row.dataset.kind)).toEqual(["database", "game"]);
  await open("Reference");
  expect(mocks.openDatabase).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Reference" }),
    mocks.navigate,
  );
  await open("White - Black");
  expect(mocks.openGame).toHaveBeenCalledWith(
    expect.objectContaining({ game, ownerId: "home", store }),
  );
  await click("Home.Library.ShowMore");
  expect(mocks.showMore).toHaveBeenCalledOnce();
});

test.each([
  "Databases.LoadError.Permission",
  "Databases.LoadError.Admission",
  "Databases.UpgradeFailed.DiskFull",
])("opening a failed database retains its %s guidance", async (key) => {
  const message = i18n.t(key);
  mocks.databases.data = {
    databases: [
      { type: "error", file: database, filename: "Failed.db3", error: message, indexed: false },
    ],
    unread: [],
    root: { kind: "databaseRoot", id: { id: "root" } },
  };
  await render();
  await open("Failed");
  expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(
    "Home.Library.OpenFailed",
    expect.objectContaining({ message }),
  );
  expect(mocks.openDatabase).not.toHaveBeenCalled();
});

test.each<{ metadata: DatabaseInfoResult; message: string }>([
  { metadata: { status: "busy", filename: "own.db3" }, message: "Databases.Busy.Description" },
  {
    metadata: { status: "upgrading", filename: "own.db3", title: null },
    message: "Databases.Upgrading.Description",
  },
  {
    metadata: {
      status: "upgrade-failed",
      filename: "own.db3",
      reason: "disk-full",
      message: "Upgrade failed",
    },
    message: "Databases.UpgradeFailed.DiskFull",
  },
  {
    metadata: {
      status: "upgrade-failed",
      filename: "own.db3",
      reason: "other",
      message: "Upgrade could not finish",
    },
    message: "Upgrade could not finish",
  },
])(
  "opening a collection retains the $metadata.status metadata reason: $message",
  async ({ metadata, message }) => {
    mocks.databases.data = {
      collections: [collection],
      databases: [],
      unread: [],
      root: { kind: "databaseRoot", id: { id: "root" } },
    };
    mocks.info.mockResolvedValue(metadata);
    await render();
    await open("Own games");
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(
      "Home.Library.OpenFailed",
      expect.objectContaining({ message }),
    );
    expect(mocks.openGame).not.toHaveBeenCalled();
    expect(mocks.openDatabase).not.toHaveBeenCalled();
  },
);

test.each(["2026.11.08", "2026.??.??"])(
  "an own-game row shows its recorded PGN date %s instead of its last-opened time",
  async (date) => {
    mocks.feed.games = [{ collection, game: { ...game, date } }];
    store.set(lastOpenedAtom, {
      [databaseGameOpenedKey(database, game.id)]: Date.now() - 86_400_000,
    });
    await render();
    await filter("games");
    expect([...rows()[0].querySelectorAll("p")].map((text) => text.textContent)).toEqual([
      "White - Black",
      "Own games",
      date,
    ]);
    expect(rows()[0].textContent).not.toContain("ago");
  },
);

test.each(["????.??.??", "", null, undefined])(
  "an own-game row with unknown date %s has no date, relative time or time tooltip target",
  async (date) => {
    mocks.feed.games = [{ collection, game: { ...game, ...(date === undefined ? {} : { date }) } }];
    store.set(lastOpenedAtom, {
      [databaseGameOpenedKey(database, game.id)]: Date.now() - 86_400_000,
    });
    await render();
    await filter("games");
    const row = rows()[0];
    expect(row.textContent).toBe("White - BlackOwn games");
    expect(row.children).toHaveLength(2);
    expect(document.querySelector(".mantine-Tooltip-tooltip")).toBeNull();
  },
);

test("a recent game's secondary collection title omits a stored PGN extension", async () => {
  store.set(recentFilesAtom, [
    {
      kind: "database",
      database,
      databaseTitle: "Meine Partien.pgn",
      gameId: game.id,
      name: "White - Black",
      lastOpened: 1,
    },
  ]);
  mocks.getGame.mockResolvedValue({ kind: "found", game });
  await render();
  expect(rows()).toHaveLength(1);
  expect(rows()[0].querySelectorAll("p")[1].textContent).toBe("Meine Partien");
});

test("a recent game keeps its relative last-opened time despite a known recorded game date", async () => {
  store.set(recentFilesAtom, [
    {
      kind: "database",
      database,
      gameId: game.id,
      name: "White - Black",
      lastOpened: Date.now() - 86_400_000,
    },
  ]);
  mocks.getGame.mockResolvedValue({ kind: "found", game: { ...game, date: "2026.10.01" } });
  await render();
  expect(rows()[0].textContent).toContain("a day ago");
  expect(rows()[0].textContent).not.toContain("2026.10.01");
});

test("All sorts recent games by their recorded opening and deduplicates appended search matches", async () => {
  store.set(recentFilesAtom, [
    { kind: "database", database, gameId: 7, name: "White - Black", lastOpened: 1 },
  ]);
  store.set(lastOpenedAtom, { [databaseGameOpenedKey(database, 7)]: 100 });
  mocks.getGame.mockResolvedValue({ kind: "found", game });
  mocks.databases.data = {
    collections: [collection],
    databases: [],
    unread: [],
    root: { kind: "databaseRoot", id: { id: "root" } },
  };
  mocks.feed.games = [{ collection, game }];
  await render();
  expect(rows()[0].textContent).toContain("White - Black");
  await search("White");
  expect(rows()).toHaveLength(1);
});

test("unusable collections explain their disabled state while failed decks stay enabled", async () => {
  mocks.databases.data = {
    collections: [{ ...collection, status: "unavailable", database: null }],
    databases: [],
    unread: [],
    root: { kind: "databaseRoot", id: { id: "root" } },
  };
  await render();
  expect(rows()[0].disabled).toBe(true);
  expect(rows()[0].textContent).toContain("Home.Library.CollectionUnavailable");
});

test("empty, no-workspace, partial failure and platform file-game notices offer the Library", async () => {
  mocks.listing = { data: [], isLoading: false, error: new Error("listing") };
  mocks.feed.incompleteCount = 2;
  await render();
  await filter("games");
  for (const key of ["Empty", "NoWorkspace", "LoadFailed", "GamesIncomplete", "GameFiles"])
    expect(host.textContent).toContain("Home.Library." + key);
  await click("Home.Library.OpenLibrary");
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/library" });
});

test.each(["count", "open"])(
  "prunes a missing recent on %s failure and keeps newer entries",
  async (stage) => {
    const recent = { name: "Gone", handle: handle("gone"), type: "game" as const, lastOpened: 1 };
    store.set(recentFilesAtom, [recent]);
    await render();
    const failure = { tag: "backend-error", category: "missing-resource", message: "File moved" };
    (stage === "count" ? mocks.count : mocks.openFile).mockRejectedValueOnce(failure);
    await open("Gone");
    expect(store.get(recentFilesAtom)).toEqual([]);
    expect(mocks.notify).toHaveBeenCalledOnce();
  },
);

test("transient validation failures retain recents and refused opening does not navigate", async () => {
  store.set(recentFilesAtom, [
    { name: "Keep", handle: handle("keep"), type: "game", lastOpened: 1 },
  ]);
  mocks.count.mockRejectedValueOnce(new Error("busy"));
  await render();
  expect(rows()).toHaveLength(1);
  mocks.openFile.mockResolvedValueOnce(null);
  await open("Keep");
  expect(mocks.navigate).not.toHaveBeenCalled();
});

test("compact actions replace their own tab and pass import ownership", async () => {
  await render();
  expect(host.querySelectorAll("[data-home-action]")).toHaveLength(5);
  expect(
    [...host.querySelectorAll("[data-home-action]")].map((action) => action.textContent),
  ).toEqual([
    "Home.Card.PlayChess.Button",
    "Home.Card.AnalysisBoard.Title",
    "Home.Card.Puzzle.Title",
    "Home.Card.NewRepertoire.Title",
    "Home.Card.ImportGame.Button",
  ]);
  for (const [label, type] of [
    ["Home.Card.PlayChess.Button", "play"],
    ["Home.Card.AnalysisBoard.Title", "analysis"],
    ["Home.Card.Puzzle.Title", "puzzles"],
  ]) {
    await act(async () =>
      store.set(tabsAtom, [
        { value: "other", name: "Other", type: "analysis", gameOrigin: { kind: "none" } },
        { value: "home", name: "Home", type: "new", gameOrigin: { kind: "none" } },
      ]),
    );
    await click(label);
    expect(store.get(tabsAtom).map((tab) => tab.type)).toEqual(["analysis", type]);
  }
  await click("Home.Card.NewRepertoire.Title");
  await click("Home.Card.ImportGame.Button");
  expect(mocks.importModal).toHaveBeenCalledWith(
    expect.objectContaining({ ownerId: "home", openModal: true }),
  );
});

test.each([true, false, "failed"] as const)(
  "Puzzles opens one puzzle tab when availability is %s",
  async (available) => {
    if (available === "failed") mocks.available.mockRejectedValue("server");
    else mocks.available.mockResolvedValue(available);
    await render();
    expect(host.querySelectorAll("[data-home-action]")).toHaveLength(5);
    await click("Home.Card.Puzzle.Title");
    expect(store.get(tabsAtom)[0]).toMatchObject({ type: "puzzles", name: "Home.PuzzleTraining" });
    expect(store.get(tabsAtom)[0].puzzleSource).toBe(
      available === false ? undefined : "chessriddle",
    );
    expect(mocks.available).toHaveBeenCalledOnce();
  },
);

test.each([true, false])(
  "Puzzles awaits the pending availability read resolving %s",
  async (available) => {
    let finish!: (value: boolean) => void;
    mocks.available.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await click("Home.Card.Puzzle.Title");
    expect(store.get(tabsAtom)[0].type).toBe("new");
    expect(mocks.available).toHaveBeenCalledOnce();
    await act(async () => finish(available));
    expect(store.get(tabsAtom)[0]).toMatchObject({ type: "puzzles", name: "Home.PuzzleTraining" });
    expect(store.get(tabsAtom)[0].puzzleSource).toBe(available ? "chessriddle" : undefined);
  },
);

test.each(["another action", "a retired home owner"])(
  "a late puzzle opening cannot replace %s",
  async (replacement) => {
    let finish!: (value: boolean) => void;
    mocks.available.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await click("Home.Card.Puzzle.Title");
    expect(store.get(tabsAtom)[0].type).toBe("new");
    if (replacement === "another action") await click("Home.Card.AnalysisBoard.Title");
    else await act(async () => root.render(null));
    await act(async () => finish(true));
    expect(store.get(tabsAtom)[0].type).toBe(replacement === "another action" ? "analysis" : "new");
  },
);

test.each(shippedCatalogues())(
  "every new Home key resolves in $locale without fallback",
  async ({ locale, translation }) => {
    const instance = await catalogueI18n(locale as SupportedLocale);
    const english = shippedCatalogues().find((entry) => entry.locale === "en-US")!.translation;
    const homeKeys = [
      "Home.Library.All",
      "Home.Library.Repertoires",
      "Home.Library.Games",
      "Home.Library.Due",
      "Home.Library.Search",
      "Home.Library.NoWorkspace",
      "Home.Library.LoadFailed",
      "Home.Library.GamesIncomplete",
      "Home.Library.GameFiles",
      "Home.Library.CollectionUnavailable",
      "Home.Library.Empty",
      "Home.Library.ShowMore",
      "Home.Library.OpenLibrary",
      "Home.Library.OpenFailed",
    ];
    for (const key of homeKeys) {
      expect(instance.exists(key)).toBe(true);
      expect(instance.t(key, { collections: 2 }).trim()).not.toBe("");
      expect(instance.t(key)).not.toBe(key);
    }
    const translatedKeys = homeKeys.filter(
      (key) =>
        !locale.startsWith("en-") && !(locale === "de-DE" && key === "Home.Library.Repertoires"),
    );
    for (const key of translatedKeys) expect(translation[key]).not.toBe(english[key]);
    expect(instance.t("Home.Library.GamesIncomplete", { collections: 2 })).toContain("2");
  },
);

function chapterGames(revision = "original") {
  return ["First chapter", "Second chapter"].map((pgn, index) => ({
    pgn,
    present: true,
    stamp: `${revision}-${index}`,
    revision,
    omission: null,
  }));
}

async function expandChapters(type: "game" | "repertoire" = "game") {
  mocks.listing = { data: [file("Chapters.pgn", type)], isLoading: false, error: undefined };
  mocks.count.mockResolvedValue(2);
  await render();
  await open("Chapters");
  expect(rows()[0].getAttribute("aria-expanded")).toBe("true");
  expect(mocks.openFile).not.toHaveBeenCalled();
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(2);
}

async function activateChapter(index = 1, gesture: "click" | "keyboard" = "click") {
  const chapter = host.querySelectorAll<HTMLElement>('[role="option"]')[index];
  expect(chapter).toBeTruthy();
  await act(async () => {
    if (gesture === "click") chapter.click();
    else chapter.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

test("a rejected Library count notifies and leaves its row collapsed", async () => {
  mocks.listing = { data: [file("Chapters.pgn")], isLoading: false, error: undefined };
  await render();
  const error = new Error("Count failed");
  mocks.count.mockRejectedValueOnce(error);
  await open("Chapters");
  expect(mocks.notify).toHaveBeenCalledExactlyOnceWith("Common.Error", error);
  expect(rows()[0].getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector('[role="listbox"]')).toBeNull();
  expect(mocks.openFile).not.toHaveBeenCalled();
});

test.each(["collapse", "filter", "search", "other row", "unmount"])(
  "a late count cannot expand after %s and its request is aborted",
  async (action) => {
    mocks.listing = {
      data: [file("Chapters.pgn"), file("Other.pgn")],
      isLoading: false,
      error: undefined,
    };
    await render();
    let finish!: (count: number) => void;
    mocks.count.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    await open("Chapters");
    const signal = mocks.count.mock.lastCall![1].signal as AbortSignal;
    if (action === "collapse") await open("Chapters");
    if (action === "filter") await filter("repertoires");
    if (action === "search") await search("Other");
    if (action === "other row") await open("Other");
    if (action === "unmount") await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
    await act(async () => finish(2));
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(host.querySelector('[aria-expanded="true"]')).toBeNull();
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.openFile).toHaveBeenCalledTimes(action === "other row" ? 1 : 0);
  },
);

test.each([0, 1])(
  "a file with %s games opens directly without a tab-name override",
  async (count) => {
    mocks.listing = { data: [file("Direct.pgn")], isLoading: false, error: undefined };
    mocks.count.mockResolvedValue(count);
    await render();
    await open("Direct");
    expect(mocks.openFile).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "Direct.pgn", numGames: count }),
      expect.any(Function),
      { ownerId: "home", store },
    );
    expect(rows()[0].getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  },
);

test.each(["click", "keyboard"] as const)(
  "chapter %s activation passes its index and displayed identity",
  async (gesture) => {
    await expandChapters();
    expect(
      [...host.querySelectorAll('[role="option"]')].every(
        (row) => row.getAttribute("aria-selected") === "false",
      ),
    ).toBe(true);
    expect(host.querySelector('button[aria-label="Files.RemoveGame"]')).toBeNull();
    await activateChapter(1, gesture);
    expect(mocks.openFile).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "Chapters.pgn", numGames: 2 }),
      expect.any(Function),
      {
        ownerId: "home",
        store,
        gameNumber: 1,
        expected: { stamp: "original-1", revision: "original" },
      },
    );
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/" });
  },
);

test("a Due chapter opens on Practice and clicking its expanded row collapses it", async () => {
  await expandChapters("repertoire");
  await open("Chapters");
  expect(host.querySelector('[role="listbox"]')).toBeNull();
  mocks.due["Chapters.pgn"] = { count: 3, failed: false };
  await filter("due");
  await open("Chapters");
  await activateChapter();
  expect(mocks.openFile.mock.lastCall![2]).toMatchObject({ panel: "practice", gameNumber: 1 });
});

test.each([new Error("Read failed"), new Error("Parse failed"), new StaleFileGameError()])(
  "a rejected chapter activation keeps the picker expanded: %s",
  async (error) => {
    await expandChapters();
    mocks.openFile.mockRejectedValueOnce(error);
    await activateChapter();
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith("Common.Error", error);
    expect(rows()[0].getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
  },
);

test("a stale refusal re-reads chapters and retry uses the refreshed identity", async () => {
  await expandChapters();
  mocks.readGames.mockResolvedValue(chapterGames("refreshed"));
  mocks.openFile.mockRejectedValueOnce(new StaleFileGameError());
  const reads = mocks.readGames.mock.calls.length;
  await activateChapter();
  expect(mocks.readGames.mock.calls.length).toBeGreaterThan(reads);
  expect(rows()[0].getAttribute("aria-expanded")).toBe("true");
  await activateChapter();
  expect(mocks.openFile).toHaveBeenCalledTimes(2);
  expect(mocks.openFile.mock.lastCall![2]).toMatchObject({
    gameNumber: 1,
    expected: { stamp: "refreshed-1", revision: "refreshed" },
  });
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/" });
});

test("repeated chapter gestures during a pending open create exactly one tab", async () => {
  await expandChapters();
  let finish!: () => void;
  mocks.openFile.mockImplementationOnce(
    (_file, setTabs) =>
      new Promise<string>((resolve) => {
        finish = () => {
          setTabs([
            {
              value: "opened",
              name: "Second chapter",
              type: "analysis",
              gameOrigin: { kind: "none" },
            },
          ]);
          resolve("opened");
        };
      }),
  );
  await activateChapter();
  await activateChapter(0);
  await activateChapter(1, "keyboard");
  await act(async () =>
    host
      .querySelector('[role="option"]')!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  );
  expect(mocks.openFile).toHaveBeenCalledOnce();
  await act(async () => finish());
  expect(store.get(tabsAtom)).toEqual([
    expect.objectContaining({ type: "analysis", name: "Second chapter" }),
  ]);
  expect(mocks.navigate).toHaveBeenCalledOnce();
});
