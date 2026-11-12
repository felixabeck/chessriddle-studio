import { parseUci } from "chessops";
import { Chess } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import { parseSan } from "chessops/san";
import { beforeEach, expect, test, vi } from "vitest";
import { buildFromTree, syncDeck, updateCardPerformance } from "@/components/files/opening";
import type { TreeStore } from "@/state/store/tree";
import type { Tab } from "@/utils/tabs";
import { createNode, defaultTree, getBoardState, type TreeNode } from "@/utils/treeReducer";
import { collectRetainedPracticePositions } from "./retainedPositions";

const trees = vi.hoisted(() => ({ cached: vi.fn(), read: vi.fn(), status: vi.fn() }));
vi.mock("@/state/store/tree", () => ({ getCachedTreeStore: trees.cached }));
vi.mock("@/state/store/tabStorage", () => ({
    tabStorage: { readForClone: trees.read, getStatus: trees.status },
}));

function tab(value: string, file = "file-a", gameNumber = 0, treeKey?: string): Tab {
    return {
        value,
        name: value,
        type: "analysis",
        treeKey,
        gameOrigin: {
            kind: "file",
            gameNumber,
            file: {
                type: "file",
                handle: { id: { id: file }, kind: "fileWorkspace" },
                name: "opening.pgn",
                numGames: 2,
                metadata: { type: "repertoire", tags: [] },
                lastModified: 0,
            },
        },
    };
}

function practiceTree() {
    const root = defaultTree().root;
    const node = createNode({
        fen: "8/8/8/8/8/8/4P3/K6k w - - 0 2",
        halfMoves: 2,
        move: parseUci("h2h1")!,
        san: "Kh1",
    });
    node.children.push(
        createNode({
            fen: "8/8/8/8/4P3/8/8/K6k b - - 0 2",
            halfMoves: 3,
            move: parseUci("e2e4")!,
            san: "e4",
        }),
    );
    node.children[0].children.push(
        createNode({
            fen: "8/8/8/8/4P2k/8/8/K7 w - - 1 3",
            halfMoves: 4,
            move: parseUci("h1h4")!,
            san: "Kh4",
        }),
    );
    root.children.push(node);
    return root;
}

beforeEach(() => {
    trees.cached.mockReset();
    trees.read.mockReset().mockReturnValue(null);
    trees.status.mockReset().mockReturnValue({ kind: "available" });
});

test.each(["cached", "storage", "legacy storage"])(
    "collects only another tab on the same file and game from %s",
    (source) => {
        const root = practiceTree();
        const other = tab(
            "other",
            "file-a",
            0,
            source === "legacy storage" ? undefined : "tree-key",
        );
        const absent = tab("absent");
        if (source === "cached") {
            trees.cached.mockImplementation((id: string) =>
                id === other.value ? ({ getState: () => ({ root }) } as TreeStore) : undefined,
            );
        } else {
            trees.read.mockImplementation((key: string) =>
                key === (other.treeKey ?? other.value) ? { root } : null,
            );
        }

        const result = collectRetainedPracticePositions({
            tabs: [
                tab("current"),
                tab("different-game", "file-a", 1),
                tab("different-file", "file-b"),
                { ...tab("scratch"), gameOrigin: { kind: "none" } },
                other,
                absent,
            ],
            currentTabId: "current",
            identity: { file: "file-a", game: 0 },
            existing: [],
        });

        expect(result).toEqual(
            new Set(
                [...buildFromTree(root, "white", []), ...buildFromTree(root, "black", [])].map(
                    ({ fen }) => getBoardState(fen),
                ),
            ),
        );
        expect(result.size).toBe(2);
        expect(trees.status.mock.calls).toEqual(source === "cached" ? [["tree-key"]] : []);
        expect(trees.cached.mock.calls).toEqual([["other"], ["absent"]]);
        expect(trees.read.mock.calls).toEqual(
            source === "cached"
                ? [["absent", false]]
                : [
                      [other.treeKey ?? other.value, other.treeKey !== undefined],
                      ["absent", false],
                  ],
        );
    },
);

test("other tab positions include both orientations and every variation", () => {
    const root = practiceTree();
    root.children.push(...practiceTree().children);
    root.children[1].children[0].fen = "8/8/8/8/3P4/8/8/K6k b - - 0 2";
    trees.read.mockReturnValue({ root });

    const result = collectRetainedPracticePositions({
        tabs: [tab("other")],
        currentTabId: "current",
        identity: { file: "file-a", game: 0 },
        existing: [],
    });

    expect(result).toEqual(
        new Set([
            getBoardState(root.children[0].fen),
            getBoardState(root.children[0].children[0].fen),
            getBoardState(root.children[1].children[0].fen),
        ]),
    );
});

test.each(["cached", "storage"])("an unreadable %s tree retains every existing card", (source) => {
    const existing = buildFromTree(practiceTree(), "white", []);
    const fail = () => {
        throw new Error("tree unavailable");
    };
    if (source === "cached") trees.cached.mockReturnValue({ getState: fail });
    else trees.read.mockImplementation(fail);

    const result = collectRetainedPracticePositions({
        tabs: [tab("other")],
        currentTabId: "current",
        identity: { file: "file-a", game: 0 },
        existing,
    });

    expect(result).toEqual(new Set(existing.map(({ fen }) => getBoardState(fen))));
    expect(result.size).toBe(1);
});

function addLine(root: TreeNode, moves: string[]) {
    const position = Chess.fromSetup(parseFen(root.fen).unwrap()).unwrap();
    let node = root;
    for (const san of moves) {
        const move = parseSan(position, san)!;
        expect(move).toBeDefined();
        position.play(move);
        const child = createNode({
            fen: makeFen(position.toSetup()),
            halfMoves: node.halfMoves + 1,
            move,
            san,
        });
        node.children.push(child);
        node = child;
    }
}

function ratedBb5Deck(root: TreeNode) {
    const deck = buildFromTree(root, "white", []);
    const index = deck.findIndex(({ answer }) => answer === "Bb5");
    expect(index).toBeGreaterThanOrEqual(0);
    const rated = updateCardPerformance(deck, index, deck[index].card, 3)!.positions;
    expect(rated[index].card.reps).toBeGreaterThan(0);
    return { rated, bb5: rated[index] };
}

test.each([
    { name: "main line", variation: false, start: [] },
    { name: "variation outside the syncing Start", variation: true, start: [0, 0] },
])("real sync retains the rated Bb5 card in another tab's $name", ({ variation, start }) => {
    const treeA = defaultTree().root;
    const treeB = defaultTree().root;
    if (variation) {
        addLine(treeA, ["d4", "d5", "c4"]);
        addLine(treeB, ["d4", "d5", "c4"]);
    }
    addLine(treeA, ["e4", "e5", "Nf3", "Nc6", "Bb5"]);
    addLine(treeB, ["e4", "e5", "Nf3", "Nc6"]);
    const { rated, bb5 } = ratedBb5Deck(treeA);
    trees.cached.mockReturnValue({ getState: () => ({ root: treeA }) });
    // Sync scope belongs to B. Passing the shared context must not scope A's independent tree.
    const context = {
        tabs: [tab("B"), tab("A", "file-a", 0, "tree-A")],
        currentTabId: "B",
        identity: { file: "file-a", game: 0 },
        orientation: "white" as const,
        start,
        existing: rated,
    };

    const result = syncDeck(rated, treeB, context.orientation, context.start, () =>
        collectRetainedPracticePositions(context),
    );

    expect(result.removed).toBe(0);
    const kept = result.positions.find(({ fen }) => getBoardState(fen) === getBoardState(bb5.fen));
    expect(kept).toBe(bb5);
    expect(kept?.card).toEqual(bb5.card);
    expect(kept?.card).toMatchObject({
        reps: bb5.card.reps,
        due: bb5.card.due,
        stability: bb5.card.stability,
    });
    expect(trees.status).toHaveBeenCalledWith("tree-A");
    expect(trees.read).not.toHaveBeenCalled();
});

test.each(["unreadable", "not-read", "unavailable"])(
    "real sync retains every existing card when the cached tree is %s",
    (kind) => {
        const treeA = defaultTree().root;
        addLine(treeA, ["e4", "e5", "Nf3", "Nc6", "Bb5"]);
        const { rated } = ratedBb5Deck(treeA);
        const getState = vi.fn(() => defaultTree());
        trees.cached.mockReturnValue({ getState });
        trees.status.mockReturnValue({ kind });
        const context = {
            tabs: [tab("A", "file-a", 0, "tree-A")],
            currentTabId: "B",
            identity: { file: "file-a", game: 0 },
            orientation: "white" as const,
            start: [],
            existing: rated,
        };

        const result = syncDeck(rated, defaultTree().root, "white", [], () =>
            collectRetainedPracticePositions(context),
        );

        expect(result.removed).toBe(0);
        expect(result.positions).toEqual(rated);
        for (const [index, card] of rated.entries()) expect(result.positions[index]).toBe(card);
        expect(getState).not.toHaveBeenCalled();
        expect(trees.status).toHaveBeenCalledWith("tree-A");
        expect(trees.read).not.toHaveBeenCalled();
    },
);

test.each(["available", "absent"])("a %s cached tree is authoritative", (kind) => {
    const treeA = defaultTree().root;
    addLine(treeA, ["e4", "e5", "Nf3", "Nc6", "Bb5"]);
    const { rated } = ratedBb5Deck(treeA);
    trees.cached.mockReturnValue({ getState: () => defaultTree() });
    trees.status.mockReturnValue({ kind });

    const result = syncDeck(rated, defaultTree().root, "white", [], () =>
        collectRetainedPracticePositions({
            tabs: [tab("A")],
            currentTabId: "B",
            identity: { file: "file-a", game: 0 },
            existing: rated,
        }),
    );

    expect(result.positions).toEqual([]);
    expect(result.removed).toBe(rated.length);
    expect(trees.status).toHaveBeenCalledWith("A");
});

test.each([
    { name: "another game", file: "file-a", game: 1 },
    { name: "another file", file: "file-b", game: 0 },
])("real sync removes the rated Bb5 card when A is on $name", ({ file, game }) => {
    const treeA = defaultTree().root;
    const treeB = defaultTree().root;
    addLine(treeA, ["e4", "e5", "Nf3", "Nc6", "Bb5"]);
    addLine(treeB, ["e4", "e5", "Nf3", "Nc6"]);
    const { rated, bb5 } = ratedBb5Deck(treeA);
    trees.cached.mockReturnValue({ getState: () => ({ root: treeA }) });

    const result = syncDeck(rated, treeB, "white", [], () =>
        collectRetainedPracticePositions({
            tabs: [tab("A", file, game)],
            currentTabId: "B",
            identity: { file: "file-a", game: 0 },
            existing: rated,
        }),
    );

    expect(result.removed).toBe(1);
    expect(result.positions.some(({ fen }) => getBoardState(fen) === getBoardState(bb5.fen))).toBe(
        false,
    );
    expect(trees.cached).not.toHaveBeenCalled();
    expect(trees.status).not.toHaveBeenCalled();
    expect(trees.read).not.toHaveBeenCalled();
});
