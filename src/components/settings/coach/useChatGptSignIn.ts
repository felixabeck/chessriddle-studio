import { useCallback, useEffect, useRef, useState } from "react";
import type { CoachError, ConnectionSaved } from "@/bindings";
import { coachErrorCode } from "@/platform/coach";
import { warn } from "@/platform/native";
import { tauri } from "@/platform/tauri";

export type ChatGptSignInState =
    | { status: "idle" }
    /** The browser is open; the native side waits for the user to come back. */
    | { status: "waiting" }
    | { status: "failed"; error: CoachError };

function cancelAttempt(attempt: string) {
    tauri.coachCancelSignIn(attempt).catch((cause: unknown) => {
        void warn(`Coach sign-in could not be cancelled: ${String(cause)}`);
    });
}

/**
 * One ChatGPT sign-in at a time, owned by the component that shows it. The attempt has an id of
 * its own: only the answer of the attempt that is still current is used, the user's cancel names
 * it, and leaving the page cancels it, so no browser sign-in is waited for behind the user's back.
 */
export function useChatGptSignIn(onSignedIn: (saved: ConnectionSaved) => void) {
    const [state, setState] = useState<ChatGptSignInState>({ status: "idle" });
    const current = useRef<string | null>(null);
    const signedIn = useRef(onSignedIn);
    signedIn.current = onSignedIn;

    useEffect(
        () => () => {
            const attempt = current.current;
            current.current = null;
            if (attempt) cancelAttempt(attempt);
        },
        [],
    );

    const start = useCallback(async () => {
        if (current.current) return;
        const attempt = crypto.randomUUID();
        current.current = attempt;
        setState({ status: "waiting" });
        let next: ChatGptSignInState = { status: "idle" };
        let saved: ConnectionSaved | null = null;
        try {
            saved = await tauri.coachSignInChatgpt(attempt);
        } catch (cause) {
            const error = coachErrorCode(cause);
            // A sign-in the user cancelled needs no message.
            if (error !== "cancelled") next = { status: "failed", error };
        }
        // An attempt that was cancelled by leaving, or replaced, has nobody to tell.
        if (current.current !== attempt) return;
        current.current = null;
        setState(next);
        if (saved) signedIn.current(saved);
    }, []);

    const cancel = useCallback(() => {
        if (current.current) cancelAttempt(current.current);
    }, []);

    return { state, start, cancel };
}
