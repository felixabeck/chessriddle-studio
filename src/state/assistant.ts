import { atom } from "jotai";
import type {
    AssistantFeedbackDraft,
    AssistantHistoryMessage,
    AssistantSegment,
    CoachError,
} from "@/bindings";
import { createNoticeAcceptedAtom, withNoticeAccepted } from "./coach";
import {
    assistantAvailableAtom,
    assistantPanelOpenAtom,
    refreshAssistantAvailabilityAtom,
} from "./coachAvailability";

export { assistantAvailableAtom, assistantPanelOpenAtom, refreshAssistantAvailabilityAtom };

/**
 * The connections for which the user accepted the Assistant's own first-use notice.
 * Separate from the Coach's acceptance; corrupt or oversized stored values count as not accepted.
 */
export const assistantNoticeAcceptedAtom = createNoticeAcceptedAtom("assistant-notice-accepted", {
    getOnInit: true,
});

export const withAssistantNoticeAccepted = withNoticeAccepted;

export const MAX_ASSISTANT_MESSAGES = 60;
export const MAX_ASSISTANT_CONVERSATION_BYTES = 96 * 1024;

export type AssistantUserMessage = {
    id: string;
    role: "user";
    text: string;
};

export type AssistantLocalError = "topicsLoadFailed";

export type AssistantAnswerMessage = {
    id: string;
    role: "assistant";
    segments: AssistantSegment[];
    state: "completed" | "cancelled" | "failed";
    error?: CoachError;
    localError?: AssistantLocalError;
    feedbackDraft?: AssistantFeedbackDraft | null;
};

export type AssistantMessage = AssistantUserMessage | AssistantAnswerMessage;

export type AssistantConversation = {
    id: string;
    messages: AssistantMessage[];
};

export type AssistantRunningTurn = {
    question: string;
    /** The text streamed in the running round. */
    text: string;
    /** Help topic ids the Assistant is currently reading, or `null`. */
    readingTopics: string[] | null;
    /** A stop was requested; the turn's end has not arrived yet. */
    stopping: boolean;
    /** The conversation the turn belonged to was discarded; it only still has to end. */
    orphaned: boolean;
};

export function newAssistantConversation(): AssistantConversation {
    return { id: crypto.randomUUID(), messages: [] };
}

/** In-memory conversation of this window. Never persisted to web storage. */
export const assistantConversationAtom = atom<AssistantConversation>(newAssistantConversation());

/** The currently running Assistant turn in this window, if any. */
export const assistantRunningTurnAtom = atom<AssistantRunningTurn | null>(null);

export function assistantAnswerText(message: AssistantAnswerMessage): string {
    return message.segments
        .map((segment) => (segment.type === "text" ? segment.text : `[[${segment.target}]]`))
        .join("");
}

function messageBytes(message: AssistantMessage): number {
    if (message.role === "user") return message.text.length * 2;
    let chars = assistantAnswerText(message).length;
    if (message.feedbackDraft) chars += message.feedbackDraft.message.length;
    return chars * 2;
}

/** Bounds the in-memory conversation by dropping the oldest messages first. */
export function boundAssistantConversation(
    conversation: AssistantConversation,
): AssistantConversation {
    let messages = conversation.messages.slice(-MAX_ASSISTANT_MESSAGES);
    let totalBytes = messages.reduce((sum, message) => sum + messageBytes(message), 0);
    while (messages.length > 1 && totalBytes > MAX_ASSISTANT_CONVERSATION_BYTES) {
        totalBytes -= messageBytes(messages[0]);
        messages = messages.slice(1);
    }
    return { ...conversation, messages };
}

/**
 * The conversation sent back to the model: each question with its completed answer, oldest first.
 * Exchanges whose turn was cancelled or failed are omitted.
 */
export function assistantHistory(conversation: AssistantConversation): AssistantHistoryMessage[] {
    const history: AssistantHistoryMessage[] = [];
    const { messages } = conversation;
    for (let index = 0; index + 1 < messages.length; index++) {
        const question = messages[index];
        const answer = messages[index + 1];
        if (
            question.role === "user" &&
            answer.role === "assistant" &&
            answer.state === "completed"
        ) {
            history.push({ role: "user", text: question.text });
            history.push({ role: "assistant", text: assistantAnswerText(answer) });
            index++;
        }
    }
    return history;
}
