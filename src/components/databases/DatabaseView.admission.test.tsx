import { MantineProvider } from "@mantine/core";
import { Provider as JotaiProvider } from "jotai";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { activeDatabaseViewStore } from "@/state/store/database";
import { decodeCompressedOrJson } from "@/state/store/debouncedStorage";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import type { DatabaseList, SuccessDatabaseInfo } from "@/utils/db";
import DatabaseView from "./DatabaseView";
import { resolveDatabaseRoute } from "./databaseRoute";

const mocks = vi.hoisted(() => ({
  data: undefined as DatabaseList | undefined,
  report: vi.fn(),
  navigate: vi.fn(),
  requestKeys: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock("@/platform/native", () => ({ platform: () => "linux", warn: vi.fn(), error: vi.fn() }));
vi.mock("@/state/persistError", () => ({ reportPersistError: mocks.report }));
vi.mock("@/hooks/useDatabaseList", () => ({
  useDatabaseList: () => ({ data: mocks.data, mutate: mocks.mutate }),
}));
vi.mock("@/state/linkedCollections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/linkedCollections")>()),
  useCollectionCurrency: () => ({ collection: { status: "ready" } }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ databaseId: "db-1" }),
  useNavigate: () => mocks.navigate,
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("swr", async (original) => ({
  ...(await original<typeof import("swr")>()),
  default: (key: unknown) => {
    // Observe the real GameTable request key without starting a native query.
    mocks.requestKeys(key);
    return { data: { data: [], count: 0 }, isLoading: false };
  },
}));
vi.mock("./GridLayout", () => ({
  default: ({ table }: { table: ReactNode }) => <div data-game-table>{table}</div>,
}));
vi.mock("mantine-datatable", () => ({ DataTable: () => <div>games table</div> }));
vi.mock("./GameCard", () => ({ default: () => null }));
vi.mock("./PlayerTable", () => ({ default: () => <div data-player-table>players table</div> }));
vi.mock("./TournamentTable", () => ({
  default: () => <div data-tournament-table>tournaments table</div>,
}));

installMatchMediaStub();
installResizeObserverStub();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const fresh: SuccessDatabaseInfo = {
  type: "success",
  file: { id: { id: "db-1" }, kind: "database" },
  filename: "selected.db3",
  title: "Fresh database",
  description: "",
  player_count: 0,
  event_count: 0,
  game_count: 0,
  storage_size: "0",
  indexed: false,
  collection: {
    id: "collection",
    name: "Games",
    file: { id: { id: "collection-file" }, kind: "fileWorkspace" },
    database: { id: { id: "db-1" }, kind: "database" },
    account: null,
    status: "ready",
    generation: "next-generation",
    omitted: 0,
    retiredDatabase: null,
    fetchSinceMs: null,
  },
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  activeDatabaseViewStore.setState(activeDatabaseViewStore.getInitialState(), true);
  mocks.data = {
    databases: [fresh],
    unread: [],
    workspaceFilenames: [],
    root: { id: { id: "root" }, kind: "databaseRoot" },
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => root.unmount());
  host.remove();
  activeDatabaseViewStore.getState().clearDatabase();
  sessionStorage.clear();
});

async function render() {
  await act(async () =>
    root.render(
      <MantineProvider>
        <JotaiProvider>
          <DatabaseView />
        </JotaiProvider>
      </MantineProvider>,
    ),
  );
}

test.each(["synchronizing", "ready"] as const)(
  "%s refusal preserves the admitted view and attempts once for unchanged inputs",
  async (status) => {
    const previous: SuccessDatabaseInfo = {
      ...fresh,
      file: status === "synchronizing" ? { id: { id: "previous" }, kind: "database" } : fresh.file,
      collection: { ...fresh.collection!, generation: "admitted-generation" },
    };
    activeDatabaseViewStore.getState().setDatabase(previous);
    const before = activeDatabaseViewStore.getState();
    const seeded = JSON.stringify({ state: before, version: 0 });
    sessionStorage.setItem("database-view", seeded);
    const nativeSetItem = Storage.prototype.setItem;
    const refused = vi.fn(() => {
      expect(activeDatabaseViewStore.getState()).toBe(before);
      expect(sessionStorage.getItem("database-view")).toBe(seeded);
      throw new DOMException("quota", "QuotaExceededError");
    });
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (this === sessionStorage && key === "database-view") return refused();
        return nativeSetItem.call(this, key, value);
      });
    try {
      await render();
      await render();
      expect(refused).toHaveBeenCalledOnce();
      expect(mocks.report).toHaveBeenCalledOnce();
      expect(activeDatabaseViewStore.getState()).toBe(before);
      expect(sessionStorage.getItem("database-view")).toBe(seeded);
      expect(decodeCompressedOrJson(seeded)).toMatchObject({
        state: { database: { collection: { generation: "admitted-generation" } } },
      });
      expect(resolveDatabaseRoute(mocks.data!.databases, "db-1", before.database).status).toBe(
        status,
      );
      expect(
        host.querySelector("[data-game-table], [data-player-table], [data-tournament-table]") !==
          null,
      ).toBe(status === "ready");
      expect(
        host.querySelector("[data-game-table]")?.textContent?.includes("games table") ?? false,
      ).toBe(status === "ready");
      expect(mocks.requestKeys.mock.calls.length > 0).toBe(status === "ready");
      for (const [key] of mocks.requestKeys.mock.calls) {
        expect(key).toEqual(["games", previous.file, before.games.query, "admitted-generation"]);
      }
    } finally {
      setItem.mockRestore();
    }
  },
);
