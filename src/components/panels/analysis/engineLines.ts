import { atom, type Getter } from "jotai";
import { useEffect, useMemo, useState } from "react";
import type { Score } from "@/bindings";
import {
    enginesAtom,
    threatFamily,
    engineMovesFamily,
    engineTerminalFamily,
    engineRetryFamily,
    tabEngineSettingsFamily,
    type AnalysisTerminal,
} from "@/state/atoms";
import { positionFromFen } from "@/utils/chessops";
import type { Engine } from "@/utils/engines";
import { analysisSearch } from "@/utils/analysisSearch";
import { AnalysisLineMemory } from "@/utils/analysisLineMemory";
import { engineIdentity, engineLineContext } from "./analysisLineContext";

export const ENGINE_LINES_LOADING_DELAY_MS = 1000;

export function matchingEngineTerminal(
    terminal: AnalysisTerminal | null,
    engine: Engine,
    context: string,
    retry: number,
    searchedKey?: string,
): AnalysisTerminal | null {
    return engine.loaded &&
        terminal?.context === context &&
        terminal.engineIdentity === engineIdentity(engine) &&
        terminal.retry === retry &&
        (searchedKey === undefined || terminal.searchedKey === searchedKey)
        ? terminal
        : null;
}

/** Shared current-line eligibility for the panel and actions consuming its analysis. */
export function readEngineLines(
    get: Getter,
    tab: string,
    engine: Engine,
    fen: string,
    moves: string[],
    threat: boolean,
) {
    const settings = get(
        tabEngineSettingsFamily({
            tab,
            engineId: engine.id,
        }),
    );
    const memory = get(engineMovesFamily({ tab, engine: engine.id }));
    const terminal = get(engineTerminalFamily({ tab, engine: engine.id }));
    const retry = get(engineRetryFamily({ tab, engine: engine.id }));
    const search = analysisSearch(fen, moves, threat);
    const [, error] = positionFromFen(fen);
    const isGameOver = search.position?.isEnd() ?? false;
    const context = engineLineContext(settings, engine);
    const current =
        !search.available || (memory instanceof AnalysisLineMemory && memory.context !== context)
            ? undefined
            : memory.get(search.key);
    const eligible = search.available && settings.enabled && !error && !isGameOver;
    const currentTerminal = eligible
        ? matchingEngineTerminal(terminal, engine, context, retry, search.key)
        : null;
    const failure = currentTerminal?.type === "failed" ? currentTerminal : null;
    const remoteNoLines = engine.type !== "local" && currentTerminal !== null && !failure;
    return {
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
        actionable:
            engine.loaded &&
            eligible &&
            !failure &&
            !remoteNoLines &&
            memory instanceof AnalysisLineMemory &&
            memory.context === context
                ? current
                : undefined,
    };
}

/** A search for this position is due but has produced neither lines nor a terminal yet. */
export function engineLinesWaiting({
    eligible,
    current,
    currentTerminal,
}: Pick<ReturnType<typeof readEngineLines>, "eligible" | "current" | "currentTerminal">): boolean {
    return eligible && current === undefined && !currentTerminal;
}

/**
 * Whether `request` has been waiting for `ENGINE_LINES_LOADING_DELAY_MS`. A new request restarts
 * the delay, and the timer is cleared when the request changes, stops waiting or unmounts.
 */
export function useEngineWaitExpired(request: string, waiting: boolean): boolean {
    const [expired, setExpired] = useState<string | null>(null);
    useEffect(() => {
        setExpired(null);
        if (!waiting) return;
        const timer = window.setTimeout(() => setExpired(request), ENGINE_LINES_LOADING_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [request, waiting]);
    return waiting && expired === request;
}

/**
 * `moves` under an identity that changes only with its content. An atom memoised over a move list
 * must not be keyed by array identity: an equal but fresh array on every render would create a
 * fresh atom per render, and jotai re-renders on every atom swap.
 */
export function useContentStableMoves(moves: string[]): string[] {
    const key = JSON.stringify(moves);
    return useMemo(() => JSON.parse(key) as string[], [key]);
}

/** A position's live engine score and the engine it comes from. */
export type LiveEngineScore = { score: Score; engineName: string };

/**
 * The live score the engines give this position. `source` is the remembered top line of the
 * first loaded, enabled engine in list order that has lines for this exact position, whatever
 * its type, so the user's engine order decides whose score the position shows and a later
 * engine fills in while an earlier one has none. `pending` says an engine is still computing
 * the position's first lines and none has a score yet. A threat search scores another
 * position, so it yields neither.
 */
export const createLiveEngineScoreAtom = (tab: string, fen: string, moves: string[]) =>
    atom((get): { source: LiveEngineScore | null; pending: boolean } => {
        if (get(threatFamily(tab))) return { source: null, pending: false };
        let pending = false;
        for (const engine of get(enginesAtom) ?? []) {
            if (!engine.loaded) continue;
            const read = readEngineLines(get, tab, engine, fen, moves, false);
            const score = read.eligible ? read.current?.[0]?.score : undefined;
            if (score) return { source: { score, engineName: engine.name }, pending: false };
            pending ||= engineLinesWaiting(read);
        }
        return { source: null, pending };
    });
