import { i18nKey } from "@/utils/i18nKey";
import {
    type BoardArrangement,
    defaultBoardArrangement,
    enginePlaceholderAreaId,
} from "./boardArrangement";

/** Analysis tab kinds that each keep their own live board layout. */
export const BOARD_LAYOUT_KINDS = ["repertoire", "game", "preparation"] as const;
export type BoardLayoutKind = (typeof BOARD_LAYOUT_KINDS)[number];

/** One analysis board layout: the Mosaic panel arrangement plus whether the tab strip is hidden. */
export interface BoardLayout {
    arrangement: BoardArrangement;
    tabsHidden: boolean;
}

/** Stable identifiers for the built-in read-only layout presets. */
export type LayoutPresetId = "preset:repertoire" | "preset:game" | "preset:preparation";

export interface LayoutPreset {
    readonly id: LayoutPresetId;
    /** Translation key for the preset's display name. */
    readonly nameKey: Parameters<typeof i18nKey>[0];
    readonly layout: BoardLayout;
}

function cloneArrangement(node: BoardArrangement): BoardArrangement {
    if (typeof node === "string") return node;
    const cloned: BoardArrangement = {
        direction: node.direction,
        first: cloneArrangement(node.first),
        second: cloneArrangement(node.second),
    };
    if (node.splitPercentage !== undefined) {
        cloned.splitPercentage = node.splitPercentage;
    }
    return cloned;
}

/** Deep-clones a board layout so live edits never mutate presets or saved copies. */
export function cloneBoardLayout(layout: BoardLayout): BoardLayout {
    return {
        arrangement: cloneArrangement(layout.arrangement),
        tabsHidden: layout.tabsHidden,
    };
}

/**
 * Built-in analysis board layout presets, kept as data so Felix's final layouts can replace
 * them with a data edit. Engine slots use placeholder ids (`engine:@<n>`).
 */
export const LAYOUT_PRESETS: readonly LayoutPreset[] = [
    {
        id: "preset:repertoire",
        nameKey: i18nKey("Board.Layout.Preset.Repertoire"),
        layout: {
            arrangement: {
                direction: "row",
                first: {
                    direction: "column",
                    first: "left",
                    second: enginePlaceholderAreaId(1),
                    splitPercentage: 70,
                },
                second: {
                    direction: "column",
                    first: "database",
                    splitPercentage: 30,
                    second: {
                        direction: "column",
                        first: "topRight",
                        splitPercentage: 35,
                        second: {
                            direction: "row",
                            first: "bottomRight",
                            second: "annotate",
                            splitPercentage: 55,
                        },
                    },
                },
            },
            tabsHidden: false,
        },
    },
    {
        id: "preset:game",
        nameKey: i18nKey("Board.Layout.Preset.GameReview"),
        layout: {
            arrangement: defaultBoardArrangement(),
            tabsHidden: false,
        },
    },
    {
        id: "preset:preparation",
        nameKey: i18nKey("Board.Layout.Preset.Preparation"),
        layout: {
            arrangement: {
                direction: "row",
                first: "left",
                second: {
                    direction: "column",
                    first: "database",
                    splitPercentage: 40,
                    second: {
                        direction: "row",
                        first: "bottomRight",
                        second: "topRight",
                        splitPercentage: 55,
                    },
                },
            },
            tabsHidden: false,
        },
    },
];

export const PRESET_IDS: ReadonlySet<string> = new Set(LAYOUT_PRESETS.map((preset) => preset.id));

const PRESET_BY_ID: ReadonlyMap<string, LayoutPreset> = new Map(
    LAYOUT_PRESETS.map((preset) => [preset.id, preset]),
);

/** Default preset assigned to each analysis tab kind on a fresh install or Reset. */
export const DEFAULT_KIND_PRESET: Readonly<Record<BoardLayoutKind, LayoutPresetId>> = {
    repertoire: "preset:repertoire",
    game: "preset:game",
    preparation: "preset:preparation",
};

export function getLayoutPreset(id: string): LayoutPreset | undefined {
    return PRESET_BY_ID.get(id);
}

export function defaultLayoutForKind(kind: BoardLayoutKind): BoardLayout {
    const preset = PRESET_BY_ID.get(DEFAULT_KIND_PRESET[kind])!;
    return cloneBoardLayout(preset.layout);
}

export function defaultKindLayouts(): Record<BoardLayoutKind, BoardLayout> {
    return {
        repertoire: defaultLayoutForKind("repertoire"),
        game: defaultLayoutForKind("game"),
        preparation: defaultLayoutForKind("preparation"),
    };
}
