import type {
    FileWorkspaceHandle,
    LibrarySyncError,
    LibrarySyncSnapshot,
    LibrarySyncTurnOffMode,
} from "@/bindings";
import { LibrarySyncCommandError } from "@/platform/chessriddle";
import { createNativeListenerLifecycle } from "@/platform/listenerLifecycle";
import { tauri, tauriSubscriptions } from "@/platform/tauri";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { useCallback, useEffect, useRef, useState } from "react";

export type UseLibrarySyncResult = {
    snapshot: LibrarySyncSnapshot | null;
    loading: boolean;
    busy: boolean;
    error: LibrarySyncError | null;
    refresh: () => Promise<void>;
    turnOn: (deselected: FileWorkspaceHandle[]) => Promise<void>;
    turnOff: (mode: LibrarySyncTurnOffMode) => Promise<void>;
    setFileSelected: (file: FileWorkspaceHandle, selected: boolean) => Promise<void>;
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
    const workspaceKey = workspace ? fileWorkspaceKey(workspace) : null;
    const [snapshot, setSnapshot] = useState<LibrarySyncSnapshot | null>(null);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<LibrarySyncError | null>(null);

    const activeWorkspaceKeyRef = useRef<string | null>(workspaceKey);
    const revisionWatermarkRef = useRef<number>(0);

    const applySnapshot = useCallback((incoming: LibrarySyncSnapshot) => {
        const incomingKey = fileWorkspaceKey(incoming.workspace);
        if (incomingKey !== activeWorkspaceKeyRef.current) return;
        if (incoming.revision < revisionWatermarkRef.current) return;
        revisionWatermarkRef.current = incoming.revision;
        setSnapshot(incoming);
        setError(null);
    }, []);

    const fetchSnapshot = useCallback(
        async (target: FileWorkspaceHandle, targetKey: string) => {
            try {
                const next = await tauri.librarySyncSnapshot(target);
                if (activeWorkspaceKeyRef.current !== targetKey) return;
                applySnapshot(next);
            } catch (cause) {
                if (activeWorkspaceKeyRef.current !== targetKey) return;
                setError(toSyncError(cause));
            } finally {
                if (activeWorkspaceKeyRef.current === targetKey) {
                    setLoading(false);
                }
            }
        },
        [applySnapshot],
    );

    useEffect(() => {
        activeWorkspaceKeyRef.current = workspaceKey;
        revisionWatermarkRef.current = 0;
        setSnapshot(null);
        setBusy(false);
        setError(null);

        if (!workspace || !workspaceKey) {
            setLoading(false);
            return;
        }

        setLoading(true);
        const lifecycle = createNativeListenerLifecycle({
            onFailure: (cause) => {
                if (activeWorkspaceKeyRef.current !== workspaceKey) return;
                setError(toSyncError(cause));
                setLoading(false);
            },
        });

        const triggerFetch = () => {
            if (lifecycle.isStopped() || activeWorkspaceKeyRef.current !== workspaceKey) return;
            void fetchSnapshot(workspace, workspaceKey);
        };

        lifecycle.attach(() =>
            tauriSubscriptions
                .librarySyncChanged((event) => {
                    if (lifecycle.isStopped() || activeWorkspaceKeyRef.current !== workspaceKey) {
                        return;
                    }
                    if (event.payload.revision <= revisionWatermarkRef.current) return;
                    triggerFetch();
                })
                .then((unlisten) => {
                    if (!lifecycle.isStopped()) {
                        triggerFetch();
                    }
                    return unlisten;
                }),
        );

        return () => {
            lifecycle.stop();
        };
    }, [workspace, workspaceKey, fetchSnapshot]);

    const runAction = useCallback(
        async (action: (target: FileWorkspaceHandle) => Promise<LibrarySyncSnapshot>) => {
            if (!workspace || !workspaceKey) return;
            const targetKey = workspaceKey;
            setBusy(true);
            try {
                const next = await action(workspace);
                if (activeWorkspaceKeyRef.current !== targetKey) return;
                applySnapshot(next);
            } catch (cause) {
                if (activeWorkspaceKeyRef.current !== targetKey) return;
                setError(toSyncError(cause));
            } finally {
                if (activeWorkspaceKeyRef.current === targetKey) {
                    setBusy(false);
                }
            }
        },
        [workspace, workspaceKey, applySnapshot],
    );

    const refresh = useCallback(async () => {
        if (!workspace || !workspaceKey) return;
        await fetchSnapshot(workspace, workspaceKey);
    }, [workspace, workspaceKey, fetchSnapshot]);

    const turnOn = useCallback(
        (deselected: FileWorkspaceHandle[]) =>
            runAction((target) => tauri.librarySyncTurnOn(target, deselected)),
        [runAction],
    );

    const turnOff = useCallback(
        (mode: LibrarySyncTurnOffMode) =>
            runAction((target) => tauri.librarySyncTurnOff(target, mode)),
        [runAction],
    );

    const setFileSelected = useCallback(
        (file: FileWorkspaceHandle, selected: boolean) =>
            runAction((target) => tauri.librarySyncSetFileSelected(target, file, selected)),
        [runAction],
    );

    const syncNow = useCallback(
        () => runAction((target) => tauri.librarySyncNow(target)),
        [runAction],
    );

    return {
        snapshot,
        loading,
        busy,
        error,
        refresh,
        turnOn,
        turnOff,
        setFileSelected,
        syncNow,
    };
}
