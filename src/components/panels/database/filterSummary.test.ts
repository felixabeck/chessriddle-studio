import type { TFunction } from "i18next";
import { describe, expect, test } from "vitest";
import type { SupportedLocale } from "@/i18n";
import { defaultExplorerFilters, type ExplorerFilters } from "@/state/explorerFilters";
import { catalogueI18n, shippedCatalogues } from "@/tests/catalogues";
import { DEFAULT_LICHESS_OPTIONS } from "@/state/atoms";
import type { LichessGamesOptions, MasterGamesOptions } from "@/utils/lichess/explorer";
import { lichessFiltersActive, localFilterSummary, masterFiltersActive } from "./filterSummary";

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
    [{ player: 7 }, "Board.Database.FilterSummary.PlayerAs Board.Database.Local.Player Fen.White"],
    [
        { player: 7, color: "black" },
        "Board.Database.FilterSummary.PlayerAs Board.Database.Local.Player Fen.Black",
    ],
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
            "Board.Database.FilterSummary.PlayerAs Board.Database.Local.Player Fen.White",
            "Board.Database.Local.Elo 1900–2500",
            "Board.Database.FilterSummary.Until 2024-12-01",
            "Board.Analysis.Tablebase.Draw",
            "Board.Database.FilterSummary.NoFastEvents",
        ].join(" · "),
    );
});

test.each<["white" | "black", string]>([
    ["white", "Fen.White"],
    ["black", "Fen.Black"],
])("a known player is named with the colour searched (%s)", (color, colorKey) => {
    expect(
        localFilterSummary(
            { ...defaultExplorerFilters(), player: 7, color },
            t,
            "Bergmann, Thomas",
        ),
    ).toBe(`Board.Database.FilterSummary.PlayerAs Bergmann, Thomas ${colorKey}`);
});

test("a name without a player filter names nobody", () => {
    expect(localFilterSummary(defaultExplorerFilters(), t, "Bergmann, Thomas")).toBe(
        "Board.Database.NoFilter",
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
            // The player is named with the colour in every language.
            const named = localFilterSummary(
                { ...defaultExplorerFilters(), player: 7, color: "black" },
                instance.t,
                "NAME",
            );
            expect(named).toContain("NAME");
            expect(named).toContain(translation["Fen.Black"]);
            expect(named).not.toContain("{{");
        },
    );
});

describe("online filter markers", () => {
    const lichess = (change: Partial<LichessGamesOptions>): LichessGamesOptions => ({
        ...DEFAULT_LICHESS_OPTIONS,
        ...change,
    });

    test.each<[string, LichessGamesOptions]>([
        ["the defaults", lichess({})],
        ["a cleared player", lichess({ player: "" })],
        ["a colour without a player", lichess({ color: "black" })],
        ["cleared dates", lichess({ since: undefined, until: undefined })],
        [
            "the default speeds toggled off and on again",
            lichess({ speeds: ["bullet", "rapid", "classical", "correspondence", "blitz"] }),
        ],
        [
            "the default ratings toggled off and on again",
            lichess({ ratings: [1200, 1400, 1600, 1800, 2000, 2200, 2500, 1000] }),
        ],
    ])("Lichess options with %s are no filter", (_name, options) => {
        expect(lichessFiltersActive(options)).toBe(false);
    });

    test.each<[string, LichessGamesOptions]>([
        ["a player", lichess({ player: "someone" })],
        ["a start date", lichess({ since: new Date("2020-01-01T00:00:00Z") })],
        ["an end date", lichess({ until: new Date("2024-01-01T00:00:00Z") })],
        ["fewer speeds", lichess({ speeds: ["blitz"] })],
        ["fewer ratings", lichess({ ratings: [2200, 2500] })],
        ["no speeds", lichess({ speeds: [] })],
        [
            "one speed swapped for another",
            lichess({ speeds: ["ultraBullet", "blitz", "rapid", "classical", "correspondence"] }),
        ],
        [
            "one rating swapped for another",
            lichess({ ratings: [0, 1200, 1400, 1600, 1800, 2000, 2200, 2500] }),
        ],
        ["a variant", lichess({ variant: "chess960" })],
    ])("Lichess options with %s are a filter", (_name, options) => {
        expect(lichessFiltersActive(options)).toBe(true);
    });

    test.each<[string, MasterGamesOptions, boolean]>([
        ["nothing set", {}, false],
        ["cleared dates", { since: undefined, until: undefined }, false],
        ["only display counts", { moves: 12, topGames: 4 }, false],
        ["a start date", { since: new Date("2020-01-01T00:00:00Z") }, true],
        ["an end date", { until: new Date("2024-01-01T00:00:00Z") }, true],
    ])("Masters options with %s", (_name, options, active) => {
        expect(masterFiltersActive(options)).toBe(active);
    });
});
