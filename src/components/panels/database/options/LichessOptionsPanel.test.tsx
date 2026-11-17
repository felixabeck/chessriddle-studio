import { MantineProvider } from "@mantine/core";
import { Provider as JotaiProvider, createStore as createJotaiStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { lichessOptionsAtom } from "@/state/atoms";
import { installMatchMediaStub } from "@/tests/matchMedia";
import LichessOptionsPanel from "./LichessOptionsPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = MockResizeObserver;

installMatchMediaStub();

describe("LichessOptionsPanel filters", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createJotaiStore>;
  const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

  beforeEach(async () => {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    store = createJotaiStore();
    store.set(lichessOptionsAtom, {
      ratings: [2200, 2500],
      speeds: ["blitz"],
      player: "DrNykterstein",
      color: "white",
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <JotaiProvider store={store}>
          <MantineProvider>
            <LichessOptionsPanel />
          </MantineProvider>
        </JotaiProvider>,
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    if (originalScroll) Object.defineProperty(Element.prototype, "scrollIntoView", originalScroll);
    else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  });

  const colourInputs = () =>
    Array.from(
      container.querySelectorAll<HTMLInputElement>(".mantine-SegmentedControl-input"),
    ).filter((input) => input.value === "white" || input.value === "black");

  test("choosing the other colour stores it and re-selecting keeps it", async () => {
    const black = colourInputs().find((input) => input.value === "black")!;
    await act(async () => black.click());
    expect(store.get(lichessOptionsAtom)).toMatchObject({
      player: "DrNykterstein",
      color: "black",
    });
    await act(async () => black.click());
    expect(store.get(lichessOptionsAtom).color).toBe("black");
  });

  test.each([undefined, "", " "])(
    "the colour control is disabled while the player is %j",
    async (player) => {
      expect(colourInputs()).toHaveLength(2);
      expect(colourInputs().every((input) => !input.disabled)).toBe(true);
      await act(async () => store.set(lichessOptionsAtom, (options) => ({ ...options, player })));
      expect(colourInputs().every((input) => input.disabled)).toBe(true);
    },
  );

  test("orders the filters like the local panel and uses its wording", () => {
    const text = container.textContent ?? "";
    const positions = [
      "Board.Database.Local.Player",
      "Board.Database.Local.PlaysAs",
      "Common.From",
      "Common.To",
      "Board.Database.AverageRating",
      "Board.Database.TimeControl",
    ].map((key) => text.indexOf(key));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(text).not.toContain("Common.Since");
    expect(text).not.toContain("Board.Database.Local.Color");
  });

  // 00:30 on 1 January in Berlin is still 31 December in UTC: the stored day must be the local one.
  test("a year shortcut stores the local calendar day as a UTC day and leaves the end alone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 0, 1, 0, 30));
      const preset = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Board.Database.Local.LastYears:3",
      )!;
      await act(async () => preset.click());
      const { since, until } = store.get(lichessOptionsAtom);
      expect(since?.toISOString()).toBe("2023-01-01T00:00:00.000Z");
      expect(until).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
