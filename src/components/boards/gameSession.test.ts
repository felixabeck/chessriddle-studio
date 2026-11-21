import { expect, test, vi } from "vitest";
import type { Move } from "chessops";
import type { TreeNode } from "@/utils/treeReducer";
import {
    abortExactTabGame,
    abortExactGame,
    getMainlineUcis,
    isCurrentQueuedGameUpdate,
} from "./gameSession";

function node(move: Move | null, children: TreeNode[] = []): TreeNode {
    return { move, children } as unknown as TreeNode;
}

test("the live mainline follows first children only and keeps native's raw castling notation", () => {
    // e2e4, then the side variation d2d4 is not mainline; e1h1 is the PGN castle native echoes.
    const root = node(null, [
        node({ from: 12, to: 28 }, [node({ from: 4, to: 7 }), node({ from: 52, to: 36 })]),
        node({ from: 11, to: 27 }),
    ]);
    expect(getMainlineUcis(root)).toEqual(["e2e4", "e1h1"]);
});

test("a mainline node without a move contributes nothing and the walk continues past it", () => {
    const root = node(null, [node(null, [node({ from: 12, to: 28 })])]);
    expect(getMainlineUcis(root)).toEqual(["e2e4"]);
});

test("a pending move from the replaced session cannot apply after New Game", () => {
    // New Game first cancels the queue, then increments its local generation and
    // clears the authoritative session. A timer that was already queued must fail
    // this final gate, even if its callback runs after the handoff.
    expect(isCurrentQueuedGameUpdate(4, 4, BigInt(9), BigInt(9))).toBe(true);
    expect(isCurrentQueuedGameUpdate(4, 5, BigInt(9), BigInt(9))).toBe(false);
    expect(isCurrentQueuedGameUpdate(4, 4, BigInt(9), BigInt(10))).toBe(false);
    expect(isCurrentQueuedGameUpdate(null, 4, null, BigInt(9))).toBe(false);
});

test("a queued update carrying no session is rejected during a session handoff", () => {
    // Both sides null is the case the explicit `queuedSession !== null` check exists for:
    // New Game clears the authoritative session, so a queued update that never carried one
    // would otherwise satisfy `queuedSession === currentSession` as `null === null` and be
    // applied to the replacement game. The generation matching here is what isolates the
    // session check — without it the case would pass for the wrong reason.
    expect(isCurrentQueuedGameUpdate(3, 3, null, null)).toBe(false);
    // And the same queue is still accepted once a real session is present on both sides.
    expect(isCurrentQueuedGameUpdate(3, 3, BigInt(2), BigInt(2))).toBe(true);
});

test("only typed missing-resource makes exact abort idempotent", async () => {
    const missing = {
        tag: "backend-error",
        category: "missing-resource",
        message: "Game not found",
    };
    await expect(
        abortExactGame("game", 1n, async () => Promise.reject(missing)),
    ).resolves.toBeUndefined();
    await expect(
        abortExactGame("game", 1n, async () => Promise.reject(new Error("Game not found"))),
    ).rejects.toThrow("Game not found");
});

test("tab cleanup aborts the stored live game id, never a synthetic tab suffix", async () => {
    const abort = vi.fn(async () => undefined);
    await expect(
        abortExactTabGame(
            "tab-a",
            () => "tab-a-game-7",
            () => BigInt(7),
            abort,
        ),
    ).resolves.toBe("tab-a-game-7");
    expect(abort).toHaveBeenCalledWith("tab-a-game-7", BigInt(7));
    await expect(
        abortExactTabGame(
            "tab-b",
            () => null,
            () => null,
            abort,
        ),
    ).resolves.toBeNull();
    await expect(
        abortExactTabGame(
            "tab-c",
            () => "tab-c-game-2",
            () => null,
            abort,
        ),
    ).resolves.toBeNull();
    expect(abort).toHaveBeenCalledTimes(1);
});

test("tab cleanup clears ownership only after exact teardown succeeds", async () => {
    const teardown = Promise.withResolvers<void>();
    const clear = vi.fn();
    const pending = abortExactTabGame(
        "tab",
        () => "game",
        () => 4n,
        () => teardown.promise,
        clear,
    );
    expect(clear).not.toHaveBeenCalled();
    teardown.resolve();
    await expect(pending).resolves.toBe("game");
    expect(clear).toHaveBeenCalledWith("game", 4n);
});
