import { expect, test } from "vitest";
import { FILE_TYPE_EMOJI, FILE_TYPES } from "./file";

test("FILE_TYPE_EMOJI maps every FILE_TYPES entry to a non-empty emoji", () => {
    expect(Object.keys(FILE_TYPE_EMOJI).sort()).toEqual(
        FILE_TYPES.map((type) => type.value).sort(),
    );
    for (const { value } of FILE_TYPES) {
        expect(FILE_TYPE_EMOJI[value].trim().length).toBeGreaterThan(0);
    }
});
