import { atom } from "jotai";
import { loadable } from "jotai/utils";
import { logFailureSafely, safeFailureContext } from "@/platform/errors";
import { tauri } from "@/platform/tauri";

/**
 * Whether this build has the Coach. Read once per document: the native switch cannot change while
 * the app runs. A failed read counts as "not available" so nothing of the Coach is rendered.
 */
const coachAvailableAtom = atom(async () => {
    try {
        return await tauri.coachAvailable();
    } catch {
        return false;
    }
});
const coachAvailableLoadableAtom = loadable(coachAvailableAtom);

/** `true` only once the native side has confirmed the Coach; `false` while that is still unknown. */
export const coachEnabledAtom = atom((get) => {
    const available = get(coachAvailableLoadableAtom);
    return available.state === "hasData" && available.data;
});

const assistantHasConnectionAtom = atom(false);
const assistantHasConnectionRequestAtom = atom(0);

/**
 * Re-checks whether at least one AI connection exists in the credential registry (no keyring read).
 * Runs only when the Coach is available; unknown or failed answers keep the Assistant entries hidden.
 */
export const refreshAssistantAvailabilityAtom = atom(null, async (get, set) => {
    const request = get(assistantHasConnectionRequestAtom) + 1;
    set(assistantHasConnectionRequestAtom, request);
    if (!get(coachEnabledAtom)) {
        set(assistantHasConnectionAtom, false);
        return;
    }
    try {
        const hasConnection = await tauri.coachHasConnection();
        if (get(assistantHasConnectionRequestAtom) === request) {
            set(assistantHasConnectionAtom, hasConnection);
        }
    } catch (cause) {
        if (get(assistantHasConnectionRequestAtom) === request) {
            set(assistantHasConnectionAtom, false);
        }
        const primaryFailure = safeFailureContext(cause);
        void logFailureSafely(
            `Assistant availability check failed: ${primaryFailure.message}`,
            { operation: "assistant-availability", primaryFailure },
            "assistant-availability",
        );
    }
});

/** `true` only when the Coach is available and at least one connection has been confirmed. */
export const assistantAvailableAtom = atom(
    (get) => get(coachEnabledAtom) && get(assistantHasConnectionAtom),
);

/** Whether the docked Assistant panel is open in this window (in memory only). */
export const assistantPanelOpenAtom = atom(false);
