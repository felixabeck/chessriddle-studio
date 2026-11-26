import type { MosaicNode } from "react-mosaic-component";
import { z } from "zod";

/** The three base areas always present on the analysis board: board, tab strip, notation. */
export const BASE_AREA_IDS = ["left", "topRight", "bottomRight"] as const;
export type BaseAreaId = (typeof BASE_AREA_IDS)[number];

/** Panels that can be taken out of the analysis board's tab strip as their own areas. */
export const PANEL_AREA_IDS = ["analysis", "database", "annotate", "coach", "info"] as const;
export type PanelAreaId = (typeof PANEL_AREA_IDS)[number];

/** Panels present on every analysis tab; at least one must remain in the tab strip. */
export const ALWAYS_PRESENT_PANEL_IDS = ["analysis", "database", "annotate", "info"] as const;

export const BOARD_AREA_IDS = [...BASE_AREA_IDS, ...PANEL_AREA_IDS] as const;
export type BoardAreaId = (typeof BOARD_AREA_IDS)[number];

export type BoardArrangement = MosaicNode<BoardAreaId>;

export type PlacementSide = "left" | "right" | "top" | "bottom";

export interface MosaicTreeBounds {
    maxNodes: number;
    maxDepth: number;
}

const WINDOWS_STATE_BOUNDS: MosaicTreeBounds = { maxNodes: 5, maxDepth: 2 };
// The strip rule caps a valid arrangement at 7 leaves (3 base + 3 always-present + coach): at most 13 nodes and depth 6.
const ARRANGEMENT_BOUNDS: MosaicTreeBounds = { maxNodes: 13, maxDepth: 6 };

const BASE_AREA_SET: ReadonlySet<BaseAreaId> = new Set(BASE_AREA_IDS);
const PANEL_AREA_SET: ReadonlySet<PanelAreaId> = new Set(PANEL_AREA_IDS);
const BOARD_AREA_SET: ReadonlySet<BoardAreaId> = new Set(BOARD_AREA_IDS);
const MOSAIC_NODE_KEYS: ReadonlySet<string> = new Set([
    "direction",
    "first",
    "second",
    "splitPercentage",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates a Mosaic binary tree's shape, node keys, directions, split positions, leaf
 * uniqueness and size bounds. Returns the set of leaves when valid, or `null` otherwise.
 */
export function validateMosaicTree<Leaf extends string>(
    value: unknown,
    allowedLeaves: ReadonlySet<Leaf>,
    bounds: MosaicTreeBounds,
): Set<Leaf> | null {
    const pending: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
    const leaves = new Set<Leaf>();
    let nodeCount = 0;

    while (pending.length > 0) {
        const current = pending.pop();
        if (!current) return null;
        const { node, depth } = current;
        if (++nodeCount > bounds.maxNodes || depth > bounds.maxDepth) return null;

        if (typeof node === "string") {
            if (!allowedLeaves.has(node as Leaf)) return null;
            const leaf = node as Leaf;
            if (leaves.has(leaf)) return null;
            leaves.add(leaf);
            continue;
        }

        if (!isRecord(node)) return null;
        if (Object.keys(node).some((key) => !MOSAIC_NODE_KEYS.has(key))) return null;
        if (node.direction !== "row" && node.direction !== "column") return null;
        if (!("first" in node) || !("second" in node)) return null;
        if (
            node.splitPercentage !== undefined &&
            (typeof node.splitPercentage !== "number" ||
                !Number.isFinite(node.splitPercentage) ||
                node.splitPercentage < 0 ||
                node.splitPercentage > 100)
        ) {
            return null;
        }

        pending.push({ node: node.first, depth: depth + 1 });
        pending.push({ node: node.second, depth: depth + 1 });
    }

    return leaves;
}

function isBoundedWindowsMosaicNode(value: unknown): value is MosaicNode<BaseAreaId> {
    return validateMosaicTree(value, BASE_AREA_SET, WINDOWS_STATE_BOUNDS) !== null;
}

export const windowsStateSchema = z
    .object({
        currentNode: z.custom<MosaicNode<BaseAreaId>>(isBoundedWindowsMosaicNode).nullable(),
    })
    .strict();

/** A divider position in percent; anything else is dropped on its own. */
const splitPercentageSchema = z.number().finite().min(0).max(100).optional().catch(undefined);

const besideSplitsSchema = z.object({
    board: splitPercentageSchema,
    notation: splitPercentageSchema,
});

export function isPanelArea(id: string): id is PanelAreaId {
    return PANEL_AREA_SET.has(id as PanelAreaId);
}

/**
 * Whether `value` is a valid analysis board arrangement: valid bounded Mosaic tree over area
 * ids, every base area present once, and at least one always-present panel left in the tab strip.
 */
export function isValidBoardArrangement(value: unknown): value is BoardArrangement {
    const leaves = validateMosaicTree(value, BOARD_AREA_SET, ARRANGEMENT_BOUNDS);
    if (!leaves) return false;
    for (const base of BASE_AREA_IDS) {
        if (!leaves.has(base)) return false;
    }
    return ALWAYS_PRESENT_PANEL_IDS.some((panel) => !leaves.has(panel));
}

export const boardArrangementSchema = z.custom<BoardArrangement>(isValidBoardArrangement);

export function defaultBoardArrangement(): BoardArrangement {
    return {
        direction: "row",
        first: "left",
        second: {
            direction: "column",
            first: "topRight",
            second: "bottomRight",
        },
    };
}

export function arrangementLeaves(node: BoardArrangement): BoardAreaId[] {
    return typeof node === "string"
        ? [node]
        : [...arrangementLeaves(node.first), ...arrangementLeaves(node.second)];
}

export function arrangementPanelAreas(node: BoardArrangement): PanelAreaId[] {
    return arrangementLeaves(node).filter(isPanelArea);
}

/** Whether `panel` is in the tab strip and can be taken out without breaking the strip rule. */
export function canTakeOutPanel(arrangement: BoardArrangement, panel: PanelAreaId): boolean {
    const leaves = new Set(arrangementLeaves(arrangement));
    if (leaves.has(panel)) return false;
    leaves.add(panel);
    return ALWAYS_PRESENT_PANEL_IDS.some((id) => !leaves.has(id));
}

function removeLeaf<Leaf extends string>(
    node: MosaicNode<Leaf>,
    target: Leaf,
): MosaicNode<Leaf> | null {
    if (typeof node === "string") {
        return node === target ? null : node;
    }
    const first = removeLeaf(node.first, target);
    const second = removeLeaf(node.second, target);
    if (first === null) return second;
    if (second === null) return first;
    if (first === node.first && second === node.second) return node;
    return { ...node, first, second };
}

function replaceLeaf<Leaf extends string>(
    node: MosaicNode<Leaf>,
    target: Leaf,
    replacement: MosaicNode<Leaf>,
): MosaicNode<Leaf> {
    if (typeof node === "string") {
        return node === target ? replacement : node;
    }
    const first = replaceLeaf(node.first, target, replacement);
    const second = replaceLeaf(node.second, target, replacement);
    if (first === node.first && second === node.second) return node;
    return { ...node, first, second };
}

function splitTarget(
    area: BoardAreaId,
    target: BoardAreaId,
    side: PlacementSide,
): BoardArrangement {
    switch (side) {
        case "left":
            return { direction: "row", first: area, second: target, splitPercentage: 50 };
        case "right":
            return { direction: "row", first: target, second: area, splitPercentage: 50 };
        case "top":
            return { direction: "column", first: area, second: target, splitPercentage: 50 };
        case "bottom":
            return { direction: "column", first: target, second: area, splitPercentage: 50 };
    }
}

/**
 * Places `area` on `side` of `target` at 50 %. Removes `area` from its previous position first
 * if it is already in the tree. Returns `arrangement` unchanged on any disallowed move.
 */
export function placeArea(
    arrangement: BoardArrangement,
    area: BoardAreaId,
    target: BoardAreaId,
    side: PlacementSide,
): BoardArrangement {
    if (area === "left" || target === area) return arrangement;
    const leaves = new Set(arrangementLeaves(arrangement));
    if (!leaves.has(target)) return arrangement;

    let base = arrangement;
    if (leaves.has(area)) {
        const removed = removeLeaf(arrangement, area);
        if (removed === null) return arrangement;
        base = removed;
    } else {
        if (!isPanelArea(area) || !canTakeOutPanel(arrangement, area)) return arrangement;
    }

    return replaceLeaf(base, target, splitTarget(area, target, side));
}

/** Returns a detached panel area back to the tab strip by removing its leaf. */
export function returnPanelArea(
    arrangement: BoardArrangement,
    panel: PanelAreaId,
): BoardArrangement {
    if (!isPanelArea(panel)) return arrangement;
    const removed = removeLeaf(arrangement, panel);
    return removed ?? arrangement;
}

/** The arrangement shown on a tab that does not offer `hiddenPanels`. */
export function shownArrangement(
    stored: BoardArrangement,
    hiddenPanels: ReadonlySet<PanelAreaId>,
): BoardArrangement {
    if (hiddenPanels.size === 0) return stored;
    let current = stored;
    for (const panel of hiddenPanels) {
        const next = removeLeaf(current, panel);
        if (next !== null) current = next;
    }
    return current;
}

function hasVisibleLeaf(node: BoardArrangement, hiddenPanels: ReadonlySet<PanelAreaId>): boolean {
    if (typeof node === "string") {
        return !isPanelArea(node) || !hiddenPanels.has(node);
    }
    return hasVisibleLeaf(node.first, hiddenPanels) || hasVisibleLeaf(node.second, hiddenPanels);
}

/**
 * Writes divider changes from a tab's shown arrangement back to the stored arrangement so that
 * hidden panel areas keep their positions and own split percentages.
 */
export function applyShownSplits(
    stored: BoardArrangement,
    nextShown: BoardArrangement,
    hiddenPanels: ReadonlySet<PanelAreaId>,
): BoardArrangement {
    if (typeof stored === "string") return stored;
    const firstVisible = hasVisibleLeaf(stored.first, hiddenPanels);
    const secondVisible = hasVisibleLeaf(stored.second, hiddenPanels);
    if (!firstVisible && !secondVisible) return stored;
    if (!firstVisible) {
        const second = applyShownSplits(stored.second, nextShown, hiddenPanels);
        return second === stored.second ? stored : { ...stored, second };
    }
    if (!secondVisible) {
        const first = applyShownSplits(stored.first, nextShown, hiddenPanels);
        return first === stored.first ? stored : { ...stored, first };
    }
    if (typeof nextShown === "string" || nextShown.direction !== stored.direction) {
        return stored;
    }
    const first = applyShownSplits(stored.first, nextShown.first, hiddenPanels);
    const second = applyShownSplits(stored.second, nextShown.second, hiddenPanels);
    const splitPercentage = nextShown.splitPercentage;
    if (
        first === stored.first &&
        second === stored.second &&
        splitPercentage === stored.splitPercentage
    ) {
        return stored;
    }
    return splitPercentage === undefined
        ? { direction: stored.direction, first, second }
        : { direction: stored.direction, first, second, splitPercentage };
}

const LEGACY_EXPLORER_PLACEMENTS = ["tabs", "notation", "belowNotation", "board"] as const;
type LegacyExplorerPlacement = (typeof LEGACY_EXPLORER_PLACEMENTS)[number];
const legacyExplorerPlacementSchema = z.enum(LEGACY_EXPLORER_PLACEMENTS);
const CARRIED_DATABASE_SHARE = 30;

/** Raw string values already read from storage for the legacy layout keys and `windowsState`. */
export interface LegacyLayoutValues {
    windowsState: string | null;
    panelsBesideNotation: string | null;
    boardBesideSplits: string | null;
    detachedExplorer: string | null;
    detachedExplorerPlacement: string | null;
    detachedExplorerHeights: string | null;
}

export interface CarryOverResult {
    arrangement: BoardArrangement;
    /** Whether at least one of the legacy keys or `windowsState` was present in storage. */
    hasLegacyValues: boolean;
}

function parseStoredJson<Value>(
    raw: string | null,
    schema: z.ZodType<Value, z.ZodTypeDef, unknown>,
): Value | undefined {
    if (raw === null) return undefined;
    try {
        const parsed = schema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined;
    }
}

function insertCarriedDatabase(
    arrangement: BoardArrangement,
    placement: LegacyExplorerPlacement,
    beside: boolean,
): BoardArrangement {
    if (placement === "tabs" && beside && typeof arrangement !== "string") {
        // In the beside base `arrangement.second` is the notation+tabs group, and the legacy "tabs" place spanned both.
        return {
            ...arrangement,
            second: {
                direction: "column",
                first: "database",
                second: arrangement.second,
                splitPercentage: CARRIED_DATABASE_SHARE,
            },
        };
    }
    switch (placement) {
        case "tabs":
            return replaceLeaf(arrangement, "topRight", {
                direction: "column",
                first: "database",
                second: "topRight",
                splitPercentage: CARRIED_DATABASE_SHARE,
            });
        case "notation":
            return replaceLeaf(arrangement, "bottomRight", {
                direction: "column",
                first: "database",
                second: "bottomRight",
                splitPercentage: CARRIED_DATABASE_SHARE,
            });
        case "belowNotation":
            return replaceLeaf(arrangement, "bottomRight", {
                direction: "column",
                first: "bottomRight",
                second: "database",
                splitPercentage: 100 - CARRIED_DATABASE_SHARE,
            });
        case "board":
            return replaceLeaf(arrangement, "left", {
                direction: "column",
                first: "left",
                second: "database",
                splitPercentage: 100 - CARRIED_DATABASE_SHARE,
            });
    }
}

/**
 * Computes the initial analysis board arrangement from already-read legacy storage values.
 * A legacy value that does not parse with its existing schema counts as absent.
 */
export function computeCarryOverArrangement(legacy: LegacyLayoutValues): CarryOverResult {
    const hasLegacyValues =
        legacy.windowsState !== null ||
        legacy.panelsBesideNotation !== null ||
        legacy.boardBesideSplits !== null ||
        legacy.detachedExplorer !== null ||
        legacy.detachedExplorerPlacement !== null ||
        legacy.detachedExplorerHeights !== null;

    if (!hasLegacyValues) {
        return { arrangement: defaultBoardArrangement(), hasLegacyValues: false };
    }

    const beside = parseStoredJson(legacy.panelsBesideNotation, z.boolean()) === true;

    let arrangement: BoardArrangement;
    if (beside) {
        const splits = parseStoredJson(legacy.boardBesideSplits, besideSplitsSchema) ?? {};
        const rightGroup: BoardArrangement =
            splits.notation === undefined
                ? { direction: "row", first: "bottomRight", second: "topRight" }
                : {
                      direction: "row",
                      first: "bottomRight",
                      second: "topRight",
                      splitPercentage: splits.notation,
                  };
        arrangement =
            splits.board === undefined
                ? { direction: "row", first: "left", second: rightGroup }
                : {
                      direction: "row",
                      first: "left",
                      second: rightGroup,
                      splitPercentage: splits.board,
                  };
    } else {
        const storedWindows = parseStoredJson(legacy.windowsState, windowsStateSchema);
        arrangement =
            storedWindows?.currentNode !== undefined &&
            storedWindows.currentNode !== null &&
            isValidBoardArrangement(storedWindows.currentNode)
                ? storedWindows.currentNode
                : defaultBoardArrangement();
    }

    const detachedExplorer = parseStoredJson(legacy.detachedExplorer, z.boolean()) === true;
    if (detachedExplorer) {
        const placement =
            parseStoredJson(legacy.detachedExplorerPlacement, legacyExplorerPlacementSchema) ??
            "tabs";
        arrangement = insertCarriedDatabase(arrangement, placement, beside);
    }

    return { arrangement, hasLegacyValues: true };
}
