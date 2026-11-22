import type { TFunction } from "i18next";
import type { ExplorerFilters } from "@/state/explorerFilters";
import { normalizeExplorerFilters } from "@/state/explorerFilters";
import { DEFAULT_LICHESS_OPTIONS } from "@/state/atoms";
import type { LichessGamesOptions, MasterGamesOptions } from "@/utils/lichess/explorer";

const displayDate = (pgnDate: string) => pgnDate.replaceAll(".", "-");

/**
 * The active filters of a local source as one short line, or the "No filter" text. A player filter
 * names the player and the colour searched; `playerName` is absent while the name is unknown.
 */
export function localFilterSummary(
    filters: ExplorerFilters,
    t: TFunction,
    playerName?: string,
): string {
    const active = normalizeExplorerFilters(filters);
    const parts: string[] = [];
    if (active.player !== null) {
        parts.push(
            t("Board.Database.FilterSummary.PlayerAs", {
                name: playerName || t("Board.Database.Local.Player"),
                color: active.color === "white" ? t("Fen.White") : t("Fen.Black"),
            }),
        );
    }
    if (active.elo) {
        parts.push(`${t("Board.Database.Local.Elo")} ${active.elo[0]}–${active.elo[1]}`);
    }
    if (active.start_date && active.end_date) {
        parts.push(`${displayDate(active.start_date)} – ${displayDate(active.end_date)}`);
    } else if (active.start_date) {
        parts.push(
            t("Board.Database.FilterSummary.Since", { date: displayDate(active.start_date) }),
        );
    } else if (active.end_date) {
        parts.push(t("Board.Database.FilterSummary.Until", { date: displayDate(active.end_date) }));
    }
    if (active.result === "whitewon") parts.push(t("Board.Database.Local.Result.WhiteWon"));
    if (active.result === "draw") parts.push(t("Board.Analysis.Tablebase.Draw"));
    if (active.result === "blackwon") parts.push(t("Board.Database.Local.Result.BlackWon"));
    if (active.exclude_fast_events) parts.push(t("Board.Database.FilterSummary.NoFastEvents"));
    return parts.length > 0 ? parts.join(" · ") : t("Board.Database.NoFilter");
}

const sameMembers = (left: readonly unknown[] = [], right: readonly unknown[] = []) =>
    left.length === right.length && left.every((member) => right.includes(member));

/**
 * Whether a Lichess source's stored options narrow its numbers compared with the defaults.
 * Judged by what the query sends: a cleared date or player and a re-ordered default list are
 * no filter, and a colour counts only with a player.
 */
export function lichessFiltersActive(options: LichessGamesOptions): boolean {
    return (
        !!options.player ||
        !!options.since ||
        !!options.until ||
        options.variant !== DEFAULT_LICHESS_OPTIONS.variant ||
        !sameMembers(options.speeds, DEFAULT_LICHESS_OPTIONS.speeds) ||
        !sameMembers(options.ratings, DEFAULT_LICHESS_OPTIONS.ratings)
    );
}

/** Whether a Masters source's stored options narrow its numbers: only its dates do. */
export function masterFiltersActive(options: MasterGamesOptions): boolean {
    return !!options.since || !!options.until;
}
