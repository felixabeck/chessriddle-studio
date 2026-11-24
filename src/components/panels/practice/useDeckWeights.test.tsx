import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createEmptyCard } from "ts-fsrs";
import { createTreeStore } from "@/state/store/tree";
import { defaultTree, getBoardState, type TreeNode } from "@/utils/treeReducer";
import type { TreeStatistics } from "@/utils/repertoire";
import { buildFromTree } from "@/components/files/opening";
import { useDeckWeights, type UseDeckWeightsParams } from "./useDeckWeights";
import type { PracticeStatistics } from "./usePracticeStatistics";
import type { PracticeDeckValue } from "@/state/practiceStorage";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function readyDeck(positions: PracticeDeckValue["positions"]): PracticeDeckValue {
  return {
    epoch: "no-map",
    positions,
    revision: 1,
    generation: 0,
    unappliedReviews: 0,
    orphansAcknowledged: true,
    status: "ready",
  };
}

function opponentE5Stats(root: TreeNode, e5Games = 30, otherGames = 70): TreeStatistics {
  return new Map([
    [
      getBoardState(root.children[0].fen),
      {
        moves: [
          { move: "e5", white: e5Games, draw: 0, black: 0 },
          { move: "c5", white: otherGames, draw: 0, black: 0 },
        ],
        total: e5Games + otherGames,
      },
    ],
  ]);
}

function successStatistics(dbMovesMap: TreeStatistics): PracticeStatistics {
  return {
    statisticsResult: {
      coverageMap: new Map(),
      gamesMap: new Map(),
      missingGamesMap: new Map(),
      dbMovesMap,
    },
    statisticsStatus: "success",
    coverageMap: new Map(),
    retryStatistics: () => undefined,
    referenceDb: { id: { id: "reference" }, kind: "database" },
    selectedReference: { id: { id: "reference" }, kind: "database" },
    selectedReferenceKey: "db:reference",
    referenceKey: "db:reference",
    currencyGeneration: undefined,
    currencyStatus: undefined,
    currencyError: undefined,
    currencyPending: false,
  };
}

function italianTree() {
  const store = createTreeStore();
  expect(store.getState().makeMoves({ payload: ["e4", "e5", "Nf3"] }).success).toBe(true);
  return store;
}

async function renderWeights(params: UseDeckWeightsParams) {
  function Harness({ value }: { value: UseDeckWeightsParams }) {
    useDeckWeights(value);
    return null;
  }
  await act(async () => {
    root.render(<Harness value={params} />);
  });
  return {
    rerender: async (value: UseDeckWeightsParams) => {
      await act(async () => {
        root.render(<Harness value={value} />);
      });
    },
  };
}

test("weights are written when the deck is ready and statistics are current", async () => {
  const store = italianTree();
  const positions = buildFromTree(store.getState().root, "white", []);
  const setDeck = vi.fn((update) =>
    typeof update === "function" ? update(readyDeck(positions)) : update,
  );
  await renderWeights({
    root: store.getState().root,
    headers: store.getState().headers,
    treeViewDeferred: false,
    deck: readyDeck(positions),
    setDeck,
    statistics: successStatistics(opponentE5Stats(store.getState().root)),
  });
  expect(setDeck).toHaveBeenCalledOnce();
  const next = setDeck.mock.calls[0][0](readyDeck(positions));
  expect(next.positions[0].weight).toBe(0.3);
});

test("nothing is written when no stored weight changed", async () => {
  const store = italianTree();
  const positions = buildFromTree(store.getState().root, "white", []).map((position) => ({
    ...position,
    weight: 0.3,
  }));
  const setDeck = vi.fn();
  await renderWeights({
    root: store.getState().root,
    headers: store.getState().headers,
    treeViewDeferred: false,
    deck: readyDeck(positions),
    setDeck,
    statistics: successStatistics(opponentE5Stats(store.getState().root)),
  });
  expect(setDeck).not.toHaveBeenCalled();
});

test("nothing is written when the deck is not ready", async () => {
  const store = italianTree();
  const positions = buildFromTree(store.getState().root, "white", []);
  const setDeck = vi.fn();
  await renderWeights({
    root: store.getState().root,
    headers: store.getState().headers,
    treeViewDeferred: false,
    deck: { ...readyDeck(positions), status: "loading" },
    setDeck,
    statistics: successStatistics(new Map()),
  });
  expect(setDeck).not.toHaveBeenCalled();
});

test("nothing is written when the tree view is deferred", async () => {
  const store = italianTree();
  const positions = buildFromTree(store.getState().root, "white", []);
  const setDeck = vi.fn();
  await renderWeights({
    root: store.getState().root,
    headers: store.getState().headers,
    treeViewDeferred: true,
    deck: readyDeck(positions),
    setDeck,
    statistics: successStatistics(new Map()),
  });
  expect(setDeck).not.toHaveBeenCalled();
});

test("nothing is written when the statistics read failed", async () => {
  const store = italianTree();
  const positions = buildFromTree(store.getState().root, "white", []);
  const setDeck = vi.fn();
  const statistics = successStatistics(new Map());
  statistics.statisticsStatus = "error";
  statistics.statisticsResult = null;
  await renderWeights({
    root: store.getState().root,
    headers: store.getState().headers,
    treeViewDeferred: false,
    deck: readyDeck(positions),
    setDeck,
    statistics,
  });
  expect(setDeck).not.toHaveBeenCalled();
});

test("out-of-scope cards keep their stored weight", async () => {
  const store = italianTree();
  const [inScope] = buildFromTree(store.getState().root, "white", []);
  const outOfScope = {
    fen: defaultTree().root.fen,
    answer: "e4",
    card: createEmptyCard(),
    outOfScope: true as const,
    weight: 0.4,
  };
  const setDeck = vi.fn((update) =>
    typeof update === "function" ? update(readyDeck([inScope, outOfScope])) : update,
  );
  await renderWeights({
    root: store.getState().root,
    headers: store.getState().headers,
    treeViewDeferred: false,
    deck: readyDeck([inScope, outOfScope]),
    setDeck,
    statistics: successStatistics(opponentE5Stats(store.getState().root)),
  });
  const next = setDeck.mock.calls[0][0](readyDeck([inScope, outOfScope]));
  expect(next.positions[0].weight).toBe(0.3);
  expect(next.positions[1].weight).toBe(0.4);
  expect(next.positions[1].outOfScope).toBe(true);
});
