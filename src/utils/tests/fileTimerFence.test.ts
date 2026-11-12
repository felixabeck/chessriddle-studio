import { expect, test, vi } from "vitest";
import {
    installedFileTimerFence,
    installFileTimerFence,
    registerFileTimerFence,
    type TimerHost,
} from "./fileTimerFence";

type TimerHandle = ReturnType<TimerHost["setTimeout"]>;

function createHost() {
    let nextHandle = 0;
    const callbacks = new Map<TimerHandle, () => void>();
    const arm = (handler: TimerHandler, _delay?: number, ...args: unknown[]) => {
        const handle = ++nextHandle as unknown as TimerHandle;
        callbacks.set(handle, () => {
            if (typeof handler === "function") handler(...args);
        });
        return handle;
    };
    const setTimeout = vi.fn(arm);
    const setInterval = vi.fn(arm);
    const clearTimeout = vi.fn();
    const clearInterval = vi.fn();
    const host: TimerHost = {
        setTimeout: setTimeout as unknown as TimerHost["setTimeout"],
        setInterval: setInterval as unknown as TimerHost["setInterval"],
        clearTimeout,
        clearInterval,
    };

    return {
        host,
        setTimeout,
        setInterval,
        clearTimeout,
        clearInterval,
        fire(handle: TimerHandle) {
            const callback = callbacks.get(handle);
            if (!callback) throw new Error("Unknown timer handle");
            callback();
        },
    };
}

test("registration opens the fence and registers one hook that clears and suppresses pending timers", () => {
    const timers = createHost();
    const afterAll = vi.fn<(hook: () => void) => void>();
    expect(installedFileTimerFence(timers.host)).toBeUndefined();
    const fence = registerFileTimerFence(timers.host, afterAll);
    expect(installedFileTimerFence(timers.host)).toBe(fence);
    const handler = vi.fn();
    const fired = timers.host.setTimeout(handler, 0);

    timers.fire(fired);
    expect(handler).toHaveBeenCalledOnce();
    const pending = [timers.host.setTimeout(handler, 10), timers.host.setInterval(handler, 20)];
    expect(afterAll).toHaveBeenCalledOnce();
    afterAll.mock.calls[0][0]();

    expect(timers.clearTimeout).toHaveBeenCalledTimes(pending.length);
    for (const handle of pending) {
        expect(timers.clearTimeout).toHaveBeenCalledWith(handle);
        timers.fire(handle);
    }
    expect(handler).toHaveBeenCalledOnce();
});

test("setup installs and opens the real global timer fence", async () => {
    expect(installedFileTimerFence(globalThis)).toBeDefined();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
});

test("an open file's timeout forwards arguments and leaves tracking after firing", () => {
    const timers = createHost();
    const fence = installFileTimerFence(timers.host);
    fence.open();
    const handler = vi.fn();
    const argument = { value: 42 };
    const handle = timers.host.setTimeout(handler, 10, "forwarded", argument);

    expect(handle).toBe(timers.setTimeout.mock.results[0].value);
    timers.fire(handle);
    expect(handler).toHaveBeenCalledExactlyOnceWith("forwarded", argument);
    fence.close();
    expect(timers.clearTimeout).not.toHaveBeenCalled();
});

test("close clears all pending timeouts and intervals and suppresses their callbacks", () => {
    const timers = createHost();
    const fence = installFileTimerFence(timers.host);
    fence.open();
    const handler = vi.fn();
    const handles = [
        timers.host.setTimeout(handler, 10),
        timers.host.setTimeout(handler, 20),
        timers.host.setInterval(handler, 30),
    ];

    fence.close();
    expect(timers.clearTimeout).toHaveBeenCalledTimes(handles.length);
    for (const handle of handles) {
        expect(timers.clearTimeout).toHaveBeenCalledWith(handle);
        timers.fire(handle);
    }
    expect(handler).not.toHaveBeenCalled();
    fence.close();
    expect(timers.clearTimeout).toHaveBeenCalledTimes(handles.length);
});

test("a timeout armed after close still arms a real timer but cannot run its handler", () => {
    const timers = createHost();
    const fence = installFileTimerFence(timers.host);
    fence.open();
    fence.close();
    const handler = vi.fn();
    const handle = timers.host.setTimeout(handler, 10);

    expect(timers.setTimeout).toHaveBeenCalledOnce();
    expect(handle).toBe(timers.setTimeout.mock.results[0].value);
    timers.fire(handle);
    expect(handler).not.toHaveBeenCalled();
});

test("a timeout from a previous file cannot run during the next file", () => {
    const timers = createHost();
    const fence = installFileTimerFence(timers.host);
    fence.open();
    const handler = vi.fn();
    const handle = timers.host.setTimeout(handler, 10);
    fence.close();
    fence.open();

    timers.fire(handle);
    expect(handler).not.toHaveBeenCalled();
});

test("an interval repeats until clearInterval removes it from tracking", () => {
    const timers = createHost();
    const fence = installFileTimerFence(timers.host);
    fence.open();
    const handler = vi.fn();
    const handle = timers.host.setInterval(handler, 10, "interval argument");

    timers.fire(handle);
    timers.fire(handle);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenLastCalledWith("interval argument");
    timers.host.clearInterval(handle);
    expect(timers.clearInterval).toHaveBeenCalledExactlyOnceWith(handle);
    fence.close();
    expect(timers.clearTimeout).not.toHaveBeenCalled();
    expect(timers.clearInterval).toHaveBeenCalledOnce();
    timers.fire(handle);
    expect(handler).toHaveBeenCalledTimes(2);
});

test("installing twice reuses the same fence and timer wrappers", () => {
    const timers = createHost();
    const originalSetTimeout = timers.host.setTimeout;
    const fence = installFileTimerFence(timers.host);
    const wrapped = { ...timers.host };

    expect(timers.host.setTimeout).not.toBe(originalSetTimeout);
    expect(installFileTimerFence(timers.host)).toBe(fence);
    expect(timers.host).toEqual(wrapped);
    expect(timers.host.setTimeout).toBe(wrapped.setTimeout);
});

test("both timer wrappers retain the original promisify.custom symbol", () => {
    const timers = createHost();
    const custom = Symbol.for("nodejs.util.promisify.custom");
    const timeoutCustom = vi.fn();
    const intervalCustom = vi.fn();
    Object.defineProperty(timers.host.setTimeout, custom, { value: timeoutCustom });
    Object.defineProperty(timers.host.setInterval, custom, { value: intervalCustom });

    installFileTimerFence(timers.host);
    expect(Reflect.get(timers.host.setTimeout, custom)).toBe(timeoutCustom);
    expect(Reflect.get(timers.host.setInterval, custom)).toBe(intervalCustom);
});

test("clearTimeout removes a pending timeout from tracking", () => {
    const timers = createHost();
    const fence = installFileTimerFence(timers.host);
    fence.open();
    const handle = timers.host.setTimeout(vi.fn(), 10);

    timers.host.clearTimeout(handle);
    fence.close();
    expect(timers.clearTimeout).toHaveBeenCalledExactlyOnceWith(handle);
});

test("non-function handlers pass through to the original timer functions", () => {
    const timers = createHost();
    const fence = installFileTimerFence(timers.host);
    fence.open();

    // Browser-compatible hosts can accept strings even when Node's overloads do not.
    const armTimeout = timers.host.setTimeout as (
        handler: TimerHandler,
        delay: number,
        ...args: unknown[]
    ) => TimerHandle;
    const armInterval = timers.host.setInterval as typeof armTimeout;
    armTimeout("timeout source", 10, "timeout argument");
    armInterval("interval source", 20, "interval argument");

    expect(timers.setTimeout).toHaveBeenCalledExactlyOnceWith(
        "timeout source",
        10,
        "timeout argument",
    );
    expect(timers.setInterval).toHaveBeenCalledExactlyOnceWith(
        "interval source",
        20,
        "interval argument",
    );
    fence.close();
    expect(timers.clearTimeout).not.toHaveBeenCalled();
});
