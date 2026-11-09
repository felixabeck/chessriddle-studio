import { useStore } from "jotai";
import { useEffect, useRef, useState } from "react";
import { deckAtomFamily } from "@/state/atoms";
import type { PracticeDeckValue } from "@/state/practiceStorage";
import { getStats } from "@/components/files/opening";
import { useDueBoundaryRerender } from "@/components/panels/practice/useDueBoundaryRerender";
import type { LibraryRow } from "./libraryData";

// Per mounted hook instance, at most four initial deck subscriptions hydrate at once.
// Settled subscriptions stay live. Native loads can overlap across remounts without cancellation.
export const LIBRARY_DECK_CONCURRENCY = 4;
type FileRow = Extract<LibraryRow, { kind: "file" }>;

export function libraryRepertoires(rows: readonly LibraryRow[]): FileRow[] {
    return rows.filter(
        (row): row is FileRow =>
            row.kind === "file" &&
            ("metadata" in row.file ? row.file.metadata.type : row.file.type) === "repertoire",
    );
}

export function projectLibraryDueCounts(
    repertoires: readonly FileRow[],
    decks: ReadonlyMap<string, PracticeDeckValue>,
) {
    const rows = repertoires.map((file) => {
        const deck = decks.get(file.key);
        const failed =
            !!deck &&
            (deck.status === "read-failed" || deck.status === "write-blocked" || !!deck.error);
        const stats =
            deck && !failed && (deck.status === "ready" || deck.status === "write-pending")
                ? getStats(deck.positions)
                : null;
        return { file, count: stats?.due ?? null, nextDue: stats?.nextDue ?? null, failed };
    });
    return {
        rows,
        dueRows: rows.filter((row) => row.failed || (row.count ?? 0) > 0),
        total: rows.reduce((sum, row) => sum + (row.count ?? 0), 0),
        incomplete: rows.some((row) => row.count === null),
        nextDue: rows.reduce<Date | null>(
            (earliest, row) =>
                row.nextDue && (!earliest || row.nextDue < earliest) ? row.nextDue : earliest,
            null,
        ),
    };
}

/** Each effect owns its queue, subscriptions and deliveries, including StrictMode replay. */
export function useLibraryDueCounts(libraryRows: readonly LibraryRow[]) {
    const store = useStore();
    const repertoires = libraryRepertoires(libraryRows);
    const identity = JSON.stringify(repertoires.map((row) => row.key).sort());
    const inputs = useRef(repertoires);
    inputs.current = repertoires;
    const [state, setState] = useState<{
        identity: string;
        decks: Map<string, PracticeDeckValue>;
    }>();
    useEffect(() => {
        const controller = new AbortController();
        const queue = [...inputs.current];
        const decks = new Map<string, PracticeDeckValue>();
        const cleanups: (() => void)[] = [];
        let hydrating = 0;
        const publish = () => {
            if (!controller.signal.aborted) setState({ identity, decks: new Map(decks) });
        };
        const pump = () => {
            while (
                !controller.signal.aborted &&
                hydrating < LIBRARY_DECK_CONCURRENCY &&
                queue.length
            ) {
                const row = queue.shift()!;
                const deck = deckAtomFamily({ file: row.key, game: 0 });
                let pending = true;
                hydrating++;
                const read = () => {
                    if (controller.signal.aborted) return;
                    const value = store.get(deck);
                    decks.set(row.key, value);
                    if (pending && value.status !== "loading") {
                        pending = false;
                        hydrating--;
                        queueMicrotask(pump);
                    }
                    publish();
                };
                cleanups.push(store.sub(deck, read));
                read();
            }
        };
        pump();
        publish();
        return () => {
            controller.abort();
            queue.length = 0;
            cleanups.forEach((cleanup) => cleanup());
        };
    }, [store, identity]);
    const result = projectLibraryDueCounts(
        repertoires,
        state?.identity === identity ? state.decks : new Map(),
    );
    useDueBoundaryRerender(result.nextDue, identity);
    return result;
}
