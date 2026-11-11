import { createInstance } from "i18next";
import { expect, test } from "vitest";
import { difficultyOptions, motifCategoryLabels, motifLabel } from "./trainingLabels";
import { CATEGORY_ORDER, motifMeta } from "./motifCatalog";

const catalogues = import.meta.glob<{ translation: Record<string, string> }>(
    "../../translation/*.json",
    { eager: true, import: "default" },
);

// Added since 44d7e34e0 by phases 1 and 2 of the training tree plan.
const phaseKeys = [
    "Training.IncompleteVariationMessage",
    "Training.IncompleteVariationTitle",
    "Training.InputLimit",
    "Training.MistakesNote",
    "Training.OnlyOneMoveAllowed",
    "Training.Settings.Categories.All",
    "Training.Settings.Categories.Tactics",
    "Training.Settings.Categories.Mates",
    "Training.Settings.Categories.Endgames",
    "Training.Settings.Categories.Phases",
    "Training.Settings.Categories.Position",
    "Training.Settings.Categories.Other",
    "Training.Settings.ShowSolutionLength",
];

test("ships all 16 locales", () => expect(Object.keys(catalogues)).toHaveLength(16));

test.each(Object.entries(catalogues))(
    "all phase 1 and 2 strings resolve without fallback in %s",
    async (_path, catalogue) => {
        const instance = createInstance();
        await instance.init({
            lng: "test",
            fallbackLng: false,
            keySeparator: false,
            resources: { test: catalogue },
        });
        for (const key of phaseKeys) {
            expect({
                key,
                value: catalogue.translation[key],
                exists: instance.exists(key),
                resolved: instance.t(key),
            }).toEqual({
                key,
                value: expect.stringMatching(/\S/),
                exists: true,
                resolved: catalogue.translation[key],
            });
        }
        expect(Object.keys(motifCategoryLabels(instance.t))).toEqual(["all", ...CATEGORY_ORDER]);
        expect(difficultyOptions(instance.t).map((option) => option.glyph)).toEqual([
            "♙",
            "♘",
            "♗",
            "♖",
            "♕",
        ]);
    },
);

test("copied motif categories and icons include safe unknown-key fallbacks", () => {
    expect(motifMeta("fork")).toEqual({ category: "tactics", icon: "🔱" });
    expect(motifMeta("mateIn2")).toEqual({ category: "mates", icon: "#2" });
    expect(motifMeta("bishopEndgame").category).toBe("endgames");
    expect(motifMeta("opening").category).toBe("phases");
    expect(motifMeta("promotion").category).toBe("position");
    expect(motifMeta("veryLong")).toEqual({ category: "other", icon: "🔢" });
    for (const name of ["futureMotif42", "constructor", "__proto__"]) {
        expect(motifMeta(name)).toEqual({ category: "other", icon: "•" });
    }
});
test.each(Object.entries(catalogues))(
    "all 62 motif names resolve without fallback in %s",
    async (_path, catalogue) => {
        const instance = createInstance();
        await instance.init({
            lng: "test",
            fallbackLng: false,
            keySeparator: false,
            resources: { test: catalogue },
        });
        const names = Object.keys(catalogue.translation)
            .filter((key) => key.startsWith("Training.Motif."))
            .map((key) => key.slice("Training.Motif.".length));
        expect(names).toHaveLength(62);
        for (const name of names) {
            const label = motifLabel(name, instance.t);
            expect(label).toBe(catalogue.translation[`Training.Motif.${name}`]);
            expect(label).not.toContain("Training.Motif.");
        }
        expect(motifLabel("futureMotif42", instance.t)).toBe("Future Motif 42");
    },
);
