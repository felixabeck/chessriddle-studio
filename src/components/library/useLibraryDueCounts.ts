import { useStore } from "jotai";
import { useEffect, useRef, useState } from "react";
import { deckAtomFamily } from "@/state/atoms";
import {
    ensurePracticeMigration,
    listPracticeDecks,
    type PracticeDeckValue,
} from "@/state/practiceStorage";
import { getStats } from "@/components/files/opening";
import { useDueBoundaryRerender } from "@/components/panels/practice/useDueBoundaryRerender";
import type { LibraryRow } from "./libraryData";

// Per mounted hook instance, at most four deck subscriptions hydrate at once
// across every chapter of every listed repertoire. Settled subscriptions stay
// live. Native loads can overlap across remounts without cancellation. Game 0
// of each repertoire is subscribed on first paint; remaining chapters come from
// the practice inventory, in-memory family params, and live CREATE events. A
// REMOVE of a subscribed identity restarts the effect (chapter deletes renumber
// games).
export const LIBRARY_DECK_CONCURRENCY = 4;
type FileRow = Extract<LibraryRow, { kind: "file" }>;
type InventoryStatus = "pending" | "ready" | "failed";
type ChapterDecks = Map<string, Map<number, PracticeDeckValue>>;

function identityKey(file: string, game: number): string {
    return `${file}\u0000${game}`;
}

function deckFailed(deck: PracticeDeckValue): boolean {
    return deck.status === "read-failed" || deck.status === "write-blocked" || !!deck.error;
}

function deckSettled(deck: PracticeDeckValue): boolean {
    return deck.status === "ready" || deck.status === "write-pending";
}

function copyChapterDecks(decks: ChapterDecks): ChapterDecks {
    const copy: ChapterDecks = new Map();
    for (const [file, chapters] of decks) copy.set(file, new Map(chapters));
    return copy;
}

export function libraryRepertoires(rows: readonly LibraryRow[]): FileRow[] {
    return rows.filter(
        (row): row is FileRow =>
            row.kind === "file" &&
            ("metadata" in row.file ? row.file.metadata.type : row.file.type) === "repertoire",
    );
}

export function projectLibraryDueCounts(
    repertoires: readonly FileRow[],
    decks: ReadonlyMap<string, ReadonlyMap<number, PracticeDeckValue>>,
    inventory: InventoryStatus,
) {
    const rows = repertoires.map((file) => {
        const chapters = decks.get(file.key);
        const values = chapters ? [...chapters.values()] : [];
        const failed = values.some(deckFailed);
        const count =
            !chapters || chapters.size === 0 || failed || values.some((deck) => !deckSettled(deck))
                ? null
                : values.reduce((sum, deck) => sum + getStats(deck.positions).due, 0);
        let nextDue: Date | null = null;
        for (const deck of values) {
            if (!deckSettled(deck) || deckFailed(deck)) continue;
            const due = getStats(deck.positions).nextDue;
            if (due && (!nextDue || due < nextDue)) nextDue = due;
        }
        return { file, count, nextDue, failed };
    });
    return {
        rows,
        dueRows: rows.filter((row) => row.failed || (row.count ?? 0) > 0),
        total: rows.reduce((sum, row) => sum + (row.count ?? 0), 0),
        incomplete: inventory !== "ready" || rows.some((row) => row.count === null),
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
    const [restart, setRestart] = useState(0);
    const [state, setState] = useState<{
        identity: string;
        decks: ChapterDecks;
        inventory: InventoryStatus;
    }>();
    useEffect(() => {
        const controller = new AbortController();
        const repertoireFiles = new Set(inputs.current.map((row) => row.key));
        const queue: { file: string; game: number }[] = [];
        const queued = new Set<string>();
        const subscribed = new Set<string>();
        const decks: ChapterDecks = new Map();
        const cleanups: (() => void)[] = [];
        let hydrating = 0;
        let inventory: InventoryStatus = "pending";
        const publish = () => {
            if (!controller.signal.aborted)
                setState({ identity, decks: copyChapterDecks(decks), inventory });
        };
        const enqueue = (file: string, game: number) => {
            if (!repertoireFiles.has(file)) return;
            const key = identityKey(file, game);
            if (subscribed.has(key) || queued.has(key)) return;
            queued.add(key);
            queue.push({ file, game });
        };
        const pump = () => {
            while (
                !controller.signal.aborted &&
                hydrating < LIBRARY_DECK_CONCURRENCY &&
                queue.length
            ) {
                const item = queue.shift()!;
                const key = identityKey(item.file, item.game);
                queued.delete(key);
                subscribed.add(key);
                const deck = deckAtomFamily({ file: item.file, game: item.game });
                let pending = true;
                hydrating++;
                const read = () => {
                    if (controller.signal.aborted) return;
                    const value = store.get(deck);
                    let chapters = decks.get(item.file);
                    if (!chapters) {
                        chapters = new Map();
                        decks.set(item.file, chapters);
                    }
                    chapters.set(item.game, value);
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
        cleanups.push(
            deckAtomFamily.unstable_listen((event) => {
                if (controller.signal.aborted) return;
                if (event.type === "CREATE") {
                    enqueue(event.param.file, event.param.game);
                    queueMicrotask(pump);
                    return;
                }
                if (
                    event.type === "REMOVE" &&
                    subscribed.has(identityKey(event.param.file, event.param.game))
                ) {
                    setRestart((count) => count + 1);
                }
            }),
        );
        for (const row of inputs.current) enqueue(row.key, 0);
        pump();
        publish();
        void (async () => {
            try {
                await ensurePracticeMigration();
                if (controller.signal.aborted) return;
                const listed = await listPracticeDecks();
                if (controller.signal.aborted) return;
                for (const entry of listed.decks) enqueue(entry.fileId, entry.game);
                for (const anomaly of listed.anomalies) {
                    if (anomaly.fileId != null && anomaly.game != null)
                        enqueue(anomaly.fileId, anomaly.game);
                }
                for (const param of deckAtomFamily.getParams()) enqueue(param.file, param.game);
                inventory = "ready";
            } catch {
                if (controller.signal.aborted) return;
                inventory = "failed";
            }
            pump();
            publish();
        })();
        return () => {
            controller.abort();
            queue.length = 0;
            cleanups.forEach((cleanup) => cleanup());
        };
    }, [store, identity, restart]);
    const result = projectLibraryDueCounts(
        repertoires,
        state?.identity === identity ? state.decks : new Map(),
        state?.identity === identity ? state.inventory : "pending",
    );
    useDueBoundaryRerender(result.nextDue, identity);
    return result;
}
