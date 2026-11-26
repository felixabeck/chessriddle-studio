import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Manages the `AbortController` lifecycle for a dialog action that can be cancelled via a
 * Cancel button, dialog close (`opened === false`), or unmount.
 */
export function useAbortableAction(opened: boolean) {
    const [canCancel, setCanCancel] = useState(false);
    const abortRef = useRef<AbortController | null>(null);
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            abortRef.current?.abort();
        };
    }, []);

    useEffect(() => {
        if (!opened) {
            abortRef.current?.abort();
        }
    }, [opened]);

    const isMounted = useCallback(() => mountedRef.current, []);

    const abort = useCallback(() => {
        abortRef.current?.abort();
    }, []);

    const runAbortable = useCallback(
        async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
            abortRef.current?.abort();
            const controller = new AbortController();
            abortRef.current = controller;
            if (mountedRef.current) setCanCancel(true);
            try {
                return await operation(controller.signal);
            } finally {
                if (abortRef.current === controller) {
                    abortRef.current = null;
                    if (mountedRef.current) setCanCancel(false);
                }
            }
        },
        [],
    );

    return { canCancel, abort, isMounted, runAbortable };
}
