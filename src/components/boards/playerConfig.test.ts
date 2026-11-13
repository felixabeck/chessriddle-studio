import { expect, test } from "vitest";
import type { EngineOption, GoMode } from "@/bindings";
import type { LocalEngine } from "@/utils/engines";
import type { OpponentSettings } from "./OpponentForm";
import { hasStartableTimeControl, MissingLocalEngineError, toPlayerConfig } from "./playerConfig";

test("an unlimited time control can start", () => {
    expect(hasStartableTimeControl({ type: "human" })).toBe(true);
});

test.each([
    [1_000, true],
    [999, false],
    [0, false],
    [1, false], // A cleared time field produces 1 ms.
])("an initial clock of %i ms has startability %s", (seconds, expected) => {
    expect(hasStartableTimeControl({ type: "human", timeControl: { seconds, increment: 0 } })).toBe(
        expected,
    );
});

const handle = { id: { id: "engine-path-ref" }, kind: "engine" } as LocalEngine["handle"];

const engine: LocalEngine = {
    type: "local",
    id: "engine-application-id",
    name: "Engine",
    version: "17",
    filename: "engine",
    handle,
    settings: [
        { type: "string", name: "MultiPV", value: "4" },
        { type: "string", name: "Threads", value: "2" },
    ],
} as LocalEngine;

/** The live engine list the selection is validated against at submission time. */
const registered: LocalEngine[] = [engine];

function engineOpponent(overrides: Partial<Extract<OpponentSettings, { type: "engine" }>> = {}) {
    return {
        type: "engine",
        engine,
        go: { t: "Depth", c: 20 } satisfies GoMode,
        ...overrides,
    } as OpponentSettings;
}

test("engine player config carries the immutable application engine id and the engine handle", () => {
    expect(toPlayerConfig(engineOpponent(), registered)).toEqual({
        type: "engine",
        name: "Engine",
        engineId: "engine-application-id",
        handle,
        options: [{ type: "string", name: "Threads", value: "2" }],
        go: { t: "Depth", c: 20 },
    });
});

test("a human player needs no engine and keeps an explicit name", () => {
    expect(toPlayerConfig({ type: "human", name: "Felix" }, registered)).toEqual({
        type: "human",
        name: "Felix",
    });
    expect(toPlayerConfig({ type: "human" }, registered)).toEqual({
        type: "human",
        name: "Player",
    });
});

test("an engine player without a usable local engine is rejected, not sent to the backend", () => {
    for (const settings of [
        engineOpponent({ engine: null }),
        engineOpponent({ engine: { type: "chessdb" } as unknown as LocalEngine }),
    ]) {
        let thrown: unknown;
        try {
            toPlayerConfig(settings, registered);
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(MissingLocalEngineError);
        expect(thrown).toMatchObject({ code: "missing-local-engine" });
        expect((thrown as Error).message).toBe(
            "A local engine must be selected for an engine player",
        );
    }
});

test("an engine without a name falls back to a default name", () => {
    expect(
        toPlayerConfig(
            engineOpponent({ engine: { ...engine, name: undefined } as unknown as LocalEngine }),
            registered,
        ),
    ).toMatchObject({ name: "Engine" });
});

test("per-game engine settings replace the engine's stored settings, and an empty list is honoured", () => {
    expect(
        toPlayerConfig(
            engineOpponent({ engineSettings: [{ type: "string", name: "Threads", value: "8" }] }),
            registered,
        ),
    ).toMatchObject({ options: [{ type: "string", name: "Threads", value: "8" }] });

    // An explicit empty list is a choice, not a reason to fall back to the engine's settings.
    expect(toPlayerConfig(engineOpponent({ engineSettings: [] }), registered)).toMatchObject({
        options: [],
    });

    // Neither source present is the remaining case the `?? []` tail exists for, and the
    // engine's own settings come from the live record rather than from the saved selection.
    expect(
        toPlayerConfig(engineOpponent({ engine: { ...engine, settings: undefined } }), [
            { ...engine, settings: undefined },
        ]),
    ).toMatchObject({ options: [] });
});

test("resource options are passed through untouched while string options are normalised", () => {
    const resource: EngineOption = {
        type: "resource",
        name: "SyzygyPath",
        resources: [{ id: { id: "tablebase-ref" }, kind: "directory", displayName: "tablebases" }],
    };

    expect(
        toPlayerConfig(
            engineOpponent({
                engineSettings: [resource, { type: "string", name: "Hash", value: "1024" }],
            }),
            registered,
        ),
    ).toMatchObject({
        options: [resource, { type: "string", name: "Hash", value: "1024" }],
    });
});

test("a time control hands the go mode to the backend instead of fixing it here", () => {
    for (const go of [
        { t: "Depth", c: 20 },
        { t: "Nodes", c: 500_000 },
    ] satisfies GoMode[]) {
        expect(toPlayerConfig(engineOpponent({ go }), registered)).toMatchObject({ go });
        expect(
            toPlayerConfig(
                engineOpponent({ go, timeControl: { seconds: 180_000, increment: 2_000 } }),
                registered,
            ),
        ).toMatchObject({ go: null });
    }
});

test("an Infinite engine go without a time control is sent as a depth limit", () => {
    expect(toPlayerConfig(engineOpponent({ go: { t: "Infinite" } }), registered)).toMatchObject({
        go: { t: "Depth", c: 24 },
    });
    expect(
        toPlayerConfig(
            engineOpponent({
                go: { t: "Infinite" },
                timeControl: { seconds: 180_000, increment: 2_000 },
            }),
            registered,
        ),
    ).toMatchObject({ go: null });
});

test("an engine removed after selection is rejected instead of submitted with a retired id", () => {
    // Removing an engine permanently retires its application id, so the supervisor would refuse
    // the start; the renderer must not offer a configuration that cannot run.
    let thrown: unknown;
    try {
        toPlayerConfig(engineOpponent(), [{ ...engine, id: "another-engine" }]);
    } catch (error) {
        thrown = error;
    }
    expect(thrown).toBeInstanceOf(MissingLocalEngineError);
    expect(thrown).toMatchObject({ code: "missing-local-engine" });
    expect((thrown as Error).message).toBe(
        "The selected local engine is not in the current engine list",
    );

    expect(() => toPlayerConfig(engineOpponent(), [])).toThrow(MissingLocalEngineError);
});

test("an engine list that has not hydrated cannot prove the selection is live", () => {
    expect(() => toPlayerConfig(engineOpponent(), undefined)).toThrow(MissingLocalEngineError);
    // A human player needs no engine list at all.
    expect(toPlayerConfig({ type: "human", name: "Felix" }, undefined)).toEqual({
        type: "human",
        name: "Felix",
    });
});

test("engine-owned fields come from the live record, not from the saved selection", () => {
    // A re-registered binary keeps its application id but gets a new handle; launching the
    // stale handle would run the executable the user replaced.
    const stale: LocalEngine = {
        ...engine,
        name: "Old name",
        handle: { id: { id: "stale-path-ref" }, kind: "engine" } as LocalEngine["handle"],
        settings: [{ type: "string", name: "Threads", value: "1" }],
    };
    const current: LocalEngine = {
        ...engine,
        name: "Current name",
        settings: [{ type: "string", name: "Threads", value: "16" }],
    };

    expect(toPlayerConfig(engineOpponent({ engine: stale }), [current])).toMatchObject({
        name: "Current name",
        engineId: engine.id,
        handle,
        options: [{ type: "string", name: "Threads", value: "16" }],
    });

    // The player's own per-game settings still win over the live record's defaults.
    expect(
        toPlayerConfig(
            engineOpponent({
                engine: stale,
                engineSettings: [{ type: "string", name: "Threads", value: "4" }],
            }),
            [current],
        ),
    ).toMatchObject({ options: [{ type: "string", name: "Threads", value: "4" }] });
});
