import { createStore } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AssistantTurnUpdate } from "@/bindings";
import { setHelpTopicsLoaderForTests } from "@/components/assistant/topics";
import { CoachCommandError } from "@/platform/coach";

const mocks = vi.hoisted(() => ({
    prepareNativeRead: vi.fn(),
    cancelNativeRead: vi.fn(),
    assistantTurn: vi.fn(),
    logError: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/platform/tauri", () => ({
    tauri: {
        prepareNativeRead: mocks.prepareNativeRead,
        cancelNativeRead: mocks.cancelNativeRead,
        assistantTurn: mocks.assistantTurn,
    },
}));
vi.mock("@/platform/native", () => ({
    warn: vi.fn(() => Promise.resolve()),
    error: mocks.logError,
}));

const { assistantConversationAtom, assistantRunningTurnAtom, newAssistantConversation } =
    await import("./assistant");
const {
    activeAssistantTurnCount,
    applyAssistantTurnEvent,
    resetAssistantTurnForTests,
    sendAssistantMessage,
    startNewAssistantConversation,
    stopAssistantTurn,
} = await import("./assistantTurns");

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function baseRequest(question = "Where is AI settings?") {
    return {
        question,
        connection: "conn-1",
        model: "gpt-4o",
        effort: null,
        context: {
            page: "board",
            boardTabKind: "analysis",
            language: "en-US",
            installedEngines: ["Stockfish"],
            referenceDatabase: true,
        },
        settings: [],
        targets: [{ id: "settings-category:coach", label: "AI" }],
        t: (key: string) => key,
    };
}

let atoms: ReturnType<typeof createStore>;

beforeEach(() => {
    vi.resetAllMocks();
    resetAssistantTurnForTests();
    setHelpTopicsLoaderForTests(async () => [
        {
            id: "ai-connections",
            title: "AI",
            summary: "AI connections",
            body: "Open {{label:Settings.AI}}",
        },
    ]);
    mocks.prepareNativeRead.mockResolvedValue("ticket-1");
    mocks.cancelNativeRead.mockResolvedValue(undefined);
    mocks.logError.mockResolvedValue(undefined);
    atoms = createStore();
    atoms.set(assistantConversationAtom, newAssistantConversation());
    atoms.set(assistantRunningTurnAtom, null);
});

afterEach(() => {
    resetAssistantTurnForTests();
    setHelpTopicsLoaderForTests(null);
});

test("streamed updates match by turn id, stop cancels reservation and keeps partial text", async () => {
    const command = deferred<AssistantTurnUpdate>();
    mocks.assistantTurn.mockReturnValue(command.promise);

    const pending = sendAssistantMessage(atoms, baseRequest());
    await vi.waitFor(() => expect(mocks.assistantTurn).toHaveBeenCalledOnce());
    const [turnId, ticket] = mocks.assistantTurn.mock.calls[0];
    expect(ticket).toBe("ticket-1");

    // Event for another turn id is ignored.
    applyAssistantTurnEvent(atoms, {
        turn: "other-turn",
        update: { type: "text", delta: "wrong" },
    });
    expect(atoms.get(assistantRunningTurnAtom)?.text).toBe("");

    applyAssistantTurnEvent(atoms, {
        turn: turnId,
        update: { type: "readingTopics", topics: ["ai-connections"] },
    });
    expect(atoms.get(assistantRunningTurnAtom)?.readingTopics).toEqual(["ai-connections"]);

    applyAssistantTurnEvent(atoms, {
        turn: turnId,
        update: { type: "text", delta: "Open AI settings" },
    });
    expect(atoms.get(assistantRunningTurnAtom)?.text).toBe("Open AI settings");
    expect(atoms.get(assistantRunningTurnAtom)?.readingTopics).toBeNull();

    stopAssistantTurn(atoms);
    expect(mocks.cancelNativeRead).toHaveBeenCalledExactlyOnceWith("ticket-1");
    expect(atoms.get(assistantRunningTurnAtom)?.stopping).toBe(true);

    command.resolve({ type: "cancelled", text: "Open AI settings" });
    await pending;

    expect(atoms.get(assistantRunningTurnAtom)).toBeNull();
    expect(activeAssistantTurnCount()).toBe(0);
    const messages = atoms.get(assistantConversationAtom).messages;
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
        role: "assistant",
        state: "cancelled",
        segments: [{ type: "text", text: "Open AI settings" }],
    });
});

test("rejected assistantTurn command cancels its reservation and records the error", async () => {
    mocks.assistantTurn.mockRejectedValue(new CoachCommandError("noFunctionCalling"));

    await sendAssistantMessage(atoms, baseRequest());

    expect(mocks.cancelNativeRead).toHaveBeenCalledExactlyOnceWith("ticket-1");
    expect(activeAssistantTurnCount()).toBe(0);
    const messages = atoms.get(assistantConversationAtom).messages;
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
        role: "assistant",
        state: "failed",
        error: "noFunctionCalling",
    });
});

test("failed prepareNativeRead reservation shows busy without calling assistantTurn", async () => {
    mocks.prepareNativeRead.mockRejectedValue(new Error("sealed"));

    await sendAssistantMessage(atoms, baseRequest());

    expect(mocks.assistantTurn).not.toHaveBeenCalled();
    expect(mocks.cancelNativeRead).not.toHaveBeenCalled();
    expect(activeAssistantTurnCount()).toBe(0);
    const messages = atoms.get(assistantConversationAtom).messages;
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
        role: "assistant",
        state: "failed",
        error: "busy",
    });
});

test("New conversation stops a running turn and discards its late answer", async () => {
    const command = deferred<AssistantTurnUpdate>();
    mocks.assistantTurn.mockReturnValue(command.promise);

    const pending = sendAssistantMessage(atoms, baseRequest("First question"));
    await vi.waitFor(() => expect(mocks.assistantTurn).toHaveBeenCalledOnce());
    const [turnId] = mocks.assistantTurn.mock.calls[0];

    startNewAssistantConversation(atoms);
    expect(mocks.cancelNativeRead).toHaveBeenCalledExactlyOnceWith("ticket-1");
    expect(atoms.get(assistantConversationAtom).messages).toEqual([]);
    expect(atoms.get(assistantRunningTurnAtom)?.orphaned).toBe(true);

    // Late answer arrives via event and command resolution: neither enters the new conversation.
    applyAssistantTurnEvent(atoms, {
        turn: turnId,
        update: {
            type: "completed",
            segments: [{ type: "text", text: "Late answer" }],
            feedbackDraft: null,
        },
    });
    command.resolve({
        type: "completed",
        segments: [{ type: "text", text: "Late answer" }],
        feedbackDraft: null,
    });
    await pending;

    expect(atoms.get(assistantConversationAtom).messages).toEqual([]);
    expect(atoms.get(assistantRunningTurnAtom)).toBeNull();
    expect(activeAssistantTurnCount()).toBe(0);
});

test("topics failing to load end the attempt with topicsLoadFailed and reload on the next attempt", async () => {
    let attempts = 0;
    setHelpTopicsLoaderForTests(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("chunk failed");
        return [{ id: "feedback", title: "Feedback", summary: "Send feedback", body: "Body" }];
    });

    await sendAssistantMessage(atoms, baseRequest("First try"));
    expect(mocks.prepareNativeRead).not.toHaveBeenCalled();
    expect(mocks.assistantTurn).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith(
        expect.stringContaining("Assistant help topics failed to load"),
    );
    expect(activeAssistantTurnCount()).toBe(0);
    expect(atoms.get(assistantConversationAtom).messages[1]).toMatchObject({
        role: "assistant",
        state: "failed",
        localError: "topicsLoadFailed",
    });

    // Next attempt reloads topics and succeeds.
    mocks.assistantTurn.mockResolvedValue({
        type: "completed",
        segments: [{ type: "text", text: "Worked" }],
        feedbackDraft: null,
    });
    await sendAssistantMessage(atoms, baseRequest("Second try"));
    expect(attempts).toBe(2);
    expect(mocks.assistantTurn).toHaveBeenCalledOnce();
    expect(atoms.get(assistantConversationAtom).messages.at(-1)).toMatchObject({
        role: "assistant",
        state: "completed",
        segments: [{ type: "text", text: "Worked" }],
    });
});

test("reset event replaces previously streamed text instead of appending", async () => {
    const command = deferred<AssistantTurnUpdate>();
    mocks.assistantTurn.mockReturnValue(command.promise);

    const pending = sendAssistantMessage(atoms, baseRequest());
    await vi.waitFor(() => expect(mocks.assistantTurn).toHaveBeenCalledOnce());
    const [turnId] = mocks.assistantTurn.mock.calls[0];

    applyAssistantTurnEvent(atoms, {
        turn: turnId,
        update: { type: "text", delta: "First round draft" },
    });
    expect(atoms.get(assistantRunningTurnAtom)?.text).toBe("First round draft");

    applyAssistantTurnEvent(atoms, {
        turn: turnId,
        update: { type: "reset" },
    });
    expect(atoms.get(assistantRunningTurnAtom)?.text).toBe("");

    applyAssistantTurnEvent(atoms, {
        turn: turnId,
        update: { type: "text", delta: "Second round answer" },
    });
    expect(atoms.get(assistantRunningTurnAtom)?.text).toBe("Second round answer");

    command.resolve({
        type: "completed",
        segments: [{ type: "text", text: "Second round answer" }],
        feedbackDraft: null,
    });
    await pending;
});

test("reset keeps readingTopics until the next text delta or terminal update", async () => {
    const command = deferred<AssistantTurnUpdate>();
    mocks.assistantTurn.mockReturnValue(command.promise);

    const pending = sendAssistantMessage(atoms, baseRequest());
    await vi.waitFor(() => expect(mocks.assistantTurn).toHaveBeenCalledOnce());
    const [turnId] = mocks.assistantTurn.mock.calls[0];

    applyAssistantTurnEvent(atoms, {
        turn: turnId,
        update: { type: "readingTopics", topics: ["ai-connections"] },
    });
    expect(atoms.get(assistantRunningTurnAtom)?.readingTopics).toEqual(["ai-connections"]);

    applyAssistantTurnEvent(atoms, {
        turn: turnId,
        update: { type: "reset" },
    });
    expect(atoms.get(assistantRunningTurnAtom)?.text).toBe("");
    expect(atoms.get(assistantRunningTurnAtom)?.readingTopics).toEqual(["ai-connections"]);

    applyAssistantTurnEvent(atoms, {
        turn: turnId,
        update: { type: "text", delta: "Answer" },
    });
    expect(atoms.get(assistantRunningTurnAtom)?.readingTopics).toBeNull();
    expect(atoms.get(assistantRunningTurnAtom)?.text).toBe("Answer");

    command.resolve({
        type: "completed",
        segments: [{ type: "text", text: "Answer" }],
        feedbackDraft: null,
    });
    await pending;
    expect(atoms.get(assistantRunningTurnAtom)).toBeNull();
});
