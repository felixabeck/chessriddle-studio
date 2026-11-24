import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useStore } from "zustand";
import {
    classifyPracticeAnswer,
    resolvePracticeCard,
    updateCardPerformance,
} from "@/components/files/opening";
import {
    activeTabAtom,
    evalOpenFamily,
    invisibleFamily,
    practiceCardStartTimeFamily,
    practiceCompletedSummaryFamily,
    practiceGradingAtom,
    practiceMoveControllerFamily,
    practiceNewPerSessionAtom,
    practiceRunRequestFamily,
    practiceSessionEndAtom,
    practiceSessionStatsFamily,
    practiceStateFamily,
    showCommentsFamily,
    type PracticeSessionEndReason,
    type PracticeSessionStats,
} from "@/state/atoms";
import { emptyPracticeStats } from "@/state/practiceSessionStats";
import type { TreeStore } from "@/state/store/tree";
import { useTabAtom } from "@/state/tabScope";
import { backgroundHotkeyOptions } from "@/utils/keyboardOwnership";
import { getBoardState, type GameHeaders, type TreeNode } from "@/utils/treeReducer";
import {
    advancePracticeQueue,
    buildPracticeQueue,
    buildPracticeReplay,
    canSubmitPracticeMove,
    getAutomaticPracticeGrade,
    idlePracticeSession,
    PRACTICE_REPLAY_STEP_MS,
    practiceSessionReducer,
    type PracticeSession,
} from "./session";
import type { DeckIdentity, UseDeckSyncResult } from "./useDeckSync";

const PRACTICE_ADVANCE_DELAY_MS = 300;

export type UsePracticeSessionParams = {
    store: TreeStore;
    root: TreeNode;
    headers: GameHeaders;
    currentFen: string;
    deck: UseDeckSyncResult["deck"];
    setDeck: UseDeckSyncResult["setDeck"];
    deckIdentity: DeckIdentity;
    currentTabId: string | undefined;
    currentTabTreeKey: string | undefined;
    tab: string;
    clearSyncMessageTimer: () => void;
    syncedWithTreeAndScope?: boolean;
};

export function usePracticeSession({
    store,
    root,
    headers,
    currentFen,
    deck,
    setDeck,
    deckIdentity,
    currentTabId,
    currentTabTreeKey,
    tab,
    clearSyncMessageTimer,
    syncedWithTreeAndScope = false,
}: UsePracticeSessionParams) {
    const setPracticePath = useStore(store, (s) => s.setPracticePath);
    const activeTab = useAtomValue(activeTabAtom);
    const deckCanWrite = deck.status === "ready";

    const setInvisible = useSetAtom(useTabAtom(invisibleFamily));
    const setShowComments = useSetAtom(useTabAtom(showCommentsFamily));
    const setEvalOpen = useSetAtom(useTabAtom(evalOpenFamily));
    const [practiceState, setPracticeState] = useAtom(useTabAtom(practiceStateFamily));
    const [, setPracticeMoveController] = useAtom(useTabAtom(practiceMoveControllerFamily));
    const [sessionStats, setSessionStats] = useAtom(useTabAtom(practiceSessionStatsFamily));
    const [completedSummary, setCompletedSummary] = useAtom(
        useTabAtom(practiceCompletedSummaryFamily),
    );
    const setCardStartTime = useSetAtom(useTabAtom(practiceCardStartTimeFamily));
    const practiceGrading = useAtomValue(practiceGradingAtom);
    const newPerSession = useAtomValue(practiceNewPerSessionAtom);
    const runRequest = useAtomValue(useTabAtom(practiceRunRequestFamily));
    const setSessionEndReport = useSetAtom(practiceSessionEndAtom);
    const sessionRef = useRef<PracticeSession>(idlePracticeSession());
    const sessionStatsRef = useRef(sessionStats);
    sessionStatsRef.current = sessionStats;
    const deckRef = useRef(deck);
    deckRef.current = deck;
    const presentationRef = useRef({ failed: false, learning: false, rated: false, startedAt: 0 });
    const [alternative, setAlternative] = useState(false);
    const navigationTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
    const endPracticeSessionRef = useRef<(reason: PracticeSessionEndReason) => void>(
        () => undefined,
    );
    const sessionStartedRef = useRef(false);
    const endReportedRef = useRef(false);
    const handledRunRequestRef = useRef<string | null>(null);
    const runRequestRef = useRef(runRequest);
    runRequestRef.current = runRequest;
    const setSessionEndReportRef = useRef(setSessionEndReport);
    setSessionEndReportRef.current = setSessionEndReport;

    const clearPracticeTimers = useCallback(() => {
        for (const timer of navigationTimersRef.current) clearTimeout(timer);
        navigationTimersRef.current.clear();
        clearSyncMessageTimer();
    }, [clearSyncMessageTimer]);

    const setSession = useCallback(
        (next: PracticeSession) => {
            sessionRef.current = next;
            const { token: _token, ...visible } = next;
            setPracticeState(visible);
        },
        [setPracticeState],
    );

    const publishStats = useCallback(
        (next: PracticeSessionStats) => {
            sessionStatsRef.current = next;
            setSessionStats(next);
        },
        [setSessionStats],
    );

    const endPracticeSession = useCallback(
        (reason: PracticeSessionEndReason = "stop") => {
            if (!sessionStartedRef.current && sessionRef.current.phase === "idle") return;
            if (endReportedRef.current) return;
            endReportedRef.current = true;
            sessionStartedRef.current = false;
            clearPracticeTimers();
            const summary = sessionStatsRef.current;
            const request = runRequestRef.current;
            if (request) {
                setSessionEndReportRef.current({
                    runId: request.runId,
                    segmentId: request.segmentId,
                    reason,
                    correct: summary.correct,
                    incorrect: summary.incorrect,
                });
            }
            if (sessionRef.current.phase !== "idle") {
                setSession(
                    practiceSessionReducer(sessionRef.current, {
                        type: "end",
                        token: sessionRef.current.token,
                    }),
                );
            }
            setPracticePath(null);
            setInvisible(false);
            setShowComments(true);
            setEvalOpen(true);
            setCardStartTime(0);
            setPracticeMoveController(null);
            publishStats(emptyPracticeStats());
            setCompletedSummary(summary.correct + summary.incorrect > 0 ? summary : null);
        },
        [
            clearPracticeTimers,
            setSession,
            setPracticePath,
            setInvisible,
            setShowComments,
            setEvalOpen,
            setCardStartTime,
            setPracticeMoveController,
            publishStats,
            setCompletedSummary,
        ],
    );
    endPracticeSessionRef.current = endPracticeSession;

    useEffect(() => {
        if (practiceState.phase === "idle") setPracticePath(null);
    }, [practiceState.phase, setPracticePath]);

    const scheduleForSession = useCallback((token: number, callback: () => void, delay: number) => {
        const timer = setTimeout(() => {
            navigationTimersRef.current.delete(timer);
            if (sessionRef.current.token === token && sessionRef.current.phase !== "idle")
                callback();
        }, delay);
        navigationTimersRef.current.add(timer);
        return () => {
            clearTimeout(timer);
            navigationTimersRef.current.delete(timer);
        };
    }, []);

    const rateCard = useCallback(
        (positionKey: string, grade: 1 | 2 | 3 | 4) => {
            // A refused write consumes this presentation's rating too.
            if (presentationRef.current.rated) return;
            presentationRef.current.rated = true;
            const currentDeck = deckRef.current;
            const index = currentDeck.positions.findIndex(
                (position) => getBoardState(position.fen) === positionKey,
            );
            const sourcePosition = currentDeck.positions[index];
            if (
                !sourcePosition ||
                (currentDeck.status !== "ready" && currentDeck.status !== "write-pending")
            )
                return;
            const update = updateCardPerformance(
                currentDeck.positions,
                index,
                sourcePosition.card,
                grade,
            );
            if (!update) return;
            deckRef.current = {
                ...currentDeck,
                positions: update.positions,
                status: "write-pending",
            };
            void setDeck({ type: "rating", ...update, sourcePosition });
        },
        [setDeck],
    );

    const currentCard = deck.positions.find(
        (position) => getBoardState(position.fen) === practiceState.positionKey,
    );
    const liveCard = resolvePracticeCard(
        root,
        practiceState.positionKey ?? "",
        headers.orientation || "white",
        headers.start || [],
    );
    const answerFrame = liveCard?.frame;
    const answerNode = answerFrame?.node.children[0];
    const answerComment = answerNode?.comment?.trim() || "";
    const manualPrompt =
        practiceState.phase === "correct" &&
        sessionStats.mode === "anki" &&
        !presentationRef.current.failed &&
        !presentationRef.current.learning &&
        practiceGrading === "manual";

    const newPractice = useCallback(
        (transition: "first" | "next" | "restart" = "next") => {
            const request = runRequestRef.current;
            if (transition !== "restart" && request && Date.now() >= request.deadline) {
                endPracticeSession("deadline");
                return;
            }
            clearPracticeTimers();
            let latest = sessionStatsRef.current;
            const state = store.getState();
            let resolved: ReturnType<typeof resolvePracticeCard>;
            while (latest.remainingPositionKeys.length > 0) {
                const key = latest.remainingPositionKeys[0];
                resolved = resolvePracticeCard(
                    state.root,
                    key,
                    state.headers.orientation || "white",
                    state.headers.start || [],
                );
                if (resolved) break;
                latest = { ...latest, ...advancePracticeQueue(latest, latest.mode) };
            }
            publishStats(latest);
            if (!resolved || latest.remainingPositionKeys.length === 0) {
                endPracticeSession("queue-exhausted");
                return;
            }
            const key = latest.remainingPositionKeys[0];
            const { frame } = resolved;
            const card = deckRef.current.positions.find(
                (position) => getBoardState(position.fen) === key,
            );
            // A restarted replay still belongs to this presentation, unless its queue entry was dropped.
            const samePresentation =
                transition === "restart" && key === sessionRef.current.positionKey;
            presentationRef.current = samePresentation
                ? { ...presentationRef.current, startedAt: 0 }
                : {
                      failed: false,
                      learning:
                          latest.mode === "anki" &&
                          card?.card.reps === 0 &&
                          !latest.introducedPositionKeys.includes(key),
                      rated: false,
                      startedAt: 0,
                  };
            setAlternative(false);
            setInvisible(true);
            setShowComments(false);
            setEvalOpen(false);
            setCardStartTime(0);
            setPracticePath(frame.position);
            const replay = buildPracticeReplay(
                transition === "first" ? null : state.position,
                frame.position,
                state.headers.start || [],
            );
            state.goToMove(replay.startPath);
            const token = sessionRef.current.token + 1;
            setSession(
                practiceSessionReducer(sessionRef.current, {
                    type: "replay",
                    token,
                    fen: frame.node.fen,
                    positionKey: key,
                }),
            );

            const step = () => {
                const live = store.getState();
                const liveCard = resolvePracticeCard(
                    live.root,
                    key,
                    live.headers.orientation || "white",
                    live.headers.start || [],
                );
                if (!liveCard) {
                    publishStats({
                        ...sessionStatsRef.current,
                        ...advancePracticeQueue(sessionStatsRef.current, latest.mode),
                    });
                    newPractice();
                    return;
                }
                const liveFrame = liveCard.frame;
                // Re-resolve both paths after every delay. Edits may have reordered this branch.
                const next = buildPracticeReplay(
                    live.position,
                    liveFrame.position,
                    live.headers.start || [],
                );
                live.setPracticePath(liveFrame.position);
                if (next.startPath.length !== live.position.length) live.goToMove(next.startPath);
                if (next.steps.length > 0) live.goToMove(next.steps[0]);
                const arrived = store.getState().position;
                if (
                    arrived.length === liveFrame.position.length &&
                    arrived.every((index, depth) => index === liveFrame.position[depth])
                ) {
                    presentationRef.current.startedAt = Date.now();
                    setCardStartTime(Date.now());
                    setSession(
                        practiceSessionReducer(sessionRef.current, {
                            type: "replayed",
                            token,
                            learning: presentationRef.current.learning,
                        }),
                    );
                } else {
                    scheduleForSession(token, step, PRACTICE_REPLAY_STEP_MS);
                }
            };
            if (replay.steps.length === 0) step();
            else scheduleForSession(token, step, PRACTICE_REPLAY_STEP_MS);
        },
        [
            clearPracticeTimers,
            store,
            publishStats,
            endPracticeSession,
            setInvisible,
            setShowComments,
            setEvalOpen,
            setCardStartTime,
            setPracticePath,
            setSession,
            scheduleForSession,
        ],
    );

    const advancePresentation = useCallback(() => {
        const session = sessionRef.current;
        if (session.phase !== "correct" && session.phase !== "advancing") return;
        clearPracticeTimers();
        const latest = sessionStatsRef.current;
        publishStats({
            ...latest,
            ...advancePracticeQueue(
                latest,
                latest.mode,
                presentationRef.current.failed || presentationRef.current.learning,
            ),
        });
        if (session.phase === "correct")
            setSession(practiceSessionReducer(session, { type: "advance", token: session.token }));
        if (runRequestRef.current && Date.now() >= runRequestRef.current.deadline) {
            endPracticeSession("deadline");
            return;
        }
        newPractice();
    }, [clearPracticeTimers, publishStats, setSession, newPractice, endPracticeSession]);

    const submitMove = useCallback(
        (san: string) => {
            const session = sessionRef.current;
            const live = store.getState();
            if (!canSubmitPracticeMove(session, live.currentNode().fen)) return;
            const card = resolvePracticeCard(
                live.root,
                session.positionKey ?? "",
                live.headers.orientation || "white",
                live.headers.start || [],
            );
            if (!card) {
                newPractice();
                return;
            }
            const { frame } = card;
            const classification = classifyPracticeAnswer(
                card,
                san,
                live.root,
                live.headers.start || [],
            );
            if (
                (session.phase === "learning" || session.phase === "revealed") &&
                classification !== "answer"
            )
                return;
            if (classification === "alternative") {
                setAlternative(true);
                return;
            }
            setAlternative(false);
            const timeTaken = Date.now() - presentationRef.current.startedAt;
            if (classification === "answer") {
                const answerIndex = frame.node.children.findIndex(
                    (child) => child.san === card.answer,
                );
                if (answerIndex < 0) return;
                live.goToMove([...frame.position, answerIndex]);
                if (session.phase === "learning") {
                    const latest = sessionStatsRef.current;
                    publishStats({
                        ...latest,
                        introducedPositionKeys: [
                            ...latest.introducedPositionKeys,
                            session.positionKey!,
                        ],
                    });
                    setSession(
                        practiceSessionReducer(session, { type: "learned", token: session.token }),
                    );
                } else {
                    if (session.phase === "waiting" && !presentationRef.current.failed) {
                        const latest = sessionStatsRef.current;
                        publishStats({
                            ...latest,
                            correct: latest.correct + 1,
                            streak: latest.streak + 1,
                            bestStreak: Math.max(latest.bestStreak, latest.streak + 1),
                        });
                        if (latest.mode === "anki" && practiceGrading === "auto")
                            rateCard(session.positionKey!, getAutomaticPracticeGrade(timeTaken));
                    }
                    setSession(
                        practiceSessionReducer(session, {
                            type: "correct",
                            token: session.token,
                            answer: card.answer,
                            timeTaken,
                        }),
                    );
                }
                return;
            }
            if (session.phase === "waiting") {
                presentationRef.current.failed = true;
                const latest = sessionStatsRef.current;
                publishStats({ ...latest, incorrect: latest.incorrect + 1, streak: 0 });
                if (latest.mode === "anki") rateCard(session.positionKey!, 1);
            }
            setSession(
                practiceSessionReducer(session, {
                    type: "wrong",
                    token: session.token,
                    answer: card.answer,
                    playedMove: san,
                    timeTaken,
                }),
            );
        },
        [store, newPractice, publishStats, setSession, practiceGrading, rateCard],
    );

    const showMove = useCallback(() => {
        const session = sessionRef.current;
        if (session.phase !== "retry" || !session.answer) return;
        setAlternative(false);
        setSession(
            practiceSessionReducer(session, {
                type: "reveal",
                token: session.token,
                answer: session.answer,
            }),
        );
    }, [setSession]);

    function handleQualityRating(grade: 1 | 2 | 3 | 4) {
        if (!manualPrompt || sessionRef.current.phase !== "correct") return;
        rateCard(sessionRef.current.positionKey!, grade);
        advancePresentation();
    }

    function startSession(mode: PracticeSessionStats["mode"], explicitKeys?: string[]) {
        if (!deckCanWrite) return;
        sessionStartedRef.current = true;
        endReportedRef.current = false;
        setCompletedSummary(null);
        publishStats({
            ...emptyPracticeStats(),
            mode,
            ...(explicitKeys
                ? { remainingPositionKeys: explicitKeys, reappendedPositionKeys: [] }
                : buildPracticeQueue(deckRef.current.positions, mode, newPerSession, new Date())),
        });
        newPractice("first");
    }
    const startPractice = () => startSession("anki");
    const startFullPractice = () => startSession("full");
    const startSessionRef = useRef(startSession);
    startSessionRef.current = startSession;

    useEffect(() => {
        if (!runRequest) {
            handledRunRequestRef.current = null;
            return;
        }
        const key = `${runRequest.runId}:${runRequest.segmentId}`;
        if (handledRunRequestRef.current === key) return;
        if (!syncedWithTreeAndScope || !deckCanWrite) return;
        handledRunRequestRef.current = key;
        startSessionRef.current("anki", runRequest.positionKeys);
    }, [runRequest, syncedWithTreeAndScope, deckCanWrite]);

    const goBackToPosition = useCallback(() => {
        const state = store.getState();
        const card = resolvePracticeCard(
            state.root,
            sessionRef.current.positionKey ?? "",
            state.headers.orientation || "white",
            state.headers.start || [],
        );
        const frame = card?.frame;
        if (!frame) {
            newPractice();
            return;
        }
        state.goToMove(frame.position);
        state.setPracticePath(frame.position);
        setInvisible(true);
    }, [store, newPractice, setInvisible]);

    useEffect(() => {
        if (
            (practiceState.phase !== "correct" && practiceState.phase !== "advancing") ||
            manualPrompt ||
            answerComment
        )
            return;
        const token = sessionRef.current.token;
        return scheduleForSession(token, advancePresentation, PRACTICE_ADVANCE_DELAY_MS);
    }, [practiceState.phase, manualPrompt, answerComment, scheduleForSession, advancePresentation]);

    useEffect(() => {
        if (practiceState.phase === "idle") {
            setPracticeMoveController(null);
            return;
        }
        setPracticeMoveController({
            canMove: canSubmitPracticeMove(sessionRef.current, currentFen),
            hintSan:
                (practiceState.phase === "learning" || practiceState.phase === "revealed") &&
                currentFen === practiceState.currentFen
                    ? liveCard?.answer
                    : undefined,
            submitMove,
        });
        return () => setPracticeMoveController(null);
    }, [
        currentFen,
        liveCard?.answer,
        practiceState.phase,
        practiceState.currentFen,
        setPracticeMoveController,
        submitMove,
    ]);

    useEffect(() => {
        if (
            (sessionStartedRef.current || sessionRef.current.phase !== "idle") &&
            activeTab !== currentTabId
        ) {
            endPracticeSession("tab-left");
        }
    }, [activeTab, currentTabId, endPracticeSession]);

    useEffect(
        () => () => {
            clearPracticeTimers();
            endPracticeSessionRef.current("identity-change");
        },
        [clearPracticeTimers, deckIdentity.file, deckIdentity.game, currentTabTreeKey],
    );

    useHotkeys("1", () => handleQualityRating(1), {
        ...backgroundHotkeyOptions,
        enabled: manualPrompt,
    });
    useHotkeys("2", () => handleQualityRating(2), {
        ...backgroundHotkeyOptions,
        enabled: manualPrompt,
    });
    useHotkeys("3", () => handleQualityRating(3), {
        ...backgroundHotkeyOptions,
        enabled: manualPrompt,
    });
    useHotkeys("4", () => handleQualityRating(4), {
        ...backgroundHotkeyOptions,
        enabled: manualPrompt,
    });
    useHotkeys(
        "space",
        () => {
            const phase = sessionRef.current.phase;
            if (phase === "retry") showMove();
            else if (phase === "learning" || phase === "revealed") {
                const state = store.getState();
                const card = resolvePracticeCard(
                    state.root,
                    sessionRef.current.positionKey ?? "",
                    state.headers.orientation || "white",
                    state.headers.start || [],
                );
                if (card) submitMove(card.answer);
            } else if (!manualPrompt && answerComment) advancePresentation();
        },
        {
            ...backgroundHotkeyOptions,
            enabled:
                practiceState.phase === "retry" ||
                practiceState.phase === "learning" ||
                practiceState.phase === "revealed" ||
                (!manualPrompt &&
                    !!answerComment &&
                    (practiceState.phase === "correct" || practiceState.phase === "advancing")),
        },
    );

    useEffect(() => {
        if (tab !== "train" && (practiceState.phase !== "idle" || sessionStartedRef.current)) {
            endPracticeSession("tab-left");
        }
    }, [endPracticeSession, practiceState.phase, tab]);

    useEffect(() => {
        if (
            practiceState.phase !== "idle" &&
            (deck.status === "write-blocked" || deck.status === "read-failed")
        )
            endPracticeSession("unwritable");
    }, [deck.status, practiceState.phase, endPracticeSession]);

    useEffect(() => {
        const session = sessionRef.current;
        if (session.phase === "idle") return;
        if (session.phase === "replaying") {
            newPractice("restart");
            return;
        }
        const card = resolvePracticeCard(
            root,
            session.positionKey ?? "",
            headers.orientation || "white",
            headers.start || [],
        );
        if (!card) {
            const latest = sessionStatsRef.current;
            publishStats({ ...latest, ...advancePracticeQueue(latest, latest.mode) });
            newPractice();
        } else if (
            card.fen !== session.currentFen ||
            (session.answer !== undefined && card.answer !== session.answer)
        ) {
            setSession(
                practiceSessionReducer(session, {
                    type: "rebind",
                    token: session.token,
                    fen: card.fen,
                    answer: card.answer,
                }),
            );
            setPracticePath(card.frame.position);
            if (
                session.phase === "learning" ||
                session.phase === "waiting" ||
                session.phase === "retry" ||
                session.phase === "revealed"
            ) {
                store.getState().goToMove(card.frame.position);
            }
        }
    }, [
        root,
        headers.start,
        headers.orientation,
        deck.positions,
        newPractice,
        publishStats,
        setSession,
        setPracticePath,
        store,
    ]);

    return {
        practiceState,
        sessionStats,
        completedSummary,
        newPerSession,
        alternative,
        currentCard,
        liveCard,
        answerFrame,
        answerComment,
        manualPrompt,
        startPractice,
        startFullPractice,
        showMove,
        advancePresentation,
        handleQualityRating,
        endPracticeSession,
        goBackToPosition,
    };
}
