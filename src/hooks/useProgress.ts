import { useCallback, useEffect, useRef, useState } from "react";
import type { ProgressItem } from "@/bindings";
import { notifyListenerError } from "@/components/files/notifyError";
import { tauri, tauriSubscriptions } from "@/platform/tauri";
import { useTauriListener } from "@/platform/useTauriListener";

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
    return incoming.progress >= current.progress ? incoming : current;
}

export function useProgress(id: string) {
    const [item, setItem] = useState<ProgressItem | null>(null);
    const [listenerSettled, setListenerSettled] = useState<boolean | null>(null);
    const minimumGeneration = useRef<bigint>(BigInt(0));
    const currentId = useRef(id);
    currentId.current = id;

    useEffect(() => {
        let active = true;
        minimumGeneration.current = BigInt(0);
        setItem(null);
        if (listenerSettled === null) return () => undefined;
        tauri
            .getProgress(id)
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
    }, [id, listenerSettled]);

    useTauriListener(
        tauriSubscriptions.progress,
        ({ payload }) => {
            if (payload.id === id) {
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
        { onError: notifyListenerError, onSettled: setListenerSettled },
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
        const clearingId = id;
        const generation = await tauri.clearProgress(id);
        if (currentId.current === clearingId) fence(generation);
    }, [fence, id]);

    return {
        progress: item?.progress ?? 0,
        finished: item?.finished ?? false,
        isActive: item !== null && !item.finished,
        clear,
        fence,
        item,
    };
}
