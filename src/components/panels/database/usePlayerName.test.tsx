import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DatabaseHandle, ErrorPayload } from "@/bindings";

const mocks = vi.hoisted(() => ({ getPlayer: vi.fn(), warn: vi.fn() }));
vi.mock("@/platform/tauri", async (original) => {
  const actual = await original<typeof import("@/platform/tauri")>();
  return { ...actual, tauri: { ...actual.tauri, getPlayer: mocks.getPlayer } };
});
vi.mock("@/platform/errors", async (original) => ({
  ...(await original<typeof import("@/platform/errors")>()),
  warnSafely: mocks.warn,
}));

import { usePlayerName } from "./usePlayerName";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const database: DatabaseHandle = { kind: "database", id: { id: "mega" } };
let root: Root;
let container: HTMLDivElement;
let shown: (string | undefined)[];

function Probe({ player }: { player: number | null }) {
  shown.push(usePlayerName(database, player));
  return null;
}

async function mount(player: number | null) {
  // The application's own SWR defaults: retrying is the hook's decision, not the test's.
  await act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <Probe player={player} />
      </SWRConfig>,
    ),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.getPlayer.mockReset();
  mocks.warn.mockReset();
  shown = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

test("names the filtered player", async () => {
  mocks.getPlayer.mockResolvedValue({ id: 7, name: "Bergmann, Thomas", elo: 2026, game_count: 80 });
  await mount(7);
  await act(async () => {});
  expect(shown.at(-1)).toBe("Bergmann, Thomas");
  expect(mocks.getPlayer).toHaveBeenCalledExactlyOnceWith(database, 7);
});

test("asks nothing without a player filter", async () => {
  await mount(null);
  expect(shown.at(-1)).toBeUndefined();
  expect(mocks.getPlayer).not.toHaveBeenCalled();
});

test("a failed lookup is logged once, never retried, and leaves the name unknown", async () => {
  mocks.getPlayer.mockRejectedValue(new Error("database is locked"));
  await mount(7);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(shown.at(-1)).toBeUndefined();
  expect(mocks.getPlayer).toHaveBeenCalledOnce();
  expect(mocks.warn).toHaveBeenCalledOnce();
  expect(mocks.warn.mock.calls[0][0]).toContain("database is locked");
});

test("a cancelled lookup is not logged", async () => {
  mocks.getPlayer.mockRejectedValue({
    tag: "backend-error",
    category: "cancellation",
    message: "Cancellation",
  } satisfies ErrorPayload);
  await mount(7);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(shown.at(-1)).toBeUndefined();
  expect(mocks.warn).not.toHaveBeenCalled();
});
