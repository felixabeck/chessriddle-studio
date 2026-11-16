/** Twin of `src-tauri/src/db/pgn_date.rs` `canonical`; parity is pinned by `src/utils/pgnDate.test.ts`. */
export function canonicalPgnDate(date: string): string {
    const match = /^([0-9?]{4})\.([0-9?]{1,2})\.([0-9?]{1,2})$/.exec(date);
    if (!match) return date;
    const canonicalPart = (part: string) =>
        part.length === 1 ? (part === "?" ? "??" : `0${part}`) : part;
    return `${match[1]}.${canonicalPart(match[2])}.${canonicalPart(match[3])}`;
}

function pad(value: number, width = 2): string {
    return String(value).padStart(width, "0");
}

export interface GameStartTags {
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
export function gameStartTags(now: Date): GameStartTags {
    return {
        date: `${pad(now.getFullYear(), 4)}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}`,
        utcDate: `${pad(now.getUTCFullYear(), 4)}.${pad(now.getUTCMonth() + 1)}.${pad(now.getUTCDate())}`,
        utcTime: `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`,
    };
}
