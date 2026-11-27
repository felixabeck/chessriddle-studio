import { atom, getDefaultStore } from "jotai";
import type { SettingCategory, SettingId } from "@/components/settings/settingsDescription";

export type SettingsNavigationTarget =
    | { kind: "category"; category: SettingCategory }
    | { kind: "setting"; settingId: SettingId };

export interface SettingsNavigationRequest {
    readonly id: number;
    readonly target: SettingsNavigationTarget;
}

type JotaiStore = ReturnType<typeof getDefaultStore>;

let nextRequestId = 1;

/**
 * In-memory one-shot request for Settings to select a category or reveal a setting row.
 * Not persisted; consumed once when Settings is shown and then written into the route search.
 */
export const settingsNavigationRequestAtom = atom<SettingsNavigationRequest | null>(null);

/**
 * Records a one-shot request to open Settings at a category or setting.
 * Any unconsumed earlier request is replaced.
 */
export function requestSettingsNavigation(
    target: SettingsNavigationTarget,
    store: JotaiStore = getDefaultStore(),
): SettingsNavigationRequest {
    const request: SettingsNavigationRequest = { id: nextRequestId++, target };
    store.set(settingsNavigationRequestAtom, request);
    return request;
}

export type SettingsScrollKey =
    | { mode: "category"; category: SettingCategory }
    | { mode: "search"; q: string };

const MAX_SCROLL_ENTRIES = 64;

let scrollGeneration = 0;
const scrollOffsets = new Map<string, number>();

export function settingsScrollKeyId(key: SettingsScrollKey): string {
    return key.mode === "search" ? `search:${key.q}` : `category:${key.category}`;
}

export function getSettingsScrollGeneration(): number {
    return scrollGeneration;
}

export function readSettingsScroll(key: SettingsScrollKey): number | undefined {
    return scrollOffsets.get(settingsScrollKeyId(key));
}

export function recordSettingsScroll(key: SettingsScrollKey, y: number, generation: number): void {
    if (generation !== scrollGeneration) return;
    if (!Number.isFinite(y) || y < 0) return;
    const id = settingsScrollKeyId(key);
    scrollOffsets.delete(id);
    scrollOffsets.set(id, y);
    if (scrollOffsets.size > MAX_SCROLL_ENTRIES) {
        const oldest = scrollOffsets.keys().next().value;
        if (oldest !== undefined) scrollOffsets.delete(oldest);
    }
}

export function clearSettingsScrollKey(key: SettingsScrollKey): void {
    scrollOffsets.delete(settingsScrollKeyId(key));
}

/**
 * Clears all remembered Settings scroll offsets and invalidates writes from any still-mounted
 * SettingsPage until a new mount captures the updated generation.
 */
export function clearSettingsScroll(): void {
    scrollOffsets.clear();
    scrollGeneration += 1;
}
