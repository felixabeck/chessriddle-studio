import { z } from "zod";
import type { CoachError, Segment, ToolSource } from "@/bindings";
import { isCoachError } from "@/platform/coach";
import { serializeStorageValue } from "./store/debouncedStorage";

/**
 * The Coach conversation of one tab. It is part of the tab's stored tree, next to the puzzle
 * session, so it lives exactly as long as the tab and goes with it. It never marks the game
 * unsaved and is never written into a PGN.
 */

export const MAX_COACH_MESSAGES = 60;
/** Bound on the stored size of a conversation, measured as it is written to tab storage. */
export const MAX_COACH_SESSION_BYTES = 96 * 1024;
const MAX_ID_LENGTH = 64;
const MAX_TEXT_LENGTH = 64 * 1024;
const MAX_SEGMENTS = 400;
const MAX_LINE_PLIES = 40;
const MAX_MOVE_LENGTH = 12;
const MAX_FEN_LENGTH = 256;
/** A path is as long as a tab's tree is deep at most (`MAX_TREE_DEPTH` in `store/tabStorage.ts`). */
export const MAX_COACH_PATH_LENGTH = 2048;
/** Appended to a message that had to be cut to fit the conversation's bound. */
export const COACH_TRUNCATION_MARK = " […]";

const idSchema = z.string().min(1).max(MAX_ID_LENGTH);
const textSchema = z.string().max(MAX_TEXT_LENGTH);
const moveSchema = z.string().min(1).max(MAX_MOVE_LENGTH);
const lineSchema = z.array(moveSchema).min(1).max(MAX_LINE_PLIES);

const segmentSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: textSchema }),
    z.object({ type: z.literal("line"), san: lineSchema, uci: lineSchema }),
]) satisfies z.ZodType<Segment>;

const userMessageSchema = z.object({
    id: idSchema,
    role: z.literal("user"),
    text: textSchema,
});

const coachMessageSchema = z.object({
    id: idSchema,
    role: z.literal("coach"),
    segments: z.array(segmentSchema).max(MAX_SEGMENTS),
    /** How the turn ended. Only a completed answer is sent back to the model as history. */
    state: z.enum(["completed", "cancelled", "failed"]),
    error: z.custom<CoachError>(isCoachError).optional(),
    /** Lines the model wrote that are not legal; they are in `segments` as plain text. */
    failedLines: z.number().int().nonnegative().optional(),
    /** The position the question was asked about: its FEN and its path in the tree then. */
    fen: z.string().min(1).max(MAX_FEN_LENGTH),
    path: z.array(z.number().int().nonnegative()).max(MAX_COACH_PATH_LENGTH),
});

const messageSchema = z.discriminatedUnion("role", [userMessageSchema, coachMessageSchema]);

export type CoachUserMessage = z.infer<typeof userMessageSchema>;
export type CoachAnswerMessage = z.infer<typeof coachMessageSchema>;
export type CoachMessage = z.infer<typeof messageSchema>;

const sessionShape = z.object({
    version: z.literal(1),
    /** Identity of the conversation: "New conversation" and a new game start another one. */
    id: idSchema,
    messages: z.array(messageSchema),
});
export type CoachSession = z.infer<typeof sessionShape>;

export function coachSessionBytes(session: CoachSession): number {
    return serializeStorageValue(session).length * 2;
}

/** What tab storage accepts: a conversation within its bounds. */
export const coachSessionSchema = sessionShape.refine(
    (session) =>
        session.messages.length <= MAX_COACH_MESSAGES &&
        coachSessionBytes(session) <= MAX_COACH_SESSION_BYTES,
    "Coach conversation exceeds its retention budget",
);

/**
 * A stored conversation as it is read back. Anything that does not match the schema is dropped
 * rather than refused: a conversation must never make its tab's game unreadable.
 */
export function readStoredCoachSession(value: unknown): CoachSession | undefined {
    const parsed = coachSessionSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

/** A turn that is running now. It is runtime state of its tab and is never stored. */
export type CoachRunningTurn = {
    question: string;
    /** The text streamed in the running round. */
    text: string;
    /**
     * The line that is checked at the moment (empty: the position itself) and where: by the
     * engine or in the reference database. `null` while nothing is looked up.
     */
    checking: { source: ToolSource; line: string[] } | null;
    /** A stop was requested; the turn's end has not arrived yet. */
    stopping: boolean;
    /** The game or conversation the turn belonged to is gone; it only still has to end. */
    orphaned: boolean;
};

export function newCoachSession(): CoachSession {
    return { version: 1, id: crypto.randomUUID(), messages: [] };
}

function cutText(text: string, length: number): string {
    return text.length <= length ? text : text.slice(0, length) + COACH_TRUNCATION_MARK;
}

function messageText(message: CoachMessage): string {
    return message.role === "user"
        ? message.text
        : message.segments
              .map((segment) => (segment.type === "text" ? segment.text : segment.san.join(" ")))
              .join("");
}

/** One message with its text cut to `length` characters; an answer loses its lines with it. */
function shortened(message: CoachMessage, length: number): CoachMessage {
    const text = cutText(messageText(message), length);
    return message.role === "user"
        ? { ...message, text }
        : { ...message, segments: [{ type: "text", text }] };
}

/** The longest text that still fits the schema with the truncation mark appended. */
const TEXT_ROOM = MAX_TEXT_LENGTH - COACH_TRUNCATION_MARK.length;

/**
 * One message inside the schema's own bounds. The native side allows a longer answer than a
 * stored text may be, so an overlong text is cut, with a mark, instead of the whole exchange
 * being refused by the store. An answer with more parts than the schema takes keeps its words
 * and loses its lines.
 */
function fitted(message: CoachMessage): CoachMessage {
    if (message.role === "user") {
        return message.text.length <= MAX_TEXT_LENGTH ? message : shortened(message, TEXT_ROOM);
    }
    if (message.segments.length > MAX_SEGMENTS) return shortened(message, TEXT_ROOM);
    const tooLong = (segment: Segment) =>
        segment.type === "text" && segment.text.length > MAX_TEXT_LENGTH;
    if (!message.segments.some(tooLong)) return message;
    return {
        ...message,
        // Only a text that is too long is cut; the others stay as they are.
        segments: message.segments.map((segment) =>
            segment.type === "text" && tooLong(segment)
                ? { ...segment, text: cutText(segment.text, TEXT_ROOM) }
                : segment,
        ),
    };
}

/**
 * The conversation within its bounds: every message inside the schema's bounds, the oldest
 * messages go first, and a newest message that is too large on its own is kept cut short, with a
 * mark.
 */
export function boundCoachSession(session: CoachSession): CoachSession {
    let messages = session.messages.slice(-MAX_COACH_MESSAGES).map(fitted);
    const fits = () => coachSessionBytes({ ...session, messages }) <= MAX_COACH_SESSION_BYTES;
    while (messages.length > 1 && !fits()) messages = messages.slice(1);
    if (messages.length === 1 && !fits()) {
        const newest = messages[0];
        // The message becomes one text, which has a length bound of its own.
        let length = Math.min(TEXT_ROOM, Math.floor(messageText(newest).length / 2));
        for (;;) {
            messages = [shortened(newest, length)];
            if (fits() || length === 0) break;
            length = Math.floor(length / 2);
        }
    }
    return { ...session, messages };
}

/** The answer's text as the model wrote it, with each checked line back in its brackets. */
export function coachAnswerText(message: CoachAnswerMessage): string {
    return message.segments
        .map((segment) => (segment.type === "text" ? segment.text : `[[${segment.san.join(" ")}]]`))
        .join("");
}

/**
 * The conversation as the model is told it: each question with its completed answer, oldest
 * first. A question whose turn was cancelled or failed is left out with its partial answer.
 */
export function coachHistory(session: CoachSession | undefined) {
    const history: { role: "user" | "coach"; text: string }[] = [];
    const messages = session?.messages ?? [];
    for (let index = 0; index + 1 < messages.length; index++) {
        const question = messages[index];
        const answer = messages[index + 1];
        if (question.role === "user" && answer.role === "coach" && answer.state === "completed") {
            history.push({ role: "user", text: question.text });
            history.push({ role: "coach", text: coachAnswerText(answer) });
            index++;
        }
    }
    return history;
}
