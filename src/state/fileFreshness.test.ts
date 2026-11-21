import { afterEach, expect, test, vi } from "vitest";
import {
    getFileFreshness,
    beginFileWrite,
    pendingFileReconcileCount,
    registerFileConflictSave,
    removeFileFreshness,
    requestFileReconcile,
    saveFileConflictVersion,
    setFileFreshness,
    startFileRevisionPoll,
} from "./fileFreshness";
import type { FileWorkspaceHandle } from "@/bindings";
import type { Tab } from "@/utils/tabs";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";

const ids = ["freshness-a", "freshness-b"];

afterEach(() => {
    ids.forEach(removeFileFreshness);
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function fileTab(tabId: string, fileId: string): Tab {
    ids.push(tabId);
    const handle: FileWorkspaceHandle = {
        id: { id: fileId },
        kind: "fileWorkspace",
    };
    return {
        value: tabId,
        type: "analysis",
        name: tabId,
        gameOrigin: {
            kind: "file",
            file: { handle },
            gameNumber: 0,
        },
    } as Tab;
}

function focusSubscription() {
    let focus: (() => void) | null = null;
    const unsubscribe = vi.fn<() => void>(() => {
        focus = null;
    });
    return {
        subscribe: (callback: () => void): (() => void) => {
            focus = callback;
            return unsubscribe;
        },
        focus: () => focus?.(),
        unsubscribe,
    };
}

async function flushPromises() {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

test("freshness transitions advance the epoch and retain only verified metadata", () => {
    expect(getFileFreshness(ids[0])).toMatchObject({
        state: "unverified",
        verifiedRevision: null,
        conflictReason: null,
        epoch: 0,
    });

    const verified = setFileFreshness(ids[0], "verified", { verifiedRevision: "r1" });
    expect(verified).toMatchObject({ state: "verified", verifiedRevision: "r1", epoch: 1 });
    const conflict = setFileFreshness(ids[0], "conflict", { conflictReason: "save-refused" });
    expect(conflict).toMatchObject({
        state: "conflict",
        verifiedRevision: null,
        conflictReason: "save-refused",
        epoch: 2,
    });
    expect(setFileFreshness(ids[0], "unavailable")).toMatchObject({
        state: "unavailable",
        conflictReason: null,
        epoch: 3,
    });
});

test("a tab admits one reconcile and runs exactly one queued invalidation after it settles", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const signals: AbortSignal[] = [];
    const reconcile = vi
        .fn<(signal: AbortSignal) => Promise<void>>()
        .mockImplementationOnce((signal) => {
            signals.push(signal);
            return first.promise;
        })
        .mockImplementationOnce((signal) => {
            signals.push(signal);
            return second.promise;
        });

    requestFileReconcile(ids[0], reconcile);
    requestFileReconcile(ids[0], reconcile);
    requestFileReconcile(ids[0], reconcile);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(pendingFileReconcileCount()).toBe(1);

    first.resolve();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
    expect(signals[0].aborted).toBe(false);
    expect(pendingFileReconcileCount()).toBe(1);
    second.resolve();
    await vi.waitFor(() => expect(pendingFileReconcileCount()).toBe(0));
});

test("aborting a running reconcile queues a replacement without overlapping native reads", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const signals: AbortSignal[] = [];
    const reconcile = vi
        .fn<(signal: AbortSignal) => Promise<void>>()
        .mockImplementationOnce((signal) => {
            signals.push(signal);
            return first.promise;
        })
        .mockImplementationOnce((signal) => {
            signals.push(signal);
            return second.promise;
        });

    const cancel = requestFileReconcile(ids[0], reconcile);
    cancel();
    requestFileReconcile(ids[0], reconcile);
    expect(signals[0].aborted).toBe(true);
    expect(reconcile).toHaveBeenCalledOnce();

    first.resolve();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
    expect(signals[1].aborted).toBe(false);
    second.resolve();
    await vi.waitFor(() => expect(pendingFileReconcileCount()).toBe(0));
});

test("a registered conflict save that returns false is failed, not unregistered", async () => {
    const save = vi.fn(async () => false);
    const unregister = registerFileConflictSave(ids[0], save);
    await expect(saveFileConflictVersion(ids[0])).resolves.toBe(false);
    expect(save).toHaveBeenCalledOnce();
    unregister();
});

test("conflict save registration is tab-scoped and removed with the tab", async () => {
    const save = vi.fn(async () => true);
    const unregister = registerFileConflictSave(ids[0], save);

    await expect(saveFileConflictVersion(ids[0])).resolves.toBe(true);
    expect(save).toHaveBeenCalledOnce();
    await expect(saveFileConflictVersion(ids[1])).resolves.toBe("unregistered");

    unregister();
    await expect(saveFileConflictVersion(ids[0])).resolves.toBe("unregistered");

    registerFileConflictSave(ids[0], save);
    removeFileFreshness(ids[0]);
    await expect(saveFileConflictVersion(ids[0])).resolves.toBe("unregistered");
});

test("the two-second poll invalidates a changed file-backed tab without a BoardsPage owner", async () => {
    vi.useFakeTimers();
    const tab = fileTab("poll-change", "file-change");
    setFileFreshness(tab.value, "verified", { verifiedRevision: "r1" });
    const revision = vi.fn(async () => "r2");
    const focus = focusSubscription();
    const stop = startFileRevisionPoll({
        getTabs: () => [tab],
        fileRevision: revision,
        subscribeFocus: focus.subscribe,
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(revision).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(revision).toHaveBeenCalledOnce();
    expect(getFileFreshness(tab.value).state).toBe("unverified");
    stop();
});

test.each([
    ["while the write is active", false],
    ["after the write has ended", true],
] as const)(
    "a conflict poll outcome that arrives %s is ignored",
    async (_timing, writeEndedBeforeOutcome) => {
        vi.useFakeTimers();
        const tab = fileTab(
            `poll-write-${writeEndedBeforeOutcome}`,
            `file-write-${writeEndedBeforeOutcome}`,
        );
        setFileFreshness(tab.value, "verified", { verifiedRevision: "r1" });
        const first = deferred<string>();
        let revisionCalls = 0;
        const revision = vi.fn((_handle: FileWorkspaceHandle, _options: { signal: AbortSignal }) =>
            ++revisionCalls === 1 ? first.promise : Promise.resolve("r1"),
        );
        const focus = focusSubscription();
        const stop = startFileRevisionPoll({
            getTabs: () => [tab],
            fileRevision: revision,
            subscribeFocus: focus.subscribe,
        });

        focus.focus();
        await flushPromises();
        expect(revision).toHaveBeenCalledOnce();
        const origin = tab.gameOrigin;
        if (origin.kind !== "file" && origin.kind !== "temp_file") {
            throw new Error("expected a file-backed test tab");
        }
        const endWrite = beginFileWrite(fileWorkspaceKey(origin.file.handle));
        if (writeEndedBeforeOutcome) endWrite();
        first.reject({
            tag: "backend-error",
            category: "conflict",
            message: "path authority is unavailable because its object changed",
        });
        await flushPromises();
        if (!writeEndedBeforeOutcome) endWrite();
        await flushPromises();

        expect(revision).toHaveBeenCalledTimes(2);
        expect(getFileFreshness(tab.value)).toMatchObject({
            state: "verified",
            verifiedRevision: "r1",
        });
        stop();
    },
);

test("a revision poll waits for an active file write and runs when it ends", async () => {
    vi.useFakeTimers();
    const tab = fileTab("poll-write-active", "file-write-active");
    setFileFreshness(tab.value, "verified", { verifiedRevision: "r1" });
    const origin = tab.gameOrigin;
    if (origin.kind !== "file" && origin.kind !== "temp_file") {
        throw new Error("expected a file-backed test tab");
    }
    const endWrite = beginFileWrite(fileWorkspaceKey(origin.file.handle));
    const revision = vi.fn(async () => "r1");
    const focus = focusSubscription();
    const stop = startFileRevisionPoll({
        getTabs: () => [tab],
        fileRevision: revision,
        subscribeFocus: focus.subscribe,
    });

    focus.focus();
    await flushPromises();
    expect(revision).not.toHaveBeenCalled();

    endWrite();
    await flushPromises();

    expect(revision).toHaveBeenCalledOnce();
    expect(getFileFreshness(tab.value).state).toBe("verified");
    stop();
});

test.each(["conflict", "unavailable"] as const)(
    "poll outcomes do not change a %s tab or its epoch",
    async (state) => {
        vi.useFakeTimers();
        const tab = fileTab(`poll-stable-${state}`, `file-stable-${state}`);
        setFileFreshness(
            tab.value,
            state,
            state === "conflict" ? { conflictReason: "changed" } : undefined,
        );
        const before = getFileFreshness(tab.value);
        const revision = vi
            .fn()
            .mockResolvedValueOnce("changed-1")
            .mockRejectedValueOnce({
                tag: "backend-error",
                category: "io",
                message: "temporary stat failure",
            })
            .mockResolvedValueOnce("changed-2")
            .mockRejectedValueOnce({
                tag: "backend-error",
                category: "io",
                message: "another temporary stat failure",
            });
        if (state === "unavailable") {
            revision.mockRejectedValueOnce({
                tag: "backend-error",
                category: "missing-resource",
                message: "file remains unavailable",
            });
        }
        const stop = startFileRevisionPoll({
            getTabs: () => [tab],
            fileRevision: revision,
            subscribeFocus: () => () => undefined,
        });

        const ticks = state === "unavailable" ? 5 : 4;
        for (let tick = 1; tick <= ticks; tick += 1) {
            await vi.advanceTimersByTimeAsync(2_000);
            expect(revision).toHaveBeenCalledTimes(tick);
            expect(getFileFreshness(tab.value)).toEqual(before);
        }

        stop();
    },
);

test("an unchanged generic poll rejection leaves an unverified epoch untouched", async () => {
    vi.useFakeTimers();
    const tab = fileTab("poll-same-error", "file-same-error");
    setFileFreshness(tab.value, "verified", { verifiedRevision: "r1" });
    const error = { tag: "backend-error", category: "io", message: "stat failed" };
    const revision = vi.fn<() => Promise<string>>().mockRejectedValue(error);
    const stop = startFileRevisionPoll({
        getTabs: () => [tab],
        fileRevision: revision,
        subscribeFocus: () => () => undefined,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    const firstRejection = getFileFreshness(tab.value);
    expect(firstRejection).toMatchObject({ state: "unverified", errorMessage: "stat failed" });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(getFileFreshness(tab.value)).toBe(firstRejection);
    expect(revision).toHaveBeenCalledTimes(2);
    stop();
});

test("an overdue poll rejection changes the tab to unverified with its error", async () => {
    vi.useFakeTimers();
    const tab = fileTab("poll-overdue-rejected", "file-overdue-rejected");
    setFileFreshness(tab.value, "overdue");
    const revision = vi.fn<() => Promise<string>>().mockRejectedValue({
        tag: "backend-error",
        category: "io",
        message: "stat still fails",
    });
    const stop = startFileRevisionPoll({
        getTabs: () => [tab],
        fileRevision: revision,
        subscribeFocus: () => () => undefined,
    });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(getFileFreshness(tab.value)).toMatchObject({
        state: "unverified",
        errorMessage: "stat still fails",
        epoch: 2,
    });
    stop();
});

test("a poll timeout does not change conflict or unavailable tabs", async () => {
    vi.useFakeTimers();
    const tabs = [
        fileTab("poll-timeout-conflict", "file-timeout-conflict"),
        fileTab("poll-timeout-unavailable", "file-timeout-unavailable"),
    ];
    setFileFreshness(tabs[0].value, "conflict", { conflictReason: "changed" });
    setFileFreshness(tabs[1].value, "unavailable");
    const before = tabs.map((tab) => getFileFreshness(tab.value));
    const pending = deferred<string>();
    const revision = vi.fn(() => pending.promise);
    const stop = startFileRevisionPoll({
        getTabs: () => tabs,
        fileRevision: revision,
        subscribeFocus: () => () => undefined,
    });

    await vi.advanceTimersByTimeAsync(4_000);

    expect(revision).toHaveBeenCalledTimes(2);
    expect(tabs.map((tab) => getFileFreshness(tab.value))).toEqual(before);
    stop();
    pending.reject(new Error("native cancellation settled"));
    await flushPromises();
});

test("a timed-out revision poll moves an unverified tab to overdue", async () => {
    vi.useFakeTimers();
    const tab = fileTab("poll-unverified-timeout", "file-unverified-timeout");
    setFileFreshness(tab.value, "unverified");
    const pending = deferred<string>();
    const revision = vi.fn(() => pending.promise);
    const stop = startFileRevisionPoll({
        getTabs: () => [tab],
        fileRevision: revision,
        subscribeFocus: () => () => undefined,
    });

    await vi.advanceTimersByTimeAsync(4_000);

    expect(revision).toHaveBeenCalledOnce();
    expect(getFileFreshness(tab.value)).toMatchObject({ state: "overdue", epoch: 2 });
    stop();
    pending.reject(new Error("native cancellation settled"));
    await flushPromises();
});

test("a deleted file moves a conflict tab to unavailable", async () => {
    vi.useFakeTimers();
    const tab = fileTab("poll-deleted-conflict", "file-deleted-conflict");
    setFileFreshness(tab.value, "conflict", { conflictReason: "changed" });
    const before = getFileFreshness(tab.value);
    const revision = vi.fn(async () => {
        throw {
            tag: "backend-error",
            category: "missing-resource",
            message: "file was deleted",
        };
    });
    const stop = startFileRevisionPoll({
        getTabs: () => [tab],
        fileRevision: revision,
        subscribeFocus: () => () => undefined,
    });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(getFileFreshness(tab.value)).toMatchObject({
        state: "unavailable",
        errorMessage: "file was deleted",
        epoch: before.epoch + 1,
    });
    stop();
});

test("a non-file-backed tab is ignored and an unchanged revision stays verified", async () => {
    vi.useFakeTimers();
    const tab = fileTab("poll-unchanged", "file-unchanged");
    const nonFileTab = { ...tab, value: "poll-non-file", gameOrigin: { kind: "none" } } as Tab;
    ids.push(nonFileTab.value);
    setFileFreshness(tab.value, "verified", { verifiedRevision: "r1" });
    const revision = vi.fn(async () => "r1");
    const focus = focusSubscription();
    const stop = startFileRevisionPoll({
        getTabs: () => [tab, nonFileTab],
        fileRevision: revision,
        subscribeFocus: focus.subscribe,
    });

    focus.focus();
    await flushPromises();

    expect(revision).toHaveBeenCalledOnce();
    expect(getFileFreshness(tab.value)).toMatchObject({ state: "verified", epoch: 1 });
    expect(getFileFreshness(nonFileTab.value).state).toBe("unverified");
    stop();
});

test("a slow first file does not prevent polling a second distinct open file", async () => {
    vi.useFakeTimers();
    const firstTab = fileTab("poll-first-file", "file-first");
    const secondTab = fileTab("poll-second-file", "file-second");
    setFileFreshness(firstTab.value, "verified", { verifiedRevision: "r1" });
    setFileFreshness(secondTab.value, "verified", { verifiedRevision: "r1" });
    const first = deferred<string>();
    const revision = vi.fn((handle: FileWorkspaceHandle) =>
        handle.id.id === "file-first" ? first.promise : Promise.resolve("r2"),
    );
    const stop = startFileRevisionPoll({
        getTabs: () => [firstTab, secondTab],
        fileRevision: revision,
        subscribeFocus: () => () => undefined,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();

    expect(revision).toHaveBeenCalledTimes(2);
    expect(getFileFreshness(firstTab.value).state).toBe("verified");
    expect(getFileFreshness(secondTab.value).state).toBe("unverified");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(revision.mock.calls.filter(([handle]) => handle.id.id === "file-first")).toHaveLength(1);
    expect(getFileFreshness(firstTab.value).state).toBe("overdue");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(revision.mock.calls.filter(([handle]) => handle.id.id === "file-first")).toHaveLength(1);

    stop();
    first.reject(new Error("cancelled after test"));
    await flushPromises();
});

test("one changed shared handle withholds every open tab that uses it", async () => {
    vi.useFakeTimers();
    const firstTab = fileTab("poll-shared-first", "file-shared");
    const secondTab = fileTab("poll-shared-second", "file-shared");
    setFileFreshness(firstTab.value, "verified", { verifiedRevision: "r1" });
    setFileFreshness(secondTab.value, "verified", { verifiedRevision: "r1" });
    const revision = vi.fn(async () => "r2");
    const stop = startFileRevisionPoll({
        getTabs: () => [firstTab, secondTab],
        fileRevision: revision,
        subscribeFocus: () => () => undefined,
    });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(revision).toHaveBeenCalledOnce();
    expect(getFileFreshness(firstTab.value).state).toBe("unverified");
    expect(getFileFreshness(secondTab.value).state).toBe("unverified");
    stop();
});

test.each([
    ["missing-resource", "unavailable"],
    ["conflict", "unavailable"],
] as const)("a %s revision rejection marks the file unavailable", async (category, state) => {
    vi.useFakeTimers();
    const tab = fileTab(`poll-${category}`, `file-${category}`);
    setFileFreshness(tab.value, "verified", { verifiedRevision: "r1" });
    const revision = vi.fn(async () => {
        throw { tag: "backend-error", category, message: "file not available" };
    });
    const stop = startFileRevisionPoll({
        getTabs: () => [tab],
        fileRevision: revision,
        subscribeFocus: () => () => undefined,
    });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(getFileFreshness(tab.value).state).toBe(state);
    stop();
});

test("a generic rejection withholds the tab and the poll retries on its next tick", async () => {
    vi.useFakeTimers();
    const tab = fileTab("poll-retry", "file-retry");
    setFileFreshness(tab.value, "verified", { verifiedRevision: "r1" });
    const revision = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce({ tag: "backend-error", category: "io", message: "stat failed" })
        .mockResolvedValue("r2");
    const stop = startFileRevisionPoll({
        getTabs: () => [tab],
        fileRevision: revision,
        subscribeFocus: () => () => undefined,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(getFileFreshness(tab.value).state).toBe("unverified");
    await vi.advanceTimersByTimeAsync(2_000);

    expect(revision).toHaveBeenCalledTimes(2);
    expect(getFileFreshness(tab.value).state).toBe("unverified");
    stop();
});

test.each([
    ["revision", "unverified"],
    ["rejection", "unavailable"],
] as const)(
    "an %s poll outcome leaves an appending tab unchanged until append settlement",
    async (outcome, expected) => {
        vi.useFakeTimers();
        const tab = fileTab(`poll-append-${outcome}`, `file-append-${outcome}`);
        setFileFreshness(tab.value, "appending");
        const append = deferred<void>();
        const appendSettled = append.promise.then(() =>
            setFileFreshness(tab.value, "verified", { verifiedRevision: "r1" }),
        );
        const revision =
            outcome === "revision"
                ? vi.fn(async () => "r2")
                : vi.fn(async () => {
                      throw {
                          tag: "backend-error",
                          category: "missing-resource",
                          message: "file missing",
                      };
                  });
        const stop = startFileRevisionPoll({
            getTabs: () => [tab],
            fileRevision: revision,
            subscribeFocus: () => () => undefined,
        });

        await vi.advanceTimersByTimeAsync(2_000);
        expect(getFileFreshness(tab.value).state).toBe("appending");
        append.resolve();
        await appendSettled;
        expect(getFileFreshness(tab.value).state).toBe(expected);
        stop();
    },
);

test("a timed-out appending tab stays appending, then needs a fresh answer after settlement", async () => {
    vi.useFakeTimers();
    const tab = fileTab("poll-append-timeout", "file-append-timeout");
    setFileFreshness(tab.value, "appending");
    const first = deferred<string>();
    const signals: AbortSignal[] = [];
    const revision = vi.fn((_handle: FileWorkspaceHandle, options: { signal: AbortSignal }) => {
        signals.push(options.signal);
        return signals.length === 1 ? first.promise : Promise.resolve("r2");
    });
    const stop = startFileRevisionPoll({
        getTabs: () => [tab],
        fileRevision: revision,
        subscribeFocus: () => () => undefined,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(signals[0].aborted).toBe(true);
    expect(getFileFreshness(tab.value).state).toBe("appending");
    setFileFreshness(tab.value, "unverified");
    expect(getFileFreshness(tab.value).state).toBe("overdue");

    first.reject(new Error("native cancellation settled"));
    await flushPromises();
    expect(revision).toHaveBeenCalledTimes(2);
    expect(getFileFreshness(tab.value).state).toBe("unverified");
    stop();
});

test("focus polls immediately and stopping clears its listener, timer, and active controller", async () => {
    vi.useFakeTimers();
    const tab = fileTab("poll-stop", "file-stop");
    setFileFreshness(tab.value, "verified", { verifiedRevision: "r1" });
    const pending = deferred<string>();
    const signals: AbortSignal[] = [];
    const revision = vi.fn((_handle: FileWorkspaceHandle, options: { signal: AbortSignal }) => {
        signals.push(options.signal);
        return pending.promise;
    });
    const focus = focusSubscription();
    const capturedFocus: { current: (() => void) | null } = { current: null };
    const stop = startFileRevisionPoll({
        getTabs: () => [tab],
        fileRevision: revision,
        subscribeFocus: (callback) => {
            capturedFocus.current = callback;
            return focus.subscribe(callback);
        },
    });

    focus.focus();
    await flushPromises();
    expect(revision).toHaveBeenCalledOnce();
    stop();
    expect(signals[0].aborted).toBe(true);
    expect(focus.unsubscribe).toHaveBeenCalledOnce();
    capturedFocus.current?.();
    stop();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(revision).toHaveBeenCalledOnce();
    pending.reject(new Error("native cancellation settled"));
    await flushPromises();
});

test("focus during an outstanding query coalesces one follow-up after that query settles", async () => {
    vi.useFakeTimers();
    const tab = fileTab("poll-focus-pending", "file-focus-pending");
    setFileFreshness(tab.value, "verified", { verifiedRevision: "r1" });
    const first = deferred<string>();
    let calls = 0;
    const revision = vi.fn((_handle: FileWorkspaceHandle) => {
        calls += 1;
        return calls === 1 ? first.promise : Promise.resolve("r2");
    });
    const focus = focusSubscription();
    const stop = startFileRevisionPoll({
        getTabs: () => [tab],
        fileRevision: revision,
        subscribeFocus: focus.subscribe,
    });

    focus.focus();
    await flushPromises();
    focus.focus();
    focus.focus();
    await flushPromises();
    expect(revision).toHaveBeenCalledOnce();

    first.resolve("r1");
    await flushPromises();
    expect(revision).toHaveBeenCalledTimes(2);
    expect(getFileFreshness(tab.value).state).toBe("unverified");
    stop();
});

test("a focus listener that resolves after stop is immediately removed", async () => {
    vi.useFakeTimers();
    const tab = fileTab("poll-late-focus", "file-late-focus");
    let resolveFocus!: (cleanup: () => void) => void;
    const subscription = new Promise<() => void>((resolve) => {
        resolveFocus = resolve;
    });
    const cleanup = vi.fn();
    const stop = startFileRevisionPoll({
        getTabs: () => [tab],
        fileRevision: vi.fn(async () => "r1"),
        subscribeFocus: () => subscription,
    });

    stop();
    resolveFocus(cleanup);
    await flushPromises();
    expect(cleanup).toHaveBeenCalledOnce();
});

test.each(["sync", "async"] as const)(
    "focus subscription %s failures are handled",
    async (mode) => {
        const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const tab = fileTab(`poll-focus-${mode}-error`, `file-focus-${mode}-error`);
        const error = new Error("focus listener failed");
        const subscribeFocus =
            mode === "sync"
                ? () => {
                      throw error;
                  }
                : () => Promise.reject(error);
        const stop = startFileRevisionPoll({
            getTabs: () => [tab],
            fileRevision: vi.fn(async () => "r1"),
            subscribeFocus,
        });

        await flushPromises();
        expect(logError).toHaveBeenCalledOnce();
        stop();
    },
);

test("closing a tab drops any revision outcome buffered during its append", async () => {
    vi.useFakeTimers();
    const tab = fileTab("poll-close-appending", "file-close-appending");
    setFileFreshness(tab.value, "appending");
    const revision = vi.fn(async () => "r2");
    const stop = startFileRevisionPoll({
        getTabs: () => [tab],
        fileRevision: revision,
        subscribeFocus: () => () => undefined,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    removeFileFreshness(tab.value);
    expect(getFileFreshness(tab.value).state).toBe("unverified");
    setFileFreshness(tab.value, "unverified");
    expect(getFileFreshness(tab.value).epoch).toBe(1);
    stop();
});
