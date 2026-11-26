import type { getDefaultStore } from "jotai";
import { tabFamily } from "./atoms";
import { arrangementLeaves } from "./boardArrangement";
import { resolveBoardLayoutKind } from "./boardLayoutKind";
import { boardLayoutFamily } from "./layoutStorage";

/**
 * Opens `tab` in board tab `tabId`'s tab strip and shows the strip in that tab's layout kind when
 * the tab lives in it, i.e. unless it is a panel shown as its own area. Every request to open a
 * strip tab goes through here.
 */
export function selectStripTab(
    store: ReturnType<typeof getDefaultStore>,
    tabId: string,
    tab: string,
): void {
    store.set(tabFamily(tabId), tab);
    const kind = resolveBoardLayoutKind(store, tabId);
    const kindAtom = boardLayoutFamily(kind);
    const layout = store.get(kindAtom);
    const ownArea = (arrangementLeaves(layout.arrangement) as string[]).includes(tab);
    if (!ownArea && layout.tabsHidden) {
        store.set(kindAtom, (prev) => ({ ...prev, tabsHidden: false }));
    }
}
