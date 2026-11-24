import { useSetAtom, useStore } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { playFromHereColorFamily, tabsAtom } from "@/state/atoms";
import { createTab, runTabCreation } from "@/utils/tabs";
import { lineToTree, type GameHeaders, type TreeNode } from "@/utils/treeReducer";

/**
 * Opens a play tab seeded with the line up to `path` and marks it as opened from here, so its
 * setup derives player 1's colour from the side to move (`seededInputColor` in useGameSetup).
 */
export function usePlayFromHere(): (
    root: TreeNode,
    orientation: GameHeaders["orientation"],
    path: number[],
) => void {
    const { t } = useTranslation();
    const setTabs = useSetAtom(tabsAtom);
    const store = useStore();

    return useCallback(
        (root, orientation, path) => {
            void runTabCreation({
                create: () =>
                    createTab({
                        tab: { name: t("Home.NewGame"), type: "play" },
                        setTabs,
                        initialTree: lineToTree(root, orientation, path),
                    }),
                onSuccess: (id) => store.set(playFromHereColorFamily(id), { chosen: null }),
                onError: (error) => notifyUnlessCancelled(t("Common.Error"), error),
            });
        },
        [setTabs, store, t],
    );
}
