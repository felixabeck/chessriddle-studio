/** In-memory opponent preparation state and per-tab preparation views. */
import { atom } from "jotai";
import type { OpponentPeriod } from "@/state/opponentLinks";
import type { IndexedRepertoireFile } from "@/state/repertoireIndex";
import type {
    PreparationColor,
    PreparationSource,
    PreparationViews,
} from "@/utils/opponentPreparation";
import { tabAtomFamily } from "./tabFamilies";

/** Identity fields that determine whether a stored preparation matches the current selection. */
export type PreparationIdentity = {
    workspaceKey: string;
    cardDatabaseKey: string;
    playerId: number;
    onlineSource: { fileKey: string; playerId: number } | null;
    opponentColor: PreparationColor;
    period: OpponentPeriod;
};

/** Canonical string key for comparing preparation identities. */
export function preparationIdentityKey(identity: PreparationIdentity): string {
    const online = identity.onlineSource
        ? `${identity.onlineSource.fileKey}:${identity.onlineSource.playerId}`
        : "none";
    const period = identity.period === null ? "all" : String(identity.period);
    return [
        identity.workspaceKey,
        identity.cardDatabaseKey,
        String(identity.playerId),
        online,
        identity.opponentColor,
        period,
    ].join("\0");
}

/**
 * The single in-memory opponent preparation result. Bounded by the repertoire index bounds; a new
 * identity replaces it and a webview reload discards it.
 */
export type StoredOpponentPreparation = {
    id: string;
    identityKey: string;
    cardDatabaseKey: string;
    playerId: number;
    opponentName: string;
    opponentColor: PreparationColor;
    period: OpponentPeriod;
    source: PreparationSource;
    views: PreparationViews;
    /** Repertoire snapshot files this preparation was matched against (reference, not a copy). */
    files: readonly IndexedRepertoireFile[];
    partial: boolean;
    onlineFailed: boolean;
};

export const opponentPreparationAtom = atom<StoredOpponentPreparation | null>(null);

/** One-shot landing target consumed when the chapter's tree is shown in `BoardAnalysis`. */
export type PreparationLanding = {
    path: number[];
    boardState: string;
};

/** Tab-scoped preparation view state, disposed with the tab via `tabAtomFamily`. */
export type TabPreparationView = {
    preparationId: string;
    landing: PreparationLanding | null;
    showAllLines: boolean;
};

export const tabPreparationViewFamily = tabAtomFamily((_tabId: string) =>
    atom<TabPreparationView | null>(null),
);
