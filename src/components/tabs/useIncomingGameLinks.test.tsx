import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { GameLink } from "@/bindings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => {
  class ChessComGameResponseError extends Error {}
  return {
    ChessComGameResponseError,
    takePendingGameLinks: vi.fn(),
    subscribe: vi.fn(),
    unlisten: vi.fn(),
    warn: vi.fn(),
    logError: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    navigate: vi.fn(),
    setTabs: vi.fn(),
    createTab: vi.fn(),
    parsePGN: vi.fn(),
    fetchChessComGamePgn: vi.fn(),
    getLichessGame: vi.fn(),
    notifyUnlessCancelled: vi.fn(),
  };
});

// Any native command but the drain is a failure: an incoming link starts no report and no engine.
vi.mock("@/platform/tauri", () => ({
  tauri: new Proxy(
    {},
    {
      get: (_target, name) => {
        if (name === "takePendingGameLinks") return mocks.takePendingGameLinks;
        throw new Error(`unexpected native command ${String(name)}`);
      },
    },
  ),
  tauriSubscriptions: { gameLinkPending: mocks.subscribe },
}));
vi.mock("@/platform/native", () => ({ warn: mocks.warn, error: mocks.logError }));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: mocks.show, hide: mocks.hide },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("jotai", () => ({ useSetAtom: () => mocks.setTabs }));
vi.mock("@/state/atoms", () => ({ tabsAtom: {} }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));
vi.mock("@/components/files/notifyError", () => ({
  notifyUnlessCancelled: mocks.notifyUnlessCancelled,
}));
vi.mock("@/utils/chess", () => ({ parsePGN: mocks.parsePGN }));
vi.mock("@/utils/treeReducer", () => ({
  getGameName: (headers: { white: string; black: string }) => `${headers.white} - ${headers.black}`,
}));
vi.mock("@/utils/tabs", () => ({ createTab: mocks.createTab }));
vi.mock("@/utils/chess.com/api", () => ({
  ChessComGameResponseError: mocks.ChessComGameResponseError,
  fetchChessComGamePgn: mocks.fetchChessComGamePgn,
}));
vi.mock("@/utils/lichess/api", () => ({ getLichessGame: mocks.getLichessGame }));

import { createDrainScheduler, useIncomingGameLinks } from "./useIncomingGameLinks";

const lichess: GameLink = { site: "lichess", game_id: "abcdefgh" };
const chessCom: GameLink = { site: "chess-com", game_type: "live", game_id: "123" };
const tree = { headers: { white: "Carlsen", black: "Caruana" } };

function Probe() {
  useIncomingGameLinks();
  return null;
}

let container: HTMLDivElement;
let root: Root;
let wake: () => void;
let failListener: (cause: unknown) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const loadingIds = () =>
  mocks.show.mock.calls
    .map(([notification]) => notification as { id?: string; loading?: boolean })
    .filter((notification) => notification.loading)
    .map((notification) => notification.id);

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
  }
  mocks.takePendingGameLinks.mockResolvedValue([]);
  mocks.subscribe.mockImplementation(
    async (listener: () => void, onError: (cause: unknown) => void) => {
      wake = listener;
      failListener = onError;
      return mocks.unlisten;
    },
  );
  mocks.parsePGN.mockResolvedValue(tree);
  mocks.getLichessGame.mockResolvedValue("lichess pgn");
  mocks.fetchChessComGamePgn.mockResolvedValue("chess.com pgn");
  mocks.createTab.mockResolvedValue("tab-1");
  mocks.navigate.mockResolvedValue(undefined);

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("useIncomingGameLinks", () => {
  test("opens a link that was waiting at startup in a new analysis tab and shows the board", async () => {
    mocks.takePendingGameLinks.mockResolvedValueOnce([lichess]);

    await act(async () => root.render(<Probe />));

    expect(mocks.getLichessGame).toHaveBeenCalledExactlyOnceWith("abcdefgh");
    expect(mocks.parsePGN).toHaveBeenCalledExactlyOnceWith("lichess pgn");
    expect(mocks.createTab).toHaveBeenCalledExactlyOnceWith({
      tab: { name: "Carlsen - Caruana", type: "analysis" },
      setTabs: mocks.setTabs,
      initialTree: tree,
      gameOrigin: { kind: "none" },
      signal: expect.any(AbortSignal),
    });
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/" });
    expect(mocks.show).toHaveBeenCalledExactlyOnceWith({
      id: expect.stringMatching(/^game-link:/u),
      loading: true,
      autoClose: false,
      withCloseButton: false,
      title: "GameLink.OpeningTitle",
      message: 'GameLink.OpeningMessage {"site":"Lichess"}',
    });
    expect(mocks.hide).toHaveBeenCalledExactlyOnceWith(loadingIds()[0]);
    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
  });

  test("does nothing visible when no link is waiting", async () => {
    await act(async () => root.render(<Probe />));

    expect(mocks.takePendingGameLinks).toHaveBeenCalledOnce();
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.createTab).not.toHaveBeenCalled();
  });

  test("drains again on a wake event", async () => {
    await act(async () => root.render(<Probe />));
    mocks.takePendingGameLinks.mockResolvedValueOnce([chessCom]);

    await act(async () => wake());

    expect(mocks.takePendingGameLinks).toHaveBeenCalledTimes(2);
    expect(mocks.fetchChessComGamePgn).toHaveBeenCalledExactlyOnceWith("live", "123");
    expect(mocks.createTab).toHaveBeenCalledOnce();
  });

  test("reports a failing link once and still opens the next one", async () => {
    const offline = { category: "network", message: "offline" };
    mocks.getLichessGame.mockRejectedValue(offline);
    mocks.takePendingGameLinks.mockResolvedValueOnce([lichess, chessCom]);

    await act(async () => root.render(<Probe />));

    expect(mocks.notifyUnlessCancelled).toHaveBeenCalledExactlyOnceWith(
      'GameLink.Failed {"site":"Lichess"}',
      offline,
    );
    expect(mocks.createTab).toHaveBeenCalledOnce();
    expect(mocks.createTab.mock.calls[0][0].initialTree).toBe(tree);
    expect(mocks.navigate).toHaveBeenCalledOnce();
    // Both loading notifications are cleared, the failed one included.
    expect(loadingIds()).toHaveLength(2);
    expect(mocks.hide.mock.calls.map(([id]) => id)).toEqual(loadingIds());
  });

  test("names the game when chess.com answers with an unusable response", async () => {
    mocks.fetchChessComGamePgn.mockRejectedValue(
      new mocks.ChessComGameResponseError("Illegal move in Chess.com game: a4"),
    );
    mocks.takePendingGameLinks.mockResolvedValueOnce([chessCom]);

    await act(async () => root.render(<Probe />));

    expect(mocks.logError).toHaveBeenCalledExactlyOnceWith("Illegal move in Chess.com game: a4");
    expect(mocks.show).toHaveBeenLastCalledWith({
      color: "danger",
      title: 'GameLink.Failed {"site":"Chess.com"}',
      message: 'ChessCom.InvalidResponse {"value":"https://www.chess.com/game/live/123"}',
    });
    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
    expect(mocks.createTab).not.toHaveBeenCalled();
    expect(mocks.hide).toHaveBeenCalledExactlyOnceWith(loadingIds()[0]);
  });

  test("reports a game that cannot be parsed", async () => {
    const broken = new Error("bad pgn");
    mocks.parsePGN.mockRejectedValue(broken);
    mocks.takePendingGameLinks.mockResolvedValueOnce([lichess]);

    await act(async () => root.render(<Probe />));

    expect(mocks.notifyUnlessCancelled).toHaveBeenCalledExactlyOnceWith(
      'GameLink.Failed {"site":"Lichess"}',
      broken,
    );
    expect(mocks.createTab).not.toHaveBeenCalled();
  });

  test("neither navigates nor notifies when the tab is declined", async () => {
    mocks.createTab.mockResolvedValue(null);
    mocks.takePendingGameLinks.mockResolvedValueOnce([lichess]);

    await act(async () => root.render(<Probe />));

    expect(mocks.createTab).toHaveBeenCalledOnce();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
    expect(mocks.show).toHaveBeenCalledOnce();
    expect(mocks.hide).toHaveBeenCalledExactlyOnceWith(loadingIds()[0]);
  });

  test("wake events during a drain cause exactly one further drain", async () => {
    const fetching = deferred<string>();
    mocks.getLichessGame.mockReturnValue(fetching.promise);
    mocks.takePendingGameLinks.mockResolvedValueOnce([lichess]).mockResolvedValueOnce([chessCom]);

    await act(async () => root.render(<Probe />));
    expect(mocks.takePendingGameLinks).toHaveBeenCalledOnce();
    await act(async () => {
      wake();
      wake();
      wake();
    });
    // Still inside the first drain: nothing overlaps it.
    expect(mocks.takePendingGameLinks).toHaveBeenCalledOnce();

    await act(async () => fetching.resolve("lichess pgn"));

    expect(mocks.takePendingGameLinks).toHaveBeenCalledTimes(2);
    expect(mocks.createTab).toHaveBeenCalledTimes(2);
    expect(mocks.fetchChessComGamePgn).toHaveBeenCalledOnce();
  });

  test("logs a failing drain and takes the links on the next wake event", async () => {
    mocks.takePendingGameLinks.mockRejectedValueOnce(new Error("ipc closed"));

    await act(async () => root.render(<Probe />));

    expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
      "Failed to take the waiting game links: Error: ipc closed",
    );
    expect(mocks.show).not.toHaveBeenCalled();

    mocks.takePendingGameLinks.mockResolvedValueOnce([lichess]);
    await act(async () => wake());

    expect(mocks.createTab).toHaveBeenCalledOnce();
  });

  test("logs a failing wake subscription", async () => {
    await act(async () => root.render(<Probe />));

    await act(async () => failListener(new Error("listener gone")));

    expect(mocks.warn).toHaveBeenCalledExactlyOnceWith("Game link listener failed: listener gone");
  });

  test("unmount aborts: a fetch that settles later opens nothing and its notification is cleared", async () => {
    const fetching = deferred<string>();
    mocks.getLichessGame.mockReturnValue(fetching.promise);
    mocks.takePendingGameLinks.mockResolvedValueOnce([lichess, chessCom]);

    await act(async () => root.render(<Probe />));
    await act(async () => root.unmount());
    await act(async () => fetching.resolve("lichess pgn"));

    expect(mocks.unlisten).toHaveBeenCalledOnce();
    expect(mocks.createTab).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.fetchChessComGamePgn).not.toHaveBeenCalled();
    expect(mocks.hide).toHaveBeenCalledExactlyOnceWith(loadingIds()[0]);
    root = createRoot(container);
  });

  test("unmount aborts: a fetch that fails later is not reported", async () => {
    const fetching = deferred<string>();
    mocks.getLichessGame.mockReturnValue(fetching.promise);
    mocks.takePendingGameLinks.mockResolvedValueOnce([lichess]);

    await act(async () => root.render(<Probe />));
    await act(async () => root.unmount());
    await act(async () => fetching.reject(new Error("offline")));

    expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
    expect(mocks.hide).toHaveBeenCalledOnce();
    root = createRoot(container);
  });
});

describe("createDrainScheduler", () => {
  test("starts nothing once aborted", async () => {
    const controller = new AbortController();
    const drain = vi.fn(async () => undefined);
    const request = createDrainScheduler(drain, controller.signal);
    controller.abort();

    await request();

    expect(drain).not.toHaveBeenCalled();
  });

  test("does not run the requested further drain after an abort", async () => {
    const controller = new AbortController();
    const first = deferred<void>();
    const drain = vi.fn(() => first.promise);
    const request = createDrainScheduler(drain, controller.signal);

    const running = request();
    await request();
    controller.abort();
    first.resolve();
    await running;

    expect(drain).toHaveBeenCalledOnce();
  });

  test("serves a later request after a drain that threw", async () => {
    const controller = new AbortController();
    const drain = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const request = createDrainScheduler(drain, controller.signal);

    await expect(request()).rejects.toThrow("boom");
    await request();

    expect(drain).toHaveBeenCalledTimes(2);
  });
});
