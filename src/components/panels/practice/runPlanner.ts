import { inScopeCards } from "@/components/files/opening";
import type { Position } from "@/utils/practicePosition";
import { validWeight } from "@/utils/practicePosition";
import { getBoardState } from "@/utils/treeReducer";
import { compareUnseenByWeight } from "./session";

export const TIMED_RUN_INITIAL_PACE_SECONDS = 15;
export const TIMED_RUN_PACE_SAMPLE_CARDS = 5;

export type TimedRunCandidateKind = "due" | "unseen";

export type TimedRunCandidate = {
    file: string;
    game: number;
    positionKey: string;
    kind: TimedRunCandidateKind;
    weight?: number;
    dueAt: number;
    treeIndex: number;
};

export type TimedRunChapterPositions = {
    file: string;
    game: number;
    positions: readonly Position[];
};

export type TimedRunSegmentPlan = {
    file: string;
    game: number;
    positionKeys: string[];
};

function chapterKey(file: string, game: number): string {
    return `${file}\u0000${game}`;
}

function candidateKey(candidate: Pick<TimedRunCandidate, "file" | "game" | "positionKey">): string {
    return `${chapterKey(candidate.file, candidate.game)}\u0000${candidate.positionKey}`;
}

function compareDue(left: TimedRunCandidate, right: TimedRunCandidate): number {
    const byWeight = compareUnseenByWeight({ weight: left.weight }, { weight: right.weight });
    if (byWeight !== 0) return byWeight;
    if (validWeight(left.weight) === undefined && validWeight(right.weight) === undefined) {
        const byDue = left.dueAt - right.dueAt;
        if (byDue !== 0) return byDue;
    }
    return left.treeIndex - right.treeIndex;
}

function compareUnseenCandidates(left: TimedRunCandidate, right: TimedRunCandidate): number {
    const byWeight = compareUnseenByWeight({ weight: left.weight }, { weight: right.weight });
    if (byWeight !== 0) return byWeight;
    return left.treeIndex - right.treeIndex;
}

export function sortRunCandidates(due: TimedRunCandidate[], unseen: TimedRunCandidate[]): void {
    due.sort(compareDue);
    unseen.sort(compareUnseenCandidates);
}

export function collectRunCandidates(
    chapters: readonly TimedRunChapterPositions[],
    now: Date,
    newPerSession: number,
): TimedRunCandidate[] {
    const due: TimedRunCandidate[] = [];
    const unseen: TimedRunCandidate[] = [];
    for (const chapter of chapters) {
        const scoped = inScopeCards(chapter.positions);
        scoped.forEach((position, treeIndex) => {
            const candidate: TimedRunCandidate = {
                file: chapter.file,
                game: chapter.game,
                positionKey: getBoardState(position.fen),
                kind: position.card.reps > 0 ? "due" : "unseen",
                weight: validWeight(position.weight),
                dueAt: new Date(position.card.due).getTime(),
                treeIndex,
            };
            if (candidate.kind === "due") {
                if (new Date(position.card.due) <= now) due.push(candidate);
            } else {
                unseen.push(candidate);
            }
        });
    }
    sortRunCandidates(due, unseen);
    const selectedUnseen = unseen.slice(0, Math.max(0, newPerSession));
    return [...due, ...selectedUnseen];
}

export function timedRunPaceSeconds(presentedCount: number, elapsedMs: number): number {
    if (presentedCount < TIMED_RUN_PACE_SAMPLE_CARDS) return TIMED_RUN_INITIAL_PACE_SECONDS;
    if (elapsedMs <= 0) return TIMED_RUN_INITIAL_PACE_SECONDS;
    return elapsedMs / 1000 / presentedCount;
}

export function planNextSegment(
    candidates: readonly TimedRunCandidate[],
    remainingSeconds: number,
    presentedCount: number,
    elapsedMs: number,
): TimedRunSegmentPlan | null {
    if (candidates.length === 0 || remainingSeconds <= 0) return null;
    const pace = timedRunPaceSeconds(presentedCount, elapsedMs);
    const k = Math.max(1, Math.floor(remainingSeconds / pace));
    const hasDue = candidates.some((candidate) => candidate.kind === "due");
    const considered = (
        hasDue ? candidates.filter((candidate) => candidate.kind === "due") : candidates
    ).slice(0, k);
    if (considered.length === 0) return null;
    const top = considered[0];
    const chapterCards = considered.filter(
        (candidate) => candidate.file === top.file && candidate.game === top.game,
    );
    chapterCards.sort((left, right) => left.treeIndex - right.treeIndex);
    return {
        file: top.file,
        game: top.game,
        positionKeys: chapterCards.map((candidate) => candidate.positionKey),
    };
}

export function removeSegmentCandidates(
    candidates: readonly TimedRunCandidate[],
    segment: TimedRunSegmentPlan,
): TimedRunCandidate[] {
    const handed = new Set(
        segment.positionKeys.map((positionKey) => candidateKey({ ...segment, positionKey })),
    );
    return candidates.filter((candidate) => !handed.has(candidateKey(candidate)));
}

export function removeChapterCandidates(
    candidates: readonly TimedRunCandidate[],
    file: string,
    game: number,
): TimedRunCandidate[] {
    return candidates.filter((candidate) => candidate.file !== file || candidate.game !== game);
}
