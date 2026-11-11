import { expect, test, vi } from "vitest";
import type { TrainingSettings } from "@/bindings";
import {
    createTrainingSettingsStore,
    defaultTrainingSettings,
} from "./chessRiddleTrainingSettings";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}
function fixture() {
    const api = {
        chessriddleTrainingSettings: vi
            .fn()
            .mockResolvedValue({ ...defaultTrainingSettings, difficulty: 250, motif: "fork" }),
        chessriddleSaveTrainingSettings: vi.fn(async (settings: TrainingSettings) => settings),
        chessriddleTrainingMotifs: vi.fn().mockResolvedValue(["fork", "pin"]),
    };
    return { api, store: createTrainingSettingsStore(api) };
}

test("load is shared and waits for settings and a delayed catalogue", async () => {
    const { api, store } = fixture();
    const motifs = deferred<string[]>();
    api.chessriddleTrainingMotifs.mockReturnValueOnce(motifs.promise);
    let done = false;
    const load = store.load().then(() => {
        done = true;
    });
    expect(store.load()).toBe(store.load());
    await vi.waitFor(() => expect(store.get().status).toBe("ready"));
    expect(done).toBe(false);
    expect(store.effective().motif).toBeNull();
    motifs.resolve(["fork"]);
    await load;
    expect(store.effective().motif).toBe("fork");
    expect(api.chessriddleTrainingSettings).toHaveBeenCalledOnce();
});

test.each(["updateRequired", "network"])(
    "failed settings read %s runs at defaults",
    async (code) => {
        const { api, store } = fixture();
        api.chessriddleTrainingSettings.mockRejectedValueOnce(code);
        await store.load();
        expect(store.get().status).toBe("unavailable");
        expect(store.get().error).toBe(code === "updateRequired" ? null : code);
        expect(store.effective()).toEqual(defaultTrainingSettings);
        await store.load(true);
        expect(store.get().status).toBe("ready");
    },
);

test.each([false, true])(
    "missing or failed catalogue keeps the saved motif untouched, failure=%s",
    async (failed) => {
        const { api, store } = fixture();
        if (failed) api.chessriddleTrainingMotifs.mockRejectedValueOnce("network");
        else api.chessriddleTrainingMotifs.mockResolvedValueOnce(["pin"]);
        await store.load();
        expect(store.get().values.motif).toBe("fork");
        expect(store.effective().motif).toBeNull();
        expect(store.get().status).toBe("ready");
        expect(store.get().motifError).toBe(failed ? "network" : null);
        await store.retryMotifs();
        expect(store.effective().motif).toBe("fork");
        expect(api.chessriddleSaveTrainingSettings).not.toHaveBeenCalled();
    },
);

test("saves serialize and send the newest change after the in-flight save", async () => {
    const { api, store } = fixture();
    await store.load();
    const save = deferred<TrainingSettings>();
    api.chessriddleSaveTrainingSettings.mockReturnValueOnce(save.promise);
    store.change({ difficulty: -250 });
    store.change({ motif: "pin" });
    store.change({ showTimer: true });
    expect(api.chessriddleSaveTrainingSettings).toHaveBeenCalledOnce();
    expect(store.effective().difficulty).toBe(250);
    save.resolve({ ...store.get().values, motif: "fork", showTimer: false });
    await vi.waitFor(() => expect(store.get().saving).toBe(false));
    expect(api.chessriddleSaveTrainingSettings).toHaveBeenCalledTimes(2);
    expect(api.chessriddleSaveTrainingSettings).toHaveBeenLastCalledWith({
        ...defaultTrainingSettings,
        difficulty: -250,
        motif: "pin",
        showTimer: true,
    });
    expect(store.effective().motif).toBe("pin");
});

test.each([false, true])(
    "failed save reconciles before accepting changes, read failure=%s",
    async (readFails) => {
        const { api, store } = fixture();
        await store.load();
        const read = deferred<TrainingSettings>();
        api.chessriddleSaveTrainingSettings.mockRejectedValueOnce("network");
        api.chessriddleTrainingSettings.mockReturnValueOnce(read.promise);
        store.change({ difficulty: -500 });
        store.change({ motif: "pin" });
        await vi.waitFor(() => expect(store.get().reconciling).toBe(true));
        store.change({ timerDuration: 60 });
        if (readFails) read.reject("server");
        else read.resolve({ ...defaultTrainingSettings, difficulty: 500 });
        await vi.waitFor(() => expect(store.get().saving).toBe(false));
        expect(api.chessriddleSaveTrainingSettings).toHaveBeenCalledOnce();
        expect(store.get().saveError).toBe("network");
        expect(store.get().values).toEqual({
            ...defaultTrainingSettings,
            difficulty: readFails ? 0 : 500,
        });
        expect(store.get().error).toBe(readFails ? "server" : null);
        expect(store.get().status).toBe(readFails ? "unavailable" : "ready");
    },
);

test("reset retires late reads and saves", async () => {
    const { api, store } = fixture();
    const old = deferred<TrainingSettings>();
    api.chessriddleTrainingSettings.mockReturnValueOnce(old.promise);
    const load = store.load();
    store.reset();
    await store.load();
    old.resolve({ ...defaultTrainingSettings, difficulty: -500 });
    await load;
    expect(store.get().values.difficulty).toBe(250);
    const save = deferred<TrainingSettings>();
    api.chessriddleSaveTrainingSettings.mockReturnValueOnce(save.promise);
    store.change({ difficulty: -250 });
    store.reset();
    save.resolve({ ...defaultTrainingSettings, difficulty: -250 });
    await vi.waitFor(() => expect(store.get().status).toBe("idle"));
    expect(store.get().values).toEqual(defaultTrainingSettings);
});

test("solution length is off by default and survives saves in the existing settings body", async () => {
    expect(defaultTrainingSettings.showMoveCounter).toBe(false);
    const { api, store } = fixture();
    api.chessriddleTrainingSettings.mockResolvedValueOnce({
        ...defaultTrainingSettings,
        showMoveCounter: true,
    });
    await store.load();
    expect(store.effective().showMoveCounter).toBe(true);
    store.change({ difficulty: 500 });
    await store.settled();
    expect(api.chessriddleSaveTrainingSettings).toHaveBeenCalledWith({
        ...defaultTrainingSettings,
        difficulty: 500,
        showMoveCounter: true,
    });
});
