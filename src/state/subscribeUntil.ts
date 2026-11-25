/** Returns a standard `AbortError` DOMException for cancelled waits. */
export function abortError(): DOMException {
    return new DOMException("Aborted", "AbortError");
}

/**
 * Waits until `read()` returns a defined value from an external subscription, or rejects when
 * `signal` aborts. Checks `signal.aborted` before subscribing so an already-aborted caller never
 * triggers a spurious mount.
 */
export function subscribeUntil<T>(
    signal: AbortSignal,
    subscribe: (check: () => void) => () => void,
    read: () => T | undefined,
): Promise<T> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason ?? abortError());
            return;
        }
        let settled = false;
        let unsubscribe: (() => void) | null = null;
        const cleanup = () => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            unsubscribe?.();
            unsubscribe = null;
        };
        const onAbort = () => {
            cleanup();
            reject(signal.reason ?? abortError());
        };
        const check = () => {
            if (settled) return;
            const value = read();
            if (value === undefined) return;
            cleanup();
            resolve(value);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        const unsub = subscribe(check);
        if (settled) {
            unsub();
            return;
        }
        unsubscribe = unsub;
        check();
    });
}
