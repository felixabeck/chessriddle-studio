import { beforeEach, describe, expect, test, vi } from "vitest";
import {
    decodeCompressedOrJson,
    deserializeStorageValue,
    serializeStorageValue,
} from "@/state/store/debouncedStorage";

const mocks = vi.hoisted(() => ({
    migrateLegacyLichessToken: vi.fn(),
    revokeLegacyLichessToken: vi.fn(),
    listLichessAccounts: vi.fn(),
    getLichessAccount: vi.fn(),
}));

vi.mock("@/bindings/generated", () => ({
    commands: {
        migrateLegacyLichessToken: mocks.migrateLegacyLichessToken,
        revokeLegacyLichessToken: mocks.revokeLegacyLichessToken,
        listLichessAccounts: mocks.listLichessAccounts,
    },
}));
vi.mock("@/utils/lichess/api", () => ({ getLichessAccount: mocks.getLichessAccount }));

import {
    dedupeChessComSessions,
    initializePersistedSessions,
    getSessionPersistenceSnapshot,
    savePublicSessions,
    retrySessionPersistence,
    sameAccountUsername,
    sessionPlayerName,
    SessionSanitizationError,
    upsertChessComSession,
    upsertLichessSession,
} from "./session";

beforeEach(() => {
    vi.restoreAllMocks();
    savePublicSessions([]);
    localStorage.clear();
    vi.clearAllMocks();
    mocks.listLichessAccounts.mockResolvedValue([]);
    mocks.revokeLegacyLichessToken.mockReset().mockResolvedValue({ status: "ok", data: "revoked" });
});

test("session player names prefer the alias, then Lichess, then Chess.com, then empty", () => {
    const session = {
        player: "Alias",
        updatedAt: 1,
        lichess: { username: "lichess", account: { id: "account", username: "Account" } },
        chessCom: { username: "chesscom", stats: {} },
    };
    expect(sessionPlayerName(session)).toBe("Alias");
    expect(sessionPlayerName({ ...session, player: undefined })).toBe("lichess");
    expect(sessionPlayerName({ ...session, player: "" })).toBe("lichess");
    expect(sessionPlayerName({ ...session, player: undefined, lichess: undefined })).toBe(
        "chesscom",
    );
    expect(sessionPlayerName({ updatedAt: 1 })).toBe("");
});

describe("upsertLichessSession", () => {
    const account = { id: "alice", username: "alice" };
    const authenticated = {
        player: "Original alias",
        updatedAt: 1,
        lichess: { username: "alice", account, handle: "existing-handle" },
    };

    test.each(["alice", "Alice"])(
        "preserves the authenticated handle when upserting handle-less %s with a different alias",
        (username) => {
            vi.spyOn(Date, "now").mockReturnValue(123);
            const sessions = upsertLichessSession([authenticated], "New alias", {
                username,
                account,
            });

            expect(sessions).toEqual([
                {
                    player: "New alias",
                    updatedAt: 123,
                    lichess: { username, account, handle: "existing-handle" },
                },
            ]);
            expect(
                sessions.filter(
                    (session) => session.lichess?.username.toLocaleLowerCase() === "alice",
                ),
            ).toHaveLength(1);
        },
    );

    test("an incoming defined handle replaces the existing handle", () => {
        const sessions = upsertLichessSession([authenticated], "New alias", {
            username: "alice",
            account,
            handle: "new-handle",
        });

        expect(sessions).toHaveLength(1);
        expect(sessions[0].lichess?.handle).toBe("new-handle");
    });

    test("a handle-less upsert without a prior session stays handle-less", () => {
        vi.spyOn(Date, "now").mockReturnValue(123);
        const sessions = upsertLichessSession([], "", { username: "alice", account });

        expect(sessions).toEqual([
            {
                player: "alice",
                updatedAt: 123,
                lichess: { username: "alice", account },
            },
        ]);
        expect(sessions[0].lichess?.handle).toBeUndefined();
    });
});

describe("sameAccountUsername", () => {
    test("compares defined usernames case-insensitively and rejects undefined", () => {
        expect(sameAccountUsername("Felix", "felix")).toBe(true);
        expect(sameAccountUsername("felix", "FELIX")).toBe(true);
        expect(sameAccountUsername("Felix", "bob")).toBe(false);
        expect(sameAccountUsername(undefined, "felix")).toBe(false);
        expect(sameAccountUsername("Felix", undefined)).toBe(false);
        expect(sameAccountUsername(undefined, undefined)).toBe(false);
    });
});

describe("upsertChessComSession", () => {
    const stats = {};
    const existing = {
        player: "Original alias",
        updatedAt: 1,
        chessCom: { username: "Felix", stats },
    };
    const otherAccount = {
        player: "Bob",
        updatedAt: 2,
        chessCom: { username: "bob", stats },
    };
    const lichessOnly = {
        player: "Lichess",
        updatedAt: 3,
        lichess: { username: "alice", account: { id: "alice", username: "alice" } },
    };

    test("replacing Felix with felix yields one session with the new username and alias while keeping others", () => {
        vi.spyOn(Date, "now").mockReturnValue(123);
        const sessions = upsertChessComSession([existing, otherAccount, lichessOnly], "New alias", {
            username: "felix",
            stats,
        });

        expect(sessions).toEqual([
            otherAccount,
            lichessOnly,
            {
                player: "New alias",
                updatedAt: 123,
                chessCom: { username: "felix", stats },
            },
        ]);
        expect(
            sessions
                .filter((session) => session.chessCom !== undefined)
                .map((s) => s.chessCom?.username),
        ).toEqual(["bob", "felix"]);
    });

    test("empty alias falls back to the Chess.com username", () => {
        vi.spyOn(Date, "now").mockReturnValue(123);
        const sessions = upsertChessComSession([], "", { username: "felix", stats });

        expect(sessions).toEqual([
            {
                player: "felix",
                updatedAt: 123,
                chessCom: { username: "felix", stats },
            },
        ]);
    });
});

describe("dedupeChessComSessions", () => {
    const stats = {};
    const lichessFirst = {
        player: "Alice",
        updatedAt: 5,
        lichess: { username: "alice", account: { id: "alice", username: "alice" } },
    };
    const otherChessCom = {
        player: "Bob",
        updatedAt: 3,
        chessCom: { username: "bob", stats },
    };
    const combinedSession = {
        player: "Combined",
        updatedAt: 99,
        lichess: { username: "felix", account: { id: "felix", username: "felix" } },
        chessCom: { username: "FELIX", stats },
    };

    test("keeps the highest updatedAt regardless of order and preserves relative order of survivors and others", () => {
        const olderUpper = {
            player: "Felix",
            updatedAt: 1,
            chessCom: { username: "Felix", stats },
        };
        const newerLower = {
            player: "felix",
            updatedAt: 10,
            chessCom: { username: "felix", stats },
        };

        expect(
            dedupeChessComSessions([
                olderUpper,
                lichessFirst,
                newerLower,
                otherChessCom,
                combinedSession,
            ]),
        ).toEqual([lichessFirst, newerLower, otherChessCom, combinedSession]);

        expect(
            dedupeChessComSessions([
                newerLower,
                lichessFirst,
                olderUpper,
                otherChessCom,
                combinedSession,
            ]),
        ).toEqual([newerLower, lichessFirst, otherChessCom, combinedSession]);
    });

    test("breaks updatedAt ties in favour of the later session", () => {
        const first = { player: "First", updatedAt: 4, chessCom: { username: "Felix", stats } };
        const second = { player: "Second", updatedAt: 4, chessCom: { username: "felix", stats } };

        expect(dedupeChessComSessions([first, lichessFirst, second])).toEqual([
            lichessFirst,
            second,
        ]);
    });
});

describe("initializePersistedSessions", () => {
    test("collapses legacy case-variant Chess.com duplicates in localStorage to the newest session", async () => {
        localStorage.setItem(
            "sessions",
            serializeStorageValue([
                { player: "Felix", updatedAt: 1, chessCom: { username: "Felix", stats: {} } },
                { player: "felix", updatedAt: 2, chessCom: { username: "felix", stats: {} } },
            ]),
        );

        const snapshot = await initializePersistedSessions();

        expect(snapshot).toEqual({
            status: "saved",
            sessions: [
                { player: "felix", updatedAt: 2, chessCom: { username: "felix", stats: {} } },
            ],
        });
        expect(decodeCompressedOrJson(localStorage.getItem("sessions"))).toEqual(snapshot.sessions);
    });
    test("persists one card for a listed native account after a successful profile read", async () => {
        const profile = { id: "player", username: "Player", count: { all: 42 } };
        mocks.listLichessAccounts.mockResolvedValue([
            { username: "Player", handle: "native-handle" },
        ]);
        mocks.getLichessAccount.mockResolvedValue(profile);

        await expect(initializePersistedSessions()).resolves.toMatchObject({ status: "saved" });
        await expect(initializePersistedSessions()).resolves.toMatchObject({ status: "saved" });

        expect(decodeCompressedOrJson(localStorage.getItem("sessions"))).toEqual([
            {
                player: "Player",
                updatedAt: expect.any(Number),
                lichess: { username: "Player", handle: "native-handle", account: profile },
            },
        ]);
        expect(mocks.getLichessAccount).toHaveBeenCalledExactlyOnceWith({
            handle: "native-handle",
        });
    });

    test.each(["rejects", "resolves null"])(
        "resolves without persisting a new card when the profile read %s",
        async (outcome) => {
            mocks.listLichessAccounts.mockResolvedValue([
                { username: "Player", handle: "native-handle" },
            ]);
            if (outcome === "rejects") {
                mocks.getLichessAccount.mockRejectedValue(new Error("Lichess account read failed"));
            } else {
                mocks.getLichessAccount.mockResolvedValue(null);
            }

            await expect(initializePersistedSessions()).resolves.toMatchObject({ status: "saved" });

            expect(decodeCompressedOrJson(localStorage.getItem("sessions"))).toEqual([]);
            expect(mocks.getLichessAccount).toHaveBeenCalledExactlyOnceWith({
                handle: "native-handle",
            });
        },
    );

    function seedLegacySessions(tokens: string[]) {
        localStorage.setItem(
            "sessions",
            JSON.stringify(
                tokens.map((accessToken, index) => ({
                    updatedAt: 1,
                    lichess: {
                        username: `private-player-${index}`,
                        account: { id: `private-player-${index}` },
                        accessToken,
                    },
                })),
            ),
        );
    }

    function refuseSessionErasure() {
        const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new DOMException("quota exceeded", "QuotaExceededError");
        });
        const removeItem = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
            throw new DOMException("storage refused", "SecurityError");
        });
        return { setItem, removeItem };
    }

    test("revokes each unerased token before rejecting with only a safe summary", async () => {
        const tokens = ["first-private-token", "second-private-token"];
        seedLegacySessions(tokens);
        const original = localStorage.getItem("sessions");
        const erasure = refuseSessionErasure();
        let finishRevocation!: (value: unknown) => void;
        mocks.revokeLegacyLichessToken.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishRevocation = resolve;
                }),
        );
        const startup = initializePersistedSessions();
        let settled = false;
        const outcome = startup.then(
            () => {
                settled = true;
                return null;
            },
            (cause: unknown) => {
                settled = true;
                return cause;
            },
        );
        expect(mocks.revokeLegacyLichessToken.mock.calls).toEqual(tokens.map((token) => [token]));
        expect(mocks.migrateLegacyLichessToken).not.toHaveBeenCalled();
        expect(mocks.listLichessAccounts).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(settled).toBe(false);
        finishRevocation({ status: "ok", data: "already_invalid" });
        const error = await outcome;
        expect(error).toBeInstanceOf(SessionSanitizationError);
        expect(error).toMatchObject({
            legacySignInFound: true,
            allRevoked: true,
            unresolvedReasons: [],
        });
        for (const sensitive of [...tokens, "private-player-0", "private-player-1"]) {
            expect(String(error)).not.toContain(sensitive);
            expect((error as SessionSanitizationError).stack).not.toContain(sensitive);
            expect(JSON.stringify(error)).not.toContain(sensitive);
        }
        expect(mocks.migrateLegacyLichessToken).not.toHaveBeenCalled();
        expect(mocks.listLichessAccounts).not.toHaveBeenCalled();
        expect(mocks.getLichessAccount).not.toHaveBeenCalled();
        expect(erasure.setItem).toHaveBeenCalledTimes(1);
        expect(erasure.removeItem).toHaveBeenCalledExactlyOnceWith("sessions");
        expect(erasure.setItem.mock.invocationCallOrder[0]).toBeLessThan(
            erasure.removeItem.mock.invocationCallOrder[0],
        );
        expect(localStorage.getItem("sessions")).toBe(original);
        expect(getSessionPersistenceSnapshot()).toEqual({ status: "saved", sessions: [] });
    });

    test("catches a revoke rejection and still attempts every other token", async () => {
        seedLegacySessions(["failed-private-token", "revoked-private-token"]);
        refuseSessionErasure();
        mocks.revokeLegacyLichessToken.mockRejectedValueOnce(new Error("failed-private-token"));
        await expect(initializePersistedSessions()).rejects.toMatchObject({
            name: "SessionSanitizationError",
            legacySignInFound: true,
            allRevoked: false,
            unresolvedReasons: ["unconfirmed"],
        });
        expect(mocks.revokeLegacyLichessToken.mock.calls).toEqual([
            ["failed-private-token"],
            ["revoked-private-token"],
        ]);
        expect(mocks.migrateLegacyLichessToken).not.toHaveBeenCalled();
        expect(mocks.listLichessAccounts).not.toHaveBeenCalled();
        expect(mocks.getLichessAccount).not.toHaveBeenCalled();
    });

    test("treats a native error result as unconfirmed revocation", async () => {
        seedLegacySessions(["native-error-private-token"]);
        refuseSessionErasure();
        mocks.revokeLegacyLichessToken.mockResolvedValueOnce({
            status: "error",
            error: "unavailable",
        });
        await expect(initializePersistedSessions()).rejects.toMatchObject({
            name: "SessionSanitizationError",
            legacySignInFound: true,
            allRevoked: false,
        });
    });

    test("retains only distinct sanitized reasons across every provider outcome and IPC rejection", async () => {
        const tokens = Array.from({ length: 8 }, (_, index) => `private-token-${index}`);
        seedLegacySessions(tokens);
        refuseSessionErasure();
        const consoleError = vi.spyOn(console, "error");
        const consoleWarn = vi.spyOn(console, "warn");
        for (const outcome of [
            "already_invalid",
            "revoked",
            "rejected",
            "unreachable",
            "rate_limited",
            "rejected",
            "unreachable",
        ]) {
            mocks.revokeLegacyLichessToken.mockResolvedValueOnce({ status: "ok", data: outcome });
        }
        mocks.revokeLegacyLichessToken.mockRejectedValueOnce(new Error(tokens[7]));
        const error = await initializePersistedSessions().catch((cause: unknown) => cause);
        expect(error).toMatchObject({
            legacySignInFound: true,
            allRevoked: false,
            unresolvedReasons: ["unreachable", "rate_limited", "rejected", "unconfirmed"],
        });
        expect(mocks.revokeLegacyLichessToken.mock.calls).toEqual(tokens.map((token) => [token]));
        expect(mocks.migrateLegacyLichessToken).not.toHaveBeenCalled();
        expect(mocks.listLichessAccounts).not.toHaveBeenCalled();
        expect(mocks.getLichessAccount).not.toHaveBeenCalled();
        expect(consoleError).not.toHaveBeenCalled();
        expect(consoleWarn).not.toHaveBeenCalled();
        expect(JSON.stringify(error)).not.toMatch(/private-token|private-player/);
    });

    test("reports nothing found and skips revocation when storage has no legacy token", async () => {
        refuseSessionErasure();
        await expect(initializePersistedSessions()).rejects.toMatchObject({
            name: "SessionSanitizationError",
            legacySignInFound: false,
            allRevoked: true,
        });
        expect(mocks.revokeLegacyLichessToken).not.toHaveBeenCalled();
        expect(mocks.migrateLegacyLichessToken).not.toHaveBeenCalled();
        expect(mocks.listLichessAccounts).not.toHaveBeenCalled();
        expect(mocks.getLichessAccount).not.toHaveBeenCalled();
    });

    test("revokes a read token even when its record cannot be migrated", async () => {
        localStorage.setItem(
            "sessions",
            JSON.stringify([{ lichess: { accessToken: "malformed-private-token" } }]),
        );
        refuseSessionErasure();
        await expect(initializePersistedSessions()).rejects.toMatchObject({
            legacySignInFound: true,
            allRevoked: true,
        });
        expect(mocks.revokeLegacyLichessToken).toHaveBeenCalledExactlyOnceWith(
            "malformed-private-token",
        );
        expect(mocks.migrateLegacyLichessToken).not.toHaveBeenCalled();
    });

    test("retries sanitization and migrates exactly once when storage works on the next call", async () => {
        seedLegacySessions(["retry-private-token"]);
        const erasure = refuseSessionErasure();
        await expect(initializePersistedSessions()).rejects.toBeInstanceOf(
            SessionSanitizationError,
        );
        erasure.setItem.mockRestore();
        erasure.removeItem.mockRestore();
        mocks.migrateLegacyLichessToken.mockImplementation(async () => {
            expect(localStorage.getItem("sessions")).not.toContain("retry-private-token");
            expect(localStorage.getItem("sessions")).not.toContain("accessToken");
            return { status: "error", error: "revoked token" };
        });
        await initializePersistedSessions();
        await initializePersistedSessions();
        expect(mocks.migrateLegacyLichessToken).toHaveBeenCalledExactlyOnceWith(
            "private-player-0",
            "retry-private-token",
        );
        expect(mocks.revokeLegacyLichessToken).toHaveBeenCalledTimes(1);
    });

    test.each(["successful", "failed"])(
        "reconciles the opaque handle returned by a successful migration with %s listing",
        async (listing) => {
            localStorage.setItem(
                "sessions",
                JSON.stringify([
                    {
                        player: "player",
                        updatedAt: 1,
                        lichess: {
                            username: "player",
                            account: { id: "player", username: "player" },
                            accessToken: "legacy-token",
                        },
                    },
                ]),
            );
            mocks.migrateLegacyLichessToken.mockResolvedValue({
                account: { username: "player", handle: "migrated-handle" },
                durability_uncertain: false,
            });
            if (listing === "successful") {
                mocks.listLichessAccounts.mockResolvedValue([
                    { username: "PLAYER", handle: "migrated-handle" },
                ]);
            } else {
                mocks.listLichessAccounts.mockRejectedValue(new Error("native unavailable"));
            }
            await initializePersistedSessions();

            const sessions = decodeCompressedOrJson(
                localStorage.getItem("sessions"),
            ) as import("./session").Session[];
            expect(sessions[0].lichess?.handle).toBe("migrated-handle");
            expect(mocks.revokeLegacyLichessToken).not.toHaveBeenCalled();
        },
    );

    test.each([
        { source: "persisted", populated: false },
        { source: "persisted", populated: true },
        { source: "earlier-migrated", populated: false },
        { source: "earlier-migrated", populated: true },
    ])(
        "confirmed absence clears a $source handle and cannot restore it on reload (populated: $populated)",
        async ({ source, populated }) => {
            const publicSession = {
                player: "Player alias",
                updatedAt: 123,
                lichess: {
                    username: "Player",
                    account: {
                        id: "player",
                        username: "Player",
                        perfs: { blitz: { rating: 1800 } },
                    },
                },
                chessCom: { username: "OtherProvider", stats: {} },
            };
            const matchingSession = {
                updatedAt: 456,
                lichess: { username: "Present", account: { id: "present", username: "Present" } },
            };
            localStorage.setItem(
                "sessions",
                JSON.stringify([
                    {
                        ...publicSession,
                        lichess: {
                            ...publicSession.lichess,
                            ...(source === "persisted"
                                ? { handle: "stale-handle" }
                                : { accessToken: "legacy-token" }),
                        },
                    },
                    matchingSession,
                ]),
            );
            mocks.migrateLegacyLichessToken.mockResolvedValue({
                account: { username: "PLAYER", handle: "earlier-migrated-handle" },
                durability_uncertain: false,
            });
            mocks.listLichessAccounts.mockResolvedValue(
                populated ? [{ username: "PRESENT", handle: "present-handle" }] : [],
            );

            await initializePersistedSessions();
            const expected = [
                publicSession,
                {
                    ...matchingSession,
                    lichess: {
                        ...matchingSession.lichess,
                        ...(populated ? { handle: "present-handle" } : {}),
                    },
                },
            ];
            expect(decodeCompressedOrJson(localStorage.getItem("sessions"))).toEqual(expected);
            expect(mocks.getLichessAccount).not.toHaveBeenCalled();

            await initializePersistedSessions();
            expect(decodeCompressedOrJson(localStorage.getItem("sessions"))).toEqual(expected);
            mocks.listLichessAccounts.mockRejectedValue(new Error("offline on reload"));
            await initializePersistedSessions();
            expect(decodeCompressedOrJson(localStorage.getItem("sessions"))).toEqual(expected);
            expect(mocks.migrateLegacyLichessToken).toHaveBeenCalledTimes(
                source === "persisted" ? 0 : 1,
            );
            expect(localStorage.getItem("sessions")).not.toContain("legacy-token");
        },
    );

    test("a later successful listing replaces an earlier migrated handle", async () => {
        seedLegacySessions(["legacy-token"]);
        mocks.migrateLegacyLichessToken.mockResolvedValue({
            account: { username: "private-player-0", handle: "earlier-handle" },
            durability_uncertain: false,
        });
        mocks.listLichessAccounts.mockResolvedValue([
            { username: "PRIVATE-PLAYER-0", handle: "latest-handle" },
        ]);

        await initializePersistedSessions();

        expect(
            (
                decodeCompressedOrJson(
                    localStorage.getItem("sessions"),
                ) as import("./session").Session[]
            )[0].lichess?.handle,
        ).toBe("latest-handle");
    });

    test("a failed listing preserves the offline public session and opaque handle across reload", async () => {
        const session = {
            player: "Alias",
            updatedAt: 123,
            lichess: {
                username: "Player",
                handle: "offline-handle",
                account: { id: "player", username: "Player" },
            },
            chessCom: { username: "OtherProvider", stats: {} },
        };
        localStorage.setItem("sessions", JSON.stringify([session]));
        mocks.listLichessAccounts.mockRejectedValue(new Error("native unavailable"));

        await initializePersistedSessions();
        await initializePersistedSessions();

        expect(decodeCompressedOrJson(localStorage.getItem("sessions"))).toEqual([session]);
    });

    test("removes credential storage when the sanitized overwrite fails", async () => {
        localStorage.setItem(
            "sessions",
            JSON.stringify([
                {
                    updatedAt: 1,
                    lichess: {
                        username: "player",
                        account: { id: "player" },
                        accessToken: "credential-that-must-be-removed",
                    },
                },
            ]),
        );
        vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
            throw new DOMException("quota exceeded", "QuotaExceededError");
        });
        mocks.migrateLegacyLichessToken.mockResolvedValue({
            status: "error",
            error: "unavailable",
        });
        const outcome = await initializePersistedSessions();

        expect(outcome.status).toBe("saved");
        expect(deserializeStorageValue(localStorage.getItem("sessions")!)).toEqual(
            outcome.sessions,
        );
        expect(localStorage.getItem("sessions")).not.toContain("credential-that-must-be-removed");
        expect(mocks.revokeLegacyLichessToken).not.toHaveBeenCalled();
    });

    test("a failed ordinary write retains only safe public data and a successful ordinary write clears unsaved status", () => {
        const record = {
            updatedAt: 1,
            lichess: {
                username: "Player",
                account: { id: "player", username: "Player" },
                accessToken: "private-write-token",
            },
        };
        const refusal = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("private-write-token");
        });
        const outcome = savePublicSessions([record]);
        expect(outcome.status).toBe("unsaved");
        expect(JSON.stringify(outcome)).not.toMatch(/private-write-token|accessToken/);
        expect(retrySessionPersistence()).toEqual(outcome);
        refusal.mockRestore();
        const saved = savePublicSessions([{ ...outcome.sessions[0], player: "Latest alias" }]);
        expect(saved.status).toBe("saved");
        expect(deserializeStorageValue(localStorage.getItem("sessions")!)).toEqual(saved.sessions);
    });

    test("scrubs a token even when a sibling record is malformed", async () => {
        localStorage.setItem(
            "sessions",
            JSON.stringify([
                null,
                {
                    player: "player",
                    updatedAt: 1,
                    lichess: {
                        username: "player",
                        account: { id: "player", username: "player" },
                        accessToken: "legacy-secret-among-malformed-records",
                    },
                },
                "invalid sibling",
            ]),
        );
        mocks.migrateLegacyLichessToken.mockResolvedValue({
            status: "error",
            error: "unavailable",
        });
        await initializePersistedSessions();

        expect(mocks.migrateLegacyLichessToken).toHaveBeenCalledWith(
            "player",
            "legacy-secret-among-malformed-records",
        );
        const persisted = localStorage.getItem("sessions")!;
        expect(persisted).not.toContain("legacy-secret-among-malformed-records");
        expect(persisted).not.toContain("accessToken");
        expect(decodeCompressedOrJson(persisted)).toHaveLength(1);
    });

    test("erases a legacy bearer token before a failed native migration can persist it", async () => {
        localStorage.setItem(
            "sessions",
            JSON.stringify([
                {
                    player: "player",
                    updatedAt: 1,
                    lichess: {
                        username: "player",
                        account: { id: "player", username: "player" },
                        accessToken: "legacy-private-token",
                    },
                },
            ]),
        );
        mocks.migrateLegacyLichessToken.mockResolvedValue({
            status: "error",
            error: "unavailable",
        });
        await initializePersistedSessions();

        expect(mocks.migrateLegacyLichessToken).toHaveBeenCalledWith(
            "player",
            "legacy-private-token",
        );
        expect(localStorage.getItem("sessions")).not.toContain("legacy-private-token");
        expect(localStorage.getItem("sessions")).not.toContain("accessToken");
    });

    test("reconciles durable native accounts without duplicate public sessions", async () => {
        localStorage.setItem(
            "sessions",
            JSON.stringify([
                {
                    player: "Felix",
                    updatedAt: 1,
                    lichess: { username: "Felix", account: { id: "felix", username: "Felix" } },
                },
            ]),
        );
        mocks.listLichessAccounts.mockResolvedValue([
            { username: "felix", handle: "native-handle" },
        ]);
        await initializePersistedSessions();
        await initializePersistedSessions();

        const sessions = decodeCompressedOrJson(
            localStorage.getItem("sessions"),
        ) as import("./session").Session[];
        expect(sessions).toHaveLength(1);
        expect(sessions[0].lichess?.handle).toBe("native-handle");
        expect(mocks.getLichessAccount).not.toHaveBeenCalled();
    });
});
