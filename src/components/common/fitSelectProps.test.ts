import { expect, test } from "vitest";
import { fitSelectProps } from "./fitSelectProps";

const chrome = "var(--input-padding-inline-start) + var(--input-right-section-size)";
const width = (data: Parameters<typeof fitSelectProps>[0]) =>
    fitSelectProps(data).styles.wrapper.width;

test("uses the longest label and grows when that label is longer", () => {
    expect(width(["ab", "a"])).toBe(`calc(2ch + ${chrome})`);
    expect(width(["ab", "abcdef"])).toBe(`calc(6ch + ${chrome})`);
});

test("reads object labels and grouped items, not values", () => {
    expect(
        width([
            { value: "all", label: "All games" },
            { value: "1", label: "1 year" },
        ]),
    ).toBe(`calc(9ch + ${chrome})`);
    expect(
        width([{ group: "Recent", items: [{ value: "5", label: "5 years" }, "All games"] }]),
    ).toBe(`calc(9ch + ${chrome})`);
});

test("counts characters, not UTF-16 units, so an astral-plane label is not overcounted", () => {
    expect(width(["𝔸𝔹", "a"])).toBe(`calc(2ch + ${chrome})`);
    expect(width(["Alle Partien", "1 Jahr"])).toBe(`calc(12ch + ${chrome})`);
});

test("lets the open list fit its options instead of the narrow trigger", () => {
    expect(fitSelectProps(["1", "2", "3", "5"]).comboboxProps.width).toBe("max-content");
});
