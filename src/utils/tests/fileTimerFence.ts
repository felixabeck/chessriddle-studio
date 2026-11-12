// Node timers outlive jsdom teardown, so fence them to their test file (f-20261112-93).
export type TimerHost = Pick<
    typeof globalThis,
    "setTimeout" | "setInterval" | "clearTimeout" | "clearInterval"
>;

export interface FileTimerFence {
    open(): void;
    close(): void;
}

const fenceKey = Symbol.for("chessfable.fileTimerFence");
const promisifyCustom = Symbol.for("nodejs.util.promisify.custom");

export function installFileTimerFence(host: TimerHost): FileTimerFence {
    const fencedHost = host as TimerHost & { [fenceKey]?: FileTimerFence };
    if (fencedHost[fenceKey]) return fencedHost[fenceKey];

    const { setTimeout, setInterval, clearTimeout, clearInterval } = host;
    const handles = new Set<ReturnType<TimerHost["setTimeout"]>>();
    let open = false;
    let token = Symbol();

    function wrapTimer(
        original: TimerHost["setTimeout"],
        interval: boolean,
    ): TimerHost["setTimeout"] {
        const wrapped = ((...parameters: Parameters<TimerHost["setTimeout"]>) => {
            const [handler, delay, ...args] = parameters;
            if (typeof handler !== "function") return original.call(host, ...parameters);

            const armedToken = token;
            const handle = original.call(
                host,
                function (this: unknown, ...callbackArgs: unknown[]) {
                    if (!interval) handles.delete(handle);
                    if (open && armedToken === token) handler.apply(this, callbackArgs);
                },
                delay,
                ...args,
            );
            if (open) handles.add(handle);
            return handle;
        }) as TimerHost["setTimeout"];

        const descriptor = Object.getOwnPropertyDescriptor(original, promisifyCustom);
        if (descriptor) Object.defineProperty(wrapped, promisifyCustom, descriptor);
        return wrapped;
    }

    host.setTimeout = wrapTimer(setTimeout, false);
    host.setInterval = wrapTimer(setInterval, true);
    host.clearTimeout = (handle) => {
        handles.delete(handle as ReturnType<TimerHost["setTimeout"]>);
        clearTimeout.call(host, handle);
    };
    host.clearInterval = (handle) => {
        handles.delete(handle as ReturnType<TimerHost["setTimeout"]>);
        clearInterval.call(host, handle);
    };

    const fence: FileTimerFence = {
        open() {
            token = Symbol();
            open = true;
        },
        close() {
            open = false;
            token = Symbol();
            for (const handle of handles) clearTimeout.call(host, handle);
            handles.clear();
        },
    };
    fencedHost[fenceKey] = fence;
    return fence;
}
