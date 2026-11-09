import { createStore } from "jotai";
import { beforeEach, expect, test, vi } from "vitest";
import type { EngineCompletion } from "@/bindings";
import type { DefaultEngine, LocalEngine } from "@/utils/engines";
import { installCatalogEngineJob } from "./catalogEngineCompletion";

const mocks = vi.hoisted(() => ({
    run: vi.fn(),
    install: vi.fn(),
    initialize: vi.fn(),
    observe: vi.fn(),
    apply: vi.fn(),
    notify: vi.fn(),
}));
vi.mock("@/hooks/downloadJobs", () => ({ runDownloadJob: mocks.run }));
vi.mock("@/utils/engineInstall", () => ({ installCatalogEngine: mocks.install }));
vi.mock("@/components/files/notifyError", async (original) => {
    const actual = await original<typeof import("@/components/files/notifyError")>();
    return {
        ...actual,
        notifyUnlessCancelled: (...args: Parameters<typeof actual.notifyUnlessCancelled>) => {
            mocks.notify(...args);
            actual.notifyUnlessCancelled(...args);
        },
    };
});
const notifications = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock("@mantine/notifications", () => ({ notifications }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("./engineCompletions", () => ({
    initializeEngineCompletions: mocks.initialize,
    observeEngineCompletions: mocks.observe,
    applyEngineCompletion: mocks.apply,
    engineCompletionState: {
        pending: new Map(),
        listeners: new Set(),
        publish: () => {},
        requireDocument: () => {},
    },
}));

const engine: DefaultEngine = {
    id: "catalog",
    type: "local",
    name: "Stockfish",
    version: "17",
    path: "stockfish",
    os: "linux",
    bmi2: false,
    sha256: "a".repeat(64),
    signature: "signature",
    downloadLink: "https://example.com/stockfish.zip",
};
const completion = { id: "completion", outcome: { state: "succeeded" } } as EngineCompletion;

beforeEach(() => {
    vi.resetAllMocks();
    mocks.run.mockImplementation((_id, run) => run("ticket"));
    mocks.initialize.mockResolvedValue(undefined);
    mocks.observe.mockResolvedValue([]);
    mocks.install.mockResolvedValue(completion);
    mocks.apply.mockResolvedValue(undefined);
});

test.each([false, true])(
    "the shared job keeps its store and upgrade target: upgrade=%s",
    async (upgrade) => {
        const store = createStore();
        const target: LocalEngine | undefined = upgrade
            ? {
                  id: "immutable-target",
                  type: "local",
                  name: "Old",
                  version: "1",
                  filename: "old",
                  handle: { id: { id: "old-binary" }, kind: "engine" },
              }
            : undefined;
        await expect(installCatalogEngineJob(engine, "progress", target, store)).resolves.toBe(
            true,
        );
        expect(mocks.run).toHaveBeenCalledExactlyOnceWith("progress", expect.any(Function));
        expect(mocks.initialize).toHaveBeenCalledExactlyOnceWith(store);
        const addIntent = { kind: "add", engine_id: expect.any(String) };
        expect(mocks.install).toHaveBeenCalledExactlyOnceWith(
            engine,
            "progress",
            "ticket",
            target ? { kind: "upgrade", engine_id: target.id, expected: target.handle } : addIntent,
        );
        expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(completion, store);
        expect(mocks.notify).not.toHaveBeenCalled();
    },
);

test("a synchronous busy refusal accepts no job and stays silent", () => {
    mocks.run.mockImplementation(() => {
        throw Object.assign(new Error("busy"), { reason: "busy" });
    });
    expect(installCatalogEngineJob(engine, "progress")).toBeNull();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
});

test.each(["synchronous", "download", "completion"])(
    "%s failure uses the Add dialog error contract",
    async (source) => {
        const failure = new Error("install failed");
        if (source === "synchronous")
            mocks.run.mockImplementation(() => {
                throw failure;
            });
        else if (source === "download") mocks.install.mockRejectedValue(failure);
        else mocks.apply.mockRejectedValue(failure);
        expect(await installCatalogEngineJob(engine, "progress")).toBe(
            source === "synchronous" ? null : false,
        );
        expect(mocks.notify).toHaveBeenCalledExactlyOnceWith("Common.Error", failure, "engine");
        expect(notifications.show).toHaveBeenCalledOnce();
    },
);

test("cancellation terminates unsuccessfully without a notification", async () => {
    const cancellation = new Error("Cancellation");
    mocks.install.mockRejectedValue(cancellation);
    await expect(installCatalogEngineJob(engine, "progress")).resolves.toBe(false);
    expect(notifications.show).not.toHaveBeenCalled();
});
