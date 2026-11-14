import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    cancelDownload: vi.fn(),
    cancelDownloadForProgress: vi.fn(),
    clearProgress: vi.fn(),
    notifyUnlessCancelled: vi.fn(),
    warn: vi.fn(),
    withDownloadTicket: vi.fn(),
    snapshot: vi.fn(),
    listen: vi.fn(),
    unlisten: vi.fn(),
}));

vi.mock("@/bindings/generated", async (original) => {
    const actual = (await original()) as {
        commands: Record<string, unknown>;
        events: Record<string, unknown>;
    };
    return {
        ...actual,
        commands: { ...actual.commands, failedProgressSnapshot: mocks.snapshot },
        events: { ...actual.events, progressEvent: { listen: mocks.listen } },
    };
});

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));

vi.mock("@/components/files/notifyError", () => ({
    notifyUnlessCancelled: mocks.notifyUnlessCancelled,
}));

vi.mock("@/platform/native", () => ({ warn: mocks.warn }));

vi.mock("@/platform/tauri", async () => {
    const actual = await vi.importActual<typeof import("@/platform/tauri")>("@/platform/tauri");
    return {
        ...actual,
        tauri: {
            ...actual.tauri,
            cancelDownload: mocks.cancelDownload,
            cancelDownloadForProgress: mocks.cancelDownloadForProgress,
            clearProgress: mocks.clearProgress,
        },
        withDownloadTicket: mocks.withDownloadTicket,
    };
});

import { cancellationError, unwrapCommand } from "@/platform/tauri";
import { normalizeError } from "@/platform/errors";
import { cancelDownloadJob, runDownloadJob, useRunningDownloadJob } from "./downloadJobs";

beforeEach(() => {
    mocks.cancelDownload.mockReset().mockResolvedValue(true);
    mocks.cancelDownloadForProgress.mockReset().mockResolvedValue(false);
    mocks.clearProgress.mockReset().mockResolvedValue(42n);
    mocks.notifyUnlessCancelled.mockReset();
    mocks.warn.mockReset().mockResolvedValue(undefined);
    mocks.snapshot.mockReset().mockResolvedValue({ status: "ok", data: [] });
    mocks.listen.mockReset().mockResolvedValue(mocks.unlisten);
    mocks.unlisten.mockReset();
    mocks.withDownloadTicket
        .mockReset()
        .mockImplementation(async (run: (ticket: string) => Promise<unknown>) =>
            run("prepared-ticket"),
        );
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function commandFailure(progressGeneration?: unknown, message = "I/O failure") {
    try {
        unwrapCommand({
            status: "error",
            error: {
                tag: "backend-error",
                category: message.startsWith("Conflict:") ? "conflict" : "io",
                message,
                ...(progressGeneration === undefined ? {} : { progressGeneration }),
            },
        });
    } catch (error) {
        return error;
    }
    throw new Error("expected command failure");
}

const failurePayload = { tag: "backend-error", category: "io", message: "I/O failure" } as const;
const failedEvent = (generation = "9007199254740993", id = "observed") => ({
    id,
    generation,
    progress: 37,
    finished: true,
    state: "failed" as const,
    cleared: false,
    failure: failurePayload,
});

describe("download failure observer", () => {
    let observer: typeof import("./downloadJobs");
    const emit = (payload: object) => mocks.listen.mock.calls[0]![0]({ payload });

    beforeEach(async () => {
        vi.resetModules();
        observer = await import("./downloadJobs");
    });

    afterEach(() => observer.disposeDownloadFailures());

    test("subscribes before snapshot and announces one unowned event per generation", async () => {
        await observer.initializeDownloadFailures();
        await observer.initializeDownloadFailures();
        expect(mocks.listen).toHaveBeenCalledOnce();
        expect(mocks.listen.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.snapshot.mock.invocationCallOrder[0]!,
        );
        emit(failedEvent());
        emit(failedEvent());
        expect(mocks.notifyUnlessCancelled).toHaveBeenCalledExactlyOnceWith(
            "Common.Error",
            failurePayload,
        );
        expect(mocks.clearProgress).toHaveBeenCalledExactlyOnceWith("observed");
        emit(failedEvent("9007199254740994"));
        expect(mocks.notifyUnlessCancelled).toHaveBeenCalledTimes(2);
    });

    test("snapshot uses the facade's wire generation normalization and deduplicates event delivery", async () => {
        mocks.snapshot.mockResolvedValue({ status: "ok", data: [failedEvent()] });
        await observer.initializeDownloadFailures();
        emit(failedEvent());
        expect(mocks.notifyUnlessCancelled).toHaveBeenCalledExactlyOnceWith(
            "Common.Error",
            failurePayload,
        );
        expect(mocks.clearProgress).toHaveBeenCalledExactlyOnceWith("observed");
    });

    test("ignores absent payloads, clears, cancellation and running items", async () => {
        await observer.initializeDownloadFailures();
        emit({ ...failedEvent(), failure: undefined });
        emit({ ...failedEvent(), cleared: true });
        emit({ ...failedEvent(), state: "cancelled" });
        emit({ ...failedEvent(), state: "running", finished: false });
        expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
        expect(mocks.clearProgress).not.toHaveBeenCalled();
    });

    test("snapshot failure logs and leaves the listener usable", async () => {
        mocks.snapshot.mockRejectedValue(new Error("snapshot refused"));
        await observer.initializeDownloadFailures();
        expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
            "failed progress snapshot: snapshot refused",
        );
        emit(failedEvent());
        expect(mocks.notifyUnlessCancelled).toHaveBeenCalledOnce();
    });

    test("a failed clear leaves one announcement and document disposal removes the listener", async () => {
        mocks.clearProgress.mockRejectedValue(new Error("clear refused"));
        await observer.initializeDownloadFailures();
        emit(failedEvent());
        emit(failedEvent());
        await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalledOnce());
        observer.disposeDownloadFailures();
        emit(failedEvent("9007199254740994"));
        expect(mocks.notifyUnlessCancelled).toHaveBeenCalledOnce();
        expect(mocks.unlisten).toHaveBeenCalledOnce();
    });

    test.each([true, false])(
        "command-owned generation stays silent with failure before settlement %s",
        async (before) => {
            await observer.initializeDownloadFailures();
            const result = deferred<void>();
            const error = commandFailure("9007199254740993");
            const attempt = observer
                .runDownloadJob("observed", () => result.promise)
                .catch((cause) => {
                    mocks.notifyUnlessCancelled("Live wrapper", cause);
                });
            if (before) emit(failedEvent());
            expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
            result.reject(error);
            await attempt;
            emit({ ...failedEvent(), state: "running", finished: false, progress: 0 });
            emit(failedEvent());
            emit(failedEvent());
            expect(mocks.notifyUnlessCancelled).toHaveBeenCalledExactlyOnceWith(
                "Live wrapper",
                error,
            );
            emit(failedEvent("9007199254740994"));
            expect(mocks.notifyUnlessCancelled).toHaveBeenLastCalledWith(
                "Common.Error",
                failurePayload,
            );
            expect(mocks.notifyUnlessCancelled).toHaveBeenCalledTimes(2);
        },
    );

    test.each([true, false])(
        "refused duplicate admission owns no survivor, buffered %s",
        async (before) => {
            await observer.initializeDownloadFailures();
            const result = deferred<void>();
            // Even a misplaced generation cannot turn this specific refusal into ownership.
            const conflict = commandFailure(
                "9007199254740993",
                "Conflict: download progress is already active",
            );
            const attempt = observer
                .runDownloadJob("observed", () => result.promise)
                .catch((cause) => {
                    mocks.notifyUnlessCancelled("Live wrapper", cause);
                });
            emit({ ...failedEvent(), state: "running", finished: false, progress: 0 });
            if (before) emit(failedEvent());
            expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
            result.reject(conflict);
            await attempt;
            emit(failedEvent());
            emit(failedEvent());
            expect(mocks.notifyUnlessCancelled.mock.calls).toEqual(
                before
                    ? [
                          ["Common.Error", failurePayload],
                          ["Live wrapper", conflict],
                      ]
                    : [
                          ["Live wrapper", conflict],
                          ["Common.Error", failurePayload],
                      ],
            );
        },
    );

    test.each([true, false])(
        "preparation cancellation owns no running generation, failure during preparation %s",
        async (during) => {
            await observer.initializeDownloadFailures();
            const preparation = deferred<string>();
            mocks.withDownloadTicket.mockImplementation(
                (run: (ticket: string) => Promise<unknown>) => preparation.promise.then(run),
            );
            const run = vi.fn();
            const attempt = observer.runDownloadJob("observed", run);
            const caught = attempt.catch((error) => error);
            const cancel = observer.cancelDownloadJob("observed");
            emit({ ...failedEvent(), state: "running", finished: false, progress: 0 });
            if (during) emit(failedEvent());
            expect(mocks.notifyUnlessCancelled).toHaveBeenCalledTimes(during ? 1 : 0);
            preparation.resolve("unused-ticket");
            expect(await caught).toMatchObject({ message: "Cancellation" });
            await cancel;
            expect(run).not.toHaveBeenCalled();
            emit(failedEvent());
            expect(mocks.notifyUnlessCancelled).toHaveBeenCalledExactlyOnceWith(
                "Common.Error",
                failurePayload,
            );
            emit(failedEvent("9007199254740994"));
            expect(mocks.notifyUnlessCancelled).toHaveBeenCalledTimes(2);
        },
    );

    test.each(["before error", "during clear", "after settlement"])(
        "pre-begin failure commits nothing: survivor delivery %s",
        async (delivery) => {
            await observer.initializeDownloadFailures();
            const result = deferred<void>();
            const clear = deferred<bigint>();
            mocks.clearProgress.mockReturnValueOnce(clear.promise);
            const error = commandFailure();
            expect(normalizeError(error)).not.toHaveProperty("progress_generation");
            const caught = observer
                .runDownloadJob("observed", () => result.promise)
                .catch((cause) => cause);
            const survivor = () => {
                emit({ ...failedEvent(), state: "running", finished: false, progress: 0 });
                emit(failedEvent());
            };
            if (delivery === "before error") survivor();
            result.reject(error);
            await vi.waitFor(() => expect(mocks.clearProgress).toHaveBeenCalledOnce());
            if (delivery === "during clear") survivor();
            expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
            clear.resolve(42n);
            expect(await caught).toBe(error);
            if (delivery === "after settlement") survivor();
            expect(mocks.notifyUnlessCancelled).toHaveBeenCalledExactlyOnceWith(
                "Common.Error",
                failurePayload,
            );
            emit(failedEvent());
            expect(mocks.notifyUnlessCancelled).toHaveBeenCalledOnce();
        },
    );

    test("buffers only the invoked id and flushes every unowned generation", async () => {
        await observer.initializeDownloadFailures();
        const result = deferred<void>();
        const caught = observer
            .runDownloadJob("observed", () => result.promise)
            .catch((cause) => cause);
        emit(failedEvent());
        emit(failedEvent("9007199254740994"));
        emit(failedEvent("9007199254740995", "other"));
        expect(mocks.notifyUnlessCancelled).toHaveBeenCalledOnce();
        result.reject(commandFailure("9007199254740993"));
        await caught;
        expect(mocks.notifyUnlessCancelled).toHaveBeenCalledTimes(2);
        emit(failedEvent("9007199254740994"));
        expect(mocks.notifyUnlessCancelled).toHaveBeenCalledTimes(2);
    });

    test.each([42, 42n, null, {}, true])(
        "normalization drops a generation with the wrong wire type: %s",
        (generation) => {
            expect(normalizeError(commandFailure(generation))).not.toHaveProperty(
                "progress_generation",
            );
        },
    );

    test("normalization retains the wire string through unwrapCommand", () => {
        expect(normalizeError(commandFailure("9007199254740993"))).toMatchObject({
            progress_generation: "9007199254740993",
        });
    });
});

afterEach(() => vi.restoreAllMocks());

describe("download jobs", () => {
    test("falls back to console with safe logger-failure context when progress clear and logger both reject", async () => {
        const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const failure = new Error("download failed");
        mocks.clearProgress.mockRejectedValueOnce(new Error("clear rejected"));
        mocks.warn.mockRejectedValueOnce(
            new Error("logger failed at /private/logger.log token=secret"),
        );
        const running = runDownloadJob("job", async () => {
            throw failure;
        });
        const cancel = cancelDownloadJob("job");

        await expect(running).rejects.toBe(failure);
        await expect(cancel).rejects.toBe(failure);
        const message = "clear progress job: Error: clear rejected";
        expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(message);
        expect(consoleWarn).toHaveBeenCalledExactlyOnceWith(message, {
            loggerFailure: {
                category: "unexpected",
                message: "logger failed at [path] token=[redacted]",
            },
        });
        await expect(cancelDownloadJob("job")).rejects.toMatchObject({ reason: "lost" });
        await expect(runDownloadJob("job", async () => "retry")).resolves.toBe("retry");
    });

    test("returns a null cleanup floor after a rejected clear and permits a retry", async () => {
        mocks.clearProgress.mockRejectedValueOnce(new Error("clear rejected"));
        mocks.warn.mockRejectedValueOnce(new Error("logger unavailable"));
        const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        let rejectRun!: (error: unknown) => void;
        const running = runDownloadJob(
            "job",
            () =>
                new Promise<never>((_resolve, reject) => {
                    rejectRun = reject;
                }),
        );
        const settled = running.catch((error: unknown) => error);
        const cancel = cancelDownloadJob("job");
        rejectRun(cancellationError());
        expect(await settled).toMatchObject({ message: "Cancellation" });
        await expect(cancel).resolves.toEqual({ clearedGeneration: null });
        expect(mocks.warn).toHaveBeenCalledOnce();
        expect(consoleWarn).toHaveBeenCalledOnce();
        await expect(runDownloadJob("job", async () => "retry")).resolves.toBe("retry");
    });
    test("passes the prepared ticket to the download and removes the entry", async () => {
        const result = await runDownloadJob("job", async (ticket) => ticket);

        expect(result).toBe("prepared-ticket");
        await expect(cancelDownloadJob("job")).rejects.toMatchObject({ reason: "lost" });
    });

    test("refuses a second job while the first one is registered", async () => {
        let finish!: () => void;
        const running = runDownloadJob(
            "job",
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );

        expect(() => runDownloadJob("job", async () => undefined)).toThrow("busy");
        finish();
        await running;
    });

    test("cancels a running job and clears progress before releasing it", async () => {
        let rejectRun!: (error: unknown) => void;
        let settleClear!: (generation: bigint) => void;
        mocks.clearProgress.mockImplementation(
            () => new Promise<bigint>((resolve) => (settleClear = resolve)),
        );
        const running = runDownloadJob(
            "job",
            () =>
                new Promise<never>((_resolve, reject) => {
                    rejectRun = reject;
                }),
        );
        const cancel = cancelDownloadJob("job");

        await Promise.resolve();
        expect(mocks.cancelDownload).toHaveBeenCalledWith("prepared-ticket");
        rejectRun(cancellationError());
        await vi.waitFor(() => expect(mocks.clearProgress).toHaveBeenCalledWith("job"));
        expect(() => runDownloadJob("job", async () => undefined)).toThrow("busy");
        settleClear(42n);
        await expect(running).rejects.toMatchObject({ message: "Cancellation" });
        await expect(cancel).resolves.toEqual({ clearedGeneration: 42n });
        expect(mocks.clearProgress).toHaveBeenCalledWith("job");
        expect(mocks.cancelDownloadForProgress).not.toHaveBeenCalled();
    });

    test("keeps cancellation pending while native preparation is delayed", async () => {
        let resolvePreparation!: (ticket: string) => void;
        mocks.withDownloadTicket.mockImplementation(
            (run: (ticket: string) => Promise<unknown>) =>
                new Promise((resolve, reject) => {
                    resolvePreparation = (ticket) => {
                        void run(ticket).then(resolve, reject);
                    };
                }),
        );
        const run = vi.fn(async () => undefined);
        const running = runDownloadJob("job", run);
        const cancel = cancelDownloadJob("job");

        resolvePreparation("prepared-after-cancel");
        await expect(running).rejects.toMatchObject({ message: "Cancellation" });
        await expect(cancel).resolves.toEqual({ clearedGeneration: 42n });
        expect(run).not.toHaveBeenCalled();
        // The command was never invoked, so the ticket is still unclaimed: `withDownloadTicket`
        // releases it on this rejection instead of leaving a cancelled reservation behind.
        expect(mocks.cancelDownload).not.toHaveBeenCalled();
    });

    test("turns a pending cancellation with failed preparation into cancellation", async () => {
        mocks.withDownloadTicket.mockRejectedValue(new Error("prepare failed"));
        const run = vi.fn(async () => undefined);
        const running = runDownloadJob("job", run);
        const cancel = cancelDownloadJob("job");

        await expect(running).rejects.toMatchObject({ message: "Cancellation" });
        await expect(cancel).resolves.toEqual({ clearedGeneration: 42n });
        expect(run).not.toHaveBeenCalled();
        expect(mocks.cancelDownload).not.toHaveBeenCalled();
    });

    test("reports a lost cancellation race when the job succeeds", async () => {
        let finish!: () => void;
        const running = runDownloadJob(
            "job",
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        const cancel = cancelDownloadJob("job");

        await Promise.resolve();
        finish();
        await running;
        await expect(cancel).rejects.toMatchObject({ reason: "lost" });
        expect(mocks.clearProgress).not.toHaveBeenCalled();
    });

    test("distinguishes a failed cancellation request from the job result", async () => {
        const requestFailure = new Error("cancel IPC failed");
        mocks.cancelDownload.mockRejectedValue(requestFailure);
        let rejectRun!: (error: unknown) => void;
        const running = runDownloadJob(
            "job",
            () =>
                new Promise<never>((_resolve, reject) => {
                    rejectRun = reject;
                }),
        );
        const cancel = cancelDownloadJob("job");

        await expect(cancel).rejects.toMatchObject({
            reason: "request",
            cause: requestFailure,
        });
        rejectRun(cancellationError());
        await expect(running).rejects.toMatchObject({ message: "Cancellation" });
    });

    test("preserves a non-cancellation job failure when cancellation was requested", async () => {
        const failure = new Error("download failed");
        const running = runDownloadJob("job", async () => {
            throw failure;
        });
        const cancel = cancelDownloadJob("job");

        await expect(running).rejects.toBe(failure);
        await expect(cancel).rejects.toBe(failure);
        // The typed failure survives, and the job still clears its own bar: a terminal item keeps
        // the last percentage it reached, so a failed download would otherwise leave one drawn.
        expect(mocks.clearProgress).toHaveBeenCalledWith("job");
    });

    test("notifies only when the cancellation request itself fails", async () => {
        const requestFailure = new Error("cancel IPC failed");
        mocks.cancelDownload.mockRejectedValue(requestFailure);
        let rejectRun!: (error: unknown) => void;
        const running = runDownloadJob(
            "job",
            () =>
                new Promise<never>((_resolve, reject) => {
                    rejectRun = reject;
                }),
        );

        await expect(cancelDownloadJob("job", "Download failed")).rejects.toMatchObject({
            reason: "request",
        });
        expect(mocks.notifyUnlessCancelled).toHaveBeenCalledWith("Download failed", requestFailure);
        rejectRun(cancellationError());
        await expect(running).rejects.toMatchObject({ message: "Cancellation" });
    });

    test("has no cancellation target after the job leaves the registry", async () => {
        await runDownloadJob("job", async () => undefined);

        await expect(cancelDownloadJob("job")).rejects.toMatchObject({ reason: "lost" });
    });

    test("cancels by native progress lookup with no local job and does not clear", async () => {
        mocks.cancelDownloadForProgress.mockResolvedValue(true);

        await expect(cancelDownloadJob("surviving", "Download failed")).resolves.toEqual({
            clearedGeneration: null,
        });
        expect(mocks.cancelDownloadForProgress).toHaveBeenCalledExactlyOnceWith("surviving");
        expect(mocks.cancelDownload).not.toHaveBeenCalled();
        expect(mocks.clearProgress).not.toHaveBeenCalled();
        expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
    });

    test("a refused native progress cancellation rejects lost without notifying", async () => {
        await expect(cancelDownloadJob("missing", "Download failed")).rejects.toMatchObject({
            reason: "lost",
        });
        expect(mocks.cancelDownloadForProgress).toHaveBeenCalledExactlyOnceWith("missing");
        expect(mocks.clearProgress).not.toHaveBeenCalled();
        expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
    });

    test.each([undefined, "Download failed"])(
        "a failed native lookup rejects request and notifies once when titled (%s)",
        async (title) => {
            const failure = new Error("lookup IPC failed");
            mocks.cancelDownloadForProgress.mockRejectedValue(failure);

            await expect(cancelDownloadJob("surviving", title)).rejects.toMatchObject({
                reason: "request",
                cause: failure,
            });
            expect(mocks.clearProgress).not.toHaveBeenCalled();
            expect(mocks.notifyUnlessCancelled.mock.calls).toEqual(
                title === undefined ? [] : [[title, failure]],
            );
        },
    );

    test("useRunningDownloadJob tracks the first live job among the given ids", async () => {
        Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
        function Probe() {
            return createElement("span", null, useRunningDownloadJob(["a", "b"]) ?? "");
        }
        const host = document.createElement("div");
        document.body.append(host);
        const root = createRoot(host);
        try {
            await act(async () => {
                root.render(createElement(Probe));
            });
            expect(host.textContent).toBe("");

            const work = deferred<void>();
            let running!: Promise<void>;
            await act(async () => {
                running = runDownloadJob("b", () => work.promise);
            });
            expect(host.textContent).toBe("b");

            await act(async () => {
                work.resolve();
                await running;
            });
            expect(host.textContent).toBe("");
        } finally {
            await act(async () => root.unmount());
            host.remove();
        }
    });

    test("a refused duplicate native claim keeps its failure and awaits the surviving generation", async () => {
        const failure = new Error("download progress is already active");
        let settleClear!: (generation: bigint) => void;
        mocks.clearProgress.mockImplementation(
            () => new Promise<bigint>((resolve) => (settleClear = resolve)),
        );
        const running = runDownloadJob("job", async () => {
            throw failure;
        });
        const cancel = cancelDownloadJob("job", "Download failed");
        const runningResult = running.catch((error: unknown) => error);
        const cancelResult = cancel.catch((error: unknown) => error);

        await vi.waitFor(() => expect(mocks.clearProgress).toHaveBeenCalledExactlyOnceWith("job"));
        expect(() => runDownloadJob("job", async () => undefined)).toThrow("busy");
        settleClear(42n);
        expect(await runningResult).toBe(failure);
        expect(await cancelResult).toBe(failure);
        expect(mocks.notifyUnlessCancelled).not.toHaveBeenCalled();
        expect(mocks.cancelDownloadForProgress).not.toHaveBeenCalled();
    });
});
