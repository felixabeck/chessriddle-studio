import type { ComboboxData, ComboboxItem, ComboboxItemGroup } from "@mantine/core";

function optionLabel(item: string | ComboboxItem): string {
    return typeof item === "string" ? item : item.label;
}

function dataLabels(data: ComboboxData): string[] {
    return data.flatMap((item) => {
        if (typeof item === "object" && "group" in item) {
            return (item as ComboboxItemGroup).items.map(optionLabel);
        }
        return [optionLabel(item)];
    });
}

/**
 * Props for an inline Select sized to its content, like the native select it replaced. The
 * trigger is as wide as the longest option label of the current `data` (so translations size
 * the field) plus the input's start padding and chevron gutter; `ch` is the used font's "0"
 * advance on the input. The open list is at least as wide as its options, with the check icon,
 * never squeezed to a narrow trigger.
 */
export function fitSelectProps(data: ComboboxData) {
    const longest = dataLabels(data).reduce((max, label) => Math.max(max, [...label].length), 0);
    const width = `calc(${longest}ch + var(--input-padding-inline-start) + var(--input-right-section-size))`;
    return {
        styles: {
            wrapper: { width, maxWidth: "100%", minWidth: 0 },
            input: { width: "100%", minWidth: 0 },
        },
        comboboxProps: { width: "max-content" },
    } as const;
}
