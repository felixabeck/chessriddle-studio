import { parseSquare } from "chessops";
import { describe, expect, test } from "vitest";
import { decodeTCN } from "./tcn";

describe("decodeTCN", () => {
    test("decodes a quiet pawn move without promotion", () => {
        expect(decodeTCN("mC")).toEqual({ from: parseSquare("e2"), to: parseSquare("e4") });
    });

    // Promotion indices are 64 + 3 * roleIndex in qnrbkp + fileDelta.
    // Straight queen = 65 ('~'), left knight = 67 ('('), with e7 encoded as '0'.
    test("decodes a white queen promotion", () => {
        expect(decodeTCN("0~")).toEqual({
            from: parseSquare("e7"),
            to: parseSquare("e8"),
            promotion: "queen",
        });
    });

    test("decodes a white capture-promotion to a knight", () => {
        expect(decodeTCN("0(")).toEqual({
            from: parseSquare("e7"),
            to: parseSquare("d8"),
            promotion: "knight",
        });
    });

    test("decodes a black queen promotion", () => {
        expect(decodeTCN("m~")).toEqual({
            from: parseSquare("e2"),
            to: parseSquare("e1"),
            promotion: "queen",
        });
    });
});
