import { ask } from "@/platform/native";
import { errorCategoryOf } from "@/platform/errors";
import { tauri } from "@/platform/tauri";
import i18n from "@/i18n";
import { initializePathOwners, startupLegacyDeckScanComplete } from "@/state/pathOwners";
import {
    ensurePracticeMigration,
    retireMigratedLegacyDeckKeysFromBrowser,
    runPracticeMigrationPass,
    type PracticeMigrationPassResult,
} from "@/state/practiceStorage";
import { nativeUnsavedGames } from "@/state/unsavedGames";
import {
    getWorkspaceSessionMirror,
    nativeWorkspaceSession,
    type DrainResult,
    type WorkspaceSessionMirror,
    type WorkspaceSessionNative,
} from "@/state/workspaceSession";

async function clearNativeStoreOrResume(
    clear: () => Promise<string[]>,
    resume: () => void,
): Promise<void> {
    let leftover: string[];
    try {
        leftover = await clear();
    } catch (error) {
        resume();
        throw new Error(
            i18n.t("Menu.Help.ClearSavedData.UnsavedFailed", { category: errorCategoryOf(error) }),
        );
    }
    if (leftover.length > 0) {
        resume();
        throw new Error(
            i18n.t("Menu.Help.ClearSavedData.UnsavedLeftover", { count: leftover.length }),
        );
    }
}

/**
 * Drains the session mirror, clears both the durable session store and the legacy unsaved-games
 * store, and wipes web storage. On any failure keeps the session and resumes the mirror (clearing
 * store-unavailable mode only if the session store itself was cleared completely).
 */
export async function clearWorkspaceAndUnsavedBeforeWipe(deps: {
    mirror: Pick<WorkspaceSessionMirror, "pause" | "resume" | "drain">;
    sessionNative: Pick<WorkspaceSessionNative, "clear">;
    legacyNative: { clear: () => Promise<string[]> };
    wipe: () => void;
}): Promise<void> {
    deps.mirror.pause();
    let drained: DrainResult;
    try {
        drained = await deps.mirror.drain();
    } catch (error) {
        deps.mirror.resume({ clearedCompletely: false });
        throw new Error(
            i18n.t("Menu.Help.ClearSavedData.UnsavedFailed", { category: errorCategoryOf(error) }),
        );
    }
    if (!drained.finished) {
        deps.mirror.resume({ clearedCompletely: false });
        throw new Error(i18n.t("Menu.Help.ClearSavedData.UnsavedPending"));
    }

    await clearNativeStoreOrResume(
        () => deps.sessionNative.clear(),
        () => deps.mirror.resume({ clearedCompletely: false }),
    );
    await clearNativeStoreOrResume(
        () => deps.legacyNative.clear(),
        () => deps.mirror.resume({ clearedCompletely: true }),
    );

    deps.wipe();
}

export type ClearSavedDataAfterConfirmationDeps = {
    blockedMessage: (decks: string[]) => string;
    clear: () => void | Promise<void>;
};

function affectedPracticeDecks(result: PracticeMigrationPassResult): string[] {
    const affected = new Set<string>();
    for (const outcome of result.outcomes) {
        if (outcome.status === "failed") {
            affected.add(`${outcome.identity.file} (${outcome.identity.game})`);
        }
    }
    for (const anomaly of result.inventory?.anomalies ?? []) {
        affected.add(
            anomaly.fileId !== null && anomaly.game !== null
                ? `${anomaly.fileId} (${anomaly.game})`
                : anomaly.leaf,
        );
    }
    if (!result.scanTrusted || !result.inventoryTrusted) {
        affected.add(i18n.t("Board.Practice.Data"));
    }
    return [...affected].sort();
}

export async function clearSavedDataAfterConfirmation(
    deps: ClearSavedDataAfterConfirmationDeps,
): Promise<void> {
    const pathOwnersInitialized = await initializePathOwners().then(
        () => true,
        () => false,
    );
    await ensurePracticeMigration();
    const result = await runPracticeMigrationPass();
    if (pathOwnersInitialized && startupLegacyDeckScanComplete()) {
        retireMigratedLegacyDeckKeysFromBrowser(result.outcomes);
    }
    const affected = affectedPracticeDecks(result);
    if (affected.length > 0) {
        throw new Error(deps.blockedMessage(affected));
    }
    await deps.clear();
}

export function reloadApp(): void {
    location.reload();
}

export async function openAppLogs(): Promise<void> {
    await tauri.openAppLog();
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Confirms, then clears saved data through the window's workspace session mirror. */
export async function clearSavedData(options?: {
    mirror?: Pick<WorkspaceSessionMirror, "pause" | "resume" | "drain">;
    t?: Translate;
}): Promise<void> {
    const mirror =
        options?.mirror ??
        getWorkspaceSessionMirror(() => {
            throw new Error("Workspace session mirror was not started");
        });
    const t = options?.t ?? ((key, vars) => i18n.t(key, vars));
    if (
        !(await ask(t("Menu.Help.ClearSavedData.Confirm"), {
            title: t("Menu.Help.ClearSavedData.Title"),
            kind: "warning",
        }))
    ) {
        return;
    }
    await clearSavedDataAfterConfirmation({
        blockedMessage: (decks) =>
            t("Menu.Help.ClearSavedData.MigrationBlocked", {
                decks: decks.join(", "),
                practiceData: t("Board.Practice.Data"),
            }),
        clear: () =>
            clearWorkspaceAndUnsavedBeforeWipe({
                mirror,
                sessionNative: nativeWorkspaceSession,
                legacyNative: nativeUnsavedGames,
                wipe: () => {
                    localStorage.clear();
                    sessionStorage.clear();
                    location.reload();
                },
            }),
    });
}
