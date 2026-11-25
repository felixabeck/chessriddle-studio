import { useDebouncedValue } from "@mantine/hooks";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR, { unstable_serialize } from "swr";
import type { DatabaseHandle, QueryOptions, QueryResponse } from "@/bindings";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { failureUnlessCancelled } from "@/platform/errors";
import type { ListDisplayMode } from "@/state/store/database";

export const ALL_RECORDS_CHUNK_SIZE = 100;
export const ALL_RECORDS_MAX_ROWS = 10_000;

export type DatabaseListKind = "games" | "players" | "tournaments";

type QueryWithOptions = { options?: QueryOptions<unknown> | null };

type ExtraChunkState<R> = {
    identity: string;
    baseData: QueryResponse<R[]> | undefined;
    epoch: number;
    records: R[];
    nextPage: number;
    loadingMore: boolean;
    moreError: unknown;
    exhausted: boolean;
};

function emptyExtraState<R>(
    identity: string,
    baseData: QueryResponse<R[]> | undefined,
    epoch: number,
): ExtraChunkState<R> {
    return {
        identity,
        baseData,
        epoch,
        records: [],
        nextPage: 2,
        loadingMore: false,
        moreError: undefined,
        exhausted: false,
    };
}

function buildChunkQuery<Q extends QueryWithOptions>(
    query: Q,
    page: number,
    skipCount: boolean,
): Q {
    return {
        ...query,
        options: {
            ...query.options!,
            page,
            pageSize: ALL_RECORDS_CHUNK_SIZE,
            skipCount,
        },
    };
}

export type DatabaseListQueryResult<R> = {
    records: R[];
    /** The display mode that `records` belong to (follows the debounced snapshot when debounced). */
    recordsMode: ListDisplayMode;
    count: number | null | undefined;
    isLoading: boolean;
    isLoadingMore: boolean;
    error: unknown;
    boundReachedWithMore: boolean;
    loadMore: () => void;
    retry: () => void;
    scrollViewportRef: RefObject<HTMLDivElement | null>;
};

/**
 * Shared owner for Library database list queries (games, players, tournaments) in both paged
 * and continuous "All" modes.
 *
 * - Keeps the first page / first chunk as an SWR entry matching `refreshDatabaseGameQueries`'s
 *   key shape (`[kind, file, ...]`), with `shouldRetryOnError: false`.
 * - Runs both first-chunk and later-chunk requests through `useNativeRequestOwner` so unmount,
 *   identity changes, and first-chunk revalidations abort in-flight work.
 * - Uses a monotonic load epoch so a later chunk (result or rejection) from an older epoch is
 *   dropped even if the underlying request ignores abort.
 */
export function useDatabaseListQuery<R extends { id: number }, Q extends QueryWithOptions>({
    kind,
    file,
    query,
    mode,
    generation,
    debounceMs = 0,
    fetchPage,
}: {
    kind: DatabaseListKind;
    file: DatabaseHandle;
    query: Q;
    mode: ListDisplayMode;
    generation?: string;
    debounceMs?: number;
    fetchPage: (
        file: DatabaseHandle,
        query: Q,
        options: { signal: AbortSignal },
    ) => Promise<QueryResponse<R[]>>;
}): DatabaseListQueryResult<R> {
    // Mode and query travel as one snapshot so a mode switch debounces once alongside the query.
    const snapshot = useMemo(() => ({ query, mode }), [query, mode]);
    const [debouncedSnapshot] = useDebouncedValue(snapshot, debounceMs);
    const active = debounceMs > 0 ? debouncedSnapshot : snapshot;

    const effectiveFirstQuery = useMemo(
        () => (active.mode === "all" ? buildChunkQuery(active.query, 1, false) : active.query),
        [active],
    );

    const requestKey = useMemo(() => {
        if (active.mode === "all") {
            return generation
                ? ([kind, file, effectiveFirstQuery, "all", generation] as const)
                : ([kind, file, effectiveFirstQuery, "all"] as const);
        }
        return generation
            ? ([kind, file, effectiveFirstQuery, generation] as const)
            : ([kind, file, effectiveFirstQuery] as const);
    }, [kind, file, effectiveFirstQuery, active.mode, generation]);

    const identity = useMemo(() => unstable_serialize(requestKey), [requestKey]);
    const laterOwnerKey = useMemo(
        () => (active.mode === "all" ? ([requestKey, "chunks"] as const) : null),
        [active.mode, requestKey],
    );

    const firstChunkOwner = useNativeRequestOwner(requestKey);
    const laterChunkOwner = useNativeRequestOwner(laterOwnerKey);

    const scrollViewportRef = useRef<HTMLDivElement | null>(null);
    const epochRef = useRef(0);
    const identityRef = useRef(identity);
    const inFlightChunkRef = useRef(false);
    const laterChunkOwnerRef = useRef(laterChunkOwner);
    laterChunkOwnerRef.current = laterChunkOwner;

    const [extraState, setExtraState] = useState<ExtraChunkState<R>>(() =>
        emptyExtraState(identity, undefined, 0),
    );

    const beginNewEpoch = useCallback(() => {
        epochRef.current += 1;
        inFlightChunkRef.current = false;
        void laterChunkOwnerRef.current?.supersede();
        return epochRef.current;
    }, []);

    const clearExtraState = useCallback(
        (targetIdentity: string, targetData: QueryResponse<R[]> | undefined, nextEpoch: number) => {
            setExtraState((prev) => {
                if (
                    prev.records.length === 0 &&
                    !prev.loadingMore &&
                    prev.moreError === undefined &&
                    !prev.exhausted &&
                    prev.nextPage === 2
                ) {
                    return prev;
                }
                return emptyExtraState(targetIdentity, targetData, nextEpoch);
            });
        },
        [],
    );

    const {
        data,
        error: rawFirstError,
        isLoading,
        isValidating,
        mutate,
    } = useSWR(
        requestKey,
        () => {
            // Supersede any in-flight later chunk without wiping already-loaded rows; the
            // identity/data effect clears accumulated chunks only if `data` actually changes.
            beginNewEpoch();
            setExtraState((prev) => (prev.loadingMore ? { ...prev, loadingMore: false } : prev));
            return firstChunkOwner!.run((signal) =>
                fetchPage(file, effectiveFirstQuery, { signal }),
            );
        },
        { shouldRetryOnError: false },
    );

    const prevIdentityRef = useRef(identity);
    const prevDataRef = useRef(data);

    useEffect(() => {
        const identityChanged = prevIdentityRef.current !== identity;
        const dataChanged = prevDataRef.current !== data;
        if (!identityChanged && !dataChanged) return;
        prevIdentityRef.current = identity;
        prevDataRef.current = data;
        identityRef.current = identity;
        const nextEpoch = beginNewEpoch();
        clearExtraState(identity, data, nextEpoch);
        if (identityChanged) {
            scrollViewportRef.current?.scrollTo?.({ top: 0 });
        }
    }, [identity, data, beginNewEpoch, clearExtraState]);

    useEffect(
        () => () => {
            beginNewEpoch();
        },
        [beginNewEpoch],
    );

    const firstFailure = failureUnlessCancelled(rawFirstError);
    const firstRecords = useMemo(
        () => (firstFailure ? [] : (data?.data ?? [])),
        [firstFailure, data],
    );
    const count = firstFailure ? undefined : data?.count;

    const activeExtra =
        active.mode === "all" &&
        !firstFailure &&
        extraState.identity === identity &&
        extraState.baseData === data
            ? extraState
            : null;

    const records = useMemo(() => {
        if (active.mode !== "all") return firstRecords;
        if (!activeExtra || activeExtra.records.length === 0) {
            return firstRecords.length > ALL_RECORDS_MAX_ROWS
                ? firstRecords.slice(0, ALL_RECORDS_MAX_ROWS)
                : firstRecords;
        }
        const combined = [...firstRecords, ...activeExtra.records];
        return combined.length > ALL_RECORDS_MAX_ROWS
            ? combined.slice(0, ALL_RECORDS_MAX_ROWS)
            : combined;
    }, [active.mode, firstRecords, activeExtra]);

    const moreFailure =
        active.mode === "all" ? failureUnlessCancelled(activeExtra?.moreError) : undefined;
    const isLoadingMore = active.mode === "all" && (activeExtra?.loadingMore ?? false);

    const hasMore =
        active.mode === "all" &&
        !firstFailure &&
        !isLoading &&
        data !== undefined &&
        records.length < ALL_RECORDS_MAX_ROWS &&
        firstRecords.length >= ALL_RECORDS_CHUNK_SIZE &&
        !(activeExtra?.exhausted ?? false) &&
        (typeof count !== "number" || records.length < count);

    const boundReachedWithMore =
        active.mode === "all" &&
        !firstFailure &&
        records.length >= ALL_RECORDS_MAX_ROWS &&
        (count == null || count > records.length);

    const loadMoreInternal = useCallback(
        (allowAfterError: boolean) => {
            if (active.mode !== "all") return;
            if (!hasMore || isValidating || inFlightChunkRef.current) return;
            if (!allowAfterError && moreFailure !== undefined) return;
            const owner = laterChunkOwnerRef.current;
            if (!owner) return;

            const requestEpoch = epochRef.current;
            const requestIdentity = identity;
            const requestBaseData = data;
            const page = activeExtra?.nextPage ?? 2;
            const currentLength = records.length;

            inFlightChunkRef.current = true;
            setExtraState((prev) => {
                const base =
                    prev.identity === requestIdentity && prev.baseData === requestBaseData
                        ? prev
                        : emptyExtraState<R>(requestIdentity, requestBaseData, requestEpoch);
                return {
                    ...base,
                    epoch: requestEpoch,
                    loadingMore: true,
                    moreError: undefined,
                };
            });

            const chunkQuery = buildChunkQuery(active.query, page, true);
            void owner
                .run((signal) => fetchPage(file, chunkQuery, { signal }))
                .then(
                    (response) => {
                        if (
                            requestEpoch !== epochRef.current ||
                            requestIdentity !== identityRef.current
                        ) {
                            return;
                        }
                        inFlightChunkRef.current = false;
                        const remaining = Math.max(0, ALL_RECORDS_MAX_ROWS - currentLength);
                        const appended =
                            response.data.length > remaining
                                ? response.data.slice(0, remaining)
                                : response.data;
                        const exhausted = response.data.length < ALL_RECORDS_CHUNK_SIZE;
                        setExtraState((prev) => {
                            if (
                                prev.identity !== requestIdentity ||
                                prev.baseData !== requestBaseData ||
                                prev.epoch !== requestEpoch
                            ) {
                                return prev;
                            }
                            return {
                                ...prev,
                                records: [...prev.records, ...appended],
                                nextPage: page + 1,
                                loadingMore: false,
                                moreError: undefined,
                                exhausted,
                            };
                        });
                    },
                    (cause) => {
                        if (
                            requestEpoch !== epochRef.current ||
                            requestIdentity !== identityRef.current
                        ) {
                            return;
                        }
                        inFlightChunkRef.current = false;
                        const visible = failureUnlessCancelled(cause);
                        setExtraState((prev) => {
                            if (
                                prev.identity !== requestIdentity ||
                                prev.baseData !== requestBaseData ||
                                prev.epoch !== requestEpoch
                            ) {
                                return prev;
                            }
                            return {
                                ...prev,
                                loadingMore: false,
                                moreError: visible,
                            };
                        });
                    },
                );
        },
        [
            active,
            hasMore,
            isValidating,
            moreFailure,
            identity,
            data,
            activeExtra,
            records.length,
            fetchPage,
            file,
        ],
    );

    const loadMore = useCallback(() => {
        loadMoreInternal(false);
    }, [loadMoreInternal]);

    const retry = useCallback(() => {
        if (firstFailure !== undefined) {
            void mutate();
            return;
        }
        if (moreFailure !== undefined) {
            loadMoreInternal(true);
        }
    }, [firstFailure, moreFailure, mutate, loadMoreInternal]);

    const autoFillRef = useRef({
        canLoad: false,
        loadMore,
    });
    autoFillRef.current = {
        canLoad:
            hasMore && !isLoading && !isValidating && !isLoadingMore && moreFailure === undefined,
        loadMore,
    };

    // Fill a short viewport when a chunk appends rows, identity/first-chunk data changes, or SWR
    // finishes revalidating a cache hit (`isValidating` is never toggled by later chunks).
    useEffect(() => {
        if (active.mode !== "all" || records.length === 0) return;
        if (!autoFillRef.current.canLoad) return;
        const viewport = scrollViewportRef.current;
        if (!viewport || viewport.clientHeight <= 0) return;
        if (viewport.scrollHeight <= viewport.clientHeight + viewport.scrollTop + 1) {
            autoFillRef.current.loadMore();
        }
    }, [active.mode, identity, data, isValidating, records.length]);

    return {
        records,
        recordsMode: active.mode,
        count,
        isLoading,
        isLoadingMore,
        error: firstFailure ?? moreFailure,
        boundReachedWithMore,
        loadMore,
        retry,
        scrollViewportRef,
    };
}
