/** Per-tab board view and panel state. */
import { atom, getDefaultStore } from "jotai";
import { defaultPanelTabAtom, hidePreviewMovesAtom } from "./preferences";
import { tabAtomFamily } from "./tabFamilies";
import { currentTabAtom } from "./tabs";

export const evalOpenFamily = tabAtomFamily((_tab: string) => atom(true));

export const evalBarDisplayFamily = tabAtomFamily((_tab: string) => atom<"cp" | "wdl">("cp"));

export const invisibleFamily = tabAtomFamily((_tab: string) => atom(false));

/** When the hide-preview-moves preference is on, the tab starts with its moves hidden. */
export function applyPreviewMovesHidden(store: ReturnType<typeof getDefaultStore>, tabId: string) {
    if (store.get(hidePreviewMovesAtom)) {
        store.set(invisibleFamily(tabId), true);
    }
}

export const showCommentsFamily = tabAtomFamily((_tab: string) => atom(true));

export const showVariationsFamily = tabAtomFamily((_tab: string) => atom(true));

export const showDiagramsFamily = tabAtomFamily((_tab: string) => atom(true));

// A board's panel starts on the default-panel setting as it stands when the board's atom is created
// (the app runs on the default store). Later setting changes leave existing boards where they are.
export const tabFamily = tabAtomFamily((_tab: string) =>
    atom<string>(getDefaultStore().get(defaultPanelTabAtom)),
);

export const reportModalOpenFamily = tabAtomFamily((_tab: string) => atom(false));

/** The Coach turn that runs in a tab now; driven by `src/state/coachTurns.ts`. */
export const coachTurnFamily = tabAtomFamily((_tab: string) =>
    atom<import("../coachSession").CoachRunningTurn | null>(null),
);

export const practiceTabFamily = tabAtomFamily((_tab: string) => atom("train"));

export const pgnOptionsFamily = tabAtomFamily((_tab: string) =>
    atom({
        comments: true,
        glyphs: true,
        variations: true,
        extraMarkups: true,
    }),
);

/**
 * Whether the analysis board of this tab shows its tab strip hidden right now. Written by the
 * mounted `BoardAnalysis`: a stored hidden strip still shows in the stacked and too-narrow layouts.
 */
export const boardTabsHiddenFamily = tabAtomFamily((_tab: string) => atom(false));

/** The View menu offers "Show the tabs" only while the active analysis tab's strip is hidden. */
export const currentBoardTabsHiddenAtom = atom((get) => {
    const tab = get(currentTabAtom);
    return tab?.type === "analysis" && get(boardTabsHiddenFamily(tab.value));
});
