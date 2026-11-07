import { WorkspaceTabScope } from "@/state/tabScope";
import { MantineProvider } from "@mantine/core";
import dayjs from "dayjs";
import { Provider as JotaiProvider, createStore as createJotaiStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { activeTabAtom, localOptionsFamily, tabsAtom } from "@/state/atoms";
import { installMatchMediaStub } from "@/tests/matchMedia";

const mocks = vi.hoisted(() => ({ searchPosition: vi.fn(), playerSearch: vi.fn() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
}));

// The board widgets are irrelevant to the filter controls and need a real layout engine.
vi.mock("@/chessground/Chessground", () => ({ Chessground: () => null }));
vi.mock("@/components/boards/PiecesGrid", () => ({ default: () => null }));
vi.mock("@/components/databases/PlayerSearchInput", () => ({
  PlayerSearchInput: mocks.playerSearch,
}));

vi.mock("@/platform/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
  return { ...actual, tauri: { ...actual.tauri, searchPosition: mocks.searchPosition } };
});

import { databaseHandleKey, searchPosition } from "@/utils/db";
import LocalOptionsPanel from "./LocalOptionsPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = MockResizeObserver;

installMatchMediaStub();

const tabId = "22222222-2222-4222-8222-222222222222";
const tab = {
  name: "Tab 1",
  value: tabId,
  type: "analysis" as const,
  gameOrigin: { kind: "none" as const },
};

describe("LocalOptionsPanel explorer filters", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createJotaiStore>;

  beforeEach(async () => {
    sessionStorage.clear();
    mocks.searchPosition.mockReset().mockResolvedValue([[], []]);
    mocks.playerSearch.mockReset().mockReturnValue(null);
    store = createJotaiStore();
    store.set(tabsAtom, [tab]);
    store.set(activeTabAtom, tabId);
    store.set(localOptionsFamily(tabId), (q) => ({
      ...q,
      path: { id: { id: "local" }, kind: "database" },
      fen: "8/8/8/8/8/8/8/8 w - - 0 1",
    }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <JotaiProvider store={store}>
          <WorkspaceTabScope tabId={tabId}>
            <MantineProvider>
              <LocalOptionsPanel boardFen="8/8/8/8/8/8/8/8 w - - 0 1" />
            </MantineProvider>
          </WorkspaceTabScope>
        </JotaiProvider>,
      );
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  test("captions the Elo band as applying to both players", () => {
    expect(container.textContent).toContain("Board.Database.Local.Elo.BothPlayers");
    expect(container.querySelectorAll(".mantine-RangeSlider-root")).toHaveLength(1);
  });

  test("player selection records its database owner and clearing removes the selection", async () => {
    const file = store.get(localOptionsFamily(tabId)).path!;
    expect(mocks.playerSearch.mock.lastCall?.[0].file).toEqual(file);
    await act(async () => mocks.playerSearch.mock.lastCall?.[0].setValue(42));
    expect(store.get(localOptionsFamily(tabId))).toMatchObject({
      player: 42,
      player_database: databaseHandleKey(file),
    });

    const otherFile = { ...file, id: { id: "other-database" } };
    await act(async () =>
      store.set(localOptionsFamily(tabId), (options) => ({ ...options, path: otherFile })),
    );
    await act(async () => mocks.playerSearch.mock.lastCall?.[0].setValue(42));
    expect(store.get(localOptionsFamily(tabId))).toMatchObject({
      player: 42,
      player_database: databaseHandleKey(otherFile),
    });

    await act(async () => mocks.playerSearch.mock.lastCall?.[0].setValue(undefined));
    expect(store.get(localOptionsFamily(tabId)).player).toBeNull();
    expect(store.get(localOptionsFamily(tabId)).player_database).toBeUndefined();
  });

  test("labels the exclude switch without rapid, shows name-based helper, and sends true", async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const accessibleName = input.getAttribute("aria-label") ?? "";
    expect(accessibleName).toBe("Board.Database.Local.ExcludeFastEvents");
    expect(accessibleName.toLowerCase()).not.toContain("rapid");
    expect(container.querySelector(".mantine-Switch-description")?.textContent).toBe(
      "Board.Database.Local.ExcludeFastEvents.Description",
    );

    await act(async () => {
      input.click();
    });

    expect(store.get(localOptionsFamily(tabId)).exclude_fast_events).toBe(true);
    await searchPosition(store.get(localOptionsFamily(tabId)), tabId);
    expect(mocks.searchPosition.mock.calls[0][1].exclude_fast_events).toBe(true);
  });

  test("the 3-year preset sets start_date to today minus three years and leaves end_date", async () => {
    const preset = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Board.Database.Local.LastYears:3",
    )!;

    await act(async () => {
      preset.click();
    });

    const options = store.get(localOptionsFamily(tabId));
    expect(options.start_date).toBe(dayjs().subtract(3, "year").format("YYYY.MM.DD"));
    expect(options.end_date).toBeUndefined();
  });
});
