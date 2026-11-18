import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import type { Score } from "@/bindings";
import {
    createLiveEngineScoreAtom,
    useEngineWaitExpired,
} from "@/components/panels/analysis/useDisplayedEngineLines";

/**
 * The score the evaluation bar shows for the current node.
 *
 * A freshly reached position has no score until the engine's first line arrives, which emptied
 * the bar for a frame on every move. The node's own score comes first, then a local engine's
 * remembered lines for this exact position. While a local engine is still computing the
 * position, the score shown just before stays on screen, so the bar slides to the new value
 * instead of blinking. The hold ends with the engine panel's own loading delay, never applies
 * when no local search is pending (engine off, game over, threat mode, engine failed), never
 * crosses into another document loaded into the tab, and never revives a score once the bar has
 * shown empty.
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
}): Score | null {
    const scope = `${tab}:${documentId}`;
    const live = useAtomValue(
        useMemo(() => createLiveEngineScoreAtom(tab, rootFen, moves), [tab, rootFen, moves]),
    );
    const current = score ?? live.cached;
    const waiting = current === null && live.pending;
    const expired = useEngineWaitExpired(JSON.stringify([scope, rootFen, moves]), waiting);
    const holding = waiting && !expired;
    const [held, setHeld] = useState<{ scope: string; score: Score } | null>(null);
    useEffect(() => {
        if (current) setHeld({ scope, score: current });
        else if (!holding) setHeld(null);
    }, [current, holding, scope]);
    if (current) return current;
    return holding && held?.scope === scope ? held.score : null;
}
