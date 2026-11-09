import type {
    AccountError,
    TrainingPuzzle,
    TrainingSource,
    TrainingSubmission,
    TrainingVerdict,
} from "@/bindings";
import { ChessRiddleCommandError } from "@/platform/chessriddle";
import { tauri } from "@/platform/tauri";
import {
    appendTrainingMove,
    canSubmitTraining,
    trainingDecision,
    undoTrainingMove,
} from "@/utils/chessRiddleTraining";

type TrainingApi = Pick<
    typeof tauri,
    | "chessriddleTrainingAvailable"
    | "chessriddleTrainingNext"
    | "chessriddleMistakeCount"
    | "chessriddleTrainingSubmit"
    | "chessriddleOpenUpgrade"
>;
type Operation = "availability" | "next" | "submit";
export type TrainingSession = {
    source: TrainingSource;
    available: boolean | null;
    mistakeCount: number | null;
    mistakeCountError: AccountError | null;
    upgradeError: AccountError | null;
    puzzle: TrainingPuzzle | null;
    line: string[];
    inputCap: number;
    submitThreshold: number;
    cursor: number;
    phase: "idle" | "loading" | "solving" | "submitting" | "verdict" | "error" | "empty";
    elapsedStart: number | null;
    verdict: TrainingVerdict | null;
    error: AccountError | null;
    failedOperation: Operation | null;
    frozenSubmission: TrainingSubmission | null;
    timedOutMistakeIds: number[];
};

type Entry = {
    state: TrainingSession;
    request: symbol | null;
    availabilityRequest: symbol | null;
    countRequest: symbol | null;
    upgradeRequest: symbol | null;
    listeners: Set<() => void>;
};
const retryable = new Set<AccountError>([
    "network",
    "server",
    "busy",
    "rateLimited",
    "submissionInProgress",
    "engineBusy",
    "engineUnavailable",
]);

/** Memory is owned by tabs, independently of their mounted views. No puzzle reaches storage. */
export function createChessRiddleTrainingSessions(
    api: TrainingApi,
    now: () => number = () => performance.now(),
    uuid: () => string = () => crypto.randomUUID(),
) {
    const entries = new Map<string, Entry>();
    const get = (tabId: string) => entries.get(tabId)?.state;
    const ensure = (tabId: string, source: TrainingSource = "tactics") => {
        if (!entries.has(tabId))
            entries.set(tabId, {
                state: {
                    source,
                    available: null,
                    mistakeCount: null,
                    mistakeCountError: null,
                    upgradeError: null,
                    puzzle: null,
                    line: [],
                    inputCap: 0,
                    submitThreshold: 0,
                    cursor: 0,
                    phase: "idle",
                    elapsedStart: null,
                    verdict: null,
                    error: null,
                    failedOperation: null,
                    frozenSubmission: null,
                    timedOutMistakeIds: [],
                },
                request: null,
                availabilityRequest: null,
                countRequest: null,
                upgradeRequest: null,
                listeners: new Set(),
            });
        return entries.get(tabId)!;
    };
    const publish = (entry: Entry, patch: Partial<TrainingSession>) => {
        entry.state = { ...entry.state, ...patch };
        for (const listener of entry.listeners) listener();
    };
    const current = (tabId: string, entry: Entry, identity: symbol) =>
        entries.get(tabId) === entry && entry.request === identity;
    const begin = (entry: Entry) => {
        const identity = Symbol("training request");
        entry.request = identity;
        return identity;
    };
    const failure = (entry: Entry, operation: Operation, cause: unknown) => {
        const error = new ChessRiddleCommandError(cause).code;
        let timedOutMistakeIds = entry.state.timedOutMistakeIds;
        if (error === "engineTimeout" && entry.state.puzzle?.source === "mistakes") {
            timedOutMistakeIds = [
                ...timedOutMistakeIds.filter((id) => id !== entry.state.puzzle!.id),
                entry.state.puzzle.id,
            ].slice(-50);
        }
        publish(entry, { phase: "error", error, failedOperation: operation, timedOutMistakeIds });
    };
    const available = async (tabId: string) => {
        const entry = ensure(tabId);
        const identity = Symbol("training availability");
        entry.availabilityRequest = identity;
        try {
            const value = await api.chessriddleTrainingAvailable();
            if (entries.get(tabId) === entry && entry.availabilityRequest === identity)
                publish(
                    entry,
                    entry.state.failedOperation === "availability"
                        ? { available: value, phase: "idle", error: null, failedOperation: null }
                        : { available: value },
                );
            return value;
        } catch (cause) {
            if (
                entries.get(tabId) === entry &&
                entry.availabilityRequest === identity &&
                entry.state.phase === "idle"
            )
                failure(entry, "availability", cause);
            return false;
        } finally {
            if (entry.availabilityRequest === identity) entry.availabilityRequest = null;
        }
    };
    const next = async (tabId: string, source?: TrainingSource) => {
        const entry = entries.get(tabId);
        if (!entry || entry.state.phase === "submitting") return;
        const identity = begin(entry);
        const selectedSource = source ?? entry.state.source;
        publish(entry, {
            source: selectedSource,
            phase: "loading",
            puzzle: null,
            line: [],
            inputCap: 0,
            submitThreshold: 0,
            cursor: 0,
            verdict: null,
            elapsedStart: null,
            error: null,
            failedOperation: null,
            frozenSubmission: null,
        });
        try {
            const puzzle = await api.chessriddleTrainingNext(
                selectedSource,
                selectedSource === "mistakes" ? [...entry.state.timedOutMistakeIds] : [],
            );
            if (!current(tabId, entry, identity)) return;
            if (puzzle) trainingDecision(puzzle);
            publish(entry, {
                puzzle,
                inputCap: puzzle?.solutionPlyCount ?? 0,
                submitThreshold: puzzle?.solutionPlyCount ?? 0,
                phase: puzzle ? "solving" : "empty",
                elapsedStart: puzzle ? now() : null,
            });
        } catch (cause) {
            if (current(tabId, entry, identity)) failure(entry, "next", cause);
        } finally {
            if (entry.request === identity) entry.request = null;
        }
    };
    const send = async (tabId: string, entry: Entry, request: TrainingSubmission) => {
        const identity = begin(entry);
        publish(entry, {
            phase: "submitting",
            error: null,
            failedOperation: null,
            frozenSubmission: request,
        });
        try {
            const verdict = await api.chessriddleTrainingSubmit(request);
            if (!current(tabId, entry, identity)) return;
            publish(entry, {
                verdict,
                inputCap: verdict.tooShort ? 7 : entry.state.inputCap,
                submitThreshold: verdict.tooShort
                    ? request.line.length + 1
                    : entry.state.submitThreshold,
                phase: verdict.tooShort ? "solving" : "verdict",
                cursor: verdict.tooShort ? entry.state.cursor : 0,
                frozenSubmission: null,
            });
        } catch (cause) {
            if (current(tabId, entry, identity)) failure(entry, "submit", cause);
        } finally {
            if (entry.request === identity) entry.request = null;
        }
    };
    const submit = async (tabId: string, solutionShown = false) => {
        const entry = entries.get(tabId);
        if (!entry || entry.state.phase !== "solving" || !entry.state.puzzle) return;
        const { puzzle, line, elapsedStart } = entry.state;
        if (!solutionShown && !canSubmitTraining(puzzle, line, entry.state.submitThreshold)) return;
        const frozenLine = [...line];
        Object.freeze(frozenLine);
        const request: TrainingSubmission = Object.freeze({
            puzzleId: puzzle.id,
            source: puzzle.source,
            decisionFen: puzzle.decisionFen,
            line: frozenLine,
            elapsedMs: Math.min(
                86_400_000,
                Math.max(0, Math.floor(now() - (elapsedStart ?? now()))),
            ),
            solutionShown,
            idempotencyKey: uuid(),
        });
        await send(tabId, entry, request);
    };
    const retry = async (tabId: string) => {
        const entry = entries.get(tabId);
        if (
            !entry ||
            entry.state.phase !== "error" ||
            !entry.state.error ||
            !retryable.has(entry.state.error)
        )
            return;
        if (entry.state.failedOperation === "submit" && entry.state.frozenSubmission)
            await send(tabId, entry, entry.state.frozenSubmission);
        else if (entry.state.failedOperation === "next") await next(tabId);
        else if (entry.state.failedOperation === "availability") await available(tabId);
    };
    const actions = (tabId: string): ("retry" | "next" | "continue")[] => {
        const state = get(tabId);
        if (!state) return [];
        if (state.phase === "error") {
            if (state.error === "engineTimeout") return ["next"];
            if (state.error === "invalidRequest" && state.failedOperation === "submit")
                return ["next"];
            return state.error && retryable.has(state.error) ? ["retry"] : [];
        }
        if (state.phase === "verdict" || state.phase === "empty") return ["next"];
        return state.phase === "solving" && state.verdict?.tooShort ? ["continue"] : [];
    };
    return {
        get,
        ensure: (tabId: string, source?: TrainingSource) => ensure(tabId, source).state,
        available,
        next,
        submit,
        retry,
        actions,
        subscribe(tabId: string, listener: () => void) {
            const entry = ensure(tabId);
            entry.listeners.add(listener);
            return () => {
                entry.listeners.delete(listener);
            };
        },
        remove(tabId: string) {
            const entry = entries.get(tabId);
            entries.delete(tabId);
            entry?.listeners.clear();
        },
        append(tabId: string, token: string) {
            const entry = entries.get(tabId);
            if (!entry || entry.state.phase !== "solving" || !entry.state.puzzle) return;
            const line = appendTrainingMove(
                entry.state.puzzle,
                entry.state.line,
                token,
                entry.state.inputCap,
            );
            publish(entry, { line, cursor: line.length, verdict: null });
        },
        undo(tabId: string) {
            const entry = entries.get(tabId);
            if (!entry || entry.state.phase !== "solving") return;
            const line = undoTrainingMove(entry.state.line);
            publish(entry, { line, cursor: line.length, verdict: null });
        },
        step(tabId: string, cursor: number) {
            const entry = entries.get(tabId);
            if (!entry || !Number.isInteger(cursor)) return;
            const cap =
                entry.state.phase === "verdict"
                    ? (entry.state.verdict?.correctVariation.length ?? 0)
                    : entry.state.line.length;
            if (cursor >= 0 && cursor <= cap) publish(entry, { cursor });
        },
        async refreshMistakeCount(tabId: string) {
            const entry = entries.get(tabId);
            if (!entry) return;
            const identity = Symbol("training count");
            entry.countRequest = identity;
            try {
                const mistakeCount = await api.chessriddleMistakeCount();
                if (entries.get(tabId) === entry && entry.countRequest === identity)
                    publish(entry, { mistakeCount, mistakeCountError: null });
            } catch (cause) {
                if (entries.get(tabId) === entry && entry.countRequest === identity)
                    publish(entry, { mistakeCountError: new ChessRiddleCommandError(cause).code });
            } finally {
                if (entry.countRequest === identity) entry.countRequest = null;
            }
        },
        async openUpgrade(tabId: string) {
            const entry = entries.get(tabId);
            if (!entry || entry.upgradeRequest) return;
            const identity = Symbol("training upgrade");
            entry.upgradeRequest = identity;
            try {
                await api.chessriddleOpenUpgrade();
                if (entries.get(tabId) === entry && entry.upgradeRequest === identity)
                    publish(entry, { upgradeError: null });
            } catch (cause) {
                if (entries.get(tabId) === entry && entry.upgradeRequest === identity)
                    publish(entry, { upgradeError: new ChessRiddleCommandError(cause).code });
            } finally {
                if (entry.upgradeRequest === identity) entry.upgradeRequest = null;
            }
        },
    };
}

export const chessRiddleTrainingSessions = createChessRiddleTrainingSessions({
    chessriddleTrainingAvailable: () => tauri.chessriddleTrainingAvailable(),
    chessriddleTrainingNext: (source, excludeIds) =>
        tauri.chessriddleTrainingNext(source, excludeIds),
    chessriddleMistakeCount: () => tauri.chessriddleMistakeCount(),
    chessriddleTrainingSubmit: (request) => tauri.chessriddleTrainingSubmit(request),
    chessriddleOpenUpgrade: () => tauri.chessriddleOpenUpgrade(),
});
