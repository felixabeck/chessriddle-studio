import { useEffect, useRef, useState } from "react";
import type { CollectionDescriptor, DatabaseHandle } from "@/bindings";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import {
    fetchPositionMoves,
    type TreeStatistics,
    type TreeStatisticsEntry,
} from "@/utils/repertoire";
import { getBoardState } from "@/utils/treeReducer";

export type DbMovesEntry = TreeStatisticsEntry;
export type DbMovesMap = TreeStatistics;

export type UseReferenceMovesParams = {
    currentFen: string;
    referenceDb: DatabaseHandle | null;
    selectedReferenceKey: string | null;
    referenceKey: string | null;
    currencyGeneration: CollectionDescriptor["generation"] | undefined;
    currencyStatus: CollectionDescriptor["status"] | undefined;
    currencyError: unknown;
    currencyPending: boolean;
    errorTitle: string;
};

type ReferenceMovesIdentity = Pick<
    UseReferenceMovesParams,
    | "selectedReferenceKey"
    | "referenceKey"
    | "currencyGeneration"
    | "currencyStatus"
    | "currencyError"
    | "currencyPending"
>;

function sameReferenceMovesIdentity(left: ReferenceMovesIdentity, right: ReferenceMovesIdentity) {
    return (
        Object.is(left.selectedReferenceKey, right.selectedReferenceKey) &&
        Object.is(left.referenceKey, right.referenceKey) &&
        Object.is(left.currencyGeneration, right.currencyGeneration) &&
        Object.is(left.currencyStatus, right.currencyStatus) &&
        Object.is(left.currencyError, right.currencyError) &&
        Object.is(left.currencyPending, right.currencyPending)
    );
}

export function useReferenceMoves({
    currentFen,
    referenceDb,
    selectedReferenceKey,
    referenceKey,
    currencyGeneration,
    currencyStatus,
    currencyError,
    currencyPending,
    errorTitle,
}: UseReferenceMovesParams) {
    const errorTitleRef = useRef(errorTitle);
    errorTitleRef.current = errorTitle;

    const [dbMovesMap, setDbMovesMap] = useState<DbMovesMap>(new Map());
    const positionRequest = useRef<AbortController | null>(null);
    const identity = {
        selectedReferenceKey,
        referenceKey,
        currencyGeneration,
        currencyStatus,
        currencyError,
        currencyPending,
    };
    const lastIdentity = useRef(identity);
    const identityRef = useRef(identity);
    identityRef.current = identity;

    useEffect(() => {
        // Last-seen comparison keeps a StrictMode effect replay from wiping a render-time seed.
        const next = identityRef.current;
        if (sameReferenceMovesIdentity(lastIdentity.current, next)) return;
        lastIdentity.current = next;
        positionRequest.current?.abort();
        setDbMovesMap(new Map());
    }, [
        selectedReferenceKey,
        referenceKey,
        currencyGeneration,
        currencyStatus,
        currencyError,
        currencyPending,
    ]);

    useEffect(
        () => () => {
            positionRequest.current?.abort();
        },
        [],
    );

    useEffect(() => {
        if (!referenceDb) return;
        const boardFen = getBoardState(currentFen);
        if (dbMovesMap.has(boardFen)) return;

        positionRequest.current?.abort();
        const controller = new AbortController();
        positionRequest.current = controller;
        fetchPositionMoves(referenceDb, boardFen, controller.signal)
            .then((data) => {
                if (controller.signal.aborted) return;
                setDbMovesMap((prev) => {
                    if (prev.has(boardFen)) return prev; // may have been filled by coverage meanwhile
                    const next = new Map(prev);
                    next.set(boardFen, data);
                    return next;
                });
            })
            .catch((error) => {
                if (controller.signal.aborted) return;
                notifyUnlessCancelled(errorTitleRef.current, error);
            });
        return () => controller.abort();
    }, [currentFen, referenceDb, dbMovesMap]);

    return { dbMovesMap, replaceMoves: setDbMovesMap };
}
