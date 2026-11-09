import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore, Provider } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Entry } from "@/components/files/file";
import type { RecentFile } from "@/state/recentFiles";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { useLibraryData } from "./useLibraryData";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({
  listing: { data: undefined as Entry[] | undefined, error: undefined as unknown, isLoading: true },
  mutate: vi.fn(),
  clear: vi.fn(),
}));
vi.mock("@/state/atoms", async () => {
  const { atom } = await import("jotai");
  return {
    fileWorkspaceAtom: atom(null),
    recentFilesAtom: atom<RecentFile[]>([]),
    lastOpenedAtom: atom({}),
    databaseConversionStateAtom: atom([]),
  };
});
vi.mock("./useWorkspaceListing", () => ({ useWorkspaceListing: () => mocks.listing }));
vi.mock("@/hooks/useDatabaseList", () => ({
  useDatabaseList: () => ({ data: undefined, isLoading: true }),
}));
vi.mock("swr", () => ({ useSWRConfig: () => ({ mutate: mocks.mutate }) }));
vi.mock("@/state/store/database", () => ({
  activeDatabaseViewStore: { getState: () => ({ clearDatabase: mocks.clear }) },
}));
// Keep the pure projection's utility dependency small and retain its real identity functions.
vi.mock("@/utils/db", async () => {
  const { capabilityKey } = await import("@/utils/pathCapabilities");
  return {
    databaseHandleKey: capabilityKey,
    sameDatabaseHandle: (a: unknown, b: unknown) => a === b,
  };
});
import { recentFilesAtom } from "@/state/atoms";
let root: Root;
let host: HTMLDivElement;
let store: ReturnType<typeof createStore>;
let latest: ReturnType<typeof useLibraryData>;
function Consumer() {
  latest = useLibraryData();
  return null;
}
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  store = createStore();
  mocks.listing = { data: undefined, error: undefined, isLoading: true };
  mocks.clear.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
test("renders recents while listing is pending, then adds rows, retaining failures without clearing the database view", async () => {
  const handle = { kind: "fileWorkspace" as const, id: { id: "recent" } };
  store.set(recentFilesAtom, [{ handle, name: "Recent", type: "repertoire", lastOpened: 10 }]);
  await act(async () =>
    root.render(
      <Provider store={store}>
        <Consumer />
      </Provider>,
    ),
  );
  expect(latest.rows.map((row) => row.key)).toEqual([fileWorkspaceKey(handle)]);
  expect(latest.loading).toBe(true);
  mocks.listing.data = [
    {
      type: "file",
      name: "Nested",
      handle: { kind: "fileWorkspace", id: { id: "nested" } },
      numGames: 1,
      metadata: { type: "repertoire", tags: [] },
      lastModified: 100,
    },
  ];
  await act(async () =>
    root.render(
      <Provider store={store}>
        <Consumer />
      </Provider>,
    ),
  );
  expect(latest.rows.map((row) => row.name)).toEqual(["Recent", "Nested"]);
  mocks.listing.error = new Error("failed to refresh");
  await act(async () =>
    root.render(
      <Provider store={store}>
        <Consumer />
      </Provider>,
    ),
  );
  expect(latest.rows).toHaveLength(2);
  expect(latest.listingError).toBe(mocks.listing.error);
  expect(mocks.clear).not.toHaveBeenCalled();
});
