import type { getDefaultStore } from "jotai";
import { tabFamily } from "./atoms";
import { arrangementLeaves } from "./boardArrangement";
import { analysisTabsHiddenAtom, boardArrangementAtom } from "./layoutStorage";

/**
 * Opens `tab` in board tab `tabId`'s tab strip and shows the strip when the tab lives in it, i.e.
 * unless it is a panel shown as its own area. Every request to open a strip tab goes through here.
 */
export function selectStripTab(
    store: ReturnType<typeof getDefaultStore>,
    tabId: string,
    tab: string,
): void {
    store.set(tabFamily(tabId), tab);
    const ownArea = (arrangementLeaves(store.get(boardArrangementAtom)) as string[]).includes(tab);
    if (!ownArea) store.set(analysisTabsHiddenAtom, false);
}
