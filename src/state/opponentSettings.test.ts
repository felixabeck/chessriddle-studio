import { expect, test } from "vitest";
import { opponentSettingsSchema } from "./opponentSettings";

test("hydrates Infinite engine go to a depth limit and keeps a valid Nodes go", () => {
    expect(
        opponentSettingsSchema.parse({ type: "engine", engine: null, go: { t: "Infinite" } }),
    ).toEqual({ type: "engine", engine: null, go: { t: "Depth", c: 24 } });
    expect(
        opponentSettingsSchema.parse({
            type: "engine",
            engine: null,
            go: { t: "Nodes", c: 100_000_000 },
        }),
    ).toEqual({ type: "engine", engine: null, go: { t: "Nodes", c: 100_000_000 } });
});
