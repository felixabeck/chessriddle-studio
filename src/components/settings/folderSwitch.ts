import type { TFunction } from "i18next";
import type {
    FolderStatus,
    FolderSwitchFailure,
    FolderSwitchGrant,
    WorkspaceChoice,
} from "@/bindings";
import i18n from "@/i18n";

export function folderSwitchFailureMessage(
    failure: FolderSwitchFailure,
    t: TFunction = i18n.t,
): string {
    switch (failure.reason) {
        case "same-folder":
            return t("Settings.Directories.SwitchError.SameFolder", {
                defaultValue: "The selected folder is already in use.",
            });
        case "nested-folders":
            return t("Settings.Directories.SwitchError.NestedFolders", {
                defaultValue:
                    "The current and selected folders cannot be nested inside each other.",
            });
        case "name-collision":
            return t("Settings.Directories.SwitchError.NameCollision", {
                count: failure.count,
                defaultValue:
                    "The selected folder already contains {{count}} file(s) with the same name.",
            });
        case "target-unwritable":
            return t("Settings.Directories.SwitchError.TargetUnwritable", {
                defaultValue: "ChessRiddle Studio cannot write to the selected folder.",
            });
        case "source-unreadable":
            return t("Settings.Directories.SwitchError.SourceUnreadable", {
                defaultValue: "ChessRiddle Studio cannot read the current folder.",
            });
        case "root-busy":
            return t("Settings.Directories.SwitchError.RootBusy", {
                defaultValue:
                    "Wait for active imports, downloads, or database updates in this folder to finish first.",
            });
        case "expired-grant":
            return t("Settings.Directories.SwitchError.ExpiredGrant", {
                defaultValue: "The folder confirmation expired. Please choose the folder again.",
            });
        case "identity-changed":
            return t("Settings.Directories.SwitchError.IdentityChanged", {
                defaultValue: "One of the folders changed before switching. Please try again.",
            });
        case "journal-write-failed":
            return t("Settings.Directories.SwitchError.JournalWriteFailed", {
                defaultValue: "Could not prepare the folder move. Your files were not changed.",
            });
        case "quiesce-failed":
            return t("Settings.Directories.SwitchError.QuiesceFailed", {
                defaultValue:
                    "Could not close open databases or engines before moving. Your files were not changed.",
            });
        case "symlink-in-tree":
            return t("Settings.Directories.SwitchError.SymlinkInTree", {
                defaultValue:
                    "Symbolic links or reparse points inside this folder cannot be moved.",
            });
        case "transfer-failed-rolled-back":
            return t("Settings.Directories.SwitchError.TransferFailedRolledBack", {
                defaultValue:
                    "Moving files failed. Your previous folder remains active and untouched.",
            });
        case "rollback-incomplete":
            return t("Settings.Directories.SwitchError.RollbackIncomplete", {
                defaultValue:
                    "Moving files failed and cleanup could not finish. ChessRiddle Studio will finish recovery on the next start.",
            });
        case "interrupted-move":
            return t("Settings.Directories.SwitchError.InterruptedMove", {
                defaultValue:
                    "A previous folder move was interrupted. ChessRiddle Studio will finish it on the next start.",
            });
        case "switch-in-progress":
            return t("Settings.Directories.SwitchError.SwitchInProgress", {
                defaultValue: "A folder switch is already in progress.",
            });
    }
}

export type PendingFolderSwitch = {
    grant: FolderSwitchGrant;
    displayName: string;
    itemCount: number;
    resolve: (result: FolderStatus | null) => void;
};

let currentPending: PendingFolderSwitch | null = null;
const listeners = new Set<() => void>();

export function getPendingFolderSwitch(): PendingFolderSwitch | null {
    return currentPending;
}

export function setPendingFolderSwitch(next: PendingFolderSwitch | null): void {
    currentPending = next;
    for (const listener of listeners) listener();
}

export function subscribePendingFolderSwitch(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export type FolderSwitchResult =
    | { switched: false }
    | {
          switched: true;
          displayName: string;
          status?: FolderStatus;
      };

/**
 * Shared facade for every folder chooser and restore action (databases, engines, puzzles).
 * - If the native choose/restore step returns `activated`, returns immediately without a dialog.
 * - If it returns `pending`, opens the shared `FolderSwitchModal` and awaits Move / Use only / Cancel.
 */
export async function runFolderSwitch(
    choose: () => Promise<WorkspaceChoice<{ displayName: string }>>,
): Promise<FolderSwitchResult> {
    const choice = await choose();
    if (choice.status === "activated") {
        return {
            switched: true,
            displayName: choice.descriptor.displayName,
        };
    }
    const status = await new Promise<FolderStatus | null>((resolve) => {
        setPendingFolderSwitch({
            grant: choice.grant,
            displayName: choice.displayName,
            itemCount: choice.itemCount,
            resolve,
        });
    });
    if (!status) {
        return { switched: false };
    }
    return {
        switched: true,
        displayName: status.displayName,
        status,
    };
}
