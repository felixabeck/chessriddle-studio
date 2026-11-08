import { MantineProvider } from "@mantine/core";
import type { i18n } from "i18next";
import { Provider, createStore } from "jotai";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Event as Tournament, NormalizedGame } from "@/bindings";
import PanelGamesTable from "@/components/panels/database/GamesTable";
import { activeDatabaseViewStore } from "@/state/store/database";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { catalogueI18n } from "@/tests/catalogues";
import { supportedLocales } from "@/i18n";
import type { SuccessDatabaseInfo } from "@/utils/db";
import { DatabaseViewStateContext } from "./DatabaseViewStateContext";
import GameTable from "./GameTable";
import PlayerTable from "./PlayerTable";
import TournamentCard from "./TournamentCard";
import TournamentTable from "./TournamentTable";

const mocks = vi.hoisted(() => ({ empty: false }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("swr", async (original) => ({
  ...(await original<typeof import("swr")>()),
  default: (key: readonly unknown[]) => ({
    data: {
      data: mocks.empty
        ? []
        : key[0] === "games"
          ? [game]
          : key[0] === "players"
            ? [{ id: 1, name: "Alice", elo: 1800, game_count: 15 }]
            : [
                {
                  ...tournament,
                  start_date: "2025.01.17",
                  end_date: "2025.02.02",
                  site: "Berlin",
                  player_count: 12,
                  game_count: 30,
                  avg_elo: 2250,
                },
              ],
      count: mocks.empty ? 0 : 1,
    },
    isLoading: false,
  }),
}));
vi.mock("swr/immutable", () => ({
  default: () => ({ data: mocks.empty ? [] : [game], isLoading: false }),
}));
vi.mock("./PlayerSearchInput", () => ({ PlayerSearchInput: () => null }));
vi.mock("./SideInput", () => ({ SideInput: () => null }));
vi.mock("./GameCard", () => ({ default: () => null }));
vi.mock("./PlayerCard", () => ({ default: () => null }));

const file = { id: { id: "locale-database" }, kind: "database" } as const;
const tournament = {
  id: 1,
  name: "Fixture",
  start_date: null,
  end_date: null,
  site: null,
  player_count: 0,
  game_count: 0,
  avg_elo: null,
} satisfies Tournament;
const game = {
  id: 1,
  white: "Alice",
  black: "Bob",
  white_elo: 0,
  black_elo: 0,
  date: "2026.11.01",
  result: "1-0",
  ply_count: 2,
  event: "Fixture",
  site: "Berlin",
} as NormalizedGame;

installMatchMediaStub({ matches: (query) => query === "" });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let host: HTMLDivElement;
let root: Root;
let locale: i18n;
let jotai: ReturnType<typeof createStore>;
beforeEach(async () => {
  mocks.empty = false;
  sessionStorage.clear();
  activeDatabaseViewStore.getState().clearDatabase();
  activeDatabaseViewStore.getState().setDatabase({ file, title: "Fixture" } as SuccessDatabaseInfo);
  jotai = createStore();
  locale = await catalogueI18n("de-DE");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  activeDatabaseViewStore.getState().clearDatabase();
});

async function render(children: ReactNode) {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <I18nextProvider i18n={locale}>
          <Provider store={jotai}>
            <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
              {children}
            </DatabaseViewStateContext.Provider>
          </Provider>
        </I18nextProvider>
      </MantineProvider>,
    ),
  );
}

function headers() {
  return [...host.querySelector("table")!.querySelectorAll("th")].map(
    (header) => header.textContent,
  );
}

test("GameTable renders German column headers without an English fallback", async () => {
  await render(<GameTable />);
  expect(headers()).toEqual([
    "Weiß",
    "Schwarz",
    "Datum",
    "Ergebnis",
    "Halbzüge",
    "Ereignis",
    "Ort",
  ]);
});

test("board-panel games render German column headers", async () => {
  await render(<PanelGamesTable games={[game]} loading={false} databasePath={file} />);
  expect(headers()).toEqual(["Weiß", "Schwarz", "Datum", "Ergebnis", "Halbzüge"]);
});

test("board-panel games render both German unrated labels", async () => {
  await render(<PanelGamesTable games={[game]} loading={false} databasePath={file} />);
  expect(
    [...host.querySelectorAll("tbody td")].filter((cell) =>
      cell.textContent?.includes("Ungewertet"),
    ),
  ).toHaveLength(2);
});

test("board-panel games render the German empty state", async () => {
  await render(<PanelGamesTable games={[]} loading={false} databasePath={file} />);
  expect(host.textContent).toContain("Keine Partien gefunden");
});

test.each(["games", "tournament"])("%s renders both German unrated labels", async (view) => {
  await render(
    view === "games" ? <GameTable /> : <TournamentCard tournament={tournament} file={file} />,
  );
  expect(
    [...host.querySelectorAll("tbody td")].filter((cell) =>
      cell.textContent?.includes("Ungewertet"),
    ),
  ).toHaveLength(2);
});

test.each(["games", "tournament"])("%s renders its German empty state", async (view) => {
  mocks.empty = true;
  await render(
    view === "games" ? <GameTable /> : <TournamentCard tournament={tournament} file={file} />,
  );
  expect(host.textContent).toContain("Keine Partien gefunden");
});

test.each(["games", "players", "tournaments", "tournament"])(
  "%s renders the German records-per-page label",
  async (view) => {
    await render(
      view === "games" ? (
        <GameTable />
      ) : view === "players" ? (
        <PlayerTable />
      ) : view === "tournaments" ? (
        <TournamentTable />
      ) : (
        <TournamentCard tournament={tournament} file={file} />
      ),
    );
    expect(host.textContent).toContain("Einträge pro Seite");
  },
);

test("TournamentCard renders German game headers and leaves the actions header empty", async () => {
  await render(<TournamentCard tournament={tournament} file={file} />);
  expect(headers()).toEqual(["", "Weiß", "Schwarz", "Datum", "Ergebnis", "Halbzüge"]);
});

test("PlayerTable renders translated column titles", async () => {
  await render(<PlayerTable />);
  expect(headers()).toEqual(["ID", "Name", "Elo", "Spiele"]);
  const count = host.querySelectorAll<HTMLElement>("tbody td")[3];
  expect(count.textContent).toBe("15");
  expect(count.style.fontVariantNumeric).toBe("tabular-nums");
});

test("TournamentTable renders translated column titles", async () => {
  await render(<TournamentTable />);
  expect(headers()).toEqual(["Name", "Datum", "Ort", "Spieler", "Spiele", "Ø Elo"]);
});

function expectDate(cell: HTMLElement) {
  expect(cell.classList.contains("mantine-datatable-nowrap")).toBe(true);
  expect(cell.style.width).toBe("");
}

function expectNumeric(cell: HTMLElement) {
  expectDate(cell);
  expect(cell.classList.contains("mantine-datatable-text-align-right")).toBe(true);
  expect(cell.style.fontVariantNumeric).toBe("tabular-nums");
}

function expectTruncated(cell: HTMLElement, value: string) {
  const text = cell.querySelector("span")!;
  expect(text.textContent).toBe(value);
  expect(text.title).toBe(value);
  expect(text.style.whiteSpace).toBe("nowrap");
  expect(text.style.textOverflow).toBe("ellipsis");
  expect(text.style.overflow).toBe("hidden");
  expect(text.style.maxWidth).toBe("16rem");
}

test("TournamentTable renders the shared date, site and numeric presets", async () => {
  await render(<TournamentTable />);
  const cells = host.querySelectorAll<HTMLElement>("tbody tr:first-child td");
  expect(cells[0].textContent).toBe("Fixture");
  expect(cells[0].style.maxWidth).toBe("");
  expect(cells[1].textContent).toBe("2025.01.17 – 02.02");
  expectDate(cells[1]);
  expectTruncated(cells[2], "Berlin");
  for (const index of [3, 4, 5]) expectNumeric(cells[index]);
  expect([...cells].map((cell) => cell.textContent)).toEqual([
    "Fixture",
    "2025.01.17 – 02.02",
    "Berlin",
    "12",
    "30",
    "2250",
  ]);
  const columns = [...host.querySelectorAll("th")];
  expect(
    columns.map((column) => column.classList.contains("mantine-datatable-header-cell-sortable")),
  ).toEqual([true, true, false, true, true, true]);
});

test("PlayerTable renders Elo and Games with the shared numeric preset", async () => {
  await render(<PlayerTable />);
  const cells = host.querySelectorAll<HTMLElement>("tbody tr:first-child td");
  expectNumeric(cells[2]);
  expectNumeric(cells[3]);
});

test("GameTable renders shared date, plies, event and site presets without reformatting dates", async () => {
  await render(<GameTable />);
  const cells = host.querySelectorAll<HTMLElement>("tbody tr:first-child td");
  expectDate(cells[2]);
  expect(cells[2].textContent).toBe(game.date);
  expectNumeric(cells[4]);
  expectTruncated(cells[5], game.event);
  expectTruncated(cells[6], game.site);
});

test("board-panel GamesTable renders the shared date and numeric presets", async () => {
  await render(<PanelGamesTable games={[game]} loading={false} databasePath={file} />);
  const cells = host.querySelectorAll<HTMLElement>("tbody tr:first-child td");
  expectDate(cells[2]);
  expect(cells[2].textContent).toBe(game.date);
  expectNumeric(cells[4]);
});

test("TournamentCard renders shared Games and Leaderboard presets", async () => {
  await render(
    <TournamentCard
      tournament={{
        ...tournament,
        player_count: 2,
        game_count: 1,
      }}
      file={file}
    />,
  );
  const cells = host.querySelectorAll<HTMLElement>("table:first-of-type tbody tr:first-child td");
  expectDate(cells[3]);
  expect(cells[3].textContent).toBe(game.date);
  expectNumeric(cells[5]);
  await act(async () => activeDatabaseViewStore.getState().setTournamentsActiveTab("leaderboard"));
  const leaderboard = host.querySelector('[role="tabpanel"][id$="-panel-leaderboard"]')!;
  const ranks = leaderboard.querySelectorAll<HTMLElement>("tbody tr");
  expect(ranks.length).toBe(2);
  for (const row of ranks) {
    expectNumeric(row.children[0] as HTMLElement);
    expectNumeric(row.children[2] as HTMLElement);
  }
});

test.each(supportedLocales)(
  "Events Avg Elo header is translated in %s without fallback",
  async (language) => {
    const translated = await catalogueI18n(language);
    expect(translated.exists("Databases.Tournament.AvgElo")).toBe(true);
    expect(translated.t("Databases.Tournament.AvgElo")).not.toBe("");
    expect(translated.t("Databases.Tournament.AvgElo")).not.toBe("Databases.Tournament.AvgElo");
  },
);

test.each(["en-US", "de-DE"] as const)(
  "Events Avg Elo uses the specified %s title",
  async (language) => {
    const translated = await catalogueI18n(language);
    expect(translated.t("Databases.Tournament.AvgElo")).toBe(
      { "en-US": "Avg Elo", "de-DE": "Ø Elo" }[language],
    );
  },
);

test.each(["players", "tournaments"])("%s renders French headers", async (view) => {
  locale = await catalogueI18n("fr-FR");
  await render(view === "players" ? <PlayerTable /> : <TournamentTable />);
  expect(headers().slice(0, 2)).toEqual(view === "players" ? ["ID", "Nom"] : ["Nom", "Date"]);
});

test("TournamentCard renders the German empty leaderboard", async () => {
  mocks.empty = true;
  activeDatabaseViewStore.getState().setTournamentsActiveTab("leaderboard");
  await render(<TournamentCard tournament={tournament} file={file} />);
  expect(host.querySelector('[role="tabpanel"][id$="-panel-leaderboard"]')?.textContent).toContain(
    "Keine Spieler gefunden",
  );
});
