import { MantineProvider } from "@mantine/core";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, test, vi } from "vitest";
import type { PlayerGameInfo } from "@/bindings";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import enUS from "@/translation/en-US.json";
import OverviewPanel from "./OverviewPanel";

vi.mock("./LastGamesList", () => ({ default: () => null }));
vi.mock("./TimeControlSelector", () => ({ default: () => null }));
vi.mock("./WebsiteAccountSelector", () => ({ default: () => null }));
vi.mock("recharts", () => ({
  Bar: () => null,
  BarChart: () => null,
  CartesianGrid: () => null,
  ResponsiveContainer: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

test("Overview headline real ResultsChart hover labels are Wins and Losses in en-US", async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "en-US", resources: { "en-US": enUS }, keySeparator: false });
  const info: PlayerGameInfo = {
    site_stats_data: [
      {
        site: "Lichess",
        player: "Magnus",
        daily: [],
        openings: [],
        latest: [],
        colors: [
          {
            time_control: "600+0",
            is_player_white: true,
            won: 2,
            drawn: 1,
            lost: 3,
            rated_won: 0,
            rated_drawn: 0,
            rated_lost: 0,
            opponent_elo_sum: 0,
          },
        ],
      },
    ],
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <I18nextProvider i18n={i18n}>
        <MantineProvider>
          <OverviewPanel playerName="Magnus" info={info} isDatabase />
        </MantineProvider>
      </I18nextProvider>,
    ),
  );

  const sections = container.querySelectorAll(
    "[data-testid='overview-headline'] .mantine-Progress-section",
  );
  expect(sections).toHaveLength(3);
  for (const [index, label] of [
    [0, "2 Wins"],
    [2, "3 Losses"],
  ] as const) {
    await act(async () => {
      sections[index].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      sections[index].dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    });
    await vi.waitFor(() => {
      const labels = Array.from(
        document.querySelectorAll('[role="tooltip"]'),
        (node) => node.textContent,
      );
      expect(labels).toContain(label);
      expect(labels.join(" ")).not.toMatch(/White won|Black won/i);
    });
    await act(async () => {
      sections[index].dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
      sections[index].dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    });
  }
});
