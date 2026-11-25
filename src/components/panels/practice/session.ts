import { inScopeCards } from "@/components/files/opening";
import type { Position } from "@/utils/practicePosition";
import { validWeight } from "@/utils/practicePosition";
import type { PracticePhase, PracticeSessionStats, PracticeState } from "@/state/atoms";
import { getBoardState } from "@/utils/treeReducer";

export const PRACTICE_SLOW_ANSWER_MS = 10_000;
export const PRACTICE_REPLAY_STEP_MS = 450;
export const PRACTICE_RUN_COUNTDOWN_TICK_MS = 1_000;

export function getAutomaticPracticeGrade(timeTaken: number): 2 | 3 {
    return timeTaken <= PRACTICE_SLOW_ANSWER_MS ? 3 : 2;
}

export type PracticeQueue = {
    remainingPositionKeys: string[];
    reappendedPositionKeys: string[];
};

export function compareUnseenByWeight(
    left: { weight?: number },
    right: { weight?: number },
): number {
    const leftWeight = validWeight(left.weight);
    const rightWeight = validWeight(right.weight);
    if (leftWeight === undefined && rightWeight === undefined) return 0;
    if (leftWeight === undefined) return 1;
    if (rightWeight === undefined) return -1;
    return rightWeight - leftWeight;
}

export function buildPracticeQueue(
    positions: Position[],
    mode: PracticeSessionStats["mode"],
    newPerSession: number,
    now: Date,
): PracticeQueue {
    const scoped = inScopeCards(positions);
    if (mode === "full") {
        return {
            remainingPositionKeys: scoped.map(({ fen }) => getBoardState(fen)),
            reappendedPositionKeys: [],
        };
    }

    const unseenIndices: number[] = [];
    for (let index = 0; index < scoped.length; index++) {
        if (scoped[index].card.reps === 0) unseenIndices.push(index);
    }
    // unseenIndices is ascending and Array.prototype.sort is stable, so equal weights keep their
    // file order without an index tie-break.
    unseenIndices.sort((left, right) => compareUnseenByWeight(scoped[left], scoped[right]));
    const selectedUnseen = new Set(unseenIndices.slice(0, newPerSession));

    const remainingPositionKeys = scoped
        .filter((position, index) => {
            if (position.card.reps > 0) return new Date(position.card.due) <= now;
            return selectedUnseen.has(index);
        })
        .map(({ fen }) => getBoardState(fen));
    return { remainingPositionKeys, reappendedPositionKeys: [] };
}

/** Consume the current card, optionally asking a failed or introduced card once more. */
export function advancePracticeQueue(
    queue: PracticeQueue,
    mode: PracticeSessionStats["mode"],
    reappend = false,
): PracticeQueue {
    const [current, ...remainingPositionKeys] = queue.remainingPositionKeys;
    if (current === undefined) return queue;
    if (mode === "anki" && reappend && !queue.reappendedPositionKeys.includes(current)) {
        return {
            remainingPositionKeys: [...remainingPositionKeys, current],
            reappendedPositionKeys: [...queue.reappendedPositionKeys, current],
        };
    }
    return { ...queue, remainingPositionKeys };
}

/** Paths are a snapshot only. Resolve them again from the live tree before scheduling a step. */
export function buildPracticeReplay(
    currentPath: number[] | null,
    cardPath: number[],
    practiceStart: number[],
): { startPath: number[]; steps: number[][] } {
    const from = currentPath ?? practiceStart;
    const mismatch = from.findIndex((index, depth) => index !== cardPath[depth]);
    const commonLength = mismatch === -1 ? from.length : mismatch;
    const startPath = cardPath.slice(0, commonLength);
    const steps: number[][] = [];
    for (let length = commonLength + 1; length <= cardPath.length; length++) {
        steps.push(cardPath.slice(0, length));
    }
    return { startPath, steps };
}

export type PracticeSession = PracticeState & {
    token: number;
};

export function idlePracticeSession(token = 0): PracticeSession {
    return { phase: "idle", token };
}

export type PracticeEvent =
    | { type: "replay"; token: number; fen: string; positionKey: string }
    | { type: "replayed"; token: number; learning: boolean }
    | { type: "rebind"; token: number; fen: string; answer: string }
    | { type: "learned"; token: number }
    | { type: "correct"; token: number; answer: string; timeTaken: number }
    | { type: "wrong"; token: number; answer: string; playedMove: string; timeTaken: number }
    | { type: "reveal"; token: number; answer: string }
    | { type: "advance"; token: number }
    | { type: "end"; token: number };

/**
 * The session token makes delayed navigation and late board events harmless:
 * a transition may only affect the practice run that created it.
 */
export function practiceSessionReducer(
    state: PracticeSession,
    event: PracticeEvent,
): PracticeSession {
    if (event.type === "replay") {
        if (event.token < state.token) return state;
        if (
            event.token === state.token &&
            (state.phase !== "replaying" || state.positionKey !== event.positionKey)
        ) {
            return state;
        }
        return {
            phase: "replaying",
            token: event.token,
            currentFen: event.fen,
            positionKey: event.positionKey,
        };
    }
    if (event.token !== state.token) return state;
    switch (event.type) {
        case "rebind":
            return state.phase === "idle" || state.phase === "replaying"
                ? state
                : {
                      ...state,
                      currentFen: event.fen,
                      ...(state.answer !== undefined ? { answer: event.answer } : {}),
                  };
        case "end":
            return idlePracticeSession(event.token);
        case "replayed":
            return state.phase === "replaying"
                ? { ...state, phase: event.learning ? "learning" : "waiting" }
                : state;
        case "learned":
            return state.phase === "learning" ? { ...state, phase: "advancing" } : state;
        case "advance":
            return state.phase === "correct" ? { ...state, phase: "advancing" } : state;
        case "correct":
            return state.phase === "waiting" ||
                state.phase === "retry" ||
                state.phase === "revealed"
                ? { ...state, phase: "correct", answer: event.answer, timeTaken: event.timeTaken }
                : state;
        case "reveal":
            return state.phase === "waiting" || state.phase === "retry"
                ? { ...state, phase: "revealed", answer: event.answer }
                : state;
        case "wrong":
            return state.phase === "waiting" || state.phase === "retry"
                ? {
                      ...state,
                      phase: state.phase === "waiting" ? "retry" : "revealed",
                      answer: event.answer,
                      playedMove: event.playedMove,
                      timeTaken: event.timeTaken,
                  }
                : state;
    }
}

export function canSubmitPracticeMove(state: PracticeSession, currentFen: string): boolean {
    return (
        (state.phase === "waiting" ||
            state.phase === "retry" ||
            state.phase === "revealed" ||
            state.phase === "learning") &&
        state.currentFen === currentFen
    );
}

export function isPracticePhase(phase: PracticePhase): boolean {
    return phase !== "idle";
}
