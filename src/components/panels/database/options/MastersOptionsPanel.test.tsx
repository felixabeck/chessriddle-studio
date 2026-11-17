import { MantineProvider } from "@mantine/core";
import { Provider as JotaiProvider, createStore as createJotaiStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { masterOptionsAtom } from "@/state/atoms";
import { installMatchMediaStub } from "@/tests/matchMedia";
import MasterOptionsPanel from "./MastersOptionsPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();

describe("MasterOptionsPanel filters", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createJotaiStore>;

  beforeEach(async () => {
    store = createJotaiStore();
    store.set(masterOptionsAtom, { until: new Date("2020-01-01") });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <JotaiProvider store={store}>
          <MantineProvider>
            <MasterOptionsPanel />
          </MantineProvider>
        </JotaiProvider>,
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  test("labels the range From and To with the local panel's placeholders", () => {
    const text = container.textContent ?? "";
    expect(text).toContain("Common.From");
    expect(text).toContain("Common.To");
    expect(text).toContain("Common.StartDate");
    expect(text).not.toContain("Common.Since");
  });

  test("a year shortcut sets the start as a UTC day and keeps the stored end", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 0, 1, 0, 30));
      const preset = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Board.Database.Local.LastYears:10",
      )!;
      await act(async () => preset.click());
      const { since, until } = store.get(masterOptionsAtom);
      expect(since?.toISOString()).toBe("2016-01-01T00:00:00.000Z");
      expect(until?.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});
