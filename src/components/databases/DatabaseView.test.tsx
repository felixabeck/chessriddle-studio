import { act, useEffect, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import useSWR, { SWRConfig, useSWRConfig } from "swr";
import { getDefaultStore } from "jotai";
import { referenceDbAtom } from "@/state/atoms";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import type { SuccessDatabaseInfo } from "@/utils/db";

installResizeObserverStub();
const defaultResizeObserver = globalThis.ResizeObserver;

const mocks = vi.hoisted(() => ({
  getDatabases: vi.fn(),
  setDatabase: vi.fn(),
  clearDatabase: vi.fn(),
  database: undefined as SuccessDatabaseInfo | undefined,
  realStore: false,
}));

vi.mock("@/utils/db", async () => {
  const actual = await vi.importActual<typeof import("@/utils/db")>("@/utils/db");
  return { ...actual, getDatabases: mocks.getDatabases };
});
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useParams: () => ({ databaseId: "db-1" }),
  useNavigate: () => vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));
vi.mock("lucide-react", () => ({
  ArrowLeft: () => null,
  ChessKnight: () => null,
  Trophy: () => null,
  User: () => null,
}));
vi.mock("@mantine/core", () => ({
  Box: ({
    children,
    "data-database-view": view,
    "data-compact": compact,
  }: {
    children: ReactNode;
    "data-database-view"?: boolean;
    "data-compact"?: boolean;
  }) => (
    <div data-database-view={view} data-compact={compact}>
      {children}
    </div>
  ),
  Button: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
  Center: ({ children, ref }: ComponentProps<"div">) => <div ref={ref}>{children}</div>,
  Group: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Loader: () => <span>loading</span>,
  Stack: ({ children, role, ref }: ComponentProps<"div">) => (
    <div role={role} ref={ref}>
      {children}
    </div>
  ),
  Tabs: Object.assign(({ children }: { children: ReactNode }) => <div>{children}</div>, {
    List: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Tab: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  }),
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Title: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
}));
vi.mock("@/components/common/IconAction", () => ({
  IconAction: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));
vi.mock("./GameTable", () => ({ default: () => <div>games table</div> }));
vi.mock("./PlayerTable", () => ({ default: () => <div>players table</div> }));
vi.mock("./TournamentTable", () => ({ default: () => <div>tournaments table</div> }));
vi.mock("@/state/store/database", async () => {
  const actual =
    await vi.importActual<typeof import("@/state/store/database")>("@/state/store/database");
  const state = {
    get database() {
      return mocks.database;
    },
    activeTab: "games" as const,
    clearDatabase: mocks.clearDatabase,
    setActiveTab: vi.fn(),
    setDatabase: mocks.setDatabase,
  };
  return {
    activeDatabaseViewStore: {
      getState: () => (mocks.realStore ? actual.activeDatabaseViewStore.getState() : state),
    },
    useActiveDatabaseViewStore: (
      selector: (value: import("@/state/store/database").DatabaseViewStore) => unknown,
    ) =>
      mocks.realStore
        ? actual.useActiveDatabaseViewStore(selector)
        : selector({ ...actual.activeDatabaseViewStore.getState(), ...state }),
  };
});

import DatabaseView from "./DatabaseView";

let revalidate!: () => Promise<unknown>;
function CaptureRevalidation() {
  const { mutate } = useSWRConfig();
  revalidate = () => mutate("databases");
  return null;
}

function Peer({ onData }: { onData: (value: unknown) => void }) {
  const owner = useNativeRequestOwner("databases");
  const { data } = useSWR("databases", () =>
    owner!.run((signal) => mocks.getDatabases({ signal })),
  );
  useEffect(() => {
    if (data) onData(data);
  }, [data, onData]);
  return null;
}

function Tree({
  view,
  peer,
  onData,
}: {
  view: boolean;
  peer: boolean;
  onData: (v: unknown) => void;
}) {
  return (
    <SWRConfig value={{ provider: () => cache, shouldRetryOnError: false }}>
      <CaptureRevalidation />
      {view && <DatabaseView />}
      {peer && <Peer onData={onData} />}
    </SWRConfig>
  );
}

const cache = new Map();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  cache.clear();
  mocks.getDatabases.mockReset();
  mocks.setDatabase.mockReset();
  mocks.clearDatabase.mockReset();
  mocks.database = undefined;
  mocks.realStore = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  globalThis.ResizeObserver = defaultResizeObserver;
  if (mocks.realStore) {
    const actual =
      await vi.importActual<typeof import("@/state/store/database")>("@/state/store/database");
    actual.activeDatabaseViewStore.getState().clearDatabase();
    getDefaultStore().set(referenceDbAtom, null);
    sessionStorage.clear();
    localStorage.clear();
  }
});

async function render(view: boolean, peer: boolean, onData = vi.fn()) {
  await act(async () => root.render(<Tree view={view} peer={peer} onData={onData} />));
}

const selectedDatabase: SuccessDatabaseInfo = {
  type: "success",
  file: { id: { id: "db-1" }, kind: "database" },
  filename: "selected.db3",
  title: "Selected database",
  description: "",
  player_count: 0,
  event_count: 0,
  game_count: 0,
  storage_size: "0",
  indexed: false,
};

test("observes the mounted view after loading ends without a resize from the detached loader", async () => {
  const observed = new Map<Element, ResizeObserverCallback>();
  const disconnected = vi.fn();
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      observed.set(target, this.callback);
    }
    unobserve(target: Element) {
      observed.delete(target);
    }
    disconnect() {
      for (const [target, callback] of observed) {
        if (callback === this.callback) {
          disconnected(target);
          observed.delete(target);
        }
      }
    }
  };
  mocks.database = selectedDatabase;
  let resolveListing!: (value: { databases: SuccessDatabaseInfo[]; unread: [] }) => void;
  mocks.getDatabases.mockImplementation(() => new Promise((resolve) => (resolveListing = resolve)));
  await render(true, false);
  const loading = container.querySelector("span")!.parentElement!;
  expect(loading.textContent).toBe("loading");
  expect(observed.has(loading)).toBe(true);

  // Render once more while loading, before any observer notification. The old hook's
  // effect now depends on the loading node, which is still ref.current in the ready render.
  await render(true, false);
  expect(observed.has(loading)).toBe(true);
  await act(async () => resolveListing({ databases: [selectedDatabase], unread: [] }));

  const view = container.querySelector("[data-database-view]")!;
  const measured = view.firstElementChild!;
  expect(loading.isConnected).toBe(false);
  expect(measured.isConnected).toBe(true);
  expect(view.getAttribute("data-compact")).toBe("true");
  expect([...observed.keys()]).toEqual([measured]);
  expect(disconnected).toHaveBeenCalledWith(loading);

  // Only the mounted view delivers its initial size. The detached loader never does.
  await act(async () => {
    observed.get(measured)!(
      [{ target: measured, contentRect: { width: 2000 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    await new Promise(requestAnimationFrame);
  });
  expect(view.hasAttribute("data-compact")).toBe(false);

  await render(false, false);
  expect(disconnected).toHaveBeenCalledWith(measured);
  expect(observed.size).toBe(0);
});

test.each([
  {
    transient: "upgrading" as const,
    error:
      "This database is being upgraded to the current format. Large databases can take several minutes.",
  },
  {
    transient: "busy" as const,
    error: "This database is in use and cannot be read right now. It is retried automatically.",
  },
  { upgradeFailed: true as const, error: "Insufficient disk space" },
])(
  "unavailable route shows $error without tables and preserves stored view and reference bytes through ready",
  async (unavailable) => {
    mocks.realStore = true;
    const { activeDatabaseViewStore: store } =
      await vi.importActual<typeof import("@/state/store/database")>("@/state/store/database");
    store.getState().setDatabase(selectedDatabase);
    store.getState().setGamesQuery({ ...store.getState().games.query, player1: 42 });
    store.getState().setGamesSelectedGameId(7);
    store.getState().setActiveTab("players");
    store.getState().setPlayersSelectedPlayer(42);
    getDefaultStore().set(referenceDbAtom, selectedDatabase.file);
    const before = sessionStorage.getItem("database-view");
    const referenceBefore = localStorage.getItem("reference-database");
    expect(before).not.toBeNull();
    expect(referenceBefore).not.toBeNull();
    const clear = vi.spyOn(store.getState(), "clearDatabase");
    const seed = vi.spyOn(store.getState(), "setDatabase");
    const listing = (databases: import("@/utils/db").ManagedDatabaseInfo[]) => ({
      databases,
      unread: [],
    });
    mocks.getDatabases.mockResolvedValue(listing([selectedDatabase]));
    await render(true, false);
    expect(container.textContent).toContain("games table");
    expect(sessionStorage.getItem("database-view")).toBe(before);

    mocks.getDatabases.mockResolvedValue(
      listing([
        {
          type: "error",
          file: selectedDatabase.file,
          filename: selectedDatabase.filename,
          indexed: false,
          ...unavailable,
        },
      ]),
    );
    await act(async () => revalidate());
    expect(container.querySelector('[role="status"]')?.textContent).toContain(unavailable.error);
    expect(container.textContent).not.toMatch(/games table|players table|tournaments table/);
    expect(container.querySelector('a[href="/library"]')).not.toBeNull();
    expect(sessionStorage.getItem("database-view")).toBe(before);
    expect(localStorage.getItem("reference-database")).toBe(referenceBefore);
    expect(clear).not.toHaveBeenCalled();

    mocks.getDatabases.mockResolvedValue(
      listing([{ ...selectedDatabase, title: "Fresh ready metadata", game_count: 123 }]),
    );
    await act(async () => revalidate());
    expect(container.textContent).toContain("Fresh ready metadata");
    expect(container.textContent).toContain("games table");
    expect(sessionStorage.getItem("database-view")).toBe(before);
    expect(localStorage.getItem("reference-database")).toBe(referenceBefore);
    expect(clear).not.toHaveBeenCalled();
    expect(seed).not.toHaveBeenCalled();
  },
);

test("a preserved original index route retires its old active explorer without rendering stale tables", async () => {
  mocks.database = selectedDatabase;
  mocks.getDatabases.mockResolvedValue({
    databases: [],
    unread: [],
    collections: [
      {
        id: "original",
        name: "prior.pgn",
        file: { id: { id: "prior" }, kind: "fileWorkspace" },
        database: null,
        status: "preservedOriginal",
        generation: "",
        omitted: 0,
        account: null,
        retiredDatabase: null,
        fetchSinceMs: null,
      },
    ],
  });
  await render(true, false);
  expect(mocks.clearDatabase).toHaveBeenCalled();
  expect(container.textContent).not.toContain("games table");
  expect(container.querySelector('a[href="/library"]')).not.toBeNull();
});

test.each([
  {
    unread: [{ filename: "selected.db3", error: "Unread permission sentence" }],
    message: "Unread permission sentence",
  },
  {
    unread: [
      { filename: "selected.db3", error: "First unread error" },
      { filename: "selected.db3", error: "Second unread error" },
    ],
    message: "Databases.LoadError.Title",
  },
])("preserves the selected unread database and shows $message", async ({ unread, message }) => {
  mocks.database = selectedDatabase;
  mocks.getDatabases.mockResolvedValue({ databases: [], unread });
  await render(true, false);

  expect(mocks.clearDatabase).not.toHaveBeenCalled();
  expect(mocks.setDatabase).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(message);
  expect(container.querySelector("a")?.getAttribute("href")).toBe("/library");
  expect(container.textContent).not.toMatch(/games table|players table|tournaments table/);
  expect(container.textContent).not.toContain("Databases.NoSelection");
});

test.each([
  { filename: "another.db3", handleId: "db-1" },
  { filename: "selected.db3", handleId: "other-database" },
])(
  "clears a selection without both the route and unread filename match: %j",
  async ({ filename, handleId }) => {
    mocks.database = { ...selectedDatabase, file: { id: { id: handleId }, kind: "database" } };
    mocks.getDatabases.mockResolvedValue({
      databases: [],
      unread: [{ filename, error: "Unread error" }],
    });
    await render(true, false);

    expect(mocks.clearDatabase).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Databases.NoSelection");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  },
);

test("a whole-list failure preserves the selection and uses the listing failure path", async () => {
  mocks.database = selectedDatabase;
  mocks.getDatabases.mockRejectedValue(new Error("listing failed"));
  await render(true, false);

  expect(mocks.clearDatabase).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not load databases. Please try again.",
  );
  expect(container.querySelector('[role="alert"] button')?.textContent).toBe("Retry");
});

test.each([
  {
    error: new Error("database listing failed"),
    message: "Could not load databases. Please try again.",
  },
  {
    error: { category: "not-found", message: "missing root", rootFailure: "missing" },
    message: "This database folder is no longer available. Choose another.",
  },
])(
  "database listing failure shows an alert with $message and retry",
  async ({ error, message }) => {
    mocks.getDatabases.mockRejectedValue(error);
    await render(true, false);

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(message);
    expect(alert?.querySelector("button")?.textContent).toBe("Retry");
    expect(alert?.querySelector("a")?.getAttribute("href")).toBe("/library");
    expect(container.textContent).not.toContain("loading");
  },
);

test("retry reloads a matching database and leaves the failure state", async () => {
  mocks.getDatabases.mockRejectedValueOnce(new Error("database listing failed"));
  await render(true, false);
  const retry = container.querySelector<HTMLButtonElement>('[role="alert"] button');
  expect(retry).not.toBeNull();

  const database = {
    type: "success",
    file: { id: { id: "db-1" }, kind: "database" },
    filename: "db-1.db3",
    title: "Recovered database",
    description: "",
    player_count: 0,
    event_count: 0,
    game_count: 0,
    storage_size: "0",
    indexed: false,
  };
  mocks.getDatabases.mockResolvedValueOnce({
    databases: [database],
    unread: [],
    root: { id: { id: "listing-test-root" }, kind: "databaseRoot" as const },
  });
  await act(async () => retry!.click());

  expect(mocks.getDatabases).toHaveBeenCalledTimes(2);
  expect(mocks.setDatabase).toHaveBeenCalledWith(database);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("cancelled database listing keeps the loader without an alert or retry", async () => {
  const error = new DOMException("Cancellation", "AbortError");
  mocks.getDatabases.mockRejectedValue(error);
  await render(true, false);

  expect(cache.get("databases")?.error).toBe(error);
  expect(container.textContent).toBe("loading");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector("button")).toBeNull();
});

test("real DatabaseView unsubscribe preserves its shared request and peer publication", async () => {
  let resolve!: (value: unknown[]) => void;
  let signal!: AbortSignal;
  mocks.getDatabases.mockImplementation(
    ({ signal: next }: { signal: AbortSignal }) =>
      new Promise((done) => {
        signal = next;
        resolve = done;
      }),
  );
  const onData = vi.fn();
  await render(true, true, onData);
  await vi.waitFor(() => expect(mocks.getDatabases).toHaveBeenCalledOnce());
  await render(false, true, onData);
  await act(async () => Promise.resolve());
  expect(signal.aborted).toBe(false);
  resolve([]);
  await vi.waitFor(() => expect(onData).toHaveBeenCalledWith([]));
});

test("real DatabaseView shared request cancels exactly once after sequential final unsubscribe", async () => {
  const cancelled = vi.fn();
  mocks.getDatabases.mockImplementation(
    ({ signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            cancelled();
            reject(new DOMException("Cancellation", "AbortError"));
          },
          { once: true },
        );
      }),
  );
  await render(true, true);
  await vi.waitFor(() => expect(mocks.getDatabases).toHaveBeenCalledOnce());
  await render(false, true);
  await act(async () => Promise.resolve());
  expect(cancelled).not.toHaveBeenCalled();
  await render(false, false);
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
});
