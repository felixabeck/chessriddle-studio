import { useNavigate } from "@tanstack/react-router";
import { useStore as useAtomStore } from "jotai";
import { useMemo } from "react";
import { useOpenFeedback } from "@/components/feedback/openFeedbackContext";
import type { AssistantTargetActions } from "./targets";

export type AssistantPageOpeners = {
    createNewTab: () => void | Promise<unknown>;
    openAccounts: () => void | Promise<unknown>;
    openEngines: () => void | Promise<unknown>;
    openSettings: () => void | Promise<unknown>;
};

/**
 * Builds the `AssistantTargetActions` shared by the Assistant transcript and the Guide page.
 * Callers supply the four page/tab openers; this hook wires `openLibrary`, `openFeedback`, and
 * the active Jotai store.
 */
export function useAssistantTargetActions({
    createNewTab,
    openAccounts,
    openEngines,
    openSettings,
}: AssistantPageOpeners): AssistantTargetActions {
    const navigate = useNavigate();
    const store = useAtomStore();
    const openFeedback = useOpenFeedback();

    return useMemo<AssistantTargetActions>(
        () => ({
            createNewTab,
            openLibrary: () => navigate({ to: "/library" }),
            openEngines,
            openAccounts,
            openSettings,
            openFeedback,
            store,
        }),
        [createNewTab, navigate, openAccounts, openEngines, openFeedback, openSettings, store],
    );
}
