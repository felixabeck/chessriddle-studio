import { getDefaultStore } from "jotai";
import { useSyncExternalStore } from "react";
import type { EngineInstallIntent } from "@/bindings";
import i18n from "@/i18n";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { runDownloadJob } from "@/hooks/downloadJobs";
import { installCatalogEngine } from "@/utils/engineInstall";
import type { DefaultEngine, LocalEngine } from "@/utils/engines";
import {
    applyEngineCompletion,
    engineCompletionState,
    initializeEngineCompletions,
    observeEngineCompletions,
} from "./engineCompletions";

const { pending, listeners, publish, requireDocument } = engineCompletionState;

/** One job and failure contract. A synchronous refusal returns null without accepting a job. */
export function installCatalogEngineJob(
    engine: DefaultEngine,
    progressId: string,
    upgrade?: LocalEngine,
    store = getDefaultStore(),
): Promise<boolean> | null {
    const failed = (error: unknown) => {
        if (!(error instanceof Error && "reason" in error && error.reason === "busy")) {
            notifyUnlessCancelled(i18n.t("Common.Error"), error, "engine");
        }
        return false;
    };
    try {
        return runDownloadJob(progressId, (ticket) =>
            completeCatalogEngine(engine, progressId, ticket, upgrade, store),
        ).then(() => true, failed);
    } catch (error) {
        failed(error);
        return null;
    }
}

export function usePendingEngineCompletion(progressId: string | null, engineId?: string) {
    return useSyncExternalStore(
        (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        () =>
            [...pending.values()].find(({ completion }) =>
                engineId
                    ? completion.request.intent.engine_id === engineId
                    : completion.request.progressId === progressId,
            ),
    );
}

/** A retry joins pending work by logical target before allocating another transfer or UUID. */
export async function completeCatalogEngine(
    engine: DefaultEngine,
    progressId: string,
    ticket: string,
    upgrade?: LocalEngine,
    store = getDefaultStore(),
) {
    await initializeEngineCompletions(store);
    const snapshots = await observeEngineCompletions();
    requireDocument();
    const previous = snapshots.find((completion) =>
        upgrade
            ? completion.request.intent.kind === "upgrade" &&
              completion.request.intent.engine_id === upgrade.id
            : completion.request.intent.kind === "add" &&
              completion.request.progressId === progressId,
    );
    const intent: EngineInstallIntent = upgrade
        ? { kind: "upgrade", engine_id: upgrade.id, expected: upgrade.handle }
        : { kind: "add", engine_id: crypto.randomUUID() };
    const completion = previous ?? (await installCatalogEngine(engine, progressId, ticket, intent));
    requireDocument();
    pending.set(completion.id, { completion, applying: false });
    publish();
    if (completion.outcome.state === "running") {
        // Rejoining an accepted transfer uses its notification/snapshot path. No second command
        // can repeat native effects. Startup itself never waits for this network operation.
        await new Promise<void>((resolve, reject) => {
            const check = () => {
                try {
                    requireDocument();
                    if (pending.get(completion.id)?.completion.outcome.state === "running") return;
                    resolve();
                } catch (error) {
                    reject(error);
                }
                listeners.delete(check);
            };
            listeners.add(check);
            check();
        });
    }
    await applyEngineCompletion(completion, store);
}
