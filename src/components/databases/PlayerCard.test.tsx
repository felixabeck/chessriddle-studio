import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DatabaseHandle, Player } from "@/bindings";
import { recordDatabaseWrite } from "@/platform/databaseWrites";
import type { OnlineGames } from "./useOnlineGames";

const mocks = vi.hoisted(() => ({
  getPlayersGameInfo: vi.fn(),
  personalCard: vi.fn(),
  cardMounts: 0,
  warn: vi.fn(),
  generation: null as string | null,
  pending: false,
  unavailable: false,
  unavailableFiles: new Set<string>(),
  online: undefined as OnlineGames | undefined,
}));

vi.mock("@/platform/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
  return {
    ...actual,
    tauri: { getPlayersGameInfo: mocks.getPlayersGameInfo },
  };
});
vi.mock("@/state/linkedCollections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/linkedCollections")>();
  const { useDatabaseWriteRevision } = await import("@/platform/databaseWrites");
  return {
    ...actual,
    useDatabaseContentRevision: (file: DatabaseHandle | null | undefined) => {
      const writes = useDatabaseWriteRevision(file);
      return {
        revision: mocks.pending ? null : ([mocks.generation, writes] as const),
        unavailable: mocks.unavailable || mocks.unavailableFiles.has(file?.id.id ?? ""),
      };
    },
  };
});
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../home/PersonalCard", async () => {
  const { useEffect } = await import("react");
  return {
    default: (props: { headerAction?: React.ReactNode; notice?: React.ReactNode }) => {
      mocks.personalCard(props);
      useEffect(() => {
        mocks.cardMounts += 1;
      }, []);
      return (
        <div>
          player-card{props.headerAction}
          {props.notice}
        </div>
      );
    },
  };
});
vi.mock("@/platform/errors", async (original) => ({
  ...(await original<typeof import("@/platform/errors")>()),
  warnSafely: mocks.warn,
}));
// The real owner hook, so a test sees whether its state survives a switch to another player; the
// two pieces only show and change that state.
vi.mock("./OpponentAccounts", async (original) => {
  const { useOpponentAccounts } = await original<typeof import("./OpponentAccounts")>();
  type Accounts = ReturnType<typeof useOpponentAccounts>;
  return {
    useOpponentAccounts,
    OpponentAccountAdd: ({ accounts }: { accounts: Accounts }) => (
      <button data-test-add onClick={() => accounts.setAdding(true)}>
        add
      </button>
    ),
    default: ({ accounts }: { accounts: Accounts }) => (
      <div data-test-strip>
        <button data-test-manage onClick={() => accounts.setExpanded(true)}>
          manage
        </button>
        {accounts.expanded && <span data-test-details />}
        {accounts.adding && <span data-test-dialog />}
      </div>
    ),
  };
});
vi.mock("./useOnlineGames", () => ({ useOnlineGames: () => mocks.online }));
vi.mock("@mantine/core", () => ({
  Center: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Loader: () => null,
  Paper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Stack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

import PlayerCard from "./PlayerCard";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const player: Player = { id: 7, name: "Magnus", game_count: 0, elo: null };
const file: DatabaseHandle = { id: { id: "db-1" }, kind: "database" };

let container: HTMLDivElement;
let root: Root;

async function renderPlayerCard() {
  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
        <PlayerCard player={player} file={file} />
      </SWRConfig>,
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generation = null;
  mocks.pending = false;
  mocks.unavailable = false;
  mocks.unavailableFiles.clear();
  mocks.online = undefined;
  mocks.cardMounts = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test("a failed player lookup renders an error instead of a blank panel", async () => {
  const rawMessage = "C:\\secret\\path diag";
  mocks.getPlayersGameInfo.mockRejectedValue(new Error(rawMessage));
  await renderPlayerCard();

  await vi.waitFor(() => {
    expect(container.textContent).toContain("Databases.LoadError.Title");
  });
  expect(container.textContent).not.toBe("");
  expect(container.textContent).not.toContain(rawMessage);
  expect(container.textContent).not.toContain("player-card");
});

test("the database caller passes its own player and database to the shared personal card", async () => {
  const info = { site_stats_data: [] };
  mocks.getPlayersGameInfo.mockResolvedValue(info);
  await renderPlayerCard();
  expect(mocks.personalCard).toHaveBeenCalledWith({
    name: player.name,
    info,
    isDatabase: true,
    headerAction: expect.anything(),
    notice: expect.anything(),
    databasePlayer: { player, file },
    online: undefined,
  });
  // The online-account button sits in the name line and the strip under it.
  expect(container.querySelector("[data-test-add]")).not.toBeNull();
  expect(container.querySelector("[data-test-strip]")).not.toBeNull();
});

test("a linked collection generation change refetches game info and a pending lookup does not fetch", async () => {
  const cache = new Map();
  async function renderCached() {
    await act(async () => {
      root.render(
        <SWRConfig value={{ provider: () => cache, shouldRetryOnError: false }}>
          <PlayerCard player={player} file={file} />
        </SWRConfig>,
      );
    });
  }
  mocks.pending = true;
  mocks.getPlayersGameInfo.mockResolvedValue({ site_stats_data: [{ site: "g1" }] });
  await renderCached();
  expect(mocks.getPlayersGameInfo).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Databases.Player.ProcessingData");

  mocks.pending = false;
  mocks.generation = "g1";
  await renderCached();
  await vi.waitFor(() => expect(mocks.getPlayersGameInfo).toHaveBeenCalledOnce());
  await vi.waitFor(() =>
    expect(mocks.personalCard).toHaveBeenCalledWith(
      expect.objectContaining({ info: { site_stats_data: [{ site: "g1" }] } }),
    ),
  );

  mocks.generation = "g2";
  mocks.getPlayersGameInfo.mockResolvedValue({ site_stats_data: [{ site: "g2" }] });
  await renderCached();
  await vi.waitFor(() => expect(mocks.getPlayersGameInfo).toHaveBeenCalledTimes(2));
  await vi.waitFor(() =>
    expect(mocks.personalCard).toHaveBeenCalledWith(
      expect.objectContaining({ info: { site_stats_data: [{ site: "g2" }] } }),
    ),
  );
});

test("an unavailable collection does not fetch player game info", async () => {
  mocks.unavailable = true;
  mocks.generation = "g1";
  mocks.getPlayersGameInfo.mockResolvedValue({ site_stats_data: [] });
  await renderPlayerCard();
  expect(mocks.getPlayersGameInfo).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Collections.Unavailable");
});

test("a write to the player's database refetches game info and a write to another database does not", async () => {
  const cache = new Map();
  mocks.getPlayersGameInfo.mockResolvedValue({ site_stats_data: [] });
  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => cache, shouldRetryOnError: false }}>
        <PlayerCard player={player} file={file} />
      </SWRConfig>,
    );
  });
  await vi.waitFor(() => expect(mocks.getPlayersGameInfo).toHaveBeenCalledOnce());

  await act(async () => {
    recordDatabaseWrite([{ id: { id: "other-player-db" }, kind: "database" }]);
  });
  expect(mocks.getPlayersGameInfo).toHaveBeenCalledOnce();

  await act(async () => {
    recordDatabaseWrite([file]);
  });
  await vi.waitFor(() => expect(mocks.getPlayersGameInfo).toHaveBeenCalledTimes(2));
});

const onlineFile: DatabaseHandle = { id: { id: "online-db" }, kind: "database" };
const accounts = [{ provider: "lichess", username: "Thomzilla" }] as const;
const boardInfo = { site_stats_data: [] };
const onlineInfo = { site_stats_data: [{ site: "Lichess" }] };

function answerByDatabase(online: () => Promise<unknown>) {
  mocks.getPlayersGameInfo.mockImplementation((_id: string, database: DatabaseHandle) =>
    database.id.id === onlineFile.id.id ? online() : Promise.resolve(boardInfo),
  );
}

const lastOnline = () => mocks.personalCard.mock.calls.at(-1)?.[0].online;

test("the online games' statistics are read for the player the linked usernames name", async () => {
  mocks.online = { file: onlineFile, accounts, lookup: { kind: "found", player: 3 } };
  answerByDatabase(() => Promise.resolve(onlineInfo));
  await renderPlayerCard();
  await vi.waitFor(() =>
    expect(lastOnline()).toEqual({
      kind: "ready",
      info: onlineInfo,
      databasePlayer: { player: { id: 3 }, file: onlineFile },
    }),
  );
  expect(mocks.getPlayersGameInfo).toHaveBeenCalledWith(
    expect.any(String),
    onlineFile,
    3,
    expect.anything(),
  );
  // The over-the-board statistics stay the card's own.
  expect(mocks.personalCard.mock.calls.at(-1)?.[0].info).toBe(boardInfo);
});

test("the online statistics wait for the player lookup and read nothing before it", async () => {
  mocks.online = { file: onlineFile, accounts, lookup: { kind: "pending" } };
  answerByDatabase(() => Promise.resolve(onlineInfo));
  await renderPlayerCard();
  await vi.waitFor(() => expect(lastOnline()).toEqual({ kind: "pending" }));
  expect(mocks.getPlayersGameInfo).toHaveBeenCalledOnce();
  expect(mocks.getPlayersGameInfo.mock.calls[0][1]).toBe(file);
});

test("a lookup that found no player leaves the online statistics unavailable", async () => {
  mocks.online = { file: onlineFile, accounts, lookup: { kind: "unavailable" } };
  answerByDatabase(() => Promise.resolve(onlineInfo));
  await renderPlayerCard();
  await vi.waitFor(() => expect(lastOnline()).toEqual({ kind: "unavailable" }));
  expect(mocks.getPlayersGameInfo).toHaveBeenCalledOnce();
});

test("a failed online read is unavailable and a cancelled one is still loading", async () => {
  mocks.online = { file: onlineFile, accounts, lookup: { kind: "found", player: 3 } };
  answerByDatabase(() => Promise.reject(new Error("database is locked")));
  await renderPlayerCard();
  await vi.waitFor(() => expect(lastOnline()).toEqual({ kind: "unavailable" }));
  // The card itself still shows the over-the-board games.
  expect(mocks.personalCard.mock.calls.at(-1)?.[0].info).toBe(boardInfo);

  await act(async () => root.unmount());
  root = createRoot(container);
  mocks.personalCard.mockClear();
  answerByDatabase(() =>
    Promise.reject({ tag: "backend-error", category: "cancellation", message: "Cancellation" }),
  );
  await renderPlayerCard();
  await vi.waitFor(() => expect(mocks.personalCard).toHaveBeenCalled());
  await act(async () => {});
  expect(lastOnline()).toEqual({ kind: "pending" });
});

test("an online database whose index cannot be read is unavailable without a read", async () => {
  mocks.online = { file: onlineFile, accounts, lookup: { kind: "found", player: 3 } };
  mocks.unavailableFiles.add(onlineFile.id.id);
  answerByDatabase(() => Promise.resolve(onlineInfo));
  await renderPlayerCard();
  await vi.waitFor(() => expect(lastOnline()).toEqual({ kind: "unavailable" }));
  expect(mocks.getPlayersGameInfo).toHaveBeenCalledOnce();
});

test("a failed statistics read is logged once, never retried, and a cancelled one is not", async () => {
  mocks.online = { file: onlineFile, accounts, lookup: { kind: "found", player: 3 } };
  answerByDatabase(() => Promise.reject(new Error("database is locked")));
  vi.useFakeTimers();
  try {
    // The application's own SWR defaults: retrying is the hook's decision, not the test's.
    await act(async () => {
      root.render(
        <SWRConfig value={{ provider: () => new Map() }}>
          <PlayerCard player={player} file={file} />
        </SWRConfig>,
      );
    });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
  } finally {
    vi.useRealTimers();
  }
  expect(lastOnline()).toEqual({ kind: "unavailable" });
  const onlineReads = mocks.getPlayersGameInfo.mock.calls.filter(
    ([, database]) => database === onlineFile,
  );
  expect(onlineReads).toHaveLength(1);
  expect(mocks.warn).toHaveBeenCalledOnce();
  expect(mocks.warn.mock.calls[0][0]).toContain("player 3");
  expect(mocks.warn.mock.calls[0][0]).toContain("database is locked");

  await act(async () => root.unmount());
  root = createRoot(container);
  mocks.warn.mockClear();
  answerByDatabase(() =>
    Promise.reject({ tag: "backend-error", category: "cancellation", message: "Cancellation" }),
  );
  await renderPlayerCard();
  await vi.waitFor(() => expect(mocks.personalCard).toHaveBeenCalled());
  await act(async () => {});
  expect(mocks.warn).not.toHaveBeenCalled();
});

test("a write to the online games database re-reads the online statistics", async () => {
  mocks.online = { file: onlineFile, accounts, lookup: { kind: "found", player: 3 } };
  answerByDatabase(() => Promise.resolve(onlineInfo));
  await renderPlayerCard();
  const onlineReads = () =>
    mocks.getPlayersGameInfo.mock.calls.filter(([, database]) => database === onlineFile).length;
  await vi.waitFor(() => expect(onlineReads()).toBe(1));
  await act(async () => {
    recordDatabaseWrite([onlineFile]);
  });
  await vi.waitFor(() => expect(onlineReads()).toBe(2));
});

test("another player gets a freshly mounted card", async () => {
  mocks.getPlayersGameInfo.mockResolvedValue(boardInfo);
  await renderPlayerCard();
  await vi.waitFor(() => expect(mocks.cardMounts).toBe(1));
  // The same player keeps the card.
  await renderPlayerCard();
  expect(mocks.cardMounts).toBe(1);

  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
        <PlayerCard player={{ ...player, id: 8, name: "Hikaru" }} file={file} />
      </SWRConfig>,
    );
  });
  await vi.waitFor(() => expect(mocks.cardMounts).toBe(2));
});

test("another player starts with the online-account strip closed and no dialog open", async () => {
  mocks.getPlayersGameInfo.mockResolvedValue(boardInfo);
  await renderPlayerCard();
  await vi.waitFor(() => expect(container.querySelector("[data-test-strip]")).not.toBeNull());
  await act(async () => container.querySelector<HTMLButtonElement>("[data-test-manage]")!.click());
  await act(async () => container.querySelector<HTMLButtonElement>("[data-test-add]")!.click());
  expect(container.querySelector("[data-test-details]")).not.toBeNull();
  expect(container.querySelector("[data-test-dialog]")).not.toBeNull();

  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
        <PlayerCard player={{ ...player, id: 8, name: "Hikaru" }} file={file} />
      </SWRConfig>,
    );
  });
  await vi.waitFor(() => expect(mocks.cardMounts).toBe(2));
  expect(container.querySelector("[data-test-details]")).toBeNull();
  expect(container.querySelector("[data-test-dialog]")).toBeNull();
});
