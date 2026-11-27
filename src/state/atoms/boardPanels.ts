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

/**
 * Transient per-tab focus of a Game Review key moment. Never persisted; disposed with the tab.
 * The board draws the review arrows only while all four identity fields match the tab's present
 * document, position and report summary, and clears the focus once the board leaves that position.
 */
export interface ReviewFocus {
    documentId: number;
    /** Path to the position before the focused move. */
    path: number[];
    /** Full FEN of the position before the focused move. */
    fen: string;
    /** `summary.createdAt` of the report summary this focus was made under, or `null` when none. */
    summaryCreatedAt: number | null;
    /** Played move in SAN from the focused position. */
    playedSan: string | null;
    /** Engine's better move in SAN from the focused position, when known. */
    betterSan: string | null;
}

export interface ReviewFocusTarget {
    documentId: number;
    path: readonly number[];
    fen: string;
    summaryCreatedAt: number | null;
}

/** True only while `focus` matches the tab's present document, path, FEN and report summary. */
export function matchesReviewFocus(
    focus: ReviewFocus | null,
    present: ReviewFocusTarget,
): focus is ReviewFocus {
    if (focus === null) return false;
    if (
        focus.documentId !== present.documentId ||
        focus.fen !== present.fen ||
        focus.summaryCreatedAt !== present.summaryCreatedAt ||
        focus.path.length !== present.path.length
    ) {
        return false;
    }
    for (let i = 0; i < focus.path.length; i++) {
        if (focus.path[i] !== present.path[i]) return false;
    }
    return true;
}

export const reviewFocusFamily = tabAtomFamily((_tab: string) => atom<ReviewFocus | null>(null));

/** Maximum age of a Game Review Coach explanation request before it is dropped (D8). */
export const COACH_EXPLAIN_REQUEST_MAX_AGE_MS = 30_000;

/**
 * Transient per-tab request from Game Review ("Explain") to the Coach panel (O7). Never
 * persisted; disposed with the tab. At most one request per tab exists; a newer one replaces it.
 */
export interface CoachExplainRequest {
    id: string;
    documentId: number;
    /** Full FEN of the focused position (before the played move). */
    fen: string;
    /** Click time (`Date.now()`); requests older than `COACH_EXPLAIN_REQUEST_MAX_AGE_MS` are dropped. */
    clickedAt: number;
    question: string;
}

export const coachExplainRequestFamily = tabAtomFamily((_tab: string) =>
    atom<CoachExplainRequest | null>(null),
);

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
