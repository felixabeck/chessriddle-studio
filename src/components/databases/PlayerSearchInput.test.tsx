import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DatabaseHandle } from "@/bindings";

const mocks = vi.hoisted(() => ({
  queryPlayers: vi.fn(),
  getPlayer: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("@/utils/db", () => ({
  NAME_SEARCH_DEBOUNCE_MS: 250,
  query_players: mocks.queryPlayers,
}));
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
      {data.map((name) => (
        <button key={name} data-player={name} type="button" onClick={() => onChange(name)}>
          {name}
        </button>
      ))}
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
  vi.useRealTimers();
});

async function render(database: DatabaseHandle) {
  await act(async () =>
    root.render(<PlayerSearchInput label="Player" file={database} setValue={vi.fn()} />),
  );
}

test("rapid typing starts only the final player search after 250 ms", async () => {
  vi.useFakeTimers();
  mocks.queryPlayers.mockResolvedValue({ data: [], count: 0 });
  const database = file("db");
  await render(database);
  const input = container.querySelector("input")!;
  for (const name of ["c", "ca", "car"]) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.value).toBe(name);
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(mocks.queryPlayers).not.toHaveBeenCalled();
  }
  await act(async () => vi.advanceTimersByTimeAsync(199));
  expect(mocks.queryPlayers).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(mocks.queryPlayers).toHaveBeenCalledExactlyOnceWith(
    database,
    expect.objectContaining({
      name: "car",
      options: expect.objectContaining({ sort: "elo", direction: "desc" }),
    }),
    { signal: expect.any(AbortSignal) },
  );
});

async function enterName(name: string) {
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("editing a suggestion selection clears its id, preserves typed text, and searches again", async () => {
  vi.useFakeTimers();
  const database = file("db");
  const setValue = vi.fn();
  mocks.getPlayer.mockImplementation(async (_file: DatabaseHandle, id: number) => ({
    id,
    name: id === 1 ? "Ada" : "Bea",
  }));
  mocks.queryPlayers
    .mockResolvedValueOnce({ data: [{ id: 1, name: "Ada" }], count: 1 })
    .mockResolvedValueOnce({ data: [{ id: 2, name: "Bea" }], count: 1 });
  function ControlledPlayer() {
    const [value, commit] = useState<number>();
    return (
      <PlayerSearchInput
        label="Player"
        file={database}
        value={value}
        setValue={(next) => {
          setValue(next);
          commit(next);
        }}
      />
    );
  }
  await act(async () => root.render(<ControlledPlayer />));
  await enterName("Ad");
  expect(setValue).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(250));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-player="Ada"]')!.click());
  expect(setValue).toHaveBeenLastCalledWith(1);
  setValue.mockClear();

  await enterName("Be");
  expect(setValue).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(container.querySelector("input")!.value).toBe("Be");
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(mocks.queryPlayers).toHaveBeenCalledTimes(2);
  expect(mocks.queryPlayers.mock.lastCall?.[1].name).toBe("Be");
  expect(container.querySelector("output")!.textContent).toBe("Bea");
  await act(async () => container.querySelector<HTMLButtonElement>('[data-player="Bea"]')!.click());
  expect(setValue).toHaveBeenLastCalledWith(2);
  expect(container.querySelector("input")!.value).toBe("Bea");
});

test("an external clear empties the selected player's text", async () => {
  const database = file("db");
  mocks.getPlayer.mockResolvedValue({ id: 1, name: "Ada" });
  await act(async () =>
    root.render(<PlayerSearchInput label="Player" file={database} value={1} setValue={vi.fn()} />),
  );
  expect(container.querySelector("input")!.value).toBe("Ada");
  await render(database);
  expect(container.querySelector("input")!.value).toBe("");
});

test.each(["file replacement", "unmount", "clear"])(
  "%s cancels a pending debounced player search",
  async (action) => {
    vi.useFakeTimers();
    await render(file("first"));
    await act(async () => container.querySelector("button")!.click());
    if (action === "file replacement") await render(file("second"));
    if (action === "unmount") await act(async () => root.render(null));
    if (action === "clear") {
      const input = container.querySelector("input")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(mocks.queryPlayers).not.toHaveBeenCalled();
  },
);

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
