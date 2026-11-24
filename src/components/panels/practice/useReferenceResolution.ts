import { useAtomValue } from "jotai";
import { useRef } from "react";
import type { CollectionDescriptor, DatabaseHandle } from "@/bindings";
import { referenceDbAtom } from "@/state/atoms";
import { currentCollectionDatabase, useCollectionCurrency } from "@/state/linkedCollections";
import { capabilityKey } from "@/utils/pathCapabilities";

export type ReferenceResolution = {
    selectedReference: DatabaseHandle | null;
    selectedReferenceKey: string | null;
    referenceDb: DatabaseHandle | null;
    referenceKey: string | null;
    currencyGeneration: CollectionDescriptor["generation"] | undefined;
    currencyStatus: CollectionDescriptor["status"] | undefined;
    currencyError: unknown;
    currencyPending: boolean;
};

/**
 * The Practice panel and the Train-openings entry resolve the selected reference the same way:
 * the linked collection's current database when it is ready, otherwise the selected handle, and
 * null while that is still being checked, failed, or not ready.
 */
export function useReferenceResolution(): ReferenceResolution {
    const selectedReference = useAtomValue(referenceDbAtom);
    const selectedReferenceKey = selectedReference ? capabilityKey(selectedReference) : null;
    const currency = useCollectionCurrency(selectedReference);
    const resolvedReference = currentCollectionDatabase(selectedReference, currency);
    const referenceKey = resolvedReference ? capabilityKey(resolvedReference) : null;
    const referenceHandle = useRef(resolvedReference);
    if (
        (referenceHandle.current ? capabilityKey(referenceHandle.current) : null) !== referenceKey
    ) {
        referenceHandle.current = resolvedReference;
    }
    return {
        selectedReference,
        selectedReferenceKey,
        referenceDb: referenceHandle.current,
        referenceKey,
        currencyGeneration: currency.collection?.generation,
        currencyStatus: currency.collection?.status,
        currencyError: currency.error,
        currencyPending: currency.pending,
    };
}
