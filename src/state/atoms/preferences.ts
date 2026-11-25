/** App-wide display, board, sound and session preferences. */
import type { SetStateAction } from "react";
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { z } from "zod";
import {
    getSessionPersistenceSnapshot,
    savePublicSessions,
    subscribeSessionPersistence,
    type Session,
    type SessionPersistenceSnapshot,
} from "../../utils/session";
import { createPreferenceStorage, createZodStorage } from "../utils";
import { FONT_SCALE_DEFAULT, fontScaleSchema } from "../fontScale";
import { soundCollectionSchema, soundVolumeSchema } from "../preferenceSchemas";
import { PIECE_SCALE_DEFAULT, pieceScaleSchema } from "../pieceScale";
import {
    LAST_MOVE_HIGHLIGHT_COLOR_DEFAULT,
    LAST_MOVE_HIGHLIGHT_OPACITY_DEFAULT,
    lastMoveHighlightColorSchema,
    lastMoveHighlightOpacitySchema,
} from "../lastMoveHighlight";
import {
    DEFAULT_BOARD_IMAGE,
    DEFAULT_PIECE_SET,
    boardImageSchema,
    pieceSetSchema,
    type BoardImage,
    type PieceSet,
} from "../artworkCatalog";
import { documentPreferences } from "./rendererState";

export const tableViewAtom = atomWithStorage<boolean>(
    "table-view",
    false,
    createPreferenceStorage(false),
);

export const fontSizeAtom = atomWithStorage(
    "font-size",
    FONT_SCALE_DEFAULT,
    createZodStorage(fontScaleSchema, localStorage),
);

export const pieceSizeAtom = atomWithStorage(
    "piece-size",
    PIECE_SCALE_DEFAULT,
    createZodStorage(pieceScaleSchema, localStorage),
);

export const moveNotationTypeAtom = atomWithStorage<"letters" | "symbols">(
    "letters",
    "symbols",
    createZodStorage(z.enum(["letters", "symbols"]), localStorage),
);
export const moveMethodAtom = atomWithStorage<"drag" | "select" | "both">(
    "move-method",
    "both",
    createZodStorage(z.enum(["drag", "select", "both"]), localStorage),
);
export const spellCheckAtom = atomWithStorage<boolean>(
    "spell-check",
    false,
    createPreferenceStorage(false),
);
export const moveInputAtom = atomWithStorage<boolean>(
    "move-input",
    false,
    createPreferenceStorage(false),
);
export const showDestsAtom = atomWithStorage<boolean>(
    "show-dests",
    true,
    createPreferenceStorage(true),
);
export const moveHighlightAtom = atomWithStorage<boolean>(
    "move-highlight",
    true,
    createPreferenceStorage(true),
);
export const lastMoveHighlightColorAtom = atomWithStorage<string>(
    "last-move-highlight-color",
    LAST_MOVE_HIGHLIGHT_COLOR_DEFAULT,
    createZodStorage(lastMoveHighlightColorSchema, localStorage),
);
export const lastMoveHighlightOpacityAtom = atomWithStorage<number>(
    "last-move-highlight-opacity",
    LAST_MOVE_HIGHLIGHT_OPACITY_DEFAULT,
    createZodStorage(lastMoveHighlightOpacitySchema, localStorage),
);
export const snapArrowsAtom = atomWithStorage<boolean>(
    "snap-dests",
    true,
    createPreferenceStorage(true),
);
export const showArrowsAtom = atomWithStorage<boolean>(
    "show-arrows",
    true,
    createPreferenceStorage(true),
);
export const showConsecutiveArrowsAtom = atomWithStorage<boolean>(
    "show-consecutive-arrows",
    false,
    createPreferenceStorage(false),
);
export const showVariationArrowsAtom = atomWithStorage<boolean>(
    "show-variation-arrows",
    false,
    createPreferenceStorage(false),
);
export const eraseDrawablesOnClickAtom = atomWithStorage<boolean>(
    "erase-drawables-on-click",
    true,
    createPreferenceStorage(true),
);
export const autoPromoteAtom = atomWithStorage<boolean>(
    "auto-promote",
    true,
    createPreferenceStorage(true),
);
export const autoSaveAtom = atomWithStorage<boolean>(
    "auto-save",
    true,
    createPreferenceStorage(true),
);
export const previewBoardOnHoverAtom = atomWithStorage<boolean>(
    "preview-board-on-hover",
    true,
    createPreferenceStorage(true),
);
export const flipBoardAfterMoveAtom = atomWithStorage<boolean>(
    "flip-board-after-move",
    true,
    createPreferenceStorage(true),
);
export const enableBoardScrollAtom = atomWithStorage<boolean>(
    "board-scroll",
    true,
    createPreferenceStorage(true),
);
/** Next move at a branch point opens a list of every continuation instead of following the main line. */
export const chooseVariationAtom = atomWithStorage<boolean>(
    "choose-variation",
    true,
    createPreferenceStorage(true),
);
/** How captured material shows beside the players: surplus only, every capture, or not at all. */
export const MATERIAL_DISPLAY_MODES = ["diff", "all", "none"] as const;
export type MaterialDisplay = (typeof MATERIAL_DISPLAY_MODES)[number];
export const materialDisplayAtom = atomWithStorage<MaterialDisplay>(
    "material-display",
    "diff",
    createZodStorage(z.enum(MATERIAL_DISPLAY_MODES), localStorage),
);
/** Hide notation in game previews, and in games opened from those previews. */
// Hydrated with the document's eager preferences, so opening a game from a preview
// sees the stored choice even when no preview or settings page has mounted it.
export const hidePreviewMovesAtom = documentPreferences.atomWithStorage<boolean>(
    "hide-preview-moves",
    false,
    createPreferenceStorage(false),
);
export const BOARD_ANIMATION_SPEEDS = ["off", "fast", "normal", "slow"] as const;
export type BoardAnimationSpeed = (typeof BOARD_ANIMATION_SPEEDS)[number];
/** Piece movement animation length in milliseconds; "off" disables animation. */
export const BOARD_ANIMATION_DURATION_MS: Record<Exclude<BoardAnimationSpeed, "off">, number> = {
    fast: 100,
    normal: 200,
    slow: 400,
};
export const boardAnimationSpeedAtom = atomWithStorage<BoardAnimationSpeed>(
    "board-animation-speed",
    "normal",
    createZodStorage(z.enum(BOARD_ANIMATION_SPEEDS), localStorage),
);
/** Side-panel tab a board opens on. Practice is not offered: repertoires open it only on request. */
export const DEFAULT_PANEL_TABS = ["info", "analysis", "database", "annotate"] as const;
export type DefaultPanelTab = (typeof DEFAULT_PANEL_TABS)[number];
// Hydrated with the document's eager preferences, so `tabFamily` sees the stored choice even when
// no settings page has mounted it.
export const defaultPanelTabAtom = documentPreferences.atomWithStorage<DefaultPanelTab>(
    "default-panel-tab",
    "info",
    createZodStorage(z.enum(DEFAULT_PANEL_TABS), localStorage),
);
export const showCoordinatesAtom = documentPreferences.atomWithStorage<"no" | "edge" | "all">(
    "show-coordinates-v2",
    "no",
    createZodStorage(z.enum(["no", "edge", "all"]), localStorage),
);
export const soundCollectionAtom = documentPreferences.atomWithStorage<string>(
    "sound-collection",
    "standard",
    createZodStorage<string>(soundCollectionSchema, localStorage),
);

export const soundVolumeAtom = documentPreferences.atomWithStorage<number>(
    "sound-volume",
    0.8,
    createZodStorage(soundVolumeSchema, localStorage),
);

export const pieceSetAtom = atomWithStorage<PieceSet>(
    "piece-set",
    DEFAULT_PIECE_SET,
    createZodStorage(pieceSetSchema, localStorage),
);
export const boardImageAtom = atomWithStorage<BoardImage>(
    "board-image",
    DEFAULT_BOARD_IMAGE,
    createZodStorage(boardImageSchema, localStorage),
);
export const boardWoodTextureAtom = atomWithStorage<boolean>(
    "board-wood-texture",
    true,
    createPreferenceStorage(true),
);
// Mount and remount synchronize with the document owner, never with an absent or stale key.
const sessionStateAtom = atom<SessionPersistenceSnapshot | null>(null);
sessionStateAtom.onMount = (setSnapshot) => {
    const synchronize = () => setSnapshot(getSessionPersistenceSnapshot());
    const unsubscribe = subscribeSessionPersistence(synchronize);
    synchronize();
    return unsubscribe;
};
export const sessionsAtom = atom(
    (get) => (get(sessionStateAtom) ?? getSessionPersistenceSnapshot()).sessions,
    (_get, set, update: SetStateAction<Session[]>) => {
        const current = getSessionPersistenceSnapshot().sessions;
        const snapshot = savePublicSessions(
            typeof update === "function" ? update(current) : update,
        );
        set(sessionStateAtom, snapshot);
    },
);
export const nativeBarAtom = atomWithStorage<boolean>(
    "native-bar",
    false,
    createPreferenceStorage(false),
);
