import { useCallback, useEffect, useSyncExternalStore } from "react";
import { chessRiddleTrainingSessions as sessions } from "@/state/chessRiddleTraining";

export function useTrainingSession(id: string) {
    const subscribe = useCallback((listener: () => void) => sessions.subscribe(id, listener), [id]);
    const snapshot = useCallback(() => sessions.ensure(id), [id]);
    const session = useSyncExternalStore(subscribe, snapshot);
    useEffect(() => {
        if (sessions.get(id)?.available === null) void sessions.available(id);
    }, [id]);
    return session;
}
