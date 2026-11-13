import { expect, test } from "vitest";
import { DEFAULT_GAME_ENGINE_GO, effectiveGameGo } from "@/utils/engines";
import { opponentSettingsSchema } from "./opponentSettings";

test("stored Infinite engine go still parses unchanged", () => {
    expect(
        opponentSettingsSchema.parse({ type: "engine", engine: null, go: { t: "Infinite" } }),
    ).toEqual({ type: "engine", engine: null, go: { t: "Infinite" } });
});

test("stored Nodes engine go still parses unchanged", () => {
    expect(
        opponentSettingsSchema.parse({
            type: "engine",
            engine: null,
            go: { t: "Nodes", c: 100_000_000 },
        }),
    ).toEqual({ type: "engine", engine: null, go: { t: "Nodes", c: 100_000_000 } });
});

test("effectiveGameGo keeps a valid node limit and falls back out of range", () => {
    expect(effectiveGameGo({ t: "Infinite" })).toEqual(DEFAULT_GAME_ENGINE_GO);
    expect(effectiveGameGo({ t: "Nodes", c: 100_000_000 })).toEqual({
        t: "Nodes",
        c: 100_000_000,
    });
    expect(effectiveGameGo({ t: "Time", c: 86_400_001 })).toEqual(DEFAULT_GAME_ENGINE_GO);
    expect(effectiveGameGo({ t: "Depth", c: 1.5 })).toEqual(DEFAULT_GAME_ENGINE_GO);
});
