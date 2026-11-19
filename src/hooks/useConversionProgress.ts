import { useCallback } from "react";
import { useSetAtom } from "jotai";
import type { ConvertProgress } from "@/bindings";
import { notifyListenerError } from "@/components/files/notifyError";
import { tauriSubscriptions } from "@/platform/tauri";
import { useTauriListener } from "@/platform/useTauriListener";
import { databaseConversionStateAtom } from "@/state/atoms";

/**
 * Keeps the live import counters on the databases page fed while a PGN
 * conversion runs.
 *
 * This is mounted application-wide rather than on the databases route: an import
 * keeps running while the user navigates away, and the counters have to be
 * correct when they come back. A frame updates only its own live operation id;
 * unknown or retired ids never create an entry. The owning route still writes
 * the target database and title and removes its entry when it settles.
 */
export function useConversionProgress() {
    const setConversionState = useSetAtom(databaseConversionStateAtom);

    const subscribe = useCallback(
        (listener: (event: { payload: ConvertProgress }) => void) =>
            tauriSubscriptions.convertProgress(listener),
        [],
    );

    useTauriListener(
        subscribe,
        ({ payload }) => {
            setConversionState((previous) => {
                if (!previous.some((entry) => entry.id === payload.id)) {
                    return previous;
                }
                return previous.map((entry) =>
                    entry.id === payload.id
                        ? {
                              ...entry,
                              totalGames: payload.imported_games,
                              elapsedSeconds: payload.elapsed_ms / 1000,
                              sourceFileName: payload.source_file_name ?? entry.sourceFileName,
                          }
                        : entry,
                );
            });
        },
        { onError: notifyListenerError },
    );
}
