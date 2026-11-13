import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DatabaseHandle, NormalizedGame, Player } from "@/bindings";

const mocks = vi.hoisted(() => ({
  queryGames: vi.fn(),
  openGame: vi.fn(),
  runTabCreation: vi.fn(),
  navigate: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { error?: string }) => {
      if (key === "Home.Personal.Overview.ResultWin") return "Win";
      if (key === "Home.Personal.Overview.ResultLoss") return "Loss";
      return options?.error !== undefined ? `${key}: ${options.error}` : key;
    },
  }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@/components/files/notifyError", () => ({ notifyUnlessCancelled: mocks.notify }));
vi.mock("@/utils/databaseGame", () => ({ openDatabaseGame: mocks.openGame }));
vi.mock("@/utils/tabs", () => ({
  runTabCreation: (args: {
    create: () => Promise<unknown>;
    onSuccess?: () => void;
    onError?: (cause: unknown) => void;
  }) => mocks.runTabCreation(args),
}));
vi.mock("@/utils/db", () => ({ query_games: mocks.queryGames }));
vi.mock("@/state/atoms", () => ({ tabsAtom: {}, addRecentFileAtom: {} }));
vi.mock("jotai", () => ({ useSetAtom: () => vi.fn() }));
vi.mock("@mantine/core", () => ({
  Box: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Loader: () => <div>loader</div>,
  Stack: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  UnstyledButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

import LastGamesList from "./LastGamesList";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const player: Player = { id: 42, name: "Magnus", game_count: 6, elo: 1800 };
const file: DatabaseHandle = { id: { id: "db-overview" }, kind: "database" };

function game(
  partial: Partial<NormalizedGame> & Pick<NormalizedGame, "id" | "white" | "black">,
): NormalizedGame {
  return {
    fen: "start",
    event: "",
    event_id: 1,
    site: "",
    site_id: 1,
    white_id: player.id,
    black_id: 99,
    result: "1-0",
    moves: "1. e4 e5",
    date: "2026.01.01",
    ...partial,
  };
}

let container: HTMLDivElement;
let root: Root;

async function renderList(swrValue?: React.ComponentProps<typeof SWRConfig>["value"]) {
  await act(async () => {
    root.render(
      <SWRConfig value={swrValue ?? { provider: () => new Map() }}>
        <LastGamesList player={player} file={file} />
      </SWRConfig>,
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runTabCreation.mockImplementation(
    async ({
      create,
      onSuccess,
      onError,
    }: {
      create: () => Promise<unknown>;
      onSuccess?: () => void;
      onError?: (cause: unknown) => void;
    }) => {
      try {
        await create();
        onSuccess?.();
      } catch (cause) {
        onError?.(cause);
      }
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

test("queries the player's last 10 games with sides Any, newest first", async () => {
  mocks.queryGames.mockResolvedValue({ data: [], count: 0 });
  await renderList();
  await vi.waitFor(() => expect(mocks.queryGames).toHaveBeenCalled());
  expect(mocks.queryGames).toHaveBeenCalledWith(
    file,
    {
      player1: 42,
      sides: "Any",
      options: {
        sort: "date",
        direction: "desc",
        pageSize: 10,
        page: 1,
        skipCount: true,
      },
    },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

test("renders returned games in order and opens the clicked row", async () => {
  const first = game({
    id: 2,
    date: "2026.02.02",
    white: "Magnus",
    black: "Hikaru",
    black_elo: 2800,
    result: "1-0",
    eco: "B90",
  });
  const second = game({
    id: 1,
    date: "2026.01.01",
    white: "Nepo",
    white_id: 7,
    white_elo: 2700,
    black: "Magnus",
    black_id: player.id,
    result: "1-0",
    eco: "C65",
  });
  mocks.queryGames.mockResolvedValue({ data: [first, second], count: 2 });
  await renderList();
  await vi.waitFor(() => expect(container.textContent).toContain("Hikaru"));

  const rows = Array.from(container.querySelectorAll("button"));
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("2026.02.02");
  expect(rows[0].textContent).toContain("Hikaru");
  expect(rows[0].textContent).toContain("2800");
  expect(rows[0].querySelector("div:last-child > span:first-child")?.textContent).toBe("Win");
  expect(rows[0].textContent).toContain("B90");
  expect(rows[1].textContent).toContain("Nepo");
  expect(rows[1].querySelector("div:last-child > span:first-child")?.textContent).toBe("Loss");

  await act(async () => {
    rows[0].click();
  });
  expect(mocks.openGame).toHaveBeenCalledWith(
    expect.objectContaining({ game: first, database: file }),
  );
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/" });
});

test("a pending open admits only one click across rows", async () => {
  const first = game({
    id: 2,
    date: "2026.02.02",
    white: "Magnus",
    black: "Hikaru",
  });
  const second = game({
    id: 1,
    date: "2026.01.01",
    white: "Nepo",
    white_id: 7,
    black: "Magnus",
    black_id: player.id,
  });
  mocks.queryGames.mockResolvedValue({ data: [first, second], count: 2 });

  let resolveOpen: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    resolveOpen = resolve;
  });
  mocks.runTabCreation.mockImplementation(() => held);

  await renderList();
  await vi.waitFor(() => expect(container.textContent).toContain("Hikaru"));

  const rows = Array.from(container.querySelectorAll("button"));
  expect(rows).toHaveLength(2);

  await act(async () => {
    rows[0].click();
    rows[0].click();
    rows[1].click();
  });
  expect(mocks.runTabCreation).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolveOpen();
  });
});

test("a non-cancellation error renders inline and does not toast", async () => {
  mocks.queryGames.mockRejectedValue(new Error("disk failed"));
  await renderList();
  await vi.waitFor(() => expect(container.textContent).toContain("disk failed"));
  expect(container.textContent).toContain("Home.Personal.Overview.LastGamesError");
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("a cancellation renders nothing", async () => {
  mocks.queryGames.mockRejectedValue(new DOMException("Cancellation", "AbortError"));
  await renderList();
  await vi.waitFor(() => expect(mocks.queryGames).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  expect(container.textContent).toBe("");
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("production SWR configuration does not retry get_games after an error", async () => {
  vi.useFakeTimers();
  mocks.queryGames.mockRejectedValue(new Error("disk failed"));
  await renderList({ provider: () => new Map() });
  await act(async () => {
    await Promise.resolve();
  });
  expect(mocks.queryGames).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(mocks.queryGames).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("disk failed");
});
