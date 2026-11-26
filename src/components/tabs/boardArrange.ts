import type { TFunction } from "i18next";
import {
    arrangementLeaves,
    type BoardAreaId,
    type BoardArrangement,
    canTakeOutPanel,
    isPanelArea,
    type PanelAreaId,
    placeArea,
    type PlacementSide,
    returnPanelArea,
    shownArrangement,
} from "@/state/boardArrangement";
import { arrangementFitsWidth } from "@/state/paneLayout";

export type ArrangeTarget =
    | { kind: "place"; target: BoardAreaId; side: PlacementSide }
    | { kind: "return" };

export interface RectBox {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
}

export interface PreviewBox {
    left: number;
    top: number;
    width: number;
    height: number;
}

/** Reading order for the four sides of a target area. */
export const PLACEMENT_SIDES: readonly PlacementSide[] = ["top", "left", "right", "bottom"];

/**
 * Computes every target for moving `area` whose resulting shown arrangement fits `width` at
 * `rootFont`. Returns targets in reading order across the displayed leaves, followed by "Back into
 * the tabs" when `area` is a detached panel area.
 */
export function validArrangeTargets({
    area,
    stored,
    displayed,
    hiddenPanels,
    width,
    rootFont,
}: {
    area: BoardAreaId;
    stored: BoardArrangement;
    displayed: BoardArrangement;
    hiddenPanels: ReadonlySet<PanelAreaId>;
    width: number;
    rootFont: number;
}): ArrangeTarget[] {
    if (area === "left") return [];

    const displayedLeaves = arrangementLeaves(displayed);
    const inTree = displayedLeaves.includes(area);
    if (!inTree) {
        if (!isPanelArea(area) || !canTakeOutPanel(stored, area)) return [];
    }

    const targets: ArrangeTarget[] = [];
    for (const target of displayedLeaves) {
        if (target === area) continue;
        for (const side of PLACEMENT_SIDES) {
            const nextStored = placeArea(stored, area, target, side);
            if (nextStored === stored) continue;
            const nextShown = shownArrangement(nextStored, hiddenPanels);
            if (arrangementFitsWidth(nextShown, width, rootFont)) {
                targets.push({ kind: "place", target, side });
            }
        }
    }

    if (inTree && isPanelArea(area)) {
        const nextStored = returnPanelArea(stored, area);
        if (nextStored !== stored) {
            const nextShown = shownArrangement(nextStored, hiddenPanels);
            if (arrangementFitsWidth(nextShown, width, rootFont)) {
                targets.push({ kind: "return" });
            }
        }
    }

    return targets;
}

/** Whether `(x, y)` lies inside `rect`. */
export function pointInRect(x: number, y: number, rect: RectBox): boolean {
    return (
        rect.width > 0 &&
        rect.height > 0 &&
        x >= rect.left &&
        x <= rect.right &&
        y >= rect.top &&
        y <= rect.bottom
    );
}

/**
 * Picks the edge of `rect` closest to `(x, y)` using normalized distances so tall or wide tiles
 * treat all four sides proportionally. Returns `null` when the point is outside `rect`.
 */
export function nearestEdge(x: number, y: number, rect: RectBox): PlacementSide | null {
    if (!pointInRect(x, y, rect)) return null;
    const distances: Array<{ side: PlacementSide; ratio: number }> = [
        { side: "left", ratio: (x - rect.left) / rect.width },
        { side: "right", ratio: (rect.right - x) / rect.width },
        { side: "top", ratio: (y - rect.top) / rect.height },
        { side: "bottom", ratio: (rect.bottom - y) / rect.height },
    ];
    let best = distances[0];
    for (let i = 1; i < distances.length; i += 1) {
        if (distances[i].ratio < best.ratio) best = distances[i];
    }
    return best.side;
}

/**
 * Resolves the hovered drop target under pointer coordinates `(x, y)` among `validTargets`.
 * Over the tab list a detached panel area targets "Back into the tabs"; otherwise the tile under
 * the pointer chooses its nearest edge if that edge is in `validTargets`.
 */
export function hitTestArrangeTarget({
    x,
    y,
    area,
    validTargets,
    tileRects,
    tabListRect,
}: {
    x: number;
    y: number;
    area: BoardAreaId;
    validTargets: readonly ArrangeTarget[];
    tileRects: ReadonlyMap<BoardAreaId, RectBox>;
    tabListRect: RectBox | null;
}): ArrangeTarget | null {
    const canReturn = validTargets.some((item) => item.kind === "return");
    if (canReturn && tabListRect && pointInRect(x, y, tabListRect)) {
        return { kind: "return" };
    }

    for (const [tileId, rect] of tileRects) {
        if (tileId === area) continue;
        const side = nearestEdge(x, y, rect);
        if (!side) continue;
        const match = validTargets.find(
            (item) => item.kind === "place" && item.target === tileId && item.side === side,
        );
        return match ?? null;
    }

    return null;
}

/** Computes the preview rectangle relative to `layoutRect` for `target`. */
export function previewBoxForTarget(
    target: ArrangeTarget,
    layoutRect: RectBox,
    tileRects: ReadonlyMap<BoardAreaId, RectBox>,
    tabListRect: RectBox | null,
): PreviewBox | null {
    if (target.kind === "return") {
        if (!tabListRect) return null;
        return {
            left: tabListRect.left - layoutRect.left,
            top: tabListRect.top - layoutRect.top,
            width: tabListRect.width,
            height: tabListRect.height,
        };
    }

    const rect = tileRects.get(target.target);
    if (!rect) return null;
    const relLeft = rect.left - layoutRect.left;
    const relTop = rect.top - layoutRect.top;
    switch (target.side) {
        case "left":
            return { left: relLeft, top: relTop, width: rect.width / 2, height: rect.height };
        case "right":
            return {
                left: relLeft + rect.width / 2,
                top: relTop,
                width: rect.width / 2,
                height: rect.height,
            };
        case "top":
            return { left: relLeft, top: relTop, width: rect.width, height: rect.height / 2 };
        case "bottom":
            return {
                left: relLeft,
                top: relTop + rect.height / 2,
                width: rect.width,
                height: rect.height / 2,
            };
    }
}

/** Localized display name of a board area (uses literal keys for i18n extraction). */
export function areaDisplayName(t: TFunction, area: BoardAreaId): string {
    switch (area) {
        case "left":
            return t("Board.Area.Board");
        case "topRight":
            return t("Board.Area.Tabs");
        case "bottomRight":
            return t("Board.Area.Notation");
        case "analysis":
            return t("Board.Tabs.Analysis");
        case "database":
            return t("Board.Tabs.Database");
        case "annotate":
            return t("Board.Tabs.Annotate");
        case "coach":
            return t("Board.Tabs.Coach");
        case "info":
            return t("Board.Tabs.Info");
    }
}

/** Localized accessible label for a placement target (uses literal keys for i18n extraction). */
export function arrangeTargetLabel(t: TFunction, target: ArrangeTarget): string {
    if (target.kind === "return") {
        return t("Board.Arrange.BackIntoTabs");
    }
    if (target.target === "left") {
        switch (target.side) {
            case "left":
                return t("Board.Arrange.LeftOfBoard");
            case "right":
                return t("Board.Arrange.RightOfBoard");
            case "top":
                return t("Board.Arrange.AboveBoard");
            case "bottom":
                return t("Board.Arrange.BelowBoard");
        }
    }
    if (target.target === "bottomRight") {
        switch (target.side) {
            case "left":
                return t("Board.Arrange.LeftOfNotation");
            case "right":
                return t("Board.Arrange.RightOfNotation");
            case "top":
                return t("Board.Arrange.AboveNotation");
            case "bottom":
                return t("Board.Arrange.BelowNotation");
        }
    }
    if (target.target === "topRight") {
        switch (target.side) {
            case "left":
                return t("Board.Arrange.LeftOfTabs");
            case "right":
                return t("Board.Arrange.RightOfTabs");
            case "top":
                return t("Board.Arrange.AboveTabs");
            case "bottom":
                return t("Board.Arrange.BelowTabs");
        }
    }
    const area = areaDisplayName(t, target.target);
    switch (target.side) {
        case "left":
            return t("Board.Arrange.LeftOf", { area });
        case "right":
            return t("Board.Arrange.RightOf", { area });
        case "top":
            return t("Board.Arrange.Above", { area });
        case "bottom":
            return t("Board.Arrange.Below", { area });
    }
}
