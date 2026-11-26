import { describe, expect, test } from "vitest";
import {
    applyRetiredEngineCarryOver,
    applyShownSplits,
    arrangementEngineAreas,
    arrangementLeaves,
    arrangementPanelAreas,
    type BoardArrangement,
    canTakeOutEngine,
    canTakeOutPanel,
    computeCarryOverArrangement,
    defaultBoardArrangement,
    engineAreaId,
    engineIdFromArea,
    enginePlaceholderAreaId,
    hiddenEngineAreas,
    type HideableAreaId,
    isEngineArea,
    isEnginePlaceholderArea,
    isEnginePlaceholderId,
    isValidBoardArrangement,
    type LegacyLayoutValues,
    MAX_ENGINE_AREAS,
    type PanelAreaId,
    placeArea,
    resolveArrangementEngines,
    type RetiredEngineValues,
    returnEngineArea,
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
            "strip rule violated (all five always-present panels)",
            {
                direction: "row",
                first: {
                    direction: "column",
                    first: "left",
                    second: {
                        direction: "row",
                        first: "analysis",
                        second: { direction: "row", first: "report", second: "database" },
                    },
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

    test.each([
        [
            "left",
            { direction: "row", first: engineAreaId("sf"), second: "left", splitPercentage: 30 },
        ],
        [
            "right",
            { direction: "row", first: "left", second: engineAreaId("sf"), splitPercentage: 70 },
        ],
        [
            "top",
            { direction: "column", first: engineAreaId("sf"), second: "left", splitPercentage: 30 },
        ],
        [
            "bottom",
            { direction: "column", first: "left", second: engineAreaId("sf"), splitPercentage: 70 },
        ],
    ] as const)(
        "places an engine window on the %s side of a target with a 30 %% share",
        (side, expected) => {
            const result = placeArea(defaultBoardArrangement(), engineAreaId("sf"), "left", side);
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
        },
    );

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

        // Strip rule: taking out the fifth always-present panel is refused, while coach and
        // moving an already-present panel are allowed.
        let fourOut = placeArea(start, "analysis", "left", "bottom");
        fourOut = placeArea(fourOut, "report", "left", "top");
        fourOut = placeArea(fourOut, "database", "topRight", "top");
        fourOut = placeArea(fourOut, "annotate", "bottomRight", "bottom");
        expect(canTakeOutPanel(fourOut, "info")).toBe(false);
        expect(canTakeOutPanel(fourOut, "analysis")).toBe(false);
        expect(canTakeOutPanel(fourOut, "coach")).toBe(true);
        expect(placeArea(fourOut, "info", "left", "right")).toBe(fourOut);

        const withCoach = placeArea(fourOut, "coach", "topRight", "right");
        expect(withCoach).not.toBe(fourOut);
        expect(isValidBoardArrangement(withCoach)).toBe(true);

        expect(canTakeOutPanel(withCoach, "photo")).toBe(true);
        const withPhoto = placeArea(withCoach, "photo", "left", "right");
        expect(withPhoto).not.toBe(withCoach);
        expect(isValidBoardArrangement(withPhoto)).toBe(true);
        expect(boardArrangementSchema.safeParse(withPhoto).success).toBe(true);

        const movedExisting = placeArea(fourOut, "database", "left", "right");
        expect(movedExisting).not.toBe(fourOut);
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

    test("accepts arrangements naming photo and keeps legacy arrangements valid; photo can be hidden and keeps splits", () => {
        const legacyWithoutPhoto: BoardArrangement = {
            direction: "row",
            first: "left",
            second: {
                direction: "column",
                first: "coach",
                second: { direction: "column", first: "topRight", second: "bottomRight" },
            },
        };
        expect(isValidBoardArrangement(legacyWithoutPhoto)).toBe(true);

        const storedWithPhoto: BoardArrangement = {
            direction: "row",
            splitPercentage: 48,
            first: "left",
            second: {
                direction: "column",
                splitPercentage: 35,
                first: "photo",
                second: {
                    direction: "column",
                    splitPercentage: 40,
                    first: "topRight",
                    second: "bottomRight",
                },
            },
        };
        expect(isValidBoardArrangement(storedWithPhoto)).toBe(true);
        expect(boardArrangementSchema.safeParse(storedWithPhoto).success).toBe(true);

        const hidden = new Set<PanelAreaId>(["photo"]);
        const shown = shownArrangement(storedWithPhoto, hidden);
        expect(arrangementLeaves(shown)).toEqual(["left", "topRight", "bottomRight"]);
        const dragged = applyShownSplits(
            storedWithPhoto,
            {
                direction: "row",
                splitPercentage: 60,
                first: "left",
                second: {
                    direction: "column",
                    splitPercentage: 55,
                    first: "topRight",
                    second: "bottomRight",
                },
            },
            hidden,
        );
        expect(dragged).toEqual({
            direction: "row",
            splitPercentage: 60,
            first: "left",
            second: {
                direction: "column",
                splitPercentage: 35,
                first: "photo",
                second: {
                    direction: "column",
                    splitPercentage: 55,
                    first: "topRight",
                    second: "bottomRight",
                },
            },
        });
        expect(shownArrangement(dragged, new Set())).toBe(dragged);
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

function emptyRetiredEngine(overrides: Partial<RetiredEngineValues> = {}): RetiredEngineValues {
    return {
        detachedEngine: null,
        detachedEnginePlacement: null,
        detachedEngineLines: null,
        ...overrides,
    };
}

describe("engine leaves: validation, bounds, place/return, hide and prune", () => {
    test("accepts engine leaves up to MAX_ENGINE_AREAS (including ids with ':') and rejects a fifth or empty id", () => {
        expect(MAX_ENGINE_AREAS).toBe(4);
        const colonId = "legacy-engine-identity:stockfish:16";
        const colonArea = engineAreaId(colonId);
        expect(isEngineArea(colonArea)).toBe(true);
        expect(engineIdFromArea(colonArea)).toBe(colonId);
        expect(isEngineArea("engine:")).toBe(false);
        expect(isEngineArea("analysis")).toBe(false);

        // Empty engine id rejected by validation, canTakeOutEngine and placeArea.
        const withEmptyEngine = {
            direction: "row",
            first: { direction: "column", first: "left", second: "engine:" },
            second: { direction: "column", first: "topRight", second: "bottomRight" },
        };
        expect(isValidBoardArrangement(withEmptyEngine)).toBe(false);
        const base = defaultBoardArrangement();
        expect(canTakeOutEngine(base, "engine:" as `engine:${string}`)).toBe(false);
        expect(placeArea(base, "engine:" as `engine:${string}`, "left", "bottom")).toBe(base);

        // Up to 4 engine leaves can be placed; the 5th is refused, while moving an existing one works.
        let arr = base;
        const ids = [colonId, "eng-2", "eng-3", "eng-4"];
        for (const id of ids) {
            const area = engineAreaId(id);
            expect(canTakeOutEngine(arr, area)).toBe(true);
            arr = placeArea(arr, area, "left", "bottom");
            expect(isValidBoardArrangement(arr)).toBe(true);
        }
        expect(arrangementEngineAreas(arr)).toEqual([...ids].reverse().map(engineAreaId));

        const fifth = engineAreaId("eng-5");
        expect(canTakeOutEngine(arr, fifth)).toBe(false);
        expect(placeArea(arr, fifth, "left", "bottom")).toBe(arr);

        // Manually constructing a 5-engine tree fails validation.
        const fiveEngines: BoardArrangement = {
            direction: "row",
            first: { direction: "column", first: "left", second: fifth },
            second: {
                direction: "column",
                first: {
                    direction: "row",
                    first: engineAreaId("eng-1"),
                    second: engineAreaId("eng-2"),
                },
                second: {
                    direction: "row",
                    first: {
                        direction: "column",
                        first: engineAreaId("eng-3"),
                        second: engineAreaId("eng-4"),
                    },
                    second: { direction: "column", first: "topRight", second: "bottomRight" },
                },
            },
        };
        expect(isValidBoardArrangement(fiveEngines)).toBe(false);

        // Moving an already-present engine while at cap 4 is allowed.
        const moved = placeArea(arr, colonArea, "topRight", "top");
        expect(moved).not.toBe(arr);
        expect(isValidBoardArrangement(moved)).toBe(true);

        // Returning an engine leaf removes it and opens a slot below the cap.
        const returned = returnEngineArea(moved, colonArea);
        expect(arrangementEngineAreas(returned)).not.toContain(colonArea);
        expect(isValidBoardArrangement(returned)).toBe(true);
        expect(canTakeOutEngine(returned, fifth)).toBe(true);
        // Returning an absent engine leaf is a no-op.
        expect(returnEngineArea(returned, colonArea)).toBe(returned);
    });

    test("accepts maximum derived bounds (3 base + 4 panels + 4 engines in a depth-10 comb)", () => {
        const leaves = [
            "left",
            "topRight",
            "bottomRight",
            "analysis",
            "database",
            "annotate",
            "coach",
            engineAreaId("e1"),
            engineAreaId("e2"),
            engineAreaId("e3"),
            engineAreaId("e4"),
        ] as const;
        const comb = leaves
            .slice(0, -1)
            .reduceRight<BoardArrangement>(
                (acc, leaf) => ({ direction: "row", first: leaf, second: acc }),
                leaves[leaves.length - 1],
            );
        expect(isValidBoardArrangement(comb)).toBe(true);
    });

    test("two engines with the same name or same path stay two distinct leaves by immutable id", () => {
        const sameNameOrPath = [
            { id: "id-a", name: "Stockfish", path: "/bin/sf", loaded: true },
            { id: "id-b", name: "Stockfish", path: "/bin/sf", loaded: true },
        ];
        let arr = placeArea(
            defaultBoardArrangement(),
            engineAreaId(sameNameOrPath[0].id),
            "left",
            "bottom",
        );
        arr = placeArea(arr, engineAreaId(sameNameOrPath[1].id), "topRight", "top");
        expect(arrangementEngineAreas(arr)).toEqual([engineAreaId("id-a"), engineAreaId("id-b")]);
        expect(hiddenEngineAreas(arr, sameNameOrPath)).toEqual([]);
        expect(resolveArrangementEngines(arr, sameNameOrPath)).toBe(arr);
        // Unloading only id-a hides id-a without affecting id-b.
        expect(
            hiddenEngineAreas(arr, [{ ...sameNameOrPath[0], loaded: false }, sameNameOrPath[1]]),
        ).toEqual([engineAreaId("id-a")]);
    });

    test("displayed arrangement hides unloaded engines while keeping them stored and preserving splits", () => {
        const engA = engineAreaId("eng-a");
        const engB = engineAreaId("eng-b");
        const stored: BoardArrangement = {
            direction: "row",
            splitPercentage: 50,
            first: {
                direction: "column",
                splitPercentage: 70,
                first: "left",
                second: engA,
            },
            second: {
                direction: "column",
                splitPercentage: 30,
                first: engB,
                second: {
                    direction: "column",
                    splitPercentage: 45,
                    first: "topRight",
                    second: "bottomRight",
                },
            },
        };

        // Unloaded eng-a is hidden in shownArrangement, loaded eng-b stays visible.
        const hidden = new Set<HideableAreaId>(
            hiddenEngineAreas(stored, [
                { id: "eng-a", loaded: false },
                { id: "eng-b", loaded: true },
            ]),
        );
        expect([...hidden]).toEqual([engA]);
        const shown = shownArrangement(stored, hidden);
        expect(arrangementLeaves(shown)).toEqual(["left", engB, "topRight", "bottomRight"]);
        // Stored tree still retains eng-a.
        expect(arrangementLeaves(stored)).toContain(engA);

        // Divider drag on shown writes back without losing eng-a or its 70 % split.
        const dragged: BoardArrangement = {
            direction: "row",
            splitPercentage: 60,
            first: "left",
            second: {
                direction: "column",
                splitPercentage: 30,
                first: engB,
                second: {
                    direction: "column",
                    splitPercentage: 55,
                    first: "topRight",
                    second: "bottomRight",
                },
            },
        };
        const updated = applyShownSplits(stored, dragged, hidden);
        expect(updated).toEqual({
            direction: "row",
            splitPercentage: 60,
            first: {
                direction: "column",
                splitPercentage: 70,
                first: "left",
                second: engA,
            },
            second: {
                direction: "column",
                splitPercentage: 30,
                first: engB,
                second: {
                    direction: "column",
                    splitPercentage: 55,
                    first: "topRight",
                    second: "bottomRight",
                },
            },
        });

        // While the engine list is undefined (not yet loaded), all engine leaves are hidden.
        expect(hiddenEngineAreas(stored, undefined)).toEqual([engA, engB]);
    });

    test("resolveArrangementEngines prunes deleted real ids only with a loaded list lacking the id, never with undefined or placeholders", () => {
        const engA = engineAreaId("eng-a");
        const engB = engineAreaId("eng-b");
        const stored = placeArea(
            placeArea(defaultBoardArrangement(), engA, "left", "bottom"),
            engB,
            "topRight",
            "top",
        );

        // Absent/unloaded list: never prunes.
        expect(resolveArrangementEngines(stored, undefined)).toBe(stored);
        // Unloaded engine still in the list: never prunes.
        expect(
            resolveArrangementEngines(stored, [
                { id: "eng-a", loaded: false },
                { id: "eng-b", loaded: false },
            ]),
        ).toBe(stored);
        // Deleted engine absent from a loaded list: pruned.
        const pruned = resolveArrangementEngines(stored, [{ id: "eng-b", loaded: true }]);
        expect(arrangementEngineAreas(pruned)).toEqual([engB]);
        expect(isValidBoardArrangement(pruned)).toBe(true);
        // Empty loaded list: prunes all real engine leaves, but keeps placeholder leaves.
        expect(arrangementEngineAreas(resolveArrangementEngines(stored, []))).toEqual([]);
        const withPlaceholder = placeArea(
            defaultBoardArrangement(),
            enginePlaceholderAreaId(1),
            "left",
            "bottom",
        );
        expect(resolveArrangementEngines(withPlaceholder, [])).toBe(withPlaceholder);
    });

    test("resolveArrangementEngines with an already-present enabled engine assigns distinct enabled engines to placeholder and missing slots", () => {
        const existing = engineAreaId("eng-existing");
        const placeholder = enginePlaceholderAreaId(1);
        const missing = engineAreaId("eng-missing");
        const tree = placeArea(
            placeArea(
                placeArea(defaultBoardArrangement(), existing, "left", "bottom"),
                placeholder,
                "topRight",
                "top",
            ),
            missing,
            "bottomRight",
            "bottom",
        );

        const resolved = resolveArrangementEngines(
            tree,
            [
                { id: "eng-existing", loaded: true },
                { id: "eng-alt-1", loaded: true },
                { id: "eng-alt-2", loaded: true },
            ],
            { fallbackMissing: true },
        );
        expect(arrangementEngineAreas(resolved)).toEqual([
            existing,
            engineAreaId("eng-alt-1"),
            engineAreaId("eng-alt-2"),
        ]);
        expect(isValidBoardArrangement(resolved)).toBe(true);
    });

    test("resolveArrangementEngines enforces rules 1-4 for live layouts and apply-time fallback", () => {
        const p1 = enginePlaceholderAreaId(1);
        const p2 = enginePlaceholderAreaId(2);
        const disabled = engineAreaId("eng-disabled");
        const removed = engineAreaId("eng-removed");

        expect(isEnginePlaceholderId("@1")).toBe(true);
        expect(isEnginePlaceholderId("@12")).toBe(true);
        expect(isEnginePlaceholderId("@0")).toBe(false);
        expect(isEnginePlaceholderId("@")).toBe(false);
        expect(isEnginePlaceholderId("uuid-1")).toBe(false);
        expect(isEnginePlaceholderArea(p1)).toBe(true);
        expect(isEnginePlaceholderArea(disabled)).toBe(false);

        const tree = placeArea(
            placeArea(
                placeArea(defaultBoardArrangement(), p1, "left", "bottom"),
                disabled,
                "topRight",
                "top",
            ),
            removed,
            "bottomRight",
            "bottom",
        );

        // Rule 1: undefined engines leaves everything untouched.
        expect(resolveArrangementEngines(tree, undefined)).toBe(tree);
        expect(resolveArrangementEngines(tree, undefined, { fallbackMissing: true })).toBe(tree);

        // Rule 2 & 3 & 4 (live layout): disabled kept, placeholder resolved to first unused enabled, deleted pruned.
        const liveResolved = resolveArrangementEngines(tree, [
            { id: "eng-disabled", loaded: false },
            { id: "eng-enabled-1", loaded: true },
            { id: "eng-enabled-2", loaded: true },
        ]);
        expect(arrangementEngineAreas(liveResolved)).toEqual([
            engineAreaId("eng-enabled-1"),
            disabled,
        ]);
        expect(isValidBoardArrangement(liveResolved)).toBe(true);

        // Apply-time fallback: disabled kept, placeholder takes first enabled, missing real id takes second enabled.
        const applyResolved = resolveArrangementEngines(
            tree,
            [
                { id: "eng-disabled", loaded: false },
                { id: "eng-enabled-1", loaded: true },
                { id: "eng-enabled-2", loaded: true },
            ],
            { fallbackMissing: true },
        );
        expect(arrangementEngineAreas(applyResolved)).toEqual([
            engineAreaId("eng-enabled-1"),
            disabled,
            engineAreaId("eng-enabled-2"),
        ]);
        expect(isValidBoardArrangement(applyResolved)).toBe(true);

        // Apply-time fallback with no enabled engines: placeholder stays @1, missing real id becomes @2, disabled kept.
        const applyNoEnabled = resolveArrangementEngines(
            tree,
            [{ id: "eng-disabled", loaded: false }],
            { fallbackMissing: true },
        );
        expect(arrangementEngineAreas(applyNoEnabled)).toEqual([p1, disabled, p2]);
        expect(isValidBoardArrangement(applyNoEnabled)).toBe(true);
        expect(hiddenEngineAreas(applyNoEnabled, [{ id: "eng-disabled", loaded: false }])).toEqual([
            p1,
            disabled,
            p2,
        ]);
    });
});

describe("applyRetiredEngineCarryOver", () => {
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
                        first: "engine:eng-1",
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
                        first: "engine:eng-1",
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
                        first: "engine:eng-1",
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
                        second: "engine:eng-1",
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
                    second: "engine:eng-1",
                    splitPercentage: 70,
                },
                second: {
                    direction: "column",
                    first: "topRight",
                    second: "bottomRight",
                },
            },
        ],
        [
            '"nowhere"',
            {
                direction: "row",
                first: "left",
                second: {
                    direction: "column",
                    first: {
                        direction: "column",
                        first: "engine:eng-1",
                        second: "topRight",
                        splitPercentage: 30,
                    },
                    second: "bottomRight",
                },
            },
        ],
    ] as const)(
        "carries over retired pinned engine for placement %s at 30 %%",
        (placement, expected) => {
            const result = applyRetiredEngineCarryOver(
                defaultBoardArrangement(),
                emptyRetiredEngine({
                    detachedEngine: JSON.stringify("eng-1"),
                    detachedEnginePlacement: placement,
                }),
            );
            expect(result).toEqual({
                arrangement: expected,
                hasRetiredKeys: true,
                changed: true,
            });
            expect(isValidBoardArrangement(result.arrangement)).toBe(true);
        },
    );

    test.each(["null", '""', "{bad", "123", "true", "{}"])(
        "treats detached-engine=%s as absent while still flagging retired keys",
        (raw) => {
            const base = defaultBoardArrangement();
            const result = applyRetiredEngineCarryOver(
                base,
                emptyRetiredEngine({ detachedEngine: raw, detachedEnginePlacement: '"board"' }),
            );
            expect(result).toEqual({ arrangement: base, hasRetiredKeys: true, changed: false });
        },
    );

    test("leaves arrangement unchanged when engine leaf is already present or cap 4 is reached", () => {
        const withEng1 = placeArea(
            defaultBoardArrangement(),
            engineAreaId("eng-1"),
            "left",
            "bottom",
        );
        expect(
            applyRetiredEngineCarryOver(
                withEng1,
                emptyRetiredEngine({ detachedEngine: JSON.stringify("eng-1") }),
            ),
        ).toEqual({ arrangement: withEng1, hasRetiredKeys: true, changed: false });

        let atCap = defaultBoardArrangement();
        for (const id of ["e1", "e2", "e3", "e4"]) {
            atCap = placeArea(atCap, engineAreaId(id), "left", "bottom");
        }
        expect(
            applyRetiredEngineCarryOver(
                atCap,
                emptyRetiredEngine({ detachedEngine: JSON.stringify("e5") }),
            ),
        ).toEqual({ arrangement: atCap, hasRetiredKeys: true, changed: false });
    });
});
