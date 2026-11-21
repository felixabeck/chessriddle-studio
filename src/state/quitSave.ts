import type { getDefaultStore } from "jotai";
import { activeTabAtom, tabsAtom, updateTabById } from "@/state/atoms";
import { getOrCreateTreeStore } from "@/state/store/tree";
import { getTabTreeKey, type Tab } from "@/state/workspaceTypes";
import { saveToFile, type SaveResult } from "@/utils/tabs";

/**
 * The quit gate's per-tab save: the same user save the tab's own Save button runs, against the
 * live workspace. `showWorkspace` brings the boards into view for a save that opens a picker.
 */
export function createQuitTabSaver(
    jotaiStore: ReturnType<typeof getDefaultStore>,
    showWorkspace: () => void,
): (tab: Tab) => Promise<SaveResult> {
    return (tab) => {
        if (tab.gameOrigin.kind === "none" || tab.gameOrigin.kind === "temp_file") {
            // These saves ask for a destination file, so show the game the picker is about.
            showWorkspace();
            jotaiStore.set(activeTabAtom, tab.value);
        }
        return saveToFile({
            tab,
            // The tab's cached store, or one hydrated from its stored tree if it never mounted.
            store: getOrCreateTreeStore(tab.value, undefined, getTabTreeKey(tab)),
            getTab: (tabId) =>
                jotaiStore.get(tabsAtom).find((candidate) => candidate.value === tabId),
            updateTab: (tabId, update, onAdmitted) =>
                updateTabById(
                    (...args) => jotaiStore.set(tabsAtom, ...args),
                    tabId,
                    update,
                    onAdmitted,
                ),
            isUserSave: true,
        });
    };
}
