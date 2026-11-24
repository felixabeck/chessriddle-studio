import { createStore } from "jotai";
import { beforeEach, expect, test, vi } from "vitest";
import { CoachCommandError } from "@/platform/coach";

const mocks = vi.hoisted(() => ({
    coachAvailable: vi.fn(),
    coachHasConnection: vi.fn(),
    coachConnections: vi.fn(),
    logFailureSafely: vi.fn(),
}));

vi.mock("@/platform/tauri", () => ({
    tauri: {
        coachAvailable: mocks.coachAvailable,
        coachHasConnection: mocks.coachHasConnection,
        coachConnections: mocks.coachConnections,
    },
}));
vi.mock("@/platform/errors", async (original) => ({
    ...(await original<typeof import("@/platform/errors")>()),
    logFailureSafely: mocks.logFailureSafely,
}));
vi.mock("@/platform/native", () => ({
    warn: vi.fn(() => Promise.resolve()),
    error: vi.fn(() => Promise.resolve()),
}));

const {
    assistantAnswerText,
    assistantAvailableAtom,
    assistantHistory,
    assistantNoticeAcceptedAtom,
    boundAssistantConversation,
    MAX_ASSISTANT_CONVERSATION_BYTES,
    MAX_ASSISTANT_MESSAGES,
    refreshAssistantAvailabilityAtom,
    withAssistantNoticeAccepted,
} = await import("./assistant");
const { coachConnectionsAtom, coachEnabledAtom, coachNoticeAcceptedAtom } = await import("./coach");

beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    mocks.coachAvailable.mockResolvedValue(true);
    mocks.coachHasConnection.mockResolvedValue(false);
    mocks.coachConnections.mockResolvedValue([]);
});

test("visibility asks coachHasConnection only when Coach is available, fails closed with logging, and re-asks on connection reload", async () => {
    mocks.coachAvailable.mockResolvedValue(false);
    const disabledStore = createStore();
    disabledStore.sub(coachEnabledAtom, () => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(disabledStore.get(coachEnabledAtom)).toBe(false);
    await disabledStore.set(refreshAssistantAvailabilityAtom);
    expect(mocks.coachHasConnection).not.toHaveBeenCalled();
    expect(disabledStore.get(assistantAvailableAtom)).toBe(false);

    mocks.coachAvailable.mockResolvedValue(true);
    mocks.coachHasConnection.mockRejectedValueOnce(new CoachCommandError("storage"));
    const store = createStore();
    store.sub(coachEnabledAtom, () => {});
    await vi.waitFor(() => expect(store.get(coachEnabledAtom)).toBe(true));

    await store.set(refreshAssistantAvailabilityAtom);
    expect(store.get(assistantAvailableAtom)).toBe(false);
    expect(mocks.logFailureSafely).toHaveBeenCalledOnce();

    // Connection added -> coachConnectionsAtom reloads -> re-asks coachHasConnection.
    mocks.coachHasConnection.mockResolvedValueOnce(true);
    await store.set(coachConnectionsAtom);
    await vi.waitFor(() => expect(store.get(assistantAvailableAtom)).toBe(true));

    // Connection removed -> coachConnectionsAtom reloads -> re-asks and hides again.
    mocks.coachHasConnection.mockResolvedValueOnce(false);
    await store.set(coachConnectionsAtom);
    await vi.waitFor(() => expect(store.get(assistantAvailableAtom)).toBe(false));
});

test("Assistant notice acceptance is separate from Coach and treats corrupt or oversized storage as not accepted", () => {
    localStorage.setItem("coach-notice-accepted", JSON.stringify(["conn-1"]));
    const store1 = createStore();
    store1.sub(coachNoticeAcceptedAtom, () => {});
    expect(store1.get(coachNoticeAcceptedAtom)).toEqual(["conn-1"]);
    expect(store1.get(assistantNoticeAcceptedAtom)).toEqual([]);

    // Corrupt JSON
    localStorage.setItem("assistant-notice-accepted", "{not-json");
    const store2 = createStore();
    expect(store2.get(assistantNoticeAcceptedAtom)).toEqual([]);

    // Oversized array (> 64 handles)
    localStorage.setItem(
        "assistant-notice-accepted",
        JSON.stringify(Array.from({ length: 65 }, (_, i) => `conn-${i}`)),
    );
    const store3 = createStore();
    expect(store3.get(assistantNoticeAcceptedAtom)).toEqual([]);

    // Oversized handle (> 64 chars)
    localStorage.setItem("assistant-notice-accepted", JSON.stringify(["x".repeat(65)]));
    const store4 = createStore();
    expect(store4.get(assistantNoticeAcceptedAtom)).toEqual([]);

    // Valid acceptance is persisted under its own key
    store4.set(
        assistantNoticeAcceptedAtom,
        withAssistantNoticeAccepted(store4.get(assistantNoticeAcceptedAtom), "conn-1"),
    );
    expect(store4.get(assistantNoticeAcceptedAtom)).toEqual(["conn-1"]);
    expect(JSON.parse(localStorage.getItem("assistant-notice-accepted")!)).toEqual(["conn-1"]);
});

test("in-memory conversation bounding drops oldest messages first by count and byte budget", () => {
    const messages = Array.from({ length: MAX_ASSISTANT_MESSAGES + 10 }, (_, index) => ({
        id: `m-${index}`,
        role: "user" as const,
        text: `Question ${index}`,
    }));
    const bounded = boundAssistantConversation({ id: "conv-1", messages });
    expect(bounded.messages).toHaveLength(MAX_ASSISTANT_MESSAGES);
    expect(bounded.messages[0].id).toBe("m-10");
    expect(bounded.messages.at(-1)?.id).toBe(`m-${MAX_ASSISTANT_MESSAGES + 9}`);

    // Byte-cap eviction: each message is 20,000 chars = 40,000 UTF-16 bytes; 3 messages exceed 96 KiB.
    const bigText = "a".repeat(20_000);
    const byBytes = boundAssistantConversation({
        id: "conv-2",
        messages: [
            { id: "old", role: "user", text: bigText },
            { id: "mid", role: "user", text: bigText },
            { id: "new", role: "user", text: bigText },
        ],
    });
    expect(byBytes.messages.map((m) => m.id)).toEqual(["mid", "new"]);
    expect(
        byBytes.messages.reduce((sum, m) => sum + (m.role === "user" ? m.text.length * 2 : 0), 0),
    ).toBeLessThanOrEqual(MAX_ASSISTANT_CONVERSATION_BYTES);
});

test("assistantAnswerText and assistantHistory serialize link segments and keep only completed exchanges in order", () => {
    const answerWithLinks = {
        id: "a1",
        role: "assistant" as const,
        state: "completed" as const,
        segments: [
            { type: "text" as const, text: "Open " },
            { type: "link" as const, target: "settings-category:coach" },
            { type: "text" as const, text: " or " },
            { type: "link" as const, target: "feedback" },
            { type: "text" as const, text: "." },
        ],
    };
    expect(assistantAnswerText(answerWithLinks)).toBe(
        "Open [[settings-category:coach]] or [[feedback]].",
    );

    const history = assistantHistory({
        id: "conv-3",
        messages: [
            { id: "u1", role: "user", text: "First?" },
            answerWithLinks,
            { id: "u2", role: "user", text: "Stopped?" },
            {
                id: "a2",
                role: "assistant",
                state: "cancelled",
                segments: [{ type: "text", text: "Partial" }],
            },
            { id: "u3", role: "user", text: "Failed?" },
            {
                id: "a3",
                role: "assistant",
                state: "failed",
                error: "network",
                segments: [],
            },
            { id: "u4", role: "user", text: "Second?" },
            {
                id: "a4",
                role: "assistant",
                state: "completed",
                segments: [{ type: "text", text: "Done." }],
            },
            { id: "u5", role: "user", text: "Unanswered?" },
        ],
    });

    expect(history).toEqual([
        { role: "user", text: "First?" },
        { role: "assistant", text: "Open [[settings-category:coach]] or [[feedback]]." },
        { role: "user", text: "Second?" },
        { role: "assistant", text: "Done." },
    ]);
});
