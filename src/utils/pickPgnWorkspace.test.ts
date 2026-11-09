import { beforeEach, expect, test, vi } from "vitest";
import { getDefaultStore } from "jotai";
import { chessBaseGuideAtom } from "@/components/library/chessBaseGuideState";
import { pickPgnWorkspace } from "./files";
import { TauriCommandError } from "@/platform/tauri";

const mocks = vi.hoisted(() => ({ pick: vi.fn() }));
vi.mock("@/platform/tauri", async (original) => ({
    ...(await original<typeof import("@/platform/tauri")>()),
    tauri: { issuePgnWorkspace: mocks.pick },
}));

beforeEach(() => {
    mocks.pick.mockReset();
    getDefaultStore().set(chessBaseGuideAtom, "closed");
});

test("ChessBase rejection opens selected-file guidance and cancels the pick", async () => {
    mocks.pick.mockRejectedValue(
        new TauriCommandError({
            tag: "backend-error",
            category: "invalid-input",
            message: "Export as PGN",
            chessBaseDatabase: true,
        }),
    );
    expect(await pickPgnWorkspace()).toBeNull();
    expect(getDefaultStore().get(chessBaseGuideAtom)).toBe("selected");
});

test("ordinary cancellation leaves the guide closed", async () => {
    mocks.pick.mockRejectedValue(
        new TauriCommandError({
            tag: "backend-error",
            category: "cancellation",
            message: "Cancellation",
        }),
    );
    expect(await pickPgnWorkspace()).toBeNull();
    expect(getDefaultStore().get(chessBaseGuideAtom)).toBe("closed");
});

test("an unrelated rejection remains the caller's error", async () => {
    const error = new Error("unavailable");
    mocks.pick.mockRejectedValue(error);
    await expect(pickPgnWorkspace()).rejects.toBe(error);
    expect(getDefaultStore().get(chessBaseGuideAtom)).toBe("closed");
});

test("PGN success preserves the descriptor", async () => {
    const descriptor = {
        handle: { id: { id: "picked" }, kind: "fileWorkspace" },
        displayName: "games.pgn",
        availability: "available",
    };
    mocks.pick.mockResolvedValue(descriptor);
    expect(await pickPgnWorkspace()).toBe(descriptor);
});
