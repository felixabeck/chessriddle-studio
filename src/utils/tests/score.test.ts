import { expect, test } from "vitest";
import type { BestMoves } from "@/bindings";
import {
    formatScore,
    getAccuracy,
    getAnnotation,
    getCPLoss,
    getWinChance,
    normalizeScore,
    positionAssessment,
} from "../score";

test("should format a positive cp score correctly", () => {
    expect(formatScore({ type: "cp", value: 50 })).toBe("+0.50");
});

test("should format a negative cp score correctly", () => {
    expect(formatScore({ type: "cp", value: -50 })).toBe("-0.50");
});

test("should format a mate score correctly", () => {
    expect(formatScore({ type: "mate", value: 5 })).toBe("+M5");
    expect(formatScore({ type: "mate", value: -5 })).toBe("-M5");
});

test("should format a dtz score with a leading sign", () => {
    expect(formatScore({ type: "dtz", value: 12 })).toBe("+DTZ12");
    expect(formatScore({ type: "dtz", value: -12 })).toBe("-DTZ12");
    expect(formatScore({ type: "dtz", value: 0 })).toBe("DTZ0");
    expect(formatScore({ type: "dtz", value: 12 }, 1).slice(1)).toBe("DTZ12");
});

test("normalizeScore maps dtz like mate to the centipawn ceiling", () => {
    expect(normalizeScore({ type: "dtz", value: 12 }, "white")).toBe(1000);
    expect(normalizeScore({ type: "dtz", value: -5 }, "white")).toBe(-1000);
    expect(normalizeScore({ type: "dtz", value: 12 }, "black")).toBe(-1000);
    expect(normalizeScore({ type: "dtz", value: -5 }, "black")).toBe(1000);
    expect(normalizeScore({ type: "dtz", value: 0 }, "white")).toBeCloseTo(0);
    expect(normalizeScore({ type: "dtz", value: 0 }, "black")).toBeCloseTo(0);
});

test("should calculate the win chance correctly", () => {
    expect(getWinChance(0)).toBe(50);
    expect(getWinChance(100)).toBeCloseTo(59.1);
    expect(getWinChance(-500)).toBeCloseTo(13.69);
});

test("should calculate the accuracy correctly", () => {
    expect(getAccuracy({ type: "cp", value: 0 }, { type: "cp", value: 0 }, "white")).toBe(100);
    expect(getAccuracy({ type: "cp", value: 0 }, { type: "cp", value: -500 }, "white")).toBeCloseTo(
        19.07,
    );
});

test("should calculate the cp loss correctly", () => {
    expect(getCPLoss({ type: "cp", value: 0 }, { type: "cp", value: 50 }, "black")).toBe(50);
    expect(getCPLoss({ type: "mate", value: -1 }, { type: "cp", value: 0 }, "black")).toBe(1000);
});

// The mistake annotations are a comparison against the previous evaluation, so
// every case that expects one supplies it explicitly.
const ZERO = { type: "cp" as const, value: 0 };

test("should annotate as ??", () => {
    expect(getAnnotation(null, ZERO, { type: "cp", value: -500 }, "white", [])).toBe("??");
    expect(getAnnotation(null, ZERO, { type: "cp", value: 500 }, "black", [])).toBe("??");
});

test("should annotate as ?", () => {
    expect(getAnnotation(null, ZERO, { type: "cp", value: -200 }, "white", [])).toBe("?");
    expect(getAnnotation(null, ZERO, { type: "cp", value: 200 }, "black", [])).toBe("?");
});

test("should annotate as ?!", () => {
    expect(getAnnotation(null, ZERO, { type: "cp", value: -100 }, "white", [])).toBe("?!");
    expect(getAnnotation(null, ZERO, { type: "cp", value: 100 }, "black", [])).toBe("?!");
});

test("should not annotate", () => {
    expect(getAnnotation(null, ZERO, { type: "cp", value: -50 }, "white", [])).toBe("");
    expect(getAnnotation(null, ZERO, { type: "cp", value: 50 }, "black", [])).toBe("");
});

test("derives no mistake annotation without the previous evaluation", () => {
    // A null previous score means "not available" — an unannotated ply, not a
    // blunder measured against an invented 0.00 baseline.
    expect(getAnnotation(null, null, { type: "cp", value: -500 }, "white", [])).toBe("");
    expect(getAnnotation(null, null, { type: "cp", value: 500 }, "black", [])).toBe("");
    expect(getAnnotation(null, null, { type: "mate", value: -1 }, "white", [])).toBe("");
});

test("derives no ! without the previous-previous evaluation", () => {
    const only = (value: number, san: string): BestMoves => ({
        depth: 1,
        multipv: 1,
        nodes: 1n,
        score: { value: { type: "cp", value }, wdl: null },
        nps: 1000n,
        sanMoves: [san],
        uciMoves: ["e2e4"],
    });
    // Only move: the best line is far better than the second, and it was played.
    const prevMoves = [only(300, "e4"), only(-300, "d4")];

    expect(
        getAnnotation(ZERO, ZERO, { type: "cp", value: 300 }, "white", prevMoves, false, "e4"),
    ).toBe("!");
    // "!" claims the move improved on the position before it. Without that
    // evaluation there is nothing to have improved on.
    expect(
        getAnnotation(null, ZERO, { type: "cp", value: 300 }, "white", prevMoves, false, "e4"),
    ).toBe("");
    // "!!" rests on the sacrifice alone and survives the missing evaluation.
    expect(
        getAnnotation(null, ZERO, { type: "cp", value: 300 }, "white", prevMoves, true, "e4"),
    ).toBe("!!");
});

test("positionAssessment uses the 0.3 / 1 / 2 pawn boundaries from White's view", () => {
    const cp = (value: number) => positionAssessment({ type: "cp", value });
    expect([0, 29, -29].map(cp)).toEqual(["=", "=", "="]);
    expect([30, 99, -30, -99].map(cp)).toEqual(["⩲", "⩲", "⩱", "⩱"]);
    expect([100, 199, -100, -199].map(cp)).toEqual(["±", "±", "∓", "∓"]);
    expect([200, 900, -200, -900].map(cp)).toEqual(["+-", "+-", "-+", "-+"]);
});

test("positionAssessment treats mate and tablebase scores as decisive for their side", () => {
    expect(positionAssessment({ type: "mate", value: 3 })).toBe("+-");
    expect(positionAssessment({ type: "mate", value: -1 })).toBe("-+");
    expect(positionAssessment({ type: "dtz", value: 12 })).toBe("+-");
    expect(positionAssessment({ type: "dtz", value: -4 })).toBe("-+");
});
