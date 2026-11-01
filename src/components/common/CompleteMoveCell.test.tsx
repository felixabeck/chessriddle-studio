import { WorkspaceTabScope, EphemeralTabScope } from "@/state/tabScope";
import { parseUci } from "chessops";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createTreeStore } from "@/state/store/tree";
import { createNode, defaultTree } from "@/utils/treeReducer";
import { TreeStateContext } from "./TreeStateContext";
import { createNotationNodeIndex } from "./notationRows";

const { currentTabAtom } = vi.hoisted(() => ({ currentTabAtom: Symbol("current-tab") }));

vi.mock("@/state/atoms", () => ({ tabsAtom: currentTabAtom, updateTabById: vi.fn() }));
vi.mock("jotai", () => ({
  useAtomValue: () => [{ value: "tab" }],
  useSetAtom: () => vi.fn(),
}));
vi.mock("@/utils/tabs", () => ({
  getTabFile: (tab: unknown) => (tab ? { metadata: { type: "repertoire" } } : undefined),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("lucide-react", () => {
  const Icon = () => null;
  return {
    Merge: Icon,
    ArrowUpRight: Icon,
    Copy: Icon,
    Flag: Icon,
    Trash2: Icon,
  };
});
vi.mock("@/components/common/Comment", () => ({
  default: ({ comment }: { comment: string }) => <span data-comment="true">{comment}</span>,
}));
vi.mock("@/components/common/IconAction", () => ({
  default: ({ children, label, onClick }: any) => (
    <button type="button" aria-label={label} onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("./MoveCell", async (importOriginal) => ({
  releasePointerFocus: (await importOriginal<typeof import("./MoveCell")>()).releasePointerFocus,
  default: ({ move, onClick, onContextMenu }: any) => (
    <button type="button" data-move={move} onClick={onClick} onContextMenu={onContextMenu}>
      {move}
    </button>
  ),
}));
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
    Box: ({ children, ...props }: any) => <span {...props}>{children}</span>,
    Menu,
    Portal: ({ children }: any) => <>{children}</>,
    Text: ({ children }: any) => <span>{children}</span>,
  };
});

import CompleteMoveCell from "./CompleteMoveCell";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
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
      scope === "workspace" ? 5 : 4,
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
