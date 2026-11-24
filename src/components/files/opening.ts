import {
    type Card,
    createEmptyCard,
    fsrs,
    type Grade,
    type ReviewLog,
    generatorParameters,
} from "ts-fsrs";
import type { Position } from "@/utils/practicePosition";
import { isInPracticeScope, isUserToMove } from "@/utils/practiceScope";
import { getBoardState, type TreeNode, treeIterator } from "@/utils/treeReducer";

const params = generatorParameters({ enable_fuzz: true });

const f = fsrs(params);

export function inScopeCards(positions: readonly Position[]): Position[] {
    return positions.filter((position) => !position.outOfScope);
}

function* practiceCardsFromTree(tree: TreeNode, color: "white" | "black", start: number[]) {
    for (const frame of treeIterator(tree)) {
        const answer = frame.node.children[0]?.san;
        if (
            !isInPracticeScope(frame.position, start) ||
            !answer ||
            !isUserToMove(frame.node.halfMoves, color)
        ) {
            continue;
        }
        yield { frame, fen: frame.node.fen, answer };
    }
}

/** The live representative uses exactly the same selection and tree order as deck construction. */
export function resolvePracticeCard(
    tree: TreeNode,
    positionKey: string,
    color: "white" | "black",
    start: number[],
) {
    for (const card of practiceCardsFromTree(tree, color, start)) {
        if (getBoardState(card.fen) === positionKey) return card;
    }
    return undefined;
}

export function buildFromTree(tree: TreeNode, color: "white" | "black", start: number[]) {
    const cards: Position[] = [];
    const seenBoardStates = new Set<string>();
    for (const { fen, answer } of practiceCardsFromTree(tree, color, start)) {
        const boardState = getBoardState(fen);
        if (seenBoardStates.has(boardState)) continue;
        seenBoardStates.add(boardState);
        cards.push({ fen, answer, card: createEmptyCard() });
    }
    return cards;
}

/** Empty Start covers every non-root position; the root is never a card. Union of both
 * orientations is every board state the tree can still practise under any scope. */
export function anyScopeBoardStates(tree: TreeNode): Set<string> {
    const boardStates = new Set<string>();
    for (const color of ["white", "black"] as const) {
        for (const pos of buildFromTree(tree, color, [])) {
            boardStates.add(getBoardState(pos.fen));
        }
    }
    return boardStates;
}

type Stats = {
    unseen: number;
    due: number;
    learned: number;
    nextDue: Date | null;
    total: number;
};

export type CardStatus = "unseen" | "due" | "practiced";

export function getCardStatus(card: Card, now: Date = new Date()): CardStatus {
    if (card.reps === 0) return "unseen";
    return new Date(card.due) <= now ? "due" : "practiced";
}

export function getStats(positions: Position[], now: Date = new Date()) {
    const scoped = inScopeCards(positions);
    const stats: Stats = {
        unseen: 0,
        due: 0,
        learned: 0,
        nextDue: null,
        total: scoped.length,
    };
    for (const card of scoped) {
        const status = getCardStatus(card.card, now);
        if (status === "unseen" || status === "due") stats[status]++;
        if (card.card.reps > 0) stats.learned++;
        if (status === "practiced") {
            const dueDate = new Date(card.card.due);
            if (!stats.nextDue || dueDate < stats.nextDue) {
                stats.nextDue = dueDate;
            }
        }
    }
    return stats;
}

export type PracticeAnswer = "answer" | "alternative" | "wrong";

export function classifyPracticeAnswer(
    card: Pick<Position, "fen" | "answer">,
    san: string,
    root: TreeNode,
    start: number[],
): PracticeAnswer {
    if (san === card.answer) return "answer";
    const boardState = getBoardState(card.fen);
    for (const frame of treeIterator(root)) {
        if (
            isInPracticeScope(frame.position, start) &&
            getBoardState(frame.node.fen) === boardState &&
            frame.node.children.some((child) => child.san === san)
        ) {
            return "alternative";
        }
    }
    return "wrong";
}

export function updateCardPerformance(
    positions: Position[],
    i: number,
    card: Card,
    grade: 1 | 2 | 3 | 4,
): {
    positions: Position[];
    entry: ReviewLog & { fen: string };
    entryId: string;
} | null {
    const schedulingCards = f.repeat(card, new Date());

    const { card: newCard, log } = schedulingCards[grade];
    const position = positions[i];
    if (!position) return null;
    return {
        positions: positions.map((candidate, index) =>
            index === i ? { ...candidate, card: newCard } : candidate,
        ),
        entry: { ...log, fen: position.fen },
        entryId: crypto.randomUUID(),
    };
}

export function syncDeck(
    existing: Position[],
    tree: TreeNode,
    color: "white" | "black",
    start: number[],
    retained?: () => ReadonlySet<string>,
): { positions: Position[]; added: number; removed: number; updated: number; reordered: boolean } {
    const freshPositions = buildFromTree(tree, color, start);
    const inTree = anyScopeBoardStates(tree);

    const existingByFen = new Map<string, Position>();
    for (const pos of existing) {
        existingByFen.set(getBoardState(pos.fen), pos);
    }

    let added = 0;
    // A retained card whose answer moved (a promoted variation) or whose full FEN changed (the same
    // board state reached at another move number) is a change to persist even though no position
    // was added or removed. The rebuilt FEN is carried forward so the persisted card stays equal
    // to the tree's current FEN; lookups go through `getBoardState` (f-20260922-02). Restoring a
    // card into the current (orientation, Start) scope drops `outOfScope` the same way (f-20261115-21).
    let updated = 0;
    const merged: Position[] = [];
    const mergedBoardStates = new Set<string>();
    for (const pos of freshPositions) {
        const boardState = getBoardState(pos.fen);
        const prev = existingByFen.get(boardState);
        if (prev) {
            const { outOfScope, ...rest } = prev;
            if (outOfScope || prev.answer !== pos.answer || prev.fen !== pos.fen) updated++;
            merged.push({ ...rest, fen: pos.fen, answer: pos.answer });
        } else {
            merged.push(pos);
            added++;
        }
        mergedBoardStates.add(boardState);
    }

    // Cards still in the tree for another orientation or Start stay in the deck, flagged, with
    // their schedule. Deduplicate by board state (first remaining card wins).
    for (const pos of existing) {
        const boardState = getBoardState(pos.fen);
        if (mergedBoardStates.has(boardState) || !inTree.has(boardState)) continue;
        merged.push({ ...pos, outOfScope: true });
        mergedBoardStates.add(boardState);
        if (!pos.outOfScope) updated++;
    }

    // Each merged board state keeps one existing card, discarding equivalent duplicates.
    // `removed` counts only cards absent from the tree for every scope (and not retained).
    let removed = existing.length - (merged.length - added);
    if (removed > 0 && retained) {
        const retainedBoardStates = retained();
        for (const pos of existing) {
            const boardState = getBoardState(pos.fen);
            if (!mergedBoardStates.has(boardState) && retainedBoardStates.has(boardState)) {
                merged.push(pos);
                mergedBoardStates.add(boardState);
                removed--;
            }
        }
    }

    // Out-of-scope and retained cards follow the tree-ordered in-scope cards in existing order.
    // Reordering the same cards is also a change to persist (full-repertoire order, due-date ties).
    const reordered =
        added === 0 &&
        removed === 0 &&
        merged.some((pos, index) => getBoardState(pos.fen) !== getBoardState(existing[index].fen));
    return { positions: merged, added, removed, updated, reordered };
}

export function getNextReviewTimes(card: Card): Record<Grade, Date> {
    const schedulingCards = f.repeat(card, new Date());
    return {
        1: schedulingCards[1].card.due,
        2: schedulingCards[2].card.due,
        3: schedulingCards[3].card.due,
        4: schedulingCards[4].card.due,
    };
}
