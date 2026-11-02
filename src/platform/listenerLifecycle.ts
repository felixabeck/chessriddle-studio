export type NativeListenerLifecycle = {
    isStopped: () => boolean;
    fail: (error: unknown) => void;
    stop: () => void;
    listen: (subscribe: () => Promise<() => void> | (() => void)) => void;
};

function quietUnlisten(fn: (() => void) | undefined): void {
    if (!fn) return;
    try {
        void Promise.resolve(fn()).catch(() => undefined);
    } catch {
        // Unlisten is best-effort after stop or a failed registration.
    }
}

/**
 * Subscribe a native listener: unlisten if stopped before the subscribe promise
 * settles, unlisten best-effort on stop, and report a subscribe failure once
 * unless already stopped.
 */
export function createNativeListenerLifecycle(options: {
    onFailure: (error: unknown) => void;
    stopOnFailure?: boolean;
}): NativeListenerLifecycle {
    let stopped = false;
    let notified = false;
    let unlisten: (() => void) | undefined;

    const stop = () => {
        stopped = true;
        quietUnlisten(unlisten);
        unlisten = undefined;
    };

    const fail = (error: unknown) => {
        if (stopped) return;
        if (!notified) {
            notified = true;
            options.onFailure(error);
        }
        if (options.stopOnFailure) stop();
    };

    return {
        isStopped: () => stopped,
        fail,
        stop,
        listen: (subscribe) => {
            void Promise.resolve(subscribe())
                .then((fn) => {
                    if (stopped) {
                        quietUnlisten(fn);
                        return;
                    }
                    unlisten = fn;
                })
                .catch((error: unknown) => {
                    fail(error);
                });
        },
    };
}
