import { createContext } from "react";

/**
 * Replaces how the notation deletes a move. Without a provider the Delete key and the move menu
 * edit the tree store directly. A live game provides one, because its tree mirrors the native
 * game: a deletion has to go through the native authority, never mutate the tree behind it.
 */
export type MoveDeletion = {
    /** Whether deleting the move at `path` is offered at all. */
    canDelete: (path: number[]) => boolean;
    /** Deletes the move at `path`; a no-op when `canDelete(path)` is false. */
    delete: (path: number[]) => void;
};

export const MoveDeletionContext = createContext<MoveDeletion | undefined>(undefined);
