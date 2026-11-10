import { createInstance } from "i18next";
import { expect, test } from "vitest";
import { motifLabel } from "./trainingLabels";

const catalogues = import.meta.glob<{ translation: Record<string, string> }>(
    "../../translation/*.json",
    { eager: true, import: "default" },
);
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
