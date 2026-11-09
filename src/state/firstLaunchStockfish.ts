import { atom, getDefaultStore } from "jotai";
import type { Platform } from "@/platform/native";
import { normalizeError, warnSafely } from "@/platform/errors";
import {
    defaultEngineProgressId,
    loadStockfishCatalogEntry,
    type DefaultEngine,
} from "@/utils/engines";
import { enginesAtom } from "./atoms";
import { installCatalogEngineJob } from "./catalogEngineCompletion";
import { enginesStorageKeyAbsent } from "./engineOwnerStorage";
import { initializePathOwners } from "./pathOwners";
import { serializeStorageValue } from "./store/debouncedStorage";

export const FIRST_LAUNCH_STOCKFISH_KEY = "first-launch-stockfish";

type AutomaticStockfishJob = { engine: DefaultEngine; progressId: string };

/** At most one document-owned automatic job, cleared on every terminal outcome. */
export const automaticStockfishJobAtom = atom<AutomaticStockfishJob | null>(null);

/** Check profile evidence before loading the catalog, then recheck it at claim time. */
function firstLaunchProfileEligible(): boolean {
    try {
        return (
            navigator.webdriver !== true &&
            localStorage.getItem(FIRST_LAUNCH_STOCKFISH_KEY) === null &&
            enginesStorageKeyAbsent()
        );
    } catch {
        return false;
    }
}

/** No await may separate the current-state checks from the durable claim. */
export function claimFirstLaunchStockfish(store = getDefaultStore()): boolean {
    try {
        const engines = store.get(enginesAtom);
        if (!firstLaunchProfileEligible() || engines === undefined || engines.length !== 0) {
            return false;
        }
        localStorage.setItem(FIRST_LAUNCH_STOCKFISH_KEY, serializeStorageValue(true));
        return true;
    } catch {
        return false;
    }
}

/** The mounting effect owns the prerequisite wait. An accepted job belongs to the document. */
export function startFirstLaunchStockfish(os: Platform | undefined, store = getDefaultStore()) {
    let active = true;
    let unsubscribe = () => {};
    let releaseWait = () => {};
    const dispose = () => {
        active = false;
        unsubscribe();
        releaseWait();
    };
    if (os === undefined || !firstLaunchProfileEligible()) return dispose;

    void (async () => {
        let automaticJob: AutomaticStockfishJob | undefined;
        try {
            const [, engine] = await Promise.all([
                initializePathOwners(),
                loadStockfishCatalogEntry(os),
            ]);
            if (!active || !engine?.downloadLink) return;
            await new Promise<void>((resolve, reject) => {
                releaseWait = resolve;
                const check = () => {
                    try {
                        if (!active || store.get(enginesAtom) !== undefined) resolve();
                    } catch (error) {
                        reject(error);
                    }
                };
                unsubscribe = store.sub(enginesAtom, check);
                check();
            });
            unsubscribe();
            if (!active || !claimFirstLaunchStockfish(store)) return;
            const progressId = defaultEngineProgressId(engine.downloadLink);
            const job = installCatalogEngineJob(engine, progressId, undefined, store);
            if (!job) return;
            automaticJob = { engine, progressId };
            store.set(automaticStockfishJobAtom, automaticJob);
            await job;
        } catch (error) {
            warnSafely(`first-launch Stockfish startup: ${normalizeError(error).message}`);
        } finally {
            unsubscribe();
            if (automaticJob && store.get(automaticStockfishJobAtom) === automaticJob) {
                store.set(automaticStockfishJobAtom, null);
            }
        }
    })();

    return dispose;
}
