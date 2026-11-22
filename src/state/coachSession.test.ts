import { expect, test } from "vitest";
import {
    boundCoachSession,
    COACH_TRUNCATION_MARK,
    type CoachMessage,
    type CoachSession,
    coachAnswerText,
    coachHistory,
    coachSessionBytes,
    coachSessionSchema,
    MAX_COACH_MESSAGES,
    MAX_COACH_PATH_LENGTH,
    MAX_COACH_SESSION_BYTES,
    readStoredCoachSession,
} from "./coachSession";

const FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function question(id: string, text = `question ${id}`): CoachMessage {
    return { id: `q${id}`, role: "user", text };
}

function answer(
    id: string,
    state: "completed" | "cancelled" | "failed" = "completed",
    text = `answer ${id}`,
): CoachMessage {
    return {
        id: `a${id}`,
        role: "coach",
        segments: [
            { type: "text", text: `${text} ` },
            { type: "line", san: ["e4", "e5"], uci: ["e2e4", "e7e5"] },
        ],
        state,
        fen: FEN,
        path: [0, 1],
    };
}

function session(messages: CoachMessage[]): CoachSession {
    return { version: 1, id: "conversation", messages };
}

/** Text the storage compression can hardly shrink (varied CJK), so its stored size is large. */
function noise(length: number): string {
    let state = 12345;
    let text = "";
    for (let index = 0; index < length; index++) {
        // mulberry32: integer arithmetic only, so the sequence does not degenerate.
        state = (state + 0x6d2b79f5) | 0;
        let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
        mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
        text += String.fromCharCode(0x4e00 + (((mixed ^ (mixed >>> 14)) >>> 0) % 20000));
    }
    return text;
}

test("a conversation keeps its newest messages when it has too many", () => {
    const messages = Array.from({ length: MAX_COACH_MESSAGES + 4 }, (_, index) =>
        question(String(index)),
    );
    const bounded = boundCoachSession(session(messages));
    expect(bounded.messages).toHaveLength(MAX_COACH_MESSAGES);
    expect(bounded.messages[0].id).toBe("q4");
    expect(bounded.messages.at(-1)?.id).toBe(`q${MAX_COACH_MESSAGES + 3}`);
    expect(coachSessionSchema.safeParse(bounded).success).toBe(true);
});

test("a conversation over its size bound loses its oldest messages first", () => {
    const big = noise(20_000);
    const messages = Array.from({ length: 6 }, (_, index) => question(String(index), big + index));
    const bounded = boundCoachSession(session(messages));
    expect(bounded.messages.length).toBeGreaterThan(0);
    expect(bounded.messages.length).toBeLessThan(6);
    expect(bounded.messages.at(-1)?.id).toBe("q5");
    expect(coachSessionBytes(bounded)).toBeLessThanOrEqual(MAX_COACH_SESSION_BYTES);
    // What is too large is refused by the stored schema unless it is bounded first.
    expect(coachSessionSchema.safeParse(session(messages)).success).toBe(false);
    expect(coachSessionSchema.safeParse(bounded).success).toBe(true);
});

test("a single message that is too large is kept, cut short and marked", () => {
    const huge = noise(60_000);
    const cutQuestion = boundCoachSession(session([question("1", huge)])).messages[0];
    expect(cutQuestion.role === "user" && cutQuestion.text.endsWith(COACH_TRUNCATION_MARK)).toBe(
        true,
    );
    expect(cutQuestion.role === "user" && huge.startsWith(cutQuestion.text.slice(0, 100))).toBe(
        true,
    );

    const bounded = boundCoachSession(session([answer("1", "completed", huge)]));
    const cutAnswer = bounded.messages[0];
    expect(coachSessionBytes(bounded)).toBeLessThanOrEqual(MAX_COACH_SESSION_BYTES);
    expect(cutAnswer.role === "coach" && cutAnswer.segments).toEqual([
        { type: "text", text: expect.stringContaining(COACH_TRUNCATION_MARK) },
    ]);
    // The position the question was about survives the cut.
    expect(cutAnswer.role === "coach" && cutAnswer.path).toEqual([0, 1]);
});

test("a stored conversation that does not match the schema is dropped, not repaired", () => {
    const valid = session([question("1"), answer("1")]);
    expect(readStoredCoachSession(valid)).toEqual(valid);
    for (const broken of [
        null,
        "text",
        { ...valid, version: 2 },
        { ...valid, messages: [{ id: "x", role: "system", text: "hi" }] },
        { ...valid, messages: [{ ...answer("1"), error: "notACoachError" }] },
        { ...valid, messages: [{ ...answer("1"), path: [-1] }] },
        { ...valid, messages: [{ ...answer("1"), segments: [{ type: "html", text: "<b>" }] }] },
        session(Array.from({ length: MAX_COACH_MESSAGES + 1 }, (_, i) => question(String(i)))),
    ]) {
        expect(readStoredCoachSession(broken)).toBeUndefined();
    }
    expect(readStoredCoachSession(undefined)).toBeUndefined();
});

test("the model is told completed exchanges only, with lines back in their brackets", () => {
    const first = answer("1");
    expect(first.role === "coach" && coachAnswerText(first)).toBe("answer 1 [[e4 e5]]");
    const history = coachHistory(
        session([
            question("1"),
            first,
            question("2"),
            answer("2", "cancelled"),
            question("3"),
            answer("3", "failed"),
            question("4"),
            answer("4"),
        ]),
    );
    expect(history).toEqual([
        { role: "user", text: "question 1" },
        { role: "coach", text: "answer 1 [[e4 e5]]" },
        { role: "user", text: "question 4" },
        { role: "coach", text: "answer 4 [[e4 e5]]" },
    ]);
    expect(coachHistory(undefined)).toEqual([]);
});

test("a message beyond the schema's own bounds is fitted, not refused with its exchange", () => {
    // Plain repeated text compresses far below the size bound and is still too long for a text.
    const long = "The plan is simple. ".repeat(5_000);
    expect(long.length).toBeGreaterThan(64 * 1024);
    const reply: CoachMessage = {
        id: "a1",
        role: "coach",
        segments: [
            { type: "text", text: long },
            { type: "line", san: ["e4", "e5"], uci: ["e2e4", "e7e5"] },
            { type: "text", text: " is the main line." },
        ],
        state: "completed",
        fen: FEN,
        path: [0, 1],
    };
    const raw = session([question("1", long), reply]);
    expect(coachSessionSchema.safeParse(raw).success).toBe(false);

    const bounded = boundCoachSession(raw);
    expect(coachSessionSchema.safeParse(bounded).success).toBe(true);
    const [asked, answered] = bounded.messages;
    expect(asked.role === "user" && asked.text.endsWith(COACH_TRUNCATION_MARK)).toBe(true);
    // Only the overlong text is cut: the checked line and the rest of the answer stay.
    expect(answered.role === "coach" && answered.segments).toEqual([
        { type: "text", text: expect.stringMatching(/^The plan is simple\. .* \[…\]$/s) },
        { type: "line", san: ["e4", "e5"], uci: ["e2e4", "e7e5"] },
        { type: "text", text: " is the main line." },
    ]);

    // More parts than a stored answer takes: its words are kept as one text.
    const parts = Array.from({ length: 401 }, (_, index) => ({
        type: "text" as const,
        text: `${index} `,
    }));
    const many = boundCoachSession(session([{ ...reply, segments: parts }]));
    expect(coachSessionSchema.safeParse(many).success).toBe(true);
    const kept = many.messages[0];
    expect(kept.role === "coach" && kept.segments).toHaveLength(1);
    expect(kept.role === "coach" && kept.segments[0]).toMatchObject({
        type: "text",
        text: expect.stringMatching(/^0 1 2 .*400 $/s),
    });
});

test("a question from the deepest position a tab can hold is stored", async () => {
    const { MAX_TREE_DEPTH } = await import("./store/tabStorage");
    expect(MAX_COACH_PATH_LENGTH).toBe(MAX_TREE_DEPTH);
    const deep: CoachMessage = {
        id: "a1",
        role: "coach",
        segments: [{ type: "text", text: "Resign." }],
        state: "completed",
        fen: FEN,
        path: Array.from({ length: MAX_TREE_DEPTH }, () => 0),
    };
    expect(coachSessionSchema.safeParse(session([question("1"), deep])).success).toBe(true);
});
