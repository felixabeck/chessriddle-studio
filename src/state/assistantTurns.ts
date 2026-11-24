import type { createStore } from "jotai";
import type {
    AssistantContext,
    AssistantLinkTarget,
    AssistantSetting,
    AssistantTurnEvent,
    AssistantTurnInput,
    AssistantTurnUpdate,
    CoachError,
} from "@/bindings";
import { loadHelpTopics } from "@/components/assistant/topics";
import { coachErrorCode } from "@/platform/coach";
import { logFailureSafely, safeFailureContext, warnSafely } from "@/platform/errors";
import { tauri } from "@/platform/tauri";
import {
    assistantConversationAtom,
    assistantHistory,
    assistantRunningTurnAtom,
    boundAssistantConversation,
    newAssistantConversation,
    type AssistantAnswerMessage,
    type AssistantRunningTurn,
} from "./assistant";

type Atoms = ReturnType<typeof createStore>;
type TerminalUpdate = Extract<AssistantTurnUpdate, { type: "completed" | "cancelled" | "failed" }>;

type ActiveTurn = {
    /** Renderer-minted turn id carried on every `AssistantTurnEvent`. */
    turnId: string;
    /** Native read reservation ticket; `null` until `prepareNativeRead` succeeds. */
    ticket: string | null;
    /** Conversation id that started this turn; a discarded conversation never receives its answer. */
    conversationId: string;
    question: string;
    stopRequested: boolean;
    orphaned: boolean;
};

let activeTurn: ActiveTurn | null = null;

export type AssistantSendRequest = {
    question: string;
    connection: string;
    model: string;
    /** `null` sends no effort: the provider's default applies. */
    effort: string | null;
    context: AssistantContext;
    settings: AssistantSetting[];
    targets: AssistantLinkTarget[];
    t: (key: string) => string;
};

function publish(
    atoms: Atoms,
    update: (turn: AssistantRunningTurn | null) => AssistantRunningTurn | null,
) {
    atoms.set(assistantRunningTurnAtom, update);
}

function cancelTicket(ticket: string) {
    tauri.cancelNativeRead(ticket).catch((cause: unknown) => {
        warnSafely(`Assistant turn could not be cancelled: ${String(cause)}`);
    });
}

function requestStop(active: ActiveTurn) {
    active.stopRequested = true;
    if (active.ticket === null) return;
    cancelTicket(active.ticket);
}

function answerOf(update: TerminalUpdate): AssistantAnswerMessage {
    const base = {
        id: crypto.randomUUID(),
        role: "assistant" as const,
    };
    if (update.type === "completed") {
        return {
            ...base,
            segments: update.segments,
            state: "completed",
            feedbackDraft: update.feedbackDraft,
        };
    }
    const segments = update.text ? [{ type: "text" as const, text: update.text }] : [];
    return update.type === "cancelled"
        ? { ...base, segments, state: "cancelled" }
        : { ...base, segments, state: "failed", error: update.error };
}

function appendExchange(atoms: Atoms, active: ActiveTurn, answer: AssistantAnswerMessage) {
    const conversation = atoms.get(assistantConversationAtom);
    if (active.orphaned || conversation.id !== active.conversationId) return;
    atoms.set(
        assistantConversationAtom,
        boundAssistantConversation({
            ...conversation,
            messages: [
                ...conversation.messages,
                { id: crypto.randomUUID(), role: "user", text: active.question },
                answer,
            ],
        }),
    );
}

/** Ends a turn exactly once and appends its exchange if it still belongs to the active conversation. */
function finish(atoms: Atoms, active: ActiveTurn, update: TerminalUpdate) {
    if (activeTurn !== active) return;
    activeTurn = null;
    publish(atoms, () => null);
    appendExchange(atoms, active, answerOf(update));
}

function failed(error: CoachError): TerminalUpdate {
    return { type: "failed", error, text: "" };
}

/**
 * Starts one Assistant turn for this window. Returns immediately if a turn is already running.
 * Loads help topics lazily, reserves a window-owned native read ticket, and cancels it on stop,
 * "New conversation", or command rejection.
 */
export async function sendAssistantMessage(
    atoms: Atoms,
    request: AssistantSendRequest,
): Promise<void> {
    if (activeTurn !== null) return;
    const conversation = atoms.get(assistantConversationAtom);
    const active: ActiveTurn = {
        turnId: crypto.randomUUID(),
        ticket: null,
        conversationId: conversation.id,
        question: request.question,
        stopRequested: false,
        orphaned: false,
    };
    activeTurn = active;
    publish(atoms, () => ({
        question: request.question,
        text: "",
        readingTopics: null,
        stopping: false,
        orphaned: false,
    }));

    const abandoned = () =>
        active.stopRequested ||
        active.orphaned ||
        atoms.get(assistantConversationAtom).id !== active.conversationId;

    let topics;
    try {
        topics = await loadHelpTopics(request.t);
    } catch (cause) {
        const primaryFailure = safeFailureContext(cause);
        void logFailureSafely(
            `Assistant help topics failed to load: ${primaryFailure.message}`,
            { operation: "assistant-topics-load", primaryFailure },
            "assistant-topics-load",
        );
        if (activeTurn !== active) return;
        activeTurn = null;
        publish(atoms, () => null);
        appendExchange(atoms, active, {
            id: crypto.randomUUID(),
            role: "assistant",
            segments: [],
            state: "failed",
            localError: "topicsLoadFailed",
        });
        return;
    }

    if (abandoned()) {
        finish(atoms, active, { type: "cancelled", text: "" });
        return;
    }

    let ticket: string;
    try {
        ticket = await tauri.prepareNativeRead();
    } catch {
        finish(atoms, active, failed("busy"));
        return;
    }
    active.ticket = ticket;

    if (abandoned()) {
        requestStop(active);
        finish(atoms, active, { type: "cancelled", text: "" });
        return;
    }

    const input: AssistantTurnInput = {
        connection: request.connection,
        model: request.model,
        effort: request.effort ?? undefined,
        history: assistantHistory(atoms.get(assistantConversationAtom)),
        message: request.question,
        context: request.context,
        topics,
        settings: request.settings,
        targets: request.targets,
    };

    try {
        const terminal = await tauri.assistantTurn(active.turnId, ticket, input);
        finishAssistantTurn(atoms, active.turnId, terminal);
    } catch (cause) {
        // The turn never started or failed to invoke; releasing an already-released ticket is safe.
        requestStop(active);
        finishAssistantTurn(atoms, active.turnId, failed(coachErrorCode(cause)));
    }
}

function finishAssistantTurn(atoms: Atoms, turnId: string, update: AssistantTurnUpdate) {
    if (!activeTurn || activeTurn.turnId !== turnId) return;
    if (update.type === "completed" || update.type === "cancelled" || update.type === "failed") {
        finish(atoms, activeTurn, update);
    }
}

/** Routes one Assistant turn event. Events for unknown or retired turn ids are dropped. */
export function applyAssistantTurnEvent(atoms: Atoms, event: AssistantTurnEvent) {
    const active = activeTurn;
    if (!active || active.turnId !== event.turn) return;
    const { update } = event;
    switch (update.type) {
        case "text":
            publish(
                atoms,
                (turn) => turn && { ...turn, text: turn.text + update.delta, readingTopics: null },
            );
            break;
        case "reset":
            publish(atoms, (turn) => turn && { ...turn, text: "" });
            break;
        case "readingTopics":
            publish(atoms, (turn) => turn && { ...turn, readingTopics: update.topics });
            break;
        default:
            finish(atoms, active, update);
    }
}

/** Asks the running Assistant turn to stop. Its terminal update delivers any text streamed so far. */
export function stopAssistantTurn(atoms: Atoms) {
    const active = activeTurn;
    if (!active || active.stopRequested) return;
    publish(atoms, (turn) => turn && { ...turn, stopping: true });
    requestStop(active);
}

/** Starts a fresh conversation. Any running turn is stopped and its late answer is discarded. */
export function startNewAssistantConversation(atoms: Atoms) {
    const active = activeTurn;
    if (active) {
        active.orphaned = true;
        publish(atoms, (turn) => turn && { ...turn, stopping: true, orphaned: true });
        if (!active.stopRequested) requestStop(active);
    }
    atoms.set(assistantConversationAtom, newAssistantConversation());
}

/** Test seam: whether an Assistant turn is currently active. */
export function activeAssistantTurnCount(): number {
    return activeTurn ? 1 : 0;
}

/** Test seam: clears any in-flight turn reference between unit tests. */
export function resetAssistantTurnForTests(): void {
    activeTurn = null;
}
