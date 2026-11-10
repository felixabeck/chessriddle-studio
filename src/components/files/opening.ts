import {
    type Card,
    createEmptyCard,
    fsrs,
    type Grade,
    type ReviewLog,
    generatorParameters,
} from "ts-fsrs";
import { z } from "zod";
import { isPrefix } from "@/utils/misc";
import { getBoardState, type TreeNode, treeIterator } from "@/utils/treeReducer";

const params = generatorParameters({ enable_fuzz: true });

const f = fsrs(params);

export const positionSchema = z.object({
    fen: z.string(),
    answer: z.string(),
    card: z.object({}).passthrough(),
});

export type Position = {
    fen: string;
    answer: string;
    card: Card;
};

/** Empty Start excludes the root. Otherwise, practice includes Start and its descendants. */
export function isInPracticeScope(position: number[], start: number[]): boolean {
    return start.length === 0 ? position.length > 0 : isPrefix(start, position);
}

export function buildFromTree(tree: TreeNode, color: "white" | "black", start: number[]) {
    const cards: Position[] = [];
    const seenBoardStates = new Set<string>();
    const iterator = treeIterator(tree);
    for (const item of iterator) {
        if (
            item.node.children.length === 0 ||
            !isInPracticeScope(item.position, start) ||
            !item.node.children[0].san
        ) {
            continue;
        }
        const boardState = getBoardState(item.node.fen);
        if (seenBoardStates.has(boardState)) continue;
        if (
            (color === "white" && item.node.halfMoves % 2 === 0) ||
            (color === "black" && item.node.halfMoves % 2 === 1)
        ) {
            seenBoardStates.add(boardState);
            cards.push({
                fen: item.node.fen,
                answer: item.node.children[0].san,
                card: createEmptyCard(),
            });
        }
    }
    return cards;
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
    const stats: Stats = {
        unseen: 0,
        due: 0,
        learned: 0,
        nextDue: null,
        total: positions.length,
    };
    for (const card of positions) {
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
): { positions: Position[]; added: number; removed: number; updated: number; reordered: boolean } {
    const freshPositions = buildFromTree(tree, color, start);

    const existingByFen = new Map<string, Position>();
    for (const pos of existing) {
        existingByFen.set(getBoardState(pos.fen), pos);
    }

    let added = 0;
    // A retained card whose answer moved (a promoted variation) or whose full FEN changed (the same
    // board state reached at another move number) is a change to persist even though no position
    // was added or removed. The rebuilt FEN is carried forward: consumers look cards up in the tree
    // by the exact FEN string, so a stale one would drop the card (f-20260922-02).
    let updated = 0;
    const merged: Position[] = [];
    for (const pos of freshPositions) {
        const prev = existingByFen.get(getBoardState(pos.fen));
        if (prev) {
            if (prev.answer !== pos.answer || prev.fen !== pos.fen) updated++;
            merged.push({ ...prev, fen: pos.fen, answer: pos.answer });
        } else {
            merged.push(pos);
            added++;
        }
    }

    // Each retained fresh position keeps one existing card, discarding equivalent duplicates.
    const removed = existing.length - (freshPositions.length - added);

    // The deck's order follows the tree's (full-repertoire order, due-date ties), so a reordering of
    // the same cards is also a change to persist.
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

export function formatReviewInterval(dueDate: Date): string {
    const now = new Date();
    const diffMs = dueDate.getTime() - now.getTime();
    const diffMin = Math.round(diffMs / 60000);
    const diffHrs = Math.round(diffMs / 3600000);
    const diffDays = Math.round(diffMs / 86400000);

    if (diffMin < 1) return "< 1m";
    if (diffMin < 60) return `${diffMin}m`;
    if (diffHrs < 24) return `${diffHrs}h`;
    if (diffDays < 30) return `${diffDays}d`;
    return `${Math.round(diffDays / 30)}mo`;
}
