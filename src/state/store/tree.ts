import type { DrawShape } from "@lichess-org/chessground/draw";
import { isNormal, type Move, parseUci } from "chessops";
import { normalizeMove } from "chessops/chess";
import { makeFen } from "chessops/fen";
import { makeSan, parseSan } from "chessops/san";
import { type Draft, freeze, produce } from "immer";
import { createStore, type StateCreator, type StoreApi } from "zustand";
import { persist, type PersistStorage } from "zustand/middleware";
import type { BestMoves, Outcome, Score } from "@/bindings";
import {
    prepareTreeForStorage,
    persistStorageWriteError,
    tabStorage,
    TREE_STORAGE_VERSION,
    type TabTreeStorageStatus,
} from "./tabStorage";
import { boundPuzzleSession } from "@/state/puzzleSession";
import { reportPersistError } from "@/state/persistError";
import { ANNOTATION_INFO, type Annotation, nagGlyph } from "@/utils/annotation";
import { getPGN } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import { validateMoveSequence, type MoveSequenceResult } from "@/utils/puzzles";
export { validateMoveSequence, type MoveSequenceResult } from "@/utils/puzzles";
import { isPrefix } from "@/utils/misc";
import { getAnnotation } from "@/utils/score";
import { playSound } from "@/utils/sound";
import { removeFileFreshness } from "@/state/fileFreshness";
import {
    createNode,
    defaultTree,
    countMainPly,
    type GameHeaders,
    getNodeAtPath,
    type TreeNode,
    type TreeState,
    treeIteratorMainLine,
    getBoardState,
    getMemoizedBoardStateMap,
    normalizeTreeHalfMoves,
    getEffectiveGameEnd,
    getEffectiveTermination,
    getResolvedPathLength,
    MAX_GAME_END_TERMINATION_LENGTH,
    treeIterator,
} from "@/utils/treeReducer";

type CompleteTreeState = TreeState & Pick<TreeStoreState, "linkedSource">;

export interface TreeStoreState extends TreeState {
    linkedSource?: import("@/bindings").LinkedGameLocator | null;
    setLinkedSource: (source: import("@/bindings").LinkedGameLocator | null) => void;
    /** Refresh after an operation's own transition, combine with its live-position/token guard. */
    capturePuzzleSessionOwner: () => () => boolean;
    /** Builds from the latest live frame and publishes only after durable admission. */
    transitionPuzzleSession: (
        update: (draft: Draft<TreeState>) => void,
    ) => PuzzleSessionTransitionResult;
    currentNode: () => TreeNode;
    getNode: (path: number[]) => TreeNode | null;

    goToNext: () => void;
    /** Plays continuation `index` of nextContinuation; refused during a practice drill. */
    goToContinuation: (index: number) => void;
    goToPrevious: () => void;
    goToStart: () => void;
    goToEnd: () => void;
    goToMove: (move: number[]) => void;
    goToBranchStart: () => void;
    goToBranchEnd: () => void;
    /**
     * Inside a line, goes to its end; at the end of a line, goes to the first move of the next line
     * in notation order (see nextLineStart). Refused at a line end during a practice drill.
     */
    goToBranchEndOrNextLine: () => void;
    nextBranch: () => void;
    previousBranch: () => void;
    nextBranching: () => void;
    previousBranching: () => void;

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
    promoteVariation: (path: number[]) => void;
    promoteToMainline: (path: number[]) => void;
    copyPgn: () => void;
    copyVariationPgn: (path: number[]) => void;

    setStart: (start: number[]) => void;

    setAnnotation: (payload: Annotation) => void;
    setComment: (payload: string) => void;
    setHeaders: (payload: GameHeaders) => void;
    setResult: (payload: Outcome) => void;
    setGameEnd: (path: number[]) => void;
    clearGameEnd: () => void;
    setTermination: (text: string) => void;
    setShapes: (shapes: DrawShape[]) => void;
    setScore: (score: Score) => void;

    clearShapes: () => void;

    setFen: (fen: string) => void;

    addAnalysis: (
        analysis: {
            best: BestMoves[];
            novelty: boolean;
            is_sacrifice: boolean;
        }[],
        options?: { showVariations: boolean },
    ) => void;

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
}

export type PuzzleSessionTransitionResult =
    | { success: true; persistence: "saved" | "memory" }
    | { success: false; error: Error };

export type TreeStore = StoreApi<TreeStoreState> & { dispose: () => void };
const installAdmittedTree = Symbol("installAdmittedTree");
type PersistedTreeStore = TreeStore & {
    [installAdmittedTree]: StoreApi<TreeStoreState>["setState"];
    persist: {
        rehydrate: () => Promise<void> | void;
        getOptions: () => { name?: string };
        setOptions: (options: { name: string; storage: PersistStorage<TreeStoreState> }) => void;
    };
};

const reportOwners = new Map<string, object>();
const treeStores = new Map<string, PersistedTreeStore>();
const closingReportOwners = new Map<string, ReportOwnerInvalidation>();

export function getCachedTreeStore(tab: string): TreeStore | undefined {
    return treeStores.get(tab);
}

function treeReplacementState(tree: CompleteTreeState) {
    return {
        puzzleSession: undefined,
        ...tree,
        linkedSource: tree.linkedSource ?? null,
        practicePath: null,
    };
}

/** Prepare the adapter and state before admission, then install without queuing a seeded tree. */
export function prepareTreeStoreRetarget(tab: string, treeKey: string, tree: CompleteTreeState) {
    const store = treeStores.get(tab)!;
    const options = {
        name: treeKey,
        storage: tabStorage.storageFor<TreeStoreState>(treeKey !== tab),
    };
    const state = treeReplacementState(tree);
    const install = store[installAdmittedTree];
    return Object.assign(
        () => {
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

/**
 * A line is a variation's first move followed by its main continuation (child 0) to the end; the
 * game's main line starts at [0]. Every move belongs to exactly one line. Lines are yielded in the
 * order the notation prints their first moves: a node's alternatives (children 1..n) come right
 * after its main child and before that child's continuation, each with its own nested lines.
 */
function* lineStarts(root: TreeNode): Generator<number[]> {
    if (root.children.length === 0) return;
    yield [0];
    // Each frame walks one line; a variation pauses it until its whole subtree has been yielded.
    const stack: { path: number[]; node: TreeNode; next: number }[] = [
        { path: [], node: root, next: 1 },
    ];
    while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        const { node } = frame;
        if (frame.next < node.children.length) {
            const path = [...frame.path, frame.next];
            frame.next += 1;
            yield path;
            stack.push({ path, node: node.children[frame.next - 1], next: 1 });
        } else if (node.children.length > 0) {
            frame.path = [...frame.path, 0];
            frame.node = node.children[0];
            frame.next = 1;
        } else {
            stack.pop();
        }
    }
}

/** The path of the line that follows the one containing `position`, or null after the last line. */
export function nextLineStart(root: TreeNode, position: number[]): number[] | null {
    if (position.length === 0) return null;
    let lastVariation = position.length - 1;
    while (lastVariation > 0 && position[lastVariation] === 0) lastVariation -= 1;
    const current = position.slice(0, lastVariation + 1);
    let found = false;
    for (const start of lineStarts(root)) {
        if (found) return start;
        found = start.length === current.length && start.every((index, i) => index === current[i]);
    }
    return null;
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

export const createTreeStore = (id?: string, initTree?: CompleteTreeState, treeKey = id) => {
    if (id) {
        const existing = treeStores.get(id);
        if (existing) return existing;
    }
    const initialTree = initTree ?? defaultTree();
    let install!: StoreApi<TreeStoreState>["setState"];
    let isCurrent = () => true;
    let persistenceKey = () => treeKey;
    const stateCreator: StateCreator<TreeStoreState> = (set, get) => ({
        ...initialTree,

        capturePuzzleSessionOwner: () => {
            const key = persistenceKey();
            const session = get().puzzleSession;
            return () => isCurrent() && persistenceKey() === key && get().puzzleSession === session;
        },

        transitionPuzzleSession: (update) => {
            let candidate: TreeStoreState;
            try {
                if (!isCurrent()) throw new Error("The puzzle tree owner has retired.");
                candidate = produce(get(), (draft) => {
                    update(draft);
                    if (draft.puzzleSession)
                        draft.puzzleSession = boundPuzzleSession(draft.puzzleSession);
                });
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
        },

        currentNode: () => getNodeAtPath(get().root, get().position),
        getNode: (path: number[]) => getNodeAtPath(get().root, path),

        practicePath: null,
        setPracticePath: (path) => set({ practicePath: path }),

        setState: (state) => {
            set(() => treeReplacementState(state));
        },

        reset: () =>
            set(() => {
                return {
                    ...defaultTree(),
                    linkedSource: null,
                    puzzleSession: undefined,
                    practicePath: null,
                };
            }),

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

        setFen: (fen) =>
            set(
                produce((state) => {
                    state.dirty = true;
                    installRoot(state, defaultTree(fen).root);
                }),
            ),

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
                            state.position = p;
                            break;
                        }
                    }
                }),
            ),

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
        goToEnd: () =>
            set(
                produce((state) => {
                    const endPosition: number[] = [];
                    let currentNode = state.root;
                    while (currentNode.children.length > 0) {
                        endPosition.push(0);
                        currentNode = currentNode.children[0];
                    }
                    state.position = endPosition;
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
                    let currentNode = getNodeAtPath(state.root, state.position);
                    while (currentNode.children.length > 0) {
                        state.position.push(0);
                        currentNode = currentNode.children[0];
                    }
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
            const next = nextLineStart(state.root, state.position);
            if (next) set({ position: next });
        },

        nextBranch: () =>
            set(
                produce((state) => {
                    if (state.position.length === 0) return;

                    let parent = getNodeAtPath(state.root, state.position.slice(0, -1));
                    let branchIndex = state.position[state.position.length - 1];
                    const node = parent.children[branchIndex];

                    // Makes the navigation more fluid and compatible with next/previous branching
                    if (node.children.length >= 2 && parent.children.length <= 1) {
                        state.position.push(0);
                        parent = getNodeAtPath(state.root, state.position.slice(0, -1));
                        branchIndex = state.position[state.position.length - 1];
                    }

                    state.position = [
                        ...state.position.slice(0, -1),
                        (branchIndex + 1) % parent.children.length,
                    ];
                }),
            ),
        previousBranch: () =>
            set(
                produce((state) => {
                    if (state.position.length === 0) return;

                    let parent = getNodeAtPath(state.root, state.position.slice(0, -1));
                    let branchIndex = state.position[state.position.length - 1];
                    const node = parent.children[branchIndex];

                    // Makes the navigation more fluid and compatible with next/previous branching
                    if (node.children.length >= 2 && parent.children.length <= 1) {
                        state.position.push(0);
                        parent = getNodeAtPath(state.root, state.position.slice(0, -1));
                        branchIndex = state.position[state.position.length - 1];
                    }

                    state.position = [
                        ...state.position.slice(0, -1),
                        (branchIndex + parent.children.length - 1) % parent.children.length,
                    ];
                }),
            ),

        nextBranching: () =>
            set(
                produce((state) => {
                    let node = getNodeAtPath(state.root, state.position);
                    let branchCount = node.children.length;

                    if (branchCount === 0) return;

                    do {
                        state.position.push(0);
                        node = node.children[0];
                        branchCount = node.children.length;
                    } while (branchCount === 1);
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

        deleteMove: (path) =>
            set(
                produce((state) => {
                    state.dirty = true;
                    deleteMove(state, path ?? state.position);
                }),
            ),
        promoteVariation: (path) =>
            set(
                produce((state) => {
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
        copyVariationPgn: (path) => {
            const { root } = get();
            const pgn = getPGN(root, {
                headers: null,
                comments: false,
                extraMarkups: false,
                glyphs: true,
                variations: false,
                path,
            });
            navigator.clipboard.writeText(pgn);
        },
        copyPgn: () => {
            const { root, headers } = get();
            const pgn = getPGN(root, {
                headers,
                comments: true,
                extraMarkups: true,
                glyphs: true,
                variations: true,
            });
            navigator.clipboard.writeText(pgn);
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
                    state.dirty = true;
                    const node = getNodeAtPath(state.root, state.position);
                    if (node) {
                        if (node.nags.some((code) => nagGlyph(code) === payload)) {
                            node.nags = node.nags.filter((code) => nagGlyph(code) !== payload);
                        } else {
                            node.nags = node.nags.filter((code) => {
                                const glyph = nagGlyph(code);
                                return (
                                    !glyph ||
                                    !ANNOTATION_INFO[glyph].group ||
                                    ANNOTATION_INFO[glyph].group !== ANNOTATION_INFO[payload].group
                                );
                            });
                            node.nags.push(ANNOTATION_INFO[payload].nag);
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
        setHeaders: (headers) =>
            set(
                produce((state) => {
                    state.dirty = true;
                    state.headers = headers;
                    if (headers.fen && headers.fen !== state.root.fen) {
                        installRoot(state, defaultTree(headers.fen).root);
                    }
                }),
            ),
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
        setScore: (score) =>
            set(
                produce((state) => {
                    state.dirty = true;
                    const node = getNodeAtPath(state.root, state.position);
                    if (node) {
                        node.score = score;
                        // A depth read from the PGN described the score this one replaces.
                        node.depth = null;
                    }
                }),
            ),
        addAnalysis: (analysis, options) =>
            set(
                produce((state) => {
                    state.dirty = true;
                    addAnalysis(state, analysis, options);
                }),
            ),

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
    });

    if (id) {
        const persistedCreator = persist(stateCreator, {
            name: treeKey!,
            version: TREE_STORAGE_VERSION,
            storage: tabStorage.storageFor<TreeStoreState>(treeKey !== id),
            onRehydrateStorage: () => (state, error) => {
                if (!error && state) {
                    // A renderer reload cannot resume the JavaScript completion owner that
                    // registered this operation. Treat persisted report identity as stale;
                    // ordinary provider remounts reuse the live store and never rehydrate.
                    state.report.inProgress = false;
                    state.report.operationId = null;
                    normalizeTreeHalfMoves(state.root);
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
            // Provider unmount also calls dispose during ordinary tab switching.
            dispose: () => undefined,
        });
        treeStores.set(id, ownedStore);
        isCurrent = () => treeStores.get(id) === ownedStore;
        persistenceKey = () => ownedStore.persist.getOptions().name;
        return ownedStore;
    }

    const store = createStore<TreeStoreState>()(stateCreator);
    install = store.setState;
    return Object.assign(store, {
        dispose: () => undefined,
    });
};

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

function promoteVariation(state: TreeStoreState, path: number[]): number[] {
    // get last element different from 0
    const i = path.findLastIndex((v) => v !== 0);
    if (i === -1) return path;

    const v = path[i];
    const promotablePath = path.slice(0, i);
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

function addAnalysis(
    state: TreeState,
    analysis: {
        best: BestMoves[];
        novelty: boolean;
        is_sacrifice: boolean;
    }[],
    options?: { showVariations: boolean },
) {
    let cur = state.root;
    let i = 0;
    let parent: TreeNode | undefined;

    while (cur !== undefined && i < analysis.length) {
        const [pos] = positionFromFen(cur.fen);
        if (pos && !pos.isEnd() && analysis[i].best.length > 0) {
            cur.score = analysis[i].best[0].score;
            cur.depth = analysis[i].best[0].depth;
            let prevScore = null;
            let prevprevScore = null;
            let prevMoves: BestMoves[] = [];
            if (i > 0 && analysis[i - 1].best.length > 0) {
                prevScore = analysis[i - 1].best[0].score;
                prevMoves = analysis[i - 1].best;
            }
            if (i > 1 && analysis[i - 2].best.length > 0) {
                prevprevScore = analysis[i - 2].best[0].score;
            }
            const curScore = analysis[i].best[0].score;
            const color = cur.halfMoves % 2 === 1 ? "white" : "black";
            const annotation = getAnnotation(
                prevprevScore?.value || null,
                prevScore?.value || null,
                curScore.value,
                color,
                prevMoves,
                analysis[i].is_sacrifice,
                cur.san || "",
            );
            if (annotation) {
                const code = ANNOTATION_INFO[annotation].nag;
                if (!cur.nags.includes(code)) cur.nags.push(code);

                if (
                    options?.showVariations &&
                    (annotation === "??" || annotation === "?" || annotation === "?!") &&
                    parent &&
                    i > 0 &&
                    analysis[i - 1].best.length > 0
                ) {
                    const bestMoveUci = analysis[i - 1].best[0].uciMoves[0];
                    const [parentPos] = positionFromFen(parent.fen);
                    if (parentPos) {
                        const parsedBestMove = parseUci(bestMoveUci);
                        if (parsedBestMove) {
                            const bestMove = normalizeMove(parentPos, parsedBestMove);
                            const existingChild = parent.children.find((c) => {
                                if (!c.move) return false;
                                const childMove = normalizeMove(parentPos, c.move);
                                return (
                                    isNormal(childMove) &&
                                    isNormal(bestMove) &&
                                    childMove.from === bestMove.from &&
                                    childMove.to === bestMove.to &&
                                    childMove.promotion === bestMove.promotion
                                );
                            });

                            if (!existingChild) {
                                const san = makeSan(parentPos, bestMove);
                                parentPos.play(bestMove);
                                const newFen = makeFen(parentPos.toSetup());
                                const variationNode = createNode({
                                    fen: newFen,
                                    move: bestMove,
                                    san,
                                    halfMoves: parent.halfMoves + 1,
                                });

                                let currentVarNode = variationNode;
                                const currentVarPos = parentPos;

                                const pv = analysis[i - 1].best[0].uciMoves;
                                if (pv.length > 1) {
                                    for (
                                        let j = 1;
                                        j <
                                        Math.min(pv.length, MAX_GENERATED_ANALYSIS_VARIATION_PLIES);
                                        j++
                                    ) {
                                        const nextMoveUci = pv[j];
                                        const parsedNextMove = parseUci(nextMoveUci);
                                        if (parsedNextMove) {
                                            const nextMove = normalizeMove(
                                                currentVarPos,
                                                parsedNextMove,
                                            );
                                            const nextSan = makeSan(currentVarPos, nextMove);
                                            currentVarPos.play(nextMove);
                                            const nextFen = makeFen(currentVarPos.toSetup());
                                            const nextNode = createNode({
                                                fen: nextFen,
                                                move: nextMove,
                                                san: nextSan,
                                                halfMoves: currentVarNode.halfMoves + 1,
                                            });
                                            currentVarNode.children.push(nextNode);
                                            currentVarNode = nextNode;
                                        }
                                    }
                                }

                                parent.children.push(variationNode);
                            }
                        }
                    }
                }
            }
            const noveltyCode = ANNOTATION_INFO.N.nag;
            if (analysis[i].novelty && !cur.nags.includes(noveltyCode)) {
                cur.nags.push(noveltyCode);
            }
        }
        parent = cur;
        cur = cur.children[0];
        i++;
    }
}
