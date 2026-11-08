import { useEffect, useState } from "react";

// Platform setTimeout maximum. Longer delays re-arm after firing.
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

export function useDueBoundaryRerender(nextDue: Date | null | undefined, resetKey?: string) {
    const nextDueTime = nextDue?.getTime();
    const [tick, setTick] = useState(0);

    useEffect(() => {
        if (nextDueTime === undefined) return;
        const delay = Math.min(Math.max(nextDueTime - Date.now() + 1, 1), MAX_TIMEOUT_DELAY_MS);
        const timer = setTimeout(() => setTick((value) => value + 1), delay);
        return () => clearTimeout(timer);
    }, [nextDueTime, tick, resetKey]);

    return tick;
}
