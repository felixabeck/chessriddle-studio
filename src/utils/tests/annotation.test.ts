import { expect, test } from "vitest";
import { shippedCatalogues } from "@/tests/catalogues";
import { ANNOTATION_INFO } from "../annotation";

test("every offered annotation has a catalogue translation", () => {
    const catalogues = shippedCatalogues();
    for (const [glyph, info] of Object.entries(ANNOTATION_INFO)) {
        if (glyph === "") continue; // the None sentinel is never offered as a symbol
        expect({ glyph, translationKey: info.translationKey }).toEqual({
            glyph,
            translationKey: expect.stringMatching(/\S/),
        });
        const key = `Annotate.${info.translationKey}`;
        for (const { locale, translation } of catalogues) {
            expect({ locale, key, value: translation[key] }).toEqual({
                locale,
                key,
                value: expect.stringMatching(/\S/),
            });
        }
    }
});
