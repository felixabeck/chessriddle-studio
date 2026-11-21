import { ask } from "@/platform/native";
import { tauri } from "@/platform/tauri";
import i18n from "@/i18n";
import { clearSavedDataFromMenu } from "@/routes/-appMenu";
import { initializePathOwners, startupLegacyDeckScanComplete } from "@/state/pathOwners";
import {
    ensurePracticeMigration,
    retireMigratedLegacyDeckKeysFromBrowser,
    runPracticeMigrationPass,
    type PracticeMigrationPassResult,
} from "@/state/practiceStorage";
import {
    clearUnsavedGamesBeforeWipe,
    getUnsavedGameMirror,
    nativeUnsavedGames,
    type UnsavedGameMirror,
} from "@/state/unsavedGames";

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

export function requireUnsavedGameMirror(): UnsavedGameMirror {
    return getUnsavedGameMirror(() => {
        throw new Error("Unsaved-game mirror was not started");
    });
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Confirms, then clears saved data through the window's unsaved-games mirror. */
export async function clearSavedData(options?: {
    mirror?: Pick<UnsavedGameMirror, "pause" | "resume" | "drain">;
    t?: Translate;
}): Promise<void> {
    const mirror = options?.mirror ?? requireUnsavedGameMirror();
    const t = options?.t ?? ((key, vars) => i18n.t(key, vars));
    await clearSavedDataFromMenu({
        ask,
        confirmMessage: t("Menu.Help.ClearSavedData.Confirm"),
        title: t("Menu.Help.ClearSavedData.Title"),
        clear: () =>
            clearSavedDataAfterConfirmation({
                blockedMessage: (decks) =>
                    t("Menu.Help.ClearSavedData.MigrationBlocked", {
                        decks: decks.join(", "),
                        practiceData: t("Board.Practice.Data"),
                    }),
                clear: () =>
                    clearUnsavedGamesBeforeWipe({
                        mirror,
                        native: nativeUnsavedGames,
                        wipe: () => {
                            localStorage.clear();
                            sessionStorage.clear();
                            location.reload();
                        },
                    }),
            }),
    });
}
