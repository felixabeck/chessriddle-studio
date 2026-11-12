import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { activeDatabaseViewStore } from "@/state/store/database";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { DatabaseViewStateContext } from "../databases/DatabaseViewStateContext";
import PersonalPlayerCard from "./PersonalCard";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../databases/FideInfo", () => ({ default: () => null }));
vi.mock("./PersonalCardPanels/OpeningsPanel", () => ({
  default: () => <div data-accounts-openings />,
}));
vi.mock("./PersonalCardPanels/OverviewPanel", () => ({ default: () => null }));
vi.mock("./PersonalCardPanels/RatingsPanel", () => ({ default: () => null }));
vi.mock("../databases/PlayerOpeningTree", () => ({
  default: () => <div data-database-openings />,
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
                setName={vi.fn()}
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
