import { WorkspaceTabScope, EphemeralTabScope } from "@/state/tabScope";
import { parseUci } from "chessops";
import { act, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useStore } from "zustand";
import type { SwitchFileChapter } from "@/components/boards/FileChapterSwitch";
import { removeFileFreshness, setFileFreshness } from "@/state/fileFreshness";
import {
  requestFilePositionIndex,
  resetFilePositionIndexForTests,
} from "@/state/filePositionIndex";
import { createTreeStore } from "@/state/store/tree";
import { lex } from "@/state/tests/lexPgn";
import type { FileBackedTab } from "@/utils/tabs";
import { createNode, defaultTree, getBoardState, type TreeNode } from "@/utils/treeReducer";
import { TreeStateContext } from "./TreeStateContext";
import { createNotationNodeIndex, type NotationNodeIndex } from "./notationRows";

const { currentTabAtom, moveCell, tab, playFromHere, mocks } = vi.hoisted(() => ({
  currentTabAtom: Symbol("current-tab"),
  moveCell: { useReal: false },
  tab: { value: "tab", type: undefined as string | undefined },
  playFromHere: vi.fn(),
  mocks: {
    tabs: null as unknown[] | null,
    switchChapter: null as SwitchFileChapter | null,
    countPgnGames: vi.fn(),
    readGames: vi.fn(),
    lexPgn: vi.fn(),
  },
}));

vi.mock("@/state/atoms", () => ({
  tabsAtom: currentTabAtom,
  updateTabById: vi.fn(),
  showCommentsFamily: Object.assign((id: string) => `comments:${id}`, { remove: () => {} }),
  moveNotationTypeAtom: "type",
}));
vi.mock("jotai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jotai")>()),
  useAtomValue: () => mocks.tabs ?? [tab],
  useSetAtom: () => vi.fn(),
  useAtom: (atom: unknown) => [atom === "type" ? "letters" : true],
}));
vi.mock("@/components/boards/usePlayFromHere", () => ({
  usePlayFromHere: () => playFromHere,
}));
vi.mock("@/utils/tabs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/tabs")>()),
  isRepertoireTab: (tab: unknown) => !!tab,
}));
vi.mock("@/components/boards/FileChapterSwitch", () => ({
  useFileChapterSwitch: () => mocks.switchChapter,
}));
vi.mock("@/platform/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/tauri")>();
  return {
    ...actual,
    tauri: {
      ...actual.tauri,
      countPgnGames: mocks.countPgnGames,
      readGames: mocks.readGames,
      lexPgn: mocks.lexPgn,
    },
  };
});
vi.mock("@/platform/native", () => ({
  platform: () => "linux",
  warn: vi.fn().mockResolvedValue(undefined),
  error: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { chapter?: string }) =>
      options?.chapter === undefined ? key : `${key}(${options.chapter})`,
  }),
}));
vi.mock("lucide-react", async (importOriginal) => {
  const Icon = () => null;
  return {
    ...(await importOriginal<typeof import("lucide-react")>()),
    Merge: Icon,
    ArrowUpRight: Icon,
    Copy: Icon,
    Flag: Icon,
    Grid2x2: Icon,
    Target: Icon,
    Trash2: Icon,
  };
});
vi.mock("@/components/common/Comment", () => ({
  default: ({ comment, annotatedNode }: { comment: string; annotatedNode?: TreeNode }) => (
    <span data-comment="true" data-annotated-fen={annotatedNode?.fen}>
      {comment}
    </span>
  ),
}));
vi.mock("@/components/common/IconAction", () => ({
  default: ({ children, label, onClick }: any) => (
    <button type="button" aria-label={label} onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("./MoveCell", async (importOriginal) => {
  const original = await importOriginal<typeof import("./MoveCell")>();
  return {
    releasePointerFocus: original.releasePointerFocus,
    default: (props: any) => {
      if (moveCell.useReal) return <original.default {...props} />;
      return (
        <button
          type="button"
          data-move={props.move}
          data-analysis={props.analysis ? "true" : undefined}
          onClick={props.onClick}
          onContextMenu={props.onContextMenu}
        >
          {props.move}
        </button>
      );
    },
  };
});
vi.mock("@mantine/core", () => {
  const Menu = ({ children }: any) => <div>{children}</div>;
  Menu.Target = ({ children }: any) => <>{children}</>;
  Menu.Dropdown = ({ children }: any) => <div data-menu="true">{children}</div>;
  Menu.Item = ({ children, onClick }: any) => (
    <button type="button" data-menu-item="true" onClick={onClick}>
      {children}
    </button>
  );
  return {
    Box: ({ component: Component = "span", children, ...props }: any) => (
      <Component {...props}>{children}</Component>
    ),
    Menu,
    Portal: ({ children }: any) => <>{children}</>,
    Text: ({ children }: any) => <span>{children}</span>,
    rgba: () => "transparent",
    useMantineTheme: () => ({
      colors: { gray: Array(10).fill("#888"), teal: Array(10).fill("#099") },
    }),
  };
});

import CompleteMoveCell, {
  NotationMoveActionsContext,
  type NotationMoveActions,
} from "./CompleteMoveCell";
import { MoveDeletionContext } from "./MoveDeletionContext";

function CurrentGameMoves({
  first,
  second,
  root,
  nodeIndex,
}: {
  first: TreeNode;
  second: TreeNode;
  root: TreeNode;
  nodeIndex: NotationNodeIndex;
}) {
  const store = useContext(TreeStateContext)!;
  const current = useStore(store, (s) => s.currentNode());
  const cell = (node: TreeNode) => (
    <CompleteMoveCell
      node={node}
      nodeIndex={nodeIndex}
      root={root}
      halfMoves={node.halfMoves}
      move={node.san}
      fen={node.fen}
      comment=""
      annotations={[]}
      showComments={false}
      isCurrentVariation={node === current}
    />
  );
  return (
    <WorkspaceTabScope tabId="tab">
      {cell(first)}
      {cell(second)}
    </WorkspaceTabScope>
  );
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  moveCell.useReal = false;
  tab.type = undefined;
  playFromHere.mockReset();
  mocks.tabs = null;
  mocks.switchChapter = null;
  mocks.countPgnGames.mockReset();
  mocks.readGames.mockReset();
  mocks.lexPgn.mockReset().mockImplementation(async (pgn: string) => lex(pgn));
  resetFilePositionIndexForTests();
  removeFileFreshness("tab");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  resetFilePositionIndexForTests();
  removeFileFreshness("tab");
});

test("renders the starting comment before the move and updates it without changing the node", async () => {
  const tree = defaultTree();
  const node = createNode({
    fen: "first w - - 0 1",
    move: parseUci("e2e4")!,
    san: "e4",
    halfMoves: 1,
  });
  tree.root.children = [node];
  const store = createTreeStore();
  store.setState({ ...store.getState(), root: tree.root });
  const index = createNotationNodeIndex(tree.root);
  const annotations: [] = [];
  const render = async (startingComment: string, showComments = true, tableLayout = false) => {
    await act(async () => {
      root.render(
        <TreeStateContext.Provider value={store}>
          <WorkspaceTabScope tabId="tab">
            <CompleteMoveCell
              node={node}
              nodeIndex={index}
              root={tree.root}
              halfMoves={node.halfMoves}
              move={node.san}
              fen={node.fen}
              comment="After the move"
              startingComment={startingComment}
              annotations={annotations}
              first
              showComments={showComments}
              tableLayout={tableLayout}
              isStart={false}
              isCurrentVariation={false}
            />
          </WorkspaceTabScope>
        </TreeStateContext.Provider>,
      );
    });
  };

  await render("Before the move");
  expect(host.textContent).toBe("Before the move1.e4After the move");
  // A cited game opens at the position the comment annotates: before the move, or after it.
  expect(
    [...host.querySelectorAll("[data-comment]")].map((comment) =>
      comment.getAttribute("data-annotated-fen"),
    ),
  ).toEqual([tree.root.fen, node.fen]);
  await render("Updated starting comment");
  expect(host.textContent).toBe("Updated starting comment1.e4After the move");
  await render("Updated starting comment", false);
  expect(host.querySelector("[data-comment]")).toBeNull();
  expect(host.textContent).toBe("1.e4");
  await render("Updated starting comment", true, true);
  expect(host.querySelector("[data-comment]")).toBeNull();
  expect(host.textContent).toBe("e4");
});

test.each([
  ["workspace", false],
  ["workspace", true],
  ["preview", false],
  ["preview", true],
] as const)(
  "%s (table layout: %s) opens one context menu and sends every action the identity-derived path",
  async (scope, tableLayout) => {
    const Scope = scope === "workspace" ? WorkspaceTabScope : EphemeralTabScope;
    const tree = defaultTree();
    const first = createNode({
      fen: "first w - - 0 1",
      move: { from: 12, to: 28 },
      san: "e4",
      halfMoves: 1,
    });
    const second = createNode({
      fen: "second b - - 0 1",
      move: { from: 51, to: 35 },
      san: "e5",
      halfMoves: 2,
    });
    tree.root.children = [first, second];
    const store = createTreeStore();
    const state = store.getState();
    const actions = {
      deleteMove: vi.fn(),
      promoteVariation: vi.fn(),
      promoteToMainline: vi.fn(),
      copyVariationPgn: vi.fn(),
      setStart: vi.fn(),
    };
    store.setState({ ...state, ...actions, root: tree.root });
    const index = createNotationNodeIndex(tree.root);

    await act(async () => {
      root.render(
        <TreeStateContext.Provider value={store}>
          <Scope tabId="tab">
            <CompleteMoveCell
              node={first}
              nodeIndex={index}
              root={tree.root}
              halfMoves={first.halfMoves}
              move={first.san}
              fen={first.fen}
              comment=""
              annotations={[]}
              showComments={false}
              tableLayout={tableLayout}
              isStart={false}
              isCurrentVariation={false}
            />
            <CompleteMoveCell
              node={second}
              nodeIndex={index}
              root={tree.root}
              halfMoves={second.halfMoves}
              move={second.san}
              fen={second.fen}
              comment=""
              annotations={[]}
              showComments={false}
              tableLayout={tableLayout}
              isStart={false}
              isCurrentVariation={false}
            />
          </Scope>
        </TreeStateContext.Provider>,
      );
    });

    const moves = () => [...host.querySelectorAll<HTMLButtonElement>("[data-move]")];
    expect(host.querySelectorAll('[data-menu="true"]').length).toBe(0);
    await act(async () => {
      moves()[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    expect(host.querySelectorAll('[data-menu="true"]').length).toBe(1);
    expect(host.querySelectorAll('[data-menu-item="true"]').length).toBe(
      scope === "workspace" ? 7 : 5,
    );

    const expectedPath = [0];
    const clickAction = async (label: string, action: ReturnType<typeof vi.fn>) => {
      await act(async () => {
        [...host.querySelectorAll<HTMLButtonElement>('[data-menu-item="true"]')]
          .find((button) => button.textContent === label)!
          .click();
      });
      expect(action).toHaveBeenCalledWith(expectedPath);
      expect(host.querySelectorAll('[data-menu="true"]').length).toBe(0);
      await act(async () => {
        moves()[0].dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
        );
      });
    };

    expect(host.textContent?.includes("Menu.MarkAsStart")).toBe(scope === "workspace");
    if (scope === "workspace") {
      await clickAction("Menu.MarkAsStart", actions.setStart);
    }
    expect(actions.setStart).toHaveBeenCalledTimes(scope === "workspace" ? 1 : 0);
    await clickAction("Menu.PromoteToMainLine", actions.promoteToMainline);
    await clickAction("Menu.PromoteVariation", actions.promoteVariation);
    await clickAction("Menu.CopyVariationPGN", actions.copyVariationPgn);
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>('[data-menu-item="true"]')]
        .find((button) => button.textContent === "Menu.DeleteMove")!
        .click();
    });
    expect(actions.deleteMove).toHaveBeenCalledWith(expectedPath);
    expect(host.querySelectorAll('[data-menu="true"]').length).toBe(0);
    expect(actions.setStart).not.toHaveBeenCalledWith([1]);
  },
);

test.each(["training", "disabled", "default"] as const)(
  "%s capability exposes only its allowed move actions and routes callbacks",
  async (capability) => {
    const tree = defaultTree();
    const node = createNode({
      fen: "move b - - 0 1",
      move: parseUci("e2e4")!,
      san: "e4",
      halfMoves: 1,
    });
    tree.root.children = [node];
    const store = createTreeStore();
    const storeActions = {
      promoteVariation: vi.fn(),
      deleteMove: vi.fn(),
      promoteToMainline: vi.fn(),
      copyVariationPgn: vi.fn(),
      setStart: vi.fn(),
      setGameEnd: vi.fn(),
      toggleDiagram: vi.fn(),
    };
    store.setState({ root: tree.root, ...storeActions });
    const sessionActions = { promote: vi.fn(), delete: vi.fn() };
    const actions =
      capability === "training" ? sessionActions : capability === "disabled" ? false : undefined;
    const index = createNotationNodeIndex(tree.root);
    const render = async (moveActions: NotationMoveActions | undefined) => {
      await act(async () =>
        root.render(
          <TreeStateContext.Provider value={store}>
            <WorkspaceTabScope tabId="tab">
              <NotationMoveActionsContext.Provider value={moveActions}>
                <CompleteMoveCell
                  node={node}
                  nodeIndex={index}
                  root={tree.root}
                  halfMoves={1}
                  move="e4"
                  fen={node.fen}
                  comment=""
                  annotations={[]}
                  showComments={false}
                />
              </NotationMoveActionsContext.Provider>
            </WorkspaceTabScope>
          </TreeStateContext.Provider>,
        ),
      );
    };
    const openMenu = async () => {
      await act(async () =>
        host
          .querySelector("[data-move]")!
          .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
      );
    };
    const items = () => [...host.querySelectorAll<HTMLButtonElement>("[data-menu-item]")];
    await render(actions);
    await openMenu();
    const labels =
      capability === "disabled"
        ? []
        : capability === "training"
          ? ["Menu.PromoteVariation", "Menu.DeleteMove"]
          : [
              "Notation.AddDiagram",
              "Notation.MarkGameEndHere",
              "Menu.MarkAsStart",
              "Menu.PromoteToMainLine",
              "Menu.PromoteVariation",
              "Menu.CopyVariationPGN",
              "Menu.DeleteMove",
            ];
    expect(items().map((item) => item.textContent)).toEqual(labels);
    for (const label of labels) {
      await act(async () =>
        items()
          .find((item) => item.textContent === label)!
          .click(),
      );
      expect(items()).toHaveLength(0);
      await openMenu();
    }
    expect(sessionActions.promote.mock.calls).toEqual(capability === "training" ? [[[0]]] : []);
    expect(sessionActions.delete.mock.calls).toEqual(capability === "training" ? [[[0]]] : []);
    for (const action of Object.values(storeActions)) {
      expect(action.mock.calls).toEqual(capability === "default" ? [[[0]]] : []);
    }
    // Submitting or receiving a verdict disables an already-open solving menu too.
    await render(false);
    expect(items()).toHaveLength(0);
    await openMenu();
    expect(items()).toHaveLength(0);
  },
);

test("navigates to the first transposition in tree order", async () => {
  const tree = defaultTree();
  const move = parseUci("e2e4")!;
  const firstBranch = createNode({
    fen: "first-branch w - - 0 1",
    move,
    san: "first-branch",
    halfMoves: 1,
  });
  const firstTargetParent = createNode({
    fen: "first-parent w - - 0 1",
    move,
    san: "first-parent",
    halfMoves: 2,
  });
  const secondTargetParent = createNode({
    fen: "second-parent w - - 0 1",
    move,
    san: "second-parent",
    halfMoves: 2,
  });
  const firstTarget = createNode({
    fen: "shared w - - 0 1",
    move,
    san: "first-target",
    halfMoves: 3,
  });
  const secondTarget = createNode({
    fen: "shared w - - 0 1",
    move,
    san: "second-target",
    halfMoves: 3,
  });
  const current = createNode({
    fen: "shared w - - 0 1",
    move,
    san: "current",
    halfMoves: 1,
  });
  firstBranch.children = [firstTargetParent, secondTargetParent];
  firstTargetParent.children = [firstTarget];
  secondTargetParent.children = [secondTarget];
  tree.root.children = [firstBranch, current];

  const store = createTreeStore();
  store.setState({ ...store.getState(), root: tree.root });
  const index = createNotationNodeIndex(tree.root);

  await act(async () => {
    root.render(
      <TreeStateContext.Provider value={store}>
        <WorkspaceTabScope tabId="tab">
          <CompleteMoveCell
            node={current}
            nodeIndex={index}
            root={tree.root}
            halfMoves={current.halfMoves}
            move={current.san}
            fen={current.fen}
            comment=""
            annotations={[]}
            showComments={false}
            isStart={false}
            isCurrentVariation={false}
          />
        </WorkspaceTabScope>
      </TreeStateContext.Provider>,
    );
  });

  const transposition = host.querySelector<HTMLButtonElement>(
    '[aria-label="Notation.Transposition"]',
  )!;
  transposition.focus();
  await act(async () => {
    transposition.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });

  expect(store.getState().position).toEqual([0, 0, 0]);
  // A pointer click releases focus, so arrow-key navigation leaves no stale focus ring here.
  expect(document.activeElement).not.toBe(transposition);
});

test("updates transposition actions when another branch is added", async () => {
  const tree = defaultTree();
  const move = parseUci("e2e4")!;
  const branch = createNode({
    fen: "branch w - - 0 1",
    move,
    san: "branch",
    halfMoves: 1,
  });
  const current = createNode({
    fen: "shared w - - 0 1",
    move,
    san: "current",
    halfMoves: 1,
  });
  tree.root.children = [branch, current];
  const store = createTreeStore();
  store.setState({ ...store.getState(), root: tree.root });
  const initialIndex = createNotationNodeIndex(tree.root);

  await act(async () => {
    root.render(
      <TreeStateContext.Provider value={store}>
        <WorkspaceTabScope tabId="tab">
          <CompleteMoveCell
            node={current}
            nodeIndex={initialIndex}
            root={tree.root}
            halfMoves={current.halfMoves}
            move={current.san}
            fen={current.fen}
            comment=""
            annotations={[]}
            showComments={false}
            isStart={false}
            isCurrentVariation={false}
          />
        </WorkspaceTabScope>
      </TreeStateContext.Provider>,
    );
  });
  expect(host.querySelector('[aria-label="Notation.Transposition"]')).toBeNull();

  const target = createNode({
    fen: current.fen,
    move,
    san: "target",
    halfMoves: 2,
  });
  const nextBranch = { ...branch, children: [target] };
  const nextRoot = { ...tree.root, children: [nextBranch, current] };
  const nextIndex = createNotationNodeIndex(nextRoot);

  await act(async () => {
    root.render(
      <TreeStateContext.Provider value={store}>
        <WorkspaceTabScope tabId="tab">
          <CompleteMoveCell
            node={current}
            nodeIndex={nextIndex}
            root={nextRoot}
            halfMoves={current.halfMoves}
            move={current.san}
            fen={current.fen}
            comment=""
            annotations={[]}
            showComments={false}
            isStart={false}
            isCurrentVariation={false}
          />
        </WorkspaceTabScope>
      </TreeStateContext.Provider>,
    );
  });

  expect(host.querySelector('[aria-label="Notation.Transposition"]')).not.toBeNull();
});

function positionNode(fen: string, children: TreeNode[] = [], clocks = "0 1"): TreeNode {
  const node = createNode({
    fen: `${fen} w - - ${clocks}`,
    move: parseUci("e2e4")!,
    san: fen,
    halfMoves: 1,
  });
  node.children = children;
  return node;
}

// Each case renders the move at `cell` and names the path its marker jumps to, or null for none.
test.each([
  [
    "a main-line move reached first elsewhere jumps to the analysed variation",
    () => [
      positionNode("shared"),
      positionNode("detour", [positionNode("shared", [positionNode("reply")])]),
    ],
    [0],
    [1, 0],
  ],
  [
    "an analysed variation move is marked as well and jumps to the main-line occurrence",
    () => [
      positionNode("shared"),
      positionNode("detour", [positionNode("shared", [positionNode("reply")])]),
    ],
    [1, 0],
    [0],
  ],
  [
    "an occurrence with a continuation wins over an earlier one without",
    () => [
      positionNode("shared"),
      positionNode("detour", [positionNode("shared", [positionNode("reply")])]),
      positionNode("shared"),
    ],
    [2],
    [1, 0],
  ],
  [
    "two analysed occurrences point at each other",
    () => [
      positionNode("shared", [positionNode("reply")]),
      positionNode("shared", [positionNode("other-reply")]),
    ],
    [0],
    [1],
  ],
  [
    "of several analysed occurrences the first in tree order wins",
    () => [
      positionNode("shared"),
      positionNode("detour", [positionNode("shared", [positionNode("reply")])]),
      positionNode("shared", [positionNode("other-reply")]),
    ],
    [0],
    [1, 0],
  ],
  [
    "move counters do not make the same position a different one",
    () => [
      positionNode("shared", [], "0 5"),
      positionNode("detour", [positionNode("shared", [positionNode("reply")], "2 9")]),
    ],
    [0],
    [1, 0],
  ],
  [
    "a repetition on the move's own line is not a transposition",
    () => [positionNode("shared", [positionNode("away", [positionNode("shared")])])],
    [0, 0, 0],
    null,
  ],
  [
    "a repetition is skipped in favour of an occurrence on another line",
    () => [
      positionNode("shared", [positionNode("away", [positionNode("shared")])]),
      positionNode("shared"),
    ],
    [0],
    [1],
  ],
] as const)("transposition marker: %s", async (_name, children, cell, expected) => {
  const tree = defaultTree();
  tree.root.children = children();
  const store = createTreeStore();
  store.setState({ ...store.getState(), root: tree.root });
  const node = store.getState().getNode([...cell])!;

  await act(async () => {
    root.render(
      <TreeStateContext.Provider value={store}>
        <WorkspaceTabScope tabId="tab">
          <CompleteMoveCell
            node={node}
            nodeIndex={createNotationNodeIndex(tree.root)}
            root={tree.root}
            halfMoves={node.halfMoves}
            move={node.san}
            fen={node.fen}
            comment=""
            annotations={[]}
            showComments={false}
            isStart={false}
            isCurrentVariation={false}
          />
        </WorkspaceTabScope>
      </TreeStateContext.Provider>,
    );
  });

  const marker = host.querySelector<HTMLButtonElement>('[aria-label="Notation.Transposition"]');
  await act(async () => {
    marker?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });
  // The cursor starts at the root, so a marker that jumps nowhere cannot pass as a jump.
  expect(marker === null ? null : store.getState().position).toEqual(expected);
});

test.each([
  ["workspace", false, false],
  ["workspace", true, false],
  ["workspace", false, true],
  ["preview", false, false],
  ["preview", true, false],
] as const)(
  "game-end menu visibility and calls for %s, marked %s, variation %s",
  async (scope, marked, variation) => {
    const tree = defaultTree();
    const node = createNode({
      fen: "end b - - 0 1",
      move: parseUci("e2e4")!,
      san: "e4",
      halfMoves: 1,
    });
    tree.root.children = variation
      ? [
          createNode({ fen: "main b - - 0 1", move: parseUci("d2d4")!, san: "d4", halfMoves: 1 }),
          node,
        ]
      : [node];
    if (marked) node.gameEnd = {};
    const store = createTreeStore();
    const setGameEnd = vi.fn();
    const clearGameEnd = vi.fn();
    store.setState({ root: tree.root, setGameEnd, clearGameEnd });
    const Scope = scope === "workspace" ? WorkspaceTabScope : EphemeralTabScope;
    await act(async () =>
      root.render(
        <TreeStateContext.Provider value={store}>
          <Scope tabId="tab">
            <CompleteMoveCell
              node={node}
              nodeIndex={createNotationNodeIndex(tree.root)}
              root={tree.root}
              halfMoves={1}
              move="e4"
              fen={node.fen}
              comment=""
              annotations={[]}
              showComments={false}
              analysis
            />
          </Scope>
        </TreeStateContext.Provider>,
      ),
    );
    await act(async () =>
      host
        .querySelector("button")!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
    );
    const items = [...host.querySelectorAll<HTMLButtonElement>("[data-menu-item]")];
    const mark = items.find((item) => item.textContent === "Notation.MarkGameEndHere");
    const clear = items.find((item) => item.textContent === "Notation.ClearGameEnd");
    const editable = scope === "workspace" && !variation;
    expect(!!mark).toBe(editable && !marked);
    expect(!!clear).toBe(editable && marked);
    expect(host.querySelector("[data-move]")?.getAttribute("data-analysis")).toBe("true");
    const expectedMarkCalls = editable && !marked ? [[[0]]] : [];
    const expectedClearCalls = editable && marked ? [[]] : [];
    if (mark) await act(async () => mark.click());
    if (clear) await act(async () => clear.click());
    expect(setGameEnd.mock.calls).toEqual(expectedMarkCalls);
    expect(clearGameEnd.mock.calls).toEqual(expectedClearCalls);
  },
);

test("marks the current move for screen readers and follows goToMove", async () => {
  moveCell.useReal = true;
  const tree = defaultTree();
  const first = createNode({
    fen: "first w - - 0 1",
    move: parseUci("e2e4")!,
    san: "e4",
    halfMoves: 1,
  });
  const second = createNode({
    fen: "second b - - 0 1",
    move: parseUci("e7e5")!,
    san: "e5",
    halfMoves: 2,
  });
  first.children = [second];
  tree.root.children = [first];
  const store = createTreeStore();
  store.setState({ ...store.getState(), root: tree.root, position: [0] });
  const nodeIndex = createNotationNodeIndex(tree.root);

  await act(async () => {
    root.render(
      <TreeStateContext.Provider value={store}>
        <CurrentGameMoves first={first} second={second} root={tree.root} nodeIndex={nodeIndex} />
      </TreeStateContext.Provider>,
    );
  });

  const moveButton = (name: string) => {
    const button = [...host.querySelectorAll("button")].find((el) => el.textContent === name);
    if (!button) throw new Error(`move ${name} not rendered`);
    return button;
  };

  expect(moveButton("e4").getAttribute("aria-current")).toBe("true");
  expect(moveButton("e5").hasAttribute("aria-current")).toBe(false);

  await act(async () => {
    store.getState().goToMove([0, 0]);
  });

  expect(moveButton("e5").getAttribute("aria-current")).toBe("true");
  expect(moveButton("e4").hasAttribute("aria-current")).toBe(false);
});

test("the move menu offers to remove the diagram of a marked move", async () => {
  const tree = defaultTree();
  const node = createNode({
    fen: "move b - - 0 1",
    move: parseUci("e2e4")!,
    san: "e4",
    halfMoves: 1,
  });
  node.diagram = true;
  tree.root.children = [node];
  const store = createTreeStore();
  const toggleDiagram = vi.fn();
  store.setState({ root: tree.root, toggleDiagram });
  await act(async () =>
    root.render(
      <TreeStateContext.Provider value={store}>
        <WorkspaceTabScope tabId="tab">
          <CompleteMoveCell
            node={node}
            nodeIndex={createNotationNodeIndex(tree.root)}
            root={tree.root}
            halfMoves={1}
            move="e4"
            fen={node.fen}
            comment=""
            annotations={[]}
            showComments={false}
          />
        </WorkspaceTabScope>
      </TreeStateContext.Provider>,
    ),
  );
  await act(async () =>
    host
      .querySelector("[data-move]")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
  );
  const items = [...host.querySelectorAll<HTMLButtonElement>("[data-menu-item]")];
  expect(items.some((item) => item.textContent === "Notation.AddDiagram")).toBe(false);
  await act(async () =>
    items.find((item) => item.textContent === "Notation.RemoveDiagram")!.click(),
  );
  expect(toggleDiagram.mock.calls).toEqual([[[0]]]);
});

test.each([true, false])(
  "a provided move deletion decides the delete entry (deletable: %s) and the store stays untouched",
  async (deletable) => {
    const tree = defaultTree();
    const node = createNode({
      fen: "move b - - 0 1",
      move: parseUci("e2e4")!,
      san: "e4",
      halfMoves: 1,
    });
    tree.root.children = [node];
    const store = createTreeStore();
    const deleteMove = vi.fn();
    store.setState({ root: tree.root, deleteMove });
    const deletion = { canDelete: vi.fn(() => deletable), delete: vi.fn() };
    const index = createNotationNodeIndex(tree.root);
    await act(async () =>
      root.render(
        <TreeStateContext.Provider value={store}>
          <WorkspaceTabScope tabId="tab">
            <MoveDeletionContext.Provider value={deletion}>
              <CompleteMoveCell
                node={node}
                nodeIndex={index}
                root={tree.root}
                halfMoves={1}
                move="e4"
                fen={node.fen}
                comment=""
                annotations={[]}
                showComments={false}
              />
            </MoveDeletionContext.Provider>
          </WorkspaceTabScope>
        </TreeStateContext.Provider>,
      ),
    );
    await act(async () =>
      host
        .querySelector("[data-move]")!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
    );
    const deleteItem = () =>
      [...host.querySelectorAll<HTMLButtonElement>("[data-menu-item]")].find(
        (item) => item.textContent === "Menu.DeleteMove",
      );

    expect(deletion.canDelete).toHaveBeenCalledWith([0]);
    expect(deleteItem() !== undefined).toBe(deletable);
    if (deletable) await act(async () => deleteItem()!.click());

    expect(deletion.delete.mock.calls).toEqual(deletable ? [[[0]]] : []);
    expect(deleteMove).not.toHaveBeenCalled();
  },
);

async function renderPlayFromHereLine(type: string) {
  tab.type = type;
  const tree = defaultTree();
  tree.headers.orientation = "black";
  const e4 = createNode({
    fen: "after-e4 b - - 0 1",
    move: parseUci("e2e4")!,
    san: "e4",
    halfMoves: 1,
  });
  const e5 = createNode({
    fen: "after-e5 w - - 0 1",
    move: parseUci("e7e5")!,
    san: "e5",
    halfMoves: 2,
  });
  const nf3 = createNode({
    fen: "after-nf3 b - - 1 2",
    move: parseUci("g1f3")!,
    san: "Nf3",
    halfMoves: 3,
  });
  e5.children = [nf3];
  e4.children = [e5];
  tree.root.children = [e4];
  const store = createTreeStore();
  store.setState({
    ...store.getState(),
    root: tree.root,
    headers: tree.headers,
    position: [0],
  });
  const nodeIndex = createNotationNodeIndex(tree.root);
  const cell = (node: TreeNode, isCurrent: boolean) => (
    <CompleteMoveCell
      node={node}
      nodeIndex={nodeIndex}
      root={tree.root}
      halfMoves={node.halfMoves}
      move={node.san}
      fen={node.fen}
      comment=""
      annotations={[]}
      showComments={false}
      isCurrentVariation={isCurrent}
    />
  );
  await act(async () => {
    root.render(
      <TreeStateContext.Provider value={store}>
        <WorkspaceTabScope tabId="tab">
          {cell(e4, true)}
          {cell(e5, false)}
          {cell(nf3, false)}
        </WorkspaceTabScope>
      </TreeStateContext.Provider>,
    );
  });
  const moveButton = (san: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("[data-move]")].find(
      (button) => button.dataset.move === san,
    )!;
  return { store, analysisRoot: tree.root, moveButton };
}

test("an analysis tab offers Play from here on a non-current move and calls it with that path", async () => {
  const { store, analysisRoot, moveButton } = await renderPlayFromHereLine("analysis");
  expect(store.getState().position).toEqual([0]);

  await act(async () => {
    moveButton("e5").dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
  });

  const items = [...host.querySelectorAll<HTMLButtonElement>("[data-menu-item]")];
  expect(items[0]?.textContent).toBe("Board.Action.PlayFromHere");
  await act(async () => items[0]!.click());
  expect(playFromHere).toHaveBeenCalledExactlyOnceWith(analysisRoot, "black", [0, 0]);
});

test("Play from here does not fire after the tree root has been replaced", async () => {
  const { store, analysisRoot, moveButton } = await renderPlayFromHereLine("analysis");
  await act(async () => {
    moveButton("e5").dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
  });
  store.setState({ root: { ...analysisRoot } });
  await act(async () => {
    [...host.querySelectorAll<HTMLButtonElement>("[data-menu-item]")]
      .find((item) => item.textContent === "Board.Action.PlayFromHere")!
      .click();
  });
  expect(playFromHere).not.toHaveBeenCalled();
});

test("a play tab omits Play from here from the move menu", async () => {
  const { moveButton } = await renderPlayFromHereLine("play");
  await act(async () => {
    moveButton("e5").dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
  });
  expect(
    [...host.querySelectorAll("[data-menu-item]")].map((item) => item.textContent),
  ).not.toContain("Board.Action.PlayFromHere");
});

test("the open-variation mark follows its flag on an unchanged node, also under the open move menu", async () => {
  moveCell.useReal = true;
  const tree = defaultTree();
  const mainMove = createNode({
    fen: "main b - - 0 1",
    move: parseUci("e2e4")!,
    san: "e4",
    halfMoves: 1,
  });
  const sideMove = createNode({
    fen: "side b - - 0 1",
    move: parseUci("d2d4")!,
    san: "d4",
    halfMoves: 1,
  });
  tree.root.children = [mainMove, sideMove];
  const store = createTreeStore();
  store.setState({ root: tree.root });
  const nodeIndex = createNotationNodeIndex(tree.root);
  const annotations: [] = [];
  const render = (openVariation: boolean) =>
    act(async () =>
      root.render(
        <TreeStateContext.Provider value={store}>
          <WorkspaceTabScope tabId="tab">
            <CompleteMoveCell
              node={sideMove}
              nodeIndex={nodeIndex}
              root={tree.root}
              halfMoves={1}
              move="d4"
              fen={sideMove.fen}
              comment=""
              annotations={annotations}
              showComments={false}
              isStart={false}
              isCurrentVariation={false}
              openVariation={openVariation}
            />
          </WorkspaceTabScope>
        </TreeStateContext.Provider>,
      ),
    );
  const marked = () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "d4")
      ?.getAttribute("data-notation-open-variation");

  await render(false);
  expect(marked()).toBeNull();

  // Only the flag changes: the memo comparator must let the cell through.
  await render(true);
  expect(marked()).toBe("true");

  await act(async () =>
    host
      .querySelector("[data-notation-open-variation]")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
  );
  expect(host.querySelector("[data-menu]")).not.toBeNull();
  expect(marked()).toBe("true");

  await render(false);
  expect(marked()).toBeNull();
});

test("O0: matches four-field and Shredder-castling spellings with standard FENs in the open chapter", async () => {
  for (const [variantFen, standardFen] of [
    [
      "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -",
      "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    ],
    [
      "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b HAha - 0 1",
      "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 4 3",
    ],
  ] as const) {
    const tree = defaultTree(variantFen);
    const branchA = createNode({
      fen: variantFen,
      move: parseUci("e2e4")!,
      san: "e4",
      halfMoves: 1,
    });
    const branchB = createNode({
      fen: standardFen,
      move: parseUci("d2d4")!,
      san: "d4",
      halfMoves: 1,
    });
    tree.root.children = [branchA, branchB];
    const store = createTreeStore();
    store.setState({ ...store.getState(), root: tree.root });

    const { getMemoizedBoardStateMap } = await import("@/utils/treeReducer");
    const key = getBoardState(standardFen);
    expect(getMemoizedBoardStateMap(tree.root)[key].map(({ path }) => path)).toEqual([
      [],
      [0],
      [1],
    ]);

    await act(async () => {
      root.render(
        <TreeStateContext.Provider value={store}>
          <WorkspaceTabScope tabId="tab">
            <CompleteMoveCell
              node={branchA}
              nodeIndex={createNotationNodeIndex(tree.root)}
              root={tree.root}
              halfMoves={branchA.halfMoves}
              move={branchA.san}
              fen={branchA.fen}
              comment=""
              annotations={[]}
              showComments={false}
            />
          </WorkspaceTabScope>
        </TreeStateContext.Provider>,
      );
    });

    const marker = host.querySelector<HTMLButtonElement>('[aria-label="Notation.Transposition"]');
    expect(marker).not.toBeNull();
    await act(async () => {
      marker!.click();
    });
    expect(store.getState().position).toEqual([1]);
  }
});

test("O3: file-wide transposition label, switch call, revision guard, and non-file/no-switcher fallback", async () => {
  const fileHandle = { id: { id: "repertoire-file" }, kind: "fileWorkspace" } as const;
  const fileTab: FileBackedTab = {
    value: "tab",
    name: "Chapter 2",
    type: "analysis",
    gameOrigin: {
      kind: "file",
      gameNumber: 1,
      file: {
        type: "file",
        handle: fileHandle,
        name: "openings.pgn",
        numGames: 2,
        metadata: { type: "repertoire", tags: [] },
        lastModified: 1,
      },
    },
  };
  const ch0 = '[White "Italian Base"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 *';
  // Chapter 1 on disk also holds the side line `2... c5 3. Nc3 Nc6`; its indexed occurrences must be
  // ignored while chapter 1 is the open chapter (the open tree is the sole authority for its own
  // chapter).
  const ch1 = '[White "Transposing Order"]\n\n1. Nf3 Nc6 2. e4 e5 (2... c5 3. Nc3 Nc6) *';
  mocks.countPgnGames.mockResolvedValue(2);
  mocks.readGames.mockResolvedValue([
    { pgn: ch0, stamp: "s0", revision: "rev-1", present: true, omission: null, linked: null },
    { pgn: ch1, stamp: "s1", revision: "rev-1", present: true, omission: null, linked: null },
  ]);

  const { finished } = requestFilePositionIndex(fileTab.gameOrigin.file, "rev-1");
  expect(await finished).toBe("built");

  const store = createTreeStore();
  const parsedCh1 = await (await import("@/utils/chess")).parsePGN(ch1);
  // Add an in-chapter transposition at another variation to test plain label precedence too.
  const altFirst = createNode({
    fen: "alt-only b - - 0 1",
    move: parseUci("d2d4")!,
    san: "d4",
    halfMoves: 1,
  });
  const sharedOpen = createNode({
    fen: "open-only w - - 0 1",
    move: parseUci("d7d5")!,
    san: "d5",
    halfMoves: 2,
  });
  const duplicateOpen = createNode({
    fen: "open-only w - - 0 1",
    move: parseUci("c2c4")!,
    san: "c4",
    halfMoves: 1,
  });
  altFirst.children = [sharedOpen];
  parsedCh1.root.children.push(altFirst, duplicateOpen);
  store.setState({ ...store.getState(), root: parsedCh1.root });

  const targetMove = store.getState().getNode([0, 0, 0, 0])!; // 2...e5 reaching 1.e4 e5 2.Nf3 Nc6
  const nodeIndex = createNotationNodeIndex(parsedCh1.root);
  const switchChapter = vi.fn().mockResolvedValue(undefined);
  mocks.tabs = [fileTab];
  mocks.switchChapter = switchChapter;
  setFileFreshness("tab", "verified", { verifiedRevision: "rev-1" });

  const renderMove = async (node: TreeNode) => {
    await act(async () => {
      root.render(
        <TreeStateContext.Provider value={store}>
          <WorkspaceTabScope tabId="tab">
            <CompleteMoveCell
              node={node}
              nodeIndex={nodeIndex}
              root={parsedCh1.root}
              halfMoves={node.halfMoves}
              move={node.san}
              fen={node.fen}
              comment=""
              annotations={[]}
              showComments={false}
            />
          </WorkspaceTabScope>
        </TreeStateContext.Provider>,
      );
    });
  };

  // 1. Verified file-backed analysis tab with switcher: names the other chapter and switches on click.
  await renderMove(targetMove);
  const fileMarker = host.querySelector<HTMLButtonElement>(
    '[aria-label="Notation.TranspositionInChapter(Italian Base)"]',
  );
  expect(fileMarker).not.toBeNull();
  await act(async () => {
    fileMarker!.click();
  });
  expect(switchChapter).toHaveBeenCalledTimes(1);
  expect(switchChapter).toHaveBeenCalledWith(0, {
    path: [0, 0, 0, 0],
    boardState: getBoardState(targetMove.fen),
  });

  // 2. Open-chapter target keeps the plain label, and same-chapter index entries are excluded.
  await renderMove(duplicateOpen);
  expect(host.querySelector('[aria-label="Notation.Transposition"]')).not.toBeNull();
  expect(host.querySelector('[aria-label^="Notation.TranspositionInChapter"]')).toBeNull();

  // Open tree edited to have 1. d4 without the indexed `c5/Nc3` variation: chapter 1 in index is excluded.
  const openOnlyD4 = createNode({
    fen: store.getState().getNode([0, 0, 0, 1, 0])!.fen,
    move: parseUci("d2d4")!,
    san: "d4",
    halfMoves: 1,
  });
  const prunedRoot = { ...parsedCh1.root, children: [openOnlyD4] };
  await act(async () => {
    root.render(
      <TreeStateContext.Provider value={store}>
        <WorkspaceTabScope tabId="tab">
          <CompleteMoveCell
            node={openOnlyD4}
            nodeIndex={createNotationNodeIndex(prunedRoot)}
            root={prunedRoot}
            halfMoves={openOnlyD4.halfMoves}
            move={openOnlyD4.san}
            fen={openOnlyD4.fen}
            comment=""
            annotations={[]}
            showComments={false}
          />
        </WorkspaceTabScope>
      </TreeStateContext.Provider>,
    );
  });
  expect(host.querySelector('[aria-label^="Notation.Transposition"]')).toBeNull();

  // 3. Revision null hides the file-wide marker.
  await renderMove(targetMove);
  expect(
    host.querySelector('[aria-label="Notation.TranspositionInChapter(Italian Base)"]'),
  ).not.toBeNull();
  await act(async () => {
    setFileFreshness("tab", "unverified");
  });
  expect(host.querySelector('[aria-label^="Notation.Transposition"]')).toBeNull();

  // 4. Mismatched verifiedRevision hides the file-wide marker.
  await act(async () => {
    setFileFreshness("tab", "verified", { verifiedRevision: "rev-2" });
  });
  expect(host.querySelector('[aria-label^="Notation.Transposition"]')).toBeNull();

  // 5. Restoring rev-1 brings it back, and removing switcher or leaving file-backed tab hides it.
  await act(async () => {
    setFileFreshness("tab", "verified", { verifiedRevision: "rev-1" });
  });
  expect(
    host.querySelector('[aria-label="Notation.TranspositionInChapter(Italian Base)"]'),
  ).not.toBeNull();

  // Remount with a fresh cell root when changing mocked non-reactive provider values.
  const remountMove = async (node: TreeNode) => {
    await act(async () => {
      root.render(null);
    });
    await renderMove(node);
  };

  mocks.switchChapter = null;
  await remountMove(targetMove);
  expect(host.querySelector('[aria-label^="Notation.Transposition"]')).toBeNull();

  mocks.switchChapter = switchChapter;
  mocks.tabs = [{ value: "tab", name: "Play", type: "play", gameOrigin: { kind: "none" } }];
  await remountMove(targetMove);
  expect(host.querySelector('[aria-label^="Notation.Transposition"]')).toBeNull();
});

test("O3: shared opening moves across chapters stay unmarked while different move orders mark, and stale-root clicks do not switch", async () => {
  const fileHandle = { id: { id: "shared-opening-file" }, kind: "fileWorkspace" } as const;
  const fileTab: FileBackedTab = {
    value: "tab",
    name: "Shared vs Detour",
    type: "analysis",
    gameOrigin: {
      kind: "file",
      gameNumber: 1,
      file: {
        type: "file",
        handle: fileHandle,
        name: "shared.pgn",
        numGames: 2,
        metadata: { type: "repertoire", tags: [] },
        lastModified: 1,
      },
    },
  };
  const ch0 = '[White "Italian Base"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 *';
  const ch1 = '[White "Main Plus Detour"]\n\n1. e4 e5 2. Nf3 Nc6 *';
  mocks.countPgnGames.mockResolvedValue(2);
  mocks.readGames.mockResolvedValue([
    { pgn: ch0, stamp: "s0", revision: "rev-shared", present: true, omission: null, linked: null },
    { pgn: ch1, stamp: "s1", revision: "rev-shared", present: true, omission: null, linked: null },
  ]);

  const { finished } = requestFilePositionIndex(fileTab.gameOrigin.file, "rev-shared");
  expect(await finished).toBe("built");

  const { parsePGN } = await import("@/utils/chess");
  const parsedCh1 = await parsePGN(ch1);

  const store = createTreeStore();
  store.setState({ ...store.getState(), root: parsedCh1.root });
  const nodeIndex = createNotationNodeIndex(parsedCh1.root);
  const sharedMove = store.getState().getNode([0, 0, 0, 0])!; // 1.e4 e5 2.Nf3 Nc6 (same move order as ch0)
  const switchChapter = vi.fn().mockResolvedValue(undefined);
  mocks.tabs = [fileTab];
  mocks.switchChapter = switchChapter;
  setFileFreshness("tab", "verified", { verifiedRevision: "rev-shared" });

  await act(async () => {
    root.render(
      <TreeStateContext.Provider value={store}>
        <WorkspaceTabScope tabId="tab">
          <CompleteMoveCell
            node={sharedMove}
            nodeIndex={nodeIndex}
            root={parsedCh1.root}
            halfMoves={sharedMove.halfMoves}
            move={sharedMove.san}
            fen={sharedMove.fen}
            comment=""
            annotations={[]}
            showComments={false}
          />
        </WorkspaceTabScope>
      </TreeStateContext.Provider>,
    );
  });
  expect(host.querySelector('[aria-label^="Notation.Transposition"]')).toBeNull();

  // Different move order in chapter 1 keeps its marker, and clicking after store root change is ignored.
  const detourHandle = { id: { id: "detour-opening-file" }, kind: "fileWorkspace" } as const;
  const detourTab: FileBackedTab = {
    ...fileTab,
    gameOrigin: {
      kind: "file",
      gameNumber: 1,
      file: {
        type: "file",
        handle: detourHandle,
        name: "detour.pgn",
        numGames: 2,
        metadata: { type: "repertoire", tags: [] },
        lastModified: 1,
      },
    },
  };
  const detourCh1 = '[White "Detour"]\n\n1. Nf3 Nc6 2. e4 e5 *';
  mocks.readGames.mockResolvedValue([
    { pgn: ch0, stamp: "s0", revision: "rev-detour", present: true, omission: null, linked: null },
    {
      pgn: detourCh1,
      stamp: "s1",
      revision: "rev-detour",
      present: true,
      omission: null,
      linked: null,
    },
  ]);
  const { finished: detourFinished } = requestFilePositionIndex(
    detourTab.gameOrigin.file,
    "rev-detour",
  );
  expect(await detourFinished).toBe("built");

  const parsedDetour = await parsePGN(detourCh1);
  store.setState({ ...store.getState(), root: parsedDetour.root });
  const detourMove = store.getState().getNode([0, 0, 0, 0])!;
  mocks.tabs = [detourTab];

  await act(async () => {
    setFileFreshness("tab", "verified", { verifiedRevision: "rev-detour" });
    root.render(
      <TreeStateContext.Provider value={store}>
        <WorkspaceTabScope tabId="tab">
          <CompleteMoveCell
            node={detourMove}
            nodeIndex={createNotationNodeIndex(parsedDetour.root)}
            root={parsedDetour.root}
            halfMoves={detourMove.halfMoves}
            move={detourMove.san}
            fen={detourMove.fen}
            comment=""
            annotations={[]}
            showComments={false}
          />
        </WorkspaceTabScope>
      </TreeStateContext.Provider>,
    );
  });

  const marker = host.querySelector<HTMLButtonElement>(
    '[aria-label="Notation.TranspositionInChapter(Italian Base)"]',
  );
  expect(marker).not.toBeNull();

  // Clicking the marker after the store's root changed must not switch chapters.
  store.setState({ ...store.getState(), root: defaultTree().root });
  await act(async () => {
    marker!.click();
  });
  expect(switchChapter).not.toHaveBeenCalled();
});

test("O3: cell mounted before index build completes shows the file-wide marker once the build finishes without remount", async () => {
  const fileHandle = { id: { id: "pending-index-file" }, kind: "fileWorkspace" } as const;
  const fileTab: FileBackedTab = {
    value: "tab",
    name: "King Knight Detour",
    type: "analysis",
    gameOrigin: {
      kind: "file",
      gameNumber: 1,
      file: {
        type: "file",
        handle: fileHandle,
        name: "pending.pgn",
        numGames: 2,
        metadata: { type: "repertoire", tags: [] },
        lastModified: 1,
      },
    },
  };
  const ch0 = '[White "Italian Base"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 *';
  const ch1 = '[White "King Knight Detour"]\n\n1. Nf3 Nc6 2. e4 e5 *';

  let resolveReadGames!: (value: unknown) => void;
  mocks.countPgnGames.mockResolvedValue(2);
  mocks.readGames.mockReturnValue(
    new Promise((resolve) => {
      resolveReadGames = resolve;
    }),
  );

  const { parsePGN } = await import("@/utils/chess");
  const parsedCh1 = await parsePGN(ch1);
  const store = createTreeStore();
  store.setState({ ...store.getState(), root: parsedCh1.root });
  const targetMove = store.getState().getNode([0, 0, 0, 0])!;
  const nodeIndex = createNotationNodeIndex(parsedCh1.root);

  mocks.tabs = [fileTab];
  mocks.switchChapter = vi.fn().mockResolvedValue(undefined);
  setFileFreshness("tab", "verified", { verifiedRevision: "rev-pending" });

  const { finished } = requestFilePositionIndex(fileTab.gameOrigin.file, "rev-pending");

  await act(async () => {
    root.render(
      <TreeStateContext.Provider value={store}>
        <WorkspaceTabScope tabId="tab">
          <CompleteMoveCell
            node={targetMove}
            nodeIndex={nodeIndex}
            root={parsedCh1.root}
            halfMoves={targetMove.halfMoves}
            move={targetMove.san}
            fen={targetMove.fen}
            comment=""
            annotations={[]}
            showComments={false}
          />
        </WorkspaceTabScope>
      </TreeStateContext.Provider>,
    );
  });

  expect(host.querySelector('[aria-label^="Notation.Transposition"]')).toBeNull();

  await act(async () => {
    resolveReadGames([
      {
        pgn: ch0,
        stamp: "s0",
        revision: "rev-pending",
        present: true,
        omission: null,
        linked: null,
      },
      {
        pgn: ch1,
        stamp: "s1",
        revision: "rev-pending",
        present: true,
        omission: null,
        linked: null,
      },
    ]);
    expect(await finished).toBe("built");
  });

  expect(
    host.querySelector('[aria-label="Notation.TranspositionInChapter(Italian Base)"]'),
  ).not.toBeNull();
});
