import { Provider, createStore as createAtomStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FileWorkspaceHandle } from "@/bindings";
import { useRepertoireNote } from "@/hooks/useRepertoireNote";
import { fileWorkspaceAtom, sessionsAtom } from "@/state/atoms";
import type {
  IndexedRepertoireChapter,
  RepertoireChapterNode,
  RepertoirePartialReason,
  RepertoireSnapshot,
} from "@/state/repertoireIndex";
import { createTreeStore } from "@/state/store/tree";
import { reportRootFingerprint } from "@/utils/chess";
import type { RepertoireComparison } from "@/utils/gameReviewRepertoire";
import type { LichessAccount } from "@/utils/lichess/api";
import type { GameHeaders, TreeNode } from "@/utils/treeReducer";
import { getBoardState } from "@/utils/treeReducer";

const mocks = vi.hoisted(() => ({
  refreshRepertoireIndex: vi.fn(),
  readRepertoireIndex: vi.fn(),
}));

vi.mock("@/state/repertoireIndex", () => ({
  refreshRepertoireIndex: mocks.refreshRepertoireIndex,
  readRepertoireIndex: mocks.readRepertoireIndex,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const ws1: FileWorkspaceHandle = { id: { id: "ws-1" }, kind: "fileWorkspace" };
const ws2: FileWorkspaceHandle = { id: { id: "ws-2" }, kind: "fileWorkspace" };

function buildChapter(moves: string[], orientation: "white" | "black"): IndexedRepertoireChapter {
  const store = createTreeStore();
  store.getState().makeMoves({ payload: moves });
  const nodes: RepertoireChapterNode[] = [];
  function visit(node: TreeNode, parent: number, path: number[]) {
    const index = nodes.length;
    nodes.push({
      boardState: getBoardState(node.fen),
      parent,
      san: node.san,
      path,
      halfMoves: node.halfMoves,
      hasContinuation: node.children.length > 0,
    });
    node.children.forEach((child, i) => visit(child, index, [...path, i]));
  }
  visit(store.getState().root, -1, []);
  return {
    chapter: 0,
    headers: { orientation, start: undefined, white: "", black: "", event: "" },
    nodes,
  };
}

function makeSnapshot(
  moves: string[],
  orientation: "white" | "black" = "white",
  partial = false,
  partialReason: RepertoirePartialReason | null = null,
): RepertoireSnapshot {
  return {
    partial,
    partialReason,
    files: [
      {
        workspaceKey: "ws-1",
        file: {
          type: "file",
          name: "My Repertoire",
          numGames: 1,
          lastModified: 0,
          handle: ws1,
          metadata: { type: "repertoire", tags: [] },
        },
        chapters: [buildChapter(moves, orientation)],
        partial: false,
      },
    ],
  };
}

function makeGame(moves: string[], headersPatch: Partial<GameHeaders> = {}) {
  const store = createTreeStore();
  store.getState().makeMoves({ payload: moves, mainline: true });
  const root = store.getState().root;
  const headers: GameHeaders = { ...store.getState().headers, ...headersPatch };
  const fingerprint = reportRootFingerprint(root.fen, moves);
  return { root, headers, fingerprint };
}

let host: HTMLDivElement;
let root: Root;
let atoms: ReturnType<typeof createAtomStore>;
let latest: RepertoireComparison | null = null;

function Harness({
  gameRoot,
  headers,
  fingerprint,
}: {
  gameRoot: TreeNode;
  headers: GameHeaders;
  fingerprint: string;
}) {
  latest = useRepertoireNote({ root: gameRoot, headers, fingerprint });
  return null;
}

async function renderHarness(game: { root: TreeNode; headers: GameHeaders; fingerprint: string }) {
  await act(async () => {
    root.render(
      <Provider store={atoms}>
        <Harness gameRoot={game.root} headers={game.headers} fingerprint={game.fingerprint} />
      </Provider>,
    );
  });
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  atoms = createAtomStore();
  latest = null;
  mocks.refreshRepertoireIndex.mockReset();
  mocks.readRepertoireIndex.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("useRepertoireNote", () => {
  test("hides the note while refreshing and hides stale note immediately when fingerprint changes", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    mocks.refreshRepertoireIndex
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    mocks.readRepertoireIndex.mockReturnValue(null);

    atoms.set(fileWorkspaceAtom, ws1);
    const game1 = makeGame(["e4", "e5", "Qh5"]);
    await renderHarness(game1);
    expect(latest).toBeNull();

    // Even before refresh resolves, readRepertoireIndex returns null; once settled, note appears.
    mocks.readRepertoireIndex.mockReturnValue(makeSnapshot(["e4", "e5", "Nf3"]));
    await act(async () => {
      first.resolve();
      await first.promise;
    });
    await flushPromises();
    expect(latest).toMatchObject({ kind: "deviation", repertoireMoves: ["Nf3"] });

    // Fingerprint changes: note hides immediately while the new refresh runs.
    mocks.readRepertoireIndex.mockReturnValue(null);
    const game2 = makeGame(["d4", "d5"]);
    await renderHarness(game2);
    expect(latest).toBeNull();

    mocks.readRepertoireIndex.mockReturnValue(makeSnapshot(["d4", "d5"]));
    await act(async () => {
      second.resolve();
      await second.promise;
    });
    await flushPromises();
    expect(latest).toMatchObject({ kind: "followed" });
  });

  test("discards a result for a changed workspace", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    mocks.refreshRepertoireIndex
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    mocks.readRepertoireIndex.mockImplementation((ws: FileWorkspaceHandle | null) =>
      ws === ws1 ? makeSnapshot(["e4", "e5", "Nf3"]) : null,
    );

    atoms.set(fileWorkspaceAtom, ws1);
    const game = makeGame(["e4", "e5", "Qh5"]);
    await renderHarness(game);
    expect(latest).toBeNull();

    await act(async () => {
      atoms.set(fileWorkspaceAtom, ws2);
    });
    expect(latest).toBeNull();

    // First workspace refresh finishes late — must be discarded.
    await act(async () => {
      first.resolve();
      await first.promise;
    });
    await flushPromises();
    expect(latest).toBeNull();

    await act(async () => {
      second.resolve();
      await second.promise;
    });
    expect(latest).toBeNull();
  });

  test("discards a result for a changed fingerprint", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    mocks.refreshRepertoireIndex
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    mocks.readRepertoireIndex.mockReturnValue(makeSnapshot(["e4", "e5", "Nf3"]));

    atoms.set(fileWorkspaceAtom, ws1);
    const game1 = makeGame(["e4", "e5", "Qh5"]);
    await renderHarness(game1);
    expect(latest).toBeNull();

    const game2 = makeGame(["e4", "e5", "Nf3"]);
    await renderHarness(game2);
    expect(latest).toBeNull();

    await act(async () => {
      first.resolve();
      await first.promise;
    });
    await flushPromises();
    expect(latest).toBeNull();

    await act(async () => {
      second.resolve();
      await second.promise;
    });
    await flushPromises();
    expect(latest).toMatchObject({ kind: "followed" });
  });

  test("discards a result when the user's side changes (flipping orientation or updating accounts)", async () => {
    const refresh = deferred<void>();
    mocks.refreshRepertoireIndex.mockReturnValue(refresh.promise);
    mocks.readRepertoireIndex.mockReturnValue(makeSnapshot(["e4", "e5", "Nf3"], "white"));

    atoms.set(fileWorkspaceAtom, ws1);
    const gameWhite = makeGame(["e4", "e5", "Qh5"], { orientation: "white" });
    await renderHarness(gameWhite);
    expect(latest).toBeNull();

    // Side changes to Black while refresh is pending: when refresh settles, White note is not shown.
    const gameBlack = makeGame(["e4", "e5", "Qh5"], { orientation: "black" });
    await renderHarness(gameBlack);
    await act(async () => {
      refresh.resolve();
      await refresh.promise;
    });
    expect(latest).toEqual({ kind: "none" });

    // Account match switches side back to White, then removing account switches back to Black.
    await act(async () => {
      atoms.set(sessionsAtom, [
        {
          updatedAt: 1,
          lichess: { username: "Alice", account: {} as LichessAccount },
        },
      ]);
    });
    await renderHarness(makeGame(["e4", "e5", "Qh5"], { white: "Alice", orientation: "black" }));
    expect(latest).toMatchObject({ kind: "deviation", repertoireMoves: ["Nf3"] });

    await act(async () => {
      atoms.set(sessionsAtom, []);
    });
    expect(latest).toEqual({ kind: "none" });
  });

  test.each<RepertoirePartialReason>(["listing-failed", "read-failed", "bound-reached"])(
    "returns partial outcome for %s",
    async (reason) => {
      mocks.refreshRepertoireIndex.mockResolvedValue(undefined);
      mocks.readRepertoireIndex.mockReturnValue(makeSnapshot(["e4"], "white", true, reason));

      atoms.set(fileWorkspaceAtom, ws1);
      const game = makeGame(["e4", "e5"]);
      await renderHarness(game);
      await flushPromises();

      expect(latest).toEqual({ kind: "partial", reason });
    },
  );

  test("ignores a pending refresh that resolves after unmount", async () => {
    const refresh = deferred<void>();
    mocks.refreshRepertoireIndex.mockReturnValue(refresh.promise);
    mocks.readRepertoireIndex.mockReturnValue(makeSnapshot(["e4", "e5", "Nf3"]));

    atoms.set(fileWorkspaceAtom, ws1);
    const game = makeGame(["e4", "e5", "Qh5"]);
    await renderHarness(game);
    expect(latest).toBeNull();

    await act(async () => root.unmount());

    await act(async () => {
      refresh.resolve();
      await refresh.promise;
    });
    await flushPromises();

    expect(mocks.readRepertoireIndex).not.toHaveBeenCalled();
    expect(latest).toBeNull();
  });

  test("swallows a rejected refresh without settling a note", async () => {
    const refresh = deferred<void>();
    mocks.refreshRepertoireIndex.mockReturnValue(refresh.promise);
    mocks.readRepertoireIndex.mockReturnValue(makeSnapshot(["e4", "e5", "Nf3"]));

    atoms.set(fileWorkspaceAtom, ws1);
    const game = makeGame(["e4", "e5", "Qh5"]);
    await renderHarness(game);
    expect(latest).toBeNull();

    await act(async () => {
      refresh.reject(new Error("index failed"));
    });
    await flushPromises();

    expect(mocks.readRepertoireIndex).not.toHaveBeenCalled();
    expect(latest).toBeNull();
  });

  test("refreshes with null and settles no snapshot when fileWorkspaceAtom is null", async () => {
    mocks.refreshRepertoireIndex.mockResolvedValue(undefined);
    mocks.readRepertoireIndex.mockReturnValue(makeSnapshot(["e4", "e5", "Nf3"]));

    atoms.set(fileWorkspaceAtom, null);
    const game = makeGame(["e4", "e5", "Qh5"]);
    await renderHarness(game);
    await flushPromises();

    expect(mocks.refreshRepertoireIndex).toHaveBeenCalledTimes(1);
    expect(mocks.refreshRepertoireIndex).toHaveBeenCalledWith(null);
    expect(mocks.readRepertoireIndex).not.toHaveBeenCalled();
    expect(latest).toBeNull();
  });
});
