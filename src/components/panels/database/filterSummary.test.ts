import type { TFunction } from "i18next";
import { describe, expect, test } from "vitest";
import type { SupportedLocale } from "@/i18n";
import { defaultExplorerFilters, type ExplorerFilters } from "@/state/explorerFilters";
import { catalogueI18n, shippedCatalogues } from "@/tests/catalogues";
import { localFilterSummary } from "./filterSummary";

const t = ((key: string, options?: Record<string, unknown>) =>
    [key, ...Object.values(options ?? {})].join(" ")) as unknown as TFunction;
const summary = (change: Partial<ExplorerFilters>) =>
    localFilterSummary({ ...defaultExplorerFilters(), ...change }, t);

test.each<[string, Partial<ExplorerFilters>]>([
    ["nothing set", {}],
    ["a full Elo band", { elo: [0, 3000] }],
    ["a colour without a player", { color: "black" }],
    ["an unset fast-event switch", { exclude_fast_events: false }],
])("filters with %s read as no filter", (_name, change) => {
    expect(summary(change)).toBe("Board.Database.NoFilter");
});

test.each<[Partial<ExplorerFilters>, string]>([
    [{ elo: [1900, 2500] }, "Board.Database.Local.Elo 1900–2500"],
    [{ elo: [0, 2000] }, "Board.Database.Local.Elo 0–2000"],
    [{ player: 7 }, "Board.Database.Local.Player"],
    [{ start_date: "2020.01.31" }, "Board.Database.FilterSummary.Since 2020-01-31"],
    [{ end_date: "2024.12.01" }, "Board.Database.FilterSummary.Until 2024-12-01"],
    [{ start_date: "2020.01.31", end_date: "2024.12.01" }, "2020-01-31 – 2024-12-01"],
    [{ result: "whitewon" }, "Board.Database.Local.Result.WhiteWon"],
    [{ result: "draw" }, "Board.Analysis.Tablebase.Draw"],
    [{ result: "blackwon" }, "Board.Database.Local.Result.BlackWon"],
    [{ exclude_fast_events: true }, "Board.Database.FilterSummary.NoFastEvents"],
])("%j is summarised as %s", (change, expected) => {
    expect(summary(change)).toBe(expected);
});

test("several active filters are joined in a fixed order", () => {
    expect(
        summary({
            exclude_fast_events: true,
            result: "draw",
            end_date: "2024.12.01",
            elo: [1900, 2500],
            player: 7,
        }),
    ).toBe(
        [
            "Board.Database.Local.Player",
            "Board.Database.Local.Elo 1900–2500",
            "Board.Database.FilterSummary.Until 2024-12-01",
            "Board.Analysis.Tablebase.Draw",
            "Board.Database.FilterSummary.NoFastEvents",
        ].join(" · "),
    );
});

describe("explorer header catalogues", () => {
    const templates = {
        "Board.Database.FilterButton": ["Filters: {{summary}}", "summary"],
        "Board.Database.FilterSummary.Since": ["since {{date}}", "date"],
        "Board.Database.FilterSummary.Until": ["until {{date}}", "date"],
        "Board.Database.PositionMode": ["Position: {{mode}}", "mode"],
        "Board.Database.ComparisonUnreadable": [
            "The comparison database “{{database}}” cannot be read.",
            "database",
        ],
    } as const;
    const plain = {
        "Board.Database.Filters": "Filters",
        "Board.Database.NoFilter": "No filter",
        "Board.Database.FilterSummary.NoFastEvents": "no blitz",
        "Board.Database.Compare": "Compare",
        "Board.Database.CompareWith": "Compare with a database",
        "Board.Database.RemoveComparison": "Remove comparison database",
        "Board.Database.GamesSource": "Games from",
    } as const;

    test.each(shippedCatalogues())(
        "$locale translates the header and filter summary without fallback",
        async ({ locale, translation }) => {
            const instance = await catalogueI18n(locale as SupportedLocale);
            const english = locale.startsWith("en-");
            for (const [key, [source, variable]] of Object.entries(templates)) {
                const template = translation[key];
                expect(template).toContain(`{{${variable}}}`);
                expect(instance.t(key, { [variable]: "VALUE" })).toBe(
                    template.replace(`{{${variable}}}`, "VALUE"),
                );
                expect({ [key]: template === source }).toEqual({ [key]: english });
            }
            for (const [key, source] of Object.entries(plain)) {
                expect(translation[key].trim()).not.toBe("");
                expect(instance.t(key)).toBe(translation[key]);
                expect({ [key]: translation[key] === source }).toEqual({ [key]: english });
            }
            expect(translation["Board.Database.NoFilter"]).not.toBe(
                translation["Board.Database.Filters"],
            );
            // The summary is built from real catalogue strings and never falls back to a key.
            const text = localFilterSummary(
                {
                    player: 7,
                    color: "white",
                    start_date: "2020.01.31",
                    result: "draw",
                    elo: [1900, 2500],
                    exclude_fast_events: true,
                },
                instance.t,
            );
            expect(text).not.toContain("Board.");
            expect(text.split(" · ")).toHaveLength(5);
        },
    );
});
