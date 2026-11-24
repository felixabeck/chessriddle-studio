import { useTabAtom, useOwnerTabId } from "@/state/tabScope";
import { atom, useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import type { BestMoves } from "@/bindings";
import { threatFamily } from "@/state/atoms";
import type { Engine } from "@/utils/engines";
import {
    engineLinesWaiting,
    readEngineLines,
    useContentStableMoves,
    useEngineWaitExpired,
} from "./engineLines";

type DisplayedLines = { lines: BestMoves[]; searchedBoardFen: string | null; halfMoves: number };

/** Retains one committed display per mode and reader, scoped to its owner and settings. */
export function useDisplayedEngineLines(
    engine: Engine,
    fen: string,
    moves: string[],
    halfMoves = 0,
) {
    const tab = useOwnerTabId();
    const threat = useAtomValue(useTabAtom(threatFamily));
    const stableMoves = useContentStableMoves(moves);
    const {
        settings,
        search,
        error,
        isGameOver,
        context,
        retry,
        current,
        eligible,
        currentTerminal,
        failure,
        remoteNoLines,
    } = useAtomValue(
        useMemo(
            () => atom((get) => readEngineLines(get, tab, engine, fen, stableMoves, threat)),
            [tab, engine, fen, stableMoves, threat],
        ),
    );
    const scope = JSON.stringify([tab, context]);
    const [previous, setPrevious] = useState<{
        scope: string;
        displays: Map<boolean, DisplayedLines>;
    } | null>(null);
    if (previous && previous.scope !== scope) setPrevious(null);
    useEffect(() => {
        if (current && !error && !isGameOver)
            setPrevious((previous) => {
                const displays = new Map(previous?.displays);
                displays.set(threat, {
                    lines: current,
                    searchedBoardFen: search.searchedBoardFen,
                    halfMoves,
                });
                return { scope, displays };
            });
    }, [current, scope, search.searchedBoardFen, halfMoves, error, isGameOver, threat]);

    const waiting = engineLinesWaiting({ eligible, current, currentTerminal });
    const loading = useEngineWaitExpired(
        JSON.stringify([scope, search.key, threat, retry]),
        waiting,
    );
    const fallback =
        ((waiting && !loading) || failure) && current === undefined
            ? previous?.displays.get(threat)
            : undefined;
    return {
        lines:
            error || isGameOver
                ? undefined
                : remoteNoLines
                  ? []
                  : search.available
                    ? (current ?? fallback?.lines)
                    : [],
        dimmed: fallback !== undefined || (failure !== null && current !== undefined),
        failure,
        terminal: currentTerminal,
        loading,
        searchedBoardFen: fallback ? fallback.searchedBoardFen : search.searchedBoardFen,
        halfMoves: fallback ? fallback.halfMoves : halfMoves,
        error,
        isGameOver,
        threat,
        settings,
        available: search.available,
    };
}
