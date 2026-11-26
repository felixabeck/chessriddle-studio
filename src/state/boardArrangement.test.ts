import { describe, expect, test } from "vitest";
import {
    applyShownSplits,
    arrangementLeaves,
    arrangementPanelAreas,
    type BoardArrangement,
    boardArrangementSchema,
    canTakeOutPanel,
    computeCarryOverArrangement,
    defaultBoardArrangement,
    type HideableAreaId,
    isValidBoardArrangement,
    type LegacyLayoutValues,
    type PanelAreaId,
    placeArea,
    returnPanelArea,
    shownArrangement,
    validateMosaicTree,
} from "./boardArrangement";

function emptyLegacy(overrides: Partial<LegacyLayoutValues> = {}): LegacyLayoutValues {
    return {
        windowsState: null,
        panelsBesideNotation: null,
        boardBesideSplits: null,
        detachedExplorer: null,
        detachedExplorerPlacement: null,
        detachedExplorerHeights: null,
        ...overrides,
    };
}

describe("validateMosaicTree and isValidBoardArrangement", () => {
    test("accepts the default arrangement and valid arrangements up to the maximum bounds", () => {
        const def = defaultBoardArrangement();
        expect(isValidBoardArrangement(def)).toBe(true);
        expect(boardArrangementSchema.safeParse(def).success).toBe(true);

        // 7 leaves (3 base + 3 always-present + coach) in a depth-6 comb (13 nodes).
        const maxTree: BoardArrangement = {
            direction: "row",
            first: "left",
            splitPercentage: 0,
            second: {
                direction: "column",
                first: "topRight",
                splitPercentage: 100,
                second: {
                    direction: "row",
                    first: "bottomRight",
                    splitPercentage: 50,
                    second: {
                        direction: "column",
                        first: "analysis",
                        second: {
                            direction: "row",
                            first: "database",
                            second: {
                                direction: "column",
                                first: "annotate",
                                second: "coach",
                            },
                        },
                    },
                },
            },
        };
        expect(isValidBoardArrangement(maxTree)).toBe(true);
        expect(arrangementLeaves(maxTree)).toEqual([
            "left",
            "topRight",
            "bottomRight",
            "analysis",
            "database",
            "annotate",
            "coach",
        ]);
        expect(arrangementPanelAreas(maxTree)).toEqual([
            "analysis",
            "database",
            "annotate",
            "coach",
        ]);
    });

    test("enforces custom bounds in the shared validator", () => {
        const allowed = new Set(["a", "b", "c", "d"] as const);
        const depthThree = {
            direction: "row",
            first: "a",
            second: {
                direction: "row",
                first: "b",
                second: { direction: "row", first: "c", second: "d" },
            },
        };
        expect(validateMosaicTree(depthThree, allowed, { maxNodes: 7, maxDepth: 3 })).toEqual(
            new Set(["a", "b", "c", "d"]),
        );
        expect(validateMosaicTree(depthThree, allowed, { maxNodes: 7, maxDepth: 2 })).toBeNull();
        expect(validateMosaicTree(depthThree, allowed, { maxNodes: 6, maxDepth: 3 })).toBeNull();
    });

    test.each([
        ["missing base area", { direction: "row", first: "left", second: "topRight" }],
        [
            "duplicate base area",
            {
                direction: "row",
                first: "left",
                second: { direction: "column", first: "left", second: "bottomRight" },
            },
        ],
        [
            "duplicate panel area",
            {
                direction: "row",
                first: { direction: "column", first: "left", second: "database" },
                second: {
                    direction: "column",
                    first: { direction: "row", first: "topRight", second: "database" },
                    second: "bottomRight",
                },
            },
        ],
        [
            "unknown leaf practice",
            {
                direction: "row",
                first: "left",
                second: {
                    direction: "column",
                    first: "topRight",
                    second: { direction: "row", first: "bottomRight", second: "practice" },
                },
            },
        ],
        [
            "unknown leaf photo",
            {
                direction: "row",
                first: "left",
                second: {
                    direction: "column",
                    first: "topRight",
                    second: { direction: "row", first: "bottomRight", second: "photo" },
                },
            },
        ],
        [
            "strip rule violated (all four always-present panels)",
            {
                direction: "row",
                first: {
                    direction: "column",
                    first: "left",
                    second: { direction: "row", first: "analysis", second: "database" },
                },
                second: {
                    direction: "column",
                    first: { direction: "row", first: "topRight", second: "annotate" },
                    second: { direction: "row", first: "bottomRight", second: "info" },
                },
            },
        ],
        [
            "invalid direction",
            {
                direction: "diagonal",
                first: "left",
                second: { direction: "column", first: "topRight", second: "bottomRight" },
            },
        ],
        [
            "unknown node property",
            {
                direction: "row",
                first: "left",
                second: { direction: "column", first: "topRight", second: "bottomRight" },
                extra: true,
            },
        ],
        ["missing second child", { direction: "row", first: "left" }],
        [
            "negative splitPercentage",
            {
                direction: "row",
                first: "left",
                second: { direction: "column", first: "topRight", second: "bottomRight" },
                splitPercentage: -0.1,
            },
        ],
        [
            "splitPercentage over 100",
            {
                direction: "row",
                first: "left",
                second: { direction: "column", first: "topRight", second: "bottomRight" },
                splitPercentage: 100.1,
            },
        ],
        [
            "NaN splitPercentage",
            {
                direction: "row",
                first: "left",
                second: { direction: "column", first: "topRight", second: "bottomRight" },
                splitPercentage: Number.NaN,
            },
        ],
        [
            "Infinity splitPercentage",
            {
                direction: "row",
                first: "left",
                second: { direction: "column", first: "topRight", second: "bottomRight" },
                splitPercentage: Number.POSITIVE_INFINITY,
            },
        ],
        [
            "null splitPercentage",
            {
                direction: "row",
                first: "left",
                second: { direction: "column", first: "topRight", second: "bottomRight" },
                splitPercentage: null,
            },
        ],
        ["null root", null],
        ["array root", ["left", "topRight", "bottomRight"]],
        ["single leaf", "left"],
    ])("rejects invalid arrangement: %s", (_label, candidate) => {
        expect(isValidBoardArrangement(candidate)).toBe(false);
        expect(boardArrangementSchema.safeParse(candidate).success).toBe(false);
    });
});

describe("placeArea, returnPanelArea and canTakeOutPanel", () => {
    test.each([
        ["left", { direction: "row", first: "database", second: "left", splitPercentage: 50 }],
        ["right", { direction: "row", first: "left", second: "database", splitPercentage: 50 }],
        ["top", { direction: "column", first: "database", second: "left", splitPercentage: 50 }],
        ["bottom", { direction: "column", first: "left", second: "database", splitPercentage: 50 }],
    ] as const)("places a new panel area on the %s side of a target at 50 %%", (side, expected) => {
        const result = placeArea(defaultBoardArrangement(), "database", "left", side);
        expect(result).toEqual({
            direction: "row",
            first: expected,
            second: {
                direction: "column",
                first: "topRight",
                second: "bottomRight",
            },
        });
        expect(isValidBoardArrangement(result)).toBe(true);
    });

    test("moves an existing area by removing it first and keeping sibling splits", () => {
        const start: BoardArrangement = {
            direction: "row",
            splitPercentage: 58,
            first: "left",
            second: {
                direction: "column",
                splitPercentage: 40,
                first: {
                    direction: "row",
                    splitPercentage: 35,
                    first: "database",
                    second: "topRight",
                },
                second: "bottomRight",
            },
        };
        const moved = placeArea(start, "bottomRight", "left", "right");
        expect(moved).toEqual({
            direction: "row",
            splitPercentage: 58,
            first: {
                direction: "row",
                first: "left",
                second: "bottomRight",
                splitPercentage: 50,
            },
            second: {
                direction: "row",
                splitPercentage: 35,
                first: "database",
                second: "topRight",
            },
        });
    });

    test.each([
        ["left", { direction: "row", first: "database", second: "left", splitPercentage: 50 }],
        ["top", { direction: "column", first: "database", second: "left", splitPercentage: 50 }],
        ["bottom", { direction: "column", first: "left", second: "database", splitPercentage: 50 }],
    ] as const)(
        "moves an existing first-child area to the %s side of another area with exact structure",
        (side, expectedFirst) => {
            const start: BoardArrangement = {
                direction: "row",
                splitPercentage: 58,
                first: "left",
                second: {
                    direction: "column",
                    splitPercentage: 40,
                    first: {
                        direction: "row",
                        splitPercentage: 35,
                        first: "database",
                        second: "topRight",
                    },
                    second: "bottomRight",
                },
            };
            expect(placeArea(start, "database", "left", side)).toEqual({
                direction: "row",
                splitPercentage: 58,
                first: expectedFirst,
                second: {
                    direction: "column",
                    splitPercentage: 40,
                    first: "topRight",
                    second: "bottomRight",
                },
            });
        },
    );

    test("refuses disallowed moves and returns the arrangement unchanged", () => {
        const start = defaultBoardArrangement();
        // Board cannot be moved.
        expect(placeArea(start, "left", "topRight", "right")).toBe(start);
        // Target cannot be the area itself.
        expect(placeArea(start, "bottomRight", "bottomRight", "left")).toBe(start);
        // Target must be in the tree.
        expect(placeArea(start, "database", "analysis", "bottom")).toBe(start);

        // Strip rule: taking out the fourth always-present panel is refused, while coach and
        // moving an already-present panel are allowed.
        let threeOut = placeArea(start, "analysis", "left", "bottom");
        threeOut = placeArea(threeOut, "database", "topRight", "top");
        threeOut = placeArea(threeOut, "annotate", "bottomRight", "bottom");
        expect(canTakeOutPanel(threeOut, "info")).toBe(false);
        expect(canTakeOutPanel(threeOut, "analysis")).toBe(false);
        expect(canTakeOutPanel(threeOut, "coach")).toBe(true);
        expect(placeArea(threeOut, "info", "left", "right")).toBe(threeOut);

        const withCoach = placeArea(threeOut, "coach", "topRight", "right");
        expect(withCoach).not.toBe(threeOut);
        expect(isValidBoardArrangement(withCoach)).toBe(true);

        const movedExisting = placeArea(threeOut, "database", "left", "right");
        expect(movedExisting).not.toBe(threeOut);
        expect(isValidBoardArrangement(movedExisting)).toBe(true);
    });

    test("returns a panel area to the tabs and leaves sibling splits intact", () => {
        const start: BoardArrangement = {
            direction: "row",
            splitPercentage: 55,
            first: {
                direction: "column",
                splitPercentage: 70,
                first: "left",
                second: "database",
            },
            second: {
                direction: "column",
                splitPercentage: 45,
                first: "topRight",
                second: "bottomRight",
            },
        };
        expect(returnPanelArea(start, "database")).toEqual({
            direction: "row",
            splitPercentage: 55,
            first: "left",
            second: {
                direction: "column",
                splitPercentage: 45,
                first: "topRight",
                second: "bottomRight",
            },
        });
        // Returning a panel that is not in the tree is a no-op.
        expect(returnPanelArea(start, "info")).toBe(start);
    });
});

describe("shownArrangement and applyShownSplits", () => {
    test("hides unavailable panels and writes divider, place and return changes past them", () => {
        const stored: BoardArrangement = {
            direction: "row",
            splitPercentage: 50,
            first: "left",
            second: {
                direction: "column",
                splitPercentage: 30,
                first: "coach",
                second: {
                    direction: "column",
                    splitPercentage: 40,
                    first: "topRight",
                    second: "bottomRight",
                },
            },
        };
        const hidden = new Set<PanelAreaId>(["coach"]);

        const shown = shownArrangement(stored, hidden);
        expect(shown).toEqual({
            direction: "row",
            splitPercentage: 50,
            first: "left",
            second: {
                direction: "column",
                splitPercentage: 40,
                first: "topRight",
                second: "bottomRight",
            },
        });

        // Divider drag on the shown arrangement updates stored while keeping coach and its 30 % split.
        const draggedShown: BoardArrangement = {
            direction: "row",
            splitPercentage: 62,
            first: "left",
            second: {
                direction: "column",
                splitPercentage: 55,
                first: "topRight",
                second: "bottomRight",
            },
        };
        const afterDrag = applyShownSplits(stored, draggedShown, hidden);
        expect(afterDrag).toEqual({
            direction: "row",
            splitPercentage: 62,
            first: "left",
            second: {
                direction: "column",
                splitPercentage: 30,
                first: "coach",
                second: {
                    direction: "column",
                    splitPercentage: 55,
                    first: "topRight",
                    second: "bottomRight",
                },
            },
        });
        expect(shownArrangement(afterDrag, hidden)).toEqual(draggedShown);

        // Place and return applied to stored keep coach in place.
        const afterPlace = placeArea(afterDrag, "database", "left", "bottom");
        expect(arrangementLeaves(afterPlace)).toContain("coach");
        expect(shownArrangement(afterPlace, hidden)).toEqual(
            placeArea(draggedShown, "database", "left", "bottom"),
        );

        const afterReturn = returnPanelArea(afterPlace, "database");
        expect(arrangementLeaves(afterReturn)).toContain("coach");
        expect(shownArrangement(afterReturn, hidden)).toEqual(draggedShown);
    });

    test("preserves a hidden panel on the second side of its parent split and updates inner splits on the first side", () => {
        const stored: BoardArrangement = {
            direction: "row",
            splitPercentage: 75,
            first: {
                direction: "row",
                splitPercentage: 50,
                first: "left",
                second: {
                    direction: "column",
                    splitPercentage: 40,
                    first: "topRight",
                    second: "bottomRight",
                },
            },
            second: "coach",
        };
        const hidden = new Set<PanelAreaId>(["coach"]);
        const draggedShown: BoardArrangement = {
            direction: "row",
            splitPercentage: 62,
            first: "left",
            second: {
                direction: "column",
                splitPercentage: 55,
                first: "topRight",
                second: "bottomRight",
            },
        };
        const updated = applyShownSplits(stored, draggedShown, hidden);
        expect(updated).toEqual({
            direction: "row",
            splitPercentage: 75,
            first: {
                direction: "row",
                splitPercentage: 62,
                first: "left",
                second: {
                    direction: "column",
                    splitPercentage: 55,
                    first: "topRight",
                    second: "bottomRight",
                },
            },
            second: "coach",
        });
        expect(shownArrangement(updated, hidden)).toEqual(draggedShown);
    });

    test("hides the tab strip with its place and split kept, and a panel returned while hidden joins the strip", () => {
        // Felix's layout: Database above the board column's right side, notation and Annotate below.
        const stored: BoardArrangement = {
            direction: "row",
            splitPercentage: 45,
            first: "left",
            second: {
                direction: "column",
                splitPercentage: 35,
                first: "database",
                second: {
                    direction: "row",
                    splitPercentage: 50,
                    first: {
                        direction: "column",
                        splitPercentage: 40,
                        first: "topRight",
                        second: "bottomRight",
                    },
                    second: "annotate",
                },
            },
        };
        const hidden = new Set<HideableAreaId>(["topRight"]);
        const shown = shownArrangement(stored, hidden);
        expect(arrangementLeaves(shown)).toEqual(["left", "database", "bottomRight", "annotate"]);

        // A divider moved while hidden keeps the strip's own 40 % split and its place above the notation.
        const draggedShown: BoardArrangement = {
            direction: "row",
            splitPercentage: 45,
            first: "left",
            second: {
                direction: "column",
                splitPercentage: 35,
                first: "database",
                second: {
                    direction: "row",
                    splitPercentage: 60,
                    first: "bottomRight",
                    second: "annotate",
                },
            },
        };
        const afterDrag = applyShownSplits(stored, draggedShown, hidden);
        expect(afterDrag).toEqual({
            ...stored,
            second: {
                ...(stored as { second: object }).second,
                second: {
                    direction: "row",
                    splitPercentage: 60,
                    first: {
                        direction: "column",
                        splitPercentage: 40,
                        first: "topRight",
                        second: "bottomRight",
                    },
                    second: "annotate",
                },
            },
        });
        // Showing again restores the full stored tree.
        expect(shownArrangement(afterDrag, new Set())).toBe(afterDrag);

        // Returning Annotate while hidden removes its area; the strip keeps its place.
        const afterReturn = returnPanelArea(afterDrag, "annotate");
        expect(arrangementLeaves(afterReturn)).toEqual([
            "left",
            "database",
            "topRight",
            "bottomRight",
        ]);
        expect(isValidBoardArrangement(afterReturn)).toBe(true);
        expect(arrangementLeaves(shownArrangement(afterReturn, hidden))).toEqual([
            "left",
            "database",
            "bottomRight",
        ]);
    });

    test("returns stored unchanged when no hidden panel is present or structure mismatches", () => {
        const stored = defaultBoardArrangement();
        expect(shownArrangement(stored, new Set())).toBe(stored);
        expect(shownArrangement(stored, new Set<PanelAreaId>(["coach"]))).toBe(stored);
        expect(applyShownSplits(stored, "left", new Set())).toBe(stored);
    });
});

describe("computeCarryOverArrangement", () => {
    test("clean profile returns default with hasLegacyValues false", () => {
        const result = computeCarryOverArrangement(emptyLegacy());
        expect(result).toEqual({
            arrangement: defaultBoardArrangement(),
            hasLegacyValues: false,
        });
    });

    test("heights-only profile counts as legacy and yields default", () => {
        const result = computeCarryOverArrangement(
            emptyLegacy({ detachedExplorerHeights: JSON.stringify({ tabs: 240 }) }),
        );
        expect(result).toEqual({
            arrangement: defaultBoardArrangement(),
            hasLegacyValues: true,
        });
    });

    test("carries over a valid three-area windowsState when beside is off", () => {
        const customTree = {
            direction: "column" as const,
            splitPercentage: 72,
            first: "bottomRight" as const,
            second: {
                direction: "row" as const,
                splitPercentage: 31,
                first: "topRight" as const,
                second: "left" as const,
            },
        };
        const result = computeCarryOverArrangement(
            emptyLegacy({ windowsState: JSON.stringify({ currentNode: customTree }) }),
        );
        expect(result).toEqual({ arrangement: customTree, hasLegacyValues: true });
    });

    test.each([
        JSON.stringify({ currentNode: null }),
        JSON.stringify({ currentNode: "left" }),
        JSON.stringify({ currentNode: { direction: "row", first: "left", second: "topRight" } }),
        "{",
        JSON.stringify({ currentNode: "obsolete" }),
    ])("falls back to default when windowsState %s does not hold all three base areas", (raw) => {
        const result = computeCarryOverArrangement(emptyLegacy({ windowsState: raw }));
        expect(result).toEqual({
            arrangement: defaultBoardArrangement(),
            hasLegacyValues: true,
        });
    });

    test("carries over beside arrangement without and with stored split positions", () => {
        expect(computeCarryOverArrangement(emptyLegacy({ panelsBesideNotation: "true" }))).toEqual({
            arrangement: {
                direction: "row",
                first: "left",
                second: { direction: "row", first: "bottomRight", second: "topRight" },
            },
            hasLegacyValues: true,
        });

        expect(
            computeCarryOverArrangement(
                emptyLegacy({
                    panelsBesideNotation: "true",
                    boardBesideSplits: JSON.stringify({ board: 42, notation: 61.5 }),
                }),
            ),
        ).toEqual({
            arrangement: {
                direction: "row",
                splitPercentage: 42,
                first: "left",
                second: {
                    direction: "row",
                    splitPercentage: 61.5,
                    first: "bottomRight",
                    second: "topRight",
                },
            },
            hasLegacyValues: true,
        });

        // Partially valid splits keep the valid field and drop the invalid one.
        expect(
            computeCarryOverArrangement(
                emptyLegacy({
                    panelsBesideNotation: "true",
                    boardBesideSplits: JSON.stringify({ board: 42, notation: 140 }),
                }),
            ),
        ).toEqual({
            arrangement: {
                direction: "row",
                splitPercentage: 42,
                first: "left",
                second: { direction: "row", first: "bottomRight", second: "topRight" },
            },
            hasLegacyValues: true,
        });
    });

    test("beside base takes precedence over a valid three-area windowsState", () => {
        const customWindows = {
            direction: "column" as const,
            splitPercentage: 72,
            first: "bottomRight" as const,
            second: {
                direction: "row" as const,
                splitPercentage: 31,
                first: "topRight" as const,
                second: "left" as const,
            },
        };
        const result = computeCarryOverArrangement(
            emptyLegacy({
                panelsBesideNotation: "true",
                windowsState: JSON.stringify({ currentNode: customWindows }),
            }),
        );
        expect(result).toEqual({
            arrangement: {
                direction: "row",
                first: "left",
                second: { direction: "row", first: "bottomRight", second: "topRight" },
            },
            hasLegacyValues: true,
        });
    });

    test.each(["[50, 50]", "not json"])(
        "beside arrangement with unparseable boardBesideSplits %s drops splits without throwing",
        (rawSplits) => {
            const result = computeCarryOverArrangement(
                emptyLegacy({
                    panelsBesideNotation: "true",
                    boardBesideSplits: rawSplits,
                }),
            );
            expect(result).toEqual({
                arrangement: {
                    direction: "row",
                    first: "left",
                    second: { direction: "row", first: "bottomRight", second: "topRight" },
                },
                hasLegacyValues: true,
            });
        },
    );

    test.each([
        [
            null,
            {
                direction: "row",
                first: "left",
                second: {
                    direction: "column",
                    first: {
                        direction: "column",
                        first: "database",
                        second: "topRight",
                        splitPercentage: 30,
                    },
                    second: "bottomRight",
                },
            },
        ],
        [
            '"tabs"',
            {
                direction: "row",
                first: "left",
                second: {
                    direction: "column",
                    first: {
                        direction: "column",
                        first: "database",
                        second: "topRight",
                        splitPercentage: 30,
                    },
                    second: "bottomRight",
                },
            },
        ],
        [
            '"notation"',
            {
                direction: "row",
                first: "left",
                second: {
                    direction: "column",
                    first: "topRight",
                    second: {
                        direction: "column",
                        first: "database",
                        second: "bottomRight",
                        splitPercentage: 30,
                    },
                },
            },
        ],
        [
            '"belowNotation"',
            {
                direction: "row",
                first: "left",
                second: {
                    direction: "column",
                    first: "topRight",
                    second: {
                        direction: "column",
                        first: "bottomRight",
                        second: "database",
                        splitPercentage: 70,
                    },
                },
            },
        ],
        [
            '"board"',
            {
                direction: "row",
                first: {
                    direction: "column",
                    first: "left",
                    second: "database",
                    splitPercentage: 70,
                },
                second: {
                    direction: "column",
                    first: "topRight",
                    second: "bottomRight",
                },
            },
        ],
    ] as const)(
        "carries over pinned Database with beside off and placement %s",
        (placement, expected) => {
            const result = computeCarryOverArrangement(
                emptyLegacy({
                    detachedExplorer: "true",
                    detachedExplorerPlacement: placement,
                }),
            );
            expect(result).toEqual({ arrangement: expected, hasLegacyValues: true });
            expect(isValidBoardArrangement(result.arrangement)).toBe(true);
        },
    );

    test.each([
        [
            null,
            {
                direction: "row",
                splitPercentage: 45,
                first: "left",
                second: {
                    direction: "column",
                    splitPercentage: 30,
                    first: "database",
                    second: {
                        direction: "row",
                        splitPercentage: 55,
                        first: "bottomRight",
                        second: "topRight",
                    },
                },
            },
        ],
        [
            '"tabs"',
            {
                direction: "row",
                splitPercentage: 45,
                first: "left",
                second: {
                    direction: "column",
                    splitPercentage: 30,
                    first: "database",
                    second: {
                        direction: "row",
                        splitPercentage: 55,
                        first: "bottomRight",
                        second: "topRight",
                    },
                },
            },
        ],
        [
            '"notation"',
            {
                direction: "row",
                splitPercentage: 45,
                first: "left",
                second: {
                    direction: "row",
                    splitPercentage: 55,
                    first: {
                        direction: "column",
                        splitPercentage: 30,
                        first: "database",
                        second: "bottomRight",
                    },
                    second: "topRight",
                },
            },
        ],
        [
            '"belowNotation"',
            {
                direction: "row",
                splitPercentage: 45,
                first: "left",
                second: {
                    direction: "row",
                    splitPercentage: 55,
                    first: {
                        direction: "column",
                        splitPercentage: 70,
                        first: "bottomRight",
                        second: "database",
                    },
                    second: "topRight",
                },
            },
        ],
        [
            '"board"',
            {
                direction: "row",
                splitPercentage: 45,
                first: {
                    direction: "column",
                    splitPercentage: 70,
                    first: "left",
                    second: "database",
                },
                second: {
                    direction: "row",
                    splitPercentage: 55,
                    first: "bottomRight",
                    second: "topRight",
                },
            },
        ],
    ] as const)(
        "carries over pinned Database with beside on, splits and placement %s",
        (placement, expected) => {
            const result = computeCarryOverArrangement(
                emptyLegacy({
                    panelsBesideNotation: "true",
                    boardBesideSplits: JSON.stringify({ board: 45, notation: 55 }),
                    detachedExplorer: "true",
                    detachedExplorerPlacement: placement,
                }),
            );
            expect(result).toEqual({ arrangement: expected, hasLegacyValues: true });
            expect(isValidBoardArrangement(result.arrangement)).toBe(true);
        },
    );

    test("ignores detached-explorer-placement when detached-explorer is false or unparseable", () => {
        for (const rawDetached of ["false", '"yes"', "{"]) {
            const result = computeCarryOverArrangement(
                emptyLegacy({
                    detachedExplorer: rawDetached,
                    detachedExplorerPlacement: '"board"',
                }),
            );
            expect(result).toEqual({
                arrangement: defaultBoardArrangement(),
                hasLegacyValues: true,
            });
        }
    });

    test("treats unparseable legacy values as absent without throwing", () => {
        const result = computeCarryOverArrangement({
            windowsState: "{bad",
            panelsBesideNotation: '"yes"',
            boardBesideSplits: "[50, 50]",
            detachedExplorer: "true",
            detachedExplorerPlacement: '"nowhere"',
            detachedExplorerHeights: "{",
        });
        // Unparseable placement defaults to "tabs" on the default base.
        expect(result).toEqual({
            arrangement: {
                direction: "row",
                first: "left",
                second: {
                    direction: "column",
                    first: {
                        direction: "column",
                        first: "database",
                        second: "topRight",
                        splitPercentage: 30,
                    },
                    second: "bottomRight",
                },
            },
            hasLegacyValues: true,
        });
        expect(isValidBoardArrangement(result.arrangement)).toBe(true);
    });
});
