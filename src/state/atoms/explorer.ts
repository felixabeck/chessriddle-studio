/** The board explorer's per-tab sources and its stored options. */
import type { SetStateAction } from "react";
import equal from "fast-deep-equal";
import { atom, type PrimitiveAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { z } from "zod";
import type { DatabaseHandle } from "@/bindings";
import type { LocalOptions } from "@/utils/db";
import {
    type LichessGamesOptions,
    lichessGamesOptionsSchema,
    type MasterGamesOptions,
    masterOptionsSchema,
} from "@/utils/lichess/explorer";
import { createPositiveRemStorage } from "../remPreference";
import { createZodStorage } from "../utils";
import { canonicalTabExplorerOptions, type Tab, type TabExplorer } from "../workspaceTypes";
import { documentPreferences } from "./rendererState";
import { tabAtomFamily } from "./tabFamilies";
import { tabsAtom, updateTabById } from "./tabs";

const DEFAULT_LOCAL_OPTIONS: LocalOptions = {
    path: null,
    type: "exact",
    fen: "",
    player: null,
    color: "white",
    result: "any",
};

const EMPTY_FURTHER_COLUMNS: ExplorerFurtherColumn[] = [];

function withTabExplorerField<K extends keyof TabExplorer>(
    tab: Tab,
    field: K,
    value: TabExplorer[K],
): Tab {
    const next: TabExplorer = { ...tab.explorer };
    if (value === undefined) {
        delete next[field];
    } else {
        next[field] = value;
    }
    if (Object.keys(next).length === 0) {
        if (tab.explorer === undefined) return tab;
        const { explorer: _removed, ...rest } = tab;
        return rest;
    }
    return { ...tab, explorer: next };
}

type TabExplorerAtomConfig<Value, K extends keyof TabExplorer> = {
    tabId: string;
    field: K;
    fallback: Value;
    toRecord: (value: Value) => TabExplorer[K];
} & (NonNullable<TabExplorer[K]> extends Value
    ? { fromRecord?: (stored: NonNullable<TabExplorer[K]>) => Value }
    : { fromRecord: (stored: NonNullable<TabExplorer[K]>) => Value });

/**
 * Per-tab explorer atom backed by the owning tab's `explorer` record in `tabsAtom`.
 * Reads the tab record until its first write, keeps in-memory edits even if a commit fails,
 * and writes through only when the tab exists and the canonical persisted member changed.
 */
function tabExplorerAtom<Value, K extends keyof TabExplorer>({
    tabId,
    field,
    fallback,
    fromRecord,
    toRecord,
}: TabExplorerAtomConfig<Value, K>): PrimitiveAtom<Value> {
    const stateAtom = atom<{ hasValue: false } | { hasValue: true; value: Value }>({
        hasValue: false,
    });
    const project =
        fromRecord ?? ((stored: NonNullable<TabExplorer[K]>) => stored as unknown as Value);
    let cachedStored: NonNullable<TabExplorer[K]> | undefined;
    let cachedValue: Value | undefined;
    const entryAtom: PrimitiveAtom<Value> = atom(
        (get) => {
            const state = get(stateAtom);
            if (state.hasValue) return state.value;
            const tab = get(tabsAtom).find((entry) => entry.value === tabId);
            const stored = tab?.explorer?.[field];
            if (stored === undefined) return fallback;
            if (stored === cachedStored && cachedValue !== undefined) return cachedValue;
            cachedStored = stored;
            cachedValue = project(stored);
            return cachedValue;
        },
        (get, set, update: SetStateAction<Value>) => {
            const current = get(entryAtom);
            const next =
                typeof update === "function" ? (update as (prev: Value) => Value)(current) : update;
            set(stateAtom, { hasValue: true, value: next });
            const tab = get(tabsAtom).find((entry) => entry.value === tabId);
            if (!tab) return;
            const nextStored = toRecord(next);
            const prevStored = tab.explorer?.[field];
            if (equal(prevStored, nextStored)) return;
            updateTabById(
                (tabsUpdate, activeTab, onSaved) => set(tabsAtom, tabsUpdate, activeTab, onSaved),
                tabId,
                (latest) => withTabExplorerField(latest, field, nextStored),
            );
        },
    );
    return entryAtom;
}

export const localOptionsFamily = tabAtomFamily((tab: string) =>
    tabExplorerAtom<LocalOptions, "options">({
        tabId: tab,
        field: "options",
        fallback: DEFAULT_LOCAL_OPTIONS,
        fromRecord: (stored) => ({ ...DEFAULT_LOCAL_OPTIONS, ...stored }),
        toRecord: canonicalTabExplorerOptions,
    }),
);

export const pinnedExplorerDatabaseFamily = tabAtomFamily((tab: string) =>
    tabExplorerAtom<DatabaseHandle | null, "pinned">({
        tabId: tab,
        field: "pinned",
        fallback: null,
        toRecord: (value) => value ?? undefined,
    }),
);

/** A second database with its own player, shown beside a tab's pinned database. */
export type PinnedExplorerComparison = { database: DatabaseHandle; player: number };

/**
 * The second column of a tab pinned to a database. It lives and ends with the pin and the tab,
 * stored on the tab record and apart from the app-wide `comparisonDbAtom`.
 */
export const pinnedExplorerComparisonFamily = tabAtomFamily((tab: string) =>
    tabExplorerAtom<PinnedExplorerComparison | null, "comparison">({
        tabId: tab,
        field: "comparison",
        fallback: null,
        toRecord: (value) => value ?? undefined,
    }),
);

/** A Lichess explorer source, stored or chosen as a column of the board's Database panel. */
export type ExplorerOnlineSource = "lch_all" | "lch_master";

/** The tab's first source: a local database, Lichess All, or Lichess Masters. */
export type ExplorerFirstSource = "local" | ExplorerOnlineSource;

/**
 * A further column of a preparation board: the reference database and each Lichess source.
 * The list lives and ends with the tab on its workspace record.
 */
export type ExplorerFurtherColumn = "reference" | ExplorerOnlineSource;

/**
 * Stable identity of a statistics column. It does not depend on which other columns are shown:
 * the first column, the second column, and one identity per further source.
 */
export type ExplorerColumnId = "primary" | "comparison" | ExplorerFurtherColumn;

/**
 * Further columns of a tab pinned to a database, in the order they were added. "Prepare on board"
 * starts it with the reference database; disposed with the tab.
 */
export const pinnedExplorerFurtherColumnsFamily = tabAtomFamily((tab: string) =>
    tabExplorerAtom<ExplorerFurtherColumn[], "further">({
        tabId: tab,
        field: "further",
        fallback: EMPTY_FURTHER_COLUMNS,
        toRecord: (value) => (value.length === 0 ? undefined : [...value]),
    }),
);

export type ExplorerGamesSourceRole = "primary" | "comparison";

/** Whose sample games the Games view lists. The switch offers the first and second column of an unpinned board, a Lichess column included. */
export const explorerGamesSourceFamily = tabAtomFamily((_tab: string) =>
    atom<ExplorerGamesSourceRole>("primary"),
);

/** The multi-source move table's sort: which source's game count, in which direction. */
export const explorerSortFamily = tabAtomFamily((_tab: string) =>
    atom<{ source: ExplorerColumnId; direction: "asc" | "desc" }>({
        source: "primary",
        direction: "desc",
    }),
);

export const DEFAULT_LICHESS_OPTIONS: LichessGamesOptions = {
    ratings: [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500],
    speeds: ["bullet", "blitz", "rapid", "classical", "correspondence"],
    color: "white",
};

export const lichessOptionsAtom = documentPreferences.atomWithStorage<LichessGamesOptions>(
    "lichess-all-options",
    DEFAULT_LICHESS_OPTIONS,
    createZodStorage(lichessGamesOptionsSchema, localStorage),
);

export const DEFAULT_MASTER_OPTIONS: MasterGamesOptions = {};

export const masterOptionsAtom = documentPreferences.atomWithStorage<MasterGamesOptions>(
    "lichess-master-options",
    DEFAULT_MASTER_OPTIONS,
    createZodStorage(masterOptionsSchema, localStorage),
);

/**
 * Whether the board explorer folds its source, position and filter controls into one caption
 * line. One preference for every tab: the sources are set up once and then only read.
 */
export const explorerHeaderCollapsedAtom = atomWithStorage<boolean>(
    "explorer-header-collapsed",
    true,
    createZodStorage(z.boolean(), localStorage),
);

export const EXPLORER_STATS_HEIGHT_KEY = "explorer-stats-height";
export const DEFAULT_EXPLORER_STATS_HEIGHT_REM = 14;
export const MIN_EXPLORER_STATS_HEIGHT_REM = 6;
export const MIN_EXPLORER_GAMES_HEIGHT_REM = 12;
export const EXPLORER_DIVIDER_HEIGHT_PX = 6; // Keep in sync with `.horizontal` height in `src/styles/ResizeHandle.module.css`.

/** Remembered height of the move-statistics section in the board's Database panel, in rem. */
export const explorerStatsHeightAtom = documentPreferences.atomWithStorage<number>(
    EXPLORER_STATS_HEIGHT_KEY,
    DEFAULT_EXPLORER_STATS_HEIGHT_REM,
    createPositiveRemStorage(localStorage),
);

export type ExplorerSplitRange = {
    statsHeightRem: number;
    minRem: number;
    maxRem: number;
    canResize: boolean;
};

/**
 * Clamps the statistics section's height to `[MIN, H - MIN_GAMES - h]` when the body fits both
 * minimums, shares the remaining height proportionally when short, and leaves an unmeasured body
 * (`H <= 0`) unclamped and non-writable.
 */
export function explorerStatsSplitRange(
    storedRem: number,
    bodyHeightRem: number,
    handleHeightRem: number,
): ExplorerSplitRange {
    if (!(bodyHeightRem > 0)) {
        return {
            statsHeightRem: storedRem,
            minRem: storedRem,
            maxRem: storedRem,
            canResize: false,
        };
    }
    const minNeeded =
        MIN_EXPLORER_STATS_HEIGHT_REM + MIN_EXPLORER_GAMES_HEIGHT_REM + handleHeightRem;
    if (bodyHeightRem >= minNeeded) {
        const minRem = MIN_EXPLORER_STATS_HEIGHT_REM;
        const maxRem = bodyHeightRem - MIN_EXPLORER_GAMES_HEIGHT_REM - handleHeightRem;
        return {
            statsHeightRem: Math.min(maxRem, Math.max(minRem, storedRem)),
            minRem,
            maxRem,
            canResize: maxRem > minRem,
        };
    }
    const remaining = Math.max(0, bodyHeightRem - handleHeightRem);
    const proportional =
        remaining *
        (MIN_EXPLORER_STATS_HEIGHT_REM /
            (MIN_EXPLORER_STATS_HEIGHT_REM + MIN_EXPLORER_GAMES_HEIGHT_REM));
    return {
        statsHeightRem: proportional,
        minRem: proportional,
        maxRem: proportional,
        canResize: false,
    };
}

export const dbTypeFamily = tabAtomFamily((tab: string) =>
    tabExplorerAtom<ExplorerFirstSource, "firstSource">({
        tabId: tab,
        field: "firstSource",
        fallback: "local",
        toRecord: (value) => (value === "local" ? undefined : value),
    }),
);
