import { Provider, createStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildFromTree } from "@/components/files/opening";
import { practiceSegmentGateFamily, tabsAtom } from "@/state/atoms";
import { resetPracticeMigrationForTests } from "@/state/practiceStorage";
import { createTreeStore } from "@/state/store/tree";
import { defaultTree } from "@/utils/treeReducer";
import {
  SYNC_MESSAGE_DISMISS_MS,
  useDeckSync,
  type UseDeckSyncParams,
  type UseDeckSyncResult,
} from "./useDeckSync";

const mocks = vi.hoisted(() => ({
  native: {
    loadPracticeDeck: vi.fn(),
    syncPracticePositions: vi.fn(),
    listPracticeDecks: vi.fn(),
  },
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

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;
let mounted = false;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  sessionStorage.clear();
  localStorage.clear();
  resetPracticeMigrationForTests();
  mocks.native.listPracticeDecks.mockResolvedValue({ decks: [], anomalies: [] });
  mocks.native.syncPracticePositions.mockImplementation(
    async (_file, _game, _generation, revision) => revision + 1,
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mounted = true;
});

afterEach(async () => {
  if (mounted) {
    mounted = false;
    await act(async () => root.unmount());
  }
  host.remove();
  vi.useRealTimers();
  sessionStorage.clear();
  localStorage.clear();
});

async function mountSyncedDeck() {
  const initialTree = createTreeStore(undefined, defaultTree());
  initialTree.getState().makeMoves({ payload: ["e4", "e5", "Nf3"] });
  const initialCards = buildFromTree(initialTree.getState().root, "white", []);
  expect(initialCards.length).toBeGreaterThan(0);

  mocks.native.loadPracticeDeck.mockResolvedValue({
    epoch: "no-map",
    deck: {
      positionsDocument: JSON.stringify({ positions: initialCards }),
      revision: 1,
      generation: 0,
      migrated: false,
      unappliedReviews: 0,
      orphansAcknowledged: true,
    },
  });

  // Tree has an extra White reply so syncDeck reports added: 1, removed: 0.
  const updatedTree = createTreeStore(undefined, defaultTree());
  updatedTree.getState().makeMoves({ payload: ["e4", "e5", "Nf3", "Nc6", "Bb5"] });

  const atomStore = createStore();
  const tabId = crypto.randomUUID();
  atomStore.set(tabsAtom, []);
  const deckIdentity = { file: `file-${crypto.randomUUID()}`, game: 0 };

  let latest!: UseDeckSyncResult;
  function Harness(props: UseDeckSyncParams) {
    latest = useDeckSync(props);
    return null;
  }

  async function renderTree(tree: ReturnType<typeof createTreeStore>) {
    await act(async () =>
      root.render(
        <Provider store={atomStore}>
          <Harness
            root={tree.getState().root}
            headers={{ ...tree.getState().headers, orientation: "white", start: [] }}
            treeViewDeferred={false}
            deckIdentity={deckIdentity}
            currentTabId={tabId}
          />
        </Provider>,
      ),
    );
    // Let async deck hydration and the subsequent sync effect settle.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  await renderTree(updatedTree);

  return {
    getLatest: () => latest,
    renderTree,
    atomStore,
    tabId,
  };
}

test("syncMessage clears after SYNC_MESSAGE_DISMISS_MS", async () => {
  const { getLatest } = await mountSyncedDeck();
  expect(getLatest().syncMessage).toEqual({ added: 1, removed: 0 });

  await act(async () => {
    await vi.advanceTimersByTimeAsync(SYNC_MESSAGE_DISMISS_MS - 1);
  });
  expect(getLatest().syncMessage).toEqual({ added: 1, removed: 0 });

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(getLatest().syncMessage).toBeNull();
});

test("clearSyncMessageTimer cancels the clear timeout without clearing syncMessage", async () => {
  const { getLatest } = await mountSyncedDeck();
  expect(getLatest().syncMessage).toEqual({ added: 1, removed: 0 });

  await act(async () => {
    getLatest().clearSyncMessageTimer();
  });
  expect(getLatest().syncMessage).toEqual({ added: 1, removed: 0 });

  await act(async () => {
    await vi.advanceTimersByTimeAsync(SYNC_MESSAGE_DISMISS_MS * 2);
  });
  expect(getLatest().syncMessage).toEqual({ added: 1, removed: 0 });
});

test("a second sync before the first timer expires re-arms the dismiss timer", async () => {
  const { getLatest, renderTree } = await mountSyncedDeck();
  expect(getLatest().syncMessage).toEqual({ added: 1, removed: 0 });

  const elapsedBeforeSecondSync = 3_000;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(elapsedBeforeSecondSync);
  });

  // Add two more White replies so the second sync sets a distinct message and re-arms the timer.
  const secondTree = createTreeStore(undefined, defaultTree());
  secondTree
    .getState()
    .makeMoves({ payload: ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O"] });
  await renderTree(secondTree);
  expect(getLatest().syncMessage).toEqual({ added: 2, removed: 0 });

  // Reaching first sync + SYNC_MESSAGE_DISMISS_MS must not clear the newer message.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SYNC_MESSAGE_DISMISS_MS - elapsedBeforeSecondSync);
  });
  expect(getLatest().syncMessage).toEqual({ added: 2, removed: 0 });

  // Just before second sync + SYNC_MESSAGE_DISMISS_MS it is still visible.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(elapsedBeforeSecondSync - 1);
  });
  expect(getLatest().syncMessage).toEqual({ added: 2, removed: 0 });

  // At second sync + SYNC_MESSAGE_DISMISS_MS it clears.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(getLatest().syncMessage).toBeNull();
});

test("reports synced with the current tree and scope on the tab gate", async () => {
  const { getLatest, atomStore, tabId } = await mountSyncedDeck();
  expect(getLatest().syncedWithTreeAndScope).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(atomStore.get(practiceSegmentGateFamily(tabId))).toEqual({
    synced: true,
    status: "ready",
  });
});
