import { useEffect, useMemo, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import type { CollectionDescriptor, DatabaseHandle } from "@/bindings";
import { useDatabaseWriteRevision } from "@/platform/databaseWrites";
import { tauri } from "@/platform/tauri";
import { registerCollectionCheck } from "./fileFreshness";
import { capabilityKey } from "@/utils/pathCapabilities";

export function isCollectionConsumer(key: unknown) {
    return (
        key === "databases" ||
        (Array.isArray(key) &&
            ["file-workspace", "games", "players", "tournaments", "personalInfo"].includes(
                String(key[0]),
            ))
    );
}

function collectionCurrencySignature(
    collection: CollectionDescriptor | null | undefined,
    error?: unknown,
): string {
    return error
        ? "unavailable"
        : collection
          ? `${collection.status}:${collection.generation}`
          : "missing";
}

function subscribeCollectionCurrency(
    database: DatabaseHandle,
    initial: CollectionDescriptor | undefined,
    invalidate: () => void,
    receive?: (collection: CollectionDescriptor | null, error?: unknown) => void,
) {
    let signature = collectionCurrencySignature(initial);
    let outage: unknown;
    return registerCollectionCheck(capabilityKey(database), {
        read: (signal) => tauri.collectionForDatabase(database, { signal }),
        rebuild: (id) => tauri.rebuildLinkedCollection(id, false),
        receive: (collection, error) => {
            // Each subscriber retains only its current outage, until a successful read.
            outage = error ? (outage ?? error) : undefined;
            receive?.(collection, outage);
            const next = collectionCurrencySignature(collection, error);
            if (next !== signature) {
                signature = next;
                invalidate();
            }
        },
    });
}

export function useCollectionCurrencies(collections: readonly CollectionDescriptor[]) {
    const { mutate } = useSWRConfig();
    const mutateRef = useRef(mutate);
    mutateRef.current = mutate;
    const inputs = useRef(collections);
    inputs.current = collections;
    const key = collections
        .map(
            (collection) =>
                `${collection.id}:${collection.database ? capabilityKey(collection.database) : ""}`,
        )
        .join(",");
    useEffect(() => {
        if (!key) return;
        const cleanups = inputs.current.flatMap((collection) => {
            const database = collection.database;
            if (!database || collection.status === "retired") return [];
            return [
                subscribeCollectionCurrency(database, collection, () => {
                    void mutateRef.current(isCollectionConsumer);
                }),
            ];
        });
        return () => cleanups.forEach((cleanup) => cleanup());
    }, [key]);
}

export function useCollectionCurrency(
    file: DatabaseHandle | null | undefined,
    initial?: CollectionDescriptor,
) {
    const { mutate } = useSWRConfig();
    const mutateRef = useRef(mutate);
    mutateRef.current = mutate;
    const key = file ? capabilityKey(file) : null;
    const inputs = useRef({ file, initial });
    inputs.current = { file, initial };
    const [snapshot, setSnapshot] = useState<{
        key: string | null;
        collection: CollectionDescriptor | null;
        error?: unknown;
        pending: boolean;
    }>({ key, collection: initial ?? null, pending: !!file });
    useEffect(() => {
        const { file, initial } = inputs.current;
        if (!file || !key) {
            setSnapshot((current) =>
                current.key === key &&
                current.collection === null &&
                !current.pending &&
                current.error === undefined
                    ? current
                    : { key, collection: null, pending: false },
            );
            return;
        }
        setSnapshot({ key, collection: initial ?? null, pending: true });
        return subscribeCollectionCurrency(
            file,
            initial,
            () => {
                void mutateRef.current(isCollectionConsumer);
            },
            (collection, error) => {
                setSnapshot({ key, collection, error, pending: false });
            },
        );
    }, [key, initial?.id]);
    return snapshot.key === key ? snapshot : { key, collection: null, pending: !!file };
}

/**
 * The database a chosen one stands for now: the database its linked collection currently
 * publishes, or the chosen one itself when it belongs to no collection. `null` while that is being
 * checked, could not be checked, or the collection is not ready.
 */
export function currentCollectionDatabase(
    selected: DatabaseHandle | null,
    currency: Pick<ReturnType<typeof useCollectionCurrency>, "collection" | "pending"> & {
        error?: unknown;
    },
): DatabaseHandle | null {
    const { collection } = currency;
    if (currency.pending || currency.error) return null;
    if (collection && (collection.status !== "ready" || !collection.database)) return null;
    return collection?.database ?? selected;
}

/** Content identity of a database for read caches: the linked collection's generation plus this
 * renderer's write revision. `revision` is null while the collection lookup is pending, so a
 * consumer never keys a read on a generation it has not observed yet. */
export function useDatabaseContentRevision(file: DatabaseHandle | null | undefined): {
    revision: readonly [generation: string | null, writes: number] | null;
    unavailable: boolean;
} {
    const currency = useCollectionCurrency(file);
    const writes = useDatabaseWriteRevision(file);
    const unavailable =
        !!currency.error || (!!currency.collection && currency.collection.status !== "ready");
    const generation = currency.collection?.generation ?? null;
    const revision = useMemo(
        () => (currency.pending ? null : ([generation, writes] as const)),
        [currency.pending, generation, writes],
    );
    return { revision, unavailable };
}
