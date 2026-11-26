import type { MosaicNode } from "react-mosaic-component";
import { z } from "zod";

/** The three base areas always present on the analysis board: board, tab strip, notation. */
export const BASE_AREA_IDS = ["left", "topRight", "bottomRight"] as const;
export type BaseAreaId = (typeof BASE_AREA_IDS)[number];

/** Panels that can be taken out of the analysis board's tab strip as their own areas. */
export const PANEL_AREA_IDS = [
    "analysis",
    "report",
    "database",
    "annotate",
    "coach",
    "info",
] as const;
export type PanelAreaId = (typeof PANEL_AREA_IDS)[number];

/** Panels present on every analysis tab; at least one must remain in the tab strip. */
export const ALWAYS_PRESENT_PANEL_IDS = [
    "analysis",
    "report",
    "database",
    "annotate",
    "info",
] as const;

export const BOARD_AREA_IDS = [...BASE_AREA_IDS, ...PANEL_AREA_IDS] as const;
export type StaticBoardAreaId = (typeof BOARD_AREA_IDS)[number];

export const ENGINE_AREA_PREFIX = "engine:";
export type EngineAreaId = `${typeof ENGINE_AREA_PREFIX}${string}`;
/** Maximum number of engine windows that can be pulled out into the arrangement at once. */
export const MAX_ENGINE_AREAS = 4;

export type BoardAreaId = StaticBoardAreaId | EngineAreaId;

/** Areas that can be left out of the shown arrangement: panel areas, engine areas, and the tab strip. */
export type HideableAreaId = PanelAreaId | EngineAreaId | "topRight";

export type BoardArrangement = MosaicNode<BoardAreaId>;

export type PlacementSide = "left" | "right" | "top" | "bottom";

export interface MosaicTreeBounds {
    maxNodes: number;
    maxDepth: number;
}

const WINDOWS_STATE_BOUNDS: MosaicTreeBounds = { maxNodes: 5, maxDepth: 2 };
// Maximum leaves: all base areas, all panels minus the one required in the strip, plus up to MAX_ENGINE_AREAS engines.
const MAX_ARRANGEMENT_LEAVES =
    BASE_AREA_IDS.length + (PANEL_AREA_IDS.length - 1) + MAX_ENGINE_AREAS;
const ARRANGEMENT_BOUNDS: MosaicTreeBounds = {
    maxNodes: 2 * MAX_ARRANGEMENT_LEAVES - 1,
    maxDepth: MAX_ARRANGEMENT_LEAVES - 1,
};

const BASE_AREA_SET: ReadonlySet<BaseAreaId> = new Set(BASE_AREA_IDS);
const PANEL_AREA_SET: ReadonlySet<PanelAreaId> = new Set(PANEL_AREA_IDS);
const STATIC_BOARD_AREA_SET: ReadonlySet<StaticBoardAreaId> = new Set(BOARD_AREA_IDS);
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
    allowedLeaves: ReadonlySet<Leaf> | ((candidate: string) => candidate is Leaf),
    bounds: MosaicTreeBounds,
): Set<Leaf> | null {
    const isAllowed =
        typeof allowedLeaves === "function"
            ? allowedLeaves
            : (candidate: string): candidate is Leaf => allowedLeaves.has(candidate as Leaf);
    const pending: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
    const leaves = new Set<Leaf>();
    let nodeCount = 0;

    while (pending.length > 0) {
        const current = pending.pop();
        if (!current) return null;
        const { node, depth } = current;
        if (++nodeCount > bounds.maxNodes || depth > bounds.maxDepth) return null;

        if (typeof node === "string") {
            if (!isAllowed(node)) return null;
            const leaf = node;
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

/** Builds the board area id for an engine from its immutable engine id. */
export function engineAreaId(engineId: string): EngineAreaId {
    return `${ENGINE_AREA_PREFIX}${engineId}`;
}

/** Whether `id` is a valid engine area leaf (`engine:<non-empty>`). */
export function isEngineArea(id: string): id is EngineAreaId {
    return id.startsWith(ENGINE_AREA_PREFIX) && id.length > ENGINE_AREA_PREFIX.length;
}

/** Extracts the immutable engine id from an engine area leaf (engine ids may contain `:`). */
export function engineIdFromArea(area: EngineAreaId): string {
    return area.slice(ENGINE_AREA_PREFIX.length);
}

export function isBoardAreaId(id: string): id is BoardAreaId {
    return STATIC_BOARD_AREA_SET.has(id as StaticBoardAreaId) || isEngineArea(id);
}

/**
 * Whether `value` is a valid analysis board arrangement: valid bounded Mosaic tree over area
 * ids, every base area present once, at least one always-present panel left in the tab strip,
 * and at most `MAX_ENGINE_AREAS` engine leaves.
 */
export function isValidBoardArrangement(value: unknown): value is BoardArrangement {
    const leaves = validateMosaicTree(value, isBoardAreaId, ARRANGEMENT_BOUNDS);
    if (!leaves) return false;
    for (const base of BASE_AREA_IDS) {
        if (!leaves.has(base)) return false;
    }
    if (!ALWAYS_PRESENT_PANEL_IDS.some((panel) => !leaves.has(panel))) return false;
    let engineCount = 0;
    for (const leaf of leaves) {
        if (isEngineArea(leaf)) engineCount += 1;
    }
    return engineCount <= MAX_ENGINE_AREAS;
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

export function arrangementEngineAreas(node: BoardArrangement): EngineAreaId[] {
    return arrangementLeaves(node).filter(isEngineArea);
}

/** Whether `panel` is in the tab strip and can be taken out without breaking the strip rule. */
export function canTakeOutPanel(arrangement: BoardArrangement, panel: PanelAreaId): boolean {
    const leaves = new Set(arrangementLeaves(arrangement));
    if (leaves.has(panel)) return false;
    leaves.add(panel);
    return ALWAYS_PRESENT_PANEL_IDS.some((id) => !leaves.has(id));
}

/** Whether `area` is a valid engine leaf not yet in the arrangement and below `MAX_ENGINE_AREAS`. */
export function canTakeOutEngine(arrangement: BoardArrangement, area: EngineAreaId): boolean {
    if (!isEngineArea(area)) return false;
    const engineAreas = arrangementEngineAreas(arrangement);
    if (engineAreas.includes(area)) return false;
    return engineAreas.length < MAX_ENGINE_AREAS;
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

/** Default split share (%) for a carried-over area or a newly placed engine window. */
const CARRIED_AREA_SHARE = 30;

/** Percentage share of the split given to `area` when placed beside another tile. */
export function areaSplitShare(area: BoardAreaId): number {
    return isEngineArea(area) ? CARRIED_AREA_SHARE : 50;
}

function splitTarget(
    area: BoardAreaId,
    target: BoardAreaId,
    side: PlacementSide,
): BoardArrangement {
    const share = areaSplitShare(area);
    switch (side) {
        case "left":
            return { direction: "row", first: area, second: target, splitPercentage: share };
        case "right":
            return { direction: "row", first: target, second: area, splitPercentage: 100 - share };
        case "top":
            return { direction: "column", first: area, second: target, splitPercentage: share };
        case "bottom":
            return {
                direction: "column",
                first: target,
                second: area,
                splitPercentage: 100 - share,
            };
    }
}

/**
 * Places `area` on `side` of `target` (30 % for an engine window, 50 % otherwise). Removes `area`
 * from its previous position first if it is already in the tree. Returns `arrangement` unchanged
 * on any disallowed move.
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
    } else if (isPanelArea(area)) {
        if (!canTakeOutPanel(arrangement, area)) return arrangement;
    } else if (isEngineArea(area)) {
        if (!canTakeOutEngine(arrangement, area)) return arrangement;
    } else {
        return arrangement;
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

/** Returns a detached engine area back to the Engines panel by removing its leaf. */
export function returnEngineArea(
    arrangement: BoardArrangement,
    area: EngineAreaId,
): BoardArrangement {
    if (!isEngineArea(area)) return arrangement;
    const removed = removeLeaf(arrangement, area);
    return removed ?? arrangement;
}

export interface EnginePresence {
    id: string;
    loaded?: boolean | null;
}

/**
 * Engine leaves in `arrangement` whose engine is not currently loaded (or while the engine list
 * has not loaded yet). Passed to `shownArrangement` and `applyShownSplits` so unloaded engines
 * stay in the stored tree without showing empty tiles.
 */
export function hiddenEngineAreas(
    arrangement: BoardArrangement,
    engines: readonly EnginePresence[] | undefined,
): EngineAreaId[] {
    const engineAreas = arrangementEngineAreas(arrangement);
    if (engineAreas.length === 0) return [];
    if (engines === undefined) return engineAreas;
    const loadedIds = new Set(engines.filter((engine) => engine.loaded).map((engine) => engine.id));
    return engineAreas.filter((area) => !loadedIds.has(engineIdFromArea(area)));
}

/**
 * Prunes engine leaves whose id is absent from a successfully loaded engine list (deleted
 * engines). Never prunes when `engines` is `undefined` (list absent or not yet loaded).
 */
export function pruneMissingEngineAreas(
    arrangement: BoardArrangement,
    engines: readonly EnginePresence[] | undefined,
): BoardArrangement {
    if (engines === undefined) return arrangement;
    const engineAreas = arrangementEngineAreas(arrangement);
    if (engineAreas.length === 0) return arrangement;
    const knownIds = new Set(engines.map((engine) => engine.id));
    let current = arrangement;
    for (const area of engineAreas) {
        if (!knownIds.has(engineIdFromArea(area))) {
            const next = removeLeaf(current, area);
            if (next !== null) current = next;
        }
    }
    return current;
}

/** The arrangement shown without the areas in `hiddenAreas`; the stored tree keeps them. */
export function shownArrangement(
    stored: BoardArrangement,
    hiddenAreas: ReadonlySet<HideableAreaId>,
): BoardArrangement {
    if (hiddenAreas.size === 0) return stored;
    let current = stored;
    for (const area of hiddenAreas) {
        const next = removeLeaf<BoardAreaId>(current, area);
        if (next !== null) current = next;
    }
    return current;
}

function hasVisibleLeaf(node: BoardArrangement, hiddenAreas: ReadonlySet<HideableAreaId>): boolean {
    if (typeof node === "string") {
        return node === "left" || node === "bottomRight" || !hiddenAreas.has(node);
    }
    return hasVisibleLeaf(node.first, hiddenAreas) || hasVisibleLeaf(node.second, hiddenAreas);
}

/**
 * Writes divider changes from a tab's shown arrangement back to the stored arrangement so that
 * hidden areas keep their positions and own split percentages.
 */
export function applyShownSplits(
    stored: BoardArrangement,
    nextShown: BoardArrangement,
    hiddenAreas: ReadonlySet<HideableAreaId>,
): BoardArrangement {
    if (typeof stored === "string") return stored;
    const firstVisible = hasVisibleLeaf(stored.first, hiddenAreas);
    const secondVisible = hasVisibleLeaf(stored.second, hiddenAreas);
    if (!firstVisible && !secondVisible) return stored;
    if (!firstVisible) {
        const second = applyShownSplits(stored.second, nextShown, hiddenAreas);
        return second === stored.second ? stored : { ...stored, second };
    }
    if (!secondVisible) {
        const first = applyShownSplits(stored.first, nextShown, hiddenAreas);
        return first === stored.first ? stored : { ...stored, first };
    }
    if (typeof nextShown === "string" || nextShown.direction !== stored.direction) {
        return stored;
    }
    const first = applyShownSplits(stored.first, nextShown.first, hiddenAreas);
    const second = applyShownSplits(stored.second, nextShown.second, hiddenAreas);
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

const CARRIED_PLACEMENTS = ["tabs", "notation", "belowNotation", "board"] as const;
type CarriedPlacement = (typeof CARRIED_PLACEMENTS)[number];
const carriedPlacementSchema = z.enum(CARRIED_PLACEMENTS);

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

function insertCarriedArea(
    arrangement: BoardArrangement,
    area: BoardAreaId,
    placement: CarriedPlacement,
): BoardArrangement {
    switch (placement) {
        case "tabs":
            return replaceLeaf(arrangement, "topRight", {
                direction: "column",
                first: area,
                second: "topRight",
                splitPercentage: CARRIED_AREA_SHARE,
            });
        case "notation":
            return replaceLeaf(arrangement, "bottomRight", {
                direction: "column",
                first: area,
                second: "bottomRight",
                splitPercentage: CARRIED_AREA_SHARE,
            });
        case "belowNotation":
            return replaceLeaf(arrangement, "bottomRight", {
                direction: "column",
                first: "bottomRight",
                second: area,
                splitPercentage: 100 - CARRIED_AREA_SHARE,
            });
        case "board":
            return replaceLeaf(arrangement, "left", {
                direction: "column",
                first: "left",
                second: area,
                splitPercentage: 100 - CARRIED_AREA_SHARE,
            });
    }
}

function insertCarriedDatabase(
    arrangement: BoardArrangement,
    placement: CarriedPlacement,
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
                splitPercentage: CARRIED_AREA_SHARE,
            },
        };
    }
    return insertCarriedArea(arrangement, "database", placement);
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
            parseStoredJson(legacy.detachedExplorerPlacement, carriedPlacementSchema) ?? "tabs";
        arrangement = insertCarriedDatabase(arrangement, placement, beside);
    }

    return { arrangement, hasLegacyValues: true };
}

/** Raw string values already read from storage for the retired pinned-engine keys. */
export interface RetiredEngineValues {
    detachedEngine: string | null;
    detachedEnginePlacement: string | null;
    detachedEngineLines: string | null;
}

export interface EngineCarryOverResult {
    arrangement: BoardArrangement;
    /** Whether at least one of the three retired pinned-engine keys was present in storage. */
    hasRetiredKeys: boolean;
    /** Whether inserting the carried-over engine leaf changed `arrangement`. */
    changed: boolean;
}

/**
 * Applies the one-time carry-over of the retired pinned-engine keys onto `arrangement`.
 * Leaves `arrangement` unchanged when no valid non-empty engine id is stored, the leaf is already
 * present, the engine cap is reached, or the resulting tree fails validation.
 */
export function applyRetiredEngineCarryOver(
    arrangement: BoardArrangement,
    retired: RetiredEngineValues,
): EngineCarryOverResult {
    const hasRetiredKeys =
        retired.detachedEngine !== null ||
        retired.detachedEnginePlacement !== null ||
        retired.detachedEngineLines !== null;

    if (!hasRetiredKeys) {
        return { arrangement, hasRetiredKeys: false, changed: false };
    }

    const engineId = parseStoredJson(retired.detachedEngine, z.string().min(1));
    if (engineId === undefined) {
        return { arrangement, hasRetiredKeys: true, changed: false };
    }

    const area = engineAreaId(engineId);
    if (!canTakeOutEngine(arrangement, area)) {
        return { arrangement, hasRetiredKeys: true, changed: false };
    }

    const placement =
        parseStoredJson(retired.detachedEnginePlacement, carriedPlacementSchema) ?? "tabs";
    const candidate = insertCarriedArea(arrangement, area, placement);
    if (!isValidBoardArrangement(candidate)) {
        return { arrangement, hasRetiredKeys: true, changed: false };
    }

    return { arrangement: candidate, hasRetiredKeys: true, changed: true };
}
