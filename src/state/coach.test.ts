import { createStore } from "jotai";
import { beforeEach, expect, test, vi } from "vitest";
import type { ConnectionSummary, ModelInfo } from "@/bindings";
import { CoachCommandError } from "@/platform/coach";
import type { Engine } from "@/utils/engines";

const mocks = vi.hoisted(() => ({
    coachAvailable: vi.fn(),
    coachConnections: vi.fn(),
    coachModels: vi.fn(),
    coachOpenUsage: vi.fn(),
    warn: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/platform/tauri", () => ({ tauri: mocks }));
vi.mock("@/platform/native", () => ({ warn: mocks.warn, error: vi.fn() }));

const {
    coachConnectionsAtom,
    coachEnabledAtom,
    coachEngines,
    coachModelsAtom,
    coachPlanNoticeSeenAtom,
    defaultCoachEffort,
    effectiveCoachEngine,
    effectiveCoachSelection,
    openCoachUsage,
} = await import("./coach");

function connection(handle: string): ConnectionSummary {
    return {
        handle,
        kind: "api",
        label: handle,
        address: "http://localhost:11434/v1",
        hasKey: false,
        account: null,
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

test("only the newest model list request is accepted, also for the same connection", async () => {
    const atoms = createStore();
    const first = deferred<{ models: ModelInfo[]; truncated: boolean }>();
    const second = deferred<{ models: ModelInfo[]; truncated: boolean }>();
    const other = deferred<{ models: ModelInfo[]; truncated: boolean }>();
    mocks.coachModels
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(other.promise)
        .mockReturnValueOnce(second.promise);
    // The connection is asked, another one is looked at, then the first is asked again.
    const stale = atoms.set(coachModelsAtom, "a");
    const between = atoms.set(coachModelsAtom, "b");
    const newest = atoms.set(coachModelsAtom, "a");
    expect(atoms.get(coachModelsAtom)).toEqual({ connection: "a", status: "loading" });

    // The first request answers while the newest one for the same connection is still open.
    first.reject(new CoachCommandError("keyRejected"));
    await stale;
    expect(atoms.get(coachModelsAtom)).toEqual({ connection: "a", status: "loading" });
    other.resolve({ models: [model("b-model")], truncated: false });
    await between;
    expect(atoms.get(coachModelsAtom)).toEqual({ connection: "a", status: "loading" });

    second.resolve({ models: [model("fresh")], truncated: false });
    await newest;
    expect(atoms.get(coachModelsAtom)).toMatchObject({
        connection: "a",
        status: "ready",
        models: [model("fresh")],
    });

    // Asking for no connection drops what a request that is still open would bring.
    const late = deferred<{ models: ModelInfo[]; truncated: boolean }>();
    mocks.coachModels.mockReturnValueOnce(late.promise);
    const open = atoms.set(coachModelsAtom, "a");
    await atoms.set(coachModelsAtom, null);
    late.resolve({ models: [model("late")], truncated: false });
    await open;
    expect(atoms.get(coachModelsAtom)).toEqual({ connection: null, status: "idle" });
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
    // With several connections left, a removed one is never replaced by a guess.
    expect(effectiveCoachSelection(stored, [connections[0], connection("c")], models)).toEqual({
        connection: null,
        model: null,
        effort: null,
    });
    // A sole connection counts as chosen, whether nothing was stored or the stored one is gone.
    expect(effectiveCoachSelection(stored, [connections[0]], null).connection).toBe(connections[0]);
    // The stored model and effort belong to the stored connection and never carry over.
    expect(effectiveCoachSelection(stored, [connections[0]], models)).toEqual({
        connection: connections[0],
        model: null,
        effort: null,
    });
    expect(
        effectiveCoachSelection(
            { connection: null, model: "plain", effort: null },
            [connections[0]],
            models,
        ),
    ).toEqual({ connection: connections[0], model: null, effort: null });
    expect(
        effectiveCoachSelection(
            { connection: null, model: null, effort: null },
            connections,
            models,
        ).connection,
    ).toBeNull();
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

test("the usage page is opened natively, and a failure to open it is only logged", async () => {
    mocks.coachOpenUsage.mockResolvedValue(null);
    openCoachUsage();
    await Promise.resolve();
    expect(mocks.coachOpenUsage).toHaveBeenCalledOnce();
    expect(mocks.warn).not.toHaveBeenCalled();

    mocks.coachOpenUsage.mockRejectedValue(new CoachCommandError("signInFailed"));
    openCoachUsage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.warn).toHaveBeenCalledOnce();
});

test("the plan notice is unseen until it is marked, and a stored value of another shape is not trusted", () => {
    localStorage.clear();
    // The stored value is read when the atom is mounted, as it is by the component that uses it.
    const mounted = () => {
        const atoms = createStore();
        atoms.sub(coachPlanNoticeSeenAtom, () => undefined);
        return atoms;
    };
    const atoms = mounted();
    expect(atoms.get(coachPlanNoticeSeenAtom)).toBe(false);
    atoms.set(coachPlanNoticeSeenAtom, true);
    expect(localStorage.getItem("coach-plan-notice-seen")).toBe("true");
    expect(mounted().get(coachPlanNoticeSeenAtom)).toBe(true);
    localStorage.setItem("coach-plan-notice-seen", JSON.stringify("yes"));
    expect(mounted().get(coachPlanNoticeSeenAtom)).toBe(false);
});
