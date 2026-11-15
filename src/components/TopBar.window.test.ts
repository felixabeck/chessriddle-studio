import { expect, test } from "vitest";
import capabilityText from "../../src-tauri/capabilities/main.json?raw";
import { bindWindowControls, runWindowAction, watchMaximized } from "@/routes/-appMenu";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

test("window-control handlers return runWindowAction's promise and notify rejections", async () => {
    const minimize = deferred<void>();
    const seen: unknown[] = [];
    const handlers = bindWindowControls(
        {
            minimize: () => minimize.promise,
            toggleMaximize: async () => {
                throw new Error("maximize failed");
            },
            close: async () => {
                throw new Error("close failed");
            },
        },
        (error) => {
            seen.push(error);
        },
    );

    const pending = handlers.minimize();
    let settled = false;
    void pending.then(() => {
        settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    minimize.resolve();
    await pending;
    expect(settled).toBe(true);

    await expect(handlers.toggleMaximize()).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);

    await handlers.close();
    expect(seen).toHaveLength(2);
    expect(seen).toEqual([
        expect.objectContaining({ message: "maximize failed" }),
        expect.objectContaining({ message: "close failed" }),
    ]);
});

test("runWindowAction notifies a rejected native call once", async () => {
    const seen: unknown[] = [];
    await runWindowAction(
        async () => {
            throw new Error("minimize failed");
        },
        (error) => {
            seen.push(error);
        },
    );
    expect(seen).toHaveLength(1);
});

test("watchMaximized ignores setState after stop and notifies once", async () => {
    const maximized = deferred<boolean>();
    const seen: boolean[] = [];
    const notified: unknown[] = [];
    const stop = watchMaximized({
        isMaximized: () => maximized.promise,
        onResized: () => () => undefined,
        setMaximized: (value) => {
            seen.push(value);
        },
        notify: (error) => {
            notified.push(error);
        },
    });
    stop();
    maximized.resolve(true);
    await maximized.promise;
    await Promise.resolve();
    expect(seen).toEqual([]);

    let resizeHandler: (() => void) | undefined;
    const stopFail = watchMaximized({
        isMaximized: async () => {
            throw new Error("isMaximized failed");
        },
        onResized: (handler) => {
            resizeHandler = handler;
            return () => {
                resizeHandler = undefined;
            };
        },
        setMaximized: (value) => {
            seen.push(value);
        },
        notify: (error) => {
            notified.push(error);
        },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(notified).toHaveLength(1);
    expect(resizeHandler).toBeUndefined();
    stopFail();
});

test("watchMaximized applies the initial maximized state and later resize updates", async () => {
    const seen: boolean[] = [];
    let resizeHandler: (() => void) | undefined;
    const stop = watchMaximized({
        isMaximized: async () => seen.length === 0,
        onResized: (handler) => {
            resizeHandler = handler;
            return () => {
                resizeHandler = undefined;
            };
        },
        setMaximized: (value) => {
            seen.push(value);
        },
        notify: () => {
            throw new Error("should not notify");
        },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([true]);
    resizeHandler?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([true, false]);
    stop();
});

test("watchMaximized ignores a stale isMaximized result", async () => {
    const first = deferred<boolean>();
    const seen: boolean[] = [];
    let resizeHandler: (() => void) | undefined;
    let calls = 0;
    const stop = watchMaximized({
        isMaximized: () => {
            calls += 1;
            if (calls === 1) return first.promise;
            return Promise.resolve(false);
        },
        onResized: (handler) => {
            resizeHandler = handler;
            return () => undefined;
        },
        setMaximized: (value) => {
            seen.push(value);
        },
        notify: () => {
            throw new Error("should not notify");
        },
    });
    await Promise.resolve();
    resizeHandler?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([false]);
    first.resolve(true);
    await first.promise;
    await Promise.resolve();
    expect(seen).toEqual([false]);
    stop();
});

test("watchMaximized swallows a rejecting unlisten", async () => {
    const notified: unknown[] = [];
    const stop = watchMaximized({
        isMaximized: async () => false,
        onResized: () => async () => {
            throw new Error("unlisten failed");
        },
        setMaximized: () => undefined,
        notify: (error) => {
            notified.push(error);
        },
    });
    await Promise.resolve();
    await Promise.resolve();
    stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(notified).toEqual([]);
});

// Tauri's data-tauri-drag-region script sends `internal_toggle_maximize` on a title-bar
// double-click. Without this permission Tauri refuses it silently and double-click does nothing.
test("main capability lets the title-bar drag region toggle maximize", () => {
    const capability = JSON.parse(capabilityText) as { windows: string[]; permissions: string[] };
    expect(capability.windows).toContain("main");
    expect(capability.permissions).toContain("core:window:allow-internal-toggle-maximize");
});
