import type { TFunction } from "i18next";
import {
    areaSplitShare,
    arrangementLeaves,
    type BoardAreaId,
    type BoardArrangement,
    canTakeOutEngine,
    canTakeOutPanel,
    engineIdFromArea,
    type HideableAreaId,
    isEngineArea,
    isPanelArea,
    placeArea,
    type PlacementSide,
    returnEngineArea,
    returnPanelArea,
    shownArrangement,
} from "@/state/boardArrangement";
import { arrangementFitsWidth } from "@/state/paneLayout";

export type ArrangeTarget =
    | { kind: "place"; target: BoardAreaId; side: PlacementSide }
    | { kind: "return" };

export type DragTarget = ArrangeTarget | { kind: "reorder"; index: number };

export type ReturnZone = "tabs" | "engines";

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
 * the tabs" / return when `area` is a detached panel or engine area.
 */
export function validArrangeTargets({
    area,
    stored,
    displayed,
    hiddenAreas,
    width,
    rootFont,
}: {
    area: BoardAreaId;
    stored: BoardArrangement;
    displayed: BoardArrangement;
    hiddenAreas: ReadonlySet<HideableAreaId>;
    width: number;
    rootFont: number;
}): ArrangeTarget[] {
    if (area === "left") return [];

    const displayedLeaves = arrangementLeaves(displayed);
    const inTree = displayedLeaves.includes(area);
    if (!inTree) {
        if (isPanelArea(area)) {
            if (!canTakeOutPanel(stored, area)) return [];
        } else if (isEngineArea(area)) {
            if (!canTakeOutEngine(stored, area)) return [];
        } else {
            return [];
        }
    }

    const targets: ArrangeTarget[] = [];
    for (const target of displayedLeaves) {
        if (target === area) continue;
        for (const side of PLACEMENT_SIDES) {
            const nextStored = placeArea(stored, area, target, side);
            if (nextStored === stored) continue;
            const nextShown = shownArrangement(nextStored, hiddenAreas);
            if (arrangementFitsWidth(nextShown, width, rootFont)) {
                targets.push({ kind: "place", target, side });
            }
        }
    }

    if (inTree && (isPanelArea(area) || isEngineArea(area))) {
        const nextStored = isPanelArea(area)
            ? returnPanelArea(stored, area)
            : returnEngineArea(stored, area);
        if (nextStored !== stored) {
            const nextShown = shownArrangement(nextStored, hiddenAreas);
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

/** Intersection of two rectangles, or `null` when they do not overlap with positive area. */
export function intersectRects(a: RectBox, b: RectBox): RectBox | null {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);
    const width = right - left;
    const height = bottom - top;
    return width > 0 && height > 0 ? { left, top, right, bottom, width, height } : null;
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
 * Resolves a reorder insertion slot (0..cardRects.length) within `cardRects` (ordered
 * top-to-bottom) when `(x, y)` lies inside `containerRect`. Returns `null` when outside
 * `containerRect` or when dropping at that slot would leave `currentIndex` unchanged.
 */
export function hitTestReorderSlot({
    x,
    y,
    containerRect,
    cardRects,
    currentIndex,
}: {
    x: number;
    y: number;
    containerRect: RectBox;
    cardRects: readonly RectBox[];
    currentIndex: number;
}): number | null {
    if (cardRects.length < 2 || currentIndex < 0 || currentIndex >= cardRects.length) return null;
    if (!pointInRect(x, y, containerRect)) return null;
    let slot = cardRects.length;
    for (let i = 0; i < cardRects.length; i += 1) {
        const midpoint = cardRects[i].top + cardRects[i].height / 2;
        if (y < midpoint) {
            slot = i;
            break;
        }
    }
    if (slot === currentIndex || slot === currentIndex + 1) return null;
    return slot;
}

/** Computes a thin horizontal insertion indicator relative to `layoutRect` for a reorder slot. */
export function reorderPreviewBox(
    slot: number,
    layoutRect: RectBox,
    cardRects: readonly RectBox[],
): PreviewBox | null {
    if (cardRects.length === 0 || slot < 0 || slot > cardRects.length) return null;
    const BAR_HEIGHT = 4;
    let top: number;
    if (slot === 0) {
        top = cardRects[0].top - layoutRect.top - BAR_HEIGHT / 2;
    } else if (slot === cardRects.length) {
        top = cardRects[cardRects.length - 1].bottom - layoutRect.top - BAR_HEIGHT / 2;
    } else {
        top =
            (cardRects[slot - 1].bottom + cardRects[slot].top) / 2 -
            layoutRect.top -
            BAR_HEIGHT / 2;
    }
    return {
        left: cardRects[0].left - layoutRect.left,
        top,
        width: cardRects[0].width,
        height: BAR_HEIGHT,
    };
}

/**
 * Resolves the hovered drop target under pointer coordinates `(x, y)` among `validTargets`.
 * Over the return zone (tab list, or the Analysis area's header for an engine window) a detached
 * area targets "return"; otherwise the tile under the pointer chooses its nearest edge if valid.
 */
export function hitTestArrangeTarget({
    x,
    y,
    area,
    validTargets,
    tileRects,
    returnRect,
}: {
    x: number;
    y: number;
    area: BoardAreaId;
    validTargets: readonly ArrangeTarget[];
    tileRects: ReadonlyMap<BoardAreaId, RectBox>;
    returnRect: RectBox | null;
}): ArrangeTarget | null {
    const canReturn = validTargets.some((item) => item.kind === "return");
    if (canReturn && returnRect && pointInRect(x, y, returnRect)) {
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
    returnRect: RectBox | null,
    movingArea?: BoardAreaId,
): PreviewBox | null {
    if (target.kind === "return") {
        if (!returnRect) return null;
        return {
            left: returnRect.left - layoutRect.left,
            top: returnRect.top - layoutRect.top,
            width: returnRect.width,
            height: returnRect.height,
        };
    }

    const rect = tileRects.get(target.target);
    if (!rect) return null;
    const relLeft = rect.left - layoutRect.left;
    const relTop = rect.top - layoutRect.top;
    const ratio = (movingArea ? areaSplitShare(movingArea) : 50) / 100;
    switch (target.side) {
        case "left":
            return { left: relLeft, top: relTop, width: rect.width * ratio, height: rect.height };
        case "right":
            return {
                left: relLeft + rect.width * (1 - ratio),
                top: relTop,
                width: rect.width * ratio,
                height: rect.height,
            };
        case "top":
            return { left: relLeft, top: relTop, width: rect.width, height: rect.height * ratio };
        case "bottom":
            return {
                left: relLeft,
                top: relTop + rect.height * (1 - ratio),
                width: rect.width,
                height: rect.height * ratio,
            };
    }
}

/** Localized display name of a board area (uses literal keys for i18n extraction). */
export function areaDisplayName(
    t: TFunction,
    area: BoardAreaId,
    resolveEngineName?: (engineId: string) => string | undefined,
): string {
    if (isEngineArea(area)) {
        const name = resolveEngineName?.(engineIdFromArea(area))?.trim();
        return name || t("Common.Engine");
    }
    switch (area) {
        case "left":
            return t("Board.Area.Board");
        case "topRight":
            return t("Board.Area.Tabs");
        case "bottomRight":
            return t("Board.Area.Notation");
        case "analysis":
            return t("Board.Tabs.Analysis");
        case "report":
            return t("Board.Analysis.Report");
        case "database":
            return t("Board.Tabs.Database");
        case "annotate":
            return t("Board.Tabs.Annotate");
        case "coach":
            return t("Board.Tabs.Coach");
        case "photo":
            return t("Board.Tabs.Photo");
        case "info":
            return t("Board.Tabs.Info");
    }
}

/** Localized accessible label for a placement target (uses literal keys for i18n extraction). */
export function arrangeTargetLabel(
    t: TFunction,
    target: ArrangeTarget,
    resolveEngineName?: (engineId: string) => string | undefined,
    movingArea?: BoardAreaId,
): string {
    if (target.kind === "return") {
        return movingArea && isEngineArea(movingArea)
            ? t("Board.Arrange.BackIntoEngines")
            : t("Board.Arrange.BackIntoTabs");
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
    const area = areaDisplayName(t, target.target, resolveEngineName);
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
