import type { createStore } from "jotai";
import type { FileMetadata } from "@/components/files/file";
import { deckCountable } from "@/components/library/useLibraryDueCounts";
import { sortRunCandidates, type TimedRunCandidate } from "@/components/panels/practice/runPlanner";
import { deckAtomFamily, type TimedRunChapter } from "@/state/atoms";
import type { PracticeDeckKey, PracticeDeckValue } from "@/state/practiceStorage";
import type { IndexedRepertoireFile } from "@/state/repertoireIndex";
import { abortError, subscribeUntil } from "@/state/subscribeUntil";
import {
    classifyChapterNodes,
    type PreparationColor,
    type PreparationView,
    userColorForOpponent,
} from "@/utils/opponentPreparation";
import { type Position, validWeight } from "@/utils/practicePosition";
import { isInPracticeScope, isUserToMove } from "@/utils/practiceScope";
import { getBoardState } from "@/utils/treeReducer";

/** Maximum number of chapter decks hydrated concurrently before starting a preparation run. */
const PREPARATION_DECK_CONCURRENCY = 4;

type JotaiStore = ReturnType<typeof createStore>;

export type PreparationCandidateNode = {
    boardState: string;
    status: "played" | "open";
    /** For open nodes, the `boardState` of the nearest played ancestor `F`; `null` for played nodes. */
    playedAncestorBoardState: string | null;
    /** Sequential index within this chapter in pre-order (`0, 1, 2, ...`). */
    treeIndex: number;
};

export type PreparationCandidateChapter = {
    workspaceKey: string;
    file: FileMetadata;
    chapter: number;
    nodes: readonly PreparationCandidateNode[];
};

export type PreparationRunBuildResult = {
    candidates: TimedRunCandidate[];
    chapters: TimedRunChapter[];
    skippedChapters: number;
};

export function preparationDeckKey(file: string, game: number): string {
    return `${file}\u0000${game}`;
}

/**
 * Collects every chapter of the preparation that has at least one trainable node:
 * user to move, continuing, inside the chapter's `Start` scope, not excluded,
 * deduplicated per `boardState` in pre-order.
 */
export function collectPreparationCandidateChapters(
    files: readonly IndexedRepertoireFile[],
    opponentColor: PreparationColor,
    playedPositions: ReadonlySet<string>,
): PreparationCandidateChapter[] {
    const userColor = userColorForOpponent(opponentColor);
    const result: PreparationCandidateChapter[] = [];

    for (const indexedFile of files) {
        for (const chapter of indexedFile.chapters) {
            const classification = classifyChapterNodes(chapter, opponentColor, playedPositions);
            if (!classification.inPreparation) continue;

            const start = chapter.headers.start ?? [];
            const { nodes } = chapter;
            const playedAncestorIndex = new Array<number>(nodes.length).fill(-1);
            const seenBoardStates = new Set<string>();
            const candidateNodes: PreparationCandidateNode[] = [];

            for (let i = 0; i < nodes.length; i++) {
                const node = nodes[i];
                const status = classification.nodes[i].status;
                if (status === "played") {
                    playedAncestorIndex[i] = i;
                } else if (status === "open") {
                    playedAncestorIndex[i] =
                        node.parent >= 0 ? playedAncestorIndex[node.parent] : -1;
                } else {
                    continue;
                }

                if (!isUserToMove(node.halfMoves, userColor)) continue;
                if (!node.hasContinuation) continue;
                if (!isInPracticeScope(node.path, start)) continue;
                if (seenBoardStates.has(node.boardState)) continue;

                seenBoardStates.add(node.boardState);
                const ancestorIdx = status === "open" ? playedAncestorIndex[i] : -1;
                candidateNodes.push({
                    boardState: node.boardState,
                    status,
                    playedAncestorBoardState:
                        ancestorIdx >= 0 ? nodes[ancestorIdx].boardState : null,
                    treeIndex: candidateNodes.length,
                });
            }

            if (candidateNodes.length > 0) {
                result.push({
                    workspaceKey: indexedFile.workspaceKey,
                    file: indexedFile.file,
                    chapter: chapter.chapter,
                    nodes: candidateNodes,
                });
            }
        }
    }

    return result;
}

function computePlayedWeights(
    positionGames: ReadonlyMap<string, number>,
    total: number,
): Map<string, number> {
    const weights = new Map<string, number>();
    if (total > 0) {
        for (const [boardState, games] of positionGames) {
            if (games >= 1) {
                weights.set(boardState, Math.min(1, games / total));
            }
        }
        return weights;
    }

    const distinctGames = Array.from(
        new Set(Array.from(positionGames.values()).filter((games) => games >= 1)),
    ).sort((left, right) => right - left);
    const rankByGames = new Map<number, number>();
    distinctGames.forEach((games, index) => rankByGames.set(games, index + 1));

    for (const [boardState, games] of positionGames) {
        const rank = rankByGames.get(games);
        if (rank !== undefined) {
            weights.set(boardState, 1 / rank);
        }
    }
    return weights;
}

/**
 * Builds timed-run candidates and chapters from the preparation's candidate chapters and their
 * settled stored decks. Chapters whose deck cannot be read or written are left out and counted.
 * All unseen candidates stay (the "New moves per session" cap does not apply).
 */
export function buildPreparationRunCandidates(
    candidateChapters: readonly PreparationCandidateChapter[],
    view: Pick<PreparationView, "positionGames" | "total">,
    decks: ReadonlyMap<string, PracticeDeckValue>,
): PreparationRunBuildResult {
    const playedWeights = computePlayedWeights(view.positionGames, view.total);
    const due: TimedRunCandidate[] = [];
    const unseen: TimedRunCandidate[] = [];
    const chapters: TimedRunChapter[] = [];
    let skippedChapters = 0;

    for (const chapter of candidateChapters) {
        const deck = decks.get(preparationDeckKey(chapter.workspaceKey, chapter.chapter));
        if (!deck || !deckCountable(deck)) {
            skippedChapters += 1;
            continue;
        }

        const deckByBoard = new Map<string, Position>();
        for (const position of deck.positions) {
            const key = getBoardState(position.fen);
            if (!deckByBoard.has(key)) deckByBoard.set(key, position);
        }

        let added = false;
        for (const node of chapter.nodes) {
            let weight: number | undefined;
            if (node.status === "played") {
                weight = validWeight(playedWeights.get(node.boardState));
            } else if (node.playedAncestorBoardState !== null) {
                const weightF = validWeight(playedWeights.get(node.playedAncestorBoardState));
                const w = validWeight(deckByBoard.get(node.boardState)?.weight);
                const wF = validWeight(deckByBoard.get(node.playedAncestorBoardState)?.weight);
                if (weightF !== undefined && w !== undefined && wF !== undefined) {
                    weight = validWeight(weightF * Math.min(1, w / wF));
                }
            }

            const stored = deckByBoard.get(node.boardState);
            const kind = stored && stored.card.reps > 0 ? "due" : "unseen";
            const rawDue = stored ? new Date(stored.card.due).getTime() : 0;
            const dueAt = Number.isFinite(rawDue) ? rawDue : 0;

            const candidate: TimedRunCandidate = {
                file: chapter.workspaceKey,
                game: chapter.chapter,
                positionKey: node.boardState,
                kind,
                weight,
                dueAt,
                treeIndex: node.treeIndex,
            };
            if (kind === "due") due.push(candidate);
            else unseen.push(candidate);
            added = true;
        }

        if (added) {
            chapters.push({
                file: chapter.workspaceKey,
                game: chapter.chapter,
                metadata: chapter.file,
            });
        }
    }

    sortRunCandidates(due, unseen);

    return {
        candidates: [...due, ...unseen],
        chapters,
        skippedChapters,
    };
}

function readSingleDeck(
    store: JotaiStore,
    key: PracticeDeckKey,
    signal: AbortSignal,
): Promise<PracticeDeckValue> {
    const deckAtom = deckAtomFamily(key);
    return subscribeUntil(
        signal,
        (check) => store.sub(deckAtom, check),
        () => {
            const value = store.get(deckAtom);
            return value.status === "loading" ? undefined : value;
        },
    );
}

/**
 * Reads the stored deck of each requested chapter through `deckAtomFamily` (the practice storage's
 * own read path), a few at a time, waiting while a deck is `loading` and unsubscribing on settle
 * or abort. Never writes to any deck.
 */
export async function readPreparationDecks(
    store: JotaiStore,
    keys: readonly PracticeDeckKey[],
    signal: AbortSignal,
): Promise<Map<string, PracticeDeckValue>> {
    if (signal.aborted) throw abortError();
    const results = new Map<string, PracticeDeckValue>();
    const seen = new Set<string>();
    const queue: PracticeDeckKey[] = [];
    for (const key of keys) {
        const id = preparationDeckKey(key.file, key.game);
        if (seen.has(id)) continue;
        seen.add(id);
        queue.push(key);
    }
    if (queue.length === 0) return results;

    let nextIndex = 0;
    const workerCount = Math.min(PREPARATION_DECK_CONCURRENCY, queue.length);
    const worker = async () => {
        while (nextIndex < queue.length) {
            if (signal.aborted) throw abortError();
            const item = queue[nextIndex++];
            const deck = await readSingleDeck(store, item, signal);
            results.set(preparationDeckKey(item.file, item.game), deck);
        }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}
