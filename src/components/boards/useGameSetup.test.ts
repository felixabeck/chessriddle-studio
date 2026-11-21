import { expect, test } from "vitest";
import { assignPlayers, nextInputColor, playerSideColors } from "./useGameSetup";

test("the colour control cycles white, black, random and back to white", () => {
    expect(nextInputColor("white")).toBe("black");
    expect(nextInputColor("black")).toBe("random");
    expect(nextInputColor("random")).toBe("white");
});

test("player 2 takes the colour player 1 does not, and shares a random draw", () => {
    expect(playerSideColors("white")).toEqual(["white", "black"]);
    expect(playerSideColors("black")).toEqual(["black", "white"]);
    expect(playerSideColors("random")).toEqual(["random", "random"]);
});

test("a fixed colour seats player 1 on it without drawing", () => {
    const draw = () => {
        throw new Error("a fixed colour must not draw");
    };
    expect(assignPlayers("white", "p1", "p2", draw)).toEqual({ white: "p1", black: "p2" });
    expect(assignPlayers("black", "p1", "p2", draw)).toEqual({ white: "p2", black: "p1" });
});

test("a random colour seats player 1 on white only for a draw above one half", () => {
    expect(assignPlayers("random", "p1", "p2", () => 0.75)).toEqual({ white: "p1", black: "p2" });
    expect(assignPlayers("random", "p1", "p2", () => 0.5)).toEqual({ white: "p2", black: "p1" });
});
