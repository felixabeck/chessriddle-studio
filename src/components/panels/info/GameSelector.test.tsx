import { notifications } from "@mantine/notifications";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FileWorkspaceHandle, StampedGame } from "@/bindings";
import { cancellationError } from "@/platform/tauri";
import { catalogueI18n } from "@/tests/catalogues";
import GameSelector, { type GameSelectorRow } from "./GameSelector";

const translation = vi.hoisted(() => ({ t: (value: string) => value }));
const mocks = vi.hoisted(() => ({
  useVirtualPageLoader: vi.fn(),
  readGames: vi.fn(),
  parsePGN: vi.fn(),
  visibleIndices: [0],
  measure: vi.fn(),
  getOffsetForIndex: vi.fn((_index: number, _align: string) => [240, "auto"]),
  scrollToOffset: vi.fn(),
  estimateSize: (() => 0) as (index: number) => number,
  virtualizer: {
    getTotalSize: () => 30,
    measure: () => mocks.measure(),
    getOffsetForIndex: (index: number, align: string) => mocks.getOffsetForIndex(index, align),
    scrollToOffset: (...args: unknown[]) => mocks.scrollToOffset(...args),
    getVirtualItems: () =>
      mocks.visibleIndices.map((index) => ({ index, size: 30, start: index * 30 })),
  },
}));

vi.mock("react-i18next", () => ({ useTranslation: () => translation }));
vi.mock("@/hooks/useVirtualPageLoader", () => ({
  useVirtualPageLoader: mocks.useVirtualPageLoader,
}));
vi.mock("@/platform/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
  return {
    ...actual,
    tauri: { ...actual.tauri, readGames: mocks.readGames },
  };
});
vi.mock("@/utils/chess", () => ({ parsePGN: mocks.parsePGN }));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { estimateSize: (index: number) => number }) => {
    mocks.estimateSize = options.estimateSize;
    return mocks.virtualizer;
  },
}));
vi.mock("@mantine/core", () => ({
  ActionIcon: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Box: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  Button: ({ children, loading, ...props }: any) => (
    <button {...props} disabled={loading || props.disabled}>
      {children}
    </button>
  ),
  Group: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  Loader: () => null,
  Modal: ({ opened, title, children }: any) =>
    opened ? (
      <div role="dialog" aria-label={title}>
        {children}
      </div>
    ) : null,
  ScrollArea: ({ children, viewportRef, h: _h, ...props }: any) => (
    <div ref={viewportRef} {...props}>
      {children}
    </div>
  ),
  Stack: ({ children }: any) => <div>{children}</div>,
  Text: ({ children, truncate: _truncate, fz: _fz, flex: _flex, lh: _lh, ...props }: any) => (
    <p {...props}>{children}</p>
  ),
  Tooltip: ({ children }: any) => <>{children}</>,
}));

vi.mock("./LineSectionEditor", () => ({
  default: ({
    target,
    onSaved,
    onRefresh,
  }: {
    target: { index: number };
    onSaved: (index: number, section: string | undefined, written: object) => void;
    onRefresh: () => void;
  }) => (
    <div>
      <div data-testid="section-editor">{JSON.stringify(target)}</div>
      <button
        data-testid="saved"
        onClick={() => onSaved(target.index, "Neu", { stamp: "s2", revision: "r2" })}
      />
      <button
        data-testid="saved-unconfirmed"
        onClick={() => onSaved(target.index, "Neu", { stamp: null, revision: null })}
      />
      <button data-testid="refresh" onClick={onRefresh} />
    </div>
  ),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (cause: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

const path: FileWorkspaceHandle = {
  id: { id: "test-file" },
  kind: "fileWorkspace",
};

const firstGame: StampedGame = {
  pgn: '[Event "First"]\n\n1. e4 *',
  stamp: "stamp-first",
  revision: "revision-first",
  present: true,
};

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  const instance = await catalogueI18n("de-DE");
  translation.t = instance.t.bind(instance);
  const { useVirtualPageLoader } = await vi.importActual<
    typeof import("@/hooks/useVirtualPageLoader")
  >("@/hooks/useVirtualPageLoader");
  mocks.useVirtualPageLoader.mockReset().mockImplementation(useVirtualPageLoader);
  mocks.readGames.mockReset().mockResolvedValue([firstGame]);
  mocks.parsePGN.mockReset().mockResolvedValue({ headers: { event: "Loaded game" } });
  vi.mocked(notifications.show).mockReset();
  mocks.visibleIndices = [0];
  mocks.getOffsetForIndex.mockClear();
  mocks.scrollToOffset.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

function renderSelector(
  games: Map<number, GameSelectorRow>,
  deleteGame: (snapshot: {
    index: number;
    stamp: string;
    revision: string;
  }) => void | Promise<void>,
) {
  root.render(
    <GameSelector
      games={games}
      setGames={vi.fn()}
      setPage={vi.fn()}
      total={1}
      path={path}
      activePage={0}
      deleteGame={deleteGame}
    />,
  );
}

test("a reload retains rows and scroll until an atomic swap and stale page reads cannot refill it", async () => {
  const oldPage = deferred<StampedGame[]>();
  const newPage = deferred<StampedGame[]>();
  mocks.visibleIndices = [0, 1];
  mocks.readGames.mockReturnValueOnce(oldPage.promise).mockReturnValueOnce(newPage.promise);
  mocks.parsePGN.mockImplementation(async (pgn: string) => ({ headers: { event: pgn } }));
  function List({ generation }: { generation: number }) {
    const [games, setGames] = useState(new Map([[0, { name: "Old first" }]]));
    return (
      <GameSelector
        games={games}
        setGames={setGames}
        setPage={vi.fn()}
        total={2}
        path={path}
        activePage={0}
        reloadGeneration={generation}
      />
    );
  }
  await act(async () => root.render(<List generation={0} />));
  const viewport = host.firstElementChild!;
  viewport.scrollTop = 80;
  await act(async () => root.render(<List generation={1} />));
  expect(host.textContent).toContain("Old first");
  await act(async () => {
    oldPage.resolve([
      { ...firstGame, pgn: "Stale first" },
      { ...firstGame, pgn: "Stale second" },
    ]);
  });
  expect(host.textContent).not.toContain("Stale");
  expect(host.textContent).toContain("Old first");
  await act(async () => {
    newPage.resolve([
      { ...firstGame, pgn: "Fresh first" },
      { ...firstGame, pgn: "Fresh second" },
    ]);
  });
  expect(host.textContent).toContain("Fresh first");
  expect(host.textContent).toContain("Fresh second");
  expect(host.textContent).not.toContain("Old first");
  expect(viewport.scrollTop).toBe(80);
});

async function renderReveal(
  games: Map<number, GameSelectorRow>,
  revealActivePage = true,
  setPage = vi.fn(),
) {
  await act(async () =>
    root.render(
      <GameSelector
        games={games}
        setGames={vi.fn()}
        setPage={setPage}
        total={10}
        path={path}
        activePage={8}
        revealActivePage={revealActivePage}
      />,
    ),
  );
}

test("reveal stays off when revealActivePage is omitted", async () => {
  await act(async () =>
    root.render(
      <GameSelector
        games={new Map([[0, { name: "First" }]])}
        setGames={vi.fn()}
        setPage={vi.fn()}
        total={10}
        path={path}
        activePage={8}
      />,
    ),
  );
  expect(mocks.scrollToOffset).not.toHaveBeenCalled();
});

test("reveal is opt-in and repeats after section heights or the visible range change", async () => {
  const games = new Map<number, GameSelectorRow>([[0, { name: "First" }]]);
  await renderReveal(games, false);
  expect(mocks.scrollToOffset).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  await renderReveal(games);
  expect(mocks.getOffsetForIndex).toHaveBeenLastCalledWith(8, "auto");
  expect(mocks.scrollToOffset).toHaveBeenCalledWith(240);
  mocks.scrollToOffset.mockClear();
  await renderReveal(new Map([...games, [8, { name: "Late", section: "Loaded heading" }]]));
  expect(mocks.scrollToOffset).toHaveBeenCalledOnce();
  mocks.scrollToOffset.mockClear();
  mocks.visibleIndices = [7, 8, 9];
  await renderReveal(new Map([...games, [8, { name: "Late", section: "Loaded heading" }]]));
  expect(mocks.scrollToOffset).toHaveBeenCalledOnce();
});

test.each(["wheel", "touchmove", "pointerdown", "keydown", "focusin"])(
  "%s ends the reveal so late headings do not pull the list back",
  async (type) => {
    const games = new Map<number, GameSelectorRow>([[0, { name: "First" }]]);
    await renderReveal(games);
    expect(mocks.scrollToOffset).toHaveBeenCalled();
    const viewport = host.querySelector('[role="listbox"]')!.parentElement!;
    await act(async () =>
      viewport.dispatchEvent(
        type === "keydown"
          ? new KeyboardEvent(type, { key: "a", bubbles: true })
          : new Event(type, { bubbles: true }),
      ),
    );
    mocks.scrollToOffset.mockClear();
    mocks.visibleIndices = [7, 8, 9];
    await renderReveal(new Map([...games, [8, { name: "Late", section: "Loaded heading" }]]));
    expect(mocks.scrollToOffset).not.toHaveBeenCalled();
  },
);

test("a failed row read during reveal adds no read and never changes the selected position", async () => {
  mocks.visibleIndices = [8];
  mocks.readGames.mockRejectedValue(new Error("Remembered row unavailable"));
  const setPage = vi.fn();
  await renderReveal(new Map([[0, { name: "First" }]]), true, setPage);
  await act(async () => {});
  expect(mocks.readGames).toHaveBeenCalledExactlyOnceWith(path, 8, 8, {
    signal: expect.any(AbortSignal),
  });
  expect(setPage).not.toHaveBeenCalled();
  expect(host.querySelector('[role="option"]')?.getAttribute("aria-selected")).toBe("true");
  expect(notifications.show).toHaveBeenCalledOnce();
});

function renderPageLoader(
  deleteGame: (snapshot: {
    index: number;
    stamp: string;
    revision: string;
  }) => void | Promise<void>,
  total = 1,
  initialGames = new Map<number, GameSelectorRow>(),
  setPage = vi.fn(),
  onActivate = vi.fn(),
) {
  const observed = { games: initialGames };
  function Harness() {
    const [games, setGames] = useState(initialGames);
    observed.games = games;
    return (
      <GameSelector
        games={games}
        setGames={setGames}
        setPage={setPage}
        onActivate={onActivate}
        total={total}
        path={path}
        activePage={0}
        deleteGame={deleteGame}
      />
    );
  }
  root.render(<Harness />);
  return observed;
}

function deleteButton(): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>('button[aria-label="Partie entfernen"]')!;
}

function confirmButton(): HTMLButtonElement {
  return [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Löschen",
  )! as HTMLButtonElement;
}

test("loads the stamped page through the page callback and submits its identity", async () => {
  const deleteGame = vi.fn().mockResolvedValue(undefined);
  await act(async () => renderPageLoader(deleteGame));

  expect(mocks.readGames).toHaveBeenCalledWith(path, 0, 0, {
    signal: expect.any(AbortSignal),
  });
  expect(host.textContent).toContain("Loaded game");
  await act(async () => deleteButton().click());
  await act(async () => confirmButton().click());

  expect(deleteGame).toHaveBeenCalledWith({
    index: 0,
    stamp: "stamp-first",
    revision: "revision-first",
  });
});

const secondGame: StampedGame = {
  ...firstGame,
  pgn: '[Event "Second"]\n\n1. d4 *',
  stamp: "stamp-second",
  revision: "revision-second",
};

function pendingRange(start: number, end: number): Promise<void> {
  const request = mocks.useVirtualPageLoader.mock.results.at(-1)!.value;
  return request(start, end);
}

test("single click selects, non-first double-click and row Enter activate explicit indices", async () => {
  mocks.visibleIndices = [0, 1];
  const setPage = vi.fn();
  const activate = vi.fn();
  await act(async () =>
    root.render(
      <GameSelector
        games={
          new Map([
            [0, { name: "First" }],
            [1, { name: "Second" }],
          ])
        }
        setGames={vi.fn()}
        setPage={setPage}
        onActivate={activate}
        total={2}
        path={path}
        activePage={0}
        deleteGame={vi.fn()}
      />,
    ),
  );
  const rows = host.querySelectorAll<HTMLElement>('[role="option"]');
  expect(rows).toHaveLength(2);
  expect(rows[1].tabIndex).toBe(0);
  expect(rows[0].getAttribute("aria-selected")).toBe("true");
  await act(async () => rows[1].click());
  expect(setPage).toHaveBeenCalledExactlyOnceWith(1);
  expect(activate).not.toHaveBeenCalled();
  await act(async () => {
    rows[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    rows[1].dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true }),
    );
    rows[1]
      .querySelector("button")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    rows[1].querySelector("button")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  expect(activate.mock.calls).toEqual([[1]]);
  await act(async () => {
    rows[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(activate.mock.calls).toEqual([[1], [1]]);
  expect(setPage).toHaveBeenCalledOnce();
});

test("continues a short page at the next index and merges the whole inclusive range", async () => {
  mocks.visibleIndices = [5, 6, 7];
  mocks.readGames.mockResolvedValueOnce([firstGame, secondGame]).mockResolvedValueOnce([firstGame]);
  const initial = new Map([[0, { name: "Already loaded" }]]);
  let observed!: ReturnType<typeof renderPageLoader>;
  await act(async () => {
    observed = renderPageLoader(vi.fn(), 8, initial);
  });

  expect(mocks.readGames).toHaveBeenCalledTimes(2);
  expect(mocks.readGames).toHaveBeenNthCalledWith(1, path, 5, 7, expect.anything());
  expect(mocks.readGames).toHaveBeenNthCalledWith(2, path, 7, 7, expect.anything());
  expect([...observed.games.keys()]).toEqual([0, 5, 6, 7]);
  expect(observed.games.get(5)?.identity).toEqual({
    stamp: "stamp-first",
    revision: "revision-first",
  });
  expect(observed.games.get(6)?.identity).toEqual({
    stamp: "stamp-second",
    revision: "revision-second",
  });
  expect(observed.games.get(7)?.identity).toEqual(observed.games.get(5)?.identity);
});

test("stores a middle omission without parsing, notifying, retrying or activating it", async () => {
  mocks.visibleIndices = [0, 1, 2];
  const omitted: StampedGame = {
    pgn: "",
    stamp: "",
    revision: "revision-first",
    present: true,
    omission: "tooLarge",
  };
  mocks.readGames
    .mockResolvedValueOnce([firstGame])
    .mockResolvedValueOnce([omitted])
    .mockResolvedValueOnce([secondGame]);
  mocks.parsePGN
    .mockResolvedValueOnce({ headers: { event: "Readable before" } })
    .mockResolvedValueOnce({ headers: { event: "Readable after" } });
  const setPage = vi.fn();
  const onActivate = vi.fn();
  const deleteGame = vi.fn();
  let observed!: ReturnType<typeof renderPageLoader>;
  await act(async () => {
    observed = renderPageLoader(deleteGame, 3, new Map(), setPage, onActivate);
  });
  await act(async () => {});

  expect(mocks.readGames.mock.calls.map((call) => call.slice(1, 3))).toEqual([
    [0, 2],
    [1, 2],
    [2, 2],
  ]);
  expect(mocks.parsePGN.mock.calls.map((call) => call[0])).toEqual([firstGame.pgn, secondGame.pgn]);
  expect([...observed.games.keys()]).toEqual([0, 1, 2]);
  expect(observed.games.get(1)).toEqual({
    name: translation.t("Files.GameTooLarge"),
    omission: "tooLarge",
  });
  expect(host.textContent).toContain("Readable before");
  expect(host.textContent).toContain("Readable after");
  const row = host.querySelectorAll<HTMLElement>('[role="option"]')[1];
  expect(row.textContent).toBe(`2${translation.t("Files.GameTooLarge")}`);
  expect(row.querySelector("button")?.disabled).toBe(true);
  await act(async () => {
    row.click();
    row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(setPage).not.toHaveBeenCalled();
  expect(onActivate).not.toHaveBeenCalled();
  expect(deleteGame).not.toHaveBeenCalled();
  expect(notifications.show).not.toHaveBeenCalled();
  expect(mocks.readGames).toHaveBeenCalledTimes(3);
});

test("maps readable and omitted games individually within one returned array", async () => {
  mocks.visibleIndices = [0, 1, 2];
  mocks.readGames.mockResolvedValueOnce([
    firstGame,
    { ...firstGame, pgn: "", stamp: "", omission: "tooLarge" },
    secondGame,
  ]);
  let observed!: ReturnType<typeof renderPageLoader>;
  await act(async () => {
    observed = renderPageLoader(vi.fn(), 3);
  });
  expect([...observed.games.keys()]).toEqual([0, 1, 2]);
  expect(observed.games.get(1)?.identity).toBeUndefined();
  expect(mocks.parsePGN.mock.calls.map((call) => call[0])).toEqual([firstGame.pgn, secondGame.pgn]);
  expect(mocks.readGames).toHaveBeenCalledOnce();
  expect(notifications.show).not.toHaveBeenCalled();
});

test("awaits every header parse in a page before reading the continuation", async () => {
  const headers = deferred<{ headers: { event: string } }>();
  mocks.visibleIndices = [0, 1, 2];
  mocks.readGames.mockResolvedValueOnce([firstGame, secondGame]).mockResolvedValueOnce([firstGame]);
  mocks.parsePGN.mockResolvedValueOnce({ headers: { event: "First parsed" } });
  mocks.parsePGN.mockReturnValueOnce(headers.promise);
  await act(async () => renderPageLoader(vi.fn(), 3));
  const request = pendingRange(0, 2);

  expect(mocks.parsePGN).toHaveBeenCalledTimes(2);
  expect(mocks.readGames).toHaveBeenCalledTimes(1);
  await act(async () => {
    headers.resolve({ headers: { event: "Second parsed" } });
    await request;
  });
  expect(mocks.readGames).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("First parsed");
  expect(host.textContent).toContain("Second parsed");
});

test("passes the same load options and signal to every read and header parse", async () => {
  mocks.visibleIndices = [0, 1, 2];
  mocks.readGames.mockResolvedValueOnce([firstGame]).mockResolvedValueOnce([secondGame, firstGame]);
  await act(async () => renderPageLoader(vi.fn(), 3));

  expect(mocks.readGames).toHaveBeenCalledTimes(2);
  expect(mocks.parsePGN).toHaveBeenCalledTimes(3);
  const options = mocks.readGames.mock.calls[0][3];
  expect(options.signal).toBeInstanceOf(AbortSignal);
  expect(options.signal.aborted).toBe(false);
  for (const call of mocks.readGames.mock.calls) expect(call[3]).toBe(options);
  for (const call of mocks.parsePGN.mock.calls) {
    expect(call[1]).toBeUndefined();
    expect(call[2]).toBe(options);
  }
});

test("stops continuation when the load aborts between pages", async () => {
  const headers = deferred<{ headers: { event: string } }>();
  mocks.visibleIndices = [0, 1, 2];
  mocks.parsePGN.mockReturnValueOnce(headers.promise);
  await act(async () => renderPageLoader(vi.fn(), 3));
  const request = pendingRange(0, 2);
  const signal = mocks.readGames.mock.calls[0][3].signal;
  expect(mocks.parsePGN).toHaveBeenCalledTimes(1);

  await act(async () => root.unmount());
  expect(signal.aborted).toBe(true);
  await act(async () => {
    headers.resolve({ headers: { event: "Late headers" } });
    await expect(request).resolves.toBeUndefined();
  });
  expect(mocks.readGames).toHaveBeenCalledTimes(1);
  expect(notifications.show).not.toHaveBeenCalled();
});

test("stops at an empty continuation page and keeps the preceding rows", async () => {
  mocks.visibleIndices = [];
  mocks.readGames
    .mockResolvedValueOnce([firstGame])
    .mockResolvedValueOnce([])
    .mockRejectedValue(new Error("Unexpected continuation"));
  let observed!: ReturnType<typeof renderPageLoader>;
  await act(async () => {
    observed = renderPageLoader(vi.fn(), 3);
  });

  expect(mocks.readGames).toHaveBeenCalledTimes(2);
  expect(mocks.readGames).toHaveBeenNthCalledWith(2, path, 1, 2, expect.anything());
  expect([...observed.games.keys()]).toEqual([0]);
});

test("an empty load preserves games identity and does not trigger another load", async () => {
  const unexpectedRetry = deferred<StampedGame[]>();
  mocks.readGames.mockResolvedValueOnce([]).mockReturnValue(unexpectedRetry.promise);
  const initial = new Map<number, GameSelectorRow>();
  let observed!: ReturnType<typeof renderPageLoader>;
  await act(async () => {
    observed = renderPageLoader(vi.fn(), 1, initial);
  });
  await act(async () => {});

  expect(observed.games).toBe(initial);
  expect(mocks.readGames).toHaveBeenCalledTimes(1);
  expect(mocks.parsePGN).not.toHaveBeenCalled();
});

test.each([
  { label: "ordinary failure", error: new Error("Page read failed"), notifies: true },
  { label: "cancellation", error: cancellationError(), notifies: false },
])(
  "a later page $label discards all rows and resolves the shared promise",
  async ({ error, notifies }) => {
    const expected = notifies
      ? [[{ color: "danger", title: translation.t("Common.Error"), message: error.message }]]
      : [];
    const laterPage = deferred<StampedGame[]>();
    mocks.visibleIndices = [0, 1, 2];
    mocks.readGames.mockResolvedValueOnce([firstGame]).mockReturnValueOnce(laterPage.promise);
    const initial = new Map<number, GameSelectorRow>();
    let observed!: ReturnType<typeof renderPageLoader>;
    await act(async () => {
      observed = renderPageLoader(vi.fn(), 3, initial);
    });
    const request = pendingRange(0, 2);
    expect(mocks.readGames).toHaveBeenCalledTimes(2);
    expect(observed.games).toBe(initial);

    await act(async () => {
      laterPage.reject(error);
      await expect(request).resolves.toBeUndefined();
    });
    expect(observed.games).toBe(initial);
    expect(mocks.readGames).toHaveBeenCalledTimes(2);
    expect(vi.mocked(notifications.show).mock.calls).toEqual(expected);
  },
);

test("a header parse failure keeps sibling rows and marks the failed games unreadable", async () => {
  mocks.visibleIndices = [0, 1, 2];
  const invalidInput = {
    tag: "backend-error",
    category: "invalid-input",
    message: "PGN contains more than one game",
  };
  const generic = new Error("Headers failed");
  mocks.readGames.mockResolvedValueOnce([firstGame, secondGame, firstGame]);
  mocks.parsePGN
    .mockResolvedValueOnce({ headers: { event: "Readable name" } })
    .mockRejectedValueOnce(invalidInput)
    .mockRejectedValueOnce(generic);
  let observed!: ReturnType<typeof renderPageLoader>;
  await act(async () => {
    observed = renderPageLoader(vi.fn(), 3);
  });

  expect([...observed.games.keys()]).toEqual([0, 1, 2]);
  expect(observed.games.get(0)).toEqual({
    name: "Readable name",
    identity: { stamp: "stamp-first", revision: "revision-first" },
  });
  expect(observed.games.get(1)).toEqual({ name: translation.t("Files.GameUnreadable") });
  expect(observed.games.get(2)).toEqual({ name: translation.t("Files.GameUnreadable") });
  expect(host.textContent).toContain("Readable name");
  expect(host.textContent).toContain(translation.t("Files.GameUnreadable"));
  expect(notifications.show).not.toHaveBeenCalled();
});

test("a header parse cancellation discards the page without an unreadable row", async () => {
  mocks.visibleIndices = [0, 1];
  mocks.readGames.mockResolvedValueOnce([firstGame, secondGame]);
  mocks.parsePGN
    .mockResolvedValueOnce({ headers: { event: "First parsed" } })
    .mockRejectedValueOnce(cancellationError());
  const initial = new Map<number, GameSelectorRow>();
  let observed!: ReturnType<typeof renderPageLoader>;
  await act(async () => {
    observed = renderPageLoader(vi.fn(), 2, initial);
  });

  expect(observed.games).toBe(initial);
  expect(host.textContent).not.toContain(translation.t("Files.GameUnreadable"));
  expect(notifications.show).not.toHaveBeenCalled();
});

test("a header parse failure after abort is silent and returns no unreadable row", async () => {
  const headers = deferred<{ headers: { event: string } }>();
  mocks.visibleIndices = [0, 1];
  mocks.readGames.mockResolvedValueOnce([firstGame, secondGame]);
  mocks.parsePGN.mockReturnValueOnce(headers.promise).mockResolvedValue({
    headers: { event: "Late headers" },
  });
  const initial = new Map<number, GameSelectorRow>();
  let observed!: ReturnType<typeof renderPageLoader>;
  await act(async () => {
    observed = renderPageLoader(vi.fn(), 2, initial);
  });
  const request = pendingRange(0, 1);
  const signal = mocks.readGames.mock.calls[0][3].signal;
  await act(async () => root.unmount());
  expect(signal.aborted).toBe(true);

  await act(async () => {
    headers.reject(new Error("Headers failed"));
    await expect(request).resolves.toBeUndefined();
  });
  expect(observed.games).toBe(initial);
  expect(notifications.show).not.toHaveBeenCalled();
});

test("an unreadable row selects, activates, and cannot delete", async () => {
  mocks.visibleIndices = [0, 1, 2];
  mocks.readGames.mockResolvedValueOnce([firstGame, secondGame, firstGame]);
  mocks.parsePGN
    .mockResolvedValueOnce({ headers: { event: "Readable before" } })
    .mockRejectedValueOnce({
      tag: "backend-error",
      category: "invalid-input",
      message: "PGN contains more than one game",
    })
    .mockResolvedValueOnce({ headers: { event: "Readable after" } });
  const setPage = vi.fn();
  const onActivate = vi.fn();
  const deleteGame = vi.fn();
  let observed!: ReturnType<typeof renderPageLoader>;
  await act(async () => {
    observed = renderPageLoader(deleteGame, 3, new Map(), setPage, onActivate);
  });

  expect(observed.games.get(1)).toEqual({ name: translation.t("Files.GameUnreadable") });
  const rows = host.querySelectorAll<HTMLElement>('[role="option"]');
  expect(rows).toHaveLength(3);
  const unreadable = rows[1];
  expect(unreadable.textContent).toContain(translation.t("Files.GameUnreadable"));
  expect(unreadable.querySelector("button")?.disabled).toBe(true);

  await act(async () => unreadable.click());
  expect(setPage).toHaveBeenCalledExactlyOnceWith(1);
  expect(onActivate).not.toHaveBeenCalled();
  await act(async () => {
    unreadable.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  expect(onActivate.mock.calls).toEqual([[1]]);
  await act(async () => {
    unreadable.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(onActivate.mock.calls).toEqual([[1], [1]]);
  expect(deleteGame).not.toHaveBeenCalled();
  expect(notifications.show).not.toHaveBeenCalled();
});

test("both one-row call sites share a failed load with exactly one notification", async () => {
  const read = deferred<StampedGame[]>();
  const unexpectedRetry = deferred<StampedGame[]>();
  const error = new Error("Single row failed");
  mocks.readGames.mockReturnValueOnce(read.promise).mockReturnValue(unexpectedRetry.promise);
  await act(async () => renderPageLoader(vi.fn()));
  const request = pendingRange(0, 0);
  expect(pendingRange(0, 0)).toBe(request);
  expect(mocks.readGames).toHaveBeenCalledTimes(1);

  await act(async () => {
    read.reject(error);
    await expect(request).resolves.toBeUndefined();
  });
  expect(mocks.readGames).toHaveBeenCalledTimes(1);
  expect(notifications.show).toHaveBeenCalledExactlyOnceWith({
    color: "danger",
    title: translation.t("Common.Error"),
    message: error.message,
  });
});

test("an ordinary read failure after abort is silent and resolves without merging", async () => {
  const read = deferred<StampedGame[]>();
  mocks.readGames.mockReturnValue(read.promise);
  const initial = new Map<number, GameSelectorRow>();
  let observed!: ReturnType<typeof renderPageLoader>;
  await act(async () => {
    observed = renderPageLoader(vi.fn(), 1, initial);
  });
  const request = pendingRange(0, 0);
  const signal = mocks.readGames.mock.calls[0][3].signal;
  await act(async () => root.unmount());
  expect(signal.aborted).toBe(true);

  await act(async () => {
    read.reject(new Error("Native read failed"));
    await expect(request).resolves.toBeUndefined();
  });
  expect(observed.games).toBe(initial);
  expect(mocks.readGames).toHaveBeenCalledTimes(1);
  expect(mocks.parsePGN).not.toHaveBeenCalled();
  expect(notifications.show).not.toHaveBeenCalled();
});

test("keeps the confirmation snapshot when the displayed row changes", async () => {
  const deleteGame = vi.fn().mockResolvedValue(undefined);
  const original = {
    name: "Original row",
    identity: { stamp: "stamp-original", revision: "revision-original" },
  };
  await act(async () => renderSelector(new Map([[0, original]]), deleteGame));
  await act(async () => deleteButton().click());

  await act(async () =>
    renderSelector(
      new Map([
        [
          0,
          {
            name: "Updated row",
            identity: { stamp: "stamp-updated", revision: "revision-updated" },
          },
        ],
      ]),
      deleteGame,
    ),
  );
  expect(host.textContent).toContain("Updated row");
  await act(async () => confirmButton().click());

  expect(deleteGame).toHaveBeenCalledWith({
    index: 0,
    stamp: "stamp-original",
    revision: "revision-original",
  });
});

test("an unloaded row cannot open a delete confirmation", async () => {
  const read = deferred<StampedGame[]>();
  mocks.readGames.mockReturnValue(read.promise);
  const deleteGame = vi.fn();
  await act(async () => renderPageLoader(deleteGame));

  expect(deleteButton().disabled).toBe(true);
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(deleteGame).not.toHaveBeenCalled();

  await act(async () => read.resolve([firstGame]));
});

test("keeps an ordinary failure retryable and closes after retry", async () => {
  const firstAttempt = deferred<void>();
  const secondAttempt = deferred<void>();
  const deleteGame = vi
    .fn<(snapshot: { index: number; stamp: string; revision: string }) => Promise<void>>()
    .mockReturnValueOnce(firstAttempt.promise)
    .mockReturnValueOnce(secondAttempt.promise);
  const row = {
    name: "Test game",
    identity: { stamp: "stamp-test", revision: "revision-test" },
  };

  try {
    await act(async () => renderSelector(new Map([[0, row]]), deleteGame));
    await act(async () => deleteButton().click());

    const button = confirmButton();
    await act(async () => {
      button.click();
      button.click();
    });
    expect(deleteGame).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(button.disabled).toBe(true);

    await act(async () => firstAttempt.reject(new Error("native rejected at /private/file.pgn")));
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain(
      "Die Aktion konnte nicht abgeschlossen werden. Bitte versuche es erneut.",
    );
    expect(host.textContent).not.toContain("native rejected");
    expect(host.textContent).not.toContain("/private/file.pgn");
    expect(button.disabled).toBe(false);

    await act(async () => confirmButton().click());
    expect(deleteGame).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(confirmButton().disabled).toBe(true);

    await act(async () => secondAttempt.resolve());
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    firstAttempt.resolve();
    secondAttempt.resolve();
  }
});

function SectionHarness({
  initial,
  editableSections,
}: {
  initial: [number, GameSelectorRow][];
  editableSections: boolean;
}) {
  const [games, setGames] = useState(new Map(initial));
  return (
    <GameSelector
      games={games}
      setGames={setGames}
      setPage={() => undefined}
      total={initial.length}
      path={path}
      activePage={0}
      editableSections={editableSections}
    />
  );
}

async function renderSections(initial: [number, GameSelectorRow][], editableSections = true) {
  await act(async () => {
    root.render(<SectionHarness initial={initial} editableSections={editableSections} />);
  });
}

const identity = { stamp: "s1", revision: "r1" };

test.each(["reload", "file change", "list reset", "disabled", "unmount"])(
  "%s cancels an active line drag",
  async (reason) => {
    const move = vi.fn().mockResolvedValue(undefined);
    const rows = new Map([[0, { name: "First", identity }]]);
    const render = (changed = false) =>
      root.render(
        reason === "unmount" && changed ? null : (
          <GameSelector
            games={changed && reason === "list reset" ? new Map() : rows}
            setGames={vi.fn()}
            setPage={vi.fn()}
            total={1}
            path={
              changed && reason === "file change" ? { ...path, id: { id: "another-file" } } : path
            }
            activePage={0}
            reloadGeneration={changed && reason === "reload" ? 1 : 0}
            onMoveLines={changed && reason === "disabled" ? undefined : move}
          />
        ),
      );
    await act(async () => render());
    const list = host.querySelector<HTMLElement>('[role="listbox"]')!;
    list.setPointerCapture = vi.fn();
    list.hasPointerCapture = () => false;
    const fire = (target: EventTarget, type: string, clientX: number) => {
      const event = new MouseEvent(type, { bubbles: true, clientX, clientY: 10 });
      Object.defineProperties(event, {
        pointerId: { value: 1 },
        isPrimary: { value: true },
      });
      target.dispatchEvent(event);
    };
    fire(list.querySelector('[role="option"]')!, "pointerdown", 10);
    fire(window, "pointermove", 20);
    expect(document.querySelector("[data-line-drag-preview]")).not.toBeNull();
    await act(async () => render(true));
    expect(document.querySelector("[data-line-drag-preview]")).toBeNull();
    expect(document.querySelector("[data-line-drop-marker]")).toBeNull();
    fire(window, "pointerup", 20);
    expect(move).not.toHaveBeenCalled();
  },
);

test("a named section shows its heading above the line that starts it", async () => {
  mocks.visibleIndices = [0, 1];
  await renderSections([
    [0, { name: "First", identity }],
    [1, { name: "Second", section: "mit g3", identity }],
  ]);
  const [first, second] = Array.from(host.querySelectorAll<HTMLElement>('[role="presentation"]'));
  expect(first.textContent).not.toContain("mit g3");
  expect(second.textContent?.startsWith("mit g3")).toBe(true);
  const option = second.querySelector<HTMLElement>('[role="option"]');
  expect(option?.getAttribute("aria-description")).toBe("mit g3");
});

test("reads the section from the line's headers", async () => {
  mocks.parsePGN.mockResolvedValue({
    headers: { event: "Loaded game", other: { Section: "Aus der Datei" } },
  });
  mocks.readGames.mockResolvedValue([firstGame]);
  await act(async () => {
    renderPageLoader(vi.fn());
  });
  expect(host.textContent).toContain("Aus der Datei");
});

test("right-clicking a loaded line opens the section editor where allowed", async () => {
  mocks.visibleIndices = [1];
  await renderSections([
    [0, { name: "First", identity }],
    [1, { name: "Second", section: "", identity }],
  ]);
  const slot = host.querySelector<HTMLElement>('[role="presentation"]')!;
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 50,
  });
  await act(async () => slot.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(JSON.parse(host.querySelector('[data-testid="section-editor"]')!.textContent!)).toEqual({
    index: 1,
    section: "",
    stamp: "s1",
    revision: "r1",
    x: 40,
    y: 50,
    nameFirst: false,
  });
});

function sectionButton() {
  return host.querySelector<HTMLButtonElement>('[role="option"] button');
}

test.each([
  ["without a section goes straight to naming", undefined, "Abschnitt hier beginnen", true],
  ["that starts a section opens the choices", "mit g3", "Abschnitt", false],
])("the icon on a line %s", async (_name, section, label, nameFirst) => {
  await renderSections([[0, { name: "First", section, identity }]]);
  const button = sectionButton()!;
  expect(button.getAttribute("aria-label")).toBe(label);
  button.getBoundingClientRect = () => ({ left: 11, bottom: 22 }) as DOMRect;
  await act(async () => button.click());
  expect(editorTarget()).toMatchObject({ index: 0, x: 11, y: 22, nameFirst });
  expect(editorTarget().section).toBe(section);
});

test("clicking the icon does not select or open the line", async () => {
  const setPage = vi.fn();
  const activate = vi.fn();
  await act(async () => {
    root.render(
      <GameSelector
        games={new Map([[0, { name: "First", identity }]])}
        setGames={vi.fn()}
        setPage={setPage}
        onActivate={activate}
        total={1}
        path={path}
        activePage={0}
        editableSections
      />,
    );
  });
  const button = sectionButton()!;
  await act(async () => {
    button.click();
    button.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  expect(setPage).not.toHaveBeenCalled();
  expect(activate).not.toHaveBeenCalled();
});

test.each([
  ["a list without section editing", { name: "First", identity }, false],
  ["a line that has no identity yet", { name: "First" }, true],
])("%s shows no section icon", async (_name, row, editable) => {
  await renderSections([[0, row as GameSelectorRow]], editable as boolean);
  expect(sectionButton()).toBeNull();
});

test.each([
  ["a list without section editing", { name: "First", identity }, false],
  ["a line that has no identity yet", { name: "First" }, true],
])("right-clicking %s opens nothing", async (_name, row, editable) => {
  await renderSections([[0, row as GameSelectorRow]], editable as boolean);
  const slot = host.querySelector<HTMLElement>('[role="presentation"]')!;
  await act(async () =>
    slot.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
  );
  expect(host.querySelector('[data-testid="section-editor"]')).toBeNull();
});

test("a section reserves its space, and only a change of that space re-measures", async () => {
  mocks.visibleIndices = [0, 1, 2, 3];
  await renderSections([
    [0, { name: "First", section: "", identity }],
    [1, { name: "Second", section: "", identity }],
    [2, { name: "Third", section: "Benannt", identity }],
    [3, { name: "Fourth", identity }],
  ]);
  const [unnamedFirst, gap, named, plain] = [0, 1, 2, 3].map(mocks.estimateSize);
  expect(unnamedFirst).toBe(plain);
  expect(gap).toBeGreaterThan(plain);
  expect(named).toBeGreaterThan(gap);
  expect(mocks.measure).toHaveBeenCalled();
});

async function openEditor(index: number) {
  const slot = host.querySelectorAll<HTMLElement>('[role="presentation"]')[index];
  await act(async () =>
    slot.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
  );
}

async function click(testId: string) {
  await act(async () => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.click());
}

function editorTarget() {
  return JSON.parse(host.querySelector('[data-testid="section-editor"]')!.textContent!);
}

test("a saved section appears at once and every line takes the file's new revision", async () => {
  mocks.visibleIndices = [0, 1];
  await renderSections([
    [0, { name: "First", identity }],
    [1, { name: "Second", identity }],
  ]);
  await openEditor(1);
  mocks.measure.mockClear();
  await click("saved");
  expect(mocks.measure).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("Neu");
  expect(editorTarget()).toMatchObject({ index: 1, stamp: "s1", revision: "r1" });

  await openEditor(1);
  expect(mocks.measure).toHaveBeenCalledOnce();
  expect(editorTarget()).toMatchObject({ index: 1, section: "Neu", stamp: "s2", revision: "r2" });
  await openEditor(0);
  expect(editorTarget()).toMatchObject({ index: 0, stamp: "s1", revision: "r2" });
});

test("a line read at an older revision does not advance with a save", async () => {
  mocks.visibleIndices = [0, 1];
  await renderSections([
    [0, { name: "Old", identity: { stamp: "s0", revision: "r0" } }],
    [1, { name: "Second", identity }],
  ]);
  await openEditor(1);
  await click("saved");
  await openEditor(0);
  expect(editorTarget()).toMatchObject({ index: 0, stamp: "s0", revision: "r0" });
});

test.each(["saved-unconfirmed", "refresh"])("%s reloads the list from the file", async (button) => {
  mocks.visibleIndices = [0];
  mocks.readGames.mockResolvedValue([firstGame]);
  await renderSections([[0, { name: "First", identity }]]);
  await openEditor(0);
  await click(button);
  expect(mocks.readGames).toHaveBeenCalled();
  expect(host.textContent).toContain("Loaded game");
});
