import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DatabaseHandle } from "@/bindings";

const mocks = vi.hoisted(() => ({
  queryPlayers: vi.fn(),
  getPlayer: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("@/utils/db", () => ({ query_players: mocks.queryPlayers }));
vi.mock("@/platform/tauri", () => ({ tauri: { getPlayer: mocks.getPlayer } }));
vi.mock("@/components/files/notifyError", () => ({ notifyUnlessCancelled: mocks.notify }));
vi.mock("react-i18next", () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock("lucide-react", () => ({ Search: () => null }));
vi.mock("@mantine/core", () => ({
  Autocomplete: ({
    value,
    data,
    onChange,
  }: {
    value: string;
    data: string[];
    onChange: (value: string) => void;
    leftSection?: ReactNode;
  }) => (
    <>
      <input value={value} onChange={(event) => onChange(event.currentTarget.value)} />
      <button type="button" onClick={() => onChange("Ada")}>
        search
      </button>
      <output>{data.join(",")}</output>
    </>
  ),
}));

import { PlayerSearchInput } from "./PlayerSearchInput";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const file = (id: string): DatabaseHandle => ({ id: { id }, kind: "database" });
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPlayer.mockReset();
  mocks.queryPlayers.mockReset();
  mocks.notify.mockReset();
  mocks.getPlayer.mockResolvedValue(null);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(database: DatabaseHandle) {
  await act(async () =>
    root.render(<PlayerSearchInput label="Player" file={database} setValue={vi.fn()} />),
  );
}

test("file replacement cancels the active native search and refuses its stale result", async () => {
  let resolve!: (value: { data: Array<{ id: number; name: string }>; count: number }) => void;
  let signal!: AbortSignal;
  mocks.queryPlayers.mockImplementation(
    (_file: unknown, _query: unknown, options: { signal: AbortSignal }) =>
      new Promise((done) => {
        signal = options.signal;
        resolve = done;
      }),
  );
  await render(file("first"));
  await act(async () => {
    container.querySelector("button")!.click();
  });
  await vi.waitFor(() => expect(mocks.queryPlayers).toHaveBeenCalledOnce());
  await render(file("second"));
  expect(signal.aborted).toBe(true);
  resolve({ data: [{ id: 1, name: "Ada" }], count: 1 });
  await act(async () => Promise.resolve());
  expect(container.querySelector("output")?.textContent).toBe("");
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("a stale getPlayer rejection is silent after value changes while a current rejection notifies", async () => {
  let rejectStale!: (reason: Error) => void;
  const staleLookup = new Promise<never>((_, fail) => {
    rejectStale = fail;
  });
  mocks.getPlayer.mockImplementation((_handle: DatabaseHandle, id: number) => {
    if (id === 1) return staleLookup;
    if (id === 3) return Promise.reject(new Error("current lookup"));
    return Promise.resolve(null);
  });
  await act(async () =>
    root.render(
      <PlayerSearchInput label="Player" file={file("db")} value={1} setValue={vi.fn()} />,
    ),
  );
  await vi.waitFor(() => expect(mocks.getPlayer).toHaveBeenCalledWith(file("db"), 1));
  await act(async () =>
    root.render(
      <PlayerSearchInput label="Player" file={file("db")} value={2} setValue={vi.fn()} />,
    ),
  );
  await act(async () => {
    rejectStale(new Error("stale lookup"));
    await Promise.resolve();
  });
  expect(mocks.notify).not.toHaveBeenCalled();

  await act(async () =>
    root.render(
      <PlayerSearchInput label="Player" file={file("db")} value={3} setValue={vi.fn()} />,
    ),
  );
  await vi.waitFor(() =>
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith("Common.Error", expect.any(Error)),
  );
});

test("a getPlayer rejection after unmount does not notify", async () => {
  let rejectLookup!: (reason: Error) => void;
  const lookup = new Promise<never>((_, fail) => {
    rejectLookup = fail;
  });
  mocks.getPlayer.mockImplementation(() => lookup);
  await act(async () =>
    root.render(
      <PlayerSearchInput label="Player" file={file("db")} value={1} setValue={vi.fn()} />,
    ),
  );
  await vi.waitFor(() => expect(mocks.getPlayer).toHaveBeenCalledWith(file("db"), 1));
  await act(async () => root.render(null));
  await act(async () => {
    rejectLookup(new Error("unmounted lookup"));
    await Promise.resolve();
  });
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("a query_players rejection after a newer lookup does not notify", async () => {
  const database = file("db");
  let rejectSearch!: (reason: Error) => void;
  mocks.queryPlayers.mockImplementation(
    () =>
      new Promise((_, fail) => {
        rejectSearch = fail;
      }),
  );
  await render(database);
  await act(async () => {
    container.querySelector("button")!.click();
  });
  await vi.waitFor(() => expect(mocks.queryPlayers).toHaveBeenCalledOnce());
  await act(async () =>
    root.render(<PlayerSearchInput label="Player" file={database} value={1} setValue={vi.fn()} />),
  );
  await act(async () => {
    rejectSearch(new Error("stale search"));
    await Promise.resolve();
  });
  expect(mocks.notify).not.toHaveBeenCalled();
});

test("unmount cancels an active lookup while an ordinary failure is surfaced", async () => {
  let signal!: AbortSignal;
  mocks.queryPlayers.mockImplementationOnce(
    (_file: unknown, _query: unknown, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise(() => undefined);
    },
  );
  await render(file("first"));
  await act(async () => {
    container.querySelector("button")!.click();
  });
  await vi.waitFor(() => expect(mocks.queryPlayers).toHaveBeenCalledOnce());
  await act(async () => root.render(null));
  expect(signal.aborted).toBe(true);

  mocks.queryPlayers.mockRejectedValueOnce(new Error("lookup failed"));
  await render(file("second"));
  await act(async () => {
    container.querySelector("button")!.click();
  });
  await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalledOnce());
});
