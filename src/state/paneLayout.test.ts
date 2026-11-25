import { expect, test } from "vitest";
import {
    arrangementFitsWidth,
    besideSplitPositions,
    fitsThreePanes,
    needsTwoPaneStack,
    rootFontPx,
    widthInPanes,
} from "./paneLayout";

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

test("three pane floors decide when the panels fit beside the notation", () => {
    expect(fitsThreePanes(971, 16)).toBe(false);
    expect(fitsThreePanes(972, 16)).toBe(true);
    expect(fitsThreePanes(1931, 32)).toBe(false);
    expect(fitsThreePanes(1932, 32)).toBe(true);
});

test("beside dividers keep the wanted positions while every pane has its floor", () => {
    expect(besideSplitPositions(2000, 16, { board: 60, notation: 45 })).toEqual({
        board: 60,
        notation: 45,
    });
    expect(besideSplitPositions(2000, 16, {})).toEqual({ board: 50, notation: 50 });
});

test("beside dividers move only as far as a pane's floor needs", () => {
    // Of 2000px the board keeps 323px and the right side 649px.
    expect(besideSplitPositions(2000, 16, { board: 5 }).board).toBeCloseTo(16.15, 5);
    expect(besideSplitPositions(2000, 16, { board: 95 }).board).toBeCloseTo(67.55, 5);
    // Of the 1000px right side the notation keeps 326px and the panels 323px.
    expect(besideSplitPositions(2000, 16, { board: 50, notation: 0 }).notation).toBeCloseTo(
        32.6,
        5,
    );
    expect(besideSplitPositions(2000, 16, { board: 50, notation: 100 }).notation).toBeCloseTo(
        67.7,
        5,
    );
    // The notation's bounds follow the board divider actually shown.
    expect(besideSplitPositions(2000, 16, { board: 95, notation: 0 }).notation).toBeCloseTo(
        (326 / 649) * 100,
        5,
    );
    // The floors scale with the root font.
    expect(besideSplitPositions(4000, 32, { board: 5 }).board).toBeCloseTo(16.075, 5);
});

test("at the three pane threshold every pane gets exactly its floor", () => {
    const { board, notation } = besideSplitPositions(972, 16, { board: 50, notation: 50 });
    expect((board / 100) * 972).toBeCloseTo(323, 5);
    const rightSide = 972 - 323;
    expect((notation / 100) * rightSide).toBeCloseTo(326, 5);
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
