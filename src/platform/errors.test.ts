import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TauriCommandError } from "./tauri";
import type { ErrorPayload } from "@/bindings";
import {
    errorUnlessCancelled,
    isErrorReported,
    markErrorReported,
    normalizeError,
    safeFailureContext,
    runAppliedMutationWithRefresh,
    runDestructiveWithRefresh,
    runWithAppliedRecovery,
    warnSafely,
} from "./errors";

const native = vi.hoisted(() => ({ warn: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./native", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./native")>()),
    warn: native.warn,
}));

describe("database busy discriminator", () => {
    test("preserves exact true through the command error and normalization", () => {
        const payload = {
            tag: "backend-error",
            category: "database",
            message: "database failure",
            databaseBusy: true,
        };
        expect(normalizeError(payload)).toMatchObject({ databaseBusy: true });
        expect(normalizeError(new TauriCommandError(payload))).toMatchObject({
            databaseBusy: true,
        });
        expect(safeFailureContext(payload)).not.toHaveProperty("databaseBusy");
    });
    test.each([undefined, false, null, 1, "true"])("omits non-true value %j", (databaseBusy) => {
        expect(
            normalizeError({
                tag: "backend-error",
                category: "database",
                message: "database failure",
                databaseBusy,
            }),
        ).not.toHaveProperty("databaseBusy");
    });
});

describe("database admission discriminator", () => {
    test("copies exact true without adding it to safe failure context", () => {
        const payload = {
            tag: "backend-error",
            category: "conflict",
            message: "Conflict: database is open through another name",
            databaseAdmission: true,
        };
        expect(normalizeError(payload)).toEqual({
            category: "validation",
            backendCategory: "conflict",
            message: payload.message,
            databaseAdmission: true,
        });
        expect(safeFailureContext(payload)).toEqual({
            category: "validation",
            message: payload.message,
        });
    });

    test.each([false, null, 1, "true"])("omits non-true value %j", (databaseAdmission) => {
        expect(
            normalizeError({
                tag: "backend-error",
                category: "conflict",
                message: "Conflict: database is open through another name",
                databaseAdmission,
            }),
        ).not.toHaveProperty("databaseAdmission");
    });
});

describe("explicit error reporting ownership", () => {
    test("marks a frozen safe payload by identity without changing its fields or normalization", () => {
        const payload = Object.freeze<ErrorPayload>({
            tag: "engine-failure",
            category: "engine-timeout",
            message: "Engine timeout: waiting for uciok",
            rootFailure: "permission",
            engineFailure: {
                kind: "protocol-failure",
                exitStatus: null,
                reason: "uciok",
                entries: [],
            },
            remoteHttpRejection: { status: 403, authorizationSent: false },
        });
        const copy = structuredClone(payload);
        const normalized = normalizeError(payload);
        expect(isErrorReported(payload)).toBe(false);
        markErrorReported(payload);
        markErrorReported(payload);
        expect(isErrorReported(payload)).toBe(true);
        expect(isErrorReported(copy)).toBe(false);
        expect(payload).toEqual(copy);
        expect(normalizeError(payload)).toEqual(normalized);
    });

    test("marked Cancellation keeps the pinned cancellation outcome", () => {
        const cancellation = new Error("Cancellation");
        markErrorReported(cancellation);
        expect(isErrorReported(cancellation)).toBe(true);
        expect(cancellation.message).toBe("Cancellation");
        expect(errorUnlessCancelled(cancellation)).toBeNull();
    });

    test.each([undefined, null, "network failed", 42, false])(
        "leaves primitive errors outside object reporting ownership: %j",
        (error) => {
            markErrorReported(error);
            expect(isErrorReported(error)).toBe(false);
        },
    );
});

describe("warnSafely", () => {
    beforeEach(() => {
        native.warn.mockReset().mockResolvedValue(undefined);
    });

    afterEach(() => vi.restoreAllMocks());

    test("reports through the native logger without a console fallback when it resolves", async () => {
        const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const message = "Could not report a warning";

        expect(warnSafely(message)).toBeUndefined();
        await Promise.resolve();

        expect(native.warn).toHaveBeenCalledExactlyOnceWith(message);
        expect(consoleWarn).not.toHaveBeenCalled();
    });

    test("falls back to console with a sanitized logger failure without an unhandled rejection", async () => {
        native.warn.mockRejectedValueOnce(
            new Error("logger failed at /private/logger.log token=secret"),
        );
        const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const message = "Could not report a warning";

        expect(warnSafely(message)).toBeUndefined();
        await Promise.resolve();

        expect(native.warn).toHaveBeenCalledExactlyOnceWith(message);
        expect(consoleWarn).toHaveBeenCalledExactlyOnceWith(message, {
            loggerFailure: {
                category: "unexpected",
                message: "logger failed at [path] token=[redacted]",
            },
        });
    });
});

describe("normalizeError", () => {
    test("carries only the typed remote rejection detail through command normalization", () => {
        const payload = {
            tag: "backend-error",
            category: "authentication",
            message: "Remote HTTP request rejected: status 401",
            remoteHttpRejection: { status: 401, authorizationSent: true, extra: "ignored" },
        };
        const normalized = normalizeError(payload);
        expect(normalized).toEqual({
            category: "permission",
            backendCategory: "authentication",
            message: payload.message,
            remoteHttpRejection: { status: 401, authorizationSent: true },
        });
        expect(normalizeError(normalized)).toBe(normalized);
        const wrapped = new TauriCommandError(payload);
        expect(wrapped.details).toEqual(normalized);
        expect(normalizeError(wrapped)).toBe(wrapped.details);
    });

    test.each([
        undefined,
        null,
        "401",
        401,
        {},
        { status: "401", authorizationSent: true },
        { status: NaN, authorizationSent: true },
        { status: Infinity, authorizationSent: true },
        { status: -Infinity, authorizationSent: false },
        { status: 401 },
        { status: 401, authorizationSent: "true" },
    ])("omits absent or malformed remote rejection detail %j", (remoteHttpRejection) => {
        expect(
            normalizeError({
                tag: "backend-error",
                category: "network",
                message: "Remote HTTP request rejected: status 401",
                remoteHttpRejection,
            }),
        ).toEqual({
            category: "network",
            backendCategory: "network",
            message: "Remote HTTP request rejected: status 401",
        });
    });

    test.each([
        ["engine-retired", "validation"],
        ["cancellation", "cancelled"],
        ["conflict", "validation"],
        ["operation-and-cleanup", "unexpected"],
    ] as const)(
        "classifies %s by category and retains its native identity",
        (backendCategory, category) => {
            const normalized = normalizeError({
                tag: "backend-error",
                category: backendCategory,
                message: "Engine id is retired",
            });
            expect(normalized).toEqual({
                category,
                backendCategory,
                message: "Engine id is retired",
            });
            expect(normalizeError(new TauriCommandError(normalized))).toEqual(normalized);
        },
    );

    test("preserves the typed terminal snapshot and re-redacts retained engine text", () => {
        const error = {
            tag: "engine-failure",
            category: "engine-failure",
            message: "Engine failed",
            engineFailure: {
                kind: "process-exit",
                exitStatus: { code: 7, signal: null },
                reason: "e2e4 rejected at /private/book.bin token=secret",
                entries: [
                    { type: "truncated" },
                    { type: "infoString", value: "e2e4 token=secret" },
                    { type: "stderr", value: "failed at C:\\private\\book.bin" },
                ],
            },
        };
        const expected = {
            kind: "process-exit",
            exitStatus: { code: 7, signal: null },
            reason: "e2e4 rejected at [path] token=[redacted]",
            entries: [
                { type: "truncated" },
                { type: "infoString", value: "e2e4 token=[redacted]" },
                { type: "stderr", value: "failed at [path]" },
            ],
        };
        expect(normalizeError(error)).toEqual({
            category: "unexpected",
            backendCategory: "engine-failure",
            message: "Engine failed",
            engineFailure: expected,
        });
        expect(normalizeError(new TauriCommandError(normalizeError(error)))).toEqual(
            normalizeError(error),
        );
        expect(
            safeFailureContext({
                category: "unexpected",
                message: "Engine failed",
                engineFailure: error.engineFailure,
            }),
        ).toEqual({ category: "unexpected", message: "Engine failed", engineFailure: expected });
    });

    test("keeps a typed engine failure without a snapshot unexpected", () => {
        expect(
            normalizeError({
                tag: "engine-failure",
                category: "engine-failure",
                message: "Engine failed",
            }),
        ).toEqual({
            category: "unexpected",
            backendCategory: "engine-failure",
            message: "Engine failed",
        });
    });
    test("retains sanitized causes of an empty-message subscriber AggregateError", () => {
        const error = new AggregateError([
            new Error("Subscriber failed at /private/game.pgn token=secret"),
        ]);
        expect(normalizeError(error)).toEqual({
            category: "unexpected",
            message: "Aggregate error: Subscriber failed at [path] token=[redacted]",
        });
    });

    test("retains both aggregate message and contained cause without a duplicate diagnostic", () => {
        expect(
            normalizeError(new AggregateError([new Error("Observer failed")], "Update failed")),
        ).toEqual({
            category: "unexpected",
            message: "Aggregate error: Update failed | Observer failed",
        });
    });

    test("retains nested aggregate causes and terminates cyclic aggregates", () => {
        const inner = new AggregateError([
            new Error("Nested failure at /private/game.pgn password=hunter2"),
        ]);
        const outer = new AggregateError([inner], "Publish failed");
        inner.errors.push(outer);
        expect(normalizeError(outer)).toEqual({
            category: "unexpected",
            message:
                "Aggregate error: Publish failed | Aggregate error: Nested failure at [path] password=[redacted] | [circular]",
        });
    });

    test.each(["", "Update failed"])(
        "keeps an empty aggregate visible with outer message %j",
        (message) => {
            const normalized = normalizeError(new AggregateError([], message));
            expect(normalized).toEqual({
                category: "unexpected",
                message: `Aggregate error: ${message || "Unexpected error"}`,
            });
            expect(errorUnlessCancelled(normalized)).toBe(normalized);
        },
    );

    test.each(["Cancellation", "Analysis cancelled", "connection aborted"])(
        "keeps aggregate cause %s unexpected and visible",
        (message) => {
            const error = new AggregateError(
                [
                    new Error(message),
                    { tag: "backend-error", category: "cancellation", message: "Cancellation" },
                ],
                "Cancellation",
            );
            expect(normalizeError(error)).toEqual({
                category: "unexpected",
                message: `Aggregate error: Cancellation | ${message} | Cancellation`,
            });
            expect(errorUnlessCancelled(error)).not.toBeNull();
        },
    );

    test.each(["changed", "missing", "unusable", "permission", "too-large"] as const)(
        "carries rootFailure %s from the payload and command details",
        (rootFailure) => {
            const payload = {
                tag: "backend-error",
                category: "conflict",
                message: "Conflict: original failure",
                rootFailure,
            };
            expect(normalizeError(payload)).toEqual({
                category: "validation",
                backendCategory: "conflict",
                message: payload.message,
                rootFailure,
            });
            const wrapped = new TauriCommandError(payload);
            expect(wrapped.details.rootFailure).toBe(rootFailure);
            expect(normalizeError(wrapped)).toBe(wrapped.details);
        },
    );

    test("leaves rootFailure absent when unset", () => {
        const payload = { tag: "backend-error", category: "io", message: "I/O failure" };
        for (const error of [payload, new TauriCommandError(payload), new Error("failed")]) {
            expect(normalizeError(error)).not.toHaveProperty("rootFailure");
        }
    });

    const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

    test("redacts secrets without emitting a literal $1", () => {
        const bearer = normalizeError(new Error("Authorization: Bearer sk-abc123 rejected"));
        expect(bearer.message).toBe("Authorization: Bearer [redacted] rejected");
        expect(bearer.message).not.toContain("$1");
        expect(bearer.message).not.toContain("sk-abc123");

        const token = normalizeError(new Error("token=xyz expired"));
        expect(token.message).toBe("token=[redacted] expired");
        expect(token.message).not.toContain("$1");

        const password = normalizeError(new Error("password: hunter2 failed"));
        expect(password.message).toBe("password: [redacted] failed");
        expect(password.message).not.toContain("hunter2");

        const jsonPassword = normalizeError('{"password":"hunter2"}');
        expect(jsonPassword.message).toBe('{"password":"[redacted]"}');
        const jsonToken = normalizeError('{"token":"abc"}');
        expect(jsonToken.message).toBe('{"token":"[redacted]"}');
    });

    test("redacts filesystem paths and preserves chess notation", () => {
        const unix = normalizeError(new Error("failed at /home/felix/secret.pgn"));
        expect(unix.message).toBe("failed at [path]");

        const windows = normalizeError(new Error("failed at C:\\Users\\felix\\secret.pgn"));
        expect(windows.message).toBe("failed at [path]");

        const windowsForward = normalizeError(new Error("failed at C:/Users/felix/secret.pgn"));
        expect(windowsForward.message).toBe("failed at [path]");

        const unc = normalizeError(new Error("failed at \\\\server\\share\\file.pgn"));
        expect(unc.message).toBe("failed at [path]");

        const home = normalizeError(new Error("failed at ~/secret.pgn"));
        expect(home.message).toBe("failed at [path]");

        const rootFile = normalizeError(new Error("failed at /secret.pgn"));
        expect(rootFile.message).toBe("failed at [path]");

        const spacedWindows = normalizeError(new Error("failed at C:\\Program Files\\secret.pgn"));
        expect(spacedWindows.message).toBe("failed at [path]");
        expect(spacedWindows.message).not.toContain("Program Files");

        const longExt = normalizeError(new Error("failed at /secret.credentials"));
        expect(longExt.message).toBe("failed at [path]");

        const httpsUrl = normalizeError(
            new Error("network failure at https://example.com/api/foo"),
        );
        expect(httpsUrl.message).toBe("network failure at https://example.com/api/foo");
        expect(httpsUrl.category).toBe("network");
        const httpUrl = normalizeError(new Error("fetch failed at http://example.com/foo"));
        expect(httpUrl.message).toBe("fetch failed at http://example.com/foo");

        const fen = normalizeError(new Error(`Invalid FEN: ${START_FEN}`));
        expect(fen.message).toBe(`Invalid FEN: ${START_FEN}`);

        const draw = normalizeError(new Error("1/2-1/2 result malformed"));
        expect(draw.message).toBe("1/2-1/2 result malformed");
    });

    test("classifies from the unredacted source", () => {
        const error = normalizeError(new Error("open /home/user/missing.pgn"));
        expect(error.category).toBe("not-found");
        expect(error.message).toBe("open [path]");
        expect(error.message).not.toContain("/home/user");
    });

    test("omits diagnostic", () => {
        expect(normalizeError(new Error("native failed")).diagnostic).toBeUndefined();
    });

    test("handles circular non-error values", () => {
        const circular: { self?: unknown } = {};
        circular.self = circular;
        expect(normalizeError(circular).message).toContain("[circular]");
    });

    test("does not throw on empty values", () => {
        expect(normalizeError(undefined).category).toBe("unexpected");
        expect(normalizeError(() => undefined).category).toBe("unexpected");
        expect(() => normalizeError(null)).not.toThrow();
    });

    // Each cause below is worded so that some *other* branch would claim it if
    // `applied-despite-error` were not tested first. These are copies of the Rust literals, so
    // this test pins only THIS side of the contract: rewording `Error::PartialRemoval` or
    // `Error::CommittedDurabilityUncertain` does not turn it red. The backend asserts the
    // literals it emits, in `infra::fs`'s tests, and that is the half that catches a reword.
    test.each([
        "Partially removed: 2 entries were deleted before failing: child not found",
        "Committed but durability uncertain: parent not found",
        "Partially removed: 1 entries were deleted before failing: connection aborted",
        "Partially removed: 3 entries were deleted before failing: operation timeout",
        "Partially removed: 1 entries were deleted before failing: permission denied",
        "Committed but durability uncertain: invalid argument",
    ])("categorizes destructive changes that could not be fully reported", (message) => {
        const error = normalizeError(new Error(message));
        expect(error.category).toBe("applied-despite-error");
        expect(error.message).toBe(message);
    });

    test("keeps I/O in a partial-removal cause", () => {
        const error = normalizeError(
            new Error("Partially removed: 1 entries were deleted before failing: I/O failure"),
        );
        expect(error.category).toBe("applied-despite-error");
        expect(error.message).toBe(
            "Partially removed: 1 entries were deleted before failing: I/O failure",
        );
    });

    test.each([
        ["Engine timeout: waiting for readyok", "unexpected"],
        ["connection aborted", "network"],
        ["network failure", "network"],
        ["Cancellation", "cancelled"],
        ["Analysis cancelled", "cancelled"],
        ["Game not found: abc", "not-found"],
        ["Missing reference database", "not-found"],
        ["No moves found", "not-found"],
        ["No opening found", "not-found"],
        ["No puzzles", "not-found"],
        ["Invalid input: bad tag", "validation"],
        ["Invalid color: green", "validation"],
        ["Conflict: path already exists", "validation"],
        ["Resource limit: depth exceeded", "validation"],
        ["Game not in progress", "validation"],
        ["Not human's turn", "validation"],
        ["Not engine's turn", "validation"],
        ["Players aren't the same. They have played against each other", "validation"],
        ["OAuth failure: denied", "permission"],
        ["Credential operation failed", "permission"],
        ["Credential operation requires recovery", "permission"],
    ] as const)("maps owned Display %s to %s", (message, category) => {
        expect(normalizeError(new Error(message)).category).toBe(category);
        expect(normalizeError(message).category).toBe(category);
        expect(normalizeError(message).message).toBe(message);
    });

    test("categorizes cancellation and keeps it silent for Error and string IPC", () => {
        expect(normalizeError(new Error("Cancellation")).category).toBe("cancelled");
        expect(errorUnlessCancelled(new Error("Cancellation"))).toBeNull();
        expect(errorUnlessCancelled(new DOMException("Cancellation", "AbortError"))).toBeNull();
        expect(errorUnlessCancelled("Cancellation")).toBeNull();
    });

    test("errorUnlessCancelled still keys on the Cancellation message for structured payloads", () => {
        expect(
            errorUnlessCancelled({
                tag: "backend-error",
                category: "cancellation",
                message: "Cancellation",
            }),
        ).toBeNull();
        expect(
            errorUnlessCancelled({
                tag: "backend-error",
                category: "cancellation",
                message: "Analysis cancelled",
            }),
        ).toEqual({
            category: "cancelled",
            backendCategory: "cancellation",
            message: "Analysis cancelled",
        });
    });

    test("keeps a real failure visible", () => {
        expect(errorUnlessCancelled(new Error("permission denied"))).toMatchObject({
            category: "permission",
        });
        expect(errorUnlessCancelled(new Error("connection aborted"))).toMatchObject({
            category: "network",
            message: "connection aborted",
        });
        expect(errorUnlessCancelled(new Error("operation timeout"))).not.toBeNull();
        expect(errorUnlessCancelled("Engine timeout: waiting for readyok")).toMatchObject({
            category: "unexpected",
            message: "Engine timeout: waiting for readyok",
        });
        expect(normalizeError("Game not found: timeout").category).toBe("not-found");
        expect(normalizeError("Invalid input: abort").category).toBe("validation");
    });

    test("returns an already-normalised AppError and TauriCommandError details", () => {
        const existing = { category: "validation" as const, message: "Conflict: x" };
        expect(normalizeError(existing)).toBe(existing);

        const details = { category: "network" as const, message: "connection aborted" };
        const wrapped = Object.assign(new Error(details.message), { details });
        expect(normalizeError(wrapped)).toBe(details);
    });

    // Each structured row carries a message `classify()` would map differently from
    // BACKEND_CATEGORY, so deleting the ErrorPayload branch turns the row red.
    test.each([
        ["durability", "native failed", "applied-despite-error"],
        ["engine-timeout", "timeout", "unexpected"],
        ["conflict", "Engine timeout: waiting for readyok", "validation"],
        ["stale-game", "The game changed on disk", "validation"],
        ["cancellation", "connection aborted", "cancelled"],
        ["missing-resource", "I/O failure", "not-found"],
        ["missing-resource", "The file was moved to the trash", "not-found"],
        ["permission", "I/O failure", "permission"],
        ["parsing", "parsing failure", "validation"],
        ["chess-data", "chess data failure", "validation"],
        ["resource-limit", "resource limit", "validation"],
        ["authentication", "authentication failure", "permission"],
        ["credential", "credential failure", "permission"],
        ["puzzle-themes-unavailable", "Puzzle themes unavailable", "not-found"],
    ] as const)(
        "maps structured %s payload to %s even when the message disagrees",
        (backendCategory, message, category) => {
            expect(
                normalizeError({
                    tag: "backend-error",
                    category: backendCategory,
                    message,
                }),
            ).toEqual({
                category,
                backendCategory,
                message,
            });
        },
    );

    test("redacts a structured command payload", () => {
        expect(
            normalizeError({
                tag: "backend-error",
                category: "io",
                message: "failed at /private/secret",
            }),
        ).toEqual({
            category: "unexpected",
            backendCategory: "io",
            message: "failed at [path]",
        });
    });

    test("preserves an already-normalised AppError that overlaps a backend category", () => {
        const existing = { category: "network" as const, message: "connection aborted" };
        expect(normalizeError(existing)).toBe(existing);

        const payload = {
            tag: "backend-error" as const,
            category: "network" as const,
            message: "connection aborted",
        };
        const mapped = normalizeError(payload);
        expect(mapped).not.toBe(payload);
        expect(mapped).toEqual({
            category: "network",
            backendCategory: "network",
            message: "connection aborted",
        });
    });
});

const structuredAppliedPayloads = [
    { tag: "backend-error" as const, category: "durability" as const, message: "native failed" },
    {
        tag: "backend-error" as const,
        category: "partial-removal" as const,
        message: "native failed",
    },
];

describe("cleanup reconciliation", () => {
    test.each([false, true])(
        "refresh preserves cleanup rejection when refresh fails=%s",
        async (fails) => {
            const cause = new TauriCommandError({
                tag: "backend-error",
                category: "operation-and-cleanup",
                message: "native diagnostic",
            });
            const refresh = vi.fn(async () => {
                if (fails) throw new Error("listing failed");
            });
            await expect(
                runAppliedMutationWithRefresh(async () => {
                    throw cause;
                }, refresh),
            ).rejects.toBe(cause);
            expect(refresh).toHaveBeenCalledExactlyOnceWith(cause);
            expect(normalizeError(cause)).toMatchObject({
                category: "unexpected",
                backendCategory: "operation-and-cleanup",
            });
        },
    );

    test.each([false, true])(
        "cleanup never recovers an object when reconciliation fails=%s",
        async (fails) => {
            const cause = new TauriCommandError({
                tag: "backend-error",
                category: "operation-and-cleanup",
                message: "native diagnostic",
            });
            const recover = vi.fn(async () => "leftover");
            const reconcile = vi.fn(async () => {
                if (fails) throw new Error("listing failed");
                return "leftover";
            });
            await expect(
                runWithAppliedRecovery(
                    async () => {
                        throw cause;
                    },
                    recover,
                    reconcile,
                ),
            ).rejects.toBe(cause);
            expect(reconcile).toHaveBeenCalledOnce();
            expect(recover).not.toHaveBeenCalled();
        },
    );

    test("cleanup without an explicit reconciliation callback does not run recovery or destructive effects", async () => {
        const cause = {
            tag: "backend-error",
            category: "operation-and-cleanup",
            message: "native diagnostic",
        };
        const recover = vi.fn(async () => "leftover");
        const refresh = vi.fn();
        await expect(
            runWithAppliedRecovery(async () => {
                throw cause;
            }, recover),
        ).rejects.toBe(cause);
        await expect(
            runDestructiveWithRefresh(async () => {
                throw cause;
            }, refresh),
        ).rejects.toBe(cause);
        expect(recover).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
    });
});

describe("runAppliedMutationWithRefresh", () => {
    test("refreshes and resolves an applied-despite-error mutation", async () => {
        const refresh = vi.fn();
        await expect(
            runAppliedMutationWithRefresh(
                async () =>
                    Promise.reject(
                        new Error("Committed but durability uncertain: registry replacement"),
                    ),
                refresh,
            ),
        ).resolves.toBeUndefined();
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    test("does not refresh or swallow an ordinary rejection", async () => {
        const refresh = vi.fn();
        await expect(
            runAppliedMutationWithRefresh(
                async () => Promise.reject(new Error("native failed")),
                refresh,
            ),
        ).rejects.toThrow("native failed");
        expect(refresh).not.toHaveBeenCalled();
    });

    test("keeps the applied rejection when its refresh fails", async () => {
        const error = new Error("Committed but durability uncertain: registry replacement");
        await expect(
            runAppliedMutationWithRefresh(
                async () => Promise.reject(error),
                async () => Promise.reject(new Error("refresh failed")),
            ),
        ).rejects.toBe(error);
    });
});

test("runWithAppliedRecovery keeps the applied rejection when recovery fails", async () => {
    const error = new Error("Committed but durability uncertain: registry replacement");
    await expect(
        runWithAppliedRecovery(
            async () => Promise.reject(error),
            async () => {
                throw new Error("list failed");
            },
        ),
    ).rejects.toBe(error);
});

test("runWithAppliedRecovery returns the recovered committed object", async () => {
    const recovered = { id: "recovered" };
    await expect(
        runWithAppliedRecovery(
            async () =>
                Promise.reject(
                    new Error("Committed but durability uncertain: registry replacement"),
                ),
            async () => recovered,
        ),
    ).resolves.toBe(recovered);
});

describe("runDestructiveWithRefresh", () => {
    test("refreshes after success", async () => {
        const refresh = vi.fn();
        await expect(runDestructiveWithRefresh(async () => "done", refresh)).resolves.toBe("done");
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    test("refreshes and preserves an applied-despite-error rejection", async () => {
        const refresh = vi.fn();
        const error = new Error(
            "Partially removed: 1 entries were deleted before failing: conflict",
        );
        await expect(
            runDestructiveWithRefresh(async () => Promise.reject(error), refresh),
        ).rejects.toBe(error);
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    test("keeps the destructive rejection when refresh itself fails", async () => {
        const error = new Error(
            "Partially removed: 1 entries were deleted before failing: conflict",
        );
        await expect(
            runDestructiveWithRefresh(
                async () => Promise.reject(error),
                async () => {
                    throw new Error("relist failed");
                },
            ),
        ).rejects.toBe(error);
    });

    test("does not refresh after an ordinary rejection", async () => {
        const refresh = vi.fn();
        await expect(
            runDestructiveWithRefresh(
                async () => Promise.reject(new Error("native failed")),
                refresh,
            ),
        ).rejects.toThrow("native failed");
        expect(refresh).not.toHaveBeenCalled();
    });

    test.each(structuredAppliedPayloads)(
        "refreshes a structured $category payload the substring table would not apply",
        async (payload) => {
            const refresh = vi.fn();
            await expect(
                runDestructiveWithRefresh(async () => Promise.reject(payload), refresh),
            ).rejects.toBe(payload);
            expect(refresh).toHaveBeenCalledTimes(1);
        },
    );
});

describe("structured applied-despite-error helpers", () => {
    test.each(structuredAppliedPayloads)(
        "runAppliedMutationWithRefresh swallows structured $category",
        async (payload) => {
            const refresh = vi.fn();
            await expect(
                runAppliedMutationWithRefresh(async () => Promise.reject(payload), refresh),
            ).resolves.toBeUndefined();
            expect(refresh).toHaveBeenCalledTimes(1);
        },
    );

    test.each(structuredAppliedPayloads)(
        "runWithAppliedRecovery recovers from structured $category",
        async (payload) => {
            const recovered = { id: "recovered" };
            await expect(
                runWithAppliedRecovery(
                    async () => Promise.reject(payload),
                    async () => recovered,
                ),
            ).resolves.toBe(recovered);
        },
    );
});
