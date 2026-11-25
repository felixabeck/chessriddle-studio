import { z } from "zod";

export const RESTORE_OPEN_TABS_KEY = "restore-open-tabs-at-start";
const restoreOpenTabsSchema = z.boolean();

/**
 * Reads the restore-open-tabs preference directly from `localStorage` without importing or
 * initializing any renderer state or path-owner snapshot. Read or parse failures default to `true`.
 */
export function readRestoreOpenTabsPreference(
    storage: Pick<Storage, "getItem"> = localStorage,
): boolean {
    try {
        const raw = storage.getItem(RESTORE_OPEN_TABS_KEY);
        if (raw === null) return true;
        const parsed = restoreOpenTabsSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : true;
    } catch {
        return true;
    }
}
