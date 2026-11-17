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

  test("re-selecting the current colour keeps it instead of storing null", async () => {
    const input = container.querySelector<HTMLInputElement>(
      '.mantine-Select-input[placeholder="Common.PickValue"]',
    )!;
    expect(input.value).toBe("Fen.White");
    await act(async () => input.click());
    const white = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (option) => option.textContent === "Fen.White",
    );
    expect(white).toBeDefined();
    await act(async () => white!.click());
    expect(store.get(lichessOptionsAtom)).toMatchObject({
      player: "DrNykterstein",
      color: "white",
    });
    expect(input.value).toBe("Fen.White");
  });
});
