/** Twin of `src-tauri/src/db/pgn_date.rs` `canonical`; parity is pinned by `src/utils/pgnDate.test.ts`. */
export function canonicalPgnDate(date: string): string {
    const match = /^([0-9?]{4})\.([0-9?]{1,2})\.([0-9?]{1,2})$/.exec(date);
    if (!match) return date;
    const canonicalPart = (part: string) =>
        part.length === 1 ? (part === "?" ? "??" : `0${part}`) : part;
    return `${match[1]}.${canonicalPart(match[2])}.${canonicalPart(match[3])}`;
}

/**
 * Orders PGN dates like the native sample order: stored dates are verbatim, so they are padded
 * first; an unknown component sorts below every known one and an unknown date below all.
 */
export function dateOrderKey(date: string | null | undefined): string {
    return !date || date.startsWith("?") ? "" : canonicalPgnDate(date).replaceAll("?", "0");
}

/** Formats a PGN date (`YYYY.MM.DD`) as `YYYY-MM`, `YYYY`, or `"–"` when absent. */
export function formatPgnYearMonth(date: string | null | undefined): string {
    if (!date) return "–";
    const month = date.slice(5, 7);
    return month && /^(0[1-9]|1[0-2])$/.test(month)
        ? `${date.slice(0, 4)}-${month}`
        : date.slice(0, 4);
}

function pad(value: number, width = 2): string {
    return String(value).padStart(width, "0");
}

interface PgnDateTags {
    /** PGN `Date`: the local calendar date the game started on. */
    date: string;
    /** PGN `UTCDate`: the UTC calendar date of the same moment, paired with `utcTime`. */
    utcDate: string;
    /** PGN `UTCTime`. */
    utcTime: string;
}

/**
 * The PGN standard keeps `Date` on the local clock and the UTC moment in the
 * `UTCDate`/`UTCTime` pair, so a game started near midnight is not dated a day off.
 */
export function pgnDateTags(now: Date): PgnDateTags {
    return {
        date: `${pad(now.getFullYear(), 4)}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}`,
        utcDate: `${pad(now.getUTCFullYear(), 4)}.${pad(now.getUTCMonth() + 1)}.${pad(now.getUTCDate())}`,
        utcTime: `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`,
    };
}
