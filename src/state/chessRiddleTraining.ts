import type {
    AccountError,
    TrainingPuzzle,
    TrainingSource,
    TrainingSubmission,
    TrainingVerdict,
} from "@/bindings";
import { ChessRiddleCommandError, requiresChessRiddleConnection } from "@/platform/chessriddle";
import { tauri } from "@/platform/tauri";
import { trainingSettings } from "./chessRiddleTrainingSettings";
import { trainingSummary } from "./chessRiddleTrainingSummary";
import { createTreeStore, type TreeStore } from "./store/tree";
import { defaultTree } from "@/utils/treeReducer";
import { produce } from "immer";
import {
    MAX_TRAINING_SUBMISSION_PLIES,
    MAX_TRAINING_DURATION_MS,
    MAX_TRAINING_EXCLUSIONS,
    canSubmitTraining,
    trainingDecision,
    trainingMoveNotice,
    trainingSubmissionTree,
    trainingVerdictTree,
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
    treeStore: TreeStore | null;
    inputNotice: "oneSolverMove" | "inputLimit" | null;
    rejectedTree: string | null;
    showMoveCounter: boolean;
    inputCap: number;
    submitThreshold: number;
    phase: "idle" | "loading" | "solving" | "submitting" | "verdict" | "error" | "empty";
    elapsedStart: number | null;
    verdict: TrainingVerdict | null;
    error: AccountError | null;
    failedOperation: Operation | null;
    frozenSubmission: TrainingSubmission | null;
    timedOutMistakeIds: number[];
    motif: string | null;
};

type Entry = {
    state: TrainingSession;
    request: symbol | null;
    availabilityRequest: symbol | null;
    availabilityPromise: Promise<boolean | null> | null;
    countRequest: symbol | null;
    upgradeRequest: symbol | null;
    listeners: Set<() => void>;
    unsubscribeTree?: () => void;
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
    settings = trainingSettings,
    summary = trainingSummary,
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
                    treeStore: null,
                    inputNotice: null,
                    rejectedTree: null,
                    showMoveCounter: false,
                    inputCap: 0,
                    submitThreshold: 0,
                    phase: "idle",
                    elapsedStart: null,
                    verdict: null,
                    error: null,
                    failedOperation: null,
                    frozenSubmission: null,
                    timedOutMistakeIds: [],
                    motif: null,
                },
                request: null,
                availabilityRequest: null,
                availabilityPromise: null,
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
    const disposeTree = (entry: Entry) => {
        entry.unsubscribeTree?.();
        entry.unsubscribeTree = undefined;
        entry.state.treeStore?.dispose();
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
        if (requiresChessRiddleConnection(error)) {
            settings.reset();
            summary.reset();
        }
        let timedOutMistakeIds = entry.state.timedOutMistakeIds;
        if (error === "engineTimeout" && entry.state.puzzle?.source === "mistakes") {
            timedOutMistakeIds = [
                ...timedOutMistakeIds.filter((id) => id !== entry.state.puzzle!.id),
                entry.state.puzzle.id,
            ].slice(-MAX_TRAINING_EXCLUSIONS);
        }
        publish(entry, { phase: "error", error, failedOperation: operation, timedOutMistakeIds });
    };
    const readAvailability = async (tabId: string) => {
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
                (entry.state.phase === "idle" || entry.state.failedOperation === "availability")
            )
                failure(entry, "availability", cause);
            return null;
        } finally {
            if (entry.availabilityRequest === identity) entry.availabilityRequest = null;
        }
    };
    const available = (tabId: string): Promise<boolean | null> => {
        const entry = ensure(tabId);
        if (entry.availabilityPromise) return entry.availabilityPromise;
        const promise = readAvailability(tabId).finally(() => {
            if (entry.availabilityPromise === promise) entry.availabilityPromise = null;
        });
        entry.availabilityPromise = promise;
        return promise;
    };
    const next = async (tabId: string, source?: TrainingSource) => {
        const entry = entries.get(tabId);
        if (!entry || entry.state.phase === "submitting") return;
        const identity = begin(entry);
        const selectedSource = source ?? entry.state.source;
        disposeTree(entry);
        publish(entry, {
            source: selectedSource,
            phase: "loading",
            puzzle: null,
            treeStore: null,
            inputNotice: null,
            rejectedTree: null,
            inputCap: 0,
            submitThreshold: 0,
            verdict: null,
            elapsedStart: null,
            error: null,
            failedOperation: null,
            frozenSubmission: null,
        });
        try {
            await Promise.all([settings.load(), summary.load()]);
            await settings.settled();
            if (!current(tabId, entry, identity)) return;
            const effective = settings.effective();
            const motif = selectedSource === "tactics" ? effective.motif : null;
            const puzzle = await api.chessriddleTrainingNext(
                selectedSource,
                selectedSource === "mistakes" ? [...entry.state.timedOutMistakeIds] : [],
                selectedSource === "tactics" ? effective.difficulty : null,
                motif,
            );
            if (!current(tabId, entry, identity)) return;
            if (puzzle) trainingDecision(puzzle);
            let treeStore: TreeStore | null = null;
            if (puzzle) {
                const tree = defaultTree(puzzle.decisionFen);
                tree.headers.orientation = puzzle.sideToMove;
                treeStore = createTreeStore(undefined, tree);
                entry.unsubscribeTree = treeStore.subscribe(() => publish(entry, {}));
            }
            publish(entry, {
                puzzle,
                motif,
                treeStore,
                showMoveCounter: effective.showMoveCounter,
                inputCap: effective.showMoveCounter
                    ? Math.min(puzzle?.solutionPlyCount ?? 0, MAX_TRAINING_SUBMISSION_PLIES)
                    : MAX_TRAINING_SUBMISSION_PLIES,
                submitThreshold: effective.showMoveCounter ? (puzzle?.solutionPlyCount ?? 0) : 1,
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
        const accountIdentity = summary.identity();
        publish(entry, {
            phase: "submitting",
            error: null,
            failedOperation: null,
            frozenSubmission: request,
        });
        try {
            const verdict = await api.chessriddleTrainingSubmit(request);
            if (!current(tabId, entry, identity)) return;
            summary.record(verdict, accountIdentity);
            if (!verdict.tooShort && entry.state.puzzle && entry.state.treeStore) {
                entry.state.treeStore
                    .getState()
                    .setState(
                        trainingVerdictTree(
                            entry.state.puzzle,
                            entry.state.treeStore.getState().root,
                            verdict,
                        ),
                    );
            }
            publish(entry, {
                verdict,
                inputCap: verdict.tooShort ? MAX_TRAINING_SUBMISSION_PLIES : entry.state.inputCap,
                rejectedTree: verdict.tooShort ? JSON.stringify(request.tree) : null,
                phase: verdict.tooShort ? "solving" : "verdict",
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
        const { puzzle, treeStore, elapsedStart } = entry.state;
        if (!treeStore || (!solutionShown && !canSubmit(tabId))) return;
        const tree = trainingSubmissionTree(treeStore.getState().root);
        const request: TrainingSubmission = Object.freeze({
            puzzleId: puzzle.id,
            source: puzzle.source,
            decisionFen: puzzle.decisionFen,
            tree,
            elapsedMs: Math.min(
                MAX_TRAINING_DURATION_MS,
                Math.max(0, Math.floor(now() - (elapsedStart ?? now()))),
            ),
            solutionShown,
            idempotencyKey: uuid(),
            motif: entry.state.motif,
        });
        await send(tabId, entry, request);
    };
    const canSubmit = (tabId: string) => {
        const state = get(tabId);
        const tree = state?.treeStore?.getState();
        return (
            !!state &&
            state.phase === "solving" &&
            !!tree &&
            canSubmitTraining(tree, state.submitThreshold) &&
            JSON.stringify(trainingSubmissionTree(tree.root)) !== state.rejectedTree
        );
    };
    const retry = async (tabId: string) => {
        const entry = entries.get(tabId);
        if (
            !entry ||
            entry.state.phase !== "error" ||
            !entry.state.error ||
            (entry.state.failedOperation !== "availability" && !retryable.has(entry.state.error))
        )
            return;
        if (entry.state.failedOperation === "submit" && entry.state.frozenSubmission)
            await send(tabId, entry, entry.state.frozenSubmission);
        else if (entry.state.failedOperation === "next") await next(tabId);
        else if (entry.state.failedOperation === "availability") await available(tabId);
    };
    const actions = (tabId: string, snapshot = get(tabId)): ("retry" | "next" | "continue")[] => {
        const state = snapshot;
        if (!state) return [];
        if (state.phase === "error") {
            if (state.failedOperation === "availability") return ["retry"];
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
        canSubmit,
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
            if (entry) disposeTree(entry);
            entries.delete(tabId);
            entry?.listeners.clear();
        },
        append(tabId: string, token: string) {
            const entry = entries.get(tabId);
            if (!entry || entry.state.phase !== "solving" || !entry.state.puzzle) return;
            const tree = entry.state.treeStore?.getState();
            if (!tree) return;
            const gate = trainingMoveNotice(tree, token, entry.state.inputCap);
            if (gate.notice) {
                publish(entry, { inputNotice: gate.notice });
                return;
            }
            if (gate.existing !== undefined) tree.goToMove([...tree.position, gate.existing]);
            else if (gate.move) tree.makeMove({ payload: gate.move, changeHeaders: false });
            if (entry.state.inputNotice) publish(entry, { inputNotice: null });
        },
        undo(tabId: string, path?: number[]) {
            const entry = entries.get(tabId);
            if (!entry || entry.state.phase !== "solving") return;
            const tree = entry.state.treeStore?.getState();
            if (!tree) return;
            const target = path ?? tree.position;
            if (target.length) tree.deleteMove(target);
            else {
                const empty = defaultTree(entry.state.puzzle!.decisionFen);
                empty.headers.orientation = entry.state.puzzle!.sideToMove;
                tree.setState(empty);
            }
            publish(entry, { inputNotice: null });
        },
        promote(tabId: string, path: number[]) {
            const entry = entries.get(tabId);
            if (!entry || entry.state.phase !== "solving" || !path.length) return;
            const store = entry.state.treeStore;
            if (!store) return;
            // The website swaps siblings rather than shifting all intervening indices.
            store.setState(
                produce(store.getState(), (tree) => {
                    const parentPath = path.slice(0, -1);
                    let parent = tree.root;
                    for (const index of parentPath) {
                        if (!parent.children[index]) return;
                        parent = parent.children[index];
                    }
                    const index = path.at(-1)!;
                    if (!parent.children[index] || index === 0) return;
                    [parent.children[0], parent.children[index]] = [
                        parent.children[index],
                        parent.children[0],
                    ];
                    if (
                        tree.position.length > parentPath.length &&
                        parentPath.every((value, i) => tree.position[i] === value)
                    ) {
                        const selected = tree.position[parentPath.length];
                        if (selected === 0) tree.position[parentPath.length] = index;
                        else if (selected === index) tree.position[parentPath.length] = 0;
                    }
                }),
            );
            publish(entry, { inputNotice: null });
        },
        step(tabId: string, action: "first" | "previous" | "next" | "last") {
            const tree = get(tabId)?.treeStore?.getState();
            if (!tree) return;
            if (action === "first") tree.goToStart();
            else if (action === "previous") tree.goToPrevious();
            else if (action === "next") tree.goToNext();
            else tree.goToBranchEnd();
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
                if (entries.get(tabId) === entry && entry.countRequest === identity) {
                    const error = new ChessRiddleCommandError(cause).code;
                    if (requiresChessRiddleConnection(error)) {
                        settings.reset();
                        summary.reset();
                    }
                    publish(entry, { mistakeCountError: error });
                }
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
    chessriddleTrainingNext: (source, excludeIds, difficulty, motif) =>
        tauri.chessriddleTrainingNext(source, excludeIds, difficulty, motif),
    chessriddleMistakeCount: () => tauri.chessriddleMistakeCount(),
    chessriddleTrainingSubmit: (request) => tauri.chessriddleTrainingSubmit(request),
    chessriddleOpenUpgrade: () => tauri.chessriddleOpenUpgrade(),
});
