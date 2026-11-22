import { createStore } from "jotai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CoachTurnEvent, TurnInput, TurnUpdate } from "@/bindings";
import { CoachCommandError } from "@/platform/coach";
import type { LocalEngine } from "@/utils/engines";
import { defaultTree } from "@/utils/treeReducer";

const mocks = vi.hoisted(() => ({
    prepareAnalysis: vi.fn(),
    coachTurn: vi.fn(),
    cancelAnalysis: vi.fn(),
}));
vi.mock("@/platform/tauri", () => ({ tauri: mocks }));
vi.mock("@/platform/native", () => ({
    warn: vi.fn(() => Promise.resolve()),
    error: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));

const { coachTurnFamily } = await import("./atoms");
const {
    activeCoachTurnCount,
    applyCoachTurnEvent,
    sendCoachMessage,
    startNewCoachConversation,
    stopCoachTurn,
} = await import("./coachTurns");
const { closeTreeStore, createTreeStore } = await import("./store/tree");

const engine = {
    type: "local",
    id: "engine-1",
    name: "Engine",
    handle: { id: { id: "engine-ref" }, kind: "engine" },
    loaded: true,
    settings: [
        { type: "string", name: "Threads", value: "4" },
        { type: "string", name: "SyzygyPath", value: "" },
    ],
} as unknown as LocalEngine;

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const completed: TurnUpdate = {
    type: "completed",
    segments: [
        { type: "text", text: "Play " },
        { type: "line", san: ["Nf3"], uci: ["g1f3"] },
    ],
    failedLines: 0,
};

let tabs: string[] = [];
let nextTab = 0;

function openTab() {
    const tab = `coach-tab-${nextTab++}`;
    tabs.push(tab);
    const tree = createTreeStore(tab);
    tree.getState().setState(defaultTree());
    tree.getState().makeMoves({ payload: ["e4", "e5"] });
    return { tab, tree };
}

function request(tab: string, tree: ReturnType<typeof createTreeStore>, question = "Plan?") {
    return { tab, tree, question, connection: "conn", model: "model", effort: null, engine };
}

function event(tab: string, turn: string, update: TurnUpdate): CoachTurnEvent {
    return { tab, turn, update };
}

/** Lets the awaited reservation and command calls of a send advance. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    vi.resetAllMocks();
    mocks.prepareAnalysis.mockResolvedValue("ticket-1");
    mocks.cancelAnalysis.mockResolvedValue(undefined);
});

afterEach(() => {
    for (const tab of tabs) closeTreeStore(tab);
    tabs = [];
    // Every test has to end its turns: a leftover entry would block the tab for good.
    if (activeCoachTurnCount() !== 0) throw new Error("a Coach turn was left running");
});

test("a turn streams into the tab and its end is saved once, whoever reports it first", async () => {
    const atoms = createStore();
    const { tab, tree } = openTab();
    const command = deferred<TurnUpdate>();
    mocks.coachTurn.mockReturnValue(command.promise);
    const sent = sendCoachMessage(atoms, { ...request(tab, tree), effort: "high" });
    expect(atoms.get(coachTurnFamily(tab))).toMatchObject({ question: "Plan?", text: "" });
    await settle();

    const [ticket, sentTab, input] = mocks.coachTurn.mock.calls[0] as [string, string, TurnInput];
    expect([ticket, sentTab]).toEqual(["ticket-1", tab]);
    expect(input).toMatchObject({
        connection: "conn",
        model: "model",
        effort: "high",
        startFen: defaultTree().root.fen,
        moves: ["e2e4", "e7e5"],
        history: [],
        message: "Plan?",
        engine: engine.handle,
        engineId: "engine-1",
        // An empty option value has no meaning for an engine and is not sent.
        uciOptions: [{ type: "string", name: "Threads", value: "4" }],
    });
    expect(input.game).toContain("1. e4 e5");

    applyCoachTurnEvent(atoms, event(tab, "ticket-1", { type: "text", delta: "Let me " }));
    applyCoachTurnEvent(atoms, event(tab, "ticket-1", { type: "text", delta: "check." }));
    expect(atoms.get(coachTurnFamily(tab))?.text).toBe("Let me check.");
    applyCoachTurnEvent(atoms, event(tab, "ticket-1", { type: "tool", line: ["Nf3"] }));
    expect(atoms.get(coachTurnFamily(tab))?.checking).toEqual(["Nf3"]);
    applyCoachTurnEvent(atoms, event(tab, "ticket-1", { type: "reset" }));
    expect(atoms.get(coachTurnFamily(tab))).toMatchObject({ text: "", checking: null });

    applyCoachTurnEvent(atoms, event(tab, "ticket-1", completed));
    expect(atoms.get(coachTurnFamily(tab))).toBeNull();
    // The command's reply carries the same end and must not save it again.
    command.resolve(completed);
    await sent;
    const messages = tree.getState().coachSession?.messages ?? [];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", text: "Plan?" });
    expect(messages[1]).toMatchObject({
        role: "coach",
        state: "completed",
        segments: completed.type === "completed" ? completed.segments : [],
        path: [0, 0],
    });
    expect(messages[1].role === "coach" && messages[1].fen).toBe(tree.getState().currentNode().fen);
    // The conversation is not part of the game: saving it leaves the game as clean as it was.
    expect(mocks.cancelAnalysis).not.toHaveBeenCalled();
});

test("the command's reply alone ends the turn, and the next turn sends the history", async () => {
    const atoms = createStore();
    const { tab, tree } = openTab();
    mocks.coachTurn.mockResolvedValue(completed);
    await sendCoachMessage(atoms, request(tab, tree));
    expect(tree.getState().coachSession?.messages).toHaveLength(2);
    expect(atoms.get(coachTurnFamily(tab))).toBeNull();

    mocks.prepareAnalysis.mockResolvedValue("ticket-2");
    await sendCoachMessage(atoms, request(tab, tree, "And then?"));
    const input = mocks.coachTurn.mock.calls[1][2] as TurnInput;
    expect(input.history).toEqual([
        { role: "user", text: "Plan?" },
        { role: "coach", text: "Play [[Nf3]]" },
    ]);
    expect(input.effort).toBeUndefined();
    expect(tree.getState().coachSession?.messages).toHaveLength(4);
});

test("events for another tab or another turn are dropped", async () => {
    const atoms = createStore();
    const { tab, tree } = openTab();
    const command = deferred<TurnUpdate>();
    mocks.coachTurn.mockReturnValue(command.promise);
    const sent = sendCoachMessage(atoms, request(tab, tree));
    await settle();
    applyCoachTurnEvent(atoms, event("other-tab", "ticket-1", { type: "text", delta: "x" }));
    applyCoachTurnEvent(atoms, event(tab, "ticket-0", { type: "text", delta: "x" }));
    applyCoachTurnEvent(atoms, event(tab, "ticket-0", completed));
    expect(atoms.get(coachTurnFamily(tab))).toMatchObject({ text: "" });
    expect(tree.getState().coachSession).toBeUndefined();
    command.resolve({ type: "cancelled", text: "" });
    await sent;
});

test("a tab runs one turn: a second send does nothing", async () => {
    const atoms = createStore();
    const { tab, tree } = openTab();
    const command = deferred<TurnUpdate>();
    mocks.coachTurn.mockReturnValue(command.promise);
    const sent = sendCoachMessage(atoms, request(tab, tree));
    await sendCoachMessage(atoms, request(tab, tree, "Second"));
    await settle();
    expect(mocks.prepareAnalysis).toHaveBeenCalledOnce();
    command.resolve(completed);
    await sent;
    expect(tree.getState().coachSession?.messages[0]).toMatchObject({ text: "Plan?" });
});

test("a turn that cannot start is saved as failed and frees its reservation", async () => {
    const atoms = createStore();
    const { tab, tree } = openTab();
    mocks.coachTurn.mockRejectedValue(new CoachCommandError("keyRejected"));
    await sendCoachMessage(atoms, request(tab, tree));
    expect(mocks.cancelAnalysis).toHaveBeenCalledExactlyOnceWith("ticket-1");
    expect(tree.getState().coachSession?.messages[1]).toMatchObject({
        state: "failed",
        error: "keyRejected",
        segments: [],
    });

    mocks.prepareAnalysis.mockRejectedValue(new Error("sealed"));
    await sendCoachMessage(atoms, request(tab, tree, "Again?"));
    expect(mocks.coachTurn).toHaveBeenCalledOnce();
    expect(tree.getState().coachSession?.messages[3]).toMatchObject({
        state: "failed",
        error: "busy",
    });
});

test("stopping cancels the operation and saves what was written until then", async () => {
    const atoms = createStore();
    const { tab, tree } = openTab();
    const command = deferred<TurnUpdate>();
    mocks.coachTurn.mockReturnValue(command.promise);
    const sent = sendCoachMessage(atoms, request(tab, tree));
    await settle();
    stopCoachTurn(atoms, tab);
    stopCoachTurn(atoms, tab);
    expect(mocks.cancelAnalysis).toHaveBeenCalledExactlyOnceWith("ticket-1");
    expect(atoms.get(coachTurnFamily(tab))).toMatchObject({ stopping: true, orphaned: false });
    applyCoachTurnEvent(atoms, event(tab, "ticket-1", { type: "cancelled", text: "Half" }));
    command.resolve({ type: "cancelled", text: "Half" });
    await sent;
    expect(tree.getState().coachSession?.messages[1]).toMatchObject({
        state: "cancelled",
        segments: [{ type: "text", text: "Half" }],
    });
});

test("a stop before the reservation arrives ends the turn without starting it", async () => {
    const atoms = createStore();
    const { tab, tree } = openTab();
    const reservation = deferred<string>();
    mocks.prepareAnalysis.mockReturnValue(reservation.promise);
    const sent = sendCoachMessage(atoms, request(tab, tree));
    stopCoachTurn(atoms, tab);
    expect(mocks.cancelAnalysis).not.toHaveBeenCalled();
    reservation.resolve("ticket-9");
    await sent;
    expect(mocks.cancelAnalysis).toHaveBeenCalledExactlyOnceWith("ticket-9");
    expect(mocks.coachTurn).not.toHaveBeenCalled();
    expect(tree.getState().coachSession?.messages[1]).toMatchObject({ state: "cancelled" });
});

test.each(["setState", "reset", "setFen"] as const)(
    "%s ends the running turn, and its late end is not saved into the new game",
    async (replace) => {
        const atoms = createStore();
        const { tab, tree } = openTab();
        const command = deferred<TurnUpdate>();
        mocks.coachTurn.mockReturnValue(command.promise);
        const sent = sendCoachMessage(atoms, request(tab, tree));
        await settle();
        if (replace === "setState") tree.getState().setState(defaultTree());
        else if (replace === "reset") tree.getState().reset();
        else tree.getState().setFen("8/8/8/8/8/8/8/K6k w - - 0 1");
        expect(mocks.cancelAnalysis).toHaveBeenCalledExactlyOnceWith("ticket-1");
        // The turn is no longer shown, but the tab stays busy until it has really ended.
        expect(atoms.get(coachTurnFamily(tab))).toMatchObject({ stopping: true, orphaned: true });
        await sendCoachMessage(atoms, request(tab, tree, "Too early"));
        expect(mocks.prepareAnalysis).toHaveBeenCalledOnce();

        applyCoachTurnEvent(atoms, event(tab, "ticket-1", completed));
        command.resolve(completed);
        await sent;
        expect(atoms.get(coachTurnFamily(tab))).toBeNull();
        expect(tree.getState().coachSession).toBeUndefined();
    },
);

test("a new conversation clears the old one and discards the turn that still runs", async () => {
    const atoms = createStore();
    const { tab, tree } = openTab();
    mocks.coachTurn.mockResolvedValueOnce(completed);
    await sendCoachMessage(atoms, request(tab, tree));
    expect(tree.getState().coachSession?.messages).toHaveLength(2);

    const command = deferred<TurnUpdate>();
    mocks.prepareAnalysis.mockResolvedValue("ticket-2");
    mocks.coachTurn.mockReturnValue(command.promise);
    const sent = sendCoachMessage(atoms, request(tab, tree, "More?"));
    await settle();
    startNewCoachConversation(atoms, tab, tree);
    expect(tree.getState().coachSession).toBeUndefined();
    expect(mocks.cancelAnalysis).toHaveBeenCalledExactlyOnceWith("ticket-2");
    expect(atoms.get(coachTurnFamily(tab))).toMatchObject({ orphaned: true });
    command.resolve(completed);
    await sent;
    expect(tree.getState().coachSession).toBeUndefined();
    expect(atoms.get(coachTurnFamily(tab))).toBeNull();
});

test("a turn whose tab was closed ends quietly and does not bring the tab's state back", async () => {
    const atoms = createStore();
    const { tab, tree } = openTab();
    const command = deferred<TurnUpdate>();
    mocks.coachTurn.mockReturnValue(command.promise);
    const sent = sendCoachMessage(atoms, request(tab, tree));
    await settle();
    closeTreeStore(tab);
    coachTurnFamily.remove(tab);
    applyCoachTurnEvent(atoms, event(tab, "ticket-1", { type: "text", delta: "late" }));
    command.resolve({ type: "cancelled", text: "" });
    await sent;
    expect(Array.from(coachTurnFamily.getParams())).not.toContain(tab);
});
