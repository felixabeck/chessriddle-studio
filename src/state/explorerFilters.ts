import { z } from "zod";
import type { LocalOptions } from "@/utils/db";

export const ELO_FILTER_MAX = 3000;

/** A full `[0, ELO_FILTER_MAX]` band means no Elo filter. */
export function normalizeRange(range?: [number, number] | null): [number, number] | undefined {
    if (!range || (range[0] === 0 && range[1] === ELO_FILTER_MAX)) {
        return undefined;
    }
    return range;
}

/** The board explorer's filters of one local database: every field its filter form can edit. */
export type ExplorerFilters = Pick<
    LocalOptions,
    "player" | "color" | "start_date" | "end_date" | "result" | "elo" | "exclude_fast_events"
>;

export type ExplorerFilterEntry = { database: string; filters: ExplorerFilters };

/** Saved filter sets are bounded; the least recently changed database goes first. */
export const MAX_EXPLORER_FILTER_DATABASES = 64;

/** An opaque database capability id; far longer than any id the native side issues. */
export const MAX_DATABASE_KEY_LENGTH = 512;

const PGN_DATE = /^\d{4}\.\d{2}\.\d{2}$/;

export const explorerFiltersSchema = z
    .object({
        player: z.number().int().nullable(),
        color: z.enum(["white", "black"]),
        start_date: z.string().regex(PGN_DATE).optional(),
        end_date: z.string().regex(PGN_DATE).optional(),
        result: z.enum(["any", "whitewon", "draw", "blackwon"]),
        elo: z.tuple([z.number().finite(), z.number().finite()]).optional(),
        exclude_fast_events: z.literal(true).optional(),
    })
    .strict();

const entrySchema = z
    .object({
        database: z.string().min(1).max(MAX_DATABASE_KEY_LENGTH),
        filters: explorerFiltersSchema,
    })
    .strict();

/**
 * Reads the stored list element by element: an invalid or repeated element is dropped and the
 * valid ones are kept unchanged, so a valid stored value parses to itself.
 */
export const explorerFilterEntriesSchema: z.ZodType<ExplorerFilterEntry[], z.ZodTypeDef, unknown> =
    z.unknown().transform((value) => {
        if (!Array.isArray(value)) return [];
        const entries = new Map<string, ExplorerFilterEntry>();
        for (const item of value) {
            const parsed = entrySchema.safeParse(item);
            if (parsed.success && !entries.has(parsed.data.database)) {
                entries.set(parsed.data.database, parsed.data);
            }
        }
        return [...entries.values()].slice(-MAX_EXPLORER_FILTER_DATABASES);
    });

/**
 * The database ids a stored list owns, for the startup path-owner snapshot. Deliberately looser
 * than the read schema: an element this accepts keeps its database id alive even if its filters
 * are later dropped as invalid.
 */
export const explorerFilterOwnersSchema = z.array(
    z.object({ database: z.string().min(1) }).passthrough(),
);

export function defaultExplorerFilters(): ExplorerFilters {
    return { player: null, color: "white", result: "any" };
}

/**
 * The one form filters are compared and stored in: a full Elo band is no Elo filter, an unset
 * fast-event switch is absent, and the colour is the default while no player is set.
 */
export function normalizeExplorerFilters(filters: ExplorerFilters): ExplorerFilters {
    const player = filters.player ?? null;
    const elo = normalizeRange(filters.elo);
    return {
        player,
        color: player === null ? "white" : filters.color,
        ...(filters.start_date ? { start_date: filters.start_date } : {}),
        ...(filters.end_date ? { end_date: filters.end_date } : {}),
        result: filters.result,
        ...(elo ? { elo: [elo[0], elo[1]] as [number, number] } : {}),
        ...(filters.exclude_fast_events ? { exclude_fast_events: true } : {}),
    };
}

export function isDefaultExplorerFilters(filters: ExplorerFilters): boolean {
    const normal = normalizeExplorerFilters(filters);
    return (
        normal.player === null &&
        normal.result === "any" &&
        normal.start_date === undefined &&
        normal.end_date === undefined &&
        normal.elo === undefined &&
        normal.exclude_fast_events === undefined
    );
}

export function explorerFiltersFor(
    entries: readonly ExplorerFilterEntry[],
    database: string | null,
): ExplorerFilters {
    return (
        entries.find((entry) => entry.database === database)?.filters ?? defaultExplorerFilters()
    );
}

/** Stores one database's filters as the most recently changed entry; a default set is removed. */
export function withExplorerFilters(
    entries: readonly ExplorerFilterEntry[],
    database: string,
    filters: ExplorerFilters,
): ExplorerFilterEntry[] {
    const others = entries.filter((entry) => entry.database !== database);
    if (isDefaultExplorerFilters(filters)) return others;
    return [...others, { database, filters: normalizeExplorerFilters(filters) }].slice(
        -MAX_EXPLORER_FILTER_DATABASES,
    );
}

export function withoutExplorerFilters(
    entries: readonly ExplorerFilterEntry[],
    database: string,
): ExplorerFilterEntry[] {
    return entries.filter((entry) => entry.database !== database);
}

/**
 * Database `from` was replaced by `to`: its filters follow in place, so the list never grows and
 * the bound cannot evict another database. The player goes, because player ids are
 * database-local. Filters `to` already has win.
 */
export function replaceExplorerFilterDatabase(
    entries: readonly ExplorerFilterEntry[],
    from: string,
    to: string,
): ExplorerFilterEntry[] {
    if (from === to) return [...entries];
    const targetExists = entries.some((entry) => entry.database === to);
    return entries.flatMap((entry) => {
        if (entry.database !== from) return [entry];
        if (targetExists) return [];
        const filters = normalizeExplorerFilters({ ...entry.filters, player: null });
        return isDefaultExplorerFilters(filters) ? [] : [{ database: to, filters }];
    });
}
