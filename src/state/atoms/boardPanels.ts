/** Per-tab board view and panel state. */
import { atom, getDefaultStore } from "jotai";
import { defaultPanelTabAtom, hidePreviewMovesAtom } from "./preferences";
import { tabAtomFamily } from "./tabFamilies";

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
