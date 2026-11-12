import { WorkspaceTabScope } from "@/state/tabScope";
import { MantineProvider } from "@mantine/core";
import dayjs from "dayjs";
import { Provider as JotaiProvider, createStore as createJotaiStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { activeTabAtom, localOptionsFamily, tabsAtom } from "@/state/atoms";
import { installMatchMediaStub } from "@/tests/matchMedia";
import type { DatabaseHandle, Player } from "@/bindings";

const mocks = vi.hoisted(() => ({
  searchPosition: vi.fn(),
  getPlayer: vi.fn(),
  getPlayers: vi.fn(),
}));

function translate(key: string, options?: { count?: number }) {
  return options?.count === undefined ? key : `${key}:${options.count}`;
}
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: translate }) }));

// The board widgets are irrelevant to the filter controls and need a real layout engine.
vi.mock("@/chessground/Chessground", () => ({ Chessground: () => null }));
vi.mock("@/components/boards/PiecesGrid", () => ({ default: () => null }));

vi.mock("@/platform/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      searchPosition: mocks.searchPosition,
      getPlayer: mocks.getPlayer,
      getPlayers: mocks.getPlayers,
    },
  };
});

import { databaseHandleKey, NAME_SEARCH_DEBOUNCE_MS, searchPosition } from "@/utils/db";
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
const databaseA: DatabaseHandle = { id: { id: "local" }, kind: "database" };
const databaseB: DatabaseHandle = { id: { id: "other-database" }, kind: "database" };
const playerA: Player = { id: 42, name: "A player", elo: 2000, game_count: 3 };
const playerB: Player = { ...playerA, name: "B player" };

describe("LocalOptionsPanel explorer filters", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createJotaiStore>;
  const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

  async function renderPanel(database: DatabaseHandle | null = databaseA) {
    await act(async () => {
      root.render(
        <JotaiProvider store={store}>
          <WorkspaceTabScope tabId={tabId}>
            <MantineProvider>
              <LocalOptionsPanel boardFen="8/8/8/8/8/8/8/8 w - - 0 1" database={database} />
            </MantineProvider>
          </WorkspaceTabScope>
        </JotaiProvider>,
      );
    });
  }

  function playerInput() {
    return container.querySelector<HTMLInputElement>(".mantine-Autocomplete-input")!;
  }

  async function enterPlayer(text: string) {
    await act(async () => {
      playerInput().focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        playerInput(),
        text,
      );
      playerInput().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(NAME_SEARCH_DEBOUNCE_MS));
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    sessionStorage.clear();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    mocks.searchPosition.mockReset().mockResolvedValue([[], []]);
    mocks.getPlayer
      .mockReset()
      .mockImplementation(async (file: DatabaseHandle) =>
        databaseHandleKey(file) === databaseHandleKey(databaseA) ? playerA : playerB,
      );
    mocks.getPlayers.mockReset().mockResolvedValue({ data: [playerB], count: 1 });
    store = createJotaiStore();
    store.set(tabsAtom, [tab]);
    store.set(activeTabAtom, tabId);
    store.set(localOptionsFamily(tabId), (q) => ({
      ...q,
      path: databaseA,
      fen: "8/8/8/8/8/8/8/8 w - - 0 1",
    }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await renderPanel();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    if (originalScroll) Object.defineProperty(Element.prototype, "scrollIntoView", originalScroll);
    else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    vi.useRealTimers();
  });

  test("captions the Elo band as applying to both players", () => {
    expect(container.textContent).toContain("Board.Database.Local.Elo.BothPlayers");
    expect(container.querySelectorAll(".mantine-RangeSlider-root")).toHaveLength(1);
  });

  test("effective database B ignores A's stored player and path, then records a real B selection", async () => {
    await act(async () =>
      store.set(localOptionsFamily(tabId), (options) => ({
        ...options,
        player: 42,
        player_database: databaseHandleKey(databaseA),
      })),
    );
    expect(playerInput().value).toBe("A player");
    mocks.getPlayer.mockClear();
    await renderPanel(databaseB);
    expect(playerInput().value).toBe("");
    expect(mocks.getPlayer).not.toHaveBeenCalled();
    expect(store.get(localOptionsFamily(tabId)).path).toEqual(databaseA);

    await enterPlayer("B");
    expect(mocks.getPlayers.mock.lastCall?.[0]).toEqual(databaseB);
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (item) => item.textContent === "B player",
    );
    expect(option).toBeDefined();
    await act(async () => option!.click());
    expect(playerInput().value).toBe("B player");
    expect(store.get(localOptionsFamily(tabId))).toMatchObject({
      player: 42,
      player_database: databaseHandleKey(databaseB),
    });
    await searchPosition({ ...store.get(localOptionsFamily(tabId)), path: databaseB }, tabId);
    expect(mocks.searchPosition.mock.lastCall?.[0]).toEqual(databaseB);
    expect(mocks.searchPosition.mock.lastCall?.[1].player1).toBe(42);

    await enterPlayer("");
    expect(store.get(localOptionsFamily(tabId)).player).toBeNull();
    expect(store.get(localOptionsFamily(tabId)).player_database).toBeUndefined();
  });

  test("A to B to A resets suggestions and ignores a late A lookup while preserving the selection", async () => {
    let finishLookup!: (player: Player) => void;
    mocks.getPlayer.mockReturnValueOnce(
      new Promise((resolve) => {
        finishLookup = resolve;
      }),
    );
    await act(async () =>
      store.set(localOptionsFamily(tabId), (options) => ({
        ...options,
        player: 42,
        player_database: databaseHandleKey(databaseA),
      })),
    );
    await renderPanel(databaseB);
    await act(async () => finishLookup(playerA));
    expect(playerInput().value).toBe("");
    expect(
      mocks.getPlayer.mock.calls.every(
        ([file]) => databaseHandleKey(file) === databaseHandleKey(databaseA),
      ),
    ).toBe(true);
    await enterPlayer("B");
    expect(document.body.textContent).toContain("B player");
    await renderPanel(databaseA);
    expect(playerInput().value).toBe("A player");
    expect(
      Array.from(document.querySelectorAll('[role="option"]'), (option) => option.textContent),
    ).not.toContain("B player");
    expect(store.get(localOptionsFamily(tabId)).player).toBe(42);
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
