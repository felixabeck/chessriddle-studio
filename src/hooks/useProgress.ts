import { useCallback, useEffect, useRef, useState } from "react";
import type { ProgressItem } from "@/bindings";
import { notifyListenerError } from "@/components/files/notifyError";
import { tauri, tauriSubscriptions } from "@/platform/tauri";
import { useTauriListener } from "@/platform/useTauriListener";

const NOOP_UNLISTEN = () => undefined;
const noopSubscribe = () => Promise.resolve(NOOP_UNLISTEN);

function newestProgress(
    current: ProgressItem | null,
    incoming: ProgressItem,
    minimumGeneration: bigint,
): ProgressItem | null {
    if (incoming.generation < minimumGeneration) {
        return current;
    }
    if (!current || incoming.generation > current.generation) {
        return incoming;
    }
    if (incoming.generation < current.generation) {
        return current;
    }
    if (current.finished && !incoming.finished) {
        return current;
    }
    if (incoming.finished && !current.finished) {
        return incoming;
    }
    if (incoming.progress > current.progress) {
        return incoming;
    }
    if (incoming.progress < current.progress) {
        return current;
    }
    const currentCount = current.count ?? null;
    const incomingCount = incoming.count ?? null;
    if (currentCount !== null && (incomingCount === null || incomingCount < currentCount)) {
        return current;
    }
    return incoming;
}

export function useProgress(id: string | null | undefined) {
    const activeId = id ?? null;
    const [item, setItem] = useState<ProgressItem | null>(null);
    const [listenerSettled, setListenerSettled] = useState<boolean | null>(null);
    const minimumGeneration = useRef<bigint>(BigInt(0));
    const currentId = useRef<string | null>(activeId);
    currentId.current = activeId;

    useEffect(() => {
        let active = true;
        minimumGeneration.current = BigInt(0);
        setItem(null);
        if (activeId === null) {
            setListenerSettled(null);
            return () => undefined;
        }
        if (listenerSettled === null) return () => undefined;
        tauri
            .getProgress(activeId)
            .then((result) => {
                if (active && result) {
                    setItem((current) =>
                        newestProgress(current, result, minimumGeneration.current),
                    );
                }
            })
            .catch((error) => {
                if (active) notifyListenerError(error);
            });
        return () => {
            active = false;
        };
    }, [activeId, listenerSettled]);

    const handleSettled = useCallback((registered: boolean) => {
        if (currentId.current !== null) setListenerSettled(registered);
    }, []);

    useTauriListener(
        activeId !== null ? tauriSubscriptions.progress : noopSubscribe,
        ({ payload }) => {
            if (activeId !== null && payload.id === activeId) {
                if (payload.cleared) {
                    minimumGeneration.current =
                        minimumGeneration.current > payload.generation
                            ? minimumGeneration.current
                            : payload.generation;
                    setItem((current) =>
                        current && current.generation >= payload.generation ? current : null,
                    );
                    return;
                }
                setItem((current) => newestProgress(current, payload, minimumGeneration.current));
            }
        },
        { onError: notifyListenerError, onSettled: handleSettled },
    );

    /**
     * Hides everything below `generation`, or - with `null`, when a cancellation could not report
     * one - everything up to and including what is displayed. A later job's items stay visible,
     * because the progress clock only moves forward.
     */
    const fence = useCallback((generation: bigint | null) => {
        setItem((current) => {
            const floor = generation ?? (current ? current.generation + BigInt(1) : null);
            // u64::MAX + 1 is a local visibility sentinel, never a native lease.
            if (floor === null) return current;
            if (minimumGeneration.current < floor) minimumGeneration.current = floor;
            return current && current.generation < floor ? null : current;
        });
    }, []);

    const clear = useCallback(async () => {
        if (activeId === null) return;
        const clearingId = activeId;
        const generation = await tauri.clearProgress(clearingId);
        if (currentId.current === clearingId) fence(generation);
    }, [activeId, fence]);

    return {
        progress: item?.progress ?? 0,
        finished: item?.finished ?? false,
        isActive: item !== null && !item.finished,
        clear,
        fence,
        item,
    };
}
