import { useSyncExternalStore } from "react";
import type { ProgressEvent, ProgressItem } from "@/bindings";
import i18n from "@/i18n";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { errorUnlessCancelled, normalizeError, warnSafely } from "@/platform/errors";
import { cancellationError, tauri, tauriSubscriptions, withDownloadTicket } from "@/platform/tauri";

/**
 * Why a cancellation did not take effect. `lost` means the download settled on its own
 * (it finished, or native lookup found no cancellable download), `request` that the cancel IPC
 * itself failed - the card notifies only the latter - and `busy` that a job for this progress
 * id is already running.
 */
export type DownloadCancelReason = "lost" | "request" | "busy";

export type DownloadCancelError = Error & { reason: DownloadCancelReason; cause?: unknown };

/** `reason` is what a caller branches on; the message repeats it so a log line still says why. */
export function downloadCancelError(
    reason: DownloadCancelReason,
    cause?: unknown,
): DownloadCancelError {
    return Object.assign(new Error(reason), { reason, cause });
}

type CancelOutcome = { clearedGeneration: bigint | null };

type DownloadJobEntry = {
    cancelRequested: boolean;
    /** Set once the native ticket exists; before that a cancel needs no native call. */
    ticket: string | null;
    settlement: Promise<unknown>;
    clearedGeneration: bigint | null;
    failures: Map<bigint, ProgressItem>;
};

const jobs = new Map<string, DownloadJobEntry>();
const subscribers = new Set<() => void>();
const publish = () => subscribers.forEach((subscriber) => subscriber());

// Receipts belong to this document and survive job settlement. Reload releases them all.
const owned = new Set<string>();
const announced = new Set<string>();
const identity = (item: { id: string; generation: string | bigint }) =>
    JSON.stringify([item.id, item.generation.toString()]);
let initialization: Promise<void> | undefined;
let unlisten: (() => void) | undefined;
let documentActive = true;

function announceFailure(item: ProgressItem): void {
    const key = identity(item);
    if (!documentActive || owned.has(key) || announced.has(key)) return;
    announced.add(key);
    notifyUnlessCancelled(i18n.t("Common.Error"), item.failure);
    void clearDownloadProgress(item.id);
}

function observeFailure(item: ProgressItem | ProgressEvent): void {
    if (
        !documentActive ||
        item.state !== "failed" ||
        !item.failure ||
        ("cleared" in item && item.cleared)
    )
        return;
    const entry = jobs.get(item.id);
    if (entry && entry.ticket !== null) {
        entry.failures.set(item.generation, item);
    } else {
        announceFailure(item);
    }
}

/** Subscribe before taking the snapshot so failures on either side of startup are observed. */
export function initializeDownloadFailures(): Promise<void> {
    if (initialization) return initialization;
    initialization = (async () => {
        const dispose = await tauriSubscriptions.progress(({ payload }) => observeFailure(payload));
        if (!documentActive) {
            dispose();
            return;
        }
        unlisten = dispose;
        window.addEventListener("pagehide", disposeDownloadFailures, { once: true });
        try {
            const snapshot = await tauri.failedProgressSnapshot();
            snapshot.forEach(observeFailure);
        } catch (error) {
            warnSafely(`failed progress snapshot: ${normalizeError(error).message}`);
        }
    })();
    return initialization;
}

export function disposeDownloadFailures(): void {
    documentActive = false;
    unlisten?.();
    unlisten = undefined;
    window.removeEventListener("pagehide", disposeDownloadFailures);
    owned.clear();
    announced.clear();
    for (const entry of jobs.values()) entry.failures.clear();
}

/**
 * Clears a job's progress entry, best effort: the result of a download is never a failure to
 * tidy its bar. If the native warning logger rejects, the warning falls back to the console.
 */
async function clearDownloadProgress(progressId: string): Promise<bigint | null> {
    try {
        return await tauri.clearProgress(progressId);
    } catch (error) {
        warnSafely(`clear progress ${progressId}: ${String(error)}`);
        return null;
    }
}

export function runDownloadJob<T>(
    progressId: string,
    run: (ticket: string) => Promise<T>,
): Promise<T> {
    if (jobs.has(progressId)) throw downloadCancelError("busy");

    const entry: DownloadJobEntry = {
        cancelRequested: false,
        ticket: null,
        settlement: Promise.resolve(),
        clearedGeneration: null,
        failures: new Map(),
    };
    jobs.set(progressId, entry);
    publish();

    const execution = withDownloadTicket(async (preparedTicket) => {
        // A cancel that arrives before this point never reached native work: the ticket is
        // still unclaimed and `withDownloadTicket` releases it on this rejection.
        if (entry.cancelRequested) throw cancellationError();
        entry.ticket = preparedTicket;
        return run(preparedTicket);
    }).catch((error) => {
        // A preparation that failed while a cancel was pending is that cancel, not an error.
        if (entry.cancelRequested && entry.ticket === null) throw cancellationError();
        throw error;
    });

    entry.settlement = execution
        // Clear an unsuccessful job's own terminal item so its last percentage is no longer drawn.
        // If another live download reports under the same progress id, native clear keeps that
        // Running bar; the returned generation is only a visibility floor below it, even when
        // nothing was cleared. Clearing before releasing this entry keeps a retry's own bar safe:
        // no local start is accepted for this id until the clear has been answered.
        .catch(async (error) => {
            const normalized = normalizeError(error);
            if (
                documentActive &&
                entry.ticket !== null &&
                normalized.message !== "Conflict: download progress is already active" &&
                normalized.progress_generation !== undefined
            ) {
                owned.add(identity({ id: progressId, generation: normalized.progress_generation }));
            }
            entry.clearedGeneration = await clearDownloadProgress(progressId);
            throw error;
        })
        .finally(() => {
            jobs.delete(progressId);
            entry.failures.forEach(announceFailure);
            entry.failures.clear();
            publish();
        });
    return entry.settlement as Promise<T>;
}

/**
 * Cancels the running download for `progressId` and answers what the UI may hide: the generation
 * the job's own progress clear returned, or `null` when that clear failed. With no local job,
 * owner-checked native lookup cancels the surviving download and answers `null` without clearing.
 * It rejects with a `reason` of `lost` when the download settled on its own or lookup found no
 * cancellable download, and `request` when the cancellation could not be delivered - only the
 * latter is notified here, because the job's own failure is already reported by the wrapper
 * around `runDownloadJob`.
 */
export async function cancelDownloadJob(
    progressId: string,
    errorTitle?: string,
): Promise<CancelOutcome> {
    const entry = jobs.get(progressId);
    if (!entry) {
        let cancelled: boolean;
        try {
            cancelled = await tauri.cancelDownloadForProgress(progressId);
        } catch (error) {
            if (errorTitle !== undefined) notifyUnlessCancelled(errorTitle, error);
            throw downloadCancelError("request", error);
        }
        if (cancelled) return { clearedGeneration: null };
        throw downloadCancelError("lost");
    }
    entry.cancelRequested = true;

    if (entry.ticket !== null) {
        try {
            await tauri.cancelDownload(entry.ticket);
        } catch (error) {
            if (errorTitle !== undefined) notifyUnlessCancelled(errorTitle, error);
            throw downloadCancelError("request", error);
        }
    }
    try {
        await entry.settlement;
    } catch (error) {
        if (errorUnlessCancelled(error) === null) {
            return { clearedGeneration: entry.clearedGeneration };
        }
        throw error;
    }
    throw downloadCancelError("lost");
}

export function useDownloadJob(progressId: string): boolean {
    return useSyncExternalStore(
        (listener) => {
            subscribers.add(listener);
            return () => subscribers.delete(listener);
        },
        () => jobs.has(progressId),
    );
}

export function useRunningDownloadJob(progressIds: readonly string[]): string | null {
    return useSyncExternalStore(
        (listener) => {
            subscribers.add(listener);
            return () => subscribers.delete(listener);
        },
        () => progressIds.find((id) => jobs.has(id)) ?? null,
    );
}
