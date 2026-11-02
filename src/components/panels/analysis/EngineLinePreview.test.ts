import { expect, test } from "vitest";
import { previewTop } from "./EngineLinePreview";

test("previewTop places the board below, then above, then inside the window", () => {
    // Room below the line.
    expect(previewTop(100, 140, 800)).toBe(140);
    // A line near the window bottom: the board flips above it.
    expect(previewTop(700, 740, 800)).toBe(500);
    // An expanded line taller than the space on either side: pinned to the window bottom.
    expect(previewTop(100, 700, 800)).toBe(600);
    // A window shorter than the board: never above its top edge.
    expect(previewTop(10, 50, 150)).toBe(0);
});
