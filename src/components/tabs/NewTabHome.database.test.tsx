import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createEmptyCard } from "ts-fsrs";
import type { NormalizedGame } from "@/bindings";
import { normalizeError } from "@/platform/errors";
import { deckAtomFamily, recentFilesAtom, tabsAtom, type RecentDatabaseGame } from "@/state/atoms";
import { resetPracticeMigrationForTests } from "@/state/practiceStorage";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { defaultTree } from "@/utils/treeReducer";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import NewTabHome from "./NewTabHome";

const mocks = vi.hoisted(() => ({
  getDbGame: vi.fn(),
  countPgnGames: vi.fn(),
  createTab: vi.fn(),
  navigate: vi.fn(),
  notify: vi.fn(),
  loadPracticeDeck: vi.fn(),
  listPracticeDecks: vi.fn(),
}));
vi.mock("@/platform/tauri", () => ({
  tauri: {
    getDbGame: mocks.getDbGame,
    countPgnGames: mocks.countPgnGames,
    loadPracticeDeck: mocks.loadPracticeDeck,
    listPracticeDecks: mocks.listPracticeDecks,
  },
}));
vi.mock("@/utils/tabs", async (original) => ({
  ...(await original<typeof import("@/utils/tabs")>()),
  createTab: mocks.createTab,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@/components/files/notifyError", () => ({ notifyUnlessCancelled: mocks.notify }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
}));
vi.mock("./CreateRepertoireModal", () => ({ default: () => null }));
vi.mock("./ImportModal", () => ({ default: () => null }));

const database = { id: { id: "recent-database" }, kind: "database" } as const;
const locator = {
  collection: "11111111-1111-4111-8111-111111111111",
  generation: "old",
  ordinal: 2,
  stamp: "a".repeat(64),
};
const game: NormalizedGame = {
  stamp: "b".repeat(64),
  id: 42,
  white: "White",
  black: "Black",
  white_id: 1,
  black_id: 2,
  event: "Event",
  site: "Unknown",
  date: null,
  round: null,
  event_id: 1,
  site_id: 1,
  result: "*",
  moves: "1. e4 *",
  fen: defaultTree().root.fen,
  linked: locator,
};
function entry(overrides: Partial<RecentDatabaseGame> = {}): RecentDatabaseGame {
  return {
    kind: "database",
    name: "White - Black",
    database,
    databaseTitle: "Meine Partien",
    gameId: 42,
    linked: {
      locator,
      signature: {
        white: game.white,
        black: game.black,
        event: game.event,
        site: game.site,
        date: null,
        round: null,
      },
    },
    lastOpened: 1,
    ...overrides,
  };
}
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let workspace: ReturnType<typeof createStore>;
installMatchMediaStub();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  workspace = createStore();
  workspace.set(tabsAtom, []);
  workspace.set(recentFilesAtom, [entry()]);
  mocks.getDbGame.mockResolvedValue({ kind: "found", game });
  mocks.createTab.mockResolvedValue("admitted-tab");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function render() {
  await act(async () =>
    root.render(
      <MantineProvider>
        <Provider store={workspace}>
          <NewTabHome id="home" />
        </Provider>
      </MantineProvider>,
    ),
  );
}
async function open() {
  await act(async () => host.querySelector<HTMLButtonElement>("[data-recent-file]")!.click());
}

test("idle Home lists reviewed repertoire cards as their future due boundaries pass", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-08T12:00:00Z"));
  resetPracticeMigrationForTests();
  const files = ["later", "earlier"].map((name) => ({
    name,
    type: "repertoire" as const,
    handle: { id: { id: crypto.randomUUID() }, kind: "fileWorkspace" as const },
    lastOpened: 1,
  }));
  mocks.countPgnGames.mockResolvedValue(1);
  mocks.listPracticeDecks.mockResolvedValue({ decks: [], anomalies: [] });
  mocks.loadPracticeDeck.mockImplementation(async (file: string) => ({
    epoch: "no-map",
    deck: {
      positionsDocument: JSON.stringify({
        positions: [
          {
            fen: defaultTree().root.fen,
            answer: "e4",
            card: {
              ...createEmptyCard(),
              reps: 1,
              due: new Date(
                Date.now() + (file === fileWorkspaceKey(files[0].handle) ? 5_000 : 1_000),
              ),
            },
          },
        ],
      }),
      revision: 1,
      generation: 0,
      migrated: false,
      unappliedReviews: 0,
      orphansAcknowledged: true,
    },
  }));
  workspace.set(recentFilesAtom, files);
  await render();
  for (const file of files) {
    expect(
      workspace.get(deckAtomFamily({ file: fileWorkspaceKey(file.handle), game: 0 })).status,
    ).toBe("ready");
  }
  const panel = host.querySelector("[data-home-due]")!;
  expect(panel.textContent).toContain("Home.DuePractice.NothingDue");
  await act(async () => vi.advanceTimersByTimeAsync(999));
  expect(panel.querySelectorAll("[data-due-file]")).toHaveLength(0);
  await act(async () => vi.advanceTimersByTimeAsync(2));
  expect(panel.querySelectorAll("[data-due-file]")).toHaveLength(1);
  expect(panel.querySelector("[data-due-file]")?.textContent).toContain("earlier");
  expect(panel.textContent).not.toContain("Home.DuePractice.NothingDue");
  await act(async () => vi.advanceTimersByTimeAsync(4_000));
  expect(panel.querySelectorAll("[data-due-file]")).toHaveLength(2);
});

test("database row renders context and forwards stored identity during pruning and reopening", async () => {
  const stored = workspace.get(recentFilesAtom)[0] as RecentDatabaseGame;
  await render();
  expect(host.querySelector("[data-recent-file]")!.textContent).toContain("Meine Partien");
  expect(host.querySelector("[data-recent-file]")!.textContent).toContain("White - Black");
  expect(mocks.getDbGame).toHaveBeenCalledWith(database, 42, stored.linked, {
    signal: expect.any(AbortSignal),
  });
  await open();
  expect(mocks.getDbGame).toHaveBeenCalledWith(database, 42, stored.linked);
  expect(mocks.createTab).toHaveBeenCalledOnce();
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/" });
  expect(workspace.get(recentFilesAtom)).toHaveLength(1);
  expect(workspace.get(recentFilesAtom)[0].lastOpened).toBeGreaterThan(1);
});

test.each([false, true])(
  "reopening after rebuild or placeholder save keeps one recent row (placeholders: %s)",
  async (placeholders) => {
    const refreshed = {
      ...game,
      id: 300,
      linked: { ...locator, generation: "new", ordinal: 1, stamp: "b".repeat(64) },
      ...(placeholders ? { site: "?", date: "????.??.??", round: "?" } : {}),
    };
    mocks.getDbGame.mockResolvedValue({ kind: "found", game: refreshed });
    await render();
    expect(workspace.get(recentFilesAtom)).toEqual([
      expect.objectContaining({
        gameId: 300,
        linked: expect.objectContaining({ locator: refreshed.linked }),
        lastOpened: 1,
      }),
    ]);
    await open();
    expect(workspace.get(recentFilesAtom)).toHaveLength(1);
    expect(workspace.get(recentFilesAtom)[0]).toMatchObject({
      gameId: 300,
      linked: { locator: refreshed.linked },
    });
  },
);

test("distinct signatures stay separate when an earlier source game is removed", async () => {
  const other = entry({
    name: "Other - Black",
    gameId: 43,
    linked: {
      locator: { ...locator, ordinal: 3 },
      signature: { ...entry().linked!.signature, white: "Other" },
    },
    lastOpened: 2,
  });
  workspace.set(recentFilesAtom, [entry(), other]);
  mocks.getDbGame.mockImplementation(async (_database, _id, identity) => ({
    kind: "found",
    game: {
      ...game,
      id: identity.signature.white === "Other" ? 301 : 300,
      white: identity.signature.white,
      linked: {
        ...locator,
        generation: "new",
        ordinal: identity.signature.white === "Other" ? 1 : 0,
      },
    },
  }));
  await render();
  expect(workspace.get(recentFilesAtom)).toHaveLength(2);
  await open();
  expect(workspace.get(recentFilesAtom)).toHaveLength(2);
  expect(
    workspace
      .get(recentFilesAtom)
      .map((file) => file.name)
      .sort(),
  ).toEqual(["Other - Black", "White - Black"]);
});

test("missing entries are pruned while every lookup error keeps them", async () => {
  workspace.set(recentFilesAtom, [
    entry(),
    entry({ database: { id: { id: "unavailable" }, kind: "database" }, name: "Unavailable" }),
  ]);
  mocks.getDbGame.mockImplementation(async (handle) => {
    if (handle.id.id === "unavailable") throw new Error("busy");
    return { kind: "missing" };
  });
  await render();
  expect(workspace.get(recentFilesAtom)).toEqual([
    expect.objectContaining({ name: "Unavailable" }),
  ]);
  await open();
  expect(workspace.get(recentFilesAtom)).toHaveLength(1);
  expect(mocks.notify).toHaveBeenCalledOnce();
  expect(mocks.createTab).not.toHaveBeenCalled();
});

test("a game deleted after mount is removed and notified on click", async () => {
  await render();
  mocks.getDbGame.mockResolvedValue({ kind: "missing" });
  await open();
  expect(workspace.get(recentFilesAtom)).toEqual([]);
  expect(mocks.notify).toHaveBeenCalledWith(
    "Common.Error",
    expect.objectContaining({ category: "not-found" }),
  );
  expect(mocks.createTab).not.toHaveBeenCalled();
});

test("a not-found lookup rejection keeps the database entry during pruning and on click", async () => {
  const stored = workspace.get(recentFilesAtom);
  const error = new Error("Game not found: lookup unavailable");
  expect(normalizeError(error).category).toBe("not-found");
  mocks.getDbGame.mockRejectedValue(error);
  await render();
  expect(mocks.getDbGame).toHaveBeenCalledWith(database, 42, entry().linked, {
    signal: expect.any(AbortSignal),
  });
  expect(workspace.get(recentFilesAtom)).toEqual(stored);
  expect(host.querySelector("[data-recent-file]")).not.toBeNull();
  mocks.getDbGame.mockClear();
  await open();
  expect(mocks.getDbGame).toHaveBeenCalledExactlyOnceWith(database, 42, entry().linked);
  expect(workspace.get(recentFilesAtom)).toEqual(stored);
  expect(host.querySelector("[data-recent-file]")).not.toBeNull();
  expect(mocks.notify).toHaveBeenCalledWith("Common.Error", error);
  expect(mocks.createTab).not.toHaveBeenCalled();
});
