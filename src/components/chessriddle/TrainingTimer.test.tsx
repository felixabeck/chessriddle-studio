import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { defaultTrainingSettings } from "@/state/chessRiddleTrainingSettings";
import TrainingTimer from "./TrainingTimer";
vi.mock("@mantine/core", () => ({
  Text: ({ children, c }: { children: React.ReactNode; c?: string }) => (
    <span data-color={c}>{children}</span>
  ),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
test.each(["up", "down"])(
  "timer counts %s, clamps at zero and cleans its interval",
  async (mode) => {
    vi.useFakeTimers();
    let now = 2000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <TrainingTimer
          start={1000}
          settings={{ ...defaultTrainingSettings, timerMode: mode, timerDuration: 60 }}
        />,
      ),
    );
    expect(host.textContent).toBe(mode === "up" ? "0:01" : "0:59");
    expect(vi.getTimerCount()).toBe(1);
    now = 62000;
    await act(async () => vi.advanceTimersByTime(100));
    expect(host.textContent).toBe(mode === "up" ? "1:01" : "0:00");
    expect(host.firstElementChild?.getAttribute("data-color")).toBe(
      mode === "down" ? "warning" : null,
    );
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    host.remove();
  },
);
