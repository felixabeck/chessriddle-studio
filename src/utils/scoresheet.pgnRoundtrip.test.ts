import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ScoresheetGame } from "@/bindings";
import { lex } from "@/state/tests/lexPgn";
import { parsePGN } from "@/utils/chess";
import { buildScoresheetTree, scoresheetGameToPgn } from "./scoresheet";

const mocks = vi.hoisted(() => ({
    lexPgn: vi.fn(),
}));

vi.mock("@/platform/tauri", () => ({
    cancellationError: () => new Error("cancelled"),
    // Replace only the native Tauri IPC lexer; `parsePGN` and `parsePgnTokens` stay real.
    tauri: { lexPgn: mocks.lexPgn },
}));

beforeEach(() => {
    mocks.lexPgn.mockReset().mockImplementation(async (pgn: string) => lex(pgn));
});

describe("scoresheet PGN clock round-trip (unmocked parsePGN)", () => {
    test("scoresheetGameToPgn -> parsePGN and buildScoresheetTree populate node.clock in seconds", async () => {
        const game: ScoresheetGame = {
            headers: {
                white: "Alice",
                black: "Bob",
                event: "Club Open",
                site: "Berlin",
                date: "2026.11.27",
                round: "4",
                result: "*",
                whiteElo: "1850",
                blackElo: "1790",
            },
            moves: [
                { san: "e4", unsure: false, clock: 5160 },
                { san: "e5", unsure: true, clock: 5190 },
                { san: "Nf3", unsure: false },
                { san: "Nc6", unsure: false, clock: 0 },
            ],
            stopped: {
                ply: 4,
                tokens: ["Bb5", "a6"],
                clocks: [null, 4800],
            },
        };

        const pgn = scoresheetGameToPgn(game);
        expect(pgn).toContain(
            "1. e4 {[%clk 1:26:00]} e5 {[%clk 1:26:30]} 2. Nf3 Nc6 {[%clk 0:00:00]} *",
        );

        const parsed = await parsePGN(pgn);
        const p1 = parsed.root.children[0];
        const p2 = p1.children[0];
        const p3 = p2.children[0];
        const p4 = p3.children[0];
        expect(p1.clock).toBe(5160);
        expect(p2.clock).toBe(5190);
        expect(p3.clock).toBeUndefined();
        expect(p4.clock).toBe(0);
        expect(p1.comment).toBe("");
        expect(p2.comment).toBe("");

        const tree = await buildScoresheetTree(game);
        const n1 = tree.root.children[0];
        const n2 = n1.children[0];
        const n3 = n2.children[0];
        const n4 = n3.children[0];
        expect(n1.clock).toBe(5160);
        expect(n2.clock).toBe(5190);
        expect(n2.unsure).toBe(true);
        expect(n3.clock).toBeUndefined();
        expect(n4.clock).toBe(0);
        expect(tree.scoresheetReview).toEqual({
            stopped: {
                ply: 4,
                tokens: ["Bb5", "a6"],
                clocks: [null, 4800],
            },
        });
    });
});
