import { beforeEach, describe, expect, test, vi } from "vitest";
import type { OpponentImportOutcome, OpponentImportRequest } from "@/bindings";

const mocks = vi.hoisted(() => ({
    importOpponentGames: vi.fn(),
    withDownloadTicket: vi.fn(),
}));

vi.mock("@/platform/tauri", async () => {
    const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
    return {
        ...actual,
        tauri: { ...actual.tauri, importOpponentGames: mocks.importOpponentGames },
        withDownloadTicket: mocks.withDownloadTicket,
    };
});

import { importOpponentGames } from "./opponentImport";

const request: OpponentImportRequest = {
    root: { id: { id: "root" }, kind: "databaseRoot" },
    filename: "opponent-11111111-1111-4111-8111-111111111111-0a1b2c3d.db3",
    title: "Carlsen, Magnus",
    accounts: [{ provider: "lichess", username: "DrNykterstein" }],
    sinceUnixSeconds: 1_700_000_000,
    timeControls: ["blitz", "rapid"],
    lichessHandle: null,
};

beforeEach(() => {
    mocks.importOpponentGames.mockReset();
    mocks.withDownloadTicket
        .mockReset()
        .mockImplementation((run: (ticket: string) => Promise<unknown>) => run("ticket-1"));
});

describe("importOpponentGames", () => {
    test("announces the ticket before the import starts and passes the request with it", async () => {
        const outcome: OpponentImportOutcome = {
            kind: "imported",
            database: null,
            accounts: [{ account: request.accounts[0], games: 0 }],
            merged: true,
        };
        const order: string[] = [];
        mocks.importOpponentGames.mockImplementation(async () => {
            order.push("import");
            return outcome;
        });

        await expect(
            importOpponentGames(request, (ticket) => order.push(`ticket:${ticket}`)),
        ).resolves.toBe(outcome);

        expect(order).toEqual(["ticket:ticket-1", "import"]);
        expect(mocks.importOpponentGames).toHaveBeenCalledExactlyOnceWith(request, "ticket-1");
    });

    test("passes a failed import on unchanged", async () => {
        const failure = new Error("cancelled");
        mocks.importOpponentGames.mockRejectedValue(failure);

        await expect(importOpponentGames(request, () => {})).rejects.toBe(failure);
    });
});
