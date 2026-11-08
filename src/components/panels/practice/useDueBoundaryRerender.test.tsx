import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { useDueBoundaryRerender } from "./useDueBoundaryRerender";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Boundary({ nextDue, owner }: { nextDue: Date | null; owner: string }) {
  useDueBoundaryRerender(nextDue, owner);
  return null;
}

test("due timers are absent for null and cleared on owner change and unmount", async () => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  const root = createRoot(host);
  const baseline = vi.getTimerCount();
  try {
    await act(async () => root.render(<Boundary nextDue={null} owner="first" />));
    expect(vi.getTimerCount()).toBe(baseline);
    const nextDue = new Date(Date.now() + 1_000);
    await act(async () => root.render(<Boundary nextDue={nextDue} owner="first" />));
    expect(vi.getTimerCount()).toBe(baseline + 1);
    await act(async () => root.render(<Boundary nextDue={nextDue} owner="second" />));
    expect(vi.getTimerCount()).toBe(baseline + 1);
  } finally {
    await act(async () => root.unmount());
    try {
      expect(vi.getTimerCount()).toBe(baseline);
      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      expect(vi.getTimerCount()).toBe(baseline);
    } finally {
      vi.useRealTimers();
    }
  }
});
