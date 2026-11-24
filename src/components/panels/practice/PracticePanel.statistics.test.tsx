import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { buildFromTree } from "@/components/files/opening";
import { activeTabAtom, deckAtomFamily, referenceDbAtom, tabsAtom } from "@/state/atoms";
import { resetPracticeMigrationForTests } from "@/state/practiceStorage";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { WorkspaceTabScope } from "@/state/tabScope";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { defaultTree, getBoardState } from "@/utils/treeReducer";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { getTabFile } from "@/utils/tabs";
import PracticePanel from "./PracticePanel";

const mocks = vi.hoisted(() => ({
  native: {
    loadPracticeDeck: vi.fn(),
    recordPracticeReview: vi.fn(),
    syncPracticePositions: vi.fn(),
    loadPracticeReviews: vi.fn(),
    listPracticeDecks: vi.fn(),
    searchPositionsStats: vi.fn(),
    collectionForDatabase: vi.fn(async () => null),
  },
  notificationShow: vi.fn(),
  hideRepertoireInfo: false,
}));

vi.mock("@/platform/tauri", async (original) => {
  const actual = await original<typeof import("@/platform/tauri")>();
  return {
    ...actual,
    tauri: new Proxy(actual.tauri, {
      get(target, key, receiver) {
        return key in mocks.native
          ? mocks.native[key as keyof typeof mocks.native]
          : Reflect.get(target, key, receiver);
      },
    }),
  };
});
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: mocks.notificationShow },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en-US" },
  }),
}));
vi.mock("@/hooks/useScaledMaxWidth", () => ({ useScaledMaxWidth: () => false }));
vi.mock("./RepertoireInfo", async (original) => {
  const actual = await original<typeof import("./RepertoireInfo")>();
  function RepertoireInfo() {
    return mocks.hideRepertoireInfo ? null : actual.default();
  }
  return { default: RepertoireInfo };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const database = { id: { id: "reference" }, kind: "database" as const };

let host: HTMLDivElement;
let root: Root;
let tree: TreeStore;
let atoms: ReturnType<typeof createStore>;
let owner: import("@/state/workspaceTypes").Tab;

function italianBoards() {
  const store = createTreeStore(undefined, defaultTree());
  expect(store.getState().makeMoves({ payload: ["e4", "e5", "Nf3"] }).success).toBe(true);
  const root = store.getState().root;
  return {
    e4: getBoardState(root.children[0].fen),
    e5: getBoardState(root.children[0].children[0].fen),
  };
}

function distinctiveOpenings(fen: string, e5Games: number) {
  const boards = italianBoards();
  if (fen === boards.e4) {
    return [
      { move: "e5", white: e5Games, draw: 0, black: 0 },
      { move: "c5", white: 100 - e5Games, draw: 0, black: 0 },
    ];
  }
  if (fen === boards.e5) {
    return [
      { move: "Nf3", white: 80, draw: 0, black: 0 },
      { move: "Bc4", white: 20, draw: 0, black: 0 },
    ];
  }
  return [];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hideRepertoireInfo = false;
  sessionStorage.clear();
  localStorage.clear();
  resetPracticeMigrationForTests();
  mocks.native.listPracticeDecks.mockResolvedValue({ decks: [], anomalies: [] });
  mocks.native.syncPracticePositions.mockImplementation(
    async (_file, _game, _generation, revision) => revision + 1,
  );
  mocks.native.collectionForDatabase.mockResolvedValue(null);
  mocks.native.searchPositionsStats.mockImplementation(async (_db, fens: string[]) =>
    fens.map((fen) => ({ fen, openings: [] })),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  sessionStorage.clear();
  localStorage.clear();
});

async function mountPanel(start: number[] = []) {
  tree = createTreeStore(undefined, defaultTree());
  expect(tree.getState().makeMoves({ payload: ["e4", "e5", "Nf3"] }).success).toBe(true);
  tree.getState().setStart(start);
  tree.getState().save("a".repeat(64));
  const cards = buildFromTree(tree.getState().root, "white", start);
  mocks.native.loadPracticeDeck.mockResolvedValue({
    epoch: "no-map",
    deck: {
      positionsDocument: JSON.stringify({ positions: cards }),
      revision: 1,
      generation: 0,
      migrated: false,
      unappliedReviews: 0,
      orphansAcknowledged: true,
    },
  });
  atoms = createStore();
  owner = {
    name: "Practice",
    value: crypto.randomUUID(),
    type: "analysis",
    gameOrigin: {
      kind: "file",
      gameNumber: 0,
      file: {
        type: "file",
        handle: { id: { id: crypto.randomUUID() }, kind: "fileWorkspace" },
        name: "Practice",
        numGames: 1,
        metadata: { type: "repertoire", tags: [] },
        lastModified: 1,
      },
    },
  };
  atoms.set(tabsAtom, [owner], owner.value);
  atoms.set(activeTabAtom, owner.value);
  atoms.set(referenceDbAtom, database);
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <Provider store={atoms}>
          <WorkspaceTabScope tabId={owner.value}>
            <TreeStateContext.Provider value={tree}>
              <PracticePanel />
            </TreeStateContext.Provider>
          </WorkspaceTabScope>
        </Provider>
      </MantineProvider>,
    ),
  );
  return cards;
}

function deckIdentity() {
  return { file: fileWorkspaceKey(getTabFile(owner)!.handle), game: 0 };
}

test("Train shown issues one batch request that feeds coverage and weights and includes the path to Start", async () => {
  mocks.native.searchPositionsStats.mockImplementation(async (_db, fens: string[]) =>
    fens.map((fen) => ({ fen, openings: distinctiveOpenings(fen, 30) })),
  );
  await mountPanel([0, 0]);
  expect(host.textContent).toContain("Board.Practice.Train");
  await vi.waitFor(() => expect(mocks.native.searchPositionsStats).toHaveBeenCalledOnce());
  const fens = mocks.native.searchPositionsStats.mock.calls[0][1] as string[];
  expect(fens).toEqual(
    expect.arrayContaining([
      getBoardState(tree.getState().root.fen),
      getBoardState(tree.getState().root.children[0].fen),
      getBoardState(tree.getState().root.children[0].children[0].fen),
    ]),
  );
  await vi.waitFor(() => {
    const deck = atoms.get(deckAtomFamily(deckIdentity()));
    expect(deck.positions.some((position) => position.weight === 0.3)).toBe(true);
  });
  await act(async () => {
    tree.getState().goToMove([0]);
  });
  expect(host.textContent).toContain("c5");
  expect(host.textContent).toContain("70%");
  expect(mocks.native.searchPositionsStats).toHaveBeenCalledOnce();
});

test("Train writes weights from one batch when Build is not mounted", async () => {
  mocks.hideRepertoireInfo = true;
  mocks.native.searchPositionsStats.mockImplementation(async (_db, fens: string[]) =>
    fens.map((fen) => ({ fen, openings: distinctiveOpenings(fen, 30) })),
  );
  await mountPanel([]);
  expect(host.textContent).toContain("Board.Practice.Train");
  expect(host.textContent).not.toContain("c5");
  await vi.waitFor(() => expect(mocks.native.searchPositionsStats).toHaveBeenCalledOnce());
  await vi.waitFor(() => {
    const deck = atoms.get(deckAtomFamily(deckIdentity()));
    expect(deck.positions.some((position) => position.weight === 0.3)).toBe(true);
  });
  expect(mocks.native.searchPositionsStats).toHaveBeenCalledOnce();
});

test("a change of Start cancels the in-flight request and drops a late result", async () => {
  const pending: { signal: AbortSignal; resolve: (e5Games: number) => void }[] = [];
  mocks.native.searchPositionsStats.mockImplementation(
    async (
      _db,
      fens: string[],
      _filter: unknown,
      _operation: string,
      { signal }: { signal: AbortSignal },
    ) => {
      const e5Games = await new Promise<number>((resolve) => {
        pending.push({ signal, resolve });
      });
      return fens.map((fen) => ({ fen, openings: distinctiveOpenings(fen, e5Games) }));
    },
  );
  await mountPanel([]);
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  const first = pending[0];
  await act(async () => {
    tree.getState().setStart([0, 0]);
    tree.getState().save("b".repeat(64));
  });
  expect(first.signal.aborted).toBe(true);
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  await act(async () => first.resolve(30));
  expect(
    atoms
      .get(deckAtomFamily(deckIdentity()))
      .positions.every((position) => position.weight !== 0.3),
  ).toBe(true);
  expect(
    atoms.get(deckAtomFamily(deckIdentity())).positions.every((position) => !position.weight),
  ).toBe(true);
  await act(async () => pending[1].resolve(80));
  await vi.waitFor(() => {
    const deck = atoms.get(deckAtomFamily(deckIdentity()));
    expect(deck.positions.some((position) => position.weight === 0.8)).toBe(true);
  });
});
