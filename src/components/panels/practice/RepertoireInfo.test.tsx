import { WorkspaceTabScope } from "@/state/tabScope";
import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";
import { act, useContext, useLayoutEffect } from "react";
import { useStore } from "zustand";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { TreeStateProvider } from "@/components/common/TreeStateContext";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { closeTreeStore, createTreeStore, type TreeStore } from "@/state/store/tree";
import { tabStorage } from "@/state/store/tabStorage";
import { activeTabAtom, coverageMinGamesAtom, referenceDbAtom, tabsAtom } from "@/state/atoms";
import { createNode, defaultTree, getBoardState, getNodeAtPath } from "@/utils/treeReducer";
import { parseUci } from "chessops";
import { installMatchMediaStub } from "@/tests/matchMedia";
import RepertoireInfo from "./RepertoireInfo";
import { startFileRevisionPoll } from "@/state/fileFreshness";

const mocks = vi.hoisted(() => ({
  computeTreeCoverage: vi.fn(),
  fetchPositionMoves: vi.fn(),
  searchPosition: vi.fn(),
  notificationShow: vi.fn(),
  playSound: vi.fn(),
  collection: vi.fn<typeof import("@/platform/tauri").tauri.collectionForDatabase>(
    async () => null,
  ),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/utils/db", () => ({ searchPosition: mocks.searchPosition }));
vi.mock("@/utils/sound", () => ({ playSound: mocks.playSound }));
vi.mock("@/platform/tauri", async (original) => {
  const actual = await original<typeof import("@/platform/tauri")>();
  return {
    ...actual,
    tauri: new Proxy(actual.tauri, {
      get(target, property, receiver) {
        return property === "collectionForDatabase"
          ? mocks.collection
          : Reflect.get(target, property, receiver);
      },
    }),
  };
});
vi.mock("@mantine/notifications", () => ({
  notifications: { show: mocks.notificationShow },
}));
vi.mock("@/utils/repertoire", async () => {
  const actual = await vi.importActual<typeof import("@/utils/repertoire")>("@/utils/repertoire");
  return {
    ...actual,
    computeTreeCoverage: mocks.computeTreeCoverage,
    fetchPositionMoves: mocks.fetchPositionMoves,
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, "ResizeObserver", {
  writable: true,
  value: ResizeObserverStub,
});

const database = { id: { id: "reference" }, kind: "database" as const };
const readyReference: import("@/bindings").CollectionDescriptor = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Reference",
  file: { id: { id: "source" }, kind: "fileWorkspace" },
  database,
  status: "ready",
  generation: "ready-generation",
  omitted: 0,
  account: null,
  retiredDatabase: null,
  fetchSinceMs: null,
};
const emptyCoverage = {
  coverageMap: new Map<string, number>(),
  gamesMap: new Map<string, number>(),
  missingGamesMap: new Map<string, number>(),
  dbMovesMap: new Map(),
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.collection.mockResolvedValue(null);
  localStorage.clear();
  sessionStorage.clear();
  mocks.fetchPositionMoves.mockResolvedValue({ moves: [], total: 0 });
  mocks.computeTreeCoverage.mockResolvedValue(emptyCoverage);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  sessionStorage.clear();
});

function CaptureStore({
  onStore,
  children,
}: {
  onStore?: (store: TreeStore) => void;
  children: React.ReactNode;
}) {
  const store = useContext(TreeStateContext)!;
  onStore?.(store);
  return children;
}

async function renderRepertoireInfo(
  initial = defaultTree(),
  id = "repertoire-info-test",
  onStore?: (store: TreeStore) => void,
  onCommit?: () => void,
) {
  const store = createStore();
  store.set(tabsAtom, [
    {
      name: "Repertoire",
      value: "tab",
      type: "analysis",
      gameOrigin: { kind: "none" },
    },
  ]);
  store.set(activeTabAtom, "tab");
  await act(async () => {
    root.render(
      <MantineProvider>
        <Provider store={store}>
          <TreeStateProvider id={id} initial={initial}>
            <CaptureStore onStore={onStore}>
              <WorkspaceTabScope tabId="tab">
                <RepertoireInfo />
                <CoverageCommitProbe onCommit={onCommit} />
              </WorkspaceTabScope>
            </CaptureStore>
          </TreeStateProvider>
        </Provider>
      </MantineProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => store.set(referenceDbAtom, database));
  return store;
}

function CoverageCommitProbe({ onCommit }: { onCommit?: () => void }) {
  const store = useContext(TreeStateContext)!;
  const tree = useStore(store, (state) => state.root);
  useLayoutEffect(() => onCommit?.(), [tree, onCommit]);
  return null;
}

async function realCoverageFixture() {
  const builder = createTreeStore();
  expect(builder.getState().makeMoves({ payload: ["e4", "e5", "Nf3"] }).success).toBe(true);
  builder.getState().goToStart();
  builder.getState().makeMove({ payload: "d4", changePosition: false });
  builder.getState().save();
  const initial = builder.getState();
  builder.dispose();

  const e4 = initial.root.children[0];
  const d4 = initial.root.children[1];
  const e5 = e4.children[0];
  const replies = new Map([
    [getBoardState(initial.root.fen), ["e4", "d4"]],
    [getBoardState(e4.fen), ["e5"]],
    [getBoardState(e5.fen), ["Nf3"]],
    [getBoardState(d4.fen), ["d5"]],
  ]);
  const pending: { signal: AbortSignal; release: () => void; reject: (error: Error) => void }[] =
    [];
  let hold = false;
  mocks.searchPosition.mockImplementation(
    async ({ fen }: { fen: string }, _operation: string, signal: AbortSignal) => {
      if (hold && fen === getBoardState(initial.root.fen)) {
        // Hold the real algorithm at its database boundary, including late obsolete replies.
        await new Promise<void>((release, reject) => pending.push({ signal, release, reject }));
      }
      return [(replies.get(fen) ?? []).map((move) => ({ move, white: 100, draw: 0, black: 0 }))];
    },
  );
  const actual = await vi.importActual<typeof import("@/utils/repertoire")>("@/utils/repertoire");
  mocks.computeTreeCoverage.mockImplementation(actual.computeTreeCoverage);
  return { initial, pending, hold: () => (hold = true) };
}

function moveRow(san: string) {
  const row = [...host.querySelectorAll("button")].find((button) =>
    [...button.querySelectorAll("p")].some((label) => label.textContent === `1. ${san}`),
  );
  expect(row).toBeDefined();
  return row!;
}

function renderedCoverage(san: string) {
  return moveRow(san)
    .querySelectorAll('[role="progressbar"]')
    .item(3)
    ?.getAttribute("aria-valuenow");
}

test.each(["Save", "autosave"])(
  "%s during actual promoted coverage preserves current paths and reaches terminal loading",
  async (saveKind) => {
    const fixture = await realCoverageFixture();
    let tree!: TreeStore;
    await renderRepertoireInfo(fixture.initial, `coverage-promote-${saveKind}`, (value) => {
      tree = value;
    });
    expect(tree.getState().dirty).toBe(false);
    expect(renderedCoverage("e4")).toBe("100");
    expect(renderedCoverage("d4")).toBe("3");
    expect(host.textContent).not.toContain("Board.Practice.Build.Loading");

    fixture.hold();
    await act(async () => tree.getState().promoteVariation([1]));
    expect(fixture.pending).toHaveLength(1);
    expect(tree.getState().root.children.map((node) => node.san)).toEqual(["d4", "e4"]);
    expect(tree.getState().dirty).toBe(true);
    expect(host.textContent).toContain("Board.Practice.Build.Loading");
    await act(async () => {
      // Both saveToFile routes finish through this store action. Autosave supplies the write stamp.
      tree.getState().save(saveKind === "autosave" ? "b".repeat(64) : undefined);
    });
    expect(tree.getState().dirty).toBe(false);
    await act(async () => {
      for (const request of fixture.pending) request.release();
    });

    // Coverage must follow the move's meaning at its newly derived path.
    expect(renderedCoverage("d4")).toBe("3");
    expect(renderedCoverage("e4")).toBe("100");
    expect(host.textContent).not.toContain("Board.Practice.Build.Loading");
    const result = await mocks.computeTreeCoverage.mock.results.at(-1)!.value;
    expect([...result.coverageMap.entries()]).toEqual(
      expect.arrayContaining([
        ["0", 0],
        ["1", 1],
        ["1,0", 1],
        ["1,0,0", 1],
      ]),
    );
    await act(async () => moveRow("e4").click());
    expect(tree.getState().position).toEqual([1]);
    expect(mocks.notificationShow).not.toHaveBeenCalled();
  },
);

test("unchanged coverage inputs preserve completed work across dirty, Save and navigation", async () => {
  const fixture = await realCoverageFixture();
  let tree!: TreeStore;
  tabStorage.seed("coverage-unchanged", fixture.initial);
  await renderRepertoireInfo(defaultTree(), "coverage-unchanged", (value) => {
    tree = value;
  });
  const originalRoot = tree.getState().root;
  expect(renderedCoverage("e4")).toBe("100");
  const computations = mocks.computeTreeCoverage.mock.calls.length;
  await act(async () => {
    tree.getState().setHeaders({ ...tree.getState().headers, event: "Metadata edit" });
  });
  expect(tree.getState().dirty).toBe(true);
  await act(async () => tree.getState().save());
  await act(async () => tree.getState().goToMove([0]));
  await act(async () => tree.getState().goToStart());
  expect(tree.getState().root).toBe(originalRoot);
  expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(computations);
  expect(renderedCoverage("e4")).toBe("100");
  expect(renderedCoverage("d4")).toBe("3");
  expect(host.textContent).not.toContain("Board.Practice.Build.Loading");
});

test("superseded actual tree computations cannot publish after a newer promotion", async () => {
  const fixture = await realCoverageFixture();
  let tree!: TreeStore;
  await renderRepertoireInfo(fixture.initial, "coverage-superseded", (value) => {
    tree = value;
  });
  fixture.hold();
  await act(async () => tree.getState().promoteVariation([1]));
  const obsolete = fixture.pending[0];
  await act(async () => tree.getState().promoteVariation([1]));
  expect(fixture.pending).toHaveLength(2);
  expect(obsolete.signal.aborted).toBe(true);
  await act(async () => tree.getState().save());
  await act(async () => obsolete.release());
  expect(host.textContent).toContain("Board.Practice.Build.Loading");
  expect(renderedCoverage("e4")).toBeUndefined();
  await act(async () => fixture.pending[1].release());
  expect(renderedCoverage("e4")).toBe("100");
  expect(renderedCoverage("d4")).toBe("3");
  expect(host.textContent).not.toContain("Board.Practice.Build.Loading");
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

test("reference loss cancels actual coverage and clean recovery recomputes current paths", async () => {
  const fixture = await realCoverageFixture();
  let tree!: TreeStore;
  const atoms = await renderRepertoireInfo(fixture.initial, "coverage-reference-loss", (value) => {
    tree = value;
  });
  fixture.hold();
  await act(async () => tree.getState().promoteVariation([1]));
  await act(async () => tree.getState().save());
  await act(async () => atoms.set(referenceDbAtom, null));
  expect(fixture.pending[0].signal.aborted).toBe(true);
  await act(async () => fixture.pending[0].release());
  expect(host.textContent).toContain("Board.Practice.Build.NoRefDb");
  await act(async () => atoms.set(referenceDbAtom, database));
  expect(fixture.pending).toHaveLength(2);
  await act(async () => fixture.pending[1].release());
  expect(renderedCoverage("d4")).toBe("3");
  expect(renderedCoverage("e4")).toBe("100");
  expect(host.textContent).not.toContain("Board.Practice.Build.Loading");
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});

test("a new linked generation supersedes actual clean coverage and settles only its own work", async () => {
  const fixture = await realCoverageFixture();
  const collection: import("@/bindings").CollectionDescriptor = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Reference",
    file: { id: { id: "source" }, kind: "fileWorkspace" },
    database,
    status: "ready",
    generation: "first",
    omitted: 0,
    account: null,
    retiredDatabase: null,
    fetchSinceMs: null,
  };
  mocks.collection.mockResolvedValue(collection);
  let focus!: () => void;
  const stop = startFileRevisionPoll({
    getTabs: () => [],
    fileRevision: vi.fn(),
    subscribeFocus: (callback) => {
      focus = callback;
      return () => undefined;
    },
  });
  try {
    let tree!: TreeStore;
    const atoms = await renderRepertoireInfo(
      fixture.initial,
      "coverage-clean-generation",
      (value) => {
        tree = value;
      },
    );
    expect(renderedCoverage("d4")).toBe("3");
    fixture.hold();
    await act(async () => atoms.set(coverageMinGamesAtom, 101));
    expect(fixture.pending).toHaveLength(1);
    const obsolete = fixture.pending[0];
    mocks.collection.mockResolvedValue({ ...collection, generation: "second" });
    await act(async () => focus());
    expect(fixture.pending).toHaveLength(2);
    expect(obsolete.signal.aborted).toBe(true);
    await act(async () => obsolete.release());
    expect(host.textContent).toContain("Board.Practice.Build.Loading");
    await act(async () => fixture.pending[1].release());
    expect(tree.getState().dirty).toBe(false);
    expect(host.textContent).not.toContain("Board.Practice.Build.Loading");
    const result = await mocks.computeTreeCoverage.mock.results.at(-1)!.value;
    expect(result.coverageMap.get("1")).toBe(1);
    expect(mocks.notificationShow).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});

test.each([
  {
    input: "orientation",
    orientation: "black",
    minGames: 50,
    startPath: [],
    paths: ["", "0", "0,0", "0,0,0", "1"],
    rootIncluded: true,
    d4Coverage: 0,
  },
  {
    input: "minGames",
    orientation: "white",
    minGames: 101,
    startPath: [],
    paths: ["", "0", "0,0", "0,0,0", "1"],
    rootIncluded: true,
    d4Coverage: 1,
  },
  {
    input: "startPath",
    orientation: "white",
    minGames: 50,
    startPath: [0],
    paths: ["0", "0,0", "0,0,0"],
    rootIncluded: false,
    d4Coverage: undefined,
  },
])("clean coverage recomputes after $input changes", async ({ input, ...expected }) => {
  const fixture = await realCoverageFixture();
  let tree!: TreeStore;
  const atoms = await renderRepertoireInfo(fixture.initial, `coverage-input-${input}`, (value) => {
    tree = value;
  });
  const computations = mocks.computeTreeCoverage.mock.calls.length;
  await act(async () => {
    if (input === "orientation") {
      tree.getState().setHeaders({ ...tree.getState().headers, orientation: "black" });
    } else if (input === "minGames") {
      atoms.set(coverageMinGamesAtom, 101);
    } else {
      tree.getState().setStart([0]);
    }
    tree.getState().save();
  });
  expect(tree.getState().dirty).toBe(false);
  expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(computations + 1);
  const args = mocks.computeTreeCoverage.mock.calls.at(-1)!;
  const result = await mocks.computeTreeCoverage.mock.results.at(-1)!.value;
  expect({
    orientation: args[1],
    minGames: args[3],
    startPath: args[4],
    paths: [...result.coverageMap.keys()],
    rootIncluded: args[5].has(getBoardState(fixture.initial.root.fen)),
    d4Coverage: result.coverageMap.get("1"),
  }).toEqual(expected);
  expect(host.textContent).not.toContain("Board.Practice.Build.Loading");
});

test("receives the complete memoized board-state map for transposed nodes", async () => {
  const initial = defaultTree();
  const first = createNode({
    fen: "same w - - 0 1",
    move: parseUci("e2e4")!,
    san: "e4",
    halfMoves: 1,
  });
  const second = createNode({
    fen: "same w - - 0 1",
    move: parseUci("d2d4")!,
    san: "d4",
    halfMoves: 1,
  });
  first.children = [
    createNode({
      fen: "after-e4 b - - 0 1",
      move: parseUci("e7e5")!,
      san: "e5",
      halfMoves: 2,
    }),
  ];
  second.children = [
    createNode({
      fen: "after-d4 b - - 0 1",
      move: parseUci("d7d5")!,
      san: "d5",
      halfMoves: 2,
    }),
  ];
  initial.root.children = [first, second];

  await renderRepertoireInfo(initial, "repertoire-info-transpositions");
  await vi.waitFor(() => expect(mocks.computeTreeCoverage).toHaveBeenCalled());

  const stateMoves = mocks.computeTreeCoverage.mock.calls.at(-1)![5] as Map<
    string,
    Map<string, string>
  >;
  expect(stateMoves.get(getBoardState(first.fen))).toEqual(
    new Map([
      ["e5", getBoardState(first.children[0].fen)],
      ["d5", getBoardState(second.children[0].fen)],
    ]),
  );
});

test.each(["KQkq e3", "HAha -"])(
  "a legal repetition finds the raw %s root's prepared repertoire answer",
  async (rightsAndEp) => {
    const id = crypto.randomUUID();
    onTestFinished(() => closeTreeStore(id));
    const fen = `rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b ${rightsAndEp} 0 1`;
    const builder = createTreeStore(undefined, defaultTree(fen));
    expect(
      builder.getState().makeMoves({ payload: ["g8f6", "g1f3", "f6g8", "f3g1"] }).success,
    ).toBe(true);
    const initial = builder.getState();
    let tree!: TreeStore;
    await renderRepertoireInfo(
      { ...initial, headers: { ...initial.headers, orientation: "black" } },
      id,
      (value) => {
        tree = value;
      },
    );
    const stateMoves = mocks.computeTreeCoverage.mock.calls.at(-1)![5] as Map<
      string,
      Map<string, string>
    >;
    expect(stateMoves.get(getBoardState(tree.getState().currentNode().fen))?.get("Nf6")).toBe(
      getBoardState(initial.root.children[0].fen),
    );
    const row = [...host.querySelectorAll("button")].find((button) =>
      [...button.querySelectorAll("p")].some((label) => label.textContent === "1... Nf6"),
    );
    expect(row).toBeDefined();
    await act(async () => row!.click());
    expect(tree.getState().position).toEqual([0]);
    expect(tree.getState().root.fen).toBe(fen);
    expect(tree.getState().headers.fen).toBe(fen);
  },
);

test("renders exact White and Black move labels", async () => {
  const initial = defaultTree();
  const whiteMove = createNode({
    fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    move: parseUci("e2e4")!,
    san: "e4",
    halfMoves: 1,
  });
  whiteMove.children = [
    createNode({
      fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
      move: parseUci("e7e5")!,
      san: "e5",
      halfMoves: 2,
    }),
  ];
  initial.root.children = [whiteMove];
  let store: TreeStore | undefined;
  await renderRepertoireInfo(initial, "repertoire-info-move-labels", (captured) => {
    store = captured;
  });

  const renderedLabels = () =>
    [...host.querySelectorAll("button p")].map((element) => element.textContent);
  expect(renderedLabels()).toContain("1. e4");

  await act(async () => store?.getState().goToMove([0]));
  expect(renderedLabels()).toContain("1... e5");
});

function retryButton() {
  const button = [...host.querySelectorAll("button")].find(
    (element) => element.textContent === "Common.Retry",
  );
  expect(button).toBeDefined();
  return button!;
}

function expectUnknownCoverage() {
  expect(host.textContent).not.toContain("Board.Practice.Build.NoGapsFound");
  expect(host.textContent).not.toContain("Board.Practice.Build.NextGap");
  expect(host.textContent).not.toContain("Board.Practice.Build.BiggestGap");
  for (const row of host.querySelectorAll("button")) {
    expect(row.querySelectorAll('[role="progressbar"]').length).toBeLessThanOrEqual(3);
  }
}

test("initial ready-reference cache reset can deliver the second native query failure to position statistics", async () => {
  const fixture = await realCoverageFixture();
  mocks.collection.mockResolvedValue(readyReference);
  const { commands } = await vi.importActual<{ commands: typeof import("@/bindings").commands }>(
    "@/bindings/generated",
  );
  const actualDb = await vi.importActual<typeof import("@/utils/db")>("@/utils/db");
  const actual = await vi.importActual<typeof import("@/utils/repertoire")>("@/utils/repertoire");
  let ticket = 0;
  const prepare = vi.spyOn(commands, "prepareNativeRead").mockImplementation(async () => ({
    status: "ok",
    data: `coverage-initial-${++ticket}`,
  }));
  const cancel = vi
    .spyOn(commands, "cancelNativeRead")
    .mockResolvedValue({ status: "ok", data: null });
  const stats = (
    move: string,
  ): [import("@/bindings").PositionStats[], import("@/bindings").NormalizedGame[]] => [
    [{ move, white: 100, draw: 0, black: 0, unknown: 0 }],
    [],
  ];
  const query = vi
    .spyOn(commands, "searchPosition")
    .mockResolvedValueOnce({ status: "ok", data: stats("e4") })
    .mockResolvedValueOnce({
      status: "error",
      error: {
        tag: "backend-error",
        category: "database",
        message: "Repertoire coverage query failed",
      },
    })
    .mockResolvedValueOnce({ status: "ok", data: stats("e4") })
    .mockResolvedValueOnce({ status: "ok", data: stats("c5") })
    .mockResolvedValue({ status: "ok", data: [[], []] });
  onTestFinished(() => {
    prepare.mockRestore();
    cancel.mockRestore();
    query.mockRestore();
  });
  mocks.searchPosition.mockImplementation(actualDb.searchPosition);
  mocks.fetchPositionMoves.mockImplementation(actual.fetchPositionMoves);
  mocks.computeTreeCoverage.mockImplementation(actual.computeTreeCoverage);
  let tree!: TreeStore;
  await renderRepertoireInfo(fixture.initial, "coverage-initial-native-order", (value) => {
    tree = value;
  });
  expect(mocks.computeTreeCoverage).toHaveBeenCalledOnce();
  expect(mocks.fetchPositionMoves).toHaveBeenCalledTimes(2);
  expect(cancel).toHaveBeenCalledWith("coverage-initial-1");
  expect(query.mock.calls.map((args) => args[3])).toEqual([
    "coverage-initial-2",
    "coverage-initial-3",
    "coverage-initial-4",
    "coverage-initial-5",
    "coverage-initial-6",
    "coverage-initial-7",
  ]);
  const result = await mocks.computeTreeCoverage.mock.results[0].value;
  expect(result.coverageMap.size).toBeGreaterThan(0);
  expect(host.textContent).not.toContain("Common.Retry");
  expect(host.textContent).toContain("Board.Practice.Build.BiggestGap");
  expect(mocks.notificationShow).toHaveBeenCalledExactlyOnceWith({
    title: "Common.Error",
    message: "Repertoire coverage query failed",
    color: "danger",
  });

  // Once metadata and the independent cache are ready, the same-FEN ordinary edit owns
  // one new coverage request. Its failure stays current until the explicit Retry.
  query.mockResolvedValueOnce({
    status: "error",
    error: { tag: "backend-error", category: "database", message: "Stable edited coverage failed" },
  });
  await act(async () => tree.getState().setAnnotation("!"));
  expect(tree.getState()).toMatchObject({ dirty: true, root: { nags: [1] } });
  expect(query).toHaveBeenCalledTimes(7);
  expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(2);
  expect(mocks.fetchPositionMoves).toHaveBeenCalledTimes(2);
  expectUnknownCoverage();
  await act(async () => tree.getState().save());
  expect(query).toHaveBeenCalledTimes(7);
  expect(retryButton().disabled).toBe(false);
  await act(async () => retryButton().click());
  expect(query).toHaveBeenCalledTimes(12);
  expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(3);
  expect(mocks.fetchPositionMoves).toHaveBeenCalledTimes(2);
  expect(host.textContent).not.toContain("Common.Retry");
  expect(host.textContent).toContain("Board.Practice.Build.NoGapsFound");
  expect(mocks.notificationShow).toHaveBeenCalledTimes(2);
});

test.each(["success", "error"] as const)(
  "fresh native metadata with equivalent capabilities preserves failed coverage until Retry, stale %s stays retired",
  async (staleOutcome) => {
    const fixture = await realCoverageFixture();
    const actual = await vi.importActual<typeof import("@/utils/repertoire")>("@/utils/repertoire");
    const actualDb = await vi.importActual<typeof import("@/utils/db")>("@/utils/db");
    const actualPlatform =
      await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
    const { commands } = await vi.importActual<{ commands: typeof import("@/bindings").commands }>(
      "@/bindings/generated",
    );
    let metadata = readyReference;
    const decoded: import("@/bindings").CollectionDescriptor[] = [];
    let ticket = 0;
    const prepare = vi.spyOn(commands, "prepareNativeRead").mockImplementation(async () => ({
      status: "ok",
      data: `metadata-coverage-${++ticket}`,
    }));
    const cancel = vi
      .spyOn(commands, "cancelNativeRead")
      .mockResolvedValue({ status: "ok", data: null });
    const read = vi.spyOn(commands, "collectionForDatabase").mockImplementation(async () => {
      // Model native IPC decoding, not the browser fixture's shared object reference.
      const value = structuredClone(metadata);
      decoded.push(value);
      return { status: "ok", data: value };
    });
    const e4 = fixture.initial.root.children[0];
    const replies = new Map([
      [getBoardState(fixture.initial.root.fen), ["e4", "d4"]],
      [getBoardState(e4.fen), ["e5"]],
      [getBoardState(e4.children[0].fen), ["Nf3"]],
      [getBoardState(fixture.initial.root.children[1].fen), ["d5"]],
    ]);
    const query = vi
      .spyOn(commands, "searchPosition")
      .mockImplementation(async (_file, request) => ({
        status: "ok",
        data: [
          (replies.get(request.position?.fen ?? "") ?? []).map((move) => ({
            move,
            white: 100,
            draw: 0,
            black: 0,
            unknown: 0,
          })),
          [],
        ],
      }));
    mocks.collection.mockImplementation(actualPlatform.tauri.collectionForDatabase);
    mocks.searchPosition.mockImplementation(actualDb.searchPosition);
    mocks.fetchPositionMoves.mockImplementation(actual.fetchPositionMoves);
    mocks.computeTreeCoverage.mockImplementation(actual.computeTreeCoverage);
    vi.useFakeTimers();
    let focus!: () => void;
    const stop = startFileRevisionPoll({
      getTabs: () => [],
      fileRevision: vi.fn(),
      subscribeFocus: (callback) => {
        focus = callback;
        return () => undefined;
      },
    });
    onTestFinished(() => {
      stop();
      prepare.mockRestore();
      cancel.mockRestore();
      read.mockRestore();
      query.mockRestore();
      vi.useRealTimers();
    });
    let tree!: TreeStore;
    const atoms = await renderRepertoireInfo(
      fixture.initial,
      `coverage-native-metadata-${staleOutcome}`,
      (value) => {
        tree = value;
      },
    );
    expect(read).toHaveBeenCalledOnce();
    expect(mocks.computeTreeCoverage).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledTimes(6);
    expect(renderedCoverage("e4")).toBe("100");

    query.mockResolvedValueOnce({
      status: "error",
      error: {
        tag: "backend-error",
        category: "database",
        message: "Current edited coverage failed",
      },
    });
    await act(async () => tree.getState().setAnnotation("!"));
    expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(7);
    expectUnknownCoverage();
    expect(retryButton().disabled).toBe(false);
    expect(moveRow("e4").textContent).toContain("100");
    expect(mocks.notificationShow).toHaveBeenCalledTimes(1);
    const positionReads = mocks.fetchPositionMoves.mock.calls.length;
    for (const count of [2, 3]) {
      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      expect(read).toHaveBeenCalledTimes(count);
      expect(decoded.at(-1)).not.toBe(decoded.at(-2));
      expect(decoded.at(-1)?.database).not.toBe(decoded.at(-2)?.database);
      expect(decoded.at(-1)?.database).toEqual(database);
      expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(2);
      expect(query).toHaveBeenCalledTimes(7);
      expect(mocks.fetchPositionMoves).toHaveBeenCalledTimes(positionReads);
      expect(mocks.notificationShow).toHaveBeenCalledTimes(1);
      expectUnknownCoverage();
      expect(retryButton().disabled).toBe(false);
      expect(moveRow("e4").textContent).toContain("100");
    }
    await act(async () => atoms.set(referenceDbAtom, structuredClone(database)));
    expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(7);
    await act(async () => retryButton().click());
    expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenCalledTimes(12);
    expect(renderedCoverage("e4")).toBe("100");
    expect(mocks.fetchPositionMoves).toHaveBeenCalledTimes(positionReads);

    // A real capability replacement must retire the cache even with unchanged generation.
    const held = Promise.withResolvers<Awaited<ReturnType<typeof commands.searchPosition>>>();
    query.mockReturnValueOnce(held.promise);
    metadata = { ...metadata, database: { id: { id: "replacement-reference" }, kind: "database" } };
    await act(async () => focus());
    expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(4);
    const obsolete = mocks.computeTreeCoverage.mock.calls.at(-1)![6] as AbortSignal;
    expect(obsolete.aborted).toBe(false);
    expect(mocks.fetchPositionMoves).toHaveBeenCalledTimes(positionReads + 1);
    expect(query.mock.calls.at(-1)![0]).toEqual(metadata.database);
    expectUnknownCoverage();
    metadata = { ...metadata, generation: "next-generation" };
    await act(async () => focus());
    expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(5);
    expect(obsolete.aborted).toBe(true);
    expect(renderedCoverage("e4")).toBe("100");
    const currentQueries = query.mock.calls.length;
    await act(async () =>
      held.resolve(
        staleOutcome === "success"
          ? { status: "ok", data: [[], []] }
          : {
              status: "error",
              error: {
                tag: "backend-error",
                category: "database",
                message: "Obsolete native error",
              },
            },
      ),
    );
    expect(query).toHaveBeenCalledTimes(currentQueries);
    expect(mocks.notificationShow).toHaveBeenCalledTimes(1);
    expect(renderedCoverage("e4")).toBe("100");

    metadata = { ...metadata, status: "unavailable" };
    await act(async () => focus());
    expect(host.textContent).toContain("Collections.Unavailable");
    expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(5);
    metadata = { ...metadata, status: "ready" };
    await act(async () => focus());
    expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(6);
    expect(renderedCoverage("e4")).toBe("100");
    expect(mocks.notificationShow).toHaveBeenCalledTimes(1);
  },
);

test.each([
  { empty: false, orientation: "white" as const },
  { empty: false, orientation: "black" as const },
  { empty: true, orientation: "white" as const },
  { empty: true, orientation: "black" as const },
])(
  "current search failure is unknown and explicit Retry recovers, empty=$empty orientation=$orientation",
  async ({ empty, orientation }) => {
    const fixture = await realCoverageFixture();
    mocks.collection.mockResolvedValue(readyReference);
    const initial = empty
      ? defaultTree()
      : { ...fixture.initial, headers: { ...fixture.initial.headers } };
    initial.headers.orientation = orientation;
    let tree!: TreeStore;
    await renderRepertoireInfo(initial, `coverage-failure-${empty}-${orientation}`, (value) => {
      tree = value;
    });
    expect(host.textContent?.includes("Board.Practice.Build.BiggestGap")).toBe(
      !empty && orientation === "black",
    );
    const before = mocks.computeTreeCoverage.mock.calls.length;
    const failure = new Error("Current coverage search refused");
    mocks.searchPosition.mockRejectedValueOnce(failure);
    await act(async () => tree.getState().setComment("Ordinary edited repertoire"));
    expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(before + 1);
    expect(mocks.notificationShow).toHaveBeenCalledExactlyOnceWith({
      title: "Common.Error",
      message: failure.message,
      color: "danger",
    });
    expect(host.textContent).not.toContain("Collections.Unavailable");
    expect(host.textContent).toContain("Common.Error");
    expectUnknownCoverage();
    expect(host.textContent).not.toContain("Board.Practice.Build.Loading");
    expect(host.textContent).toContain("1. e4");
    const queriesAfterFailure = mocks.searchPosition.mock.calls.length;
    await act(async () => {
      tree.getState().save();
      await Promise.resolve();
    });
    expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(before + 1);
    expect(mocks.searchPosition).toHaveBeenCalledTimes(queriesAfterFailure);
    await act(async () => retryButton().click());
    expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(before + 2);
    expect(host.textContent).not.toContain("Common.Retry");
    expect(host.textContent).not.toContain("Board.Practice.Build.Loading");
    const result = await mocks.computeTreeCoverage.mock.results.at(-1)!.value;
    expect(result.coverageMap.size).toBeGreaterThan(0);
    expect(mocks.notificationShow).toHaveBeenCalledTimes(1);
  },
);

test.each(["white", "black"] as const)(
  "empty MovesView feedback permits explicit Retry for %s without inventing completeness",
  async (orientation) => {
    await realCoverageFixture();
    mocks.collection.mockResolvedValue(readyReference);
    mocks.searchPosition.mockResolvedValue([[], []]);
    const initial = defaultTree();
    initial.headers.orientation = orientation;
    let tree!: TreeStore;
    await renderRepertoireInfo(initial, `coverage-no-position-moves-${orientation}`, (value) => {
      tree = value;
    });
    expect(host.textContent).toContain("Board.Practice.Build.NoMovesFound");
    mocks.searchPosition.mockRejectedValueOnce(new Error("Empty coverage search failed"));
    await act(async () => tree.getState().setComment("Empty repertoire edit"));
    expectUnknownCoverage();
    expect(host.textContent).toContain("Board.Practice.Build.NoMovesFound");
    expect(retryButton().disabled).toBe(false);
    const attempts = mocks.searchPosition.mock.calls.length;
    await act(async () => tree.getState().save());
    expect(mocks.searchPosition).toHaveBeenCalledTimes(attempts);
    await act(async () => retryButton().click());
    expect(mocks.searchPosition).toHaveBeenCalledTimes(attempts + 1);
    expect(host.textContent).toContain("Board.Practice.Build.NoMovesFound");
    expect(host.textContent).not.toContain("Common.Retry");
    expect(host.textContent).not.toContain("Board.Practice.Build.Loading");
    expect(host.textContent).not.toContain("Board.Practice.Build.NoGapsFound");
  },
);

test("coverage failure after an ordinary edit cannot claim completeness and Retry restores real success", async () => {
  const fixture = await realCoverageFixture();
  mocks.collection.mockResolvedValue(readyReference);
  let tree!: TreeStore;
  await renderRepertoireInfo(fixture.initial, "coverage-completeness-recovery", (value) => {
    tree = value;
  });
  expect(host.textContent).toContain("Board.Practice.Build.NoGapsFound");
  mocks.searchPosition.mockRejectedValueOnce(new Error("Edited search failed"));
  await act(async () => tree.getState().deleteMove([1]));
  expectUnknownCoverage();
  expect(renderedCoverage("e4")).toBeUndefined();
  expect(moveRow("e4").textContent).toContain("100");
  expect(retryButton().disabled).toBe(false);
  await act(async () => retryButton().click());
  expect(renderedCoverage("e4")).toBe("100");
  expect(host.textContent).toContain("Board.Practice.Build.NoGapsFound");
  expect(host.textContent).not.toContain("Common.Retry");
});

test("old coverage success is ineligible in the commit before the next effect", async () => {
  const fixture = await realCoverageFixture();
  let tree!: TreeStore;
  const committedCoverage: (string | undefined | null)[] = [];
  await renderRepertoireInfo(
    fixture.initial,
    "coverage-before-passive-effect",
    (value) => {
      tree = value;
    },
    () => {
      const row = [...host.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("1. e4"),
      );
      committedCoverage.push(
        row?.querySelectorAll('[role="progressbar"]').item(3)?.getAttribute("aria-valuenow"),
      );
    },
  );
  expect(renderedCoverage("e4")).toBe("100");
  fixture.hold();
  await act(async () => tree.getState().promoteVariation([1]));
  expect(committedCoverage.at(-1)).toBeUndefined();
  expectUnknownCoverage();
  await act(async () => fixture.pending[0].release());
  expect(renderedCoverage("e4")).toBe("100");
});

test.each(["success", "error"] as const)(
  "stale %s cannot publish or notify over a newer explicit Retry",
  async (staleOutcome) => {
    const fixture = await realCoverageFixture();
    let tree!: TreeStore;
    await renderRepertoireInfo(fixture.initial, `coverage-stale-${staleOutcome}`, (value) => {
      tree = value;
    });
    const actual = await vi.importActual<typeof import("@/utils/repertoire")>("@/utils/repertoire");
    let releaseOld!: () => void;
    let oldSignal!: AbortSignal;
    mocks.computeTreeCoverage.mockImplementationOnce(
      async (...args: Parameters<typeof actual.computeTreeCoverage>) => {
        oldSignal = args[6]!;
        const result = await actual.computeTreeCoverage(...args);
        return new Promise((resolve, reject) => {
          releaseOld = () =>
            staleOutcome === "success"
              ? resolve(result)
              : reject(new Error("Obsolete coverage failure"));
        });
      },
    );
    await act(async () => tree.getState().setComment("Earlier edit"));
    expect(releaseOld).toBeTypeOf("function");
    mocks.searchPosition.mockRejectedValueOnce(new Error("Current retryable coverage failure"));
    await act(async () => tree.getState().setComment("Current edit"));
    expect(oldSignal.aborted).toBe(true);
    expectUnknownCoverage();
    fixture.hold();
    await act(async () => retryButton().click());
    expect(fixture.pending).toHaveLength(1);
    await act(async () => releaseOld());
    expectUnknownCoverage();
    expect(host.textContent).toContain("Board.Practice.Build.Loading");
    expect(mocks.notificationShow).toHaveBeenCalledTimes(1);
    await act(async () => fixture.pending[0].release());
    expect(renderedCoverage("e4")).toBe("100");
    expect(host.textContent).toContain("Board.Practice.Build.NoGapsFound");
    expect(host.textContent).not.toContain("Board.Practice.Build.Loading");
    expect(mocks.notificationShow).toHaveBeenCalledTimes(1);
  },
);

test("a canceled Retry cannot replace or notify over a successful newer tree", async () => {
  const fixture = await realCoverageFixture();
  let tree!: TreeStore;
  await renderRepertoireInfo(fixture.initial, "coverage-canceled-retry", (value) => {
    tree = value;
  });
  mocks.searchPosition.mockRejectedValueOnce(new Error("Retryable coverage error"));
  await act(async () => tree.getState().setComment("Current coverage edit"));
  fixture.hold();
  await act(async () => retryButton().click());
  const retry = fixture.pending[0];
  await act(async () => tree.getState().promoteVariation([1]));
  expect(retry.signal.aborted).toBe(true);
  expect(fixture.pending).toHaveLength(2);
  await act(async () => fixture.pending[1].release());
  expect(renderedCoverage("e4")).toBe("100");
  expect(renderedCoverage("d4")).toBe("3");
  await act(async () => retry.reject(new Error("Canceled Retry failure")));
  expect(renderedCoverage("e4")).toBe("100");
  expect(renderedCoverage("d4")).toBe("3");
  expect(host.textContent).not.toContain("Common.Retry");
  expect(host.textContent).not.toContain("Board.Practice.Build.Loading");
  expect(mocks.notificationShow).toHaveBeenCalledTimes(1);
});

test("a refused Italian preset preserves the reported black-to-move tree and all user state", async () => {
  const initial = defaultTree("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");
  let tree!: TreeStore;
  await renderRepertoireInfo(initial, "preset-refused-custom-root", (value) => {
    tree = value;
  });
  const before = tree.getState();
  const preset = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Italian Game",
  )!;
  expect(preset).toBeDefined();
  mocks.playSound.mockClear();
  await act(async () => preset.click());
  expect(tree.getState()).toBe(before);
  expect(tree.getState().headers.start).toBeUndefined();
  expect(tree.getState().root.children).toEqual([]);
  expect(mocks.playSound).not.toHaveBeenCalled();
  expect(mocks.notificationShow).toHaveBeenCalledExactlyOnceWith({
    title: "Common.Error",
    message: expect.stringContaining("(1)"),
    color: "danger",
  });
  expect(host.textContent).not.toContain("Board.Practice.Build.GoToStart");
});

test.each([
  {
    name: "standard-white",
    fen: undefined,
    orientation: "white" as const,
    preset: "Italian Game",
    length: 5,
    final: "Bc4",
  },
  {
    name: "standard-black",
    fen: undefined,
    orientation: "black" as const,
    preset: "French Defense",
    length: 4,
    final: "d5",
  },
  {
    name: "custom-white",
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 7 4",
    orientation: "white" as const,
    preset: "Italian Game",
    length: 5,
    final: "Bc4",
  },
])(
  "legal $name preset installs its actual resulting cursor as start",
  async ({ name, fen, orientation, preset, length, final }) => {
    const initial = defaultTree(fen);
    initial.headers.orientation = orientation;
    let tree!: TreeStore;
    await renderRepertoireInfo(initial, `preset-legal-${name}`, (value) => {
      tree = value;
    });
    const button = [...host.querySelectorAll("button")].find(
      (element) => element.textContent === preset,
    )!;
    expect(button).toBeDefined();
    mocks.playSound.mockClear();
    await act(async () => button.click());
    const state = tree.getState();
    expect(state.position).toHaveLength(length);
    expect(state.headers.start).toBe(state.position);
    expect(state.currentNode().san).toBe(final);
    expect(state.root.fen).toBe(initial.root.fen);
    expect(state.dirty).toBe(true);
    expect(mocks.playSound).toHaveBeenCalledTimes(1);
    expect(mocks.notificationShow).not.toHaveBeenCalled();
  },
);

test("reports the current-position query failure", async () => {
  mocks.fetchPositionMoves.mockRejectedValue(new Error("position query failed"));
  await renderRepertoireInfo();
  await vi.waitFor(() =>
    expect(mocks.notificationShow).toHaveBeenCalledWith({
      title: "Common.Error",
      message: "position query failed",
      color: "danger",
    }),
  );
});

test("reports the current coverage query failure", async () => {
  let rejectCoverage!: (error: unknown) => void;
  let coverageSignal!: AbortSignal;
  mocks.computeTreeCoverage.mockImplementation((...args: unknown[]) => {
    coverageSignal = args[6] as AbortSignal;
    return new Promise((_resolve, reject) => (rejectCoverage = reject));
  });
  await renderRepertoireInfo();
  await vi.waitFor(() => expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(1));
  expect(coverageSignal.aborted).toBe(false);
  await act(async () => rejectCoverage(new Error("coverage query failed")));
  await vi.waitFor(() =>
    expect(mocks.notificationShow).toHaveBeenCalledWith({
      title: "Common.Error",
      message: "coverage query failed",
      color: "danger",
    }),
  );
});

test("coverage completion leaves dirty edits dirty", async () => {
  const initial = defaultTree();
  initial.dirty = true;
  initial.headers.event = "Unsaved user edit";
  let store: TreeStore | undefined;
  await renderRepertoireInfo(initial, "coverage-dirty-stays", (captured) => {
    store = captured;
  });
  await vi.waitFor(() => expect(mocks.computeTreeCoverage).toHaveBeenCalledOnce());
  await act(async () => Promise.resolve());

  expect(store?.getState()).toMatchObject({ dirty: true, headers: { event: "Unsaved user edit" } });
});

test("linked reference changes cancel earlier coverage while preserving the live dirty repertoire", async () => {
  const collection: import("@/bindings").CollectionDescriptor = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Reference",
    file: { id: { id: "source" }, kind: "fileWorkspace" },
    database,
    status: "ready",
    generation: "first",
    omitted: 0,
    account: null,
    retiredDatabase: null,
    fetchSinceMs: null,
  };
  mocks.collection.mockResolvedValue(collection);
  const requests: { signal: AbortSignal; resolve: (value: typeof emptyCoverage) => void }[] = [];
  mocks.computeTreeCoverage.mockImplementation(
    (...args: unknown[]) =>
      new Promise((resolve) => requests.push({ signal: args[6] as AbortSignal, resolve })),
  );
  let focus!: () => void;
  const stop = startFileRevisionPoll({
    getTabs: () => [],
    fileRevision: vi.fn(),
    subscribeFocus: (callback) => {
      focus = callback;
      return () => undefined;
    },
  });
  try {
    const initial = defaultTree();
    initial.dirty = true;
    initial.headers.event = "Live repertoire edits";
    let tree!: TreeStore;
    await renderRepertoireInfo(initial, "linked-coverage-generation", (value) => {
      tree = value;
    });
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    const old = requests.at(-1)!;
    expect(old.signal.aborted).toBe(false);
    mocks.collection.mockResolvedValue({ ...collection, generation: "second" });
    await act(async () => {
      focus();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(old.signal.aborted).toBe(true);
    await act(async () => {
      for (const request of requests) request.resolve(emptyCoverage);
    });
    expect(tree.getState()).toMatchObject({
      dirty: true,
      headers: { event: "Live repertoire edits" },
    });
    expect(mocks.notificationShow).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});

test("an unchecked or failed selected reference is unavailable and recovers through the shared focus check without losing dirty edits", async () => {
  let rejectCheck!: (error: unknown) => void;
  mocks.collection.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      rejectCheck = reject;
    }),
  );
  const initial = defaultTree();
  initial.dirty = true;
  initial.headers.event = "Live unavailable repertoire";
  let tree!: TreeStore;
  let focus!: () => void;
  const stop = startFileRevisionPoll({
    getTabs: () => [],
    fileRevision: vi.fn(),
    subscribeFocus: (callback) => {
      focus = callback;
      return () => undefined;
    },
  });
  try {
    await renderRepertoireInfo(initial, "unavailable-reference", (value) => {
      tree = value;
    });
    // Unverified references must not dispatch coverage.
    expect(mocks.computeTreeCoverage).not.toHaveBeenCalled();
    expect(mocks.fetchPositionMoves).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Collections.Unavailable");
    expect(host.textContent).not.toContain("Board.Practice.Build.NoRefDb");
    await act(async () => rejectCheck(new Error("reference currency failed")));
    expect(host.textContent).toContain("Collections.Unavailable");
    expect(mocks.notificationShow).toHaveBeenCalledWith({
      title: "Common.Error",
      message: "reference currency failed",
      color: "danger",
    });
    mocks.collection.mockResolvedValue(null);
    await act(async () => focus());
    expect(host.textContent).not.toContain("Collections.Unavailable");
    expect(mocks.computeTreeCoverage).toHaveBeenCalledOnce();
    expect(tree.getState()).toMatchObject({
      dirty: true,
      headers: { event: "Live unavailable repertoire" },
    });
  } finally {
    stop();
  }
});

test.each(["missing", "preservedOriginal"] as const)(
  "a selected %s reference reports unavailable rather than asking for a new selection",
  async (status) => {
    mocks.collection.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      name: "Reference",
      file: { id: { id: "source" }, kind: "fileWorkspace" },
      database,
      status,
      generation: "first",
      omitted: 0,
      account: null,
      retiredDatabase: null,
      fetchSinceMs: null,
    });
    await renderRepertoireInfo();
    expect(host.textContent).toContain("Collections.Unavailable");
    expect(host.textContent).not.toContain("Board.Practice.Build.NoRefDb");
    expect(mocks.computeTreeCoverage).not.toHaveBeenCalled();
  },
);

test("shared teardown clears the debounce scheduled by repertoire edits", async () => {
  let store: TreeStore | undefined;
  await renderRepertoireInfo(defaultTree(), "repertoire-teardown", (captured) => {
    store = captured;
  });
  const schedule = vi.spyOn(globalThis, "setTimeout");
  const clear = vi.spyOn(globalThis, "clearTimeout");
  await act(async () => {
    store!.getState().setHeaders({ ...store!.getState().headers, event: "Edited repertoire" });
  });
  const index = schedule.mock.calls.findLastIndex(([, delay]) => delay === 300);
  expect(index).toBeGreaterThanOrEqual(0);
  const timer = schedule.mock.results[index].value;
  expect(tabStorage.pendingCount()).toBeGreaterThan(0);
  onTestFinished(() => {
    try {
      expect(clear).toHaveBeenCalledWith(timer);
      expect(tabStorage.pendingCount()).toBe(0);
    } finally {
      schedule.mockRestore();
      clear.mockRestore();
    }
  });
});

test.each([100, 9])(
  "successful Italian marked-start coverage admits completeness only for covered significant games, games=%s",
  async (games) => {
    const actual = await vi.importActual<typeof import("@/utils/repertoire")>("@/utils/repertoire");
    const builder = createTreeStore();
    expect(
      builder.getState().makeMoves({ payload: ["e4", "e5", "Nf3", "Nc6", "Bc4"] }).success,
    ).toBe(true);
    const startFen = getBoardState(builder.getState().currentNode().fen);
    builder.dispose();
    mocks.computeTreeCoverage.mockImplementation(actual.computeTreeCoverage);
    mocks.fetchPositionMoves.mockImplementation(actual.fetchPositionMoves);
    mocks.searchPosition.mockImplementation(async ({ fen }: { fen: string }) => [
      fen === startFen ? [{ move: "Bc5", white: games, draw: 0, black: 0 }] : [],
      [],
    ]);
    let tree!: TreeStore;
    const atoms = await renderRepertoireInfo(defaultTree(), `italian-start-${games}`, (value) => {
      tree = value;
    });
    await act(async () => atoms.set(coverageMinGamesAtom, 10));
    const preset = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Italian Game",
    )!;
    await act(async () => preset.click());
    const state = tree.getState();
    const start = state.headers.start!;
    expect(state.currentNode().san).toBe("Bc4");
    expect(state.position).toEqual(start);
    const result = await mocks.computeTreeCoverage.mock.results.at(-1)!.value;
    expect(result.coverageMap.get(start.join(","))).toBe(games >= 10 ? 0 : 1);
    expect(result.missingGamesMap.get(start.join(","))).toBe(games >= 10 ? games : 0);
    expect(result.gamesMap.get(start.join(","))).toBe(games);
    expect(
      actual.findNextGap(state.root, start, "white", result.coverageMap, result.gamesMap, 10),
    ).toBeNull();
    expect(
      actual.findBiggestGap(
        state.root,
        "white",
        result.coverageMap,
        result.gamesMap,
        result.missingGamesMap,
        10,
        start,
      ),
    ).toBeNull();
    expect(host.textContent).toContain("3... Bc5");
    expect(host.textContent?.includes("Board.Practice.Build.NoGapsFound")).toBe(games < 10);
    expect(host.textContent).not.toContain("Common.Retry");
    expect(host.textContent).not.toContain("Board.Practice.Build.Loading");
    expect(host.textContent).not.toContain("Board.Practice.Build.NextGap");
    expect(host.textContent).not.toContain("Board.Practice.Build.BiggestGap");
    const computations = mocks.computeTreeCoverage.mock.calls.length;
    await act(async () => tree.getState().save());
    expect(mocks.computeTreeCoverage).toHaveBeenCalledTimes(computations);
    expect(host.textContent?.includes("Board.Practice.Build.NoGapsFound")).toBe(games < 10);
  },
);

test("ten fully covered fractional continuations admit healthy completeness and a real missing branch removes it", async () => {
  const actual = await vi.importActual<typeof import("@/utils/repertoire")>("@/utils/repertoire");
  const builder = createTreeStore();
  expect(builder.getState().makeMoves({ payload: ["e4", "e5", "Nf3", "Nc6", "Bc4"] }).success).toBe(
    true,
  );
  const start = builder.getState().position;
  builder.getState().setStart(start);
  const replies = ["Bc5", "Be7", "Nf6", "d6", "a6", "h6", "d5", "f5", "g6", "b6"];
  for (const san of replies) {
    builder.getState().goToMove(start);
    expect(builder.getState().makeMoves({ payload: [san, "d3"] }).success).toBe(true);
  }
  builder.getState().goToMove(start);
  builder.getState().save();
  const initial = builder.getState();
  const startNode = getNodeAtPath(initial.root, start);
  const continuations = new Set(startNode.children.map((node) => getBoardState(node.fen)));
  mocks.searchPosition.mockImplementation(async ({ fen }: { fen: string }) => [
    (fen === getBoardState(startNode.fen) ? replies : continuations.has(fen) ? ["d3"] : []).map(
      (move) => ({ move, white: 10, draw: 0, black: 0 }),
    ),
    [],
  ]);
  mocks.computeTreeCoverage.mockImplementation(actual.computeTreeCoverage);
  mocks.fetchPositionMoves.mockImplementation(actual.fetchPositionMoves);
  let tree!: TreeStore;
  const atoms = await renderRepertoireInfo(initial, "fractional-complete-start", (value) => {
    tree = value;
  });
  builder.dispose();
  await act(async () => atoms.set(coverageMinGamesAtom, 10));
  expect(host.textContent).toContain("Board.Practice.Build.NoGapsFound");
  let result = await mocks.computeTreeCoverage.mock.results.at(-1)!.value;
  expect(result.coverageMap.get(start.join(","))).toBe(1);
  expect(result.missingGamesMap.get(start.join(","))).toBe(0);
  await act(async () => tree.getState().deleteMove([...start, 9]));
  result = await mocks.computeTreeCoverage.mock.results.at(-1)!.value;
  expect(result.coverageMap.get(start.join(","))).toBeLessThan(1);
  expect(result.missingGamesMap.get(start.join(","))).toBe(10);
  expect(host.textContent).not.toContain("Board.Practice.Build.NoGapsFound");
  expect(host.textContent).not.toContain("Common.Retry");
  await act(async () => {
    tree.getState().goToMove(start);
    expect(tree.getState().makeMoves({ payload: ["b6", "d3"] }).success).toBe(true);
    tree.getState().goToMove(start);
  });
  expect(host.textContent).toContain("Board.Practice.Build.NoGapsFound");
  expect(mocks.notificationShow).not.toHaveBeenCalled();
});
