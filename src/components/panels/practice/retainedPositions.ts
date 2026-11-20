import { anyScopeBoardStates } from "@/components/files/opening";
import type { Position } from "@/utils/practicePosition";
import type { PracticeDeckKey } from "@/state/practiceStorage";
import { tabStorage } from "@/state/store/tabStorage";
import { getCachedTreeStore } from "@/state/store/tree";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { getTabFile, getTabGameNumber, getTabTreeKey, type Tab } from "@/utils/tabs";
import { getBoardState } from "@/utils/treeReducer";

/** An unreadable matching tab protects the entire existing deck until its tree is available. */
export function collectRetainedPracticePositions({
    tabs,
    currentTabId,
    identity,
    existing,
}: {
    tabs: readonly Tab[];
    currentTabId: string | undefined;
    identity: PracticeDeckKey;
    existing: readonly Position[];
}): ReadonlySet<string> {
    const retained = new Set<string>();
    for (const tab of tabs) {
        if (tab.value === currentTabId) continue;
        const file = getTabFile(tab);
        if (
            !file ||
            fileWorkspaceKey(file.handle) !== identity.file ||
            getTabGameNumber(tab) !== identity.game
        ) {
            continue;
        }
        try {
            const cached = getCachedTreeStore(tab.value);
            if (cached) {
                const status = tabStorage.getStatus(getTabTreeKey(tab));
                if (status.kind !== "available" && status.kind !== "absent") {
                    return new Set(existing.map((position) => getBoardState(position.fen)));
                }
            }
            const root = cached
                ? cached.getState().root
                : tabStorage.readForClone(getTabTreeKey(tab), tab.treeKey !== undefined)?.root;
            if (!root) continue;
            for (const boardState of anyScopeBoardStates(root)) {
                retained.add(boardState);
            }
        } catch {
            return new Set(existing.map((position) => getBoardState(position.fen)));
        }
    }
    return retained;
}
