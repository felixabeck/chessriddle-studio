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
 * Not persisted and not part of the URL; consumed once when Settings is shown.
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
