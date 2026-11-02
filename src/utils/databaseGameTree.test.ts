import { expect, test, vi } from "vitest";
import type { NormalizedGame, Token } from "@/bindings";
import { databaseGameHeaders, databaseGameToTree } from "./databaseGameTree";

const native = vi.hoisted(() => ({ lexPgn: vi.fn() }));
vi.mock("@/platform/tauri", () => ({ tauri: native }));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));

test.each(["b".repeat(64), undefined])(
    "row conversion preserves its starting position and uses only the row stamp: %s",
    async (stamp) => {
        const row: NormalizedGame = {
            id: 812,
            stamp,
            fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
            event: String.raw`Cup \"A\"`,
            event_id: 1,
            site: String.raw`Hall \\ Wing`,
            site_id: 1,
            white: "White",
            white_id: 1,
            black: "Black",
            black_id: 2,
            result: "*",
            moves: "1... c5 *",
            linked: {
                collection: "11111111-1111-4111-8111-111111111111",
                generation: "linked",
                ordinal: 2,
                stamp: "a".repeat(64),
            },
        };
        native.lexPgn.mockReset().mockResolvedValue([
            { type: "San", value: "c5" },
            { type: "Outcome", value: "*" },
        ] satisfies Token[]);

        const tree = await databaseGameToTree(row);
        expect(tree.root.fen).toBe(row.fen);
        expect(tree.root.children[0].san).toBe("c5");
        expect(tree.sourceStamp).toBe(stamp ?? null);
        expect(tree.headers).toEqual(databaseGameHeaders(row));
        expect(tree.headers).toMatchObject({ event: 'Cup "A"', site: "Hall \\ Wing" });
        expect(row.event).toBe(String.raw`Cup \"A\"`);
    },
);
