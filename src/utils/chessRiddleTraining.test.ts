import { INITIAL_FEN, makeFen } from "chessops/fen";
import { expect, test } from "vitest";
import type { TrainingPuzzle } from "@/bindings";
import {
    appendTrainingMove,
    canSubmitTraining,
    trainingDecision,
    trainingPosition,
    trainingSan,
    undoTrainingMove,
    walkTrainingLine,
} from "./chessRiddleTraining";

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

test("legal append, undo and input cap share the replay rules", () => {
    let line: string[] = [];
    for (const token of ["e7e5", "g1f3", "b8c6"])
        line = appendTrainingMove(puzzle, line, token, puzzle.solutionPlyCount);
    expect(canSubmitTraining(puzzle, line, puzzle.solutionPlyCount)).toBe(true);
    expect(() => appendTrainingMove(puzzle, line, "f1c4", puzzle.solutionPlyCount)).toThrow("full");
    const shorter = undoTrainingMove(line);
    expect(shorter).toEqual(["e7e5", "g1f3"]);
    expect(line).toHaveLength(3);
    expect(canSubmitTraining(puzzle, shorter, puzzle.solutionPlyCount)).toBe(false);
    expect(canSubmitTraining(puzzle, [], puzzle.solutionPlyCount)).toBe(false);
    for (const token of ["e7e4", "Nf6", "0000"])
        expect(() => appendTrainingMove(puzzle, [], token, puzzle.solutionPlyCount)).toThrow();
    expect(() => trainingPosition(puzzle, [], 1)).toThrow();
    expect(() => trainingDecision({ ...puzzle, entranceMove: "e2e5" })).toThrow();
    expect(() => trainingDecision({ ...puzzle, decisionFen: INITIAL_FEN })).toThrow();
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
    expect(canSubmitTraining(short, ["d8h4"], 7)).toBe(true);
    expect(trainingDecision(mating).isCheckmate()).toBe(true);
    expect(walkTrainingLine(short.decisionFen, ["d8h4"])[1].san).toBe("Qh4#");
    expect(() => walkTrainingLine(short.decisionFen, ["d8h4", "a2a3"])).toThrow();
});

test("input cap and submit threshold can grow after a too-short verdict", () => {
    let line = ["e7e5", "g1f3", "b8c6"];
    expect(canSubmitTraining(puzzle, line, 4)).toBe(false);
    line = appendTrainingMove(puzzle, line, "f1c4", 7);
    expect(canSubmitTraining(puzzle, line, 4)).toBe(true);
    line = appendTrainingMove(puzzle, line, "g8f6", 7);
    expect(canSubmitTraining(puzzle, line, 4)).toBe(true);
    line = appendTrainingMove(puzzle, line, "d2d3", 7);
    line = appendTrainingMove(puzzle, line, "f8c5", 7);
    expect(() => appendTrainingMove(puzzle, line, "e1g1", 7)).toThrow("full");
    expect(
        canSubmitTraining(
            puzzle,
            undoTrainingMove(undoTrainingMove(undoTrainingMove(undoTrainingMove(line)))),
            4,
        ),
    ).toBe(false);
});

test("promotions, en passant and castling use chess legality", () => {
    expect(walkTrainingLine("4k3/P7/8/8/8/8/8/4K3 w - - 0 1", ["a7a8n"])[1].san).toBe("a8=N");
    expect(walkTrainingLine("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2", ["e5d6"])[1].san).toBe("exd6");
    expect(walkTrainingLine("4k3/8/8/8/8/8/8/4K2R w K - 0 1", ["e1g1"])[1].san).toBe("O-O");
});
