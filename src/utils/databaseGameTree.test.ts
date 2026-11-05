import { beforeEach, expect, test, vi } from "vitest";
import type { NormalizedGame, Token } from "@/bindings";
import {
    databaseGameHeaders,
    databaseGameToTree,
    seedDatabaseOrientation,
} from "./databaseGameTree";
import { defaultTree } from "./treeReducer";

const native = vi.hoisted(() => ({ lexPgn: vi.fn(), inferGameOrientation: vi.fn(), log: vi.fn() }));
vi.mock("@/platform/tauri", () => ({ tauri: native }));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("@/platform/errors", async (original) => ({
    ...(await original<typeof import("@/platform/errors")>()),
    logFailureSafely: native.log,
}));

const database = { id: { id: "orientation-db" }, kind: "database" } as const;
beforeEach(() => {
    native.inferGameOrientation.mockReset().mockResolvedValue("black");
    native.log.mockReset().mockResolvedValue(undefined);
});

test.each([undefined, "white", "black"] as const)(
    "inference seeds only an unset orientation, stored=%s",
    async (orientation) => {
        const tree = defaultTree();
        tree.headers.orientation = orientation;
        const seeded = await seedDatabaseOrientation(tree, database, 812);
        expect(seeded.headers.orientation).toBe(orientation ?? "black");
        expect(seeded.dirty).toBe(false);
        expect(seeded.sourceStamp).toBeNull();
        expect(native.inferGameOrientation.mock.calls).toEqual(
            orientation ? [] : [[database, 812]],
        );
    },
);

test.each(["database", "invalid-input", "cancellation", "unexpected"])(
    "inference error %s logs and leaves the initial White fallback clean",
    async (category) => {
        native.inferGameOrientation.mockRejectedValue({ category, message: "Inference failed" });
        const tree = await seedDatabaseOrientation(defaultTree(), database, 812);
        expect(tree.headers.orientation).toBeUndefined();
        expect(tree.dirty).toBe(false);
        expect(native.log).toHaveBeenCalledOnce();
    },
);

test("a cancelled reload cannot apply a late inference result", async () => {
    const controller = new AbortController();
    native.inferGameOrientation.mockImplementation(async () => {
        controller.abort();
        return "black";
    });
    const tree = await seedDatabaseOrientation(defaultTree(), database, 812, {
        signal: controller.signal,
    });
    expect(tree.headers.orientation).toBeUndefined();
});

test("an already cancelled reload starts no inference", async () => {
    await seedDatabaseOrientation(defaultTree(), database, 812, { signal: AbortSignal.abort() });
    expect(native.inferGameOrientation).not.toHaveBeenCalled();
});

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
        expect(tree.headers.orientation).toBeUndefined();
        expect(native.inferGameOrientation).not.toHaveBeenCalled();
    },
);
