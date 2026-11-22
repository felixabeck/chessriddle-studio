import useSWR, { type ScopedMutator, type SWRConfiguration } from "swr";
import { useEffect, useState } from "react";
import { listingFailure } from "@/components/files/listingFailure";
import { type NativeRequestOwner, useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { type DatabaseList, getDatabases } from "@/utils/db";
import { getDefaultStore } from "jotai";
import {
    fileWorkspaceAtom,
    referenceDbAtom,
    reconcileReferenceCollectionAtom,
} from "@/state/atoms";

export const DATABASE_LIST_KEY = "databases" as const;
export const DATABASE_LIST_MAX_RETRIES = 3;
export const DATABASE_LIST_TRANSIENT_REFRESH_INTERVAL_MS = 3000;

let latestReferenceListing: object | undefined;

/** One read of the listing. Only the read started last reconciles the reference collection. */
async function readDatabaseList(signal?: AbortSignal) {
    const listing = {};
    latestReferenceListing = listing;
    const store = getDefaultStore();
    const workspace = store.get(fileWorkspaceAtom);
    const reference = store.get(referenceDbAtom);
    const result = await getDatabases({ signal });
    if (!signal?.aborted && latestReferenceListing === listing && result.collections) {
        store.set(reconcileReferenceCollectionAtom, {
            workspace,
            reference,
            collections: result.collections,
        });
    }
    return result;
}

export function fetchDatabaseList(owner: NativeRequestOwner) {
    return owner.run((signal) => readDatabaseList(signal));
}

/** The latest publication of each cache. The next one starts only once it has settled. */
const publications = new WeakMap<ScopedMutator, Promise<unknown>>();

async function publishOnce(mutate: ScopedMutator) {
    try {
        for (;;) {
            let written = false;
            const listing = await mutate(DATABASE_LIST_KEY, readDatabaseList(), {
                revalidate: false,
                populateCache: (result: DatabaseList) => {
                    written = true;
                    return result;
                },
            });
            if (written) return listing;
            // SWR dropped the result because another mutation of the key began during the read.
            // That one may still be pending, or fail, so the listing is read again; each further
            // read answers one more mutation that someone else began meanwhile.
        }
    } catch (cause) {
        void mutate(DATABASE_LIST_KEY);
        throw cause;
    }
}

/**
 * Reads the listing and publishes it, for work that outlives the components that read it: the
 * cache is written whether or not a reader is mounted. It settles only once its own listing is
 * in the cache, and SWR drops every revalidation started before that read ended, so the cache
 * then holds no listing older than this call. Publications of one cache run one after another.
 * A failed read publishes nothing and is thrown, after mounted readers were asked to read for
 * themselves and show their own failure.
 */
export function publishDatabaseList(mutate: ScopedMutator) {
    const previous = publications.get(mutate) ?? Promise.resolve();
    const publication = previous.then(() => publishOnce(mutate));
    publications.set(
        mutate,
        publication.catch(() => undefined),
    );
    return publication;
}

export async function refreshDatabaseList(owner: NativeRequestOwner, mutate: ScopedMutator) {
    await owner.supersede();
    return mutate(DATABASE_LIST_KEY, fetchDatabaseList(owner));
}

export async function revalidateDatabaseList(owner: NativeRequestOwner, mutate: ScopedMutator) {
    await owner.supersede();
    return mutate(DATABASE_LIST_KEY);
}

export const databaseListRetry: NonNullable<SWRConfiguration["onErrorRetry"]> = (
    error,
    _key,
    config,
    revalidate,
    { retryCount },
) => {
    // Keep SWR's backoff for transient failures and bound it to three retries.
    if (listingFailure(error) !== "retry" || retryCount > DATABASE_LIST_MAX_RETRIES) return;
    const delay =
        ~~((Math.random() + 0.5) * (1 << (retryCount < 8 ? retryCount : 8))) *
        config.errorRetryInterval;
    setTimeout(() => void revalidate({ retryCount }), delay);
};

export function useDatabaseList(enabled = true) {
    const owner = useNativeRequestOwner(enabled ? DATABASE_LIST_KEY : null);
    const [refreshInterval, setRefreshInterval] = useState(0);
    const swr = useSWR(
        enabled ? DATABASE_LIST_KEY : null,
        async () => {
            await owner!.supersede();
            return fetchDatabaseList(owner!);
        },
        {
            onErrorRetry: databaseListRetry,
            refreshWhenHidden: true,
            refreshWhenOffline: true,
            refreshInterval,
        },
    );
    const transient = swr.data?.databases.some((row) => row.type === "error" && row.transient);
    // A zero SWR interval stops scheduling. Restart it when a later listing becomes transient.
    useEffect(() => {
        setRefreshInterval(enabled && transient ? DATABASE_LIST_TRANSIENT_REFRESH_INTERVAL_MS : 0);
    }, [enabled, transient]);
    return Object.assign(swr, { owner });
}
