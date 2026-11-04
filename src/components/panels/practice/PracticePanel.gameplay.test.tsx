import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { buildFromTree, updateCardPerformance } from "@/components/files/opening";
import {
  activeTabAtom,
  autoSaveAtom,
  deckAtomFamily,
  practiceMoveControllerFamily,
  practiceStateFamily,
  practiceSessionStatsFamily,
  tabsAtom,
} from "@/state/atoms";
import { PRACTICE_SYNC_DEBOUNCE_MS, resetPracticeMigrationForTests } from "@/state/practiceStorage";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { WorkspaceTabScope } from "@/state/tabScope";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { defaultTree, getNodeAtPath } from "@/utils/treeReducer";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { Chess } from "chessops/chess";
import { parseFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import PracticePanel from "./PracticePanel";

const mocks = vi.hoisted(() => ({
  native: {
    loadPracticeDeck: vi.fn(),
    recordPracticeReview: vi.fn(),
    syncPracticePositions: vi.fn(),
    loadPracticeReviews: vi.fn(),
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
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./RepertoireInfo", () => ({ default: () => null }));

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
const standard = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const cases = [
  {
    name: "White",
    fen: standard,
    orientation: "white" as const,
    moves: ["e4", "e5", "Nf3"],
    wrong: "Nc3",
    label: "1... e5",
  },
  {
    name: "Black",
    fen: standard,
    orientation: "black" as const,
    moves: ["e4", "c5"],
    wrong: "e5",
    label: "1. e4",
  },
  {
    name: "custom White",
    fen: standard.replace("0 1", "0 12"),
    orientation: "white" as const,
    moves: ["e4", "e5", "Nf3"],
    wrong: "Nc3",
    label: "12... e5",
  },
  {
    name: "custom Black",
    fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 12",
    orientation: "black" as const,
    moves: ["c5", "Nf3", "d6"],
    wrong: "e5",
    label: "13. Nf3",
  },
];
let host: HTMLDivElement;
let root: Root;
let tree: TreeStore;
let atoms: ReturnType<typeof createStore>;
let owner: import("@/state/workspaceTypes").Tab;
let reviews: { id: string; entry: string }[];
let mounted = false;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
  sessionStorage.clear();
  localStorage.clear();
  resetPracticeMigrationForTests();
  reviews = [];
  mocks.native.listPracticeDecks.mockResolvedValue({ decks: [], anomalies: [] });
  mocks.native.syncPracticePositions.mockImplementation(
    async (_file, _game, _generation, revision) => revision + 1,
  );
  mocks.native.recordPracticeReview.mockImplementation(async (_file, _game, _epoch, write) => {
    reviews.push({ id: write.entryId, entry: write.entry });
    return write.revision + 1;
  });
  mocks.native.loadPracticeReviews.mockImplementation(async () => ({
    entries: reviews,
    nextCursor: null,
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mounted = true;
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  tree?.dispose();
  host.remove();
  vi.useRealTimers();
  sessionStorage.clear();
  localStorage.clear();
});

async function mountStudy(spec = cases[0], variation?: string[], full = false) {
  tree = createTreeStore(undefined, defaultTree(spec.fen));
  for (const payload of variation ? [spec.moves, variation] : [spec.moves]) {
    tree.getState().goToStart();
    expect(tree.getState().makeMoves({ payload }).success).toBe(true);
  }
  tree.getState().setHeaders({ ...tree.getState().headers, orientation: spec.orientation });
  tree.getState().goToMove([]);
  tree.getState().save("a".repeat(64));
  const cards = buildFromTree(tree.getState().root, spec.orientation, []);
  expect(cards).toHaveLength(variation ? 3 : 1);
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
  atoms.set(autoSaveAtom, false);
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
  await click(full ? "Board.Practice.PracticeFullRepertoire" : "Board.Practice.StartPractice");
  expect(atoms.get(practiceStateFamily(owner.value)).phase).toBe("waiting");
  expect(tree.getState().currentNode().fen).toBe(cards[0].fen);
  return cards[0];
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find((value) =>
    value.textContent?.includes(label),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
async function wrongAnswer(spec = cases[0]) {
  const card = await mountStudy(spec);
  const position = Chess.fromSetup(parseFen(card.fen).unwrap()).unwrap();
  expect(parseSan(position, spec.wrong)).toBeDefined();
  const controller = atoms.get(practiceMoveControllerFamily(owner.value))!;
  expect(controller.canMove).toBe(true);
  const source = tree.getState();
  await act(async () => controller.submitMove(spec.wrong));
  expect(atoms.get(practiceStateFamily(owner.value)).phase).toBe("incorrect");
  expect(tree.getState().position).toBe(source.position);
  return { card, source };
}

test.each(cases)(
  "wrong legal answer reveals the existing $name answer without changing source or drill guard",
  async (spec) => {
    const { card, source } = await wrongAnswer(spec);
    const answerIndex = source
      .currentNode()
      .children.findIndex((child) => child.san === card.answer);
    expect(answerIndex).toBeGreaterThanOrEqual(0);
    await act(async () => tree.getState().goToNext());
    expect(tree.getState().position).toBe(source.position);
    await act(async () => vi.advanceTimersByTimeAsync(499));
    expect(tree.getState().position).toBe(source.position);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(tree.getState().position).toEqual([...source.position, answerIndex]);
    expect(tree.getState().currentNode().san).toBe(card.answer);
    expect(tree.getState().root).toBe(source.root);
    expect(tree.getState().headers).toBe(source.headers);
    expect(tree.getState().dirty).toBe(false);
    expect(tree.getState().practicePath).toBe(source.practicePath);
    expect(tree.getState().sourceStamp).toBe(source.sourceStamp);
    expect(atoms.get(practiceSessionStatsFamily(owner.value)).incorrect).toBe(1);
    expect(mocks.native.recordPracticeReview).toHaveBeenCalledOnce();
    expect(JSON.parse(reviews[0].entry).fen).toBe(card.fen);
    await click("Board.Practice.ShowLogs");
    expect(
      document.querySelector(`[data-practice-entry-id="${reviews[0].id}"]`)?.firstElementChild
        ?.textContent,
    ).toBe(spec.label);
  },
);

test.each([
  "navigation",
  "return navigation",
  "tree edit",
  "headers",
  "source stamp",
  "owner replacement",
  "file replacement",
  "game replacement",
  "close",
  "unmount",
  "new session",
])("%s prevents a stale delayed answer reveal", async (change) => {
  const { source } = await wrongAnswer();
  await act(async () => {
    if (change === "navigation") tree.getState().goToMove([]);
    if (change === "return navigation") {
      tree.getState().goToMove([]);
      tree.getState().goToMove([...source.position]);
    }
    if (change === "tree edit") tree.getState().setComment("Changed while feedback is pending");
    if (change === "headers")
      tree.getState().setHeaders({ ...tree.getState().headers, event: "Changed" });
    if (change === "source stamp") tree.getState().save("b".repeat(64));
    if (change === "owner replacement")
      atoms.set(tabsAtom, [{ ...owner, treeKey: crypto.randomUUID() }], owner.value);
    if (change === "file replacement" || change === "game replacement") {
      if (owner.gameOrigin.kind !== "file")
        throw new Error("Expected a file-backed practice owner");
      atoms.set(
        tabsAtom,
        [
          {
            ...owner,
            gameOrigin: {
              ...owner.gameOrigin,
              gameNumber: change === "game replacement" ? 1 : 0,
              file: {
                ...owner.gameOrigin.file,
                handle:
                  change === "file replacement"
                    ? { id: { id: crypto.randomUUID() }, kind: "fileWorkspace" }
                    : owner.gameOrigin.file.handle,
              },
            },
          },
        ],
        owner.value,
      );
    }
    if (change === "close") atoms.set(tabsAtom, []);
    if (change === "unmount") {
      root.unmount();
      mounted = false;
    }
  });
  expect(tree.getState().practicePath).toEqual(change === "unmount" ? null : source.practicePath);
  if (change === "new session") {
    await click("Board.Practice.NextPosition");
    // The rated card is due later. Start the existing full repertoire flow as the successor.
    await click("Board.Practice.PracticeFullRepertoire");
  }
  const before = tree.getState().position;
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(tree.getState().position).toBe(before);
  expect(tree.getState().position).not.toEqual([...source.position, 0]);
});

test("correct answers retain rating and advancement behavior with the real controller", async () => {
  const card = await mountStudy();
  const source = tree.getState();
  await act(async () =>
    atoms.get(practiceMoveControllerFamily(owner.value))!.submitMove(card.answer),
  );
  expect(tree.getState().currentNode().san).toBe(card.answer);
  expect(tree.getState().root).toBe(source.root);
  expect(atoms.get(practiceStateFamily(owner.value)).phase).toBe("correct");
  await click("Board.Practice.Good");
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(atoms.get(practiceStateFamily(owner.value)).phase).toBe("idle");
  expect(mocks.native.recordPracticeReview).toHaveBeenCalledOnce();
  expect(JSON.parse(reviews[0].entry).rating).toBe(3);
});

test("actual log writer retains repeated FEN IDs and root or missing-node fallback", async () => {
  const card = await mountStudy();
  const written = [
    updateCardPerformance([card], 0, card.card, 3)!,
    updateCardPerformance([card], 0, card.card, 1)!,
  ];
  expect(written[0].entry.fen).toBe(card.fen);
  expect(written[0].entryId).not.toBe(written[1].entryId);
  const rootFen = tree.getState().root.fen;
  reviews = [
    ...written.map((value) => ({ id: value.entryId, entry: JSON.stringify(value.entry) })),
    { id: "root", entry: JSON.stringify({ ...written[0].entry, fen: rootFen }) },
    {
      id: "missing",
      entry: JSON.stringify({ ...written[0].entry, fen: "Historical off-repertoire FEN" }),
    },
  ];
  await click("Board.Practice.ShowLogs");
  const nodes = [...document.querySelectorAll("[data-practice-entry-id]")];
  expect(nodes.map((node) => node.getAttribute("data-practice-entry-id"))).toEqual(
    reviews.map((entry) => entry.id),
  );
  expect(nodes.map((node) => node.firstElementChild?.textContent)).toEqual([
    "1... e5",
    "1... e5",
    rootFen,
    "Historical off-repertoire FEN",
  ]);
  expect(getNodeAtPath(tree.getState().root, tree.getState().position).fen).toBe(card.fen);
});

const transposedFen = "r1bqkb1r/pppppppp/2n2n2/8/8/2N2N2/PPPPPPPP/R1BQKB1R w KQkq - 4 3";
const answerFrame = [1, 0, 0, 0];

async function startTransposedCard() {
  await mountStudy(
    { ...cases[0], moves: ["Nf3", "Nf6", "Nc3", "Nc6"] },
    ["Nc3", "Nc6", "Nf3", "Nf6", "e4"],
    true,
  );
  const cards = buildFromTree(tree.getState().root, "white", []);
  expect(cards.map((card) => card.answer)).toEqual(["Nc3", "Nf3", "e4"]);
  expect(getNodeAtPath(tree.getState().root, [0, 0, 0, 0]).fen).toBe(transposedFen);
  expect(getNodeAtPath(tree.getState().root, [0, 0, 0, 0]).children).toHaveLength(0);
  for (const answer of ["Nc3", "Nf3"]) {
    await act(async () => atoms.get(practiceMoveControllerFamily(owner.value))!.submitMove(answer));
    expect(atoms.get(practiceStateFamily(owner.value)).phase).toBe("correct");
    await act(async () => vi.advanceTimersByTimeAsync(300));
  }
  expect(atoms.get(practiceStateFamily(owner.value))).toMatchObject({
    phase: "waiting",
    currentFen: transposedFen,
  });
  return cards.at(-1)!;
}

test("real producer transposition admits the answer-bearing frame and reveals its existing answer at 499/1ms", async () => {
  const card = await startTransposedCard();
  expect(tree.getState().position).toEqual(answerFrame);
  expect(tree.getState().practicePath).toEqual(answerFrame);
  expect(card.answer).toBe("e4");
  const source = tree.getState();
  expect(parseSan(Chess.fromSetup(parseFen(card.fen).unwrap()).unwrap(), "d4")).toBeDefined();
  await act(async () => tree.getState().goToNext());
  expect(tree.getState().position).toBe(source.position);
  await act(async () => atoms.get(practiceMoveControllerFamily(owner.value))!.submitMove("d4"));
  expect(atoms.get(practiceStateFamily(owner.value)).phase).toBe("incorrect");
  await act(async () => vi.advanceTimersByTimeAsync(499));
  expect(tree.getState().position).toBe(source.position);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(tree.getState().position).toEqual([...answerFrame, 0]);
  expect(tree.getState().currentNode().san).toBe("e4");
  expect(tree.getState().root).toBe(source.root);
  expect(tree.getState().headers).toBe(source.headers);
  expect(tree.getState().practicePath).toBe(source.practicePath);
  expect(tree.getState().sourceStamp).toBe(source.sourceStamp);
  expect(tree.getState().linkedSource).toBe(source.linkedSource);
  expect(tree.getState().dirty).toBe(false);
  expect(atoms.get(practiceSessionStatsFamily(owner.value))).toMatchObject({
    correct: 2,
    incorrect: 1,
  });
  expect(mocks.native.recordPracticeReview).not.toHaveBeenCalled();
});

test("current transposed card return and positions navigation use the answer-bearing current frame", async () => {
  await startTransposedCard();
  await act(async () => tree.getState().goToStart());
  await click("Board.Practice.GoBackToPosition");
  expect(tree.getState().position).toEqual(answerFrame);
  expect(tree.getState().practicePath).toEqual(answerFrame);
  await act(async () => tree.getState().goToStart());
  await click("Board.Practice.ShowAll");
  const positionCard = [...document.querySelectorAll(".mantine-Card-root")].find((element) =>
    element.textContent?.includes("3. e4"),
  );
  expect(positionCard).toBeDefined();
  await act(async () => positionCard!.querySelector<HTMLButtonElement>("button")!.click());
  expect(tree.getState().position).toEqual(answerFrame);
  expect(tree.getState().currentNode().children[0].san).toBe("e4");
  expect(tree.getState().dirty).toBe(false);
});

test.each([false, true])(
  "removing a transposed card answer retires waiting or pending feedback without fabricating moves, pending=%s",
  async (pending) => {
    await startTransposedCard();
    if (pending)
      await act(async () => atoms.get(practiceMoveControllerFamily(owner.value))!.submitMove("d4"));
    await act(async () => tree.getState().deleteMove([...answerFrame, 0]));
    const edited = tree.getState();
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(atoms.get(practiceStateFamily(owner.value)).phase).toBe("idle");
    expect(tree.getState().root).toBe(edited.root);
    expect(tree.getState().headers).toBe(edited.headers);
    expect(getNodeAtPath(tree.getState().root, answerFrame).children).toHaveLength(0);
    expect(tree.getState().linkedSource).toBe(edited.linkedSource);
    expect(tree.getState().dirty).toBe(true);
    expect(mocks.native.recordPracticeReview).not.toHaveBeenCalled();
  },
);

test.each([cases[0], cases[3]])(
  "a stored $name root card keeps exact-frame admission and reveals its existing answer",
  async (spec) => {
    const originalCard = await mountStudy(spec);
    await click("Common.Stop");
    if (owner.gameOrigin.kind !== "file") throw new Error("Expected a file-backed practice owner");
    const file = owner.gameOrigin.file.handle;
    const rootCard = {
      ...originalCard,
      fen: tree.getState().root.fen,
      answer: tree.getState().root.children[0].san!,
    };
    // A stored card uses the existing deck writer after tree synchronization has settled.
    await act(async () => {
      const writing = atoms.set(deckAtomFamily({ file: fileWorkspaceKey(file), game: 0 }), {
        type: "sync",
        positions: [rootCard],
      });
      await vi.advanceTimersByTimeAsync(PRACTICE_SYNC_DEBOUNCE_MS);
      await writing;
    });
    await click("Board.Practice.StartPractice");
    expect(tree.getState().position).toEqual([]);
    expect(atoms.get(practiceStateFamily(owner.value))).toMatchObject({
      phase: "waiting",
      currentFen: rootCard.fen,
    });
    const source = tree.getState();
    expect(
      parseSan(Chess.fromSetup(parseFen(rootCard.fen).unwrap()).unwrap(), spec.wrong),
    ).toBeDefined();
    await act(async () =>
      atoms.get(practiceMoveControllerFamily(owner.value))!.submitMove(spec.wrong),
    );
    await act(async () => vi.advanceTimersByTimeAsync(499));
    expect(tree.getState().position).toBe(source.position);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(tree.getState().position).toEqual([0]);
    expect(tree.getState().currentNode().san).toBe(rootCard.answer);
    expect(tree.getState().root).toBe(source.root);
    expect(tree.getState().headers).toBe(source.headers);
    expect(tree.getState().dirty).toBe(false);
    expect(mocks.native.recordPracticeReview).toHaveBeenCalledOnce();
  },
);
