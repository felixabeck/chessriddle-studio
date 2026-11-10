import type { Position } from "@/components/files/opening";
import type { PracticePhase, PracticeSessionStats, PracticeState } from "@/state/atoms";
import { getBoardState } from "@/utils/treeReducer";

export const PRACTICE_SLOW_ANSWER_MS = 10_000;
export const PRACTICE_REPLAY_STEP_MS = 450;

export function getAutomaticPracticeGrade(timeTaken: number): 2 | 3 {
    return timeTaken <= PRACTICE_SLOW_ANSWER_MS ? 3 : 2;
}

export type PracticeQueue = {
    remainingPositionKeys: string[];
    reappendedPositionKeys: string[];
};

export function buildPracticeQueue(
    positions: Position[],
    mode: PracticeSessionStats["mode"],
    newPerSession: number,
    now: Date,
): PracticeQueue {
    let newCount = 0;
    const remainingPositionKeys = positions
        .filter(({ card }) => {
            if (mode === "full") return true;
            if (card.reps > 0) return new Date(card.due) <= now;
            if (newCount >= newPerSession) return false;
            newCount++;
            return true;
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
    practiceStart: number[] = [],
): { startPath: number[]; steps: number[][] } {
    const from = currentPath ?? practiceStart;
    let commonLength = 0;
    while (commonLength < from.length && from[commonLength] === cardPath[commonLength]) {
        commonLength++;
    }
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
    if (event.type === "rebind") {
        return state.phase === "idle" || state.phase === "replaying"
            ? state
            : {
                  ...state,
                  currentFen: event.fen,
                  ...(state.answer !== undefined ? { answer: event.answer } : {}),
              };
    }
    if (event.type === "end") return idlePracticeSession(event.token);
    if (event.type === "replayed") {
        return state.phase === "replaying"
            ? { ...state, phase: event.learning ? "learning" : "waiting" }
            : state;
    }
    if (event.type === "learned") {
        return state.phase === "learning" ? { ...state, phase: "advancing" } : state;
    }
    if (event.type === "advance") {
        return state.phase === "correct" ? { ...state, phase: "advancing" } : state;
    }
    const acceptsAnswer =
        state.phase === "waiting" || state.phase === "retry" || state.phase === "revealed";
    if (event.type === "correct" && acceptsAnswer) {
        return { ...state, phase: "correct", answer: event.answer, timeTaken: event.timeTaken };
    }
    if (state.phase === "waiting" || state.phase === "retry") {
        if (event.type === "reveal") {
            return { ...state, phase: "revealed", answer: event.answer };
        }
        if (event.type === "wrong") {
            return {
                ...state,
                phase: state.phase === "waiting" ? "retry" : "revealed",
                answer: event.answer,
                playedMove: event.playedMove,
                timeTaken: event.timeTaken,
            };
        }
    }
    return state;
}

export function emptyPracticeStats(): PracticeSessionStats {
    return {
        mode: "anki",
        remainingPositionKeys: [],
        reappendedPositionKeys: [],
        introducedPositionKeys: [],
        correct: 0,
        incorrect: 0,
        streak: 0,
        bestStreak: 0,
    };
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
