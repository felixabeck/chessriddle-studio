import { type getDefaultStore, useAtomValue } from "jotai";
import { isRepertoireTab } from "@/utils/tabs";
import { tabsAtom } from "./atoms";
import {
    opponentPreparationAtom,
    type TabPreparationView,
    tabPreparationViewFamily,
} from "./atoms/preparation";
import type { BoardLayoutKind } from "./layoutPresets";
import type { Tab } from "./workspaceTypes";

/**
 * Classifies an analysis tab into its layout kind:
 * - `"preparation"` when `view` is non-null and its `preparationId` matches the current preparation;
 * - `"repertoire"` when `isRepertoireTab(tab)` is true;
 * - `"game"` otherwise.
 */
export function classifyBoardLayoutKind(
    tab: Tab | undefined,
    preparationId: string | null,
    view: TabPreparationView | null,
): BoardLayoutKind {
    if (tab?.type !== "analysis") return "game";
    if (preparationId !== null && view !== null && view.preparationId === preparationId) {
        return "preparation";
    }
    return isRepertoireTab(tab) ? "repertoire" : "game";
}

/**
 * Resolves the layout kind of `tabId` from `store`. Reads `tabPreparationViewFamily` only when
 * `tabId` is an open analysis tab (and a preparation is active), avoiding orphan family entries.
 */
export function resolveBoardLayoutKind(
    store: ReturnType<typeof getDefaultStore>,
    tabId: string,
): BoardLayoutKind {
    const tab = store.get(tabsAtom).find((candidate) => candidate.value === tabId);
    if (!tab || tab.type !== "analysis") return "game";
    const preparation = store.get(opponentPreparationAtom);
    const view = preparation !== null ? store.get(tabPreparationViewFamily(tabId)) : null;
    return classifyBoardLayoutKind(tab, preparation?.id ?? null, view);
}

/**
 * Subscribes to the layout kind of an open analysis `tab`. Call only for open analysis tabs.
 */
export function useAnalysisTabLayoutKind(tab: Tab): BoardLayoutKind {
    const preparation = useAtomValue(opponentPreparationAtom);
    const view = useAtomValue(tabPreparationViewFamily(tab.value));
    return classifyBoardLayoutKind(tab, preparation?.id ?? null, view);
}
