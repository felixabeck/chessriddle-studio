import { createStore } from "jotai";
import { beforeEach, expect, test, vi } from "vitest";
import type { ConnectionSummary, ModelInfo } from "@/bindings";
import { CoachCommandError } from "@/platform/coach";
import type { Engine } from "@/utils/engines";

const mocks = vi.hoisted(() => ({
    coachAvailable: vi.fn(),
    coachConnections: vi.fn(),
}));
vi.mock("@/platform/tauri", () => ({ tauri: mocks }));
vi.mock("@/platform/native", () => ({ warn: vi.fn(), error: vi.fn() }));

const {
    coachConnectionsAtom,
    coachEnabledAtom,
    coachEngines,
    defaultCoachEffort,
    effectiveCoachEngine,
    effectiveCoachSelection,
} = await import("./coach");

function connection(handle: string): ConnectionSummary {
    return {
        handle,
        kind: "api",
        label: handle,
        address: "http://localhost:11434/v1",
        hasKey: false,
        status: "ready",
    };
}

function model(id: string, effortLevels: string[] = [], defaultEffort: string | null = null) {
    return { id, name: id, effortLevels, defaultEffort, supportsTools: null } satisfies ModelInfo;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    vi.resetAllMocks();
});

test("the Coach counts as off until the native side confirms it, and stays off when the read fails", async () => {
    const pending = deferred<boolean>();
    mocks.coachAvailable.mockReturnValue(pending.promise);
    const store = createStore();
    const unsubscribe = store.sub(coachEnabledAtom, () => {});
    expect(store.get(coachEnabledAtom)).toBe(false);
    pending.resolve(true);
    await settle();
    expect(store.get(coachEnabledAtom)).toBe(true);
    unsubscribe();

    const replies = [() => Promise.resolve(false), () => Promise.reject(new Error("no native"))];
    for (const reply of replies) {
        mocks.coachAvailable.mockImplementation(reply);
        const other = createStore();
        const stop = other.sub(coachEnabledAtom, () => {});
        await settle();
        expect(other.get(coachEnabledAtom)).toBe(false);
        stop();
    }
});

test("mounting reads the native connections and only the newest read is accepted", async () => {
    const first = deferred<ConnectionSummary[]>();
    const second = deferred<ConnectionSummary[]>();
    mocks.coachConnections.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const store = createStore();
    const unsubscribe = store.sub(coachConnectionsAtom, () => {});
    expect(store.get(coachConnectionsAtom)).toEqual({ status: "loading" });
    const reread = store.set(coachConnectionsAtom);
    second.resolve([connection("new")]);
    await reread;
    expect(store.get(coachConnectionsAtom)).toEqual({
        status: "ready",
        connections: [connection("new")],
    });
    // The first read answers last and must not replace the newer list.
    first.resolve([connection("old")]);
    await settle();
    expect(store.get(coachConnectionsAtom)).toEqual({
        status: "ready",
        connections: [connection("new")],
    });
    unsubscribe();
});

test("a failed connection read carries the native error code", async () => {
    mocks.coachConnections.mockRejectedValue(new CoachCommandError("storage"));
    const store = createStore();
    await store.set(coachConnectionsAtom);
    expect(store.get(coachConnectionsAtom)).toEqual({ status: "failed", error: "storage" });
});

test("a stored selection is honoured only while its connection and model exist", () => {
    const connections = [connection("a"), connection("b")];
    const models = [model("plain"), model("leveled", ["low", "high"], "high")];
    const stored = { connection: "b", model: "plain", effort: "high" };

    expect(effectiveCoachSelection(stored, connections, models)).toEqual({
        connection: connections[1],
        model: models[0],
        effort: "high",
    });
    // A removed connection is never replaced by another one.
    expect(effectiveCoachSelection(stored, [connections[0]], models)).toEqual({
        connection: null,
        model: null,
        effort: null,
    });
    // An unloaded model list leaves model and effort undecided.
    expect(effectiveCoachSelection(stored, connections, null)).toEqual({
        connection: connections[1],
        model: null,
        effort: null,
    });
    expect(effectiveCoachSelection({ ...stored, model: "gone" }, connections, models)).toEqual({
        connection: connections[1],
        model: null,
        effort: null,
    });
});

test("effort is explicit only where the provider reports levels", () => {
    const connections = [connection("a")];
    const plain = model("plain");
    const leveled = model("leveled", ["low", "high"], "high");
    const medium = model("medium", ["low", "medium", "high"], "low");
    const select = (target: ModelInfo, effort: string | null) =>
        effectiveCoachSelection({ connection: "a", model: target.id, effort }, connections, [
            target,
        ]).effort;

    // Nothing reported: nothing is sent unless the user picked one of the common three.
    expect(select(plain, null)).toBeNull();
    expect(select(plain, "low")).toBe("low");
    expect(select(plain, "extreme")).toBeNull();
    // Reported levels: medium if offered, else the provider's default, else the first.
    expect(select(medium, null)).toBe("medium");
    expect(select(leveled, null)).toBe("high");
    expect(select(leveled, "medium")).toBe("high");
    expect(select(leveled, "low")).toBe("low");
    expect(defaultCoachEffort(model("first", ["minimal", "max"]))).toBe("minimal");
    expect(defaultCoachEffort(null)).toBeNull();
});

test("the Coach engine is the picked loaded local engine, else the first one, else none", () => {
    const local = (id: string, loaded: boolean) =>
        ({ type: "local", id, name: id, loaded }) as unknown as Engine;
    const remote = {
        type: "lichess",
        id: "cloud",
        name: "cloud",
        loaded: true,
    } as unknown as Engine;
    const engines = [remote, local("unloaded", false), local("one", true), local("two", true)];

    expect(coachEngines(engines).map((engine) => engine.id)).toEqual(["one", "two"]);
    expect(effectiveCoachEngine(engines, "two")?.id).toBe("two");
    expect(effectiveCoachEngine(engines, "unloaded")?.id).toBe("one");
    expect(effectiveCoachEngine(engines, "cloud")?.id).toBe("one");
    expect(effectiveCoachEngine(engines, null)?.id).toBe("one");
    expect(effectiveCoachEngine([remote], "one")).toBeNull();
    expect(effectiveCoachEngine(undefined, "one")).toBeNull();
});
