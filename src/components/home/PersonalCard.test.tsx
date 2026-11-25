import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { activeDatabaseViewStore } from "@/state/store/database";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { DatabaseViewStateContext } from "../databases/DatabaseViewStateContext";
import type { PlayerGameInfo } from "@/bindings";
import PersonalPlayerCard, { type OnlineStatistics } from "./PersonalCard";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../common/FideInfo", () => ({ default: () => null }));
vi.mock("./PersonalCardPanels/OpeningsPanel", () => ({
  default: () => <div data-accounts-openings />,
}));
const panels = vi.hoisted(() => ({ overview: vi.fn(), ratings: vi.fn() }));
vi.mock("./PersonalCardPanels/OverviewPanel", () => ({
  default: (props: unknown) => {
    panels.overview(props);
    return <div data-overview />;
  },
}));
vi.mock("./PersonalCardPanels/RatingsPanel", () => ({
  default: (props: unknown) => {
    panels.ratings(props);
    return <div data-ratings />;
  },
}));
vi.mock("../databases/PlayerOpeningTree", () => ({
  default: () => <div data-database-openings />,
}));
vi.mock("../databases/PlayerPreparation", () => ({
  default: () => <div data-database-preparation />,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

test("Accounts retains OpeningsPanel while only the database caller renders the player opening tree", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  activeDatabaseViewStore.getState().setPlayersActiveTab("openings");
  try {
    for (const database of [false, true]) {
      await act(async () =>
        root.render(
          <MantineProvider>
            <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
              <PersonalPlayerCard
                name="Player"
                playerKey="lichess:player"
                setPlayerKey={vi.fn()}
                info={{ site_stats_data: [] }}
                isDatabase={database}
                databasePlayer={
                  database
                    ? {
                        player: { id: 1, name: "Player", elo: null, game_count: 1 },
                        file: { kind: "database", id: { id: "A" } },
                      }
                    : undefined
                }
              />
            </DatabaseViewStateContext.Provider>
          </MantineProvider>,
        ),
      );
      expect(container.querySelector("[data-accounts-openings]") !== null).toBe(!database);
      expect(
        container.querySelector('input[aria-label="Home.Accounts.PlayerName"]'),
      ).not.toBeNull();
      expect(container.querySelector("[data-database-openings]") !== null).toBe(database);
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    activeDatabaseViewStore.getState().setPlayersActiveTab("overview");
  }
});

const daily = (date: string, timeControl: string, won: number, elo: number | null) => ({
  date,
  time_control: timeControl,
  won,
  drawn: 0,
  lost: 0,
  max_player_elo: elo,
});
const colors = (won: number) => [
  {
    time_control: "180+0",
    is_player_white: true,
    won,
    drawn: 0,
    lost: 0,
    rated_won: 0,
    rated_drawn: 0,
    rated_lost: 0,
    opponent_elo_sum: 0,
  },
];
const boardInfo: PlayerGameInfo = {
  site_stats_data: [
    {
      site: "Bundesliga",
      player: "Bergmann, Thomas",
      daily: [],
      openings: [],
      colors: colors(3),
      latest: [],
    },
  ],
};
const onlineInfo: PlayerGameInfo = {
  site_stats_data: [
    {
      site: "Lichess",
      player: "Thomzilla",
      daily: [daily("2026.11.20", "180+0", 4, 2140), daily("2026.11.21", "600+0", 1, 2050)],
      openings: [],
      colors: colors(5),
      latest: [],
    },
  ],
};
const databasePlayer = {
  player: { id: 1, name: "Bergmann, Thomas", elo: 2026, game_count: 3 },
  file: { kind: "database" as const, id: { id: "mega" } },
};
const onlineFile = { kind: "database" as const, id: { id: "online" } };

async function renderCard(
  root: ReturnType<typeof createRoot>,
  tab: "overview" | "ratings",
  online?: OnlineStatistics,
  cardKey = "first",
) {
  activeDatabaseViewStore.getState().setPlayersActiveTab(tab);
  await act(async () =>
    root.render(
      <MantineProvider>
        <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
          <PersonalPlayerCard
            key={cardKey}
            name="Bergmann, Thomas"
            info={boardInfo}
            isDatabase
            databasePlayer={databasePlayer}
            online={online}
          />
        </DatabaseViewStateContext.Provider>
      </MantineProvider>,
    ),
  );
}

async function withCard(
  run: (container: HTMLDivElement, root: ReturnType<typeof createRoot>) => Promise<void>,
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  panels.overview.mockClear();
  panels.ratings.mockClear();
  try {
    await run(container, root);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    activeDatabaseViewStore.getState().setPlayersActiveTab("overview");
  }
}

const sourceSwitch = (container: HTMLElement) =>
  container.querySelector("[data-statistics-source]");
async function choose(container: HTMLElement, source: "overTheBoard" | "online") {
  const input = container.querySelector<HTMLInputElement>(
    `[data-statistics-source] input[value="${source}"]`,
  )!;
  await act(async () => input.click());
}

test("a player without downloaded online games has no source switch", async () => {
  await withCard(async (container, root) => {
    await renderCard(root, "overview");
    expect(sourceSwitch(container)).toBeNull();
    expect(panels.overview.mock.calls.at(-1)?.[0]).toMatchObject({
      info: boardInfo,
      databasePlayer,
    });
  });
});

test("the Overview switches between the over-the-board and the online games, each with its count", async () => {
  const online: OnlineStatistics = {
    kind: "ready",
    info: onlineInfo,
    databasePlayer: { player: { id: 9 }, file: onlineFile },
  };
  await withCard(async (container, root) => {
    await renderCard(root, "overview", online);
    expect(sourceSwitch(container)?.textContent).toContain(
      "Databases.OpeningTree.OverTheBoard · 3",
    );
    expect(sourceSwitch(container)?.textContent).toContain("Databases.OpeningTree.Online · 5");
    // The over-the-board games come first.
    expect(panels.overview.mock.calls.at(-1)?.[0]).toMatchObject({
      info: boardInfo,
      databasePlayer,
    });

    await choose(container, "online");
    expect(panels.overview.mock.calls.at(-1)?.[0]).toEqual({
      playerKey: "",
      info: onlineInfo,
      isDatabase: true,
      databasePlayer: { player: { id: 9 }, file: onlineFile },
      onlineSites: ["lichess"],
    });

    await choose(container, "overTheBoard");
    expect(panels.overview.mock.calls.at(-1)?.[0]).toMatchObject({ info: boardInfo });
  });
});

test("the online ratings start on the site and time control with the most rated games", async () => {
  const online: OnlineStatistics = {
    kind: "ready",
    info: onlineInfo,
    databasePlayer: { player: { id: 9 }, file: onlineFile },
  };
  await withCard(async (container, root) => {
    await renderCard(root, "ratings", online);
    expect(panels.ratings.mock.calls.at(-1)?.[0]).toMatchObject({ info: boardInfo });
    expect(panels.ratings.mock.calls.at(-1)?.[0].onlineFilters).toBeUndefined();

    await choose(container, "online");
    expect(panels.ratings.mock.calls.at(-1)?.[0]).toEqual({
      playerKey: "",
      info: onlineInfo,
      isDatabase: true,
      onlineFilters: { sites: ["lichess"], initial: { website: "Lichess", timeControl: "blitz" } },
    });
  });
});

test("online games still being read show a loader, unreadable ones say so", async () => {
  await withCard(async (container, root) => {
    await renderCard(root, "overview", { kind: "pending" });
    const labels = [...container.querySelectorAll("[data-statistics-source] label")].map(
      (label) => label.textContent,
    );
    expect(labels).toEqual([
      "Databases.OpeningTree.OverTheBoard · 3",
      "Databases.OpeningTree.Online",
    ]);
    // The over-the-board games stay readable while the online ones are not.
    expect(container.querySelector("[data-overview]")).not.toBeNull();
    expect(panels.overview.mock.calls.at(-1)?.[0]).toMatchObject({ info: boardInfo });
    await choose(container, "online");
    expect(container.textContent).toContain("Databases.Player.ProcessingData");
    expect(container.querySelector("[data-overview]")).toBeNull();

    await choose(container, "overTheBoard");
    await renderCard(root, "overview", { kind: "unavailable" });
    expect(container.querySelector("[data-overview]")).not.toBeNull();
    await choose(container, "online");
    expect(container.textContent).toContain("Databases.OpeningTree.OnlineUnavailable");
    expect(container.querySelector("[data-overview]")).toBeNull();
  });
});

test("a new card, as another player gets, starts on the over-the-board games again", async () => {
  const online: OnlineStatistics = {
    kind: "ready",
    info: onlineInfo,
    databasePlayer: { player: { id: 9 }, file: onlineFile },
  };
  await withCard(async (container, root) => {
    await renderCard(root, "overview", online);
    await choose(container, "online");
    expect(panels.overview.mock.calls.at(-1)?.[0]).toMatchObject({ info: onlineInfo });
    // The same card keeps the choice on a re-render.
    await renderCard(root, "overview", online);
    expect(panels.overview.mock.calls.at(-1)?.[0]).toMatchObject({ info: onlineInfo });

    await renderCard(root, "overview", online, "second");
    expect(panels.overview.mock.calls.at(-1)?.[0]).toMatchObject({ info: boardInfo });
    expect(
      container.querySelector<HTMLInputElement>(
        '[data-statistics-source] input[value="overTheBoard"]',
      )?.checked,
    ).toBe(true);
  });
});

test("the Openings tab has no source switch", async () => {
  await withCard(async (container, root) => {
    activeDatabaseViewStore.getState().setPlayersActiveTab("openings");
    await act(async () =>
      root.render(
        <MantineProvider>
          <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
            <PersonalPlayerCard
              name="Bergmann, Thomas"
              info={boardInfo}
              isDatabase
              databasePlayer={databasePlayer}
              online={{
                kind: "ready",
                info: onlineInfo,
                databasePlayer: { player: { id: 9 }, file: onlineFile },
              }}
            />
          </DatabaseViewStateContext.Provider>
        </MantineProvider>,
      ),
    );
    expect(container.querySelector("[data-database-openings]")).not.toBeNull();
    expect(sourceSwitch(container)).toBeNull();
  });
});

test("the Ratings tab shows the same loading and unavailable states for the online games", async () => {
  await withCard(async (container, root) => {
    await renderCard(root, "ratings", { kind: "pending" });
    expect(container.querySelector("[data-ratings]")).not.toBeNull();
    await choose(container, "online");
    expect(container.textContent).toContain("Databases.Player.ProcessingData");
    expect(container.querySelector("[data-ratings]")).toBeNull();

    await renderCard(root, "ratings", { kind: "unavailable" });
    expect(container.textContent).toContain("Databases.OpeningTree.OnlineUnavailable");
    expect(container.querySelector("[data-ratings]")).toBeNull();
  });
});

test("database player card renders Preparation tab while account card falls back to Overview without resetting stored activeTab", async () => {
  await withCard(async (container, root) => {
    activeDatabaseViewStore.getState().setPlayersActiveTab("preparation");
    // Database player card shows the Preparation tab and panel.
    await act(async () =>
      root.render(
        <MantineProvider>
          <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
            <PersonalPlayerCard
              name="Bergmann, Thomas"
              info={boardInfo}
              isDatabase
              databasePlayer={databasePlayer}
            />
          </DatabaseViewStateContext.Provider>
        </MantineProvider>,
      ),
    );
    expect(container.querySelector("[data-database-preparation]")).not.toBeNull();
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      "Home.Personal.Preparation",
    );

    // Account card has no Preparation tab: shows Overview while stored activeTab stays "preparation".
    await act(async () =>
      root.render(
        <MantineProvider>
          <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
            <PersonalPlayerCard
              name="Account Player"
              playerKey="lichess:account"
              setPlayerKey={vi.fn()}
              info={boardInfo}
            />
          </DatabaseViewStateContext.Provider>
        </MantineProvider>,
      ),
    );
    expect(container.querySelector("[data-database-preparation]")).toBeNull();
    expect(container.querySelector("[data-overview]")).not.toBeNull();
    expect(activeDatabaseViewStore.getState().players.activeTab).toBe("preparation");
  });
});
