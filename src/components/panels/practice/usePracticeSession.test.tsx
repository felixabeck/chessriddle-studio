import { Provider, createStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useStore } from "zustand";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { buildFromTree } from "@/components/files/opening";
import {
  activeTabAtom,
  practiceGradingAtom,
  practiceNewPerSessionAtom,
  practiceStateFamily,
  tabsAtom,
} from "@/state/atoms";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { WorkspaceTabScope } from "@/state/tabScope";
import { defaultTree } from "@/utils/treeReducer";
import { PRACTICE_REPLAY_STEP_MS } from "./session";
import type { UseDeckSyncResult } from "./useDeckSync";
import { usePracticeSession } from "./usePracticeSession";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;
let mounted = false;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
  sessionStorage.clear();
  localStorage.clear();
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
  vi.restoreAllMocks();
  vi.useRealTimers();
  sessionStorage.clear();
  localStorage.clear();
});

async function mountSession() {
  const tree = createTreeStore(undefined, defaultTree());
  tree.getState().makeMoves({ payload: ["e4", "e5", "Nf3", "Nc6", "Bb5"] });
  tree.getState().setHeaders({ ...tree.getState().headers, orientation: "white", start: [] });
  tree.getState().goToMove([]);

  // Keep only the deeper card (after 1. e4 e5 2. Nf3 Nc6) so replay takes multiple timed steps.
  const allCards = buildFromTree(tree.getState().root, "white", []);
  const deepCard = allCards[allCards.length - 1];
  deepCard.card = { ...deepCard.card, reps: 1, due: new Date(Date.now() - 1_000) };

  const deck: UseDeckSyncResult["deck"] = {
    status: "ready",
    positions: [deepCard],
    revision: 1,
    generation: 0,
    epoch: "no-map",
    unappliedReviews: 0,
    orphansAcknowledged: true,
  };
  const setDeck = vi.fn() as unknown as UseDeckSyncResult["setDeck"];
  const clearSyncMessageTimer = vi.fn();

  const atoms = createStore();
  const tabId = crypto.randomUUID();
  atoms.set(tabsAtom, []);
  atoms.set(activeTabAtom, tabId);
  atoms.set(practiceGradingAtom, "auto");
  atoms.set(practiceNewPerSessionAtom, 10);

  let latest!: ReturnType<typeof usePracticeSession>;
  function Harness({ store, tab }: { store: TreeStore; tab: string }) {
    const treeRoot = useStore(store, (s) => s.root);
    const headers = useStore(store, (s) => s.headers);
    const currentFen = useStore(store, (s) => s.currentNode().fen);
    latest = usePracticeSession({
      store,
      root: treeRoot,
      headers,
      currentFen,
      deck,
      setDeck,
      deckIdentity: { file: "file-a", game: 0 },
      currentTabId: tabId,
      currentTabTreeKey: "tree-a",
      tab,
      clearSyncMessageTimer,
    });
    return null;
  }

  async function renderTab(tab: string) {
    await act(async () =>
      root.render(
        <Provider store={atoms}>
          <WorkspaceTabScope tabId={tabId}>
            <TreeStateContext.Provider value={tree}>
              <Harness store={tree} tab={tab} />
            </TreeStateContext.Provider>
          </WorkspaceTabScope>
        </Provider>,
      ),
    );
  }

  await renderTab("train");

  return {
    tree,
    atoms,
    tabId,
    clearSyncMessageTimer,
    getLatest: () => latest,
    renderTab,
  };
}

test("a scheduled replay timer superseded by endPracticeSession never fires its callback", async () => {
  const { tree, atoms, tabId, getLatest } = await mountSession();

  const capturedReplayCallbacks: (() => void)[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => {
    if (typeof handler === "function" && timeout === PRACTICE_REPLAY_STEP_MS) {
      capturedReplayCallbacks.push(handler as () => void);
    }
    return realSetTimeout(handler, timeout, ...args);
  }) as typeof setTimeout);

  try {
    await act(async () => {
      getLatest().startPractice();
    });
    expect(getLatest().practiceState.phase).toBe("replaying");
    expect(capturedReplayCallbacks).toHaveLength(1);
    const staleCallback = capturedReplayCallbacks[0];

    await act(async () => {
      getLatest().endPracticeSession();
    });
    expect(getLatest().practiceState.phase).toBe("idle");
    expect(tree.getState().position).toEqual([]);

    // Invoking the stale timer wrapper directly exercises the idle guard even if clearTimeout raced.
    await act(async () => {
      staleCallback();
    });
    expect(getLatest().practiceState.phase).toBe("idle");
    expect(atoms.get(practiceStateFamily(tabId)).phase).toBe("idle");
    expect(tree.getState().position).toEqual([]);

    // Starting a fresh session bumps the token; invoking the token-1 callback must also be ignored.
    await act(async () => {
      getLatest().startPractice();
    });
    expect(getLatest().practiceState.phase).toBe("replaying");
    expect(tree.getState().position).toEqual([]);

    await act(async () => {
      staleCallback();
    });
    expect(tree.getState().position).toEqual([]);
  } finally {
    setTimeoutSpy.mockRestore();
  }
});

test("unmount clears pending timers and ends the session", async () => {
  const { atoms, tabId, clearSyncMessageTimer, getLatest } = await mountSession();
  const baseline = vi.getTimerCount();

  await act(async () => {
    getLatest().startPractice();
  });
  expect(getLatest().practiceState.phase).toBe("replaying");
  expect(vi.getTimerCount()).toBeGreaterThan(baseline);
  clearSyncMessageTimer.mockClear();

  mounted = false;
  await act(async () => root.unmount());

  expect(vi.getTimerCount()).toBe(baseline);
  expect(atoms.get(practiceStateFamily(tabId)).phase).toBe("idle");
  expect(clearSyncMessageTimer).toHaveBeenCalled();
});

test("leaving the train tab ends an active session", async () => {
  const { atoms, tabId, getLatest, renderTab } = await mountSession();

  await act(async () => {
    getLatest().startPractice();
  });
  expect(getLatest().practiceState.phase).toBe("replaying");

  await renderTab("build");

  expect(getLatest().practiceState.phase).toBe("idle");
  expect(atoms.get(practiceStateFamily(tabId)).phase).toBe("idle");
  expect(getLatest().completedSummary).toBeNull();
});
