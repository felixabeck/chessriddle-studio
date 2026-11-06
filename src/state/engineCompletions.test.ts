import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { EngineCompletion, ErrorPayload } from "@/bindings";
import type { LocalEngine } from "@/utils/engines";
import { decodeCompressedOrJson, serializeStorageValue } from "./store/debouncedStorage";
// Warms the transforms at collection for the dynamic imports in documentRuntime (f-20261102-04).
import "./atoms";
import "./engineCompletions";
import "./engineOwnerStorage";
import "./catalogEngineCompletion";

const native = vi.hoisted(() => ({
    records: new Map<string, EngineCompletion>(),
    pending: vi.fn(),
    ack: vi.fn(),
    retire: vi.fn(),
    install: vi.fn(),
    reconcile: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
    subscribe: vi.fn(),
    changed: undefined as (() => void) | undefined,
}));
vi.mock("@/platform/tauri", () => ({
    tauri: {
        pendingEngineCompletions: native.pending,
        acknowledgeEngineCompletion: native.ack,
        retireEngineCompletion: native.retire,
        installEngineWorkflow: native.install,
        reconcileEngineAttachments: native.reconcile,
        clearProgress: native.clear,
    },
    tauriSubscriptions: {
        completionChanged: native.subscribe,
    },
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: native.show } }));
vi.mock("@/platform/native", () => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));

const a: LocalEngine = {
    id: "logical-engine",
    type: "local",
    name: "A",
    version: "1",
    filename: "a",
    legacyAssessment: null,
    handle: { id: { id: "binary-a" }, kind: "engine" },
    settings: [{ type: "string", name: "Threads", value: "20" }],
};
const root = { id: { id: "root" }, kind: "engineRoot" as const };
const player = (engine = a) => ({
    type: "engine" as const,
    engine,
    go: { t: "Depth" as const, c: 12 },
    engineSettings: engine.settings,
});
function workflow(upgrade = false, expected = a, binary = "binary-b"): EngineCompletion {
    return {
        id: crypto.randomUUID(),
        retired: false,
        request: {
            intent: upgrade
                ? { kind: "upgrade", engine_id: expected.id, expected: expected.handle }
                : { kind: "add", engine_id: "add-engine" },
            root,
            progressId: upgrade ? `engine-upgrade:${expected.id}:catalog` : "engine:catalog",
            url: "https://example.com/engine.zip",
            sha256: "a".repeat(64),
            signature: "signature",
            relativePath: "engine",
            name: "B",
            version: "2",
            elo: null,
            downloadSize: null,
        },
        outcome: {
            state: "succeeded",
            result: {
                handle: { id: { id: binary }, kind: "engine" },
                filename: "b",
                config: {
                    name: "B",
                    options: [
                        {
                            type: "spin",
                            value: { name: "Threads", default: 1n, min: 1n, max: 64n },
                        },
                    ],
                },
            },
        },
    };
}

function failedWorkflow(result: ErrorPayload): EngineCompletion {
    const completion = workflow();
    completion.outcome = { state: "failed", result };
    return completion;
}

function deferred<Value>() {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>((done) => (resolve = done));
    return { promise, resolve };
}

async function documentRuntime() {
    vi.resetModules();
    const [{ createStore }, atoms, completions, owners, catalog] = await Promise.all([
        import("jotai"),
        import("./atoms"),
        import("./engineCompletions"),
        import("./engineOwnerStorage"),
        import("./catalogEngineCompletion"),
    ]);
    return { store: createStore(), atoms, completions: { ...completions, ...catalog }, owners };
}
function durable(key: string) {
    const decoded = decodeCompressedOrJson(localStorage.getItem(key)!);
    return decoded as { version: number; value: unknown; receipts: Record<string, string> };
}
function retain(completion: EngineCompletion) {
    native.records.set(completion.id, completion);
}
let runtimes: Awaited<ReturnType<typeof documentRuntime>>[];
async function runtime() {
    const run = await documentRuntime();
    runtimes.push(run);
    return run;
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    native.records.clear();
    runtimes = [];
    native.pending
        .mockReset()
        .mockImplementation(async () => structuredClone([...native.records.values()]));
    native.ack.mockReset().mockImplementation(async (id: string) => {
        native.records.delete(id);
    });
    native.retire.mockReset().mockImplementation(async (id: string) => {
        native.records.get(id)!.retired = true;
    });
    native.install.mockReset();
    native.show.mockReset();
    native.dispose.mockReset();
    native.subscribe.mockReset().mockImplementation(async (callback: () => void) => {
        native.changed = callback;
        return native.dispose;
    });
    native.reconcile.mockReset().mockResolvedValue(undefined);
    native.clear.mockReset().mockResolvedValue(1n);
    native.changed = undefined;
});
afterEach(() => {
    for (const run of runtimes) run.completions.disposeEngineCompletions();
    vi.restoreAllMocks();
});

test("reload completion Add replays after save/ack loss without duplicating or restoring a later deletion", async () => {
    const completion = workflow();
    retain(completion);
    native.ack.mockRejectedValueOnce(new Error("receiver lost"));
    const first = await runtime();
    await expect(first.completions.applyEngineCompletion(completion, first.store)).rejects.toThrow(
        "receiver lost",
    );
    expect(durable("engines")).toMatchObject({
        version: 1,
        value: [{ id: "add-engine" }],
        receipts: { [completion.id]: "applied" },
    });
    expect((await first.store.set(first.atoms.enginesAtom, [])).saved).toBe(true);
    expect(durable("engines").receipts[completion.id]).toBe("applied");
    first.completions.disposeEngineCompletions();
    const replacement = await runtime();
    await replacement.completions.initializeEngineCompletions(replacement.store);
    expect(replacement.store.get(replacement.atoms.enginesAtom)).toEqual([]);
    expect(native.records.size).toBe(0);
    expect(native.install).not.toHaveBeenCalled();
    expect(native.ack).toHaveBeenCalledTimes(2);
});

test.each(["engines", "game-player1-settings", "game-player2-settings", "ack"])(
    "reload completion upgrade resumes after the %s boundary with one UUID and all owners converged",
    async (boundary) => {
        localStorage.setItem("engines", serializeStorageValue([a]));
        for (const key of ["game-player1-settings", "game-player2-settings"])
            localStorage.setItem(key, serializeStorageValue(player()));
        const completion = workflow(true);
        retain(completion);
        const write = Storage.prototype.setItem;
        let refused = false;
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(
            function (this: Storage, key, value) {
                if (!refused && key === boundary) {
                    refused = true;
                    throw new DOMException("quota", "QuotaExceededError");
                }
                write.call(this, key, value);
            },
        );
        if (boundary === "ack") native.ack.mockRejectedValueOnce(new Error("lost acknowledgement"));
        const first = await runtime();
        await expect(
            first.completions.applyEngineCompletion(completion, first.store),
        ).rejects.toThrow(/Engines\.(SaveError|Upgrade\.SnapshotSaveError)|lost acknowledgement/);
        expect(native.records.has(completion.id)).toBe(true);
        first.completions.disposeEngineCompletions();
        vi.restoreAllMocks();
        const replacement = await runtime();
        await replacement.completions.initializeEngineCompletions(replacement.store);
        expect(replacement.store.get(replacement.atoms.enginesAtom)).toMatchObject([
            { id: a.id, handle: { id: { id: "binary-b" } }, settings: [{ value: "20" }] },
        ]);
        for (const key of ["game-player1-settings", "game-player2-settings"]) {
            expect(durable(key)).toMatchObject({
                value: {
                    engine: { id: a.id, handle: { id: { id: "binary-b" } } },
                    go: { c: 12 },
                    engineSettings: [{ value: "20" }],
                },
                receipts: { [completion.id]: "applied" },
            });
        }
        expect(native.records.size).toBe(0);
        expect(native.install).not.toHaveBeenCalled();
    },
);

test("reload completion partial A to B application cannot be overtaken and explicit retry rejoins it", async () => {
    localStorage.setItem("engines", serializeStorageValue([a]));
    for (const key of ["game-player1-settings", "game-player2-settings"])
        localStorage.setItem(key, serializeStorageValue(player()));
    const ab = workflow(true);
    retain(ab);
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
        if (key === "game-player2-settings") throw new Error("refused second player");
        original.call(this, key, value);
    });
    const first = await runtime();
    await expect(first.completions.applyEngineCompletion(ab, first.store)).rejects.toThrow(
        "Engines.SaveError refused second player",
    );
    expect(durable("game-player1-settings").value).toMatchObject({
        engine: { handle: { id: { id: "binary-b" } } },
    });
    const b = first.store.get(first.atoms.enginesAtom)![0] as LocalEngine;
    await expect(
        first.completions.completeCatalogEngine(
            { downloadLink: "https://example.com/c.zip" } as never,
            "another-catalog",
            "ticket",
            b,
            first.store,
        ),
    ).rejects.toThrow("Engines.SaveError refused second player");
    expect(native.install).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    first.completions.disposeEngineCompletions();
    const second = await runtime();
    await second.completions.initializeEngineCompletions(second.store);
    const bc = workflow(true, b, "binary-c");
    retain(bc);
    await second.completions.applyEngineCompletion(bc, second.store);
    expect(second.store.get(second.atoms.enginesAtom)).toMatchObject([
        { id: a.id, handle: { id: { id: "binary-c" } } },
    ]);
    for (const key of ["game-player1-settings", "game-player2-settings"])
        expect(durable(key).value).toMatchObject({
            engine: { id: a.id, handle: { id: { id: "binary-c" } } },
        });
    expect(native.records.size).toBe(0);
});

test.each(["deleted", "new binary", "new player", "new settings"])(
    "reload completion preserves a newer %s choice between owner commits",
    async (choice) => {
        localStorage.setItem("engines", serializeStorageValue([a]));
        localStorage.setItem("game-player1-settings", serializeStorageValue(player()));
        const completion = workflow(true);
        retain(completion);
        native.retire.mockRejectedValueOnce(new Error("cleanup failed"));
        const first = await runtime();
        await expect(
            first.completions.applyEngineCompletion(completion, first.store),
        ).rejects.toThrow("cleanup failed");
        if (choice === "deleted") await first.store.set(first.atoms.enginesAtom, []);
        if (choice === "new binary")
            await first.store.set(first.atoms.enginesAtom, [
                { ...a, handle: { id: { id: "binary-c" }, kind: "engine" } },
            ]);
        if (choice === "new player")
            await first.store.set(first.atoms.gamePlayer1SettingsAtom, {
                type: "human",
                name: "New human",
            });
        if (choice === "new settings")
            await first.store.set(first.atoms.gamePlayer1SettingsAtom, {
                ...player(),
                engineSettings: [{ type: "string", name: "Threads", value: "7" }],
            });
        first.completions.disposeEngineCompletions();
        const replacement = await runtime();
        await replacement.completions.initializeEngineCompletions(replacement.store);
        const expectedEngines =
            choice === "deleted"
                ? []
                : [
                      {
                          id: a.id,
                          handle: { id: { id: choice === "new binary" ? "binary-c" : "binary-b" } },
                      },
                  ];
        expect(replacement.store.get(replacement.atoms.enginesAtom)).toMatchObject(expectedEngines);
        const snapshot = durable("game-player1-settings");
        const expectedPlayer =
            choice === "new player"
                ? { type: "human", name: "New human" }
                : choice === "new settings"
                  ? {
                        engine: { handle: { id: { id: "binary-b" } } },
                        engineSettings: [{ value: "7" }],
                    }
                  : { engine: { handle: { id: { id: "binary-a" } } } };
        expect(snapshot.value).toMatchObject(expectedPlayer);
        expect(snapshot.receipts[completion.id]).toBe(
            choice === "new settings" ? "applied" : "skipped",
        );
        expect(native.records.size).toBe(0);
    },
);

test.each(["malformed", "unreadable"])(
    "reload completion refuses %s owner writes and keeps native work",
    async (mode) => {
        const completion = workflow();
        retain(completion);
        localStorage.setItem("engines", "corrupt original bytes");
        if (mode === "unreadable") {
            const read = Storage.prototype.getItem;
            vi.spyOn(Storage.prototype, "getItem").mockImplementation(
                function (this: Storage, key) {
                    if (key === "engines") throw new Error("unreadable");
                    return read.call(this, key);
                },
            );
        }
        const run = await runtime();
        await expect(run.completions.applyEngineCompletion(completion, run.store)).rejects.toThrow(
            "Engines.SaveError",
        );
        expect(native.ack).not.toHaveBeenCalled();
        expect(native.records.has(completion.id)).toBe(true);
        vi.restoreAllMocks();
        expect(localStorage.getItem("engines")).toBe("corrupt original bytes");
    },
);

test("reload completion observes running work without delaying startup and disposes stale callbacks", async () => {
    const completion = workflow();
    completion.outcome = { state: "running" };
    retain(completion);
    const run = await runtime();
    await run.completions.initializeEngineCompletions(run.store);
    expect(native.changed).toBeTypeOf("function");
    expect(native.ack).not.toHaveBeenCalled();
    completion.outcome = workflow().outcome;
    native.changed!();
    await vi.waitFor(() => expect(native.ack).toHaveBeenCalledWith(completion.id));
    expect(run.store.get(run.atoms.enginesAtom)).toMatchObject([{ id: "add-engine" }]);
    run.completions.disposeEngineCompletions();
    expect(native.dispose).toHaveBeenCalledOnce();
    const next = workflow();
    retain(next);
    native.changed!();
    await Promise.resolve();
    expect(native.records.has(next.id)).toBe(true);
});

test("reload completion snapshots a terminal result produced during asynchronous subscription setup", async () => {
    const completion = workflow();
    completion.outcome = { state: "running" };
    retain(completion);
    const subscribing = deferred<void>();
    const subscribed = deferred<void>();
    native.subscribe.mockImplementationOnce(async (callback: () => void) => {
        subscribing.resolve();
        await subscribed.promise;
        native.changed = callback;
        return native.dispose;
    });
    const run = await runtime();
    const initialization = run.completions.initializeEngineCompletions(run.store);
    await subscribing.promise;
    // Native finishes while listen() is still pending, before this document can receive events.
    completion.outcome = workflow().outcome;
    subscribed.resolve();
    await initialization;

    expect(run.store.get(run.atoms.enginesAtom)).toMatchObject([{ id: "add-engine" }]);
    expect(native.ack).toHaveBeenCalledExactlyOnceWith(completion.id);
    expect(native.records.size).toBe(0);
});

test("reload completion pruning requires a native pending snapshot and retains receipts through ordinary edits", async () => {
    const completion = workflow();
    retain(completion);
    native.ack.mockRejectedValueOnce(new Error("lost"));
    const run = await runtime();
    await expect(run.completions.applyEngineCompletion(completion, run.store)).rejects.toThrow(
        "lost",
    );
    await run.store.set(run.atoms.enginesAtom, (current) =>
        current.map((engine) => ({ ...engine, name: "Renamed" })),
    );
    expect(durable("engines").receipts[completion.id]).toBe("applied");
    await run.owners.pruneEngineCompletionReceipts(new Set([completion.id]));
    expect(durable("engines").receipts[completion.id]).toBe("applied");
    await run.completions.applyEngineCompletion(completion, run.store);
    const replacement = await runtime();
    await replacement.completions.initializeEngineCompletions(replacement.store);
    expect(durable("engines").receipts).toEqual({});
    expect(durable("engines").value).toMatchObject([{ name: "Renamed" }]);
});

test("reload completion reads a retained failure through the localized error path and acknowledges no native effect", async () => {
    const failure: ErrorPayload = {
        tag: "backend-error",
        category: "network",
        message: "Remote server rejected the download",
        remoteHttpRejection: { status: 403, authorizationSent: false },
    };
    const completion = failedWorkflow(failure);
    retain(completion);
    const run = await runtime();
    await run.completions.initializeEngineCompletions(run.store);
    expect(native.show).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
            title: "Common.Error",
            message: "Common.RemoteRequest.AccessDenied",
        }),
    );
    await expect(run.completions.applyEngineCompletion(completion, run.store)).rejects.toBe(
        failure,
    );
    expect(native.show).toHaveBeenCalledOnce();
    expect(native.records.size).toBe(0);
    expect(native.retire).not.toHaveBeenCalled();
    expect(localStorage.getItem("engines")).toBeNull();
});

test("reload completion keeps safe root failure guidance across document loss", async () => {
    const failure: ErrorPayload = {
        tag: "backend-error",
        category: "permission",
        message: "Permission denied",
        rootFailure: "permission",
    };
    const completion = failedWorkflow(failure);
    retain(completion);
    const run = await runtime();
    await run.completions.initializeEngineCompletions(run.store);
    expect(native.show).toHaveBeenCalledExactlyOnceWith({
        color: "danger",
        title: "Common.Error",
        message: "Engines.LoadError.RootPermission",
    });
    await expect(run.completions.applyEngineCompletion(completion, run.store)).rejects.toBe(
        failure,
    );
    expect(native.show).toHaveBeenCalledOnce();
    expect(native.records.size).toBe(0);
});

test("reload completion preserves the safe engine failure snapshot and message", async () => {
    const failure: ErrorPayload = {
        tag: "engine-failure",
        category: "engine-timeout",
        message: "Engine timeout: waiting for uciok",
        engineFailure: { kind: "protocol-failure", exitStatus: null, reason: "uciok", entries: [] },
    };
    const completion = failedWorkflow(failure);
    retain(completion);
    const run = await runtime();
    await run.completions.initializeEngineCompletions(run.store);
    expect(native.show).toHaveBeenCalledExactlyOnceWith({
        color: "danger",
        title: "Common.Error",
        message: failure.message,
    });
    await expect(run.completions.applyEngineCompletion(completion, run.store)).rejects.toBe(
        failure,
    );
    expect(native.show).toHaveBeenCalledOnce();
    expect(native.ack).toHaveBeenCalledExactlyOnceWith(completion.id);
});

test.each(["command-first", "event-first"])(
    "reload completion preserves a failed terminal result for concurrent callers: %s",
    async (order) => {
        const failure: ErrorPayload = {
            tag: "backend-error",
            category: "network",
            message: "Remote server rejected the download",
            remoteHttpRejection: { status: 403, authorizationSent: false },
        };
        const completion = failedWorkflow(failure);
        const run = await runtime();
        await run.completions.initializeEngineCompletions(run.store);
        retain(completion);
        const acknowledged = deferred<void>();
        const releaseAck = deferred<void>();
        native.ack.mockImplementationOnce(async (id: string) => {
            native.records.delete(id);
            acknowledged.resolve();
            await releaseAck.promise;
        });
        let command: Promise<void>;
        if (order === "command-first") {
            command = run.completions.applyEngineCompletion(completion, run.store);
            void command.catch(() => undefined);
            await acknowledged.promise;
            native.changed!();
            releaseAck.resolve();
        } else {
            native.changed!();
            await acknowledged.promise;
            releaseAck.resolve();
            // Wait for the observer's application to leave the in-flight map, then deliver the
            // already captured command response. Native no longer retains this failed result.
            await run.completions.observeEngineCompletions();
            command = run.completions.applyEngineCompletion(completion, run.store);
        }
        await expect(command).rejects.toEqual(failure);
        await expect(run.completions.applyEngineCompletion(completion, run.store)).rejects.toEqual(
            failure,
        );
        expect(native.ack).toHaveBeenCalledExactlyOnceWith(completion.id);
        expect(native.show).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                title: "Common.Error",
                message: "Common.RemoteRequest.AccessDenied",
            }),
        );
        expect(localStorage.getItem("engines")).toBeNull();
        expect(native.retire).not.toHaveBeenCalled();
    },
);

test.each(["path", "name"])(
    "reload completion keeps a different UUID with the same %s independent",
    async (shared) => {
        const neighbor: LocalEngine = {
            ...a,
            id: "neighbor",
            name: shared === "name" ? a.name : "Neighbor",
            handle: shared === "path" ? a.handle : { id: { id: "other-binary" }, kind: "engine" },
        };
        localStorage.setItem("engines", serializeStorageValue([a, neighbor]));
        localStorage.setItem("game-player1-settings", serializeStorageValue(player()));
        localStorage.setItem("game-player2-settings", serializeStorageValue(player(neighbor)));
        const completion = workflow(true);
        retain(completion);
        const run = await runtime();
        await run.completions.applyEngineCompletion(completion, run.store);
        expect(run.store.get(run.atoms.enginesAtom)).toMatchObject([
            { id: a.id, handle: { id: { id: "binary-b" } } },
            neighbor,
        ]);
        expect(durable("game-player2-settings")).toMatchObject({
            value: player(neighbor),
            receipts: { [completion.id]: "skipped" },
        });
        expect(native.records.size).toBe(0);
    },
);

test("reload completion reports refused startup recovery and retries retained failures after owner repair", async () => {
    const completion = failedWorkflow({
        tag: "backend-error",
        category: "network",
        message: "Network request failed",
    });
    retain(completion);
    localStorage.setItem("engines", "invalid original owner");
    const run = await runtime();
    await expect(run.completions.initializeEngineCompletions(run.store)).rejects.toThrow(
        "Engines.SaveError",
    );
    expect(native.records.has(completion.id)).toBe(true);
    expect(native.show).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
            title: "Common.Error",
            message: expect.stringContaining("Engines.SaveError"),
        }),
    );
    localStorage.setItem("engines", serializeStorageValue([]));
    await run.completions.initializeEngineCompletions(run.store);
    expect(native.show).toHaveBeenCalledTimes(2);
    expect(native.show).toHaveBeenNthCalledWith(2, {
        color: "danger",
        title: "Common.Error",
        message: "Network request failed",
    });
    expect(native.records.size).toBe(0);
});

test("reload completion reports an owner-save failure once and retains it for retry", async () => {
    const completion = workflow();
    retain(completion);
    const write = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
        if (key === "engines") throw new Error("quota");
        write.call(this, key, value);
    });
    const run = await runtime();
    await run.completions.initializeEngineCompletions(run.store);
    expect(native.show).toHaveBeenCalledExactlyOnceWith({
        color: "danger",
        title: "Common.Error",
        message: "Engines.SaveError quota",
    });
    expect(native.records.has(completion.id)).toBe(true);
    expect(native.ack).not.toHaveBeenCalled();
});

test("shared application reports an owner-save failure once while every caller receives the same error", async () => {
    const completion = workflow();
    retain(completion);
    const preparationFailure = new Error("prepare refused");
    native.reconcile.mockRejectedValueOnce(preparationFailure);
    const run = await runtime();
    const first = run.completions.applyEngineCompletion(completion, run.store);
    const joined = run.completions.applyEngineCompletion(completion, run.store);
    expect(joined).toBe(first);
    const [failure, otherFailure] = await Promise.all([
        first.catch((error: unknown) => error),
        joined.catch((error: unknown) => error),
    ]);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toBe(preparationFailure);
    expect(otherFailure).toBe(failure);
    const { notifyUnlessCancelled } = await import("@/components/files/notifyError");
    notifyUnlessCancelled("Common.Error", failure, "engine");
    notifyUnlessCancelled("Common.Error", otherFailure, "engine");
    expect(native.show).toHaveBeenCalledExactlyOnceWith({
        color: "danger",
        title: "Common.Error",
        message: "prepare refused",
    });
    expect(native.records.has(completion.id)).toBe(true);
    expect(native.ack).not.toHaveBeenCalled();
});

test("shared retained failure preserves every safe field for every caller and reports once", async () => {
    const failure: ErrorPayload = {
        tag: "engine-failure",
        category: "engine-timeout",
        message: "Engine timeout: waiting for uciok",
        rootFailure: "permission",
        engineFailure: { kind: "protocol-failure", exitStatus: null, reason: "uciok", entries: [] },
        remoteHttpRejection: { status: 403, authorizationSent: false },
    };
    const completion = failedWorkflow(failure);
    retain(completion);
    const run = await runtime();
    const first = run.completions.applyEngineCompletion(completion, run.store);
    const joined = run.completions.applyEngineCompletion(completion, run.store);
    expect(joined).toBe(first);
    const [received, otherReceived] = await Promise.all([
        first.catch((error: unknown) => error),
        joined.catch((error: unknown) => error),
    ]);
    expect(received).toEqual(failure);
    expect(otherReceived).toBe(received);
    const { notifyUnlessCancelled } = await import("@/components/files/notifyError");
    notifyUnlessCancelled("Common.Error", received, "engine");
    notifyUnlessCancelled("Common.Error", otherReceived, "engine");
    expect(native.show).toHaveBeenCalledExactlyOnceWith({
        color: "danger",
        title: "Common.Error",
        message: "Engines.LoadError.RootPermission",
    });
    expect(native.ack).toHaveBeenCalledExactlyOnceWith(completion.id);
});

test.each(["subscription", "snapshot"])(
    "completion initialization still reports its %s failure once",
    async (boundary) => {
        const failure = new Error(`${boundary} unavailable`);
        if (boundary === "subscription") native.subscribe.mockRejectedValueOnce(failure);
        else native.pending.mockRejectedValueOnce(failure);
        const run = await runtime();
        await expect(run.completions.initializeEngineCompletions(run.store)).rejects.toBe(failure);
        expect(native.show).toHaveBeenCalledExactlyOnceWith({
            color: "danger",
            title: "Common.Error",
            message: failure.message,
        });
    },
);

test.each(["network", "cancellation"] as const)(
    "retained %s reaches its reporting owner before acknowledgement can dispose the document",
    async (category) => {
        const failure: ErrorPayload = {
            tag: "backend-error",
            category,
            message: category === "cancellation" ? "Cancellation" : "Network request failed",
        };
        const completion = failedWorkflow(failure);
        retain(completion);
        const run = await runtime();
        const { isErrorReported } = await import("@/platform/errors");
        // Keep this response's identity visible to the native callback so it can observe the
        // ownership handoff, then simulate losing the document immediately after native removal.
        native.pending.mockResolvedValueOnce([completion]);
        const observed: Array<{ notifications: number; reported: boolean }> = [];
        native.ack.mockImplementationOnce(async (id: string) => {
            observed.push({
                notifications: native.show.mock.calls.length,
                reported: isErrorReported(failure),
            });
            native.records.delete(id);
            run.completions.disposeEngineCompletions();
        });
        const first = run.completions.applyEngineCompletion(completion, run.store);
        const joined = run.completions.applyEngineCompletion(completion, run.store);
        expect(joined).toBe(first);
        await expect(first).rejects.toBe(failure);
        await expect(joined).rejects.toBe(failure);
        expect(observed).toEqual([
            { notifications: category === "cancellation" ? 0 : 1, reported: true },
        ]);
        expect(native.show).toHaveBeenCalledTimes(category === "cancellation" ? 0 : 1);
        expect(native.ack).toHaveBeenCalledExactlyOnceWith(completion.id);
        expect(native.records.size).toBe(0);
    },
);

test("a failed acknowledgement reports its own error after the retained failure was reported", async () => {
    const failure: ErrorPayload = {
        tag: "backend-error",
        category: "network",
        message: "Network request failed",
    };
    const completion = failedWorkflow(failure);
    retain(completion);
    const acknowledgementFailure = new Error("acknowledgement unavailable");
    native.ack.mockRejectedValueOnce(acknowledgementFailure);
    const run = await runtime();
    await expect(run.completions.applyEngineCompletion(completion, run.store)).rejects.toBe(
        acknowledgementFailure,
    );
    expect(native.show).toHaveBeenCalledTimes(2);
    expect(native.show).toHaveBeenNthCalledWith(1, {
        color: "danger",
        title: "Common.Error",
        message: failure.message,
    });
    expect(native.show).toHaveBeenNthCalledWith(2, {
        color: "danger",
        title: "Common.Error",
        message: acknowledgementFailure.message,
    });
    expect(native.records.has(completion.id)).toBe(true);
});
