import { beforeEach, expect, test, vi } from "vitest";
import { getDefaultStore } from "jotai";
import type { ErrorPayload } from "@/bindings";
import { chessBaseGuideAtom } from "@/components/library/chessBaseGuideState";
import { pickPgnFile, pickPgnWorkspace } from "./files";
import { TauriCommandError } from "@/platform/tauri";

const mocks = vi.hoisted(() => ({
    pick: vi.fn(),
    pickExport: vi.fn(),
    countPgnGames: vi.fn(),
}));
vi.mock("@/platform/tauri", async (original) => ({
    ...(await original<typeof import("@/platform/tauri")>()),
    tauri: {
        issuePgnWorkspace: mocks.pick,
        issuePgnExportDestination: mocks.pickExport,
        countPgnGames: mocks.countPgnGames,
    },
}));

const chessBasePayload = {
    tag: "backend-error",
    category: "invalid-input",
    message: "Export as PGN",
    chessBaseDatabase: true,
} satisfies ErrorPayload;

beforeEach(() => {
    mocks.pick.mockReset();
    mocks.pickExport.mockReset();
    mocks.countPgnGames.mockReset();
    getDefaultStore().set(chessBaseGuideAtom, "closed");
});

test("ChessBase rejection opens selected-file guidance and cancels the pick", async () => {
    mocks.pick.mockRejectedValue(new TauriCommandError(chessBasePayload));
    expect(await pickPgnWorkspace()).toBeNull();
    expect(getDefaultStore().get(chessBaseGuideAtom)).toBe("selected");
});

test("pickPgnFile cancels a ChessBase selection through the shared guide path without counting games", async () => {
    mocks.pick.mockRejectedValue(new TauriCommandError(chessBasePayload));

    const result = await pickPgnFile();

    expect(result).toBeNull();
    expect(getDefaultStore().get(chessBaseGuideAtom)).toBe("selected");
    expect(mocks.countPgnGames).not.toHaveBeenCalled();
    expect(mocks.pick).toHaveBeenCalledOnce();
    expect(mocks.pickExport).not.toHaveBeenCalled();
});

test("pickPgnFile export propagates a ChessBase marker without opening the guide", async () => {
    const failure = new TauriCommandError(chessBasePayload);
    mocks.pickExport.mockRejectedValue(failure);
    mocks.pick.mockRejectedValue(failure);

    await expect(pickPgnFile("export")).rejects.toBe(failure);

    expect(getDefaultStore().get(chessBaseGuideAtom)).toBe("closed");
    expect(mocks.pickExport).toHaveBeenCalledOnce();
    expect(mocks.pick).not.toHaveBeenCalled();
    expect(mocks.countPgnGames).not.toHaveBeenCalled();
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
