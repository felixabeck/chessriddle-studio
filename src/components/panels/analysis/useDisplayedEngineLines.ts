import { useTabAtom, useOwnerTabId } from "@/state/tabScope";
import { useAtomValue, useStore, type Getter } from "jotai";
import { useEffect, useState } from "react";
import type { BestMoves, EngineLog, EngineTerminalEntry, EngineTerminalSnapshot } from "@/bindings";
import type { TFunction } from "i18next";
import { normalizeError } from "@/platform/errors";
import {
    threatFamily,
    engineMovesFamily,
    engineTerminalFamily,
    engineRetryFamily,
    tabEngineSettingsFamily,
    type AnalysisTerminal,
} from "@/state/atoms";
import { positionFromFen } from "@/utils/chessops";
import type { Engine } from "@/utils/engines";
import { analysisSearch } from "./analysisSearch";
import { AnalysisLineMemory } from "./analysisLineMemory";
import { engineIdentity, engineLineContext } from "./analysisLineContext";

export const ENGINE_LINES_LOADING_DELAY_MS = 1000;

type DisplayedLines = { lines: BestMoves[]; searchedBoardFen: string | null; halfMoves: number };

/** The native snapshot is already safe. Render its text without interpreting markup. */
export function engineFailureMessage(
    t: TFunction,
    snapshot?: EngineTerminalSnapshot,
    message = "",
    cleanupFailed = false,
): string {
    if (cleanupFailed)
        return `${engineFailureMessage(t, snapshot, message)} ${t("Board.Analysis.EngineCleanupFailed")}`;
    if (!snapshot) return message.trim() ? message : t("Board.Analysis.EngineDisconnected");
    if (snapshot?.reason) return snapshot.reason;
    if (snapshot?.exitStatus?.signal != null)
        return t("Board.Analysis.EngineExitSignal", { signal: snapshot.exitStatus.signal });
    if (snapshot?.exitStatus?.code != null)
        return t("Board.Analysis.EngineExitCode", { code: snapshot.exitStatus.code });
    if (snapshot?.kind === "protocol-failure") return t("Board.Analysis.EngineProtocolFailure");
    if (snapshot?.kind === "process-exit") return t("Board.Analysis.EngineExited");
    return t("Board.Analysis.EngineDisconnected");
}

export function engineTerminalLogs(t: TFunction, entries: EngineTerminalEntry[]): EngineLog[] {
    return entries.map((entry) => ({
        type: "engine",
        value: entry.type === "truncated" ? t("Engines.Logs.TerminalTruncated") : entry.value,
    }));
}

export function reportEngineFailure(t: TFunction, cause: unknown): unknown {
    const failure = normalizeError(cause);
    return failure.engineFailure || failure.backendCategory === "engine-failure"
        ? {
              ...failure,
              message: engineFailureMessage(
                  t,
                  failure.engineFailure,
                  failure.message,
                  failure.backendCategory === "operation-and-cleanup",
              ),
          }
        : cause;
}

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
            defaultSettings: engine.settings ?? undefined,
            defaultGo: engine.go ?? undefined,
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

/** Retains one committed display per mode and reader, scoped to its owner and settings. */
export function useDisplayedEngineLines(
    engine: Engine,
    fen: string,
    moves: string[],
    halfMoves = 0,
) {
    const tab = useOwnerTabId();
    const threat = useAtomValue(useTabAtom(threatFamily));
    const store = useStore();
    useAtomValue(
        tabEngineSettingsFamily({
            tab,
            engineId: engine.id,
            defaultSettings: engine.settings ?? undefined,
            defaultGo: engine.go ?? undefined,
        }),
    );
    useAtomValue(engineMovesFamily({ tab, engine: engine.id }));
    useAtomValue(engineTerminalFamily({ tab, engine: engine.id }));
    useAtomValue(engineRetryFamily({ tab, engine: engine.id }));
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
    } = readEngineLines(store.get, tab, engine, fen, moves, threat);
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

    const waiting = eligible && current === undefined && !currentTerminal;
    const request = JSON.stringify([scope, search.key, threat, retry]);
    const [expired, setExpired] = useState<string | null>(null);
    useEffect(() => {
        setExpired(null);
        if (!waiting) return;
        const timer = window.setTimeout(() => setExpired(request), ENGINE_LINES_LOADING_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [request, waiting]);
    const loading = waiting && expired === request;
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
