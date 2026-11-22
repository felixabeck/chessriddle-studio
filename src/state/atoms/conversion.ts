/** In-flight database conversions and their cancellable runner. */
import { atom } from "jotai";
import type { DatabaseHandle } from "@/bindings";
import { cancellationError, tauri, withConversionTicket } from "@/platform/tauri";

export type DatabaseConversionEntry = {
    id: string;
    totalGames: number;
    elapsedSeconds: number;
    targetDatabase: DatabaseHandle | null;
    targetDatabaseTitle: string | null;
    sourceFileName: string | null;
    cancel?: () => Promise<void>;
    cancelPending?: boolean;
};

export type DatabaseConversionOperation = {
    id: string;
    ticket: string | null;
    throwIfCancelled: () => void;
    setTarget: (handle: DatabaseHandle) => void;
};

/** In-memory only: one entry per in-flight conversion, removed by its owning route; never persisted or restored. */
export const databaseConversionStateAtom = atom<DatabaseConversionEntry[]>([]);
/** A failed post-import reload keeps the library's existing retry action available across navigation. */
export const databaseConversionRefreshFailedAtom = atom(false);

/** Retains one entry per active owner, in start order, until that owner's work settles. */
export async function runDatabaseConversion<T>(
    setState: (update: (previous: DatabaseConversionEntry[]) => DatabaseConversionEntry[]) => void,
    target: Pick<
        DatabaseConversionEntry,
        "targetDatabase" | "targetDatabaseTitle" | "sourceFileName"
    >,
    run: (operation: DatabaseConversionOperation) => Promise<T>,
    local?: { onCancelError: (cause: unknown) => void },
): Promise<T> {
    const id = `conversion:${crypto.randomUUID()}`;
    let live = true;
    let ticket: string | null = null;
    let cancelRequested = false;
    let pending: Promise<void> | undefined;
    const updatePending = (cancelPending: boolean) =>
        setState((previous) =>
            previous.map((entry) => (entry.id === id ? { ...entry, cancelPending } : entry)),
        );
    const cancel = (): Promise<void> => {
        if (!live) return Promise.resolve();
        if (pending) return pending;
        cancelRequested = true;
        if (!ticket) return Promise.resolve();
        updatePending(true);
        pending = (async () => {
            try {
                await tauri.cancelConversion(ticket);
            } catch (cause) {
                cancelRequested = false;
                local?.onCancelError(cause);
            } finally {
                pending = undefined;
                if (live) updatePending(false);
            }
        })();
        return pending;
    };
    setState((previous) => [
        ...previous,
        {
            ...target,
            id,
            totalGames: 0,
            elapsedSeconds: 0,
            ...(local ? { cancel, cancelPending: false } : {}),
        },
    ]);
    try {
        const execute = async (preparedTicket: string | null) => {
            ticket = preparedTicket;
            if (local && cancelRequested) throw cancellationError();
            return run({
                id,
                ticket,
                throwIfCancelled: () => {
                    if (local && cancelRequested) throw cancellationError();
                },
                setTarget: (handle) => {
                    setState((previous) =>
                        previous.some((entry) => entry.id === id)
                            ? previous.map((entry) =>
                                  entry.id === id ? { ...entry, targetDatabase: handle } : entry,
                              )
                            : previous,
                    );
                },
            });
        };
        return await (local ? withConversionTicket(execute) : execute(null));
    } finally {
        if (pending) await pending;
        live = false;
        setState((previous) =>
            previous.some((entry) => entry.id === id)
                ? previous.filter((entry) => entry.id !== id)
                : previous,
        );
    }
}
