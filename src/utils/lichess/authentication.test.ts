import { getDefaultStore } from "jotai";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { sessionsAtom } from "@/state/atoms";

const mocks = vi.hoisted(() => ({
    authenticate: vi.fn(),
    getAuthenticationStatus: vi.fn(),
    getLichessAccount: vi.fn(),
}));

vi.mock("@/platform/tauri", () => ({
    tauri: {
        authenticate: mocks.authenticate,
        getAuthenticationStatus: mocks.getAuthenticationStatus,
    },
}));
vi.mock("@/utils/lichess/api", () => ({ getLichessAccount: mocks.getLichessAccount }));

import { authenticateLichess } from "./authentication";

beforeEach(() => {
    vi.clearAllMocks();
    getDefaultStore().set(sessionsAtom, []);
    mocks.authenticate.mockResolvedValue("job-id");
    mocks.getLichessAccount.mockResolvedValue({ id: "player", username: "Player" });
});

describe("authenticateLichess", () => {
    test("returns failure without upserting when native authentication fails", async () => {
        mocks.getAuthenticationStatus.mockResolvedValue({ state: "failed" });
        await expect(authenticateLichess("alias", "Player")).resolves.toEqual({ ok: false });
        expect(getDefaultStore().get(sessionsAtom)).toEqual([]);
    });

    test("upserts a successful native account", async () => {
        mocks.getAuthenticationStatus.mockResolvedValue({
            state: "succeeded",
            account: { handle: "native-handle", username: "Player" },
            durability_uncertain: false,
        });
        await expect(authenticateLichess("alias", "Player")).resolves.toEqual({
            ok: true,
            durabilityUncertain: false,
        });
        expect(getDefaultStore().get(sessionsAtom)[0]).toMatchObject({
            alias: "alias",
            lichess: { handle: "native-handle", username: "Player" },
        });
    });

    test("preserves the durability warning on successful authentication", async () => {
        mocks.getAuthenticationStatus.mockResolvedValue({
            state: "succeeded",
            account: { handle: "native-handle", username: "Player" },
            durability_uncertain: true,
        });
        await expect(authenticateLichess("alias", "Player")).resolves.toEqual({
            ok: true,
            durabilityUncertain: true,
        });
        expect(getDefaultStore().get(sessionsAtom)).toHaveLength(1);
    });

    test("falls back to native metadata when the account profile is unavailable", async () => {
        mocks.getAuthenticationStatus.mockResolvedValue({
            state: "succeeded",
            account: { handle: "native-handle", username: "Player" },
        });
        mocks.getLichessAccount.mockResolvedValue(null);
        await expect(authenticateLichess("alias", "Player")).resolves.toEqual({
            ok: true,
            durabilityUncertain: false,
        });
        expect(getDefaultStore().get(sessionsAtom)[0].lichess).toMatchObject({
            handle: "native-handle",
            username: "Player",
            account: { id: "player", username: "Player" },
        });
    });

    test("links the job username when the account profile rejects", async () => {
        mocks.getAuthenticationStatus.mockResolvedValue({
            state: "succeeded",
            account: { handle: "native-handle", username: "JobPlayer" },
        });
        mocks.getLichessAccount.mockRejectedValue(new Error("Lichess account identity changed"));

        await expect(authenticateLichess("alias", "RequestedPlayer")).resolves.toEqual({
            ok: true,
            durabilityUncertain: false,
        });

        expect(mocks.getLichessAccount).toHaveBeenCalledExactlyOnceWith({
            handle: "native-handle",
        });
        expect(getDefaultStore().get(sessionsAtom)).toEqual([
            {
                alias: "alias",
                updatedAt: expect.any(Number),
                lichess: {
                    handle: "native-handle",
                    username: "JobPlayer",
                    account: { id: "jobplayer", username: "JobPlayer" },
                },
            },
        ]);
    });
});
