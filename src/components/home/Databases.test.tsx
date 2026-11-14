import { getDefaultStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { sessionsAtom } from "@/state/atoms";
import type { ProgressEvent } from "@/bindings";
import { sessionsSchema } from "@/utils/session";

const mocks = vi.hoisted(() => ({
  getDatabases: vi.fn(),
  query_players: vi.fn(),
  getPlayersGameInfo: vi.fn(),
  progress: vi.fn(),
  notifyListenerError: vi.fn(),
  logError: vi.fn(),
  personalCardInfo: vi.fn(),
  personalCardNotice: vi.fn(),
  setName: undefined as ((name: string) => void) | undefined,
  select: undefined as
    | {
        value?: string | null;
        data?: string[];
        onChange?: (value: string | null) => void;
      }
    | undefined,
}));

vi.mock("@/platform/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
  return {
    ...actual,
    tauri: { getPlayersGameInfo: mocks.getPlayersGameInfo },
    tauriSubscriptions: { progress: mocks.progress },
  };
});
vi.mock("@/utils/db", async () => {
  const actual = await vi.importActual<typeof import("@/utils/db")>("@/utils/db");
  return {
    ...actual,
    getDatabases: mocks.getDatabases,
    query_players: mocks.query_players,
  };
});
vi.mock("@/platform/native", () => ({ error: mocks.logError }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { databases?: string; error?: unknown }) => {
      if (options?.error !== undefined) return `${key}: ${options.error}`;
      return options?.databases ? `${key}: ${options.databases}` : key;
    },
  }),
}));
vi.mock("@/components/files/notifyError", () => ({
  notifyListenerError: mocks.notifyListenerError,
}));
vi.mock("./PersonalCard", () => ({
  default: ({
    name,
    setName,
    info,
    notice,
  }: {
    name: string;
    setName?: (name: string) => void;
    info: unknown;
    notice?: React.ReactNode;
  }) => {
    mocks.personalCardInfo(info);
    mocks.personalCardNotice(notice);
    mocks.setName = setName;
    return (
      <div>
        player-card {name}
        <span data-testid="statistics">{JSON.stringify(info)}</span>
        {notice}
      </div>
    );
  },
}));
vi.mock("lucide-react", () => ({ DatabaseX: () => null }));
vi.mock("@mantine/core", () => ({
  Alert: ({ children, title }: { children: React.ReactNode; title?: React.ReactNode }) => (
    <div role="alert">
      {title}
      {children}
    </div>
  ),
  Center: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Loader: () => null,
  Paper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Progress: ({ value }: { value: number }) => <div data-testid="progress">{value}</div>,
  Select: (props: {
    value?: string | null;
    data?: string[];
    onChange?: (value: string | null) => void;
  }) => {
    mocks.select = props;
    return null;
  },
  Stack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  ThemeIcon: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Title: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
}));

import Databases from "./Databases";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const session = {
  player: "Magnus",
  updatedAt: 1,
  lichess: {
    username: "Magnus",
    account: { id: "magnus", username: "Magnus" },
  },
};

function database(id: string) {
  return {
    type: "success" as const,
    title: id === "db-2" ? "Magnus Chess.com" : "Magnus Lichess",
    description: "",
    player_count: 1,
    event_count: 1,
    game_count: 2,
    storage_size: "1",
    filename: id === "db-2" ? "Magnus_chesscom.db3" : "Magnus_lichess.db3",
    indexed: true,
    file: { id: { id }, kind: "database" as const },
  };
}

function progressEvent(id: string, progress: number): { payload: ProgressEvent } {
  return {
    payload: {
      id,
      generation: 1n,
      progress,
      finished: false,
      state: "running",
      cleared: false,
    },
  };
}

let container: HTMLDivElement;
let root: Root;
let progressListener: (event: { payload: ProgressEvent }) => void;

async function renderDatabases() {
  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <Databases />
      </SWRConfig>,
    );
  });
}

function displayedProgress() {
  return container.textContent ?? "";
}

function exactOwnerScenario(ownerPresent = true) {
  const rows = [
    { id: 1, name: "MagnusOpponent", elo: null },
    ...(ownerPresent
      ? [
          { id: 7, name: "magnus", elo: null },
          { id: 8, name: "MAGNUS", elo: null },
          { id: 9, name: "MagNus", elo: null },
        ]
      : []),
  ];
  mocks.query_players.mockImplementation(async (_file, query) => {
    const matching = rows.filter((row) =>
      query.nameMatch === "exact"
        ? row.name.toLowerCase() === query.name.toLowerCase()
        : row.name.toLowerCase().includes(query.name.toLowerCase()),
    );
    return {
      data: query.options.pageSize ? matching.slice(0, query.options.pageSize) : matching,
      count: matching.length,
    };
  });
  mocks.getPlayersGameInfo.mockImplementation(async (_progress, _file, id) => ({
    site_stats_data: [
      {
        site: "Lichess",
        player: rows.find((row) => row.id === id)!.name,
        daily: [{ won: id, drawn: 0, lost: 0 }],
        colors: [],
        latest: [],
        openings: [{ name: `opening-${id}` }],
      },
    ],
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setName = undefined;
  mocks.select = undefined;
  localStorage.clear();
  getDefaultStore().set(sessionsAtom, [
    session,
    { player: "Magnus", updatedAt: 1, chessCom: { username: "Magnus", stats: {} } },
  ]);
  mocks.getDatabases.mockResolvedValue({
    databases: [database("db-1")],
    unread: [],
    root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
  });
  mocks.query_players.mockResolvedValue({
    data: [{ id: 7, name: "Magnus", elo: null }],
    count: 1,
  });
  mocks.getPlayersGameInfo.mockReturnValue(new Promise(() => undefined));
  mocks.progress.mockImplementation(async (listener: typeof progressListener) => {
    progressListener = listener;
    return () => undefined;
  });
  mocks.logError.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test("exact account lookup combines every casing variant under session spelling and excludes an earlier opponent", async () => {
  exactOwnerScenario();
  await renderDatabases();
  await vi.waitFor(() => expect(mocks.personalCardInfo).toHaveBeenCalled());
  expect(mocks.getPlayersGameInfo.mock.calls.map((call) => call[2])).toEqual([7, 8, 9]);
  const calls = mocks.getPlayersGameInfo.mock.calls;
  expect(new Set(calls.map((call) => call[0])).size).toBe(3);
  expect(calls.every((call) => call[3].signal === calls[0][3].signal)).toBe(true);
  expect(mocks.personalCardInfo).toHaveBeenLastCalledWith({
    site_stats_data: [7, 8, 9].map((id) => ({
      site: "Lichess",
      player: "Magnus",
      daily: [{ won: id, drawn: 0, lost: 0 }],
      colors: [],
      latest: [],
      openings: [{ name: `opening-${id}` }],
    })),
  });
  expect(container.textContent).toContain('"won":9');
  expect(container.textContent).not.toContain("MagnusOpponent");
  expect(container.textContent).not.toContain('"player":"MAGNUS"');
});

test("a large owner response preserves all 200000 distinct site groups under session spelling", async () => {
  const groupCount = 200_000;
  mocks.query_players.mockResolvedValue({
    data: [{ id: 7, name: "MAGNUS", elo: null }],
    count: 1,
  });
  mocks.getPlayersGameInfo.mockResolvedValue({
    site_stats_data: Array.from({ length: groupCount }, (_, index) => ({
      site: `https://example.com/game/${index}`,
      player: "MAGNUS",
      daily: [],
      colors: [],
      latest: [],
      openings: [],
    })),
  });

  await renderDatabases();

  const groups = mocks.personalCardInfo.mock.lastCall?.[0]?.site_stats_data ?? [];
  expect(groups.length).toBe(groupCount);
  expect(groups[0].site).toBe("https://example.com/game/0");
  expect(groups.at(-1).site).toBe("https://example.com/game/199999");
  expect(
    groups.filter((group: { player: string }) => group.player !== session.lichess.username).length,
  ).toBe(0);
});

test("an absent exact owner with only a substring opponent contributes no statistics or warning", async () => {
  exactOwnerScenario(false);
  await renderDatabases();
  await vi.waitFor(() => expect(container.textContent).toContain("Home.Databases.Empty.Title"));
  expect(mocks.getPlayersGameInfo).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(mocks.logError).not.toHaveBeenCalled();
});

test("abort while a casing variant is held prevents later reads and publication", async () => {
  exactOwnerScenario();
  const original = mocks.getPlayersGameInfo.getMockImplementation()!;
  let release!: (value: unknown) => void;
  mocks.getPlayersGameInfo.mockImplementation((progress, file, id, options) =>
    id === 8
      ? new Promise((resolve) => {
          release = resolve;
        })
      : original(progress, file, id, options),
  );
  await renderDatabases();
  await vi.waitFor(() => expect(mocks.getPlayersGameInfo).toHaveBeenCalledTimes(2));
  const signal = mocks.getPlayersGameInfo.mock.calls[1][3].signal;
  await act(async () => root.render(null));
  expect(signal.aborted).toBe(true);
  await act(async () => release({ site_stats_data: [] }));
  expect(mocks.getPlayersGameInfo.mock.calls.map((call) => call[2])).toEqual([7, 8]);
  expect(mocks.personalCardInfo).not.toHaveBeenCalled();
  expect(mocks.logError).not.toHaveBeenCalled();
});

test("a later casing variant failure discards that database and preserves its named warning and successful sibling", async () => {
  exactOwnerScenario();
  mocks.getDatabases.mockResolvedValue({
    databases: [database("db-1"), database("db-2")],
    unread: [],
    root: { id: { id: "root" }, kind: "databaseRoot" },
  });
  const original = mocks.getPlayersGameInfo.getMockImplementation()!;
  const sibling = {
    site: "Chess.com",
    player: "Magnus",
    daily: [{ won: 42 }],
    colors: [],
    latest: [],
    openings: [],
  };
  mocks.getPlayersGameInfo.mockImplementation(async (progress, file, id, options) => {
    if (file.id.id === "db-2") return { site_stats_data: id === 7 ? [sibling] : [] };
    if (id === 8) throw new Error("later variant unreadable");
    return original(progress, file, id, options);
  });
  await renderDatabases();
  await vi.waitFor(() =>
    expect(container.textContent).toContain("Home.Databases.Incomplete.Title"),
  );
  expect(mocks.personalCardInfo).toHaveBeenLastCalledWith({ site_stats_data: [sibling] });
  expect(container.textContent).toContain('"won":42');
  expect(container.textContent).not.toContain('"won":7');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Magnus Lichess");
  expect(container.querySelector('[role="alert"]')?.textContent).not.toContain("Magnus Chess.com");
});

test("a ProgressEvent under the id passed to getPlayersGameInfo moves the bar", async () => {
  await renderDatabases();
  await vi.waitFor(() => expect(mocks.getPlayersGameInfo).toHaveBeenCalled());
  const ownedId = mocks.getPlayersGameInfo.mock.calls[0][0] as string;
  expect(ownedId).toEqual(expect.any(String));

  await act(async () => {
    progressListener(progressEvent(ownedId, 40));
  });

  expect(displayedProgress()).toContain("40%");
  expect(container.querySelector("[data-testid='progress']")?.textContent).toBe("40");
});

test("an adapter decoding error notifies only while mounted and leaves progress unchanged", async () => {
  let reportError: ((error: unknown, event: { payload: unknown }) => void) | undefined;
  const unlisten = vi.fn();
  mocks.progress.mockImplementation(async (listener: typeof progressListener, onError) => {
    progressListener = listener;
    reportError = onError;
    return unlisten;
  });
  await renderDatabases();
  await vi.waitFor(() => expect(mocks.getPlayersGameInfo).toHaveBeenCalled());
  const ownedId = mocks.getPlayersGameInfo.mock.calls[0][0] as string;
  await act(async () => progressListener(progressEvent(ownedId, 40)));
  const error = new TypeError("generation must be a canonical unsigned u64 decimal string");
  const malformed = { payload: { id: ownedId, generation: "01", progress: 99 } };

  // The adapter drops the frame and reports its decoding error through the supplied callback.
  await act(async () => reportError?.(error, malformed));
  expect(mocks.notifyListenerError).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ message: error.message }),
    malformed,
  );
  expect(container.querySelector("[data-testid='progress']")?.textContent).toBe("40");
  expect(displayedProgress()).not.toContain("99%");

  await act(async () => root.render(null));
  expect(unlisten).toHaveBeenCalledOnce();
  await act(async () => {
    reportError?.(error, malformed);
    progressListener(progressEvent(ownedId, 99));
  });
  expect(mocks.notifyListenerError).toHaveBeenCalledOnce();
  expect(container.textContent).toBe("");
});

test("an owned ProgressEvent moves the bar when another player's database is present", async () => {
  getDefaultStore().set(sessionsAtom, [
    {
      player: "Bob",
      updatedAt: 1,
      lichess: { username: "bob", account: { id: "bob", username: "bob" } },
    },
    {
      player: "Alice",
      updatedAt: 1,
      chessCom: { username: "alice", stats: {} },
    },
  ]);
  const bobDatabase = { ...database("db-1"), filename: "bob_lichess.db3" };
  const aliceDatabase = { ...database("db-2"), filename: "alice_chesscom.db3" };
  mocks.getDatabases.mockResolvedValue({
    databases: [bobDatabase, aliceDatabase],
    unread: [],
    root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
  });

  await renderDatabases();
  await vi.waitFor(() => expect(mocks.getPlayersGameInfo).toHaveBeenCalledOnce());
  const ownedId = mocks.getPlayersGameInfo.mock.calls[0][0] as string;
  expect(mocks.getPlayersGameInfo).toHaveBeenCalledWith(
    ownedId,
    bobDatabase.file,
    7,
    expect.anything(),
  );
  expect(displayedProgress()).toContain("0%");

  await act(async () => {
    progressListener(progressEvent(ownedId, 40));
  });

  expect(displayedProgress()).toContain("40%");
  expect(container.querySelector("[data-testid='progress']")?.textContent).toBe("40");
});

test("a ProgressEvent under a foreign PlayerCard id does not move the bar", async () => {
  await renderDatabases();
  await vi.waitFor(() => expect(mocks.getPlayersGameInfo).toHaveBeenCalled());
  const ownedId = mocks.getPlayersGameInfo.mock.calls[0][0] as string;

  await act(async () => {
    progressListener(progressEvent("player-card-foreign", 90));
  });
  expect(displayedProgress()).toContain("0%");
  expect(displayedProgress()).not.toContain("90%");

  await act(async () => {
    progressListener(progressEvent(ownedId, 40));
  });
  expect(displayedProgress()).toContain("40%");
});

test("two owned ids average", async () => {
  mocks.getDatabases.mockResolvedValue({
    databases: [database("db-1"), database("db-2")],
    unread: [],
    root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
  });
  mocks.getPlayersGameInfo
    .mockResolvedValueOnce({ site_stats_data: [] })
    .mockReturnValueOnce(new Promise(() => undefined));
  await renderDatabases();
  await vi.waitFor(() => expect(mocks.getPlayersGameInfo).toHaveBeenCalledTimes(2));
  const firstId = mocks.getPlayersGameInfo.mock.calls[0][0] as string;
  const secondId = mocks.getPlayersGameInfo.mock.calls[1][0] as string;
  expect(firstId).not.toBe(secondId);

  await act(async () => {
    progressListener(progressEvent(firstId, 20));
    progressListener(progressEvent(secondId, 80));
  });

  expect(displayedProgress()).toContain("50%");
});

test("merges aggregate records from two databases without dropping duplicate keys", async () => {
  const firstRecord = {
    site: "Lichess",
    player: "Magnus",
    daily: [
      {
        date: "2026.09.01",
        time_control: "600+0",
        won: 2,
        drawn: 1,
        lost: 0,
        max_player_elo: 2_850,
      },
    ],
    colors: [
      {
        time_control: "600+0",
        is_player_white: true,
        won: 2,
        drawn: 1,
        lost: 0,
        rated_won: 2,
        rated_drawn: 1,
        rated_lost: 0,
        opponent_elo_sum: 8_400,
      },
    ],
    latest: [
      {
        time_control: "600+0",
        date: "2026.09.01",
        time: "12:00:00",
        game_id: 1,
        player_elo: 2_840,
      },
    ],
    openings: [
      {
        time_control: "600+0",
        is_player_white: true,
        opening: "Sicilian Defense",
        won: 2,
        drawn: 1,
        lost: 0,
      },
    ],
  };
  const secondRecord = {
    site: "Lichess",
    player: "Magnus",
    daily: [
      {
        date: "2026.09.01",
        time_control: "600+0",
        won: 1,
        drawn: 0,
        lost: 2,
        max_player_elo: 2_860,
      },
    ],
    colors: [
      {
        time_control: "600+0",
        is_player_white: true,
        won: 1,
        drawn: 0,
        lost: 2,
        rated_won: 1,
        rated_drawn: 0,
        rated_lost: 1,
        opponent_elo_sum: 5_500,
      },
    ],
    latest: [
      {
        time_control: "600+0",
        date: "2026.09.01",
        time: null,
        game_id: 2,
        player_elo: 2_860,
      },
    ],
    openings: [
      {
        time_control: "600+0",
        is_player_white: true,
        opening: "Sicilian Defense",
        won: 1,
        drawn: 0,
        lost: 2,
      },
    ],
  };
  mocks.getDatabases.mockResolvedValue({
    databases: [database("db-1"), database("db-2")],
    unread: [],
    root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
  });
  mocks.getPlayersGameInfo
    .mockResolvedValueOnce({ site_stats_data: [firstRecord] })
    .mockResolvedValueOnce({ site_stats_data: [secondRecord] });

  await renderDatabases();
  await vi.waitFor(() => expect(mocks.personalCardInfo).toHaveBeenCalled());

  expect(mocks.personalCardInfo).toHaveBeenLastCalledWith({
    site_stats_data: [firstRecord, secondRecord],
  });
  expect(mocks.personalCardNotice).toHaveBeenLastCalledWith(undefined);
  expect(container.querySelector("[role='alert']")).toBeNull();
});

test("a ProgressEvent under an id registered by the original fetcher still moves the bar after unmount and remount", async () => {
  const cache = new Map();
  const swrConfig = { provider: () => cache };

  async function renderDatabasesMounted(mounted: boolean) {
    await act(async () => {
      root.render(<SWRConfig value={swrConfig}>{mounted ? <Databases /> : null}</SWRConfig>);
    });
  }

  await renderDatabasesMounted(true);
  await vi.waitFor(() => expect(mocks.getPlayersGameInfo).toHaveBeenCalled());
  const ownedId = mocks.getPlayersGameInfo.mock.calls[0][0] as string;

  await renderDatabasesMounted(false);
  await renderDatabasesMounted(true);

  expect(mocks.getPlayersGameInfo).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(displayedProgress()).toContain("0%"));

  await act(async () => {
    progressListener(progressEvent(ownedId, 40));
  });

  expect(displayedProgress()).toContain("40%");
  expect(container.querySelector("[data-testid='progress']")?.textContent).toBe("40");
});

test("a foreign event arriving before any id is registered renders 0% not NaN%", async () => {
  let resolvePlayers!: (value: {
    data: Array<{ id: number; name: string; elo: null }>;
    count: number;
  }) => void;
  mocks.query_players.mockReturnValue(
    new Promise((resolve) => {
      resolvePlayers = resolve;
    }),
  );
  await renderDatabases();
  await vi.waitFor(() => expect(mocks.query_players).toHaveBeenCalled());
  expect(mocks.getPlayersGameInfo).not.toHaveBeenCalled();

  await act(async () => {
    progressListener(progressEvent("player-card-foreign", 75));
  });

  expect(displayedProgress()).toContain("0%");
  expect(displayedProgress()).not.toContain("NaN");
  expect(displayedProgress()).not.toContain("75%");

  resolvePlayers({ data: [{ id: 7, name: "Magnus", elo: null }], count: 1 });
});

test("unmount while query_players is held cancels it and admits no info or later pair", async () => {
  mocks.getDatabases.mockResolvedValue({
    databases: [database("db-1"), database("db-2")],
    unread: [],
    root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
  });
  let querySignal!: AbortSignal;
  mocks.query_players.mockImplementation(
    (_file: unknown, _query: unknown, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        querySignal = options.signal;
        querySignal.addEventListener(
          "abort",
          () => reject(new DOMException("Cancellation", "AbortError")),
          { once: true },
        );
      }),
  );
  await renderDatabases();
  await vi.waitFor(() => expect(mocks.query_players).toHaveBeenCalledOnce());
  await act(async () => root.render(null));
  await vi.waitFor(() => expect(querySignal.aborted).toBe(true));
  expect(mocks.getPlayersGameInfo).not.toHaveBeenCalled();
  expect(mocks.query_players).toHaveBeenCalledOnce();
  expect(mocks.logError).not.toHaveBeenCalled();
});

test("unmount while getPlayersGameInfo is held cancels it and admits no subsequent pair", async () => {
  mocks.getDatabases.mockResolvedValue({
    databases: [database("db-1"), database("db-2")],
    unread: [],
    root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
  });
  mocks.query_players.mockResolvedValue({
    data: [{ id: 7, name: "Magnus", elo: null }],
    count: 1,
  });
  let infoSignal!: AbortSignal;
  mocks.getPlayersGameInfo.mockImplementation(
    (_progress: unknown, _file: unknown, _id: unknown, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        infoSignal = options.signal;
        infoSignal.addEventListener(
          "abort",
          () => reject(new DOMException("Cancellation", "AbortError")),
          { once: true },
        );
      }),
  );
  await renderDatabases();
  await vi.waitFor(() => expect(mocks.getPlayersGameInfo).toHaveBeenCalledOnce());
  await act(async () => root.render(null));
  await vi.waitFor(() => expect(infoSignal.aborted).toBe(true));
  expect(mocks.query_players).toHaveBeenCalledOnce();
  expect(mocks.getPlayersGameInfo).toHaveBeenCalledOnce();
  expect(mocks.logError).not.toHaveBeenCalled();
});

test("ordinary failed personal item retains successful sibling and reports a diagnostic", async () => {
  mocks.getDatabases.mockResolvedValue({
    databases: [database("db-1"), database("db-2")],
    unread: [],
    root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
  });
  mocks.query_players
    .mockRejectedValueOnce(new Error("player lookup failed"))
    .mockResolvedValueOnce({ data: [{ id: 8, name: "Magnus", elo: null }], count: 1 });
  mocks.getPlayersGameInfo.mockResolvedValue({ site_stats_data: [] });
  await renderDatabases();
  await vi.waitFor(() => expect(mocks.query_players).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(mocks.getPlayersGameInfo).toHaveBeenCalledOnce());
  expect(mocks.logError).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("Home.Databases.Incomplete.Title");
  expect(container.textContent).toContain("Magnus Lichess");
  expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining("(Magnus Lichess)"));
});

test.each([1, 2])(
  "unread account candidates remain visibly unavailable (%i rows)",
  async (count) => {
    mocks.getDatabases.mockResolvedValue({
      databases: [],
      unread: Array.from({ length: count }, () => ({
        filename: "Magnus_lichess.db3",
        error: "ChessRiddle Studio is not allowed to read this database file",
      })),
      root: { id: { id: "account-root" }, kind: "databaseRoot" },
    });
    await renderDatabases();
    await vi.waitFor(() => expect(container.textContent).toContain("Home.Databases.Failed.Title"));
    expect(container.textContent).toContain("Magnus_lichess.db3");
    expect(
      container.textContent?.includes(
        "ChessRiddle Studio is not allowed to read this database file",
      ),
    ).toBe(count === 1);
    expect(mocks.query_players).not.toHaveBeenCalled();
  },
);

test("a failed statistics read visibly marks partial statistics and retains only the healthy records", async () => {
  const firstRecord = {
    site: "Lichess",
    player: "Magnus",
    daily: [],
    colors: [],
    latest: [],
    openings: [],
  };
  mocks.getDatabases.mockResolvedValue({
    databases: [Object.freeze(database("db-1")), Object.freeze(database("db-2"))],
    unread: [],
    root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
  });
  mocks.getPlayersGameInfo
    .mockResolvedValueOnce({ site_stats_data: [firstRecord] })
    .mockRejectedValueOnce(new Error("statistics unreadable"));
  await renderDatabases();
  await vi.waitFor(() =>
    expect(container.textContent).toContain("Home.Databases.Incomplete.Title"),
  );
  expect(container.textContent).toContain("Magnus Chess.com");
  expect(mocks.personalCardInfo).toHaveBeenLastCalledWith({ site_stats_data: [firstRecord] });
  expect(mocks.personalCardNotice).toHaveBeenLastCalledWith(expect.anything());
  expect(mocks.logError).toHaveBeenCalledOnce();
  expect(mocks.logError).toHaveBeenCalledWith(
    "personal database summary item 1 (Magnus Chess.com) failed: statistics unreadable",
  );
});

test("all failed statistics reads render every failed name instead of no games", async () => {
  mocks.getDatabases.mockResolvedValue({
    databases: [database("db-1"), database("db-2")],
    unread: [],
    root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
  });
  mocks.getPlayersGameInfo.mockRejectedValue(new Error("statistics unreadable"));
  await renderDatabases();
  await vi.waitFor(() => expect(container.textContent).toContain("Home.Databases.Failed.Title"));
  expect(container.textContent).toContain("Magnus Lichess, Magnus Chess.com");
  expect(container.textContent).not.toContain("Home.Databases.Empty.Title");
  expect(mocks.personalCardInfo).not.toHaveBeenCalled();
  expect(mocks.logError).toHaveBeenCalledTimes(2);
});

test("a missing player is an empty contribution without a notice or diagnostic", async () => {
  mocks.query_players.mockResolvedValue({ data: [], count: 0 });
  await renderDatabases();
  await vi.waitFor(() => expect(container.textContent).toContain("Home.Databases.Empty.Title"));
  expect(container.querySelector("[role='alert']")).toBeNull();
  expect(mocks.getPlayersGameInfo).not.toHaveBeenCalled();
  expect(mocks.logError).not.toHaveBeenCalled();
});

function metadataError(id: string) {
  const { file, filename } = database(id);
  return { type: "error" as const, file, filename, indexed: false, error: "unreadable" };
}

test.each(["upgrading", "busy"] as const)(
  "a %s row is omitted from unreadable statistics while healthy siblings remain usable",
  async (transient) => {
    const record = { site: "Lichess", player: "Magnus", daily: [], openings: [] };
    mocks.getDatabases.mockResolvedValue({
      databases: [database("db-1"), { ...metadataError("db-2"), transient }],
      unread: [],
      root: { id: { id: "transient-root" }, kind: "databaseRoot" },
    });
    mocks.getPlayersGameInfo.mockResolvedValue({ site_stats_data: [record] });
    await renderDatabases();
    await vi.waitFor(() =>
      expect(mocks.personalCardInfo).toHaveBeenLastCalledWith({ site_stats_data: [record] }),
    );
    expect(mocks.query_players).toHaveBeenCalledOnce();
    expect(mocks.getPlayersGameInfo).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain("Magnus_chesscom.db3");
    expect(mocks.personalCardNotice).toHaveBeenLastCalledWith(undefined);
    expect(mocks.logError).not.toHaveBeenCalled();
  },
);

test("a metadata failure names its filename beside the healthy statistics without another log", async () => {
  const firstRecord = {
    site: "Lichess",
    player: "Magnus",
    daily: [],
    colors: [],
    latest: [],
    openings: [],
  };
  mocks.getDatabases.mockResolvedValue({
    databases: [database("db-1"), metadataError("db-2")],
    unread: [],
    root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
  });
  mocks.getPlayersGameInfo.mockResolvedValue({ site_stats_data: [firstRecord] });
  await renderDatabases();
  await vi.waitFor(() =>
    expect(container.textContent).toContain("Home.Databases.Incomplete.Title"),
  );
  expect(container.textContent).toContain("Magnus_chesscom.db3");
  expect(mocks.personalCardInfo).toHaveBeenLastCalledWith({ site_stats_data: [firstRecord] });
  expect(mocks.getPlayersGameInfo).toHaveBeenCalledOnce();
  expect(mocks.logError).not.toHaveBeenCalled();
});

test("only metadata failures render the failed state and every filename without another log", async () => {
  mocks.getDatabases.mockResolvedValue({
    databases: [metadataError("db-1"), metadataError("db-2")],
    unread: [],
    root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
  });
  await renderDatabases();
  await vi.waitFor(() => expect(container.textContent).toContain("Home.Databases.Failed.Title"));
  expect(container.textContent).toContain("Magnus_lichess.db3, Magnus_chesscom.db3");
  expect(container.textContent).not.toContain("Home.Databases.Empty.Title");
  expect(mocks.query_players).not.toHaveBeenCalled();
  expect(mocks.getPlayersGameInfo).not.toHaveBeenCalled();
  expect(mocks.logError).not.toHaveBeenCalled();
});

test("an imported database with an account title or username substring is excluded", async () => {
  mocks.getDatabases.mockResolvedValue({
    databases: [{ ...database("db-1"), filename: "OtherMagnus_lichess.db3" }],
    unread: [],
    root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
  });
  await renderDatabases();
  await vi.waitFor(() => expect(container.textContent).toContain("Home.Databases.Empty.Title"));
  expect(mocks.query_players).not.toHaveBeenCalled();
  expect(mocks.logError).not.toHaveBeenCalled();
});

test("a renamed account database remains included by filename with the owning username", async () => {
  getDefaultStore().set(sessionsAtom, [
    { ...session, player: "Player alias", lichess: { ...session.lichess, username: "magnus" } },
  ]);
  mocks.getDatabases.mockResolvedValue({
    databases: [
      Object.freeze({
        ...database("db-1"),
        filename: "Magnus_lichess.db3",
        title: "My downloaded games",
      }),
    ],
    unread: [],
    root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
  });
  mocks.getPlayersGameInfo.mockResolvedValue({ site_stats_data: [] });
  await renderDatabases();
  await vi.waitFor(() => expect(mocks.personalCardInfo).toHaveBeenCalled());
  expect(mocks.query_players).toHaveBeenCalledWith(
    database("db-1").file,
    expect.objectContaining({ name: "magnus" }),
    expect.anything(),
  );
  expect(container.textContent).toContain("Player alias");
  expect(container.querySelector("[role='alert']")).toBeNull();
});

test("the default player uses the session username when account username casing differs", async () => {
  getDefaultStore().set(sessionsAtom, [
    {
      updatedAt: 1,
      lichess: { username: "magnus", account: { id: "magnus", username: "Magnus" } },
    },
  ]);
  const accountDatabase = { ...database("db-1"), filename: "Magnus_lichess.db3" };
  const record = {
    site: "Lichess",
    player: "Magnus",
    daily: [],
    colors: [],
    latest: [],
    openings: [],
  };
  mocks.getDatabases.mockResolvedValue({
    databases: [accountDatabase],
    unread: [],
    root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
  });
  mocks.getPlayersGameInfo.mockResolvedValue({ site_stats_data: [record] });

  await renderDatabases();
  await vi.waitFor(() => expect(mocks.personalCardInfo).toHaveBeenCalled());

  expect(accountDatabase.filename).toBe("Magnus_lichess.db3");
  expect(mocks.personalCardInfo).toHaveBeenLastCalledWith({
    site_stats_data: [{ ...record, player: "magnus" }],
  });
  expect(mocks.query_players).toHaveBeenCalledWith(
    accountDatabase.file,
    expect.objectContaining({ name: "magnus" }),
    expect.anything(),
  );
  expect(mocks.getPlayersGameInfo).toHaveBeenCalledWith(
    expect.any(String),
    accountDatabase.file,
    7,
    expect.anything(),
  );
});

test.each([false, true])(
  "the selected player excludes another player's matching account username (statistics fail: %s)",
  async (statisticsFail) => {
    getDefaultStore().set(sessionsAtom, [
      {
        player: "bob",
        updatedAt: 1,
        lichess: { username: "carol", account: { id: "carol", username: "carol" } },
      },
      {
        player: "Alice",
        updatedAt: 1,
        lichess: { username: "bob", account: { id: "bob", username: "bob" } },
      },
    ]);
    const aliceDatabase = { ...database("db-1"), title: "", filename: "bob_lichess.db3" };
    const bobDatabase = { ...database("db-2"), title: "", filename: "carol_lichess.db3" };
    const aliceRecord = {
      site: "Lichess",
      player: "bob",
      daily: [],
      colors: [],
      latest: [],
      openings: [],
    };
    const bobRecord = {
      site: "Lichess",
      player: "carol",
      daily: [],
      colors: [],
      latest: [],
      openings: [],
    };
    mocks.getDatabases.mockResolvedValue({
      databases: [aliceDatabase, bobDatabase],
      unread: [],
      root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
    });
    mocks.getPlayersGameInfo.mockImplementation(async (_progress, file) => {
      if (file.id.id === "db-1") {
        return { site_stats_data: [aliceRecord] };
      }
      if (statisticsFail) {
        throw new Error("statistics unreadable");
      }
      return { site_stats_data: [bobRecord] };
    });

    await renderDatabases();
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        statisticsFail ? "Home.Databases.Failed.Title" : "player-card",
      ),
    );
    expect(mocks.personalCardInfo.mock.lastCall?.[0]).toEqual(
      statisticsFail ? undefined : { site_stats_data: [bobRecord] },
    );
    expect(mocks.personalCardNotice.mock.lastCall?.[0]).toBeUndefined();
    expect(container.querySelector("[role='alert']")?.textContent ?? "").toBe(
      statisticsFail ? "Home.Databases.Incomplete.Description: carol_lichess.db3" : "",
    );
    expect(container.textContent).not.toContain("bob_lichess.db3");
    expect(mocks.query_players).toHaveBeenCalledOnce();
    expect(mocks.query_players).toHaveBeenCalledWith(
      bobDatabase.file,
      expect.objectContaining({ name: "carol" }),
      expect.anything(),
    );
    expect(mocks.query_players).not.toHaveBeenCalledWith(
      aliceDatabase.file,
      expect.anything(),
      expect.anything(),
    );
  },
);

test("changing session membership refetches the selected player's summary with unchanged databases", async () => {
  const bobSession = {
    player: "Bob",
    updatedAt: 1,
    lichess: { username: "bob", account: { id: "bob", username: "bob" } },
  };
  const aliceSession = {
    player: "Alice",
    updatedAt: 1,
    chessCom: { username: "alice", stats: {} },
  };
  getDefaultStore().set(sessionsAtom, [bobSession, aliceSession]);
  const bobDatabase = { ...database("db-1"), filename: "bob_lichess.db3" };
  const aliceDatabase = { ...database("db-2"), filename: "alice_chesscom.db3" };
  const bobRecord = {
    site: "Lichess",
    player: "bob",
    daily: [],
    colors: [],
    latest: [],
    openings: [],
  };
  const aliceRecord = {
    site: "Chess.com",
    player: "alice",
    daily: [],
    colors: [],
    latest: [],
    openings: [],
  };
  mocks.getDatabases.mockResolvedValue({
    databases: [bobDatabase, aliceDatabase],
    unread: [],
    root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
  });
  mocks.getPlayersGameInfo.mockImplementation(async (_progress, file) => ({
    site_stats_data: [file.id.id === "db-1" ? bobRecord : aliceRecord],
  }));

  await renderDatabases();
  await vi.waitFor(() => expect(mocks.personalCardInfo).toHaveBeenCalled());
  expect(mocks.personalCardInfo).toHaveBeenLastCalledWith({ site_stats_data: [bobRecord] });
  expect(mocks.getPlayersGameInfo).toHaveBeenCalledOnce();
  expect(mocks.getPlayersGameInfo).toHaveBeenCalledWith(
    expect.any(String),
    bobDatabase.file,
    7,
    expect.anything(),
  );

  await act(async () => {
    getDefaultStore().set(sessionsAtom, [bobSession, { ...aliceSession, player: "Bob" }]);
  });
  await vi.waitFor(() => expect(mocks.getDatabases).toHaveBeenCalledTimes(2));
  await vi.waitFor(() =>
    expect(mocks.personalCardInfo).toHaveBeenLastCalledWith({
      site_stats_data: [bobRecord, aliceRecord],
    }),
  );
  expect(mocks.getPlayersGameInfo).toHaveBeenCalledTimes(3);
  expect(mocks.getPlayersGameInfo).toHaveBeenCalledWith(
    expect.any(String),
    aliceDatabase.file,
    7,
    expect.anything(),
  );
  expect(mocks.personalCardNotice).toHaveBeenLastCalledWith(undefined);
});

test("a database listing failure renders a diagnostic-free message and logs the failure", async () => {
  mocks.getDatabases.mockRejectedValue(new Error("database workspace unavailable"));

  await renderDatabases();
  await vi.waitFor(() => expect(container.textContent).not.toBe(""));

  expect(container.textContent).not.toContain("database workspace unavailable");
  expect(container.textContent).not.toContain("Home.Databases.ErrorLoading");
  expect(container.textContent).toContain("Home.Databases.Failed.Title");
  expect(mocks.logError).toHaveBeenCalledOnce();
  expect(mocks.logError).toHaveBeenCalledWith(
    expect.stringContaining("personal database listing failed: database workspace unavailable"),
  );

  expect(mocks.query_players).not.toHaveBeenCalled();
  expect(mocks.getPlayersGameInfo).not.toHaveBeenCalled();
  expect(mocks.personalCardInfo).not.toHaveBeenCalled();
});

test("a cancelled database listing logs nothing", async () => {
  mocks.getDatabases.mockRejectedValue(new DOMException("Cancellation", "AbortError"));

  await renderDatabases();
  await vi.waitFor(() => expect(container.textContent).toContain("Home.Databases.Failed.Title"));

  expect(mocks.logError).not.toHaveBeenCalled();
});

test("an aborted database listing logs no late failure", async () => {
  let listingSignal!: AbortSignal;
  mocks.getDatabases.mockImplementation(
    ({ signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        listingSignal = signal;
        signal.addEventListener(
          "abort",
          () => reject(new Error("database workspace unavailable")),
          { once: true },
        );
      }),
  );

  await renderDatabases();
  await vi.waitFor(() => expect(mocks.getDatabases).toHaveBeenCalledOnce());
  await act(async () => root.render(null));

  expect(listingSignal.aborted).toBe(true);
  expect(mocks.logError).not.toHaveBeenCalled();
});

test("a username-less session does not prevent a healthy account summary from loading", async () => {
  getDefaultStore().set(sessionsAtom, [{ player: "Magnus", updatedAt: 1 }, session]);
  const record = {
    site: "Lichess",
    player: "Magnus",
    daily: [],
    colors: [],
    latest: [],
    openings: [],
  };
  mocks.getPlayersGameInfo.mockResolvedValue({ site_stats_data: [record] });

  await renderDatabases();
  await vi.waitFor(() => expect(mocks.personalCardInfo).toHaveBeenCalled());

  expect(container.textContent).toContain("player-card");
  expect(mocks.personalCardInfo).toHaveBeenLastCalledWith({ site_stats_data: [record] });
  expect(mocks.query_players).toHaveBeenCalledWith(
    database("db-1").file,
    expect.objectContaining({ name: "Magnus" }),
    expect.anything(),
  );
  expect(mocks.logError).not.toHaveBeenCalled();
});

test.each([false, true])(
  "linked summaries group Coach's provider accounts independently of usernames (failed sibling: %s)",
  async (failedSibling) => {
    getDefaultStore().set(sessionsAtom, [
      {
        player: "Coach",
        updatedAt: 1,
        lichess: { username: "felix", account: { id: "felix", username: "Felix" } },
      },
      { player: "Coach", updatedAt: 1, chessCom: { username: "FELIX", stats: {} } },
      { player: "Other", updatedAt: 1, chessCom: { username: "Coach", stats: {} } },
    ]);
    const linked = (id: string, provider: "lichess" | "chesscom", account: string) => ({
      ...database(id),
      filename: `${id} history`,
      collection: {
        id,
        name: `${id} history`,
        file: { id: { id: `${id}-source` }, kind: "fileWorkspace" as const },
        database: database(id).file,
        account: { provider, account },
        status: "ready" as const,
        generation: "current",
        omitted: 0,
        retiredDatabase: null,
        fetchSinceMs: null,
      },
    });
    const lichess = linked("coach-lichess", "lichess", "fELix");
    const chesscom = linked("coach-chesscom", "chesscom", "felix");
    const other = linked("other-chesscom", "chesscom", "coach");
    const failed = {
      ...chesscom,
      type: "error" as const,
      error: "Index unavailable",
    };
    mocks.getDatabases.mockResolvedValue({
      databases: [other, lichess, failedSibling ? failed : chesscom],
      unread: [],
      root: { id: { id: "linked-root" }, kind: "databaseRoot" },
    });
    const lichessRecord = {
      site: "Lichess",
      player: "Felix",
      daily: [],
      colors: [],
      latest: [],
      openings: [],
    };
    const chesscomRecord = {
      site: "Chess.com",
      player: "FELIX",
      daily: [],
      colors: [],
      latest: [],
      openings: [],
    };
    mocks.getPlayersGameInfo.mockImplementation(async (_progress, file) => ({
      site_stats_data: [file.id.id === "coach-lichess" ? lichessRecord : chesscomRecord],
    }));

    await renderDatabases();
    await vi.waitFor(() =>
      expect(mocks.personalCardInfo).toHaveBeenLastCalledWith({
        site_stats_data: failedSibling
          ? [{ ...lichessRecord, player: "felix" }]
          : [{ ...lichessRecord, player: "felix" }, chesscomRecord],
      }),
    );
    expect(mocks.query_players).toHaveBeenCalledTimes(failedSibling ? 1 : 2);
    expect(
      mocks.query_players.mock.calls.map(([file, query]) => ({ file, name: query.name })),
    ).toEqual(
      failedSibling
        ? [{ file: lichess.file, name: "felix" }]
        : [
            { file: lichess.file, name: "felix" },
            { file: chesscom.file, name: "FELIX" },
          ],
    );
    expect(mocks.query_players).not.toHaveBeenCalledWith(
      other.file,
      expect.anything(),
      expect.anything(),
    );
    expect(container.textContent?.includes("Home.Databases.Incomplete.Title")).toBe(failedSibling);
    expect(container.textContent?.includes("coach-chesscom history")).toBe(failedSibling);
    expect(container.textContent).not.toContain("other-chesscom history");
    expect(mocks.logError).not.toHaveBeenCalled();
  },
);

test.each(
  [{}, { perfs: { blitz: { games: 2 } } }, { username: "other-player" }].flatMap((profile) =>
    [false, true].map((failed) => ({ profile, failed })),
  ),
)(
  "Home resolves canonical Lichess history with cache $profile and linked error $failed",
  async ({ profile, failed }) => {
    getDefaultStore().set(
      sessionsAtom,
      sessionsSchema.parse([
        { player: "Coach", updatedAt: 1, lichess: { username: "e2e-player", account: profile } },
        { player: "Coach", updatedAt: 1, chessCom: { username: "e2e-player", stats: {} } },
        { player: "Other", updatedAt: 1, lichess: { username: "other-player", account: {} } },
      ]),
    );
    const canonical = {
      ...database("canonical"),
      filename: "Canonical linked history",
      collection: {
        id: "canonical",
        name: "Canonical linked history",
        file: { id: { id: "canonical-source" }, kind: "fileWorkspace" as const },
        database: database("canonical").file,
        account: { provider: "lichess", account: "e2e-player" },
        status: "ready" as const,
        generation: "current",
        omitted: 0,
        retiredDatabase: null,
        fetchSinceMs: null,
      },
    };
    const peer = {
      ...database("peer"),
      filename: "Chess.com peer history",
      collection: {
        ...canonical.collection,
        id: "peer",
        database: database("peer").file,
        account: { provider: "chesscom", account: "e2e-player" },
      },
    };
    const other = {
      ...database("other"),
      filename: "Other player history",
      collection: {
        ...canonical.collection,
        id: "other",
        database: database("other").file,
        account: { provider: "lichess", account: "other-player" },
      },
    };
    const legacy = { ...database("legacy"), filename: "e2e-player_lichess.db3" };
    mocks.getDatabases.mockResolvedValue({
      databases: [
        legacy,
        other,
        failed ? { ...canonical, type: "error", error: "Index unavailable" } : canonical,
        peer,
      ],
      unread: [],
      root: { id: { id: "canonical-root" }, kind: "databaseRoot" },
    });
    const canonicalRecord = {
      site: "Lichess",
      player: "e2e-player",
      daily: [],
      colors: [],
      latest: [],
      openings: [],
    };
    const peerRecord = {
      site: "Chess.com",
      player: "e2e-player",
      daily: [],
      colors: [],
      latest: [],
      openings: [],
    };
    const foreignRecord = {
      site: "Lichess",
      player: "other-player",
      daily: [],
      colors: [],
      latest: [],
      openings: [],
    };
    mocks.getPlayersGameInfo.mockImplementation(async (_progress, file) => ({
      site_stats_data: [
        file.id.id === "canonical"
          ? canonicalRecord
          : file.id.id === "peer"
            ? peerRecord
            : foreignRecord,
      ],
    }));

    await renderDatabases();

    await vi.waitFor(() =>
      expect(mocks.personalCardInfo).toHaveBeenLastCalledWith({
        site_stats_data: failed ? [peerRecord] : [canonicalRecord, peerRecord],
      }),
    );
    expect(container.textContent).toContain("Coach");
    expect(mocks.query_players).toHaveBeenCalledTimes(failed ? 1 : 2);
    for (const [file, query] of mocks.query_players.mock.calls) {
      expect(["canonical", "peer"]).toContain(file.id.id);
      expect(query.name).toBe("e2e-player");
    }
    expect(container.querySelector('[role="alert"]')?.textContent ?? "").toBe(
      failed
        ? "Home.Databases.Incomplete.TitleHome.Databases.Incomplete.Description: Canonical linked history"
        : "",
    );
    expect(container.textContent).not.toContain("Other player history");
    expect(container.textContent).not.toContain("e2e-player_lichess.db3");
    expect(mocks.logError).not.toHaveBeenCalled();
  },
);

test.each(["readable", "unread"])(
  "Home refuses conflicting legacy case variants including a %s candidate",
  async (kind) => {
    getDefaultStore().set(
      sessionsAtom,
      sessionsSchema.parse([
        { player: "Coach", updatedAt: 1, lichess: { username: "magnus", account: {} } },
      ]),
    );
    mocks.getDatabases.mockResolvedValue({
      databases: [
        { ...database("db-1"), filename: "magnus_lichess.db3" },
        ...(kind === "readable" ? [{ ...database("db-2"), filename: "Magnus_lichess.db3" }] : []),
      ],
      unread: kind === "unread" ? [{ filename: "Magnus_lichess.db3", error: "Unreadable" }] : [],
      root: { id: { id: "legacy-root" }, kind: "databaseRoot" },
    });
    mocks.getPlayersGameInfo.mockResolvedValue({ site_stats_data: [] });
    await renderDatabases();
    await vi.waitFor(() => expect(container.textContent).toContain("Home.Databases.Failed.Title"));
    expect(container.textContent).toContain("magnus_lichess.db3");
    expect(container.textContent).toContain("Magnus_lichess.db3");
    expect(mocks.query_players).not.toHaveBeenCalled();
    expect(mocks.getPlayersGameInfo).not.toHaveBeenCalled();
  },
);

test.each([{}, { perfs: { blitz: { games: 2 } } }, { username: "foreign" }])(
  "Home retains differently cased legacy history independently of profile cache %j",
  async (profile) => {
    getDefaultStore().set(
      sessionsAtom,
      sessionsSchema.parse([
        { player: "Coach", updatedAt: 1, lichess: { username: "magnus", account: profile } },
      ]),
    );
    const legacy = { ...database("db-1"), filename: "Magnus_lichess.db3" };
    mocks.getDatabases.mockResolvedValue({
      databases: [
        legacy,
        { ...database("db-2"), filename: "foreign_lichess.db3" },
        { ...database("other-provider"), filename: "magnus_chesscom.db3" },
      ],
      unread: [],
      root: { id: { id: "legacy-root" }, kind: "databaseRoot" },
    });
    const record = {
      site: "Lichess",
      player: "Magnus",
      daily: [],
      colors: [],
      latest: [],
      openings: [],
    };
    mocks.getPlayersGameInfo.mockResolvedValue({ site_stats_data: [record] });
    await renderDatabases();
    await vi.waitFor(() =>
      expect(mocks.personalCardInfo).toHaveBeenLastCalledWith({
        site_stats_data: [{ ...record, player: "magnus" }],
      }),
    );
    expect(container.textContent).toContain("Coach");
    expect(mocks.query_players).toHaveBeenCalledExactlyOnceWith(
      legacy.file,
      expect.objectContaining({ name: "magnus" }),
      expect.anything(),
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
  },
);

function setupBobAndAlice({ bobGames = 2, includeAlice = true } = {}) {
  const bobSession = {
    player: "Bob",
    updatedAt: 1,
    lichess: { username: "bob", account: { id: "bob", username: "bob" } },
  };
  const aliceSession = {
    player: "Alice",
    updatedAt: 1,
    chessCom: { username: "alice", stats: {} },
  };
  const bobDb = { ...database("db-1"), filename: "bob_lichess.db3", game_count: bobGames };
  const aliceDb = { ...database("db-2"), filename: "alice_chesscom.db3" };
  getDefaultStore().set(sessionsAtom, includeAlice ? [bobSession, aliceSession] : [bobSession]);
  mocks.getDatabases.mockResolvedValue({
    databases: includeAlice ? [bobDb, aliceDb] : [bobDb],
    unread: [],
    root: { id: { id: "selection-root" }, kind: "databaseRoot" as const },
  });
  return { bobSession, aliceSession, bobDb, aliceDb };
}

test("choosing a player via the empty-summary Select or PersonalCard survives session updates and falls back when removed", async () => {
  const { bobSession, aliceSession } = setupBobAndAlice({ bobGames: 0 });
  mocks.query_players.mockImplementation(async (file, query) =>
    file.id.id === "db-1"
      ? { data: [], count: 0 }
      : { data: [{ id: 7, name: query.name, elo: null }], count: 1 },
  );
  mocks.getPlayersGameInfo.mockResolvedValue({
    site_stats_data: [
      { site: "Chess.com", player: "alice", daily: [], colors: [], latest: [], openings: [] },
    ],
  });

  await renderDatabases();
  await vi.waitFor(() => expect(container.textContent).toContain("Home.Databases.Empty.Title"));
  expect(mocks.select).toMatchObject({ value: "Bob", data: ["Bob", "Alice"] });

  await act(async () => {
    mocks.select?.onChange?.("Alice");
  });
  await vi.waitFor(() => expect(container.textContent).toContain("player-card Alice"));

  await act(async () => {
    getDefaultStore().set(sessionsAtom, [{ ...bobSession, updatedAt: 2 }, aliceSession]);
  });
  await vi.waitFor(() => expect(container.textContent).toContain("player-card Alice"));
  expect(container.textContent).not.toContain("Home.Databases.Empty.Title");

  await act(async () => {
    mocks.setName?.("Bob");
  });
  await vi.waitFor(() => expect(container.textContent).toContain("Home.Databases.Empty.Title"));

  await act(async () => {
    mocks.select?.onChange?.("Alice");
  });
  await vi.waitFor(() => expect(container.textContent).toContain("player-card Alice"));

  await act(async () => {
    getDefaultStore().set(sessionsAtom, [{ ...bobSession, updatedAt: 3 }]);
  });
  await vi.waitFor(() => expect(container.textContent).toContain("Home.Databases.Empty.Title"));
  expect(mocks.select?.value).toBe("Bob");
});

test("switching between two players or returning after an aborted fetch does not carry over stale progress", async () => {
  const { bobSession, aliceSession } = setupBobAndAlice();
  mocks.query_players.mockImplementation(async (_file, query) => ({
    data: [{ id: 7, name: query.name, elo: null }],
    count: 1,
  }));

  let resolveAlice!: (value: { site_stats_data: unknown[] }) => void;
  mocks.getPlayersGameInfo.mockImplementation(
    (_progress, file, _id, options: { signal: AbortSignal }) => {
      if (file.id.id === "db-2") {
        return new Promise((resolve) => {
          resolveAlice = resolve;
        });
      }
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Cancellation", "AbortError")),
          { once: true },
        );
      });
    },
  );

  await renderDatabases();
  await vi.waitFor(() => expect(mocks.getPlayersGameInfo).toHaveBeenCalledTimes(1));
  const bobProgressId = mocks.getPlayersGameInfo.mock.calls[0][0] as string;

  await act(async () => {
    progressListener(progressEvent(bobProgressId, 80));
  });
  expect(displayedProgress()).toContain("80%");
  expect(container.querySelector("[data-testid='progress']")?.textContent).toBe("80");

  // Switch default player from pending Bob (80%) to pending Alice -> 0%:
  await act(async () => {
    getDefaultStore().set(sessionsAtom, [aliceSession, bobSession]);
  });
  await vi.waitFor(() => expect(mocks.getPlayersGameInfo).toHaveBeenCalledTimes(2));
  expect(displayedProgress()).toContain("0%");
  expect(displayedProgress()).not.toContain("80%");
  expect(container.querySelector("[data-testid='progress']")?.textContent).toBe("0");

  // Complete Alice without emitting progress, then select Bob again so a new Bob fetch starts:
  await act(async () => {
    resolveAlice({
      site_stats_data: [
        { site: "Chess.com", player: "alice", daily: [], colors: [], latest: [], openings: [] },
      ],
    });
  });
  await vi.waitFor(() => expect(container.textContent).toContain("player-card Alice"));

  await act(async () => {
    mocks.setName?.("Bob");
  });
  await vi.waitFor(() => expect(mocks.getPlayersGameInfo).toHaveBeenCalledTimes(3));
  expect(displayedProgress()).toContain("0%");
  expect(displayedProgress()).not.toContain("80%");
  expect(container.querySelector("[data-testid='progress']")?.textContent).toBe("0");
});

test("an in-flight same-handle refetch with a changed game_count shows 0% immediately", async () => {
  const { bobSession, bobDb } = setupBobAndAlice({ bobGames: 2, includeAlice: false });
  mocks.query_players.mockResolvedValue({
    data: [{ id: 7, name: "bob", elo: null }],
    count: 1,
  });
  mocks.getPlayersGameInfo.mockReturnValue(new Promise(() => undefined));

  await renderDatabases();
  await vi.waitFor(() => expect(mocks.getPlayersGameInfo).toHaveBeenCalledTimes(1));
  const firstProgressId = mocks.getPlayersGameInfo.mock.calls[0][0] as string;

  await act(async () => {
    progressListener(progressEvent(firstProgressId, 80));
  });
  expect(displayedProgress()).toContain("80%");

  // Hold the second fetch at query_players while the first fetch is still pending at 80%.
  let releaseSecondQuery!: () => void;
  mocks.query_players.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseSecondQuery = () => resolve({ data: [{ id: 7, name: "bob", elo: null }], count: 1 });
      }),
  );
  mocks.getDatabases.mockResolvedValue({
    databases: [{ ...bobDb, game_count: 5 }],
    unread: [],
    root: { id: { id: "selection-root" }, kind: "databaseRoot" as const },
  });

  await act(async () => {
    getDefaultStore().set(sessionsAtom, [{ ...bobSession, updatedAt: 2 }]);
  });

  expect(container.textContent).toContain("Home.Databases.ProcessingGames");
  expect(displayedProgress()).toContain("0%");
  expect(displayedProgress()).not.toContain("80%");
  expect(container.querySelector("[data-testid='progress']")?.textContent).toBe("0");

  await act(async () => {
    releaseSecondQuery();
  });
  await vi.waitFor(() => expect(mocks.getPlayersGameInfo).toHaveBeenCalledTimes(2));
  expect(displayedProgress()).toContain("0%");
});

test("overlapping same-key fetches keep the second fetch's progress map when the first finally settles late", async () => {
  setupBobAndAlice({ includeAlice: false });
  mocks.query_players.mockResolvedValue({
    data: [{ id: 7, name: "bob", elo: null }],
    count: 1,
  });

  let rejectFirstBob!: (reason?: unknown) => void;
  mocks.getPlayersGameInfo
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirstBob = reject;
        }),
    )
    .mockImplementationOnce(() => new Promise(() => undefined));

  await renderDatabases();
  await vi.waitFor(() => expect(mocks.getPlayersGameInfo).toHaveBeenCalledTimes(1));

  // Unmount so the first fetch is aborted while its native promise is still unwinding,
  // then mount a fresh SWR cache that starts a second fetch under the identical progress key.
  await act(async () => root.render(null));
  await renderDatabases();
  await vi.waitFor(() => expect(mocks.getPlayersGameInfo).toHaveBeenCalledTimes(2));
  const secondBobProgressId = mocks.getPlayersGameInfo.mock.calls[1][0] as string;

  // The first fetch's finally settles after the second installed its map:
  await act(async () => {
    rejectFirstBob(new DOMException("Cancellation", "AbortError"));
  });

  await act(async () => {
    progressListener(progressEvent(secondBobProgressId, 65));
  });
  expect(displayedProgress()).toContain("65%");
  expect(container.querySelector("[data-testid='progress']")?.textContent).toBe("65");
});
