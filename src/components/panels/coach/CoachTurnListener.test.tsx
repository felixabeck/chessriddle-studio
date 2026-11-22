import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import type { CoachTurnEvent } from "@/bindings";

const mocks = vi.hoisted(() => ({
  listener: undefined as ((event: { payload: unknown }) => void) | undefined,
  unlisten: vi.fn(),
  apply: vi.fn(),
}));
vi.mock("@/platform/tauri", () => ({
  tauriSubscriptions: {
    coachTurn: (callback: (event: { payload: unknown }) => void) => {
      mocks.listener = callback;
      return Promise.resolve(mocks.unlisten);
    },
  },
}));
vi.mock("@/state/coachTurns", () => ({ applyCoachTurnEvent: mocks.apply }));

const { CoachTurnListener } = await import("./CoachTurnListener");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test("turn events are applied in arrival order to the app's atoms, until the shell goes", async () => {
  const atoms = createStore();
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <Provider store={atoms}>
        <CoachTurnListener />
      </Provider>,
    ),
  );
  const event = (delta: string): CoachTurnEvent => ({
    tab: "tab",
    turn: "turn",
    update: { type: "text", delta },
  });
  await act(async () => {
    mocks.listener!({ payload: event("first") });
    mocks.listener!({ payload: event("second") });
  });
  // Each handler first awaits the on-demand turn logic.
  await vi.waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(2));
  expect(mocks.apply.mock.calls).toEqual([
    [atoms, event("first")],
    [atoms, event("second")],
  ]);
  await act(async () => root.unmount());
  expect(mocks.unlisten).toHaveBeenCalledOnce();
});
