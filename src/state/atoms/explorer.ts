/** The board explorer's per-tab sources and its stored options and pinned strip. */
import { atom } from "jotai";
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
import { createZodStorage } from "../utils";
import { PINNED_PLACEMENTS, type PinnedPlacement } from "./boardPanels";
import { documentPreferences } from "./rendererState";
import { tabAtomFamily } from "./tabFamilies";

export const localOptionsFamily = tabAtomFamily((_tab: string) =>
    atom<LocalOptions>({
        path: null,
        type: "exact",
        fen: "",
        player: null,
        color: "white",
        result: "any",
    }),
);

export const pinnedExplorerDatabaseFamily = tabAtomFamily((_tab: string) =>
    atom<DatabaseHandle | null>(null),
);

/** A second database with its own player, shown beside a tab's pinned database. */
export type PinnedExplorerComparison = { database: DatabaseHandle; player: number };

/**
 * The second column of a tab pinned to a database. It lives and ends with the pin: it is the
 * tab's own, never stored, and apart from the app-wide `comparisonDbAtom`.
 */
export const pinnedExplorerComparisonFamily = tabAtomFamily((_tab: string) =>
    atom<PinnedExplorerComparison | null>(null),
);

/** A Lichess explorer source, stored or chosen as a column of the board's Database panel. */
export type ExplorerOnlineSource = "lch_all" | "lch_master";

/** The tab's first source: a local database, Lichess All, or Lichess Masters. */
export type ExplorerFirstSource = "local" | ExplorerOnlineSource;

/**
 * A further column of a preparation board: the reference database and each Lichess source.
 * The list lives and ends with the tab; it is never stored.
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
export const pinnedExplorerFurtherColumnsFamily = tabAtomFamily((_tab: string) =>
    atom<ExplorerFurtherColumn[]>([]),
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

/**
 * Whether the board explorer is pinned as a strip instead of being one of the panel tabs; where
 * it sits is `explorerPlacementAtom`. Called detached like the engine bar:
 * `pinnedExplorerDatabaseFamily` is a tab's own database, not this.
 */
export const explorerDetachedAtom = atomWithStorage<boolean>(
    "detached-explorer",
    false,
    createZodStorage(z.boolean(), localStorage),
);

/** Where the pinned explorer strip sits. */
export const explorerPlacementAtom = atomWithStorage<PinnedPlacement>(
    "detached-explorer-placement",
    "tabs",
    createZodStorage(z.enum(PINNED_PLACEMENTS), localStorage),
);

/**
 * A dragged explorer strip's height in pixels; anything else is dropped. Heights were once stored
 * as a share of the pane (at most 1), so a value of 1 or less is such a share and is dropped too.
 */
const stripPixels = z.number().finite().gt(1).optional().catch(undefined);

/**
 * The pinned explorer strip's dragged height per place, in pixels, so resizing the pane around it
 * leaves it alone. A place without a height sizes the strip to its content; an unreadable height
 * is dropped on its own.
 */
export const explorerStripHeightsAtom = atomWithStorage<Partial<Record<PinnedPlacement, number>>>(
    "detached-explorer-heights",
    {},
    createZodStorage(
        z.object({
            tabs: stripPixels,
            notation: stripPixels,
            belowNotation: stripPixels,
            board: stripPixels,
        }),
        localStorage,
    ),
);

export const dbTypeFamily = tabAtomFamily((_tab: string) => atom<ExplorerFirstSource>("local"));

export const dbTabFamily = tabAtomFamily((_tab: string) => atom("stats"));
