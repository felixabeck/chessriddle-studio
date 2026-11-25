import type { DatabaseHandle } from "@/bindings";
import type {
    ComparisonSource,
    ExplorerFirstSource,
    ExplorerFurtherColumn,
    ExplorerOnlineSource,
} from "@/state/atoms";
import { isDatabaseComparisonSource } from "@/utils/pathCapabilities";
import { databaseHandleKey, type ManagedDatabaseInfo } from "@/utils/db";

/** Columns a preparation board may show: first, opponent, and one further source. */
export const PREPARATION_BOARD_COLUMN_LIMIT = 3;

export type ComparisonState =
    | { kind: "none" }
    | { kind: "database"; database: DatabaseHandle; title: string }
    | { kind: "online"; source: ExplorerOnlineSource }
    | { kind: "unreadable"; name: string };

function listedSource(
    candidate: DatabaseHandle,
    databases: readonly ManagedDatabaseInfo[],
): ComparisonState {
    const key = databaseHandleKey(candidate);
    const entry = databases.find((database) => databaseHandleKey(database.file) === key);
    if (!entry) return { kind: "none" };
    return entry.type === "success"
        ? { kind: "database", database: entry.file, title: entry.title || entry.filename }
        : { kind: "unreadable", name: entry.filename };
}

/**
 * What a panel shows as its second source. An unpinned board compares against the app-wide
 * `stored` choice once its first source is set (a readable local database, or a Lichess source).
 * A tab pinned to a database compares against its own `pinnedComparison` and never against
 * `stored`. `databases` is `undefined` while the list is pending or failed. A Lichess second
 * source beside a Lichess first source does not depend on that list; a local source on either
 * side does.
 */
export function comparisonState({
    first,
    pinned,
    primary,
    stored,
    pinnedComparison,
    databases,
}: {
    first: ExplorerFirstSource;
    pinned: boolean;
    primary: DatabaseHandle | null;
    stored: ComparisonSource;
    pinnedComparison: DatabaseHandle | null;
    databases: readonly ManagedDatabaseInfo[] | undefined;
}): ComparisonState {
    if (pinned) {
        if (first !== "local" || !primary || !pinnedComparison || !databases) {
            return { kind: "none" };
        }
        if (databaseHandleKey(pinnedComparison) === databaseHandleKey(primary)) {
            return { kind: "none" };
        }
        return listedSource(pinnedComparison, databases);
    }

    const firstSet = first !== "local" || primary !== null;
    if (!firstSet || stored == null) return { kind: "none" };

    if (!isDatabaseComparisonSource(stored)) {
        if (first === stored) return { kind: "none" };
        return { kind: "online", source: stored };
    }

    if (!databases) return { kind: "none" };
    if (first === "local" && primary && databaseHandleKey(stored) === databaseHandleKey(primary)) {
        return { kind: "none" };
    }
    return listedSource(stored, databases);
}

export type ReferenceSourceState =
    | { kind: "none" }
    | { kind: "source"; database: DatabaseHandle; title: string };

/**
 * The reference database shown as a further source on a pinned tab. Unlike `comparisonState`, it
 * may be the same database as the primary one, and a missing or unreadable reference database
 * stays absent without an error.
 */
export function pinnedReferenceState({
    local,
    pinned,
    primary,
    reference,
    databases,
}: {
    local: boolean;
    pinned: boolean;
    primary: DatabaseHandle | null;
    reference: DatabaseHandle | null;
    databases: readonly ManagedDatabaseInfo[] | undefined;
}): ReferenceSourceState {
    if (!local || !pinned || !primary || !reference || !databases) {
        return { kind: "none" };
    }
    const key = databaseHandleKey(reference);
    const entry = databases.find((database) => databaseHandleKey(database.file) === key);
    if (!entry || entry.type !== "success") return { kind: "none" };
    return { kind: "source", database: entry.file, title: entry.title || entry.filename };
}

export type ShownFurtherColumn =
    | { id: "reference"; database: DatabaseHandle; title: string }
    | { id: ExplorerOnlineSource };

const FURTHER_COLUMN_IDS: readonly ExplorerFurtherColumn[] = ["reference", "lch_all", "lch_master"];

function occupiedColumnCount(comparisonShown: boolean, furtherShown: number): number {
    return 1 + (comparisonShown ? 1 : 0) + furtherShown;
}

/**
 * Further columns that can be shown, in list order, never beyond three columns in total. The
 * reference database appears only while it is readable; each Lichess source is always showable.
 */
export function shownFurtherColumns({
    columns,
    pinned,
    primary,
    comparisonShown,
    reference,
    databases,
}: {
    columns: readonly ExplorerFurtherColumn[];
    pinned: boolean;
    primary: DatabaseHandle | null;
    comparisonShown: boolean;
    reference: DatabaseHandle | null;
    databases: readonly ManagedDatabaseInfo[] | undefined;
}): ShownFurtherColumn[] {
    if (!pinned || !primary) return [];
    const shown: ShownFurtherColumn[] = [];
    for (const id of columns) {
        if (occupiedColumnCount(comparisonShown, shown.length) >= PREPARATION_BOARD_COLUMN_LIMIT) {
            break;
        }
        if (id === "reference") {
            const source = pinnedReferenceState({
                local: true,
                pinned: true,
                primary,
                reference,
                databases,
            });
            if (source.kind === "source") {
                shown.push({
                    id: "reference",
                    database: source.database,
                    title: source.title,
                });
            }
            continue;
        }
        shown.push({ id });
    }
    return shown;
}

/**
 * Adds a further column after dropping list entries that are not shown, so an unreadable
 * reference database does not reappear as a fourth column once it becomes readable.
 */
export function addFurtherColumn(
    columns: readonly ExplorerFurtherColumn[],
    add: ExplorerFurtherColumn,
    context: {
        pinned: boolean;
        primary: DatabaseHandle | null;
        comparisonShown: boolean;
        reference: DatabaseHandle | null;
        databases: readonly ManagedDatabaseInfo[] | undefined;
    },
): ExplorerFurtherColumn[] {
    const shownIds = shownFurtherColumns({ columns, ...context }).map((column) => column.id);
    const kept = columns.filter((id) => shownIds.includes(id));
    if (kept.includes(add)) return kept;
    const next = [...kept, add];
    if (shownFurtherColumns({ columns: next, ...context }).length > shownIds.length) return next;
    return kept;
}

/** Further sources not yet shown, while fewer than three columns are shown. */
export function furtherColumnChoices(
    columns: readonly ExplorerFurtherColumn[],
    context: {
        pinned: boolean;
        primary: DatabaseHandle | null;
        comparisonShown: boolean;
        reference: DatabaseHandle | null;
        databases: readonly ManagedDatabaseInfo[] | undefined;
    },
): ExplorerFurtherColumn[] {
    const shown = shownFurtherColumns({ columns, ...context });
    if (
        occupiedColumnCount(context.comparisonShown, shown.length) >= PREPARATION_BOARD_COLUMN_LIMIT
    ) {
        return [];
    }
    const shownIds = new Set(shown.map((column) => column.id));
    return FURTHER_COLUMN_IDS.filter((id) => {
        if (shownIds.has(id)) return false;
        if (id !== "reference") return true;
        return (
            pinnedReferenceState({
                local: true,
                pinned: true,
                primary: context.primary,
                reference: context.reference,
                databases: context.databases,
            }).kind === "source"
        );
    });
}
