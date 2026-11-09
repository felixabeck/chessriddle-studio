import { useCallback, useEffect, useRef, useState } from "react";

/** One admitted async action at a time: pending state for dialogs and pickers, no state writes after unmount. */
export function useSingleFlight() {
    const [pending, setPending] = useState(false);
    const flight = useRef(false);
    const mounted = useRef(true);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const isMounted = useCallback(() => mounted.current, []);
    const run = useCallback(async (operation: () => Promise<void>): Promise<void> => {
        if (flight.current) return;
        flight.current = true;
        setPending(true);
        try {
            await operation();
        } finally {
            flight.current = false;
            if (mounted.current) setPending(false);
        }
    }, []);

    return { pending, run, isMounted };
}
