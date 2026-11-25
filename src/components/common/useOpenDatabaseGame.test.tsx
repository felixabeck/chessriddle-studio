import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DatabaseHandle, NormalizedGame } from "@/bindings";
import { DATABASE_LIST_KEY } from "@/hooks/useDatabaseList";
import type { DatabaseList } from "@/utils/db";
import {
  type DatabaseGameTarget,
  listedDatabaseTitle,
  useDatabaseGameOpener,
} from "./useOpenDatabaseGame";

const mocks = vi.hoisted(() => ({
  openDatabaseGame: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@/utils/databaseGame", () => ({ openDatabaseGame: mocks.openDatabaseGame }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const handle = (id: string) => ({ id: { id }, kind: "database" }) as unknown as DatabaseHandle;
const game = { id: 7, white: "A", black: "B" } as NormalizedGame;

const listing = {
  databases: [
    { type: "error", file: handle("broken"), filename: "broken.db3", error: "x" },
    { type: "success", file: handle("games"), title: "My games" },
  ],
} as unknown as DatabaseList;

let host: HTMLDivElement;
let root: Root;
let open: ReturnType<typeof useDatabaseGameOpener>;

function Probe() {
  open = useDatabaseGameOpener();
  return null;
}

async function mount(cached?: DatabaseList) {
  const cache = new Map<string, unknown>();
  if (cached) cache.set(DATABASE_LIST_KEY, { data: cached });
  await act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => cache as never }}>
        <Probe />
      </SWRConfig>,
    ),
  );
}

const recordedTitle = () => mocks.openDatabaseGame.mock.lastCall![0].databaseTitle;
const openTarget = (target: Partial<DatabaseGameTarget>) =>
  act(() => open({ game, database: handle("games"), ...target }));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.openDatabaseGame.mockResolvedValue("tab-1");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

test("an untitled open records the listing's title for its handle and lands on the board", async () => {
  await mount(listing);
  await expect(openTarget({})).resolves.toBe("tab-1");
  expect(recordedTitle()).toBe("My games");
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/" });
});

test("a caller's own title wins over the listing's", async () => {
  await mount(listing);
  await openTarget({ databaseTitle: "Home row title" });
  expect(recordedTitle()).toBe("Home row title");
});

test("an admission refusal stays on the current page", async () => {
  mocks.openDatabaseGame.mockResolvedValue(null);
  await mount(listing);
  await expect(openTarget({})).resolves.toBeNull();
  expect(mocks.navigate).not.toHaveBeenCalled();
});

test("abort signal, owner and store reach the tab admission", async () => {
  const signal = new AbortController().signal;
  const store = {} as never;
  await mount();
  await act(() => open({ game, database: handle("games") }, { signal, ownerId: "home", store }));
  expect(mocks.openDatabaseGame).toHaveBeenCalledWith(
    expect.objectContaining({ game, signal, ownerId: "home", store, databaseTitle: undefined }),
  );
});

test("fromPreview from the list opener reaches tab admission", async () => {
  await mount();
  await act(() => open({ game, database: handle("games") }, { fromPreview: true }));
  expect(mocks.openDatabaseGame).toHaveBeenCalledWith(
    expect.objectContaining({ fromPreview: true }),
  );
});

test("the default opener does not pass fromPreview", async () => {
  await mount();
  await act(() => open({ game, database: handle("games") }));
  expect(mocks.openDatabaseGame.mock.lastCall![0].fromPreview).toBeUndefined();
});

test("an unlisted, failed or absent database records no title", () => {
  expect(listedDatabaseTitle(listing, handle("other"))).toBeUndefined();
  expect(listedDatabaseTitle(listing, handle("broken"))).toBeUndefined();
  expect(listedDatabaseTitle(undefined, handle("games"))).toBeUndefined();
  expect(listedDatabaseTitle(listing, null)).toBeUndefined();
});
