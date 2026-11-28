import type {
    FileWorkspaceHandle,
    LibrarySyncError,
    LibrarySyncHandle,
    LibrarySyncSnapshot,
    LibrarySyncTurnOffMode,
} from "@/bindings";
import { LibrarySyncCommandError } from "@/platform/chessriddle";
import { safeFailureContext, warnSafely } from "@/platform/errors";
import { createNativeListenerLifecycle } from "@/platform/listenerLifecycle";
import { tauri, tauriSubscriptions } from "@/platform/tauri";
import { capabilityKey } from "@/utils/pathCapabilities";
import { useCallback, useEffect, useRef, useState } from "react";

export const LIBRARY_SYNC_RETRY_BACKOFF_MS = [2_000, 10_000, 30_000] as const;

export type UseLibrarySyncResult = {
    snapshot: LibrarySyncSnapshot | null;
    busy: boolean;
    error: LibrarySyncError | null;
    turnOn: (deselected: LibrarySyncHandle[]) => Promise<void>;
    turnOff: (mode: LibrarySyncTurnOffMode) => Promise<void>;
    setFileSelected: (file: LibrarySyncHandle, selected: boolean) => Promise<void>;
    syncNow: () => Promise<void>;
};

function toSyncError(error: unknown): LibrarySyncError {
    return error instanceof LibrarySyncCommandError ? error.code : "unavailable";
}

/**
 * Single renderer adapter for Studio Library sync (S-6).
 * Owns the snapshot, event subscription, and the five commands; persists nothing in the renderer.
 */
export function useLibrarySync(workspace: FileWorkspaceHandle | null): UseLibrarySyncResult {
    const workspaceKey = workspace ? capabilityKey(workspace) : null;
    const workspaceRef = useRef<FileWorkspaceHandle | null>(workspace);
    workspaceRef.current = workspace;

    const [snapshot, setSnapshot] = useState<LibrarySyncSnapshot | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<LibrarySyncError | null>(null);

    const sessionRef = useRef<symbol | null>(null);
    const activeWorkspaceKeyRef = useRef<string | null>(workspaceKey);
    const revisionWatermarkRef = useRef<number>(0);
    const requestSeqRef = useRef<number>(0);
    const settledSeqRef = useRef<number>(0);
    const inFlightActionsRef = useRef<number>(0);
    const hasSnapshotRef = useRef<boolean>(false);
    const retryAttemptRef = useRef<number>(0);
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearRetryTimer = useCallback(() => {
        if (retryTimerRef.current !== null) {
            clearTimeout(retryTimerRef.current);
            retryTimerRef.current = null;
        }
    }, []);

    // Every request takes the next sequence number; a request may apply its outcome
    // (success or failure) only if its number is greater than the last settled number,
    // and applying it records its number as the last settled one.
    const claimSettlement = useCallback(
        (session: symbol, targetKey: string, seq: number): boolean => {
            if (sessionRef.current !== session || activeWorkspaceKeyRef.current !== targetKey) {
                return false;
            }
            if (seq <= settledSeqRef.current) return false;
            settledSeqRef.current = seq;
            return true;
        },
        [],
    );

    const applySnapshot = useCallback(
        (incoming: LibrarySyncSnapshot, session: symbol, targetKey: string, seq: number) => {
            if (capabilityKey(incoming.workspace) !== targetKey) return;
            if (incoming.revision < revisionWatermarkRef.current) return;
            if (!claimSettlement(session, targetKey, seq)) return;
            revisionWatermarkRef.current = incoming.revision;
            hasSnapshotRef.current = true;
            retryAttemptRef.current = 0;
            clearRetryTimer();
            setSnapshot(incoming);
            setError(null);
        },
        [claimSettlement, clearRetryTimer],
    );

    const fetchSnapshot = useCallback(
        async (session: symbol, target: FileWorkspaceHandle, targetKey: string) => {
            const seq = ++requestSeqRef.current;
            try {
                const next = await tauri.librarySyncSnapshot(target);
                applySnapshot(next, session, targetKey, seq);
            } catch (cause) {
                if (!claimSettlement(session, targetKey, seq)) return;
                const code = toSyncError(cause);
                setError(code);
                if (!hasSnapshotRef.current) {
                    warnSafely(
                        `Library sync snapshot failed: ${safeFailureContext(cause).message}`,
                    );
                    const attempt = retryAttemptRef.current;
                    if (
                        attempt < LIBRARY_SYNC_RETRY_BACKOFF_MS.length &&
                        retryTimerRef.current === null
                    ) {
                        retryAttemptRef.current = attempt + 1;
                        retryTimerRef.current = setTimeout(() => {
                            retryTimerRef.current = null;
                            if (
                                sessionRef.current !== session ||
                                activeWorkspaceKeyRef.current !== targetKey
                            ) {
                                return;
                            }
                            const latestTarget = workspaceRef.current;
                            if (!latestTarget || capabilityKey(latestTarget) !== targetKey) return;
                            void fetchSnapshot(session, latestTarget, targetKey);
                        }, LIBRARY_SYNC_RETRY_BACKOFF_MS[attempt]);
                    }
                }
            }
        },
        [applySnapshot, claimSettlement],
    );

    useEffect(() => {
        const session = Symbol("library-sync");
        sessionRef.current = session;
        activeWorkspaceKeyRef.current = workspaceKey;
        revisionWatermarkRef.current = 0;
        requestSeqRef.current = 0;
        settledSeqRef.current = 0;
        inFlightActionsRef.current = 0;
        hasSnapshotRef.current = false;
        retryAttemptRef.current = 0;
        clearRetryTimer();
        setSnapshot(null);
        setBusy(false);
        setError(null);

        const target = workspaceRef.current;
        if (!target || !workspaceKey) {
            return () => {
                if (sessionRef.current === session) sessionRef.current = null;
                clearRetryTimer();
            };
        }

        const triggerFetch = () => {
            if (sessionRef.current !== session || activeWorkspaceKeyRef.current !== workspaceKey)
                return;
            const latestTarget = workspaceRef.current;
            if (!latestTarget || capabilityKey(latestTarget) !== workspaceKey) return;
            void fetchSnapshot(session, latestTarget, workspaceKey);
        };

        const lifecycle = createNativeListenerLifecycle({
            onFailure: (cause) => {
                if (
                    sessionRef.current !== session ||
                    activeWorkspaceKeyRef.current !== workspaceKey
                ) {
                    return;
                }
                const code = toSyncError(cause);
                if (!hasSnapshotRef.current) {
                    warnSafely(
                        `Library sync listener failed: ${safeFailureContext(cause).message}`,
                    );
                }
                setError(code);
                triggerFetch();
            },
        });

        lifecycle.attach(() =>
            tauriSubscriptions
                .librarySyncChanged((event) => {
                    if (
                        lifecycle.isStopped() ||
                        sessionRef.current !== session ||
                        activeWorkspaceKeyRef.current !== workspaceKey
                    ) {
                        return;
                    }
                    if (event.payload.revision <= revisionWatermarkRef.current) return;
                    clearRetryTimer();
                    triggerFetch();
                })
                .then((unlisten) => {
                    if (!lifecycle.isStopped() && sessionRef.current === session) {
                        triggerFetch();
                    }
                    return unlisten;
                }),
        );

        return () => {
            lifecycle.stop();
            if (sessionRef.current === session) sessionRef.current = null;
            clearRetryTimer();
        };
    }, [workspaceKey, fetchSnapshot, clearRetryTimer]);

    const runAction = useCallback(
        async (action: (target: FileWorkspaceHandle) => Promise<LibrarySyncSnapshot>) => {
            const session = sessionRef.current;
            const target = workspaceRef.current;
            if (!session || !target || !workspaceKey) return;
            const targetKey = workspaceKey;
            const seq = ++requestSeqRef.current;
            inFlightActionsRef.current += 1;
            setBusy(true);
            try {
                const next = await action(target);
                applySnapshot(next, session, targetKey, seq);
            } catch (cause) {
                if (!claimSettlement(session, targetKey, seq)) return;
                setError(toSyncError(cause));
            } finally {
                if (sessionRef.current === session && activeWorkspaceKeyRef.current === targetKey) {
                    inFlightActionsRef.current = Math.max(0, inFlightActionsRef.current - 1);
                    setBusy(inFlightActionsRef.current > 0);
                }
            }
        },
        [workspaceKey, applySnapshot, claimSettlement],
    );

    const turnOn = useCallback(
        (deselected: LibrarySyncHandle[]) =>
            runAction((target) => tauri.librarySyncTurnOn(target, deselected)),
        [runAction],
    );

    const turnOff = useCallback(
        (mode: LibrarySyncTurnOffMode) =>
            runAction((target) => tauri.librarySyncTurnOff(target, mode)),
        [runAction],
    );

    const setFileSelected = useCallback(
        (file: LibrarySyncHandle, selected: boolean) =>
            runAction((target) => tauri.librarySyncSetFileSelected(target, file, selected)),
        [runAction],
    );

    const syncNow = useCallback(
        () => runAction((target) => tauri.librarySyncNow(target)),
        [runAction],
    );

    const matchesWorkspace =
        snapshot !== null &&
        workspaceKey !== null &&
        capabilityKey(snapshot.workspace) === workspaceKey;

    return {
        snapshot: matchesWorkspace ? snapshot : null,
        busy: matchesWorkspace || snapshot === null ? busy : false,
        error: matchesWorkspace || snapshot === null ? error : null,
        turnOn,
        turnOff,
        setFileSelected,
        syncNow,
    };
}
