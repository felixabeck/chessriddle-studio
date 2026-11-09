import { z } from "zod";
import type { SyncStorage, SyncStringStorage } from "jotai/vanilla/utils/atomWithStorage";
import type { DatabaseHandle } from "@/bindings";
import { capabilityKey } from "@/utils/pathCapabilities";
import { deserializeStorageValue, serializeStorageValue } from "./store/debouncedStorage";
import { reportPreferenceStorageFailure } from "./utils";

export const MAX_LAST_OPENED = 1000;
export type LastOpened = Record<string, number>;

export function boundLastOpened(record: LastOpened): LastOpened {
    return Object.fromEntries(
        Object.entries(record)
            .sort(([, left], [, right]) => right - left)
            .slice(0, MAX_LAST_OPENED),
    );
}

const storedLastOpenedSchema = z.object({
    version: z.literal(1),
    items: z.record(z.string().min(1).max(1024), z.number().finite().nonnegative()),
});

/** A game key contains only native authority and the database-local game id, never headers. */
export function databaseGameOpenedKey(database: DatabaseHandle, gameId: number): string {
    return JSON.stringify(["database-game", capabilityKey(database), gameId]);
}

/** One compressed, validated storage contract for both hydration and writes. */
export function createLastOpenedStorage(storage: SyncStringStorage): SyncStorage<LastOpened> {
    return {
        getItem(key, initialValue) {
            try {
                const stored = storage.getItem(key);
                if (stored === null) return initialValue;
                const parsed = storedLastOpenedSchema.safeParse(deserializeStorageValue(stored));
                return parsed.success ? boundLastOpened(parsed.data.items) : initialValue;
            } catch (error) {
                reportPreferenceStorageFailure("read", error);
                return initialValue;
            }
        },
        setItem(key, value) {
            try {
                const record = storedLastOpenedSchema.parse({
                    version: 1,
                    items: boundLastOpened(value),
                });
                storage.setItem(key, serializeStorageValue(record));
            } catch (error) {
                reportPreferenceStorageFailure("save", error);
            }
        },
        removeItem(key) {
            try {
                storage.removeItem(key);
            } catch (error) {
                reportPreferenceStorageFailure("save", error);
            }
        },
    };
}
