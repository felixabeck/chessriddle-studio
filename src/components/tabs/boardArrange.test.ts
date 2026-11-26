import { describe, expect, test } from "vitest";
import {
    defaultBoardArrangement,
    engineAreaId,
    placeArea,
    type BoardAreaId,
    type BoardArrangement,
    type PanelAreaId,
} from "@/state/boardArrangement";
import {
    areaDisplayName,
    arrangeTargetLabel,
    hitTestArrangeTarget,
    hitTestReorderSlot,
    nearestEdge,
    previewBoxForTarget,
    reorderPreviewBox,
    type RectBox,
    validArrangeTargets,
} from "./boardArrange";

const EMPTY_SET: ReadonlySet<PanelAreaId> = new Set();

const THREE_PANE: BoardArrangement = {
    direction: "row",
    first: "left",
    second: {
        direction: "row",
        first: "bottomRight",
        second: "topRight",
    },
};

describe("validArrangeTargets", () => {
    test("never offers targets for the board", () => {
        const arrangement = defaultBoardArrangement();
        expect(
            validArrangeTargets({
                area: "left",
                stored: arrangement,
                displayed: arrangement,
                hiddenAreas: EMPTY_SET,
                width: 1440,
                rootFont: 16,
            }),
        ).toEqual([]);
    });

    test("enforces the strip rule when taking out the last always-present panel", () => {
        const fourTakenOut: BoardArrangement = {
            direction: "row",
            first: "left",
            second: {
                direction: "column",
                first: "analysis",
                second: {
                    direction: "column",
                    first: "report",
                    second: {
                        direction: "column",
                        first: "database",
                        second: {
                            direction: "column",
                            first: "annotate",
                            second: {
                                direction: "column",
                                first: "topRight",
                                second: "bottomRight",
                            },
                        },
                    },
                },
            },
        };
        expect(
            validArrangeTargets({
                area: "info",
                stored: fourTakenOut,
                displayed: fourTakenOut,
                hiddenAreas: EMPTY_SET,
                width: 1440,
                rootFont: 16,
            }),
        ).toEqual([]);
        // Coach is not an always-present panel and can still be taken out.
        expect(
            validArrangeTargets({
                area: "coach",
                stored: fourTakenOut,
                displayed: fourTakenOut,
                hiddenAreas: EMPTY_SET,
                width: 1440,
                rootFont: 16,
            }).length,
        ).toBeGreaterThan(0);
    });

    test("omits targets that would exceed width (3 panes fit, 4 do not)", () => {
        // At 16px root font: 3 panes need 972px, 4 panes need 1298px.
        const targets = validArrangeTargets({
            area: "database",
            stored: THREE_PANE,
            displayed: THREE_PANE,
            hiddenAreas: EMPTY_SET,
            width: 1100,
            rootFont: 16,
        });
        expect(targets.length).toBeGreaterThan(0);
        // Horizontal placement next to any of the 3 side-by-side panes would require 4 panes.
        expect(
            targets.some((t) => t.kind === "place" && (t.side === "left" || t.side === "right")),
        ).toBe(false);
        // Vertical placement above/below keeps widthInPanes === 3 and fits.
        expect(targets).toEqual([
            { kind: "place", target: "left", side: "top" },
            { kind: "place", target: "left", side: "bottom" },
            { kind: "place", target: "bottomRight", side: "top" },
            { kind: "place", target: "bottomRight", side: "bottom" },
            { kind: "place", target: "topRight", side: "top" },
            { kind: "place", target: "topRight", side: "bottom" },
        ]);
    });

    test("includes Back into the tabs only for detached panel areas", () => {
        const withDatabase: BoardArrangement = {
            direction: "row",
            first: { direction: "column", first: "left", second: "database" },
            second: { direction: "column", first: "topRight", second: "bottomRight" },
        };
        const dbTargets = validArrangeTargets({
            area: "database",
            stored: withDatabase,
            displayed: withDatabase,
            hiddenAreas: EMPTY_SET,
            width: 1440,
            rootFont: 16,
        });
        expect(dbTargets.at(-1)).toEqual({ kind: "return" });

        const notationTargets = validArrangeTargets({
            area: "bottomRight",
            stored: withDatabase,
            displayed: withDatabase,
            hiddenAreas: EMPTY_SET,
            width: 1440,
            rootFont: 16,
        });
        expect(notationTargets.some((t) => t.kind === "return")).toBe(false);
    });
});

describe("nearestEdge, hitTestArrangeTarget and previewBoxForTarget", () => {
    const layoutRect: RectBox = {
        left: 100,
        top: 50,
        right: 1100,
        bottom: 850,
        width: 1000,
        height: 800,
    };
    const boardRect: RectBox = {
        left: 100,
        top: 50,
        right: 600,
        bottom: 850,
        width: 500,
        height: 800,
    };
    const tabsRect: RectBox = {
        left: 600,
        top: 50,
        right: 1100,
        bottom: 450,
        width: 500,
        height: 400,
    };
    const returnRect: RectBox = {
        left: 604,
        top: 54,
        right: 1096,
        bottom: 94,
        width: 492,
        height: 40,
    };
    const tileRects = new Map<BoardAreaId, RectBox>([
        ["left", boardRect],
        ["topRight", tabsRect],
    ]);

    test("nearestEdge selects each of the four sides and rejects outside points", () => {
        expect(nearestEdge(120, 450, boardRect)).toBe("left");
        expect(nearestEdge(580, 450, boardRect)).toBe("right");
        expect(nearestEdge(350, 70, boardRect)).toBe("top");
        expect(nearestEdge(350, 830, boardRect)).toBe("bottom");
        expect(nearestEdge(50, 450, boardRect)).toBeNull();
    });

    test("hitTestArrangeTarget prefers Back into the tabs over the tab list for detached panels", () => {
        const valid = [
            { kind: "place" as const, target: "left" as const, side: "bottom" as const },
            { kind: "return" as const },
        ];
        expect(
            hitTestArrangeTarget({
                x: 700,
                y: 70,
                area: "database",
                validTargets: valid,
                tileRects,
                returnRect,
            }),
        ).toEqual({ kind: "return" });

        // Non-fitting side on a tile yields null.
        expect(
            hitTestArrangeTarget({
                x: 120,
                y: 450,
                area: "database",
                validTargets: valid,
                tileRects,
                returnRect,
            }),
        ).toBeNull();
    });

    test("previewBoxForTarget computes half-tile boxes and the tab-list box relative to layoutRect", () => {
        expect(
            previewBoxForTarget(
                { kind: "place", target: "left", side: "left" },
                layoutRect,
                tileRects,
                returnRect,
            ),
        ).toEqual({ left: 0, top: 0, width: 250, height: 800 });
        expect(
            previewBoxForTarget(
                { kind: "place", target: "left", side: "right" },
                layoutRect,
                tileRects,
                returnRect,
            ),
        ).toEqual({ left: 250, top: 0, width: 250, height: 800 });
        expect(
            previewBoxForTarget(
                { kind: "place", target: "left", side: "top" },
                layoutRect,
                tileRects,
                returnRect,
            ),
        ).toEqual({ left: 0, top: 0, width: 500, height: 400 });
        expect(
            previewBoxForTarget(
                { kind: "place", target: "left", side: "bottom" },
                layoutRect,
                tileRects,
                returnRect,
            ),
        ).toEqual({ left: 0, top: 400, width: 500, height: 400 });
        expect(previewBoxForTarget({ kind: "return" }, layoutRect, tileRects, returnRect)).toEqual({
            left: 504,
            top: 4,
            width: 492,
            height: 40,
        });

        // Engine windows preview with the same 30 % share that placeArea applies on each side.
        const eng = engineAreaId("sf");
        expect(
            previewBoxForTarget(
                { kind: "place", target: "left", side: "left" },
                layoutRect,
                tileRects,
                returnRect,
                eng,
            ),
        ).toEqual({ left: 0, top: 0, width: 150, height: 800 });
        expect(
            previewBoxForTarget(
                { kind: "place", target: "left", side: "right" },
                layoutRect,
                tileRects,
                returnRect,
                eng,
            ),
        ).toEqual({ left: 350, top: 0, width: 150, height: 800 });
        expect(
            previewBoxForTarget(
                { kind: "place", target: "left", side: "top" },
                layoutRect,
                tileRects,
                returnRect,
                eng,
            ),
        ).toEqual({ left: 0, top: 0, width: 500, height: 240 });
        expect(
            previewBoxForTarget(
                { kind: "place", target: "left", side: "bottom" },
                layoutRect,
                tileRects,
                returnRect,
                eng,
            ),
        ).toEqual({ left: 0, top: 560, width: 500, height: 240 });
    });

    test("arrangeTargetLabel uses grammatical base-area keys and parameterized panel keys", () => {
        const t = ((key: string, opts?: { area?: string }) =>
            opts?.area ? `${key}(${opts.area})` : key) as unknown as import("i18next").TFunction;
        expect(arrangeTargetLabel(t, { kind: "place", target: "left", side: "top" })).toBe(
            "Board.Arrange.AboveBoard",
        );
        expect(arrangeTargetLabel(t, { kind: "place", target: "bottomRight", side: "left" })).toBe(
            "Board.Arrange.LeftOfNotation",
        );
        expect(arrangeTargetLabel(t, { kind: "place", target: "topRight", side: "bottom" })).toBe(
            "Board.Arrange.BelowTabs",
        );
        expect(arrangeTargetLabel(t, { kind: "place", target: "database", side: "right" })).toBe(
            "Board.Arrange.RightOf(Board.Tabs.Database)",
        );
        expect(arrangeTargetLabel(t, { kind: "return" })).toBe("Board.Arrange.BackIntoTabs");
    });

    test("validArrangeTargets and labels support engine leaves up to the cap", () => {
        const eng = engineAreaId("legacy-engine-identity:sf");
        const base = defaultBoardArrangement();
        const pullOutTargets = validArrangeTargets({
            area: eng,
            stored: base,
            displayed: base,
            hiddenAreas: EMPTY_SET,
            width: 1440,
            rootFont: 16,
        });
        expect(pullOutTargets.length).toBeGreaterThan(0);
        expect(pullOutTargets.some((t) => t.kind === "return")).toBe(false);

        const withEng = placeArea(base, eng, "left", "bottom");
        const inTreeTargets = validArrangeTargets({
            area: eng,
            stored: withEng,
            displayed: withEng,
            hiddenAreas: EMPTY_SET,
            width: 1440,
            rootFont: 16,
        });
        expect(inTreeTargets.at(-1)).toEqual({ kind: "return" });

        // At cap 4, a 5th engine has no valid targets.
        let atCap = base;
        for (const id of ["e1", "e2", "e3", "e4"]) {
            atCap = placeArea(atCap, engineAreaId(id), "left", "bottom");
        }
        expect(
            validArrangeTargets({
                area: engineAreaId("e5"),
                stored: atCap,
                displayed: atCap,
                hiddenAreas: EMPTY_SET,
                width: 1440,
                rootFont: 16,
            }),
        ).toEqual([]);

        const t = ((key: string, opts?: { area?: string }) =>
            opts?.area ? `${key}(${opts.area})` : key) as unknown as import("i18next").TFunction;
        expect(
            areaDisplayName(t, eng, (id) =>
                id === "legacy-engine-identity:sf" ? "Stockfish" : undefined,
            ),
        ).toBe("Stockfish");
        expect(areaDisplayName(t, eng)).toBe("Common.Engine");
        expect(
            arrangeTargetLabel(t, { kind: "place", target: eng, side: "bottom" }, (id) =>
                id === "legacy-engine-identity:sf" ? "Stockfish" : undefined,
            ),
        ).toBe("Board.Arrange.Below(Stockfish)");
        expect(arrangeTargetLabel(t, { kind: "return" }, undefined, eng)).toBe(
            "Board.Arrange.BackIntoEngines",
        );
        expect(arrangeTargetLabel(t, { kind: "return" }, undefined, "database")).toBe(
            "Board.Arrange.BackIntoTabs",
        );
        expect(areaDisplayName(t, "report")).toBe("Board.Analysis.Report");
    });

    test("hitTestReorderSlot and reorderPreviewBox resolve insertion slots and skip no-op slots", () => {
        const containerRect: RectBox = {
            left: 10,
            top: 100,
            right: 210,
            bottom: 250,
            width: 200,
            height: 150,
        };
        const cardRects: RectBox[] = [
            { left: 10, top: 100, right: 210, bottom: 145, width: 200, height: 45 },
            { left: 10, top: 150, right: 210, bottom: 195, width: 200, height: 45 },
            { left: 10, top: 200, right: 210, bottom: 245, width: 200, height: 45 },
        ];
        // Dragging card 0: slots 0 and 1 are no-ops; slot 2 (above card 2) and slot 3 (after card 2) are valid.
        expect(
            hitTestReorderSlot({ x: 50, y: 110, containerRect, cardRects, currentIndex: 0 }),
        ).toBeNull();
        expect(
            hitTestReorderSlot({ x: 50, y: 160, containerRect, cardRects, currentIndex: 0 }),
        ).toBeNull();
        expect(
            hitTestReorderSlot({ x: 50, y: 210, containerRect, cardRects, currentIndex: 0 }),
        ).toBe(2);
        expect(
            hitTestReorderSlot({ x: 50, y: 240, containerRect, cardRects, currentIndex: 0 }),
        ).toBe(3);
        // Outside container returns null so board placement targets can take over.
        expect(
            hitTestReorderSlot({ x: 300, y: 210, containerRect, cardRects, currentIndex: 0 }),
        ).toBeNull();

        const layoutRect: RectBox = {
            left: 0,
            top: 0,
            right: 800,
            bottom: 600,
            width: 800,
            height: 600,
        };
        expect(reorderPreviewBox(2, layoutRect, cardRects)).toEqual({
            left: 10,
            top: 195.5,
            width: 200,
            height: 4,
        });
    });

    test("engine return zone hit-tests before Analysis tile edges while the rest of the Analysis tile keeps placement edges", () => {
        const eng = engineAreaId("sf");
        const layout = placeArea(
            placeArea(defaultBoardArrangement(), "analysis", "left", "right"),
            eng,
            "left",
            "bottom",
        );
        const targets = validArrangeTargets({
            area: eng,
            stored: layout,
            displayed: layout,
            hiddenAreas: EMPTY_SET,
            width: 1440,
            rootFont: 16,
        });
        const analysisTile: RectBox = {
            left: 400,
            top: 0,
            right: 800,
            bottom: 400,
            width: 400,
            height: 400,
        };
        const analysisHeader: RectBox = {
            left: 400,
            top: 0,
            right: 800,
            bottom: 32,
            width: 400,
            height: 32,
        };
        const tileRects = new Map<BoardAreaId, RectBox>([["analysis", analysisTile]]);

        // Over the Analysis header -> return.
        expect(
            hitTestArrangeTarget({
                x: 500,
                y: 16,
                area: eng,
                validTargets: targets,
                tileRects,
                returnRect: analysisHeader,
            }),
        ).toEqual({ kind: "return" });

        // Over the bottom of the Analysis tile -> place below Analysis.
        expect(
            hitTestArrangeTarget({
                x: 500,
                y: 380,
                area: eng,
                validTargets: targets,
                tileRects,
                returnRect: analysisHeader,
            }),
        ).toEqual({ kind: "place", target: "analysis", side: "bottom" });
    });
});
