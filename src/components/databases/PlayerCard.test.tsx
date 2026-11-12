import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DatabaseHandle, Player } from "@/bindings";

const mocks = vi.hoisted(() => ({
  getPlayersGameInfo: vi.fn(),
  personalCard: vi.fn(),
}));

vi.mock("@/platform/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
  return {
    ...actual,
    tauri: { getPlayersGameInfo: mocks.getPlayersGameInfo },
  };
});
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../home/PersonalCard", () => ({
  default: (props: unknown) => {
    mocks.personalCard(props);
    return <div>player-card</div>;
  },
}));
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
    databasePlayer: { player, file },
  });
});
