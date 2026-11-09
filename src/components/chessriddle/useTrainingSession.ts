import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { chessRiddleTrainingSessions as sessions } from "@/state/chessRiddleTraining";

export function useTrainingSession(id: string, retryFailedAvailabilityOnMount = false) {
    const retryOnMount = useRef(retryFailedAvailabilityOnMount);
    retryOnMount.current = retryFailedAvailabilityOnMount;
    const subscribe = useCallback((listener: () => void) => sessions.subscribe(id, listener), [id]);
    const snapshot = useCallback(() => sessions.ensure(id), [id]);
    const session = useSyncExternalStore(subscribe, snapshot);
    useEffect(() => {
        const state = sessions.get(id);
        if (
            state?.available === null &&
            (state.failedOperation !== "availability" || retryOnMount.current)
        )
            void sessions.available(id);
    }, [id]);
    return session;
}
