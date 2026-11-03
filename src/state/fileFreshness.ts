import { useSyncExternalStore } from "react";
import type { FileWorkspaceHandle } from "@/bindings";
import { normalizeError } from "@/platform/errors";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import type { Tab } from "@/utils/tabs";
import type { CollectionDescriptor } from "@/bindings";

type CollectionCheck = {
    read: (signal: AbortSignal) => Promise<CollectionDescriptor | null>;
    rebuild?: (collection: string) => Promise<CollectionDescriptor>;
    receive: (value: CollectionDescriptor | null, error?: unknown) => void;
};
type CollectionCheckEntry = {
    subscribers: Set<CollectionCheck>;
    due: boolean;
    generation: string | null;
    rebuildPending: CollectionDescriptor | null;
};
const collectionChecks = new Map<string, CollectionCheckEntry>();
const collectionFlights = new Map<string, AbortController>();
const collectionRebuilds = new Map<string, Promise<CollectionDescriptor>>();
const COLLECTION_METADATA_CONCURRENCY = 8;
const COLLECTION_REBUILD_CONCURRENCY = 4;
const COLLECTION_CHECK_CAPACITY = 4096;
let collectionReads = 0;

function publishCollection(
    key: string,
    entry: CollectionCheckEntry,
    value: CollectionDescriptor | null,
    error?: unknown,
) {
    if (collectionChecks.get(key) !== entry) return;
    for (const subscriber of entry.subscribers) {
        try {
            subscriber.receive(value, error);
        } catch (cause) {
            console.error("Collection freshness observer failed", normalizeError(cause));
        }
    }
}

function startCollectionRebuilds() {
    for (const [key, entry] of collectionChecks) {
        if (collectionRebuilds.size >= COLLECTION_REBUILD_CONCURRENCY) break;
        const collection = entry.rebuildPending;
        if (!collection || collectionRebuilds.has(key)) continue;
        const owner = [...entry.subscribers].find((subscriber) => subscriber.rebuild);
        if (!owner?.rebuild) continue;
        entry.rebuildPending = null;
        const admitted = entry.generation;
        const job = Promise.resolve().then(() => owner.rebuild!(collection.id));
        collectionRebuilds.set(key, job);
        void job
            .then(
                (current) => {
                    if (entry.generation === admitted || entry.generation === current.generation) {
                        entry.generation = current.generation;
                        entry.rebuildPending = current.status === "stale" ? current : null;
                        publishCollection(key, entry, current);
                    }
                },
                (error) => {
                    if (entry.generation === admitted) publishCollection(key, entry, null, error);
                },
            )
            .finally(() => {
                if (collectionRebuilds.get(key) === job) collectionRebuilds.delete(key);
                startCollectionRebuilds();
            });
    }
}

function checkActiveCollections(markDue = false) {
    if (markDue) for (const entry of collectionChecks.values()) entry.due = true;
    for (const [key, entry] of collectionChecks) {
        if (collectionReads >= COLLECTION_METADATA_CONCURRENCY) break;
        if (collectionFlights.has(key) || !entry.due) continue;
        const owner = entry.subscribers.values().next().value as CollectionCheck | undefined;
        if (!owner) continue;
        const flight = new AbortController();
        collectionFlights.set(key, flight);
        // Move admitted checks behind those still waiting, including when clocks mark them due.
        collectionChecks.delete(key);
        collectionChecks.set(key, entry);
        entry.due = false;
        collectionReads += 1;
        const deadline = setTimeout(() => {
            flight.abort();
            publishCollection(
                key,
                entry,
                null,
                new Error("Collection freshness check exceeded its deadline"),
            );
        }, FILE_REVISION_DEADLINE_MS);
        void Promise.resolve()
            .then(() => owner.read(flight.signal))
            .then(
                (value) => {
                    if (flight.signal.aborted) return;
                    entry.generation = value?.generation ?? null;
                    entry.rebuildPending = value?.status === "stale" ? value : null;
                    publishCollection(key, entry, value);
                    startCollectionRebuilds();
                },
                (error) => {
                    if (!flight.signal.aborted) publishCollection(key, entry, null, error);
                },
            )
            .finally(() => {
                clearTimeout(deadline);
                if (collectionFlights.get(key) === flight) collectionFlights.delete(key);
                collectionReads -= 1;
                checkActiveCollections();
            });
    }
}

/** Uses the root freshness clock, bounded metadata reads and native-owned rebuild operations. */
export function registerCollectionCheck(key: string, check: CollectionCheck): () => void {
    let entry = collectionChecks.get(key);
    if (!entry) {
        if (collectionChecks.size >= COLLECTION_CHECK_CAPACITY) {
            check.receive(null, new Error("Too many active collection checks"));
            return () => undefined;
        }
        entry = {
            subscribers: new Set(),
            due: true,
            generation: null,
            rebuildPending: null,
        };
        collectionChecks.set(key, entry);
    }
    entry.subscribers.add(check);
    entry.due = true;
    queueMicrotask(checkActiveCollections);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        entry.subscribers.delete(check);
        if (!entry.subscribers.size && collectionChecks.get(key) === entry) {
            collectionFlights.get(key)?.abort();
            collectionChecks.delete(key);
        }
    };
}

export type FileFreshnessState =
    | "unverified"
    | "overdue"
    | "appending"
    | "verified"
    | "conflict"
    | "unavailable";

export type FileConflictReason = "changed" | "save-refused" | "lossy-source";

export type FileFreshnessEntry = {
    state: FileFreshnessState;
    verifiedRevision: string | null;
    conflictReason: FileConflictReason | null;
    errorMessage: string | null;
    epoch: number;
};

type FreshnessUpdate = {
    verifiedRevision?: string | null;
    conflictReason?: FileConflictReason | null;
    errorMessage?: string | null;
};

const initialEntry: FileFreshnessEntry = Object.freeze({
    state: "unverified",
    verifiedRevision: null,
    conflictReason: null,
    errorMessage: null,
    epoch: 0,
});

const entries = new Map<string, FileFreshnessEntry>();
const subscribers = new Map<string, Set<() => void>>();
type FilePollOutcome =
    | { kind: "revision"; revision: string }
    | { kind: "rejected"; unavailable: boolean; message: string }
    | { kind: "overdue" };

const pendingPollOutcomes = new Map<string, FilePollOutcome>();

type FileWriteState = {
    active: number;
    generation: number;
    observers: number;
};

const fileWrites = new Map<string, FileWriteState>();
const fileWriteSubscribers = new Set<(key: string) => void>();

const FILE_REVISION_INTERVAL_MS = 2_000;
const FILE_REVISION_DEADLINE_MS = 2_000;

export function getFileFreshness(tabId: string): FileFreshnessEntry {
    return entries.get(tabId) ?? initialEntry;
}

function getFileWriteState(key: string): FileWriteState {
    let state = fileWrites.get(key);
    if (!state) {
        state = { active: 0, generation: 0, observers: 0 };
        fileWrites.set(key, state);
    }
    return state;
}

function notifyFileWriteChange(key: string): void {
    for (const listener of fileWriteSubscribers) listener(key);
}

function releaseFileWriteState(key: string, state: FileWriteState): void {
    if (state.active === 0 && state.observers === 0 && fileWrites.get(key) === state) {
        fileWrites.delete(key);
    }
}

/** Marks a file-key write so revision polls cannot classify the app's own atomic replacement. */
export function beginFileWrite(key: string): () => void {
    const state = getFileWriteState(key);
    state.active += 1;
    state.generation += 1;
    notifyFileWriteChange(key);

    let ended = false;
    return () => {
        if (ended) return;
        ended = true;
        const current = fileWrites.get(key);
        if (current !== state) return;
        current.active -= 1;
        notifyFileWriteChange(key);
        releaseFileWriteState(key, current);
    };
}

function fileWriteIsActive(key: string): boolean {
    return (fileWrites.get(key)?.active ?? 0) > 0;
}

function fileWriteGeneration(key: string): number {
    return fileWrites.get(key)?.generation ?? 0;
}

function retainFileWriteState(key: string): () => void {
    const state = getFileWriteState(key);
    state.observers += 1;
    return () => {
        state.observers -= 1;
        releaseFileWriteState(key, state);
    };
}

function subscribeFileWriteChanges(listener: (key: string) => void): () => void {
    fileWriteSubscribers.add(listener);
    return () => fileWriteSubscribers.delete(listener);
}

export function subscribeFileFreshness(tabId: string, listener: () => void): () => void {
    let listeners = subscribers.get(tabId);
    if (!listeners) {
        listeners = new Set();
        subscribers.set(tabId, listeners);
    }
    listeners.add(listener);
    return () => {
        listeners?.delete(listener);
        if (listeners?.size === 0) subscribers.delete(tabId);
    };
}

export function setFileFreshness(
    tabId: string,
    state: FileFreshnessState,
    update: FreshnessUpdate = {},
): FileFreshnessEntry {
    const previous = getFileFreshness(tabId);
    const settledAppend = previous.state === "appending" && state !== "appending";
    const next: FileFreshnessEntry = {
        state,
        verifiedRevision:
            update.verifiedRevision !== undefined
                ? update.verifiedRevision
                : state === "verified"
                  ? previous.verifiedRevision
                  : null,
        conflictReason: state === "conflict" ? (update.conflictReason ?? "changed") : null,
        errorMessage: update.errorMessage ?? null,
        epoch: previous.epoch + 1,
    };
    entries.set(tabId, next);
    for (const listener of subscribers.get(tabId) ?? []) listener();
    if (settledAppend) {
        const pending = pendingPollOutcomes.get(tabId);
        pendingPollOutcomes.delete(tabId);
        if (pending) return applyFilePollOutcome(tabId, pending);
    }
    return next;
}

function setFileFreshnessErrorMessage(tabId: string, errorMessage: string): FileFreshnessEntry {
    const previous = getFileFreshness(tabId);
    if (previous.errorMessage === errorMessage) return previous;
    const next = { ...previous, errorMessage };
    entries.set(tabId, next);
    for (const listener of subscribers.get(tabId) ?? []) listener();
    return next;
}

export function removeFileFreshness(tabId: string): void {
    entries.delete(tabId);
    pendingPollOutcomes.delete(tabId);
    conflictSaveActions.delete(tabId);
    for (const listener of subscribers.get(tabId) ?? []) listener();
}

export function useFileFreshness(tabId: string): FileFreshnessEntry {
    return useSyncExternalStore(
        (listener) => subscribeFileFreshness(tabId, listener),
        () => getFileFreshness(tabId),
        () => initialEntry,
    );
}

type ReconcileFlight = {
    controller: AbortController;
    rerun: (() => void) | null;
};

const reconcileFlights = new Map<string, ReconcileFlight>();
const conflictSaveActions = new Map<string, () => Promise<boolean>>();

export function registerFileConflictSave(
    tabId: string,
    action: () => Promise<boolean>,
): () => void {
    conflictSaveActions.set(tabId, action);
    return () => {
        if (conflictSaveActions.get(tabId) === action) conflictSaveActions.delete(tabId);
    };
}

export async function saveFileConflictVersion(tabId: string): Promise<boolean> {
    const action = conflictSaveActions.get(tabId);
    return action ? action() : false;
}

/** Keeps at most one native reconcile read outstanding for a tab, even after abort. */
export function requestFileReconcile(
    tabId: string,
    reconcile: (signal: AbortSignal) => Promise<void>,
): () => void {
    let active = true;
    let ownedFlight: ReconcileFlight | null = null;

    const request = () => {
        if (!active) return;
        const current = reconcileFlights.get(tabId);
        if (current) {
            current.rerun = request;
            return;
        }

        const flight: ReconcileFlight = {
            controller: new AbortController(),
            rerun: null,
        };
        ownedFlight = flight;
        reconcileFlights.set(tabId, flight);
        void Promise.resolve(reconcile(flight.controller.signal))
            .catch(() => undefined)
            .finally(() => {
                if (reconcileFlights.get(tabId) !== flight) return;
                reconcileFlights.delete(tabId);
                const rerun = flight.rerun;
                if (rerun) queueMicrotask(rerun);
            });
    };

    request();
    return () => {
        active = false;
        const current = reconcileFlights.get(tabId);
        if (current?.rerun === request) current.rerun = null;
        if (ownedFlight && current === ownedFlight) ownedFlight.controller.abort();
    };
}

export function pendingFileReconcileCount(): number {
    return reconcileFlights.size;
}

type FileRevisionPollDependencies = {
    getTabs: () => readonly Tab[];
    fileRevision: (
        handle: FileWorkspaceHandle,
        options: { signal: AbortSignal },
    ) => Promise<string>;
    subscribeFocus: (callback: () => void) => Promise<() => void> | (() => void);
};

type FileRevisionFlight = {
    controller: AbortController;
    deadline: ReturnType<typeof setTimeout> | null;
    rerunAfterSettle: boolean;
    timedOut: boolean;
    writeGeneration: number;
    releaseWriteState: () => void;
};

/** Starts the one app-level file revision poll. The returned owner clears every timer and
 * aborts each outstanding native read when the root route unmounts. */
export function startFileRevisionPoll(dependencies: FileRevisionPollDependencies): () => void {
    let running = true;
    let focusCleanup: (() => void) | null = null;
    const flights = new Map<string, FileRevisionFlight>();

    const fileTabs = () =>
        dependencies.getTabs().flatMap((tab) => {
            const origin = tab.gameOrigin;
            if (origin.kind !== "file" && origin.kind !== "temp_file") return [];
            return [
                {
                    tabId: tab.value,
                    handle: origin.file.handle,
                    key: fileWorkspaceKey(origin.file.handle),
                },
            ];
        });

    const applyOutcome = (key: string, outcome: FilePollOutcome) => {
        for (const tab of fileTabs()) {
            if (tab.key !== key) continue;
            applyFilePollOutcome(tab.tabId, outcome);
        }
    };

    const runForHandle = (key: string, handle: FileWorkspaceHandle) => {
        if (!running) return;
        const existing = flights.get(key);
        if (existing) {
            existing.rerunAfterSettle = true;
            return;
        }
        if (fileWriteIsActive(key)) return;
        const releaseWriteState = retainFileWriteState(key);
        const flight: FileRevisionFlight = {
            controller: new AbortController(),
            deadline: null,
            rerunAfterSettle: false,
            timedOut: false,
            writeGeneration: fileWriteGeneration(key),
            releaseWriteState,
        };
        flights.set(key, flight);
        const applyIfCurrent = (outcome: FilePollOutcome) => {
            if (fileWriteGeneration(key) !== flight.writeGeneration) {
                flight.rerunAfterSettle = true;
                return;
            }
            applyOutcome(key, outcome);
        };
        flight.deadline = setTimeout(() => {
            if (!running || flights.get(key) !== flight || flight.timedOut) return;
            flight.timedOut = true;
            flight.controller.abort();
            flight.deadline = null;
            applyIfCurrent({ kind: "overdue" });
        }, FILE_REVISION_DEADLINE_MS);

        void Promise.resolve()
            .then(() => dependencies.fileRevision(handle, { signal: flight.controller.signal }))
            .then((revision) => {
                if (!flight.timedOut && running) {
                    applyIfCurrent({ kind: "revision", revision });
                }
            })
            .catch((error: unknown) => {
                if (flight.timedOut || !running) return;
                const normalized = normalizeError(error);
                applyIfCurrent({
                    kind: "rejected",
                    unavailable:
                        normalized.backendCategory === "missing-resource" ||
                        normalized.backendCategory === "conflict",
                    message: normalized.message,
                });
            })
            .finally(() => {
                if (flight.deadline !== null) clearTimeout(flight.deadline);
                if (flights.get(key) === flight) flights.delete(key);
                flight.releaseWriteState();
                if (!running || (!flight.timedOut && !flight.rerunAfterSettle)) return;
                const nextHandle = fileTabs().find((tab) => tab.key === key)?.handle;
                if (nextHandle) runForHandle(key, nextHandle);
            });
    };

    const tick = () => {
        if (!running) return;
        checkActiveCollections(true);
        const handles = new Map<string, FileWorkspaceHandle>();
        for (const tab of fileTabs()) handles.set(tab.key, tab.handle);
        for (const [key, handle] of handles) runForHandle(key, handle);
    };

    const interval = setInterval(tick, FILE_REVISION_INTERVAL_MS);
    const unsubscribeWrites = subscribeFileWriteChanges((key) => {
        checkActiveCollections(true);
        const handle = fileTabs().find((tab) => tab.key === key)?.handle;
        if (handle) runForHandle(key, handle);
    });
    try {
        void Promise.resolve(dependencies.subscribeFocus(tick))
            .then((unsubscribe) => {
                if (running) focusCleanup = unsubscribe;
                else unsubscribe();
            })
            .catch((error: unknown) => {
                console.error("File freshness focus listener failed", normalizeError(error));
            });
    } catch (error) {
        console.error("File freshness focus listener failed", normalizeError(error));
    }

    return () => {
        if (!running) return;
        running = false;
        clearInterval(interval);
        unsubscribeWrites();
        focusCleanup?.();
        focusCleanup = null;
        for (const flight of flights.values()) {
            if (flight.deadline !== null) clearTimeout(flight.deadline);
            flight.deadline = null;
            flight.controller.abort();
        }
        for (const flight of collectionFlights.values()) flight.abort();
        pendingPollOutcomes.clear();
    };
}

function applyFilePollOutcome(tabId: string, outcome: FilePollOutcome): FileFreshnessEntry {
    const current = getFileFreshness(tabId);
    if (current.state === "appending") {
        pendingPollOutcomes.set(tabId, outcome);
        return current;
    }
    if (outcome.kind === "overdue") {
        if (current.state === "verified" || current.state === "unverified") {
            return setFileFreshness(tabId, "overdue");
        }
        return current;
    }
    if (outcome.kind === "rejected") {
        if (outcome.unavailable) {
            if (current.state === "unavailable") return current;
            return setFileFreshness(tabId, "unavailable", { errorMessage: outcome.message });
        }
        if (current.state === "verified" || current.state === "overdue") {
            return setFileFreshness(tabId, "unverified", { errorMessage: outcome.message });
        }
        if (current.state === "unverified") {
            return setFileFreshnessErrorMessage(tabId, outcome.message);
        }
        return current;
    }
    if (current.state === "verified") {
        if (outcome.revision === current.verifiedRevision) return current;
        return setFileFreshness(tabId, "unverified");
    }
    if (current.state === "overdue") return setFileFreshness(tabId, "unverified");
    return current;
}
