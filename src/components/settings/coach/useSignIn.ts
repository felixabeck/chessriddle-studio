import { useCallback, useEffect, useRef, useState } from "react";
import type { CoachError, ConnectionSaved, GrokCode } from "@/bindings";
import { coachErrorCode } from "@/platform/coach";
import { warn } from "@/platform/native";
import { tauri } from "@/platform/tauri";

export type SignInState<Shown> =
    | { status: "idle" }
    /** The native side waits for the user in the browser; `shown` is what the user needs for it. */
    | { status: "waiting"; shown: Shown | null }
    | { status: "failed"; error: CoachError };

/**
 * Runs one sign-in to its connection. `attempt` is the id the native side knows it by; `show`
 * hands over what the user needs while they are away.
 */
type SignInRun<Shown> = (attempt: string, show: (shown: Shown) => void) => Promise<ConnectionSaved>;

function cancelAttempt(attempt: string) {
    tauri.coachCancelSignIn(attempt).catch((cause: unknown) => {
        void warn(`Coach sign-in could not be cancelled: ${String(cause)}`);
    });
}

/**
 * One sign-in at a time, owned by the component that shows it. The attempt has an id of its own:
 * only the answer of the attempt that is still current is used, the user's cancel names it, and
 * leaving the page cancels it, so no browser sign-in is waited for behind the user's back.
 */
function useSignIn<Shown>(run: SignInRun<Shown>, onSignedIn: (saved: ConnectionSaved) => void) {
    const [state, setState] = useState<SignInState<Shown>>({ status: "idle" });
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
        setState({ status: "waiting", shown: null });
        let next: SignInState<Shown> = { status: "idle" };
        let saved: ConnectionSaved | null = null;
        try {
            saved = await run(attempt, (shown) => {
                if (current.current === attempt) setState({ status: "waiting", shown });
            });
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
    }, [run]);

    const cancel = useCallback(() => {
        if (current.current) cancelAttempt(current.current);
    }, []);

    return { state, start, cancel };
}

const chatGpt: SignInRun<never> = (attempt) => tauri.coachSignInChatgpt(attempt);

/** The browser sign-in with ChatGPT: one command that returns when the user is back. */
export function useChatGptSignIn(onSignedIn: (saved: ConnectionSaved) => void) {
    return useSignIn(chatGpt, onSignedIn);
}

const grok: SignInRun<GrokCode> = async (attempt, show) => {
    show(await tauri.coachBeginGrokSignIn(attempt));
    return tauri.coachFinishGrokSignIn(attempt);
};

/** The sign-in with Grok: the user enters the shown code on the provider's page. */
export function useGrokSignIn(onSignedIn: (saved: ConnectionSaved) => void) {
    return useSignIn(grok, onSignedIn);
}
