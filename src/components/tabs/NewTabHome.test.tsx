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
import NewTabHome from "./NewTabHome";

const mocks = vi.hoisted(() => ({
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
  tauri: { countPgnGames: mocks.count, getDbGame: mocks.getGame, getDbInfo: mocks.info },
}));
vi.mock("@/utils/db", async (original) => ({
  ...(await original<typeof import("@/utils/db")>()),
  query_games: mocks.query,
}));
vi.mock("@/utils/files", () => ({ openFile: mocks.openFile }));
vi.mock("@/utils/databaseGame", async (original) => ({
  ...(await original<typeof import("@/utils/databaseGame")>()),
  openDatabaseGame: mocks.openGame,
}));
vi.mock("@/components/library/openDatabaseTable", () => ({
  openDatabaseTable: mocks.openDatabase,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@/components/files/notifyError", () => ({ notifyUnlessCancelled: mocks.notify }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: unknown) => (values ? key + JSON.stringify(values) : key),
    i18n: { language: "en-US" },
  }),
}));
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
  vi.spyOn(i18n, "t").mockImplementation((...args: Parameters<typeof i18n.t>) => String(args[0]));
  localStorage.clear();
  sessionStorage.clear();
  store = createStore();
  store.set(tabsAtom, [{ value: "home", name: "Home", type: "new", gameOrigin: { kind: "none" } }]);
  mocks.listing = { data: undefined, isLoading: true, error: undefined };
  mocks.databases = { data: undefined, isLoading: false, error: undefined };
  mocks.due = {};
  mocks.feed = { games: [], loading: false, hasMore: false, incompleteCount: 0 };
  mocks.count.mockResolvedValue(1);
  mocks.openFile.mockResolvedValue("opened");
  mocks.openGame.mockResolvedValue("opened");
  mocks.info.mockResolvedValue({ status: "ready", game_count: 1, title: "Own games" });
  mocks.query.mockResolvedValue({ data: [game] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
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
    { tabName: "Recent", ownerId: "home", store },
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

test("Library listing rows let openFile derive the tab and recent name from the game", async () => {
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
