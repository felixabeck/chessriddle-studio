import type { TFunction } from "i18next";
import type { ExplorerFilters } from "@/state/explorerFilters";
import { normalizeExplorerFilters } from "@/state/explorerFilters";

const displayDate = (pgnDate: string) => pgnDate.replaceAll(".", "-");

/** The active filters of a local source as one short line, or the "No filter" text. */
export function localFilterSummary(filters: ExplorerFilters, t: TFunction): string {
    const active = normalizeExplorerFilters(filters);
    const parts: string[] = [];
    if (active.player !== null) parts.push(t("Board.Database.Local.Player"));
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
