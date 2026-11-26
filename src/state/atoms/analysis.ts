/** Engine analysis: score display, per-tab engine results and settings, and best-move arrows. */
import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import type { BestMoves, EngineTerminalSnapshot } from "@/bindings";
import { analysisSearch } from "@/utils/analysisSearch";
import { AnalysisLineMemory } from "@/utils/analysisLineMemory";
import { getWinChance, normalizeScore } from "@/utils/score";
import { projectAnalysisSettings, type AnalysisSettings } from "../analysisSettings";
import { enginesAtom } from "./engineOwners";
import { tabAtomFamily, tabEngineAtomFamily } from "./tabFamilies";

export const reportTypeAtom = atom<"CP" | "WDL">("CP");

export const scoreTypeFamily = atomFamily((_engine: string) => atom<"cp" | "wdl">("cp"));

export const threatFamily = tabAtomFamily((_tab: string) => atom(false));

export const expandedEnginesFamily = tabAtomFamily((_tab: string) =>
    atom<string[] | undefined>(undefined),
);

export const engineMovesFamily = tabEngineAtomFamily("engine", () =>
    atom<Map<string, BestMoves[]>>(new AnalysisLineMemory()),
);

export const engineProgressFamily = tabEngineAtomFamily("engine", () => atom<number>(0));

export type AnalysisTerminal = {
    searchedKey: string;
    context: string;
    fingerprint: string;
    engineIdentity: string;
    generation: string | null;
    retry: number;
} & (
    | { type: "completed-without-lines" }
    | { type: "not-in-database" }
    | {
          type: "failed";
          snapshot?: EngineTerminalSnapshot;
          message?: string;
          cleanupFailed?: boolean;
      }
);

/** One ephemeral terminal outcome for the owned engine's current attempt. */
export const engineTerminalFamily = tabEngineAtomFamily("engine", () =>
    atom<AnalysisTerminal | null>(null),
);

export const engineRetryFamily = tabEngineAtomFamily("engine", () => atom(0));

const BEST_MOVE_ARROW_MAX_WIN_CHANCE_LOSS = 10; // win-chance percentage points

type BestMoveArrows = Map<number, { pv: string[]; winChance: number }[]>;

function equalBestMoveArrows(previous: BestMoveArrows, next: BestMoveArrows): boolean {
    if (previous.size !== next.size) return false;
    const entries = previous.entries();
    for (const [key, lines] of next) {
        const entry = entries.next().value;
        if (!entry || entry[0] !== key || entry[1].length !== lines.length) return false;
        for (let i = 0; i < lines.length; i++) {
            const before = entry[1][i];
            const after = lines[i];
            if (
                before.winChance !== after.winChance ||
                before.pv.length !== after.pv.length ||
                !before.pv.every((move, index) => move === after.pv[index])
            )
                return false;
        }
    }
    return true;
}

/** Returns each engine's best moves for the current position. Callers must memoize the result. */
export const createBestMovesAtom = (tab: string, fen: string, gameMoves: string[]) => {
    let previous: BestMoveArrows = new Map();
    const reuse = (next: BestMoveArrows) => {
        if (!equalBestMoveArrows(previous, next)) previous = next;
        return previous;
    };
    return atom<BestMoveArrows>((get) => {
        const engines = get(enginesAtom);
        if (!engines) return reuse(new Map());
        const bestMoves: BestMoveArrows = new Map();
        const search = analysisSearch(fen, gameMoves, get(threatFamily(tab)));
        if (!search.available) return reuse(bestMoves);
        const { searchingTurn, key } = search;
        let n = 0;
        for (const engine of engines.filter((e) => e.loaded)) {
            const engineMoves = get(engineMovesFamily({ tab, engine: engine.id }));
            const moves = engineMoves.get(key);
            if (moves && moves.length > 0) {
                const bestWinChange = getWinChance(
                    normalizeScore(moves[0].score.value, searchingTurn),
                );
                bestMoves.set(
                    n,
                    moves.reduce<{ pv: string[]; winChance: number }[]>((acc, m) => {
                        const winChance = getWinChance(
                            normalizeScore(m.score.value, searchingTurn),
                        );
                        if (bestWinChange - winChance < BEST_MOVE_ARROW_MAX_WIN_CHANCE_LOSS) {
                            acc.push({ pv: m.uciMoves, winChance });
                        }
                        return acc;
                    }, []),
                );
            }
            n++;
        }
        return reuse(bestMoves);
    });
};

/**
 * A tab's analysis settings for one engine. While `synced`, reads project the engine's own settings
 * and go mode, so the stored defaults matter only once the tab unsyncs, and the unsync write copies
 * the projected value in.
 */
export const tabEngineSettingsFamily = tabEngineAtomFamily("engineId", ({ engineId }) => {
    const local = atom<AnalysisSettings>({
        enabled: false,
        settings: [],
        go: { t: "Infinite" },
        synced: true,
    });
    const effective = atom(
        (get) => {
            const settings = get(local);
            const engine = get(enginesAtom)?.find((item) => item.id === engineId);
            return projectAnalysisSettings(settings, engine);
        },
        (
            get,
            set,
            update: AnalysisSettings | ((current: AnalysisSettings) => AnalysisSettings),
        ) => {
            set(local, typeof update === "function" ? update(get(effective)) : update);
        },
    );
    return effective;
});

/** Gives tab `to` the analysis settings tab `from` holds for every configured engine. */
export const copyTabEngineSettingsAtom = atom(
    null,
    (get, set, { from, to }: { from: string; to: string }) => {
        for (const engine of get(enginesAtom) ?? []) {
            const source = tabEngineSettingsFamily({ tab: from, engineId: engine.id });
            set(tabEngineSettingsFamily({ tab: to, engineId: engine.id }), get(source));
        }
    },
);

export const allEnabledFamily = tabAtomFamily((tab: string) =>
    atom((get) => {
        const engines = get(enginesAtom);
        if (!engines) return false;

        const v = engines
            .filter((e) => e.loaded)
            .every((engine) => {
                const atom = tabEngineSettingsFamily({ tab, engineId: engine.id });
                return get(atom).enabled;
            });

        return v;
    }),
);

export const enableAllFamily = tabAtomFamily((tab: string) =>
    atom(null, (get, set, value: boolean) => {
        const engines = get(enginesAtom);
        if (!engines) return;

        for (const engine of engines.filter((e) => e.loaded)) {
            const atom = tabEngineSettingsFamily({ tab, engineId: engine.id });
            set(atom, { ...get(atom), enabled: value });
        }
    }),
);
