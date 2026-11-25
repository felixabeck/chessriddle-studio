import type { TFunction } from "i18next";
import { OPPONENT_PERIODS, type OpponentPeriod } from "@/state/opponentLinks";

/** Default period preset for the Preparation tab (3 years). */
export const DEFAULT_PREPARATION_PERIOD: OpponentPeriod = 3;

export function opponentPeriodToValue(period: OpponentPeriod): string {
    return period === null ? "all" : String(period);
}

export function valueToOpponentPeriod(
    value: string,
    fallback: OpponentPeriod = DEFAULT_PREPARATION_PERIOD,
): OpponentPeriod {
    if (value === "all") return null;
    const parsed = Number(value);
    return OPPONENT_PERIODS.includes(parsed as OpponentPeriod)
        ? (parsed as OpponentPeriod)
        : fallback;
}

export function opponentPeriodLabel(period: OpponentPeriod, t: TFunction): string {
    switch (period) {
        case null:
            return t("Databases.OpeningTree.AllGames", { defaultValue: "All games" });
        case 5:
            return t("Databases.OpeningTree.FiveYears", { defaultValue: "5 years" });
        case 3:
            return t("Databases.Opponent.ThreeYears", { defaultValue: "3 years" });
        case 1:
            return t("Databases.OpeningTree.OneYear", { defaultValue: "1 year" });
    }
}

export function opponentPeriodOptions(
    periods: readonly OpponentPeriod[],
    t: TFunction,
): { value: string; label: string }[] {
    return periods.map((period) => ({
        value: opponentPeriodToValue(period),
        label: opponentPeriodLabel(period, t),
    }));
}
