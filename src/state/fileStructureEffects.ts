import { invalidateFileDeckAtoms } from "./atoms";
import { setFileFreshness } from "./fileFreshness";
import { clearPracticeFileMigrationFailures } from "./practiceStorage";
import type { Tab } from "./workspaceTypes";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { isFileBackedTab } from "@/utils/tabs";

export function markFileTabsFreshness(
    tabs: readonly Tab[],
    fileKey: string,
    state: "conflict" | "unverified",
): void {
    for (const tab of tabs) {
        if (isFileBackedTab(tab) && fileWorkspaceKey(tab.gameOrigin.file.handle) === fileKey) {
            setFileFreshness(
                tab.value,
                state,
                state === "conflict" ? { conflictReason: "changed" } : undefined,
            );
        }
    }
}

export function invalidateFileStructureCaches(fileKey: string): void {
    try {
        invalidateFileDeckAtoms(fileKey);
    } finally {
        clearPracticeFileMigrationFailures(fileKey);
    }
}
