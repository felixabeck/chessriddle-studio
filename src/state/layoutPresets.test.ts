import { describe, expect, test } from "vitest";
import {
    arrangementEngineAreas,
    isEnginePlaceholderArea,
    isValidBoardArrangement,
} from "./boardArrangement";
import {
    BOARD_LAYOUT_KINDS,
    DEFAULT_KIND_PRESET,
    defaultKindLayouts,
    defaultLayoutForKind,
    getLayoutPreset,
    LAYOUT_PRESETS,
    PRESET_IDS,
} from "./layoutPresets";

describe("layoutPresets", () => {
    test("every preset has a valid arrangement, boolean tabsHidden, unique id, and only placeholder engine leaves", () => {
        expect(LAYOUT_PRESETS).toHaveLength(3);
        expect(PRESET_IDS.size).toBe(LAYOUT_PRESETS.length);

        for (const preset of LAYOUT_PRESETS) {
            expect(preset.id.length).toBeGreaterThan(0);
            expect(preset.nameKey.length).toBeGreaterThan(0);
            expect(preset.defaultName.length).toBeGreaterThan(0);
            expect(typeof preset.layout.tabsHidden).toBe("boolean");
            expect(isValidBoardArrangement(preset.layout.arrangement)).toBe(true);
            for (const engineLeaf of arrangementEngineAreas(preset.layout.arrangement)) {
                expect(isEnginePlaceholderArea(engineLeaf)).toBe(true);
            }
            expect(getLayoutPreset(preset.id)).toBe(preset);
        }
    });

    test("every tab kind maps to a valid preset and defaultLayoutForKind returns an independent copy", () => {
        const defaults = defaultKindLayouts();
        for (const kind of BOARD_LAYOUT_KINDS) {
            const presetId = DEFAULT_KIND_PRESET[kind];
            expect(getLayoutPreset(presetId)).toBeDefined();
            const layout = defaultLayoutForKind(kind);
            expect(layout).toEqual(defaults[kind]);
            expect(isValidBoardArrangement(layout.arrangement)).toBe(true);
            layout.tabsHidden = !layout.tabsHidden;
            expect(defaultLayoutForKind(kind).tabsHidden).toBe(defaults[kind].tabsHidden);
        }
    });
});
