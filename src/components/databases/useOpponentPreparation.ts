import dayjs from "dayjs";
import { useAtomValue, useStore } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DatabaseHandle, Player, PositionStats, PositionStatsFilter } from "@/bindings";
import {
    fileWorkspaceAtom,
    opponentPreparationAtom,
    preparationIdentityKey,
    type StoredOpponentPreparation,
} from "@/state/atoms";
import type { OpponentPeriod } from "@/state/opponentLinks";
import { readRepertoireIndex, refreshRepertoireIndex } from "@/state/repertoireIndex";
import { databaseHandleKey } from "@/utils/db";
import {
    chapterOrientation,
    collectPreparationFens,
    computePreparationViews,
    DEFAULT_PREPARATION_MIN_GAMES,
    type PreparationColor,
    type PreparationMinGames,
    type PreparationSource,
    userColorForOpponent,
} from "@/utils/opponentPreparation";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { fetchBatchStatistics } from "@/utils/repertoire";
import type { OnlineGames } from "./useOnlineGames";

export type EmptyRepertoireReason = "no-workspace" | "no-files" | "no-color-chapters";

export type PreparationJobState =
    | { kind: "loading"; stage: "repertoire" | "searching"; progressId: string }
    | { kind: "empty-repertoire"; reason: EmptyRepertoireReason }
    | { kind: "repertoire-failed" }
    | { kind: "search-failed"; error: unknown }
    | { kind: "ready"; preparation: StoredOpponentPreparation };

type InternalJobState = Exclude<PreparationJobState, { kind: "ready" }> | { kind: "idle" };

/** Computes the start date string for a period preset, matching the Openings tab. */
function preparationStartDate(period: OpponentPeriod): string | null {
    if (period === null) return null;
    return dayjs().subtract(period, "year").format("YYYY.MM.DD");
}

function buildFilter(
    playerId: number,
    opponentColor: PreparationColor,
    startDate: string | null,
): PositionStatsFilter {
    return {
        player1: opponentColor === "white" ? playerId : null,
        player2: opponentColor === "black" ? playerId : null,
        startDate,
        includeUnknownResults: true,
    };
}

/**
 * The stored preparation recomputed for another minimum from its kept statistics, under the same
 * id so open notation tabs and the training follow it; unchanged when it already has that minimum.
 */
function withMinGames(
    preparation: StoredOpponentPreparation,
    minGames: PreparationMinGames,
): StoredOpponentPreparation {
    if (preparation.minGames === minGames) return preparation;
    return {
        ...preparation,
        minGames,
        views: computePreparationViews(
            preparation.files,
            preparation.opponentColor,
            preparation.stats.otb,
            preparation.stats.online,
            minGames,
        ),
    };
}

/**
 * Owns the opponent preparation job for the Preparation tab.
 *
 * Every run carries a monotonic run id and its own AbortController. Results and failures apply
 * only when the run id is still current. Changing the identity, unmounting, or clicking
 * Refresh/Retry aborts the active run; a card-database search failure aborts the same run's
 * online search. A stored preparation matching the current identity is reused without a new run.
 */
export function useOpponentPreparation({
    player,
    file,
    opponentName,
    online,
    opponentColor,
    period,
}: {
    player: Player;
    file: DatabaseHandle;
    opponentName: string;
    online: OnlineGames | undefined;
    opponentColor: PreparationColor;
    period: OpponentPeriod;
}): {
    state: PreparationJobState;
    restart: () => void;
    setSource: (source: PreparationSource) => void;
    minGames: PreparationMinGames;
    setMinGames: (minGames: PreparationMinGames) => void;
} {
    const atoms = useStore();
    const workspace = useAtomValue(fileWorkspaceAtom);
    const stored = useAtomValue(opponentPreparationAtom);

    const workspaceKey = workspace ? fileWorkspaceKey(workspace) : "";
    const cardDatabaseKey = databaseHandleKey(file);
    const onlineFile = online?.lookup.kind === "found" ? online.file : null;
    const onlinePlayerId = online?.lookup.kind === "found" ? online.lookup.player : null;
    const onlineFileKey = onlineFile ? databaseHandleKey(onlineFile) : null;

    const identityKey = useMemo(
        () =>
            preparationIdentityKey({
                workspaceKey,
                cardDatabaseKey,
                playerId: player.id,
                onlineSource:
                    onlineFileKey !== null && onlinePlayerId !== null
                        ? { fileKey: onlineFileKey, playerId: onlinePlayerId }
                        : null,
                opponentColor,
                period,
            }),
        [
            workspaceKey,
            cardDatabaseKey,
            player.id,
            onlineFileKey,
            onlinePlayerId,
            opponentColor,
            period,
        ],
    );

    const [internalState, setInternalState] = useState<InternalJobState>(() => {
        if (stored && stored.identityKey === identityKey) return { kind: "idle" };
        if (workspace === null) return { kind: "empty-repertoire", reason: "no-workspace" };
        return { kind: "loading", stage: "repertoire", progressId: "" };
    });
    const [runNonce, setRunNonce] = useState(0);

    const runIdRef = useRef(0);
    const abortControllerRef = useRef<AbortController | null>(null);
    const storedForPlayer =
        stored && stored.cardDatabaseKey === cardDatabaseKey && stored.playerId === player.id
            ? stored
            : null;
    const preferredSourceRef = useRef<PreparationSource>(storedForPlayer?.source ?? "otb");
    const [minGames, setMinGamesState] = useState<PreparationMinGames>(
        () => storedForPlayer?.minGames ?? DEFAULT_PREPARATION_MIN_GAMES,
    );
    const minGamesRef = useRef(minGames);
    minGamesRef.current = minGames;

    const fileRef = useRef(file);
    fileRef.current = file;
    const onlineFileRef = useRef(onlineFile);
    onlineFileRef.current = onlineFile;
    const workspaceRef = useRef(workspace);
    workspaceRef.current = workspace;
    const opponentNameRef = useRef(opponentName);
    opponentNameRef.current = opponentName;

    useEffect(() => {
        const existing = atoms.get(opponentPreparationAtom);
        if (existing && existing.identityKey === identityKey) {
            preferredSourceRef.current = existing.source;
            // The minimum may have changed while another identity was shown.
            const reconciled = withMinGames(existing, minGamesRef.current);
            if (reconciled !== existing) atoms.set(opponentPreparationAtom, reconciled);
            setInternalState({ kind: "idle" });
            return;
        }

        const currentWorkspace = workspaceRef.current;
        if (currentWorkspace === null) {
            setInternalState({ kind: "empty-repertoire", reason: "no-workspace" });
            return;
        }

        const runId = ++runIdRef.current;
        const runController = new AbortController();
        abortControllerRef.current = runController;

        const isCurrent = () => runIdRef.current === runId && !runController.signal.aborted;

        setInternalState({ kind: "loading", stage: "repertoire", progressId: "" });

        void (async () => {
            await refreshRepertoireIndex(currentWorkspace);
            if (!isCurrent()) return;

            const snapshot = readRepertoireIndex(currentWorkspace);
            if (!snapshot) {
                setInternalState({ kind: "repertoire-failed" });
                return;
            }

            const userColor = userColorForOpponent(opponentColor);
            const hasMatchingChapter = snapshot.files.some((indexedFile) =>
                indexedFile.chapters.some(
                    (chapter) => chapterOrientation(chapter.headers.orientation) === userColor,
                ),
            );

            if (
                snapshot.partialReason === "listing-failed" ||
                (snapshot.partial && !hasMatchingChapter)
            ) {
                setInternalState({ kind: "repertoire-failed" });
                return;
            }

            if (snapshot.files.length === 0) {
                setInternalState({ kind: "empty-repertoire", reason: "no-files" });
                return;
            }

            if (!hasMatchingChapter) {
                setInternalState({ kind: "empty-repertoire", reason: "no-color-chapters" });
                return;
            }

            const fens = collectPreparationFens(snapshot.files, opponentColor);
            const startDate = preparationStartDate(period);

            const otbController = new AbortController();
            const otbProgressId = `opponent-prep:${crypto.randomUUID()}`;
            const currentOnlineFile = onlineFileRef.current;
            const hasOnline = currentOnlineFile !== null && onlinePlayerId !== null;
            const onlineController = hasOnline ? new AbortController() : null;
            const onlineProgressId = hasOnline
                ? `opponent-prep-online:${crypto.randomUUID()}`
                : null;

            const onRunAbort = () => {
                otbController.abort();
                onlineController?.abort();
            };
            runController.signal.addEventListener("abort", onRunAbort, { once: true });

            setInternalState({
                kind: "loading",
                stage: "searching",
                progressId: otbProgressId,
            });

            const otbPromise = fetchBatchStatistics(
                fens,
                fileRef.current,
                buildFilter(player.id, opponentColor, startDate),
                otbController.signal,
                otbProgressId,
            );

            const onlinePromise =
                hasOnline && onlineController && onlineProgressId
                    ? fetchBatchStatistics(
                          fens,
                          currentOnlineFile,
                          buildFilter(onlinePlayerId, opponentColor, startDate),
                          onlineController.signal,
                          onlineProgressId,
                      ).then(
                          (stats) => ({ ok: true as const, stats }),
                          (error: unknown) => ({ ok: false as const, error }),
                      )
                    : null;

            let otbStats: Map<string, PositionStats[]>;
            try {
                otbStats = await otbPromise;
            } catch (error) {
                // A card-database search failure aborts the same run's online search.
                onlineController?.abort();
                runController.signal.removeEventListener("abort", onRunAbort);
                // Caller-initiated aborts leave `isCurrent()` false and stay silent; a backend-
                // initiated rejection while this run is still current must surface as a failure.
                if (!isCurrent()) return;
                setInternalState({ kind: "search-failed", error });
                return;
            }

            if (!isCurrent()) {
                runController.signal.removeEventListener("abort", onRunAbort);
                return;
            }

            let onlineStats: Map<string, PositionStats[]> | null = null;
            let onlineFailed = false;
            if (onlinePromise) {
                const onlineResult = await onlinePromise;
                if (!isCurrent()) {
                    runController.signal.removeEventListener("abort", onRunAbort);
                    return;
                }
                if (onlineResult.ok) {
                    onlineStats = onlineResult.stats;
                } else {
                    onlineFailed = true;
                }
            }

            runController.signal.removeEventListener("abort", onRunAbort);
            if (!isCurrent()) return;

            const runMinGames = minGamesRef.current;
            const views = computePreparationViews(
                snapshot.files,
                opponentColor,
                otbStats,
                onlineStats,
                runMinGames,
            );
            const nextSource: PreparationSource =
                onlineStats !== null && !onlineFailed ? preferredSourceRef.current : "otb";

            atoms.set(opponentPreparationAtom, {
                id: crypto.randomUUID(),
                identityKey,
                cardDatabaseKey,
                playerId: player.id,
                opponentName: opponentNameRef.current,
                opponentColor,
                period,
                source: nextSource,
                minGames: runMinGames,
                views,
                stats: { otb: otbStats, online: onlineStats },
                files: snapshot.files,
                partial: snapshot.partial,
                onlineFailed,
            });
            setInternalState({ kind: "idle" });
        })();

        return () => {
            runIdRef.current += 1;
            runController.abort();
            if (abortControllerRef.current === runController) {
                abortControllerRef.current = null;
            }
        };
    }, [
        atoms,
        identityKey,
        workspaceKey,
        cardDatabaseKey,
        player.id,
        onlineFileKey,
        onlinePlayerId,
        opponentColor,
        period,
        runNonce,
    ]);

    const restart = useCallback(() => {
        runIdRef.current += 1;
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
        const current = atoms.get(opponentPreparationAtom);
        if (current?.identityKey === identityKey) {
            atoms.set(opponentPreparationAtom, null);
        }
        setRunNonce((n) => n + 1);
    }, [atoms, identityKey]);

    const setSource = useCallback(
        (source: PreparationSource) => {
            preferredSourceRef.current = source;
            const current = atoms.get(opponentPreparationAtom);
            if (current && current.identityKey === identityKey && current.source !== source) {
                atoms.set(opponentPreparationAtom, { ...current, source });
            }
        },
        [atoms, identityKey],
    );

    const setMinGames = useCallback(
        (next: PreparationMinGames) => {
            // A run that finishes before the next render reads the new minimum.
            minGamesRef.current = next;
            setMinGamesState(next);
            const current = atoms.get(opponentPreparationAtom);
            if (current && current.identityKey === identityKey) {
                atoms.set(opponentPreparationAtom, withMinGames(current, next));
            }
        },
        [atoms, identityKey],
    );

    const state: PreparationJobState =
        stored && stored.identityKey === identityKey
            ? { kind: "ready", preparation: stored }
            : internalState.kind === "idle"
              ? { kind: "loading", stage: "repertoire", progressId: "" }
              : internalState;

    return {
        state,
        restart,
        setSource,
        minGames,
        setMinGames,
    };
}
