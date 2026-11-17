import { MantineProvider } from "@mantine/core";
import { Provider as JotaiProvider, createStore as createJotaiStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { lichessOptionsAtom } from "@/state/atoms";
import { installMatchMediaStub } from "@/tests/matchMedia";
import LichessOptionsPanel from "./LichessOptionsPanel";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = MockResizeObserver;

installMatchMediaStub();

describe("LichessOptionsPanel colour", () => {
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

  test("the colour control is disabled while no player is named", async () => {
    expect(colourInputs()).toHaveLength(2);
    expect(colourInputs().every((input) => !input.disabled)).toBe(true);
    await act(async () =>
      store.set(lichessOptionsAtom, (options) => ({ ...options, player: " " })),
    );
    expect(colourInputs().every((input) => input.disabled)).toBe(true);
  });

  test("uses the same date wording as the local panel and a year shortcut sets only the start", async () => {
    expect(container.textContent).toContain("Common.From");
    expect(container.textContent).toContain("Common.To");
    const preset = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Board.Database.Local.LastYears",
    )!;
    await act(async () => preset.click());
    const { since, until } = store.get(lichessOptionsAtom);
    expect(since?.getFullYear()).toBe(new Date().getFullYear() - 1);
    expect(until).toBeUndefined();
  });
});
