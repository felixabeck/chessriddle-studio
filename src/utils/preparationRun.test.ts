import { createStore } from "jotai";
import { createEmptyCard } from "ts-fsrs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FileMetadata } from "@/components/files/file";
import { deckAtomFamily, invalidateFileDeckAtoms } from "@/state/atoms";
import { type PracticeDeckValue, resetPracticeMigrationForTests } from "@/state/practiceStorage";
import type { IndexedRepertoireFile, RepertoireChapterNode } from "@/state/repertoireIndex";
import { INITIAL_BOARD_STATE } from "@/utils/opponentPreparation";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import type { Position } from "@/utils/practicePosition";
import {
    buildPreparationRunCandidates,
    collectPreparationCandidateChapters,
    preparationDeckKey,
    readPreparationDecks,
} from "./preparationRun";

const tauriMocks = vi.hoisted(() => ({
    listPracticeDecks: vi.fn(),
    readPracticeEpoch: vi.fn(),
    loadPracticeDeck: vi.fn(),
    syncPracticePositions: vi.fn(),
    recordPracticeReview: vi.fn(),
    resetPracticeDeck: vi.fn(),
}));

vi.mock("@/platform/tauri", () => ({
    tauri: tauriMocks,
}));

const fileA: FileMetadata = {
    type: "file",
    name: "White.pgn",
    handle: { id: { id: "file-a" }, kind: "fileWorkspace" },
    numGames: 2,
    metadata: { type: "repertoire", tags: [] },
    lastModified: 1,
};

const fileB: FileMetadata = {
    type: "file",
    name: "White2.pgn",
    handle: { id: { id: "file-b" }, kind: "fileWorkspace" },
    numGames: 1,
    metadata: { type: "repertoire", tags: [] },
    lastModified: 1,
};

const keyA = fileWorkspaceKey(fileA.handle);
const keyB = fileWorkspaceKey(fileB.handle);

const P_ROOT = INITIAL_BOARD_STATE;
const P_W1 = "pos-w1 w - -";
const P_B1 = "pos-b1 b - -";
const P_W2 = "pos-w2 w - -";
const P_W_OPEN1 = "pos-w-open1 w - -";
const P_W_OPEN2 = "pos-w-open2 w - -";
const P_W_EXCL = "pos-w-excl w - -";
const P_B_OPEN = "pos-b-open b - -";
const P_B_EXCL = "pos-b-excl b - -";
const P_LEAF = "pos-leaf w - -";

function makeNode(
    boardState: string,
    parent: number,
    path: number[],
    halfMoves: number,
    hasContinuation: boolean,
    san: string | null = "e4",
): RepertoireChapterNode {
    return { boardState, parent, san, path, halfMoves, hasContinuation };
}

function readyDeck(positions: Position[] = []): PracticeDeckValue {
    return {
        positions,
        revision: 1,
        generation: 0,
        unappliedReviews: 0,
        orphansAcknowledged: true,
        status: "ready",
    };
}

function failedDeck(status: "read-failed" | "write-blocked"): PracticeDeckValue {
    return {
        positions: [],
        revision: 0,
        generation: 0,
        unappliedReviews: 0,
        orphansAcknowledged: true,
        status,
    };
}

function makeCardPosition(
    boardState: string,
    options: { reps?: number; due?: Date; weight?: number } = {},
): Position {
    const base = createEmptyCard(options.due ?? new Date("2026-11-20T00:00:00Z"));
    return {
        fen: `${boardState} 0 1`,
        answer: "Nf3",
        card: {
            ...base,
            reps: options.reps ?? 0,
            due: options.due ?? base.due,
        },
        weight: options.weight,
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

beforeEach(() => {
    vi.clearAllMocks();
    resetPracticeMigrationForTests();
    invalidateFileDeckAtoms(keyA);
    invalidateFileDeckAtoms(keyB);
    tauriMocks.listPracticeDecks.mockResolvedValue({ decks: [], anomalies: [] });
    tauriMocks.readPracticeEpoch.mockResolvedValue({ epoch: "epoch-1" });
});

afterEach(() => {
    invalidateFileDeckAtoms(keyA);
    invalidateFileDeckAtoms(keyB);
});

describe("collectPreparationCandidateChapters & buildPreparationRunCandidates", () => {
    test("computes weights and order for played and open nodes, excludes excluded/out-of-scope/non-continuing/opponent-turn nodes", () => {
        // User plays White (opponent plays Black).
        // Tree:
        // 0: P_ROOT (halfMoves 0, White, played) -> root is outside empty Start scope!
        // 1: P_B1 (parent 0, path [0], halfMoves 1, Black, played) -> opponent to move
        // 2: P_W1 (parent 1, path [0,0], halfMoves 2, White, played, continues) -> candidate (played, games=6)
        // 3: P_B_OPEN (parent 2, path [0,0,0], halfMoves 3, Black, not played -> open, continues) -> opponent to move
        // 4: P_W_OPEN1 (parent 3, path [0,0,0,0], halfMoves 4, White, open below F=P_W1, continues) -> candidate (open, has weights)
        // 5: P_W_OPEN2 (parent 3, path [0,0,0,1], halfMoves 4, White, open below F=P_W1, continues) -> candidate (open, missing weight -> last)
        // 6: P_W2 (parent 1, path [0,1], halfMoves 2, White, played, continues) -> candidate (played, games=2)
        // 7: P_LEAF (parent 6, path [0,1,0], halfMoves 4, White, played, hasContinuation=false) -> skipped (leaf)
        // 8: P_B_EXCL (parent 1, path [0,2], halfMoves 2, White, not played -> parent is Black played -> excluded!)
        // 9: P_W_EXCL (parent 8, path [0,2,0], halfMoves 4, White, excluded, continues) -> skipped (excluded)
        const files: IndexedRepertoireFile[] = [
            {
                workspaceKey: keyA,
                file: fileA,
                partial: false,
                chapters: [
                    {
                        chapter: 0,
                        headers: { orientation: "white", white: "Ch1", black: "?", event: "?" },
                        nodes: [
                            makeNode(P_ROOT, -1, [], 0, true, null),
                            makeNode(P_B1, 0, [0], 1, true, "e4"),
                            makeNode(P_W1, 1, [0, 0], 2, true, "c5"),
                            makeNode(P_B_OPEN, 2, [0, 0, 0], 3, true, "Nf3"),
                            makeNode(P_W_OPEN1, 3, [0, 0, 0, 0], 4, true, "d6"),
                            makeNode(P_W_OPEN2, 3, [0, 0, 0, 1], 4, true, "Nc6"),
                            makeNode(P_W2, 1, [0, 1], 2, true, "e6"),
                            makeNode(P_LEAF, 6, [0, 1, 0], 4, false, "d4"),
                            makeNode(P_B_EXCL, 1, [0, 2], 2, true, "e5"),
                            makeNode(P_W_EXCL, 8, [0, 2, 0], 4, true, "Nf3"),
                        ],
                    },
                ],
            },
        ];

        const playedPositions = new Set([P_ROOT, P_B1, P_W1, P_W2, P_LEAF]);
        const positionGames = new Map([
            [P_ROOT, 10],
            [P_B1, 8],
            [P_W1, 6],
            [P_W2, 2],
            [P_LEAF, 1],
        ]);

        const candidateChapters = collectPreparationCandidateChapters(
            files,
            "black",
            playedPositions,
        );
        expect(candidateChapters).toHaveLength(1);
        expect(
            candidateChapters[0].nodes.map((n) => [n.boardState, n.status, n.treeIndex]),
        ).toEqual([
            [P_W1, "played", 0],
            [P_W_OPEN1, "open", 1],
            [P_W_OPEN2, "open", 2],
            [P_W2, "played", 3],
        ]);

        // Deck: P_W1 has reps=2 with future due date (still "due"!), reference weight w_F = 0.5.
        // P_W_OPEN1 has reps=0, reference weight w = 0.25 -> open weight = (6/10) * min(1, 0.25/0.5) = 0.3.
        // P_W_OPEN2 has no weight -> undefined, planned last.
        // P_W2 has reps=0 -> unseen, weight = 2/10 = 0.2.
        const futureDue = new Date("2030-01-01T00:00:00Z");
        const decks = new Map<string, PracticeDeckValue>([
            [
                preparationDeckKey(keyA, 0),
                readyDeck([
                    makeCardPosition(P_W1, { reps: 2, due: futureDue, weight: 0.5 }),
                    makeCardPosition(P_W_OPEN1, { reps: 0, weight: 0.25 }),
                    makeCardPosition(P_W_OPEN2, { reps: 0 }),
                    makeCardPosition(P_W2, { reps: 0 }),
                ]),
            ],
        ]);

        const result = buildPreparationRunCandidates(
            candidateChapters,
            { positionGames, total: 10 },
            decks,
        );

        expect(result.skippedChapters).toBe(0);
        expect(result.chapters).toEqual([{ file: keyA, game: 0, metadata: fileA }]);
        // Due first (P_W1 even with future due date), then unseen ordered by weight descending:
        // P_W_OPEN1 (0.3) > P_W2 (0.2) > P_W_OPEN2 (undefined)
        expect(
            result.candidates.map((c) => [c.positionKey, c.kind, c.weight, c.treeIndex]),
        ).toEqual([
            [P_W1, "due", 0.6, 0],
            [P_W_OPEN1, "unseen", 0.3, 1],
            [P_W2, "unseen", 0.2, 3],
            [P_W_OPEN2, "unseen", undefined, 2],
        ]);
    });

    test("uses 1 / rank by games when total is 0 and clamps open w / w_F to 1", () => {
        const files: IndexedRepertoireFile[] = [
            {
                workspaceKey: keyA,
                file: fileA,
                partial: false,
                chapters: [
                    {
                        chapter: 0,
                        headers: {
                            orientation: "white",
                            start: [0],
                            white: "Custom",
                            black: "?",
                            event: "?",
                        },
                        nodes: [
                            makeNode(P_ROOT, -1, [], 0, true, null),
                            makeNode(P_W1, 0, [0], 2, true, "c5"), // inside Start [0]
                            makeNode(P_B_OPEN, 1, [0, 0], 3, true, "Nf3"),
                            makeNode(P_W_OPEN1, 2, [0, 0, 0], 4, true, "d6"),
                            makeNode(P_W2, 0, [0, 1], 2, true, "e6"),
                        ],
                    },
                ],
            },
        ];

        const playedPositions = new Set([P_W1, P_W2]);
        const positionGames = new Map([
            [P_W1, 8], // rank 1 -> 1 / 1 = 1
            [P_W2, 3], // rank 2 -> 1 / 2 = 0.5
        ]);
        const candidateChapters = collectPreparationCandidateChapters(
            files,
            "black",
            playedPositions,
        );
        // w = 0.8 > w_F = 0.4 -> min(1, w / w_F) = 1 -> weight(P_W_OPEN1) = 1 * 1 = 1
        const decks = new Map<string, PracticeDeckValue>([
            [
                preparationDeckKey(keyA, 0),
                readyDeck([
                    makeCardPosition(P_W1, { reps: 0, weight: 0.4 }),
                    makeCardPosition(P_W_OPEN1, { reps: 0, weight: 0.8 }),
                ]),
            ],
        ]);

        const result = buildPreparationRunCandidates(
            candidateChapters,
            { positionGames, total: 0 },
            decks,
        );

        expect(result.candidates.map((c) => [c.positionKey, c.weight])).toEqual([
            [P_W1, 1],
            [P_W_OPEN1, 1],
            [P_W2, 0.5],
        ]);
    });

    test("keeps all unseen candidates even when exceeding 'New moves per session' and handles empty decks", () => {
        const nodes: RepertoireChapterNode[] = [makeNode(P_ROOT, -1, [], 0, true, null)];
        const playedPositions = new Set<string>([P_ROOT]);
        const positionGames = new Map<string, number>([[P_ROOT, 20]]);

        // 15 distinct played White-to-move continuing nodes (more than default 10 new per session)
        for (let i = 0; i < 15; i++) {
            const pos = `pos-many-${i} w - -`;
            nodes.push(makeNode(pos, 0, [i], 2, true, `m${i}`));
            playedPositions.add(pos);
            positionGames.set(pos, 15 - i);
        }

        const files: IndexedRepertoireFile[] = [
            {
                workspaceKey: keyA,
                file: fileA,
                partial: false,
                chapters: [
                    {
                        chapter: 0,
                        headers: { orientation: "white", white: "Many", black: "?", event: "?" },
                        nodes,
                    },
                ],
            },
        ];

        const candidateChapters = collectPreparationCandidateChapters(
            files,
            "black",
            playedPositions,
        );
        // Empty stored deck -> all 15 become unseen candidates, none capped.
        const decks = new Map<string, PracticeDeckValue>([
            [preparationDeckKey(keyA, 0), readyDeck([])],
        ]);

        const result = buildPreparationRunCandidates(
            candidateChapters,
            { positionGames, total: 20 },
            decks,
        );

        expect(result.candidates).toHaveLength(15);
        expect(result.candidates.every((c) => c.kind === "unseen")).toBe(true);
    });

    test("leaves out chapters with read-failed or write-blocked decks and counts them", () => {
        const files: IndexedRepertoireFile[] = [
            {
                workspaceKey: keyA,
                file: fileA,
                partial: false,
                chapters: [
                    {
                        chapter: 0,
                        headers: { orientation: "white", white: "Ch0", black: "?", event: "?" },
                        nodes: [
                            makeNode(P_ROOT, -1, [], 0, true, null),
                            makeNode(P_W1, 0, [0], 2, true, "c5"),
                        ],
                    },
                    {
                        chapter: 1,
                        headers: { orientation: "white", white: "Ch1", black: "?", event: "?" },
                        nodes: [
                            makeNode(P_ROOT, -1, [], 0, true, null),
                            makeNode(P_W2, 0, [0], 2, true, "e6"),
                        ],
                    },
                ],
            },
            {
                workspaceKey: keyB,
                file: fileB,
                partial: false,
                chapters: [
                    {
                        chapter: 0,
                        headers: { orientation: "white", white: "ChB", black: "?", event: "?" },
                        nodes: [
                            makeNode(P_ROOT, -1, [], 0, true, null),
                            makeNode(P_W_OPEN1, 0, [0], 2, true, "d6"),
                        ],
                    },
                ],
            },
        ];

        const playedPositions = new Set([P_ROOT, P_W1, P_W2, P_W_OPEN1]);
        const positionGames = new Map([
            [P_ROOT, 10],
            [P_W1, 5],
            [P_W2, 4],
            [P_W_OPEN1, 3],
        ]);
        const candidateChapters = collectPreparationCandidateChapters(
            files,
            "black",
            playedPositions,
        );
        expect(candidateChapters).toHaveLength(3);

        const decks = new Map<string, PracticeDeckValue>([
            [preparationDeckKey(keyA, 0), failedDeck("read-failed")],
            [preparationDeckKey(keyA, 1), failedDeck("write-blocked")],
            [preparationDeckKey(keyB, 0), readyDeck([])],
        ]);

        const result = buildPreparationRunCandidates(
            candidateChapters,
            { positionGames, total: 10 },
            decks,
        );
        expect(result.skippedChapters).toBe(2);
        expect(result.chapters).toEqual([{ file: keyB, game: 0, metadata: fileB }]);
        expect(result.candidates).toHaveLength(1);
        expect(result.candidates[0].file).toBe(keyB);
    });

    test("orders multiple due candidates by weight, then dueAt when unweighted, then treeIndex, and deduplicates repeated positions in one chapter", () => {
        const P_DUE_LOW_W = "pos-due-low-w w - -";
        const P_DUE_HIGH_W = "pos-due-high-w w - -";
        const P_DUE_UNW_LATE = "pos-due-unw-late w - -";
        const P_DUE_UNW_EARLY = "pos-due-unw-early w - -";
        const P_DUE_UNW_TIE = "pos-due-unw-tie w - -";
        const P_OPEN_PARENT = "pos-open-parent b - -";

        const files: IndexedRepertoireFile[] = [
            {
                workspaceKey: keyA,
                file: fileA,
                partial: false,
                chapters: [
                    {
                        chapter: 0,
                        headers: { orientation: "white", white: "Order", black: "?", event: "?" },
                        nodes: [
                            makeNode(P_ROOT, -1, [], 0, true, null),
                            makeNode(P_DUE_LOW_W, 0, [0], 2, true, "e4"),
                            // Duplicate of P_DUE_LOW_W in the same chapter -> must yield only one candidate
                            makeNode(P_DUE_LOW_W, 0, [1], 2, true, "d4"),
                            makeNode(P_DUE_HIGH_W, 0, [2], 2, true, "c4"),
                            // Open branch below P_DUE_HIGH_W (which is White to move and played) -> unweighted due cards
                            makeNode(P_OPEN_PARENT, 3, [2, 0], 3, true, "Nf3"),
                            makeNode(P_DUE_UNW_LATE, 4, [2, 0, 0], 4, true, "d6"),
                            makeNode(P_DUE_UNW_EARLY, 4, [2, 0, 1], 4, true, "e6"),
                            makeNode(P_DUE_UNW_TIE, 4, [2, 0, 2], 4, true, "c6"),
                        ],
                    },
                ],
            },
        ];

        const playedPositions = new Set([P_ROOT, P_DUE_LOW_W, P_DUE_HIGH_W]);
        const positionGames = new Map([
            [P_ROOT, 10],
            [P_DUE_LOW_W, 2],
            [P_DUE_HIGH_W, 8],
        ]);
        const candidateChapters = collectPreparationCandidateChapters(
            files,
            "black",
            playedPositions,
        );
        // Duplicate P_DUE_LOW_W collapsed to a single node.
        expect(candidateChapters[0].nodes.map((n) => [n.boardState, n.treeIndex])).toEqual([
            [P_DUE_LOW_W, 0],
            [P_DUE_HIGH_W, 1],
            [P_DUE_UNW_LATE, 2],
            [P_DUE_UNW_EARLY, 3],
            [P_DUE_UNW_TIE, 4],
        ]);

        const earlyDate = new Date("2026-11-01T00:00:00Z");
        const lateDate = new Date("2026-11-20T00:00:00Z");
        const decks = new Map<string, PracticeDeckValue>([
            [
                preparationDeckKey(keyA, 0),
                readyDeck([
                    makeCardPosition(P_DUE_LOW_W, { reps: 1, due: earlyDate }),
                    makeCardPosition(P_DUE_HIGH_W, { reps: 1, due: lateDate }),
                    // No reference weights on P_DUE_HIGH_W or open nodes -> unweighted due candidates
                    makeCardPosition(P_DUE_UNW_LATE, { reps: 1, due: lateDate }),
                    makeCardPosition(P_DUE_UNW_EARLY, { reps: 1, due: earlyDate }),
                    makeCardPosition(P_DUE_UNW_TIE, { reps: 1, due: earlyDate }),
                ]),
            ],
        ]);

        const result = buildPreparationRunCandidates(
            candidateChapters,
            { positionGames, total: 10 },
            decks,
        );

        // 1. Weighted due first: P_DUE_HIGH_W (0.8) > P_DUE_LOW_W (0.2)
        // 2. Unweighted due next, ordered by dueAt: earlyDate (treeIndex 3 before 4), then lateDate (treeIndex 2)
        expect(result.candidates.map((c) => [c.positionKey, c.weight, c.treeIndex])).toEqual([
            [P_DUE_HIGH_W, 0.8, 1],
            [P_DUE_LOW_W, 0.2, 0],
            [P_DUE_UNW_EARLY, undefined, 3],
            [P_DUE_UNW_TIE, undefined, 4],
            [P_DUE_UNW_LATE, undefined, 2],
        ]);
    });
});

describe("readPreparationDecks", () => {
    test("reads never-mounted stored decks through practiceStorage, waits while loading, and performs no deck writes", async () => {
        const store = createStore();
        const gate = deferred<{
            epoch: string;
            deck: {
                generation: number;
                revision: number;
                positionsDocument: string;
                unappliedReviews: number;
                orphansAcknowledged: boolean;
            } | null;
        }>();

        const storedPosition = makeCardPosition(P_W1, { reps: 3, weight: 0.42 });
        tauriMocks.loadPracticeDeck.mockImplementation((fileId: string, game: number) => {
            if (fileId === keyA && game === 0) return gate.promise;
            return Promise.resolve({ epoch: "epoch-1", deck: null });
        });

        // Confirm atom is initially unmounted and loading.
        expect(store.get(deckAtomFamily({ file: keyA, game: 0 })).status).toBe("loading");

        const controller = new AbortController();
        const readPromise = readPreparationDecks(
            store,
            [
                { file: keyA, game: 0 },
                { file: keyB, game: 0 },
            ],
            controller.signal,
        );

        // Wait until loadPracticeDeck is called for keyA:0; promise must not resolve while loading.
        await vi.waitFor(() => {
            expect(tauriMocks.loadPracticeDeck).toHaveBeenCalledWith(keyA, 0);
        });

        let settled = false;
        void readPromise.then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        // Now resolve the stored deck for keyA:0.
        gate.resolve({
            epoch: "epoch-1",
            deck: {
                generation: 0,
                revision: 2,
                positionsDocument: JSON.stringify({ positions: [storedPosition] }),
                unappliedReviews: 0,
                orphansAcknowledged: true,
            },
        });

        const decks = await readPromise;
        const deckA = decks.get(preparationDeckKey(keyA, 0));
        const deckB = decks.get(preparationDeckKey(keyB, 0));
        expect(deckA?.status).toBe("ready");
        expect(deckA?.positions).toHaveLength(1);
        expect(deckA?.positions[0].card.reps).toBe(3);
        expect(deckA?.positions[0].weight).toBe(0.42);
        expect(deckB?.status).toBe("ready");
        expect(deckB?.positions).toEqual([]);

        // No writes to practice storage.
        expect(tauriMocks.syncPracticePositions).not.toHaveBeenCalled();
        expect(tauriMocks.recordPracticeReview).not.toHaveBeenCalled();
        expect(tauriMocks.resetPracticeDeck).not.toHaveBeenCalled();
    });

    test("aborts cleanly while a deck is still loading", async () => {
        const store = createStore();
        const neverResolving = new Promise<never>(() => {});
        tauriMocks.loadPracticeDeck.mockReturnValue(neverResolving);

        const controller = new AbortController();
        const promise = readPreparationDecks(store, [{ file: keyA, game: 0 }], controller.signal);

        await vi.waitFor(() => {
            expect(tauriMocks.loadPracticeDeck).toHaveBeenCalledWith(keyA, 0);
        });

        controller.abort();
        await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    });

    test("never has more than the concurrency bound of decks pending at once", async () => {
        const store = createStore();
        const gates = new Map<number, ReturnType<typeof deferred<{ epoch: string; deck: null }>>>();
        let inFlight = 0;
        let maxInFlight = 0;

        tauriMocks.loadPracticeDeck.mockImplementation((_fileId: string, game: number) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            const gate = deferred<{ epoch: string; deck: null }>();
            gates.set(game, gate);
            return gate.promise.finally(() => {
                inFlight -= 1;
            });
        });

        const keys = Array.from({ length: 7 }, (_, game) => ({ file: keyA, game }));
        const controller = new AbortController();
        const readPromise = readPreparationDecks(store, keys, controller.signal);

        // First wave fills the concurrency bound (4) and does not start the 5th yet.
        await vi.waitFor(() => {
            expect(gates.size).toBe(4);
        });
        await Promise.resolve();
        expect(inFlight).toBe(4);
        expect(maxInFlight).toBe(4);

        // Release each pending deck as it arrives; total in-flight must never exceed 4.
        for (let released = 0; released < 7; released++) {
            await vi.waitFor(() => {
                expect(gates.has(released)).toBe(true);
            });
            expect(maxInFlight).toBeLessThanOrEqual(4);
            gates.get(released)!.resolve({ epoch: "epoch-1", deck: null });
        }

        const decks = await readPromise;
        expect(decks.size).toBe(7);
        expect(maxInFlight).toBe(4);
    });
});
