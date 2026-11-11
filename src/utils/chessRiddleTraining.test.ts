import { INITIAL_FEN, makeFen } from "chessops/fen";
import { expect, test, vi } from "vitest";
import type { TrainingPuzzle } from "@/bindings";
import {
    canSubmitTraining,
    trainingDecision,
    trainingPosition,
    trainingSan,
    walkTrainingLine,
    trainingAnalysisTree,
    trainingMoveNotice,
    trainingNeedsConfirmation,
    trainingDepth,
} from "./chessRiddleTraining";
import { createTab } from "./tabs";
import { deserializeStorageValue } from "@/state/store/debouncedStorage";
import { treeIteratorMainLine, type TreeState } from "./treeReducer";
import { createStore } from "jotai";
import { tabsAtom } from "@/state/atoms";
vi.mock("@/platform/tauri", () => ({
    tauri: {
        lexPgn: () => {
            throw new Error("The lexer must not be called");
        },
    },
}));

const puzzle: TrainingPuzzle = {
    id: 1,
    source: "tactics",
    preEntranceFen: INITIAL_FEN,
    entranceMove: "e2e4",
    decisionFen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    sideToMove: "black",
    puzzleRating: 1500,
    solutionPlyCount: 3,
};

test("entrance replay and SAN are anchored to Black and the FEN move number", () => {
    const custom = {
        ...puzzle,
        preEntranceFen: INITIAL_FEN.replace("0 1", "0 19"),
        decisionFen: puzzle.decisionFen.replace("0 1", "0 19"),
    };
    expect(trainingDecision(custom).turn).toBe("black");
    const steps = walkTrainingLine(custom.decisionFen, ["e7e5", "g1f3", "b8c6"]);
    expect(steps.map(({ turn, fullmoves }) => [turn, fullmoves])).toEqual([
        ["black", 19],
        ["white", 20],
        ["black", 20],
        ["white", 21],
    ]);
    expect(trainingSan(custom, ["e7e5", "g1f3", "b8c6"])).toEqual(["e5", "Nf3", "Nc6"]);
    expect(makeFen(trainingPosition(custom, ["e7e5"], 0).toSetup())).toBe(custom.decisionFen);
});

test("tree input gate navigates existing moves and enforces solver, depth and child limits", () => {
    const tree = trainingAnalysisTree(puzzle, ["e7e5", "g1f3", "b8c6"]);
    expect(trainingMoveNotice(tree, "e7e5", 3)).toEqual({ existing: 0 });
    expect(trainingMoveNotice(tree, "c7c5", 3)).toEqual({ notice: "oneSolverMove" });
    tree.position = [0];
    expect(trainingMoveNotice(tree, "f1c4", 3)).toEqual({});
    tree.position = [0, 0];
    expect(trainingMoveNotice(tree, "g8f6", 3)).toEqual({ notice: "oneSolverMove" });
    tree.position = [0, 0, 0];
    expect(trainingMoveNotice(tree, "f1c4", 3)).toEqual({ notice: "inputLimit" });
    expect(trainingMoveNotice(tree, "f1c4", 7)).toEqual({});
    expect(canSubmitTraining(tree, 3)).toBe(true);
    expect(canSubmitTraining(tree, 4)).toBe(false);
    expect(trainingDepth(tree.root)).toBe(3);
    expect(trainingNeedsConfirmation(tree.root)).toBe(false);
    tree.root.children[0].children.push(
        trainingAnalysisTree({ ...puzzle, decisionFen: tree.root.children[0].fen }, ["f1c4"]).root
            .children[0],
    );
    expect(trainingNeedsConfirmation(tree.root)).toBe(true);
    tree.root.children[0].children = Array(10).fill(tree.root.children[0].children[0]);
    tree.position = [0];
    expect(trainingMoveNotice(tree, "d2d4", 7)).toEqual({ notice: "inputLimit" });
    expect(() => trainingPosition(puzzle, [], 1)).toThrow("Invalid training cursor");
    expect(() => trainingDecision({ ...puzzle, entranceMove: "e2e5" })).toThrow(
        "Illegal training move",
    );
    expect(() => trainingDecision({ ...puzzle, decisionFen: INITIAL_FEN })).toThrow(
        "Inconsistent training position",
    );
    const seven = trainingAnalysisTree(puzzle, [
        "e7e5",
        "g1f3",
        "b8c6",
        "f1c4",
        "g8f6",
        "d2d3",
        "f8c5",
    ]);
    seven.position = Array(7).fill(0);
    expect(trainingMoveNotice(seven, "e1g1", 7)).toEqual({ notice: "inputLimit" });
});

test("terminal positions enable submit before the cap and solution walking validates legality", () => {
    const before = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
    const mating = {
        ...puzzle,
        preEntranceFen: "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2",
        entranceMove: "d8h4",
        decisionFen: before,
        sideToMove: "white" as const,
    };
    // Checkmate after an entered move, starting one ply earlier than the entrance above.
    const short = {
        ...puzzle,
        preEntranceFen: "rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2",
        entranceMove: "g2g4",
        decisionFen: "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2",
    };
    expect(canSubmitTraining({ ...trainingAnalysisTree(short, ["d8h4"]), position: [0] }, 7)).toBe(
        true,
    );
    expect(trainingDecision(mating).isCheckmate()).toBe(true);
    expect(walkTrainingLine(short.decisionFen, ["d8h4"])[1].san).toBe("Qh4#");
    expect(() => walkTrainingLine(short.decisionFen, ["d8h4", "a2a3"])).toThrow(
        "Illegal training move",
    );
});

test("promotions, en passant and castling use chess legality", () => {
    expect(walkTrainingLine("4k3/P7/8/8/8/8/8/4K3 w - - 0 1", ["a7a8n"])[1].san).toBe("a8=N");
    expect(walkTrainingLine("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2", ["e5d6"])[1].san).toBe("exd6");
    expect(walkTrainingLine("4k3/8/8/8/8/8/8/4K2R w K - 0 1", ["e1g1"])[1].san).toBe("O-O");
});

test.each([
    [puzzle.decisionFen, ["e7e5", "g1f3", "b8c6"], "black"],
    ["4k3/P7/8/8/8/8/8/4K3 w - - 0 19", ["a7a8n", "e8d7"], "white"],
    ["4k3/8/8/8/8/8/8/4K2R w K - 0 19", ["e1g1", "e8d7"], "white"],
] as const)(
    "Analyse creates a real tab with the complete legal mainline from %s",
    async (fen, line, side) => {
        const initialTree = trainingAnalysisTree(
            { ...puzzle, decisionFen: fen, sideToMove: side },
            line,
        );
        const store = createStore();
        const id = await createTab({
            tab: { name: "Analysis", type: "analysis" },
            setTabs: (value) => store.set(tabsAtom, value),
            initialTree,
        });
        expect(id).not.toBeNull();
        const stored = deserializeStorageValue(sessionStorage.getItem(id!)!) as {
            state: TreeState;
        };
        expect(stored.state.root.fen).toBe(fen);
        expect(stored.state.headers.orientation).toBe(side);
        expect(stored.state.position).toEqual([]);
        const actual = [...treeIteratorMainLine(stored.state.root)];
        const steps = walkTrainingLine(fen, line);
        expect(actual.map(({ node }) => node.fen)).toEqual(steps.map((step) => step.fen));
        expect(actual.slice(1).map(({ node }) => node.san)).toEqual(
            steps.slice(1).map((step) => step.san),
        );
        expect(actual.map(({ node }) => node.halfMoves)).toEqual(
            steps.map((_step, index) => initialTree.root.halfMoves + index),
        );
    },
);
