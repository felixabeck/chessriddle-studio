import { expect, test } from "vitest";
import { normalizeEngineOptions } from "./engineOptions";

test("normalizeEngineOptions drops empty string values the native launch refuses", () => {
    const resource = {
        type: "resource" as const,
        name: "SyzygyPath",
        resources: [{ id: { id: "tb" }, kind: "directory" as const, displayName: "tb" }],
    };
    expect(
        normalizeEngineOptions([
            { type: "string", name: "Hash", value: "" },
            { type: "string", name: "Threads", value: "4" },
            resource,
        ]),
    ).toEqual([{ type: "string", name: "Threads", value: "4" }, resource]);
});
