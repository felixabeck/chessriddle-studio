/** Twin of `src-tauri/src/db/pgn_date.rs` `canonical`; parity is pinned by `src/utils/pgnDate.test.ts`. */
export function canonicalPgnDate(date: string): string {
    const match = /^([0-9?]{4})\.([0-9?]{1,2})\.([0-9?]{1,2})$/.exec(date);
    if (!match) return date;
    const canonicalPart = (part: string) =>
        part.length === 1 ? (part === "?" ? "??" : `0${part}`) : part;
    return `${match[1]}.${canonicalPart(match[2])}.${canonicalPart(match[3])}`;
}
