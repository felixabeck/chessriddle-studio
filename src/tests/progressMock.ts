import { useEffect, useState } from "react";
import type { ProgressItem } from "@/bindings";

/**
 * Reactive test double for `useProgress` that returns the configured item only when the
 * subscribed id matches `item.id`.
 */
export function createProgressMock() {
    let currentItem: ProgressItem | null = null;
    const listeners = new Set<() => void>();

    return {
        reset() {
            currentItem = null;
        },
        setItem(item: ProgressItem | null) {
            currentItem = item;
            for (const notify of listeners) notify();
        },
        useProgress(id: string | null | undefined) {
            const [, setTick] = useState(0);
            useEffect(() => {
                const notify = () => setTick((t) => t + 1);
                listeners.add(notify);
                return () => {
                    listeners.delete(notify);
                };
            }, []);
            const matched =
                id != null && currentItem !== null && currentItem.id === id ? currentItem : null;
            return {
                progress: matched?.progress ?? 0,
                finished: matched?.finished ?? false,
                isActive: matched !== null && !matched.finished,
                clear: async () => undefined,
                fence: () => undefined,
                item: matched,
            };
        },
    };
}
