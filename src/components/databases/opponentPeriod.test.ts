import type { TFunction } from "i18next";
import { describe, expect, test } from "vitest";
import { OPPONENT_PERIODS } from "@/state/opponentLinks";
import {
    DEFAULT_PREPARATION_PERIOD,
    opponentPeriodLabel,
    opponentPeriodOptions,
    opponentPeriodToValue,
    valueToOpponentPeriod,
} from "./opponentPeriod";

const t = ((key: string) => key) as unknown as TFunction;

describe("opponentPeriod helpers", () => {
    test("maps periods to select values and back using OPPONENT_PERIODS", () => {
        expect(DEFAULT_PREPARATION_PERIOD).toBe(3);
        for (const period of OPPONENT_PERIODS) {
            const value = opponentPeriodToValue(period);
            expect(valueToOpponentPeriod(value)).toBe(period);
        }
        expect(opponentPeriodToValue(null)).toBe("all");
        expect(valueToOpponentPeriod("all")).toBeNull();
        expect(valueToOpponentPeriod("invalid")).toBe(DEFAULT_PREPARATION_PERIOD);
        expect(valueToOpponentPeriod("2", 5)).toBe(5);
    });

    test("builds localized labels and options in the supplied order", () => {
        expect(opponentPeriodLabel(null, t)).toBe("Databases.OpeningTree.AllGames");
        expect(opponentPeriodLabel(5, t)).toBe("Databases.OpeningTree.FiveYears");
        expect(opponentPeriodLabel(3, t)).toBe("Databases.Opponent.ThreeYears");
        expect(opponentPeriodLabel(1, t)).toBe("Databases.OpeningTree.OneYear");

        expect(opponentPeriodOptions(OPPONENT_PERIODS, t)).toEqual([
            { value: "1", label: "Databases.OpeningTree.OneYear" },
            { value: "3", label: "Databases.Opponent.ThreeYears" },
            { value: "5", label: "Databases.OpeningTree.FiveYears" },
            { value: "all", label: "Databases.OpeningTree.AllGames" },
        ]);
    });
});
