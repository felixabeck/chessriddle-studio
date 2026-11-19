import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import type { Score } from "@/bindings";
import {
    createLiveEngineScoreAtom,
    useEngineWaitExpired,
} from "@/components/panels/analysis/useDisplayedEngineLines";

/** What the evaluation bar shows. `engineName` is null for a score no running engine gives. */
export type EvalBarScore = { score: Score; engineName: string | null };

/**
 * The score the evaluation bar shows for the current node.
 *
 * A freshly reached position has no score until an engine's first line arrives, which emptied
 * the bar for a frame on every move. The engines' live score for this exact position comes
 * first: the first engine in list order that has one, named so the bar can say whose it is.
 * Without one the node's own stored score shows. While an engine is still computing the
 * position, the score shown just before stays on screen, so the bar slides to the new value
 * instead of blinking. The hold ends with the engine panel's own loading delay, never applies
 * when no search is pending (engine off, game over, threat mode, engine failed), never crosses
 * into another document loaded into the tab, and never revives a score once the bar has shown
 * empty.
 */
export function useEvalBarScore({
    score,
    tab,
    documentId,
    rootFen,
    moves,
}: {
    score: Score | null;
    tab: string;
    documentId: number;
    rootFen: string;
    moves: string[];
}): EvalBarScore | null {
    const scope = `${tab}:${documentId}`;
    const live = useAtomValue(
        useMemo(() => createLiveEngineScoreAtom(tab, rootFen, moves), [tab, rootFen, moves]),
    );
    const current = useMemo<EvalBarScore | null>(
        () => live.source ?? (score ? { score, engineName: null } : null),
        [live.source, score],
    );
    const waiting = current === null && live.pending;
    const expired = useEngineWaitExpired(JSON.stringify([scope, rootFen, moves]), waiting);
    const holding = waiting && !expired;
    const [held, setHeld] = useState<{ scope: string; shown: EvalBarScore } | null>(null);
    useEffect(() => {
        if (current) setHeld({ scope, shown: current });
        else if (!holding) setHeld(null);
    }, [current, holding, scope]);
    if (current) return current;
    return holding && held?.scope === scope ? held.shown : null;
}
