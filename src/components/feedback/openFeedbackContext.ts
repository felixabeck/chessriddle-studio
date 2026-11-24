import { createContext, useContext } from "react";
import type { FeedbackType } from "@/bindings";

export type FeedbackDraft = {
    type?: FeedbackType;
    message?: string;
};

export const OpenFeedbackContext = createContext<((draft?: FeedbackDraft) => void) | null>(null);

/** Opens the root feedback modal, optionally prefilled with an initial type and message. */
export function useOpenFeedback(): (draft?: FeedbackDraft) => void {
    const open = useContext(OpenFeedbackContext);
    if (!open) throw new Error("useOpenFeedback used outside RootLayout");
    return open;
}
