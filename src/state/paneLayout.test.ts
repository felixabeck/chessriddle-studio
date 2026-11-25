import { expect, test } from "vitest";
import { arrangementFitsWidth, needsTwoPaneStack, rootFontPx, widthInPanes } from "./paneLayout";

test("two pane floors keep the database boundary and scale with the root font", () => {
    expect(needsTwoPaneStack(645, 16)).toBe(true);
    expect(needsTwoPaneStack(646, 16)).toBe(false);
    expect(needsTwoPaneStack(1285, 32)).toBe(true);
    expect(needsTwoPaneStack(1286, 32)).toBe(false);
});

test("root font uses computed pixels and the existing percentage fallback", () => {
    expect(rootFontPx("24px", 200)).toBe(24);
    expect(rootFontPx("", 200)).toBe(32);
    expect(rootFontPx("0px", 100)).toBe(16);
});

test("widthInPanes sums rows and takes the larger side of columns", () => {
    expect(widthInPanes("left")).toBe(1);
    expect(
        widthInPanes({
            direction: "column",
            first: "left",
            second: { direction: "column", first: "topRight", second: "bottomRight" },
        }),
    ).toBe(1);
    expect(
        widthInPanes({
            direction: "row",
            first: "left",
            second: { direction: "column", first: "topRight", second: "bottomRight" },
        }),
    ).toBe(2);
    expect(
        widthInPanes({
            direction: "row",
            first: "left",
            second: {
                direction: "column",
                first: "database",
                second: { direction: "row", first: "bottomRight", second: "topRight" },
            },
        }),
    ).toBe(3);
    expect(
        widthInPanes({
            direction: "column",
            first: {
                direction: "row",
                first: "left",
                second: { direction: "row", first: "topRight", second: "bottomRight" },
            },
            second: "database",
        }),
    ).toBe(3);
    expect(
        widthInPanes({
            direction: "column",
            first: { direction: "row", first: "left", second: "topRight" },
            second: {
                direction: "row",
                first: "bottomRight",
                second: {
                    direction: "row",
                    first: "database",
                    second: { direction: "row", first: "analysis", second: "info" },
                },
            },
        }),
    ).toBe(4);
});

test("arrangementFitsWidth checks pane floors and divider allowance at the root font", () => {
    const twoPanes = {
        direction: "row" as const,
        first: "left",
        second: { direction: "column" as const, first: "topRight", second: "bottomRight" },
    };
    const threePanes = {
        direction: "row" as const,
        first: "left",
        second: { direction: "row" as const, first: "bottomRight", second: "topRight" },
    };
    const fourPanes = {
        direction: "row" as const,
        first: "left",
        second: {
            direction: "row" as const,
            first: "database",
            second: { direction: "row" as const, first: "bottomRight", second: "topRight" },
        },
    };
    expect(arrangementFitsWidth("left", 319, 16)).toBe(false);
    expect(arrangementFitsWidth("left", 320, 16)).toBe(true);
    expect(arrangementFitsWidth(twoPanes, 645, 16)).toBe(false);
    expect(arrangementFitsWidth(twoPanes, 646, 16)).toBe(true);
    expect(arrangementFitsWidth(threePanes, 971, 16)).toBe(false);
    expect(arrangementFitsWidth(threePanes, 972, 16)).toBe(true);
    expect(arrangementFitsWidth(fourPanes, 1297, 16)).toBe(false);
    expect(arrangementFitsWidth(fourPanes, 1298, 16)).toBe(true);
    expect(arrangementFitsWidth(fourPanes, 2577, 32)).toBe(false);
    expect(arrangementFitsWidth(fourPanes, 2578, 32)).toBe(true);
});
