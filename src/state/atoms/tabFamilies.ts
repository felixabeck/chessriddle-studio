/** The registry of tab-scoped atom families and their release when a tab closes. */
import type { Atom } from "jotai";
import { atomFamily } from "jotai/utils";
import { chessRiddleTrainingSessions } from "../chessRiddleTraining";

const tabDisposers = new Set<(tabId: string) => void>();

/** Registers a module-owned cleanup callback to run when a tab closes. */
export function registerTabDisposer(dispose: (tabId: string) => void): void {
    tabDisposers.add(dispose);
}

/**
 * A runtime atom family whose entries belong to one tab. Every such family is declared through
 * `tabAtomFamily` or `tabEngineAtomFamily`, which register it here, so `disposeTabAtoms` releases
 * it when the tab closes without a second hand-kept list.
 */
type TabScopedFamily = {
    readonly family: object;
    /** Creates the entry for `tab` (and `engine`, for per-engine families). */
    create(tab: string, engine: string): Atom<unknown>;
    has(tab: string): boolean;
    dispose(tab: string): void;
};

const tabScopedFamilies: TabScopedFamily[] = [];

/** Read-only view for the lifecycle test that proves every registered family is released. */
export const registeredTabAtomFamilies: readonly TabScopedFamily[] = tabScopedFamilies;

export function tabAtomFamily<AtomType extends Atom<unknown>>(init: (tab: string) => AtomType) {
    const family = atomFamily(init);
    tabScopedFamilies.push({
        family,
        create: (tab) => family(tab),
        has: (tab) => Array.from(family.getParams()).includes(tab),
        dispose: (tab) => family.remove(tab),
    });
    return family;
}

/** A family keyed by `{ tab, [engineKey]: engine id }`; closing the tab releases every engine's entry. */
export function tabEngineAtomFamily<EngineKey extends string, AtomType extends Atom<unknown>>(
    engineKey: EngineKey,
    init: (param: { tab: string } & Record<EngineKey, string>) => AtomType,
) {
    type Param = { tab: string } & Record<EngineKey, string>;
    const family = atomFamily(
        init,
        (a: Param, b: Param) => a.tab === b.tab && a[engineKey] === b[engineKey],
    );
    const owned = (tab: string) =>
        Array.from(family.getParams()).filter((param) => param.tab === tab);
    tabScopedFamilies.push({
        family,
        create: (tab, engine) => family({ tab, [engineKey]: engine } as Param),
        has: (tab) => owned(tab).length > 0,
        dispose: (tab) => {
            for (const param of owned(tab)) family.remove(param);
        },
    });
    return family;
}

/** Remove every runtime atom whose identity is a closed tab, including per-engine entries. */
export function disposeTabAtoms(tabId: string) {
    chessRiddleTrainingSessions.remove(tabId);
    for (const dispose of tabDisposers) dispose(tabId);
    for (const family of tabScopedFamilies) family.dispose(tabId);
}
