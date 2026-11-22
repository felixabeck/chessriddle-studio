import type { createStore } from "jotai";
import type { CoachError, CoachTurnEvent, TurnUpdate } from "@/bindings";
import { normalizeEngineOptions } from "@/components/engines/engineOptions";
import { coachErrorCode } from "@/platform/coach";
import { warn } from "@/platform/native";
import { tauri } from "@/platform/tauri";
import { getVariationLine } from "@/utils/chess";
import { coachGameContext } from "@/utils/coachContext";
import type { LocalEngine } from "@/utils/engines";
import { coachTurnFamily } from "./atoms";
import {
    type CoachAnswerMessage,
    type CoachRunningTurn,
    coachHistory,
    newCoachSession,
} from "./coachSession";
import { getCachedTreeStore, type TreeStore } from "./store/tree";

/**
 * The Coach turns that run now. A turn outlives the panel that started it: the answer arrives
 * through the application-lifetime listener (or the command's own reply, whichever is first) and
 * is saved into the tab's conversation whether or not the panel is on screen.
 *
 * One turn per tab, as on the native side. An entry is removed on every way its turn ends: its
 * terminal event, the command's reply or rejection, and a failed reservation.
 */
type ActiveTurn = {
    tab: string;
    tree: TreeStore;
    /** The turn's id, the ticket of its analysis operation; `null` until it is reserved. */
    turn: string | null;
    question: string;
    /** The position the question is about. */
    fen: string;
    path: number[];
    /** Whether the game and conversation the question was asked in are still the tab's. */
    isOwner: () => boolean;
    stopRequested: boolean;
    unsubscribe: () => void;
};

type Atoms = ReturnType<typeof createStore>;
type TerminalUpdate = Extract<TurnUpdate, { type: "completed" | "cancelled" | "failed" }>;

const activeTurns = new Map<string, ActiveTurn>();

export type CoachSendRequest = {
    tab: string;
    tree: TreeStore;
    question: string;
    connection: string;
    model: string;
    /** `null` sends no effort: the provider's default applies. */
    effort: string | null;
    engine: LocalEngine;
};

/** Writes the tab's runtime turn, unless the tab is gone: a closed tab must not get its atom back. */
function publish(
    atoms: Atoms,
    active: ActiveTurn,
    update: (turn: CoachRunningTurn | null) => CoachRunningTurn | null,
) {
    if (getCachedTreeStore(active.tab) !== active.tree) return;
    atoms.set(coachTurnFamily(active.tab), update);
}

function requestStop(active: ActiveTurn) {
    active.stopRequested = true;
    if (active.turn === null) return;
    tauri.cancelAnalysis(active.turn).catch((cause: unknown) => {
        void warn(`Coach turn could not be cancelled: ${String(cause)}`);
    });
}

function answerOf(active: ActiveTurn, update: TerminalUpdate): CoachAnswerMessage {
    const base = {
        id: crypto.randomUUID(),
        role: "coach" as const,
        fen: active.fen,
        path: active.path,
    };
    if (update.type === "completed") {
        return {
            ...base,
            segments: update.segments,
            state: "completed",
            ...(update.failedLines > 0 ? { failedLines: update.failedLines } : {}),
        };
    }
    const segments = update.text ? [{ type: "text" as const, text: update.text }] : [];
    return update.type === "cancelled"
        ? { ...base, segments, state: "cancelled" }
        : { ...base, segments, state: "failed", error: update.error };
}

/** Ends a turn exactly once and saves its exchange, if it still belongs to the tab's conversation. */
function finish(atoms: Atoms, active: ActiveTurn, update: TerminalUpdate) {
    if (activeTurns.get(active.tab) !== active) return;
    activeTurns.delete(active.tab);
    active.unsubscribe();
    const owned = active.isOwner();
    publish(atoms, active, () => null);
    if (!owned) return;
    const answer = answerOf(active, update);
    // A refused write is reported by the store; the conversation then simply lacks this exchange.
    active.tree.getState().transitionCoachSession((session) => {
        const conversation = session ?? newCoachSession();
        return {
            ...conversation,
            messages: [
                ...conversation.messages,
                { id: crypto.randomUUID(), role: "user", text: active.question },
                answer,
            ],
        };
    });
}

function failed(error: CoachError): TerminalUpdate {
    return { type: "failed", error, text: "" };
}

/**
 * Starts a turn for the tab's current position. Returns at once if the tab already runs one. The
 * promise settles when the turn is over; nothing has to await it.
 */
export async function sendCoachMessage(atoms: Atoms, request: CoachSendRequest): Promise<void> {
    const { tab, tree, question } = request;
    if (activeTurns.has(tab)) return;
    const state = tree.getState();
    const path = [...state.position];
    const active: ActiveTurn = {
        tab,
        tree,
        turn: null,
        question,
        fen: state.currentNode().fen,
        path,
        isOwner: state.captureCoachSessionOwner(),
        stopRequested: false,
        unsubscribe: () => undefined,
    };
    activeTurns.set(tab, active);
    publish(atoms, active, () => ({
        question,
        text: "",
        checking: null,
        stopping: false,
        orphaned: false,
    }));
    // Another game, a reset or a new conversation ends the turn: it has nowhere to answer to.
    active.unsubscribe = tree.subscribe(() => {
        if (active.stopRequested || active.isOwner()) return;
        publish(atoms, active, (turn) => turn && { ...turn, stopping: true, orphaned: true });
        requestStop(active);
    });
    const input = {
        connection: request.connection,
        model: request.model,
        effort: request.effort ?? undefined,
        startFen: state.root.fen,
        moves: getVariationLine(state.root, path),
        history: coachHistory(state.coachSession),
        message: question,
        game: coachGameContext(state.root, state.headers, path),
        engine: request.engine.handle,
        engineId: request.engine.id,
        uciOptions: normalizeEngineOptions(request.engine.settings ?? []),
    };
    let ticket: string;
    try {
        ticket = await tauri.prepareAnalysis(tab);
    } catch {
        finish(atoms, active, failed("busy"));
        return;
    }
    active.turn = ticket;
    if (active.stopRequested) {
        requestStop(active);
        finish(atoms, active, { type: "cancelled", text: "" });
        return;
    }
    try {
        finishCoachTurn(atoms, tab, ticket, await tauri.coachTurn(ticket, tab, input));
    } catch (cause) {
        // The turn never started, so its reservation is still open.
        requestStop(active);
        finishCoachTurn(atoms, tab, ticket, failed(coachErrorCode(cause)));
    }
}

function finishCoachTurn(atoms: Atoms, tab: string, turn: string, update: TurnUpdate) {
    const active = activeTurns.get(tab);
    if (!active || active.turn !== turn) return;
    if (update.type === "completed" || update.type === "cancelled" || update.type === "failed") {
        finish(atoms, active, update);
    }
}

/** Routes one turn event. An event for an unknown tab or for another turn of the tab is dropped. */
export function applyCoachTurnEvent(atoms: Atoms, event: CoachTurnEvent) {
    const active = activeTurns.get(event.tab);
    if (!active || active.turn !== event.turn) return;
    const { update } = event;
    switch (update.type) {
        case "text":
            publish(
                atoms,
                active,
                (turn) => turn && { ...turn, text: turn.text + update.delta, checking: null },
            );
            break;
        case "reset":
            publish(atoms, active, (turn) => turn && { ...turn, text: "", checking: null });
            break;
        case "tool":
            publish(atoms, active, (turn) => turn && { ...turn, checking: update.line });
            break;
        default:
            finish(atoms, active, update);
    }
}

/** Asks the tab's running turn to stop. Its end still arrives as a terminal update. */
export function stopCoachTurn(atoms: Atoms, tab: string) {
    const active = activeTurns.get(tab);
    if (!active || active.stopRequested) return;
    publish(atoms, active, (turn) => turn && { ...turn, stopping: true });
    requestStop(active);
}

/** Clears the tab's conversation. A running turn is stopped and will not be saved. */
export function startNewCoachConversation(atoms: Atoms, tab: string, tree: TreeStore) {
    const active = activeTurns.get(tab);
    if (active && active.tree === tree) {
        active.isOwner = () => false;
        publish(atoms, active, (turn) => turn && { ...turn, stopping: true, orphaned: true });
        if (!active.stopRequested) requestStop(active);
    }
    tree.getState().transitionCoachSession(() => undefined);
}

/** Test seam: the number of turns that have not ended. */
export function activeCoachTurnCount(): number {
    return activeTurns.size;
}
