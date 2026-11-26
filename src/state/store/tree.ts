import type { DrawShape } from "@lichess-org/chessground/draw";
import { notifications } from "@mantine/notifications";
import { type Move, parseUci } from "chessops";
import { normalizeMove } from "chessops/chess";
import { makeFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import { type Draft, freeze, produce } from "immer";
import { createStore, type StateCreator, type StoreApi } from "zustand";
import { persist, type PersistStorage } from "zustand/middleware";
import type { GameAnalysis, Outcome, Score } from "@/bindings";
import i18n from "@/i18n";
import { writeClipboardText } from "@/utils/clipboard";
import { persistStorageWriteError } from "../storageWriteError";
import {
    prepareTreeForStorage,
    tabStorage,
    TREE_STORAGE_VERSION,
    type TabTreeStorageStatus,
} from "./tabStorage";
import { boundCoachSession, coachSessionSchema, type CoachSession } from "@/state/coachSession";
import { boundPuzzleSession } from "@/state/puzzleSession";
import { reportPersistError } from "@/state/persistError";
import { ANNOTATION_INFO, type Annotation, isBasicAnnotation, nagGlyph } from "@/utils/annotation";
import { getMainLine, getPGN, reportRootFingerprint } from "@/utils/chess";
import { isSameMove, positionFromFen } from "@/utils/chessops";
import { validateMoveSequence, type MoveSequenceResult } from "@/utils/puzzles";
export { validateMoveSequence, type MoveSequenceResult } from "@/utils/puzzles";
import { isPrefix } from "@/utils/misc";
import type { BoundedGoMode } from "@/utils/engines";
import { judgeReport } from "@/utils/score";
import { playSound } from "@/utils/sound";
import { replacePgnCommentText } from "@/utils/pgnComment";
import {
    isPlainScoresheetLine,
    planScoresheetContinuation,
    replayScoresheetMoves,
} from "@/utils/scoresheet";
import { removeFileFreshness } from "@/state/fileFreshness";
import {
    createNode,
    defaultTree,
    countMainPly,
    type GameHeaders,
    getMainlineEndNode,
    getNodeAtPath,
    type ListNode,
    nextOpenVariation,
    stripUnsureMarks,
    type TreeNode,
    type TreeState,
    treeIteratorMainLine,
    getBoardState,
    getMemoizedBoardStateMap,
    normalizeFen,
    normalizeTreeHalfMoves,
    getEffectiveGameEnd,
    getEffectiveTermination,
    getResolvedPathLength,
    acceptsStartingComment,
    MAX_GAME_END_TERMINATION_LENGTH,
    treeIterator,
} from "@/utils/treeReducer";
import {
    editedHeaderFields,
    documentChanged,
    EMPTY_TREE_HISTORY,
    recordEdit,
    stepHistory,
    type TreeHistory,
} from "./treeHistory";

type CompleteTreeState = TreeState & Pick<TreeStoreState, "linkedSource">;

let nextDocumentId = 0;
const newDocumentId = () => ++nextDocumentId;

async function copyPgnToClipboard(serialize: () => string): Promise<boolean> {
    try {
        await writeClipboardText(serialize());
        return true;
    } catch {
        notifications.show({ message: i18n.t("Board.CopyFailed"), color: "danger" });
        return false;
    }
}

export interface TreeStoreState extends TreeState {
    /** Identifies the installed document across ordinary edits. Never persisted. */
    documentId: number;
    linkedSource?: import("@/bindings").LinkedGameLocator | null;
    setLinkedSource: (source: import("@/bindings").LinkedGameLocator | null) => void;
    /** Refresh after an operation's own transition, combine with its live-position/token guard. */
    capturePuzzleSessionOwner: () => () => boolean;
    /** Builds from the latest live frame and publishes only after durable admission. */
    transitionPuzzleSession: (update: (draft: Draft<TreeState>) => void) => SessionTransitionResult;
    /**
     * True while the store still holds the document and the Coach conversation it held when the
     * check was captured: another game, a reset and a new conversation each end it.
     */
    captureCoachSessionOwner: () => () => boolean;
    /** Replaces the Coach conversation, bounded, with the same durable admission. */
    transitionCoachSession: (
        update: (session: CoachSession | undefined) => CoachSession | undefined,
    ) => SessionTransitionResult;
    currentNode: () => TreeNode;
    getNode: (path: number[]) => TreeNode | null;

    goToNext: () => void;
    /** Plays continuation `index` of nextContinuation; refused during a practice drill (d-20260923-04/-05). */
    goToContinuation: (index: number) => void;
    goToPrevious: () => void;
    goToStart: () => void;
    /** During a practice drill, does nothing unless its target is on practicePath up to and including the card (a prefix of practicePath; d-20260923-04/-05). */
    goToEnd: () => void;
    goToMove: (move: number[]) => void;
    goToBranchStart: () => void;
    /** During a practice drill, does nothing unless its target is on practicePath up to and including the card (a prefix of practicePath; d-20260923-04/-05). */
    goToBranchEnd: () => void;
    /**
     * Inside a line, goes to its end. At a variation end, goes to the next sibling variation,
     * or child 0 of the same fork after the last sibling. Stays at the main line end.
     * During a practice drill, inside a line it does nothing unless the line end is a prefix of practicePath; at a line end it is refused.
     */
    goToBranchEndOrNextLine: () => void;
    /** During a practice drill, does nothing unless its target is on practicePath up to and including the card (a prefix of practicePath; d-20260923-04/-05). */
    nextBranch: () => void;
    /** During a practice drill, does nothing unless its target is on practicePath up to and including the card (a prefix of practicePath; d-20260923-04/-05). */
    previousBranch: () => void;
    /** During a practice drill, does nothing unless its target is on practicePath up to and including the card (a prefix of practicePath; d-20260923-04/-05). */
    nextBranching: () => void;
    previousBranching: () => void;
    /**
     * Goes to the next open variation (a side line one move long) in notation order, wrapping to
     * the first one. During a practice drill, does nothing unless its target is on practicePath up to and including the card (a prefix of practicePath; d-20260923-04/-05).
     */
    goToNextOpenVariation: () => void;

    /** During a practice drill, does nothing unless its target is on practicePath up to and including the card (a prefix of practicePath; d-20260923-04/-05). */
    goToAnnotation: (annotation: Annotation, color: "white" | "black") => void;

    makeMove: (args: {
        payload: string | Move;
        changePosition?: boolean;
        mainline?: boolean;
        clock?: number;
        changeHeaders?: boolean;
    }) => void;

    appendMove: (args: { payload: Move; clock?: number }) => void;

    makeMoves: (args: {
        payload: string[];
        mainline?: boolean;
        changeHeaders?: boolean;
    }) => MoveSequenceResult;
    deleteMove: (path?: number[]) => void;
    /** Deletes the whole side line `path` lies in, from its first move; a no-op on the main line. */
    deleteVariation: (path: number[]) => void;
    /** Deletes every move after `path`, keeping the move itself. */
    deleteMovesAfter: (path: number[]) => void;
    promoteVariation: (path: number[]) => void;
    promoteToMainline: (path: number[]) => void;
    copyPgn: () => Promise<boolean>;
    copyVariationPgn: (path: number[]) => Promise<boolean>;

    setStart: (start: number[]) => void;

    setAnnotation: (payload: Annotation) => void;
    setComment: (payload: string) => void;
    /**
     * Replaces the prose of the comment in front of the current move, keeping the commands it
     * carries; empty prose with no commands removes it. Only where `acceptsStartingComment` holds.
     */
    setStartingComment: (payload: string) => void;
    /** Flips the diagram marker of the node at `path`; without a path, of the current node. */
    toggleDiagram: (path?: number[]) => void;
    setHeaders: (payload: GameHeaders) => void;
    setResult: (payload: Outcome) => void;
    setGameEnd: (path: number[]) => void;
    clearGameEnd: () => void;
    setTermination: (text: string) => void;
    setShapes: (shapes: DrawShape[]) => void;
    /** Records the live engine's evaluation of the current node; view-only, leaves `dirty` alone. */
    setEngineScore: (score: Score) => void;

    clearShapes: () => void;
    /** Clears the scoresheet unsure mark on the current node. Not undoable, leaves `dirty` unchanged. */
    clearUnsureMark: () => void;
    /** Ends the scoresheet review: clears every unsure mark, `scoresheetReview` and in-memory photos. Not undoable, leaves `dirty` unchanged. */
    finishScoresheetReview: () => void;
    /** Replays remaining moves from the scoresheet after a stop or a mid-game correction. One undo step. */
    continueScoresheet: () => void;

    setFen: (fen: string) => void;

    /**
     * Writes a finished report onto the tree as one undoable edit, replacing the previous report.
     * Refused (returns false) unless `request` names the tab's current report operation and the
     * game it was started on.
     */
    applyReport: (result: GameAnalysis, request: ReportRequest) => boolean;

    setReportInProgress: (value: boolean) => void;
    setReportOperationId: (value: string | null) => void;

    practicePath: number[] | null;
    setPracticePath: (path: number[] | null) => void;

    setState: (state: CompleteTreeState) => void;
    reset: () => void;
    save: (stamp?: string, revision?: string) => void;
    setSourceStamp: (stamp: string | null, revision?: string) => void;
    setAppendAttempted: (value: boolean) => void;
    setStoreAttempts: (destinations: string[]) => void;

    /** Session-only undo/redo of document edits. Never persisted. */
    history: TreeHistory;
    /** Restores the document before the last edit; refused during a practice drill. */
    undo: () => void;
    /** Reapplies the last undone edit; refused during a practice drill. */
    redo: () => void;
}

/** The store state written to tab storage: everything except `documentId` and `history`. */
type PersistedTreeStoreState = Omit<TreeStoreState, "documentId" | "history">;

export type SessionTransitionResult =
    | { success: true; persistence: "saved" | "memory" }
    | { success: false; error: Error };

export type TreeStore = StoreApi<TreeStoreState>;
const installAdmittedTree = Symbol("installAdmittedTree");
type PersistedTreeStore = TreeStore & {
    [installAdmittedTree]: StoreApi<TreeStoreState>["setState"];
    persist: {
        rehydrate: () => Promise<void> | void;
        getOptions: () => { name?: string };
        setOptions: (options: {
            name: string;
            storage: PersistStorage<PersistedTreeStoreState>;
        }) => void;
    };
};

const reportOwners = new Map<string, object>();
const treeStores = new Map<string, PersistedTreeStore>();
const treeStoreCreatedListeners = new Set<(id: string, store: TreeStore) => void>();
const closingReportOwners = new Map<string, ReportOwnerInvalidation>();
const reviewEndedListeners = new Set<(tabId: string) => void>();

/** Registers a cleanup callback invoked when a tab's scoresheet review ends or its game is replaced. */
export function registerScoresheetReviewCleanup(listener: (tabId: string) => void): void {
    reviewEndedListeners.add(listener);
}

function notifyScoresheetReviewEnded(tabId: string): void {
    for (const listener of reviewEndedListeners) listener(tabId);
}

/** Notifies subscribers whenever a persisted per-tab tree store is created and cached. */
export function subscribeTreeStoreCreated(
    listener: (id: string, store: TreeStore) => void,
): () => void {
    treeStoreCreatedListeners.add(listener);
    return () => {
        treeStoreCreatedListeners.delete(listener);
    };
}

export function getCachedTreeStore(tab: string): TreeStore | undefined {
    return treeStores.get(tab);
}

function treeReplacementState(tree: CompleteTreeState) {
    return {
        puzzleSession: undefined,
        // Another game starts another conversation, unless the tree brings its own back.
        coachSession: undefined,
        // Another game ends any scoresheet review, unless the tree brings its own back.
        scoresheetReview: undefined,
        ...tree,
        documentId: newDocumentId(),
        linkedSource: tree.linkedSource ?? null,
        practicePath: null,
        history: EMPTY_TREE_HISTORY,
    };
}

/** Prepare the adapter and state before admission, then install without queuing a seeded tree. */
export function prepareTreeStoreRetarget(tab: string, treeKey: string, tree: CompleteTreeState) {
    const store = treeStores.get(tab)!;
    const options = {
        name: treeKey,
        storage: tabStorage.storageFor<PersistedTreeStoreState>(treeKey !== tab),
    };
    const state = treeReplacementState(tree);
    const install = store[installAdmittedTree];
    return Object.assign(
        () => {
            notifyScoresheetReviewEnded(tab);
            store.persist.setOptions(options);
            install(state);
        },
        { state },
    );
}

/** Switch the cached logical owner's persistence generation after durable admission. */
export function retargetTreeStore(tab: string, treeKey: string, tree: CompleteTreeState): void {
    prepareTreeStoreRetarget(tab, treeKey, tree)();
}

export type ReportOwnerInvalidation = {
    previous: object | undefined;
    invalidated: object;
    decision: Promise<boolean>;
    decide: (restored: boolean) => void;
};

export function captureReportOwner(tab: string): object {
    const existing = reportOwners.get(tab);
    if (existing) return existing;
    const owner = {};
    reportOwners.set(tab, owner);
    return owner;
}

export function invalidateReportOwner(tab: string): ReportOwnerInvalidation {
    let decide: (restored: boolean) => void = () => undefined;
    const invalidation = {
        previous: reportOwners.get(tab),
        invalidated: {},
        decision: new Promise<boolean>((resolve) => {
            decide = resolve;
        }),
        decide: (restored: boolean) => decide(restored),
    };
    reportOwners.set(tab, invalidation.invalidated);
    closingReportOwners.set(tab, invalidation);
    return invalidation;
}

export function restoreReportOwner(tab: string, invalidation: ReportOwnerInvalidation): void {
    if (
        reportOwners.get(tab) !== invalidation.invalidated ||
        closingReportOwners.get(tab) !== invalidation
    )
        return;
    if (invalidation.previous) reportOwners.set(tab, invalidation.previous);
    else reportOwners.delete(tab);
    closingReportOwners.delete(tab);
    invalidation.decide(true);
}

export function isReportOwnerCurrent(tab: string, owner: object): boolean {
    return reportOwners.get(tab) === owner;
}

export async function waitForReportOwner(tab: string, owner: object): Promise<boolean> {
    if (isReportOwnerCurrent(tab, owner)) return true;
    const closing = closingReportOwners.get(tab);
    if (!closing || closing.previous !== owner) return false;
    const restored = await closing.decision;
    return restored && isReportOwnerCurrent(tab, owner);
}

export function closeTreeStore(tab: string): void {
    const closing = closingReportOwners.get(tab);
    closingReportOwners.delete(tab);
    treeStores.delete(tab);
    reportOwners.delete(tab);
    removeFileFreshness(tab);
    notifyScoresheetReviewEnded(tab);
    closing?.decide(false);
}

/** Rehydrates the existing cached store after storage refused its initial tree read. */
export async function retryTreeStoreStorage(tab: string): Promise<TabTreeStorageStatus | null> {
    const store = treeStores.get(tab);
    if (!store) throw new Error("The tab has no cached tree store to retry.");
    await store.persist.rehydrate();
    if (treeStores.get(tab) !== store) return null;
    return tabStorage.getStatus(store.persist.getOptions().name!);
}

/** Discards an undecodable value and resets its cached store only after storage confirms removal. */
export function discardTreeStoreStorage(tab: string, treeKey = tab): boolean {
    if (!tabStorage.discardUnreadable(treeKey)) return false;
    treeStores.get(tab)?.getState().reset();
    return true;
}

function installRoot(state: Draft<TreeStoreState>, root: TreeNode): void {
    state.root = root;
    state.documentId = newDocumentId();
    state.scoresheetReview = undefined;
    // A fresh headers object, never a mutation of the current one: in setHeaders it is the caller's
    // object, just assigned into the draft. The start path indexed the tree being replaced.
    const { start: _start, ...headers } = state.headers;
    state.headers = { ...headers, fen: root.fen };
    state.practicePath = null;
    state.position = [];
}

export function nextContinuation(
    state: Pick<TreeStoreState, "root" | "position" | "headers" | "practicePath">,
): { path: number[]; children: TreeNode[] } | null {
    const node = getNodeAtPath(state.root, state.position);
    if (!node) return null;
    if (node.children.length > 0) return { path: state.position, children: node.children };
    if (state.practicePath !== null) return null;

    const currentFen = getBoardState(node.fen);
    const entries =
        getMemoizedBoardStateMap(state.root, state.headers.start ?? [])[currentFen] || [];
    const target = entries.find((e) => e.node !== node && e.node.children.length > 0);
    if (!target) return null;
    return { path: target.path, children: target.node.children };
}

/** The next sibling variation's start, or the same fork's main move. No target on the main line. */
export function nextSiblingVariationOrMainMove(
    root: TreeNode,
    position: number[],
): number[] | null {
    let lastVariation = position.length - 1;
    while (lastVariation >= 0 && position[lastVariation] === 0) lastVariation -= 1;
    if (lastVariation < 0) return null;
    const prefix = position.slice(0, lastVariation);
    const parent = getNodeAtPath(root, prefix);
    const next = position[lastVariation] + 1;
    return [...prefix, next < parent.children.length ? next : 0];
}

/**
 * Shared cursor assignment of the jump actions (`stepSibling`, `goToAnnotation`, `goToEnd`,
 * `goToBranchEnd`, `nextBranching`, `goToNextOpenVariation`). d-20260923-04/-05: during a practice drill they may only land
 * on the drill line up to the card position; anything past or beside it shows the answer.
 */
function moveCursorWithinDrill(state: Draft<TreeStoreState>, target: number[]): void {
    if (state.practicePath === null || isPrefix(target, state.practicePath))
        state.position = target;
}

function stepIntoChild(
    path: number[],
    children: TreeNode[],
    index: number,
): Partial<TreeStoreState> {
    const child = children[index];
    if (!child?.move || !child.san) return {};
    const { san } = child;
    playSound(san.includes("x"), san.includes("+"));
    return { position: [...path, index] };
}

type TreeSet = Parameters<StateCreator<TreeStoreState>>[0];
type TreeGet = Parameters<StateCreator<TreeStoreState>>[1];

type TreeNavigationActions = Pick<
    TreeStoreState,
    | "currentNode"
    | "getNode"
    | "goToNext"
    | "goToContinuation"
    | "goToPrevious"
    | "goToAnnotation"
    | "goToEnd"
    | "goToStart"
    | "goToMove"
    | "goToBranchStart"
    | "goToBranchEnd"
    | "goToBranchEndOrNextLine"
    | "nextBranch"
    | "previousBranch"
    | "nextBranching"
    | "previousBranching"
    | "goToNextOpenVariation"
>;

type TreeMutationActions = Pick<
    TreeStoreState,
    | "setFen"
    | "makeMove"
    | "appendMove"
    | "makeMoves"
    | "deleteMove"
    | "deleteVariation"
    | "deleteMovesAfter"
    | "promoteVariation"
    | "promoteToMainline"
    | "continueScoresheet"
>;

type TreeMarkupActions = Pick<
    TreeStoreState,
    | "copyPgn"
    | "copyVariationPgn"
    | "setStart"
    | "setAnnotation"
    | "setComment"
    | "setStartingComment"
    | "toggleDiagram"
    | "setGameEnd"
    | "clearGameEnd"
    | "setTermination"
    | "setHeaders"
    | "setResult"
    | "setShapes"
    | "setEngineScore"
    | "applyReport"
    | "setReportInProgress"
    | "setReportOperationId"
    | "clearShapes"
    | "clearUnsureMark"
    | "finishScoresheetReview"
>;

/**
 * The `set` producer for nextBranch (`1`) / previousBranch (`-1`): steps to the adjacent sibling,
 * wrapping around the fork. On a single-child move that opens a fork it steps among that fork's
 * children instead.
 */
function stepSibling(step: 1 | -1) {
    return produce((state: Draft<TreeStoreState>) => {
        if (state.position.length === 0) return;

        const target = [...state.position];
        let parent = getNodeAtPath(state.root, target.slice(0, -1));
        let branchIndex = target[target.length - 1];
        const node = parent.children[branchIndex];

        // Makes the navigation more fluid and compatible with next/previous branching
        if (node.children.length >= 2 && parent.children.length <= 1) {
            target.push(0);
            parent = getNodeAtPath(state.root, target.slice(0, -1));
            branchIndex = target[target.length - 1];
        }

        const count = parent.children.length;
        target[target.length - 1] = (branchIndex + count + step) % count;
        moveCursorWithinDrill(state, target);
    });
}

/** Cursor movement. Never edits the tree, so none of these mark the document dirty. */
function treeNavigationActions(set: TreeSet, get: TreeGet): TreeNavigationActions {
    return {
        currentNode: () => getNodeAtPath(get().root, get().position),
        getNode: (path: number[]) => getNodeAtPath(get().root, path),

        goToNext: () => {
            set((state) => {
                const { practicePath } = state;
                if (
                    practicePath !== null &&
                    (!isPrefix(state.position, practicePath) ||
                        state.position.length >= practicePath.length)
                )
                    return {};

                const c = nextContinuation(state);
                if (!c) return {};
                const index = practicePath === null ? 0 : practicePath[state.position.length];
                return stepIntoChild(c.path, c.children, index);
            });
        },
        goToContinuation: (index) => {
            set((state) => {
                if (state.practicePath !== null) return {};
                const c = nextContinuation(state);
                if (!c) return {};
                return stepIntoChild(c.path, c.children, index);
            });
        },
        goToPrevious: () => {
            set((state) => ({
                position: state.position.slice(0, -1),
            }));
        },

        goToAnnotation: (annotation, color) =>
            set(
                produce((state) => {
                    const colorN = color === "white" ? 1 : 0;

                    let p: number[] = [...state.position];
                    let node = getNodeAtPath(state.root, p);
                    const searchLimit = countMainPly(node) + countMainPly(state.root) + 1;
                    for (let i = 0; i < searchLimit; i++) {
                        node = getNodeAtPath(state.root, p);
                        if (node.children.length === 0) {
                            p = [];
                        } else {
                            p = [...p, 0];
                        }

                        node = getNodeAtPath(state.root, p);

                        if (
                            node.nags.some((code) => nagGlyph(code) === annotation) &&
                            node.halfMoves % 2 === colorN
                        ) {
                            moveCursorWithinDrill(state, p);
                            return;
                        }
                    }
                }),
            ),

        goToEnd: () =>
            set(
                produce((state) => {
                    const target: number[] = [];
                    let currentNode = state.root;
                    while (currentNode.children.length > 0) {
                        target.push(0);
                        currentNode = currentNode.children[0];
                    }
                    moveCursorWithinDrill(state, target);
                }),
            ),
        goToStart: () =>
            set((state) => ({
                ...state,
                position: state.headers.start || [],
            })),
        goToMove: (move) =>
            set((state) => ({
                ...state,
                position: move,
            })),
        goToBranchStart: () => {
            set(
                produce((state) => {
                    if (
                        state.position.length > 0 &&
                        state.position[state.position.length - 1] !== 0
                    ) {
                        state.position = state.position.slice(0, -1);
                    }

                    while (
                        state.position.length > 0 &&
                        state.position[state.position.length - 1] === 0
                    ) {
                        state.position = state.position.slice(0, -1);
                    }
                }),
            );
        },

        goToBranchEnd: () => {
            set(
                produce((state) => {
                    const target = [...state.position];
                    let currentNode = getNodeAtPath(state.root, target);
                    while (currentNode.children.length > 0) {
                        target.push(0);
                        currentNode = currentNode.children[0];
                    }
                    moveCursorWithinDrill(state, target);
                }),
            );
        },

        goToBranchEndOrNextLine: () => {
            const state = get();
            const node = getNodeAtPath(state.root, state.position);
            if (node.children.length > 0) {
                state.goToBranchEnd();
                return;
            }
            if (state.practicePath !== null) return;
            const next = nextSiblingVariationOrMainMove(state.root, state.position);
            if (next) set({ position: next });
        },

        nextBranch: () => set(stepSibling(1)),
        previousBranch: () => set(stepSibling(-1)),

        nextBranching: () =>
            set(
                produce((state) => {
                    const target = [...state.position];
                    let node = getNodeAtPath(state.root, target);
                    let branchCount = node.children.length;

                    if (branchCount === 0) return;

                    do {
                        target.push(0);
                        node = node.children[0];
                        branchCount = node.children.length;
                    } while (branchCount === 1);
                    moveCursorWithinDrill(state, target);
                }),
            ),

        previousBranching: () =>
            set(
                produce((state) => {
                    let node = getNodeAtPath(state.root, state.position);
                    let branchCount = node.children.length;

                    if (state.position.length === 0) return;

                    do {
                        state.position = state.position.slice(0, -1);
                        node = getNodeAtPath(state.root, state.position);
                        branchCount = node.children.length;
                    } while (branchCount === 1 && state.position.length > 0);
                }),
            ),

        goToNextOpenVariation: () => {
            // Walked outside the recipe: inside it, the walk would wrap every node in a draft.
            const { root, position } = get();
            const target = nextOpenVariation(root, position);
            if (target === null) return;
            set(
                produce((state) => {
                    moveCursorWithinDrill(state, target);
                }),
            );
        },
    };
}

/** Tree edits; the node bookkeeping lives in the module-level helpers (`installRoot`, `makeMove`, `deleteMove`, `promoteVariation`). */
function treeMutationActions(set: TreeSet, get: TreeGet, tabId?: string): TreeMutationActions {
    return {
        setFen: (fen) => {
            set(
                produce((state) => {
                    state.dirty = true;
                    installRoot(state, defaultTree(fen).root);
                }),
            );
            if (tabId) notifyScoresheetReviewEnded(tabId);
        },

        makeMove: ({ payload, changePosition, mainline, clock, changeHeaders = true }) => {
            set(
                produce((state) => {
                    if (typeof payload === "string") {
                        const node = getNodeAtPath(state.root, state.position);
                        if (!node) return;
                        const [pos] = positionFromFen(node.fen);
                        if (!pos) return;
                        const move = parseSan(pos, payload);
                        if (!move) return;
                        payload = move;
                    }
                    makeMove({
                        state,
                        move: payload,
                        last: false,
                        changePosition,
                        changeHeaders,
                        mainline,
                        clock,
                    });
                }),
            );
        },

        appendMove: ({ payload, clock }) =>
            set(
                produce((state) => {
                    makeMove({ state, move: payload, last: true, clock });
                }),
            ),

        makeMoves: ({ payload, mainline, changeHeaders = true }) => {
            if (payload.length === 0) return { success: true, moves: [] };
            const state = get();
            const node = getNodeAtPath(state.root, state.position);
            const result = validateMoveSequence(node.fen, payload);
            if (!result.success) return result;
            set(
                produce((state) => {
                    for (const [i, move] of result.moves.entries()) {
                        makeMove({
                            state,
                            move,
                            last: false,
                            mainline,
                            sound: i === payload.length - 1,
                            changeHeaders,
                        });
                    }
                }),
            );
            return result;
        },

        deleteMove: (path) =>
            set(
                produce((state) => {
                    state.dirty = true;
                    deleteMove(state, path ?? state.position);
                }),
            ),
        deleteVariation: (path) =>
            set(
                produce((state) => {
                    const start = variationStartPath(path);
                    if (!start) return;
                    state.dirty = true;
                    deleteMove(state, start);
                }),
            ),
        deleteMovesAfter: (path) =>
            set(
                produce((state) => {
                    // getNodeAtPath falls back to the deepest resolved node; a stale path must not
                    // clear an ancestor's moves.
                    if (getResolvedPathLength(state.root, path) !== path.length) return;
                    const node = getNodeAtPath(state.root, path);
                    if (node.children.length === 0) return;
                    state.dirty = true;
                    node.children = [];
                    rebaseTrackedPaths(
                        state,
                        (target) =>
                            target.length > path.length && isPrefix(path, target)
                                ? undefined
                                : target,
                        { position: path, start: undefined, practicePath: path },
                    );
                }),
            ),
        promoteVariation: (path) =>
            set(
                produce((state) => {
                    if (!variationStartPath(path)) return;
                    state.dirty = true;
                    promoteVariation(state, path);
                }),
            ),
        promoteToMainline: (path) =>
            set(
                produce((state) => {
                    state.dirty = true;
                    let p = path;
                    while (p.some((v) => v !== 0)) {
                        p = promoteVariation(state, p);
                    }
                }),
            ),
        continueScoresheet: () =>
            set(
                produce((state) => {
                    const plan = planScoresheetContinuation(
                        state.root,
                        state.position,
                        state.scoresheetReview,
                    );
                    if (!plan) return;

                    if (plan.kind === "after-stop") {
                        const userNode = getNodeAtPath(state.root, state.position);
                        const replayed = replayScoresheetMoves(userNode, plan.moves);
                        if (replayed > 0 || userNode.unsure !== undefined) {
                            delete userNode.unsure;
                            state.dirty = true;
                        }
                        return;
                    }

                    const userPath = [...state.position];
                    const userNode = getNodeAtPath(state.root, userPath);
                    delete userNode.unsure;

                    const replayed = replayScoresheetMoves(userNode, plan.moves);
                    const allOldReplayed = replayed >= plan.oldMainLineMoveCount;

                    promoteVariation(state, userPath);
                    const oldLinePath = [...plan.parentPath, 1];
                    const oldLineNode = getNodeAtPath(state.root, oldLinePath);

                    const oldLastNode = getMainlineEndNode(oldLineNode);
                    if (allOldReplayed && oldLastNode.gameEnd !== undefined) {
                        let counterpart = userNode;
                        for (let i = 0; i < plan.oldMainLineMoveCount; i += 1) {
                            counterpart = counterpart.children[0];
                        }
                        counterpart.gameEnd = { ...oldLastNode.gameEnd };
                        delete oldLastNode.gameEnd;
                    }

                    if (allOldReplayed && isPlainScoresheetLine(oldLineNode)) {
                        deleteMove(state, oldLinePath);
                    } else {
                        for (const { node } of treeIterator(oldLineNode)) {
                            if (node.unsure !== undefined) delete node.unsure;
                        }
                    }
                    state.dirty = true;
                }),
            ),
    };
}

/** Clipboard export, annotations, comments, game end, headers, shapes, scores, analysis and report flags. */
function treeMarkupActions(set: TreeSet, get: TreeGet, tabId?: string): TreeMarkupActions {
    return {
        copyVariationPgn: (path) => {
            const { root } = get();
            return copyPgnToClipboard(() =>
                getPGN(root, {
                    headers: null,
                    comments: false,
                    extraMarkups: false,
                    glyphs: true,
                    variations: false,
                    path,
                }),
            );
        },
        copyPgn: () => {
            const { root, headers } = get();
            return copyPgnToClipboard(() =>
                getPGN(root, {
                    headers,
                    comments: true,
                    extraMarkups: true,
                    glyphs: true,
                    variations: true,
                }),
            );
        },
        setStart: (start) =>
            set(
                produce((state) => {
                    state.dirty = true;
                    state.headers.start = start;
                }),
            ),
        setAnnotation: (payload) =>
            set(
                produce((state) => {
                    if (state.position.length === 0) {
                        return;
                    }
                    state.dirty = true;
                    const node = getNodeAtPath(state.root, state.position);
                    if (node) {
                        if (node.nags.some((code) => nagGlyph(code) === payload)) {
                            node.nags = node.nags.filter((code) => nagGlyph(code) !== payload);
                        } else {
                            node.nags = replaceInGroup(node.nags, payload);
                        }
                    }
                }),
            ),
        setComment: (payload) =>
            set(
                produce((state) => {
                    state.dirty = true;
                    const node = getNodeAtPath(state.root, state.position);
                    if (node) {
                        node.comment = payload;
                    }
                }),
            ),
        setStartingComment: (payload) =>
            set(
                produce((state) => {
                    if (!acceptsStartingComment(state.root, state.position)) return;
                    const node = getNodeAtPath(state.root, state.position);
                    const next = replacePgnCommentText(node.startingComment ?? "", payload);
                    if (next === (node.startingComment ?? "")) return;
                    state.dirty = true;
                    if (next === "") delete node.startingComment;
                    else node.startingComment = next;
                }),
            ),
        toggleDiagram: (path) =>
            set(
                produce((state) => {
                    const target = path ?? state.position;
                    if (
                        !Array.isArray(target) ||
                        getResolvedPathLength(state.root, target) !== target.length
                    )
                        return;
                    const node = getNodeAtPath(state.root, target);
                    if (node.diagram) delete node.diagram;
                    else node.diagram = true;
                    state.dirty = true;
                }),
            ),
        setGameEnd: (path) =>
            set(
                produce((state) => {
                    if (
                        !Array.isArray(path) ||
                        path.length === 0 ||
                        !path.every((index) => index === 0) ||
                        getResolvedPathLength(state.root, path) !== path.length
                    )
                        return;
                    const termination = getEffectiveTermination(state);
                    for (const { node } of treeIterator(state.root)) delete node.gameEnd;
                    getNodeAtPath(state.root, path).gameEnd =
                        termination === undefined ? {} : { termination };
                    state.dirty = true;
                }),
            ),
        clearGameEnd: () =>
            set(
                produce((state) => {
                    for (const { node } of treeIterator(state.root)) delete node.gameEnd;
                    state.dirty = true;
                }),
            ),
        setTermination: (text) =>
            set(
                produce((state) => {
                    if (typeof text !== "string" || text.length > MAX_GAME_END_TERMINATION_LENGTH)
                        return;
                    const end = getEffectiveGameEnd(state.root);
                    if (!end) return;
                    end.node.gameEnd = text === "" ? {} : { termination: text };
                    if (state.headers.other) delete state.headers.other.Termination;
                    state.dirty = true;
                }),
            ),
        setHeaders: (headers) => {
            let rootReplaced = false;
            set(
                produce((state) => {
                    state.dirty = true;
                    // Store and compare the spelling a root is installed with, so a tag that only
                    // differs by a dropped en-passant square neither replaces the tree on an edit
                    // nor leaves headers.fen disagreeing with root.fen.
                    state.headers = headers.fen
                        ? { ...headers, fen: normalizeFen(headers.fen) }
                        : headers;
                    if (headers.fen && state.headers.fen !== normalizeFen(state.root.fen)) {
                        installRoot(state, defaultTree(headers.fen).root);
                        rootReplaced = true;
                    }
                }),
            );
            if (rootReplaced && tabId) notifyScoresheetReviewEnded(tabId);
        },
        setResult: (result) =>
            set(
                produce((state) => {
                    state.dirty = true;
                    state.headers.result = result;
                }),
            ),
        setShapes: (shapes) =>
            set(
                produce((state) => {
                    state.dirty = true;
                    setShapes(state, shapes);
                }),
            ),
        setEngineScore: (score) =>
            set(
                produce((state) => {
                    const node = getNodeAtPath(state.root, state.position);
                    if (node) node.engineScore = score;
                }),
            ),
        applyReport: (result, request) => {
            let applied = false;
            set(
                produce((state: Draft<TreeStoreState>) => {
                    applied = applyReport(state, result, request);
                    if (applied) state.dirty = true;
                }),
            );
            return applied;
        },

        setReportInProgress: (value: boolean) => {
            set(
                produce((state: Draft<TreeStoreState>) => {
                    state.report.inProgress = value;
                }),
            );
        },

        setReportOperationId: (value: string | null) => {
            set(
                produce((state: Draft<TreeStoreState>) => {
                    state.report.operationId = value;
                }),
            );
        },

        clearShapes: () =>
            set(
                produce((state) => {
                    const node = getNodeAtPath(state.root, state.position);
                    if (node && node.shapes.length > 0) {
                        state.dirty = true;
                        node.shapes = [];
                    }
                }),
            ),

        clearUnsureMark: () =>
            set(
                produce((state) => {
                    if (!state.scoresheetReview) return;
                    const target = state.position;
                    if (
                        target.length === 0 ||
                        getResolvedPathLength(state.root, target) !== target.length
                    )
                        return;
                    const node = getNodeAtPath(state.root, target);
                    if (node.unsure) delete node.unsure;
                }),
            ),

        finishScoresheetReview: () => {
            set(
                produce((state) => {
                    for (const { node } of treeIterator(state.root)) {
                        if (node.unsure !== undefined) delete node.unsure;
                    }
                    state.scoresheetReview = undefined;
                }),
            );
            if (tabId) notifyScoresheetReviewEnded(tabId);
        },
    };
}

/**
 * Tree and header edits a user can undo. The other mutation and markup actions are listed in
 * `NOT_UNDOABLE`. Navigation actions never change the document and are in neither list.
 */
const UNDOABLE_EDITS = [
    "setFen",
    "makeMove",
    "appendMove",
    "makeMoves",
    "deleteMove",
    "deleteVariation",
    "deleteMovesAfter",
    "promoteVariation",
    "promoteToMainline",
    "continueScoresheet",
    "setStart",
    "setAnnotation",
    "setComment",
    "setStartingComment",
    "toggleDiagram",
    "setGameEnd",
    "clearGameEnd",
    "setTermination",
    "setHeaders",
    "setResult",
    "setShapes",
    "applyReport",
    "clearShapes",
] as const;

/** Clipboard export, the engine's view-only score, report bookkeeping and scoresheet review controls are not edits. */
const NOT_UNDOABLE = [
    "copyPgn",
    "copyVariationPgn",
    "setEngineScore",
    "setReportInProgress",
    "setReportOperationId",
    "clearUnsureMark",
    "finishScoresheetReview",
] as const;

type UndoableEdit = (typeof UNDOABLE_EDITS)[number];
type EditActions = TreeMutationActions & TreeMarkupActions;
// A new mutation or markup action must be classified, or this assignment stops compiling.
const _everyEditActionClassified: Exclude<
    keyof EditActions,
    UndoableEdit | (typeof NOT_UNDOABLE)[number]
> extends never
    ? true
    : never = true;

/**
 * Typing into one comment, one header field or the termination text is one step, not one per
 * keystroke. Any other edit, undo or redo ends the merge.
 */
function editMergeKey(
    name: UndoableEdit,
    before: TreeStoreState,
    after: TreeStoreState,
): string | null {
    if (name === "setComment") return `comment:${before.position.join(".")}`;
    if (name === "setStartingComment") return `startingComment:${before.position.join(".")}`;
    if (name === "setTermination") return "termination";
    if (name === "setHeaders" && before.root === after.root) {
        return `headers:${editedHeaderFields(before.headers, after.headers).join(",")}`;
    }
    return null;
}

/**
 * Builds the mutation and markup actions on a setter that records the replaced document in the
 * same state write, so an edit notifies subscribers and queues persistence once. Only a call to an
 * action in `UNDOABLE_EDITS` records; the `NOT_UNDOABLE` actions write through the same setter
 * with no edit active, so they never record.
 */
function recordingEditActions(set: TreeSet, get: TreeGet, tabId?: string): EditActions {
    let active: UndoableEdit | null = null;
    const recordingSet = ((partial: Parameters<TreeSet>[0], replace?: boolean) =>
        set(
            (state) => {
                const update = typeof partial === "function" ? partial(state) : partial;
                if (active === null) return update;
                const next = { ...state, ...update };
                if (!documentChanged(state, next)) return update;
                return {
                    ...update,
                    history: recordEdit(state.history, state, editMergeKey(active, state, next)),
                };
            },
            replace as false | undefined,
        )) as TreeSet;
    const actions: EditActions = {
        ...treeMutationActions(recordingSet, get, tabId),
        ...treeMarkupActions(recordingSet, get, tabId),
    };
    const recorded: Record<string, unknown> = { ...actions };
    for (const name of UNDOABLE_EDITS) {
        const action = actions[name] as (...args: unknown[]) => unknown;
        recorded[name] = (...args: unknown[]) => {
            active = name;
            try {
                return action(...args);
            } finally {
                active = null;
            }
        };
    }
    return recorded as EditActions;
}

/** Restores a recorded document. The board orientation stays as the user has it now. */
function applyHistoryStep(
    state: TreeStoreState,
    direction: "undo" | "redo",
): Partial<TreeStoreState> {
    if (state.practicePath !== null) return {};
    const step = stepHistory(state.history, state, direction);
    if (!step) return {};
    const { orientation: _recorded, ...headers } = step.restore.headers;
    const { orientation } = state.headers;
    return {
        root: step.restore.root,
        headers: orientation === undefined ? headers : { ...headers, orientation },
        position: step.restore.position,
        documentId: step.restore.documentId,
        // The summary belongs to the tree it describes; the run flags belong to the live run.
        report: { ...state.report, summary: step.restore.reportSummary },
        dirty: true,
        history: step.history,
    };
}

export const createTreeStore = (id?: string, initTree?: CompleteTreeState, treeKey = id) => {
    if (id) {
        const existing = treeStores.get(id);
        if (existing) return existing;
    }
    const initialTree = initTree ?? defaultTree();
    let install!: StoreApi<TreeStoreState>["setState"];
    let isCurrent = () => true;
    let persistenceKey = () => treeKey;
    /**
     * A change to one of the tab's sessions: built from the latest live frame, written durably,
     * and installed only after that write was admitted.
     */
    const admitSessionTransition = (
        get: () => TreeStoreState,
        update: (draft: Draft<TreeState>) => void,
    ): SessionTransitionResult => {
        let candidate: TreeStoreState;
        try {
            if (!isCurrent()) throw new Error("The tab's tree owner has retired.");
            candidate = produce(get(), update);
            candidate = freeze({ ...candidate, ...prepareTreeForStorage(candidate) }, true);
            if (id) tabStorage.seed(persistenceKey()!, candidate);
        } catch (cause) {
            const error = persistStorageWriteError(cause);
            reportPersistError(error);
            return { success: false, error };
        }
        // Subscriber failures occur after installation. They must not be reported as a
        // refused save or invite a retry of a transition that is already durable.
        install(candidate);
        return { success: true, persistence: id ? "saved" : "memory" };
    };
    const stateCreator: StateCreator<TreeStoreState> = (set, get) => ({
        ...initialTree,
        documentId: newDocumentId(),
        history: EMPTY_TREE_HISTORY,
        undo: () => set((state) => applyHistoryStep(state, "undo")),
        redo: () => set((state) => applyHistoryStep(state, "redo")),

        capturePuzzleSessionOwner: () => {
            const key = persistenceKey();
            const session = get().puzzleSession;
            return () => isCurrent() && persistenceKey() === key && get().puzzleSession === session;
        },

        transitionPuzzleSession: (update) =>
            admitSessionTransition(get, (draft) => {
                update(draft);
                if (draft.puzzleSession)
                    draft.puzzleSession = boundPuzzleSession(draft.puzzleSession);
            }),

        captureCoachSessionOwner: () => {
            const key = persistenceKey();
            const document = get().documentId;
            const conversation = get().coachSession?.id;
            return () =>
                isCurrent() &&
                persistenceKey() === key &&
                get().documentId === document &&
                get().coachSession?.id === conversation;
        },

        transitionCoachSession: (update) =>
            admitSessionTransition(get, (draft) => {
                const next = update(draft.coachSession);
                // Strict here: reading drops a conversation that does not match the schema, so a
                // write that would not be read back is refused instead of silently lost.
                draft.coachSession = next && coachSessionSchema.parse(boundCoachSession(next));
            }),

        practicePath: null,
        setPracticePath: (path) => set({ practicePath: path }),

        setState: (state) => {
            if (id) notifyScoresheetReviewEnded(id);
            set(() => treeReplacementState(state));
        },

        reset: () => {
            if (id) notifyScoresheetReviewEnded(id);
            set(() => treeReplacementState(defaultTree()));
        },

        save: (stamp, revision) => {
            set((state) => ({
                ...state,
                dirty: false,
                sourceStamp: stamp ?? state.sourceStamp,
                linkedSource:
                    state.linkedSource && stamp && revision
                        ? { ...state.linkedSource, stamp, generation: revision }
                        : state.linkedSource,
                appendAttempted: false,
            }));
        },

        setAppendAttempted: (value) => set({ appendAttempted: value }),
        setStoreAttempts: (destinations) => set({ storeAttempts: destinations }),
        setSourceStamp: (stamp, revision) =>
            set((state) => ({
                sourceStamp: stamp,
                linkedSource:
                    state.linkedSource && stamp && revision
                        ? { ...state.linkedSource, stamp, generation: revision }
                        : state.linkedSource,
            })),
        setLinkedSource: (linkedSource) => set({ linkedSource }),

        ...treeNavigationActions(set, get),
        ...recordingEditActions(set, get, id),
    });

    if (id) {
        const persistedCreator = persist(stateCreator, {
            name: treeKey!,
            version: TREE_STORAGE_VERSION,
            storage: tabStorage.storageFor<PersistedTreeStoreState>(treeKey !== id),
            partialize: ({ documentId: _documentId, history: _history, ...state }) =>
                state.scoresheetReview ? state : { ...state, root: stripUnsureMarks(state.root) },
            onRehydrateStorage: () => (state, error) => {
                if (!error && state) {
                    // A renderer reload cannot resume the JavaScript completion owner that
                    // registered this operation. Treat persisted report identity as stale;
                    // ordinary provider remounts reuse the live store and never rehydrate.
                    state.report.inProgress = false;
                    state.report.operationId = null;
                    // The rehydrated tree replaces the one any recorded step belongs to.
                    state.history = EMPTY_TREE_HISTORY;
                    normalizeTreeHalfMoves(state.root);
                    // A tab persisted before roots were normalized keeps its rejected en-passant
                    // square otherwise, and the engine, report and database refuse it.
                    const fen = normalizeFen(state.root.fen);
                    if (fen !== state.root.fen) {
                        if (state.headers.fen === state.root.fen) state.headers.fen = fen;
                        state.root.fen = fen;
                    }
                }
            },
        });
        const capturedCreator: typeof persistedCreator = (set, get, api) => {
            // Capture the original setter outside persist so installing an already durably
            // seeded tree does not queue another persistence write.
            install = set;
            return persistedCreator(set, get, api);
        };
        const store = createStore<TreeStoreState>()(capturedCreator);
        const ownedStore = Object.assign(store, {
            [installAdmittedTree]: install,
        });
        treeStores.set(id, ownedStore);
        for (const listener of treeStoreCreatedListeners) listener(id, ownedStore);
        isCurrent = () => treeStores.get(id) === ownedStore;
        persistenceKey = () => ownedStore.persist.getOptions().name;
        return ownedStore;
    }

    const store = createStore<TreeStoreState>()(stateCreator);
    install = store.setState;
    return store;
};

export const getOrCreateTreeStore = (
    id: string,
    initTree?: CompleteTreeState,
    treeKey = id,
): TreeStore => createTreeStore(id, initTree, treeKey);

export function makeMove({
    state,
    move,
    last,
    changePosition = true,
    changeHeaders = true,
    mainline = false,
    clock,
    sound = true,
}: {
    state: TreeState & { practicePath?: number[] | null };
    move: Move;
    last: boolean;
    changePosition?: boolean;
    changeHeaders?: boolean;
    mainline?: boolean;
    clock?: number;
    sound?: boolean;
}) {
    const mainLine = Array.from(treeIteratorMainLine(state.root));
    const position = last ? mainLine[mainLine.length - 1].position : state.position;
    const moveNode = getNodeAtPath(state.root, position);
    if (!moveNode) return;
    const [pos] = positionFromFen(moveNode.fen);
    if (!pos) return;
    if (!pos.isLegal(move)) return;
    const san = makeSan(pos, move);
    pos.play(move);
    if (sound) {
        playSound(san.includes("x"), san.includes("+"));
    }
    const existingIndex = moveNode.children.findIndex((n) => n.san === san);
    const targetIndex =
        existingIndex !== -1 ? existingIndex : mainline ? 0 : moveNode.children.length;
    const endsMainLine =
        position.every((index) => index === 0) &&
        targetIndex === 0 &&
        (existingIndex === -1 || moveNode.children[existingIndex].children.length === 0);
    // Adjudication only applies when the move ends the main line, so a variation never rewrites the game's Result.
    const end = getEffectiveGameEnd(state.root);
    const endOnResultingPath =
        end &&
        targetIndex === 0 &&
        position.every((index) => index === 0) &&
        (end.position.length <= position.length ||
            (existingIndex === 0 && end.position.length === position.length + 1));
    const adjudicate = changeHeaders && endsMainLine && !endOnResultingPath;
    const previousResult = state.headers.result;
    if (adjudicate && pos.isEnd()) {
        if (pos.isCheckmate()) {
            state.headers.result = pos.turn === "white" ? "0-1" : "1-0";
        }
        if (pos.isStalemate() || pos.isInsufficientMaterial()) {
            state.headers.result = "1/2-1/2";
        }
    }

    const newFen = makeFen(pos.toSetup());

    if (
        adjudicate &&
        !pos.isCheckmate() &&
        (isThreeFoldRepetition(state, newFen, position) || is50MoveRule(newFen))
    ) {
        state.headers.result = "1/2-1/2";
    }

    if (state.headers.result !== previousResult) {
        state.dirty = true;
    }

    const i = existingIndex;
    if (i !== -1) {
        if (changePosition) {
            if (state.position === position) {
                state.position.push(i);
            } else {
                state.position = [...position, i];
            }
        }
    } else {
        state.dirty = true;
        const newMoveNode = createNode({
            fen: newFen,
            move,
            san,
            halfMoves: moveNode.halfMoves + 1,
            clock,
        });
        if (mainline) {
            moveNode.children.unshift(newMoveNode);
            rebaseTrackedPaths(state, (target) => rebasePathAfterPrepend(target, position), {
                position: state.position,
                start: state.headers.start,
                practicePath: state.practicePath,
            });
        } else {
            moveNode.children.push(newMoveNode);
        }
        if (changePosition) {
            if (state.position === position) {
                if (mainline) {
                    state.position.push(0);
                } else {
                    state.position.push(moveNode.children.length - 1);
                }
            } else {
                state.position = [...position, moveNode.children.length - 1];
            }
        }
    }
}

function isThreeFoldRepetition(state: TreeState, fen: string, position: number[]): boolean {
    const targetState = getBoardState(fen);
    let matchCount = 0;

    if (getBoardState(state.root.fen) === targetState) {
        matchCount++;
    }

    let node = state.root;
    for (const i of position) {
        node = node.children[i];
        if (getBoardState(node.fen) === targetState) {
            matchCount++;
        }
    }

    // `fen` is the candidate about to be appended, so it is the final occurrence.
    return matchCount + 1 >= 3;
}

function is50MoveRule(fen: string) {
    const halfmoveClock = Number.parseInt(fen.trim().split(/\s+/)[4], 10);
    return halfmoveClock >= 100;
}

function rebasePathAfterDelete(target: number[], deleted: number[]): number[] | undefined {
    if (isPrefix(deleted, target)) return undefined;
    const parentDepth = deleted.length - 1;
    if (
        target.length > parentDepth &&
        isPrefix(deleted.slice(0, -1), target) &&
        target[parentDepth] > deleted[parentDepth]
    ) {
        const rebased = [...target];
        rebased[parentDepth] -= 1;
        return rebased;
    }
    return target;
}

function rebasePathAfterPromotion(target: number[], parent: number[], promotedIndex: number) {
    if (target.length <= parent.length || !isPrefix(parent, target)) return target;
    const rebased = [...target];
    const siblingIndex = rebased[parent.length];
    if (siblingIndex === promotedIndex) rebased[parent.length] = 0;
    else if (siblingIndex < promotedIndex) rebased[parent.length] += 1;
    return rebased;
}

function rebasePathAfterPrepend(target: number[], parent: number[]): number[] {
    if (target.length <= parent.length || !isPrefix(parent, target)) return target;
    const rebased = [...target];
    rebased[parent.length] += 1;
    return rebased;
}

function rebaseTrackedPaths(
    state: TreeState & { practicePath?: number[] | null },
    rebase: (target: number[]) => number[] | undefined,
    fallback: {
        position: number[];
        start: number[] | undefined;
        practicePath: number[] | null | undefined;
    },
) {
    state.position = rebase(state.position) ?? fallback.position;
    if (state.headers.start) state.headers.start = rebase(state.headers.start) ?? fallback.start;
    if (state.practicePath != null)
        state.practicePath = rebase(state.practicePath) ?? fallback.practicePath;
}

function deleteMove(state: TreeStoreState, path: number[]) {
    if (path.length === 0) return;
    const node = getNodeAtPath(state.root, path);
    if (!node) return;
    const parent = getNodeAtPath(state.root, path.slice(0, -1));
    if (!parent) return;
    const index = parent.children.findIndex((n) => n === node);
    if (index < 0) return;
    parent.children.splice(index, 1);
    const deletedParentPath = path.slice(0, -1);
    rebaseTrackedPaths(state, (target) => rebasePathAfterDelete(target, path), {
        position: deletedParentPath,
        start: undefined,
        practicePath: deletedParentPath,
    });
}

/**
 * The path of the first move of the side line `path` lies in, or `null` when `path` is on the
 * main line. The side line starts at the last index that is not the first child.
 */
export function variationStartPath(path: number[]): number[] | null {
    const i = path.findLastIndex((v) => v !== 0);
    return i === -1 ? null : path.slice(0, i + 1);
}

function promoteVariation(state: TreeStoreState, path: number[]): number[] {
    const start = variationStartPath(path);
    if (!start) return path;

    const v = start[start.length - 1];
    const promotablePath = start.slice(0, -1);
    const node = getNodeAtPath(state.root, promotablePath);
    if (!node) return path;
    node.children.unshift(node.children.splice(v, 1)[0]);
    rebaseTrackedPaths(state, (target) => rebasePathAfterPromotion(target, promotablePath, v), {
        position: state.position,
        start: state.headers.start,
        practicePath: state.practicePath,
    });
    return rebasePathAfterPromotion(path, promotablePath, v);
}

function setShapes(state: TreeState, shapes: DrawShape[]) {
    const node = getNodeAtPath(state.root, state.position);
    if (!node) return state;

    // Chessground reports the complete user drawing state, not a delta. Keeping it as
    // such preserves multiple arrows and square markers through any rerender/save cycle.
    node.shapes = shapes.map((shape) =>
        shape.modifiers ? { ...shape, modifiers: { ...shape.modifiers } } : { ...shape },
    );

    return state;
}

const MAX_GENERATED_ANALYSIS_VARIATION_PLIES = 10;

function replaceInGroup(nags: readonly number[], annotation: Annotation): number[] {
    const next = nags.filter((code) => {
        const glyph = nagGlyph(code);
        return (
            !glyph ||
            !ANNOTATION_INFO[glyph].group ||
            ANNOTATION_INFO[glyph].group !== ANNOTATION_INFO[annotation].group
        );
    });
    next.push(ANNOTATION_INFO[annotation].nag);
    return next;
}

/** What a report run asked for, and which operation and game it belongs to. */
export type ReportRequest = {
    operationId: string;
    /** `reportRootFingerprint` of the root FEN and mainline the run was started on. */
    fingerprint: string;
    engine: string;
    goMode: BoundedGoMode;
    /** Replace the move-quality marks on the main line (P1). */
    marks: boolean;
    /** Add the engine's better line after a mistake. */
    lines: boolean;
    createdAt: number;
};

/**
 * Removes every report line hanging off a mainline node: a child with the report-line marker
 * that is not its parent's mainline continuation. Tracked paths are rebased like `deleteMove`.
 */
function removeReportLines(state: TreeStoreState, mainline: ListNode[]) {
    for (const { node, position: path } of mainline) {
        for (let index = node.children.length - 1; index > 0; index--) {
            if (node.children[index].reportLine !== true) continue;
            node.children.splice(index, 1);
            const deleted = [...path, index];
            rebaseTrackedPaths(state, (target) => rebasePathAfterDelete(target, deleted), {
                position: path,
                start: undefined,
                practicePath: path,
            });
        }
    }
}

/** The engine's line from `parent`, as tree nodes, up to the first move that is not legal. */
function reportLineNodes(
    parent: TreeNode,
    line: GameAnalysis["positions"][number]["best"][number],
) {
    const [position] = positionFromFen(parent.fen);
    if (!position) return null;
    let first: TreeNode | null = null;
    let last: TreeNode | null = null;
    let halfMoves = parent.halfMoves;
    for (const uci of line.uciMoves.slice(0, MAX_GENERATED_ANALYSIS_VARIATION_PLIES)) {
        const parsed = parseUci(uci);
        if (!parsed) break;
        const move = normalizeMove(position, parsed);
        if (!position.isLegal(move)) break;
        const san = makeSan(position, move);
        position.play(move);
        halfMoves += 1;
        const node = createNode({ fen: makeFen(position.toSetup()), move, san, halfMoves });
        if (last) last.children.push(node);
        else first = node;
        last = node;
    }
    if (!first) return null;
    first.score = line.score;
    first.depth = line.depth;
    first.reportLine = true;
    return first;
}

function applyReport(state: TreeStoreState, result: GameAnalysis, request: ReportRequest): boolean {
    if (state.report.operationId !== request.operationId) return false;
    if (reportRootFingerprint(state.root.fen, getMainLine(state.root)) !== request.fingerprint)
        return false;
    const { positions, novelty } = result;
    const mainline = Array.from(treeIteratorMainLine(state.root));
    if (positions.length !== mainline.length) return false;
    const marks = judgeReport(
        positions,
        mainline.map(({ node }) => node),
    );

    // Index 0 is never removed, so the main line and its paths stay valid.
    removeReportLines(state, mainline);

    let drawWritten = false;
    mainline.forEach(({ node }, index) => {
        const position = positions[index];
        if (position.best.length > 0) {
            node.score = position.best[0].score;
            node.depth = position.best[0].depth;
            delete node.engineScore;
        } else if (position.terminal === "draw" && !drawWritten) {
            // Bare kings included: the renderer's chess library may still see legal moves there.
            node.score = { value: { type: "cp", value: 0 }, wdl: null };
            node.depth = null;
            delete node.engineScore;
            drawWritten = true;
        } else {
            node.score = null;
            node.depth = null;
        }
    });

    if (request.marks) {
        mainline.forEach(({ node }, index) => {
            if (index === 0) return;
            const kept = node.nags.filter((code) => {
                const glyph = nagGlyph(code);
                return !glyph || !isBasicAnnotation(glyph);
            });
            const mark = marks[index];
            node.nags = mark ? [...kept, ANNOTATION_INFO[mark].nag] : kept;
        });
    }

    if (novelty.kind === "found" || novelty.kind === "notFound") {
        const noveltyCode = ANNOTATION_INFO.N.nag;
        for (const { node } of mainline) {
            if (node.nags.includes(noveltyCode))
                node.nags = node.nags.filter((code) => code !== noveltyCode);
        }
        // The root is the start position, not a move: it never carries N.
        if (novelty.kind === "found" && novelty.position > 0) {
            const node = mainline[novelty.position]?.node;
            if (node) node.nags = [...node.nags, noveltyCode];
        }
    }

    if (request.lines) {
        mainline.forEach((_, index) => {
            const mark = marks[index];
            if (index === 0 || (mark !== "?!" && mark !== "?" && mark !== "??")) return;
            const parent = mainline[index - 1].node;
            const line = positions[index - 1].best[0];
            const [parentPosition] = positionFromFen(parent.fen);
            const engineMove = line?.uciMoves[0] ? parseUci(line.uciMoves[0]) : undefined;
            if (!parentPosition || !engineMove) return;
            const exists = parent.children.some(
                (child) => child.move && isSameMove(parentPosition, child.move, engineMove),
            );
            if (exists) return;
            const first = reportLineNodes(parent, line);
            if (first) parent.children.push(first);
        });
    }

    state.report.summary = {
        engine: request.engine,
        goMode: request.goMode,
        createdAt: request.createdAt,
        missingEvaluations: positions.filter(
            (position) => position.best.length === 0 && position.terminal === null,
        ).length,
        novelty: novelty.kind,
        fingerprint: request.fingerprint,
    };
    return true;
}
