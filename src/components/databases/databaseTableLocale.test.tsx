import { MantineProvider } from "@mantine/core";
import type { i18n } from "i18next";
import { Provider, createStore } from "jotai";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { NormalizedGame } from "@/bindings";
import { activeDatabaseViewStore } from "@/state/store/database";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { catalogueI18n } from "@/tests/catalogues";
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
            ? [{ id: 1, name: "Alice", elo: 1800 }]
            : [{ id: 1, name: "Fixture" }],
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

test.each(["games", "tournament"])("%s renders both German unrated labels", async (view) => {
  await render(
    view === "games" ? (
      <GameTable />
    ) : (
      <TournamentCard tournament={{ id: 1, name: "Fixture" }} file={file} />
    ),
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
    view === "games" ? (
      <GameTable />
    ) : (
      <TournamentCard tournament={{ id: 1, name: "Fixture" }} file={file} />
    ),
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
        <TournamentCard tournament={{ id: 1, name: "Fixture" }} file={file} />
      ),
    );
    expect(host.textContent).toContain("Einträge pro Seite");
  },
);

test("TournamentCard renders German game headers and leaves the actions header empty", async () => {
  await render(<TournamentCard tournament={{ id: 1, name: "Fixture" }} file={file} />);
  expect(headers()).toEqual(["", "Weiß", "Schwarz", "Datum", "Ergebnis", "Halbzüge"]);
});

test("PlayerTable renders translated column titles", async () => {
  await render(<PlayerTable />);
  expect(headers()).toEqual(["ID", "Name", "Elo"]);
});

test("TournamentTable renders translated column titles", async () => {
  await render(<TournamentTable />);
  expect(headers()).toEqual(["ID", "Name"]);
});

test.each(["players", "tournaments"])("%s renders French ID and name headers", async (view) => {
  locale = await catalogueI18n("fr-FR");
  await render(view === "players" ? <PlayerTable /> : <TournamentTable />);
  expect(headers().slice(0, 2)).toEqual(["ID", "Nom"]);
});

test("TournamentCard renders the German empty leaderboard", async () => {
  mocks.empty = true;
  activeDatabaseViewStore.getState().setTournamentsActiveTab("leaderboard");
  await render(<TournamentCard tournament={{ id: 1, name: "Fixture" }} file={file} />);
  expect(host.querySelector('[role="tabpanel"][id$="-panel-leaderboard"]')?.textContent).toContain(
    "Keine Spieler gefunden",
  );
});
