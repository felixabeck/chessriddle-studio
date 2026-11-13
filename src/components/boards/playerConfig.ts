import type { PlayerConfig } from "@/bindings";
import { normalizeEngineOptions } from "@/components/engines/engineOptions";
import { effectiveGameGo, type Engine, type LocalEngine } from "@/utils/engines";
import type { OpponentSettings } from "./OpponentForm";

const MIN_INITIAL_TIME_MS = 1_000;

/** Mirrors validate_time_controls: each side may be Unlimited or meet the initial-time floor. */
export function hasStartableTimeControl(settings: OpponentSettings): boolean {
    return (
        settings.timeControl === undefined || settings.timeControl.seconds >= MIN_INITIAL_TIME_MS
    );
}

/** A player configuration was incomplete before it could be sent to the backend. */
export class MissingLocalEngineError extends Error {
    readonly code = "missing-local-engine" as const;

    constructor(diagnostic = "A local engine must be selected for an engine player") {
        super(diagnostic);
        this.name = "MissingLocalEngineError";
    }
}

/**
 * Maps the form's opponent settings onto the backend's player contract.
 *
 * `engineId` carries the immutable application id rather than the path handle, so a result
 * arriving later stays bound to the engine that was actually asked. MultiPV is dropped because
 * a game engine plays one move, and a time control makes `go` the backend's decision.
 *
 * `availableEngines` is the live engine list and is authoritative, both for existence and for
 * the engine's own fields. Removing an engine permanently retires its application id
 * (d-20260901-17), so a selection that survived the removal — or one that cannot be proven live
 * because the list has not hydrated yet (`undefined`) — is rejected here rather than sent to a
 * supervisor that will refuse it.
 */
export function toPlayerConfig(
    settings: OpponentSettings,
    availableEngines: readonly Engine[] | undefined,
): PlayerConfig {
    if (settings.type === "human") {
        return {
            type: "human",
            name: settings.name ?? "Player",
        };
    }
    const engine = settings.engine;
    if (!engine || engine.type !== "local") {
        throw new MissingLocalEngineError();
    }
    const live = availableEngines?.find(
        (known): known is LocalEngine => known.type === "local" && known.id === engine.id,
    );
    if (!live) {
        throw new MissingLocalEngineError(
            "The selected local engine is not in the current engine list",
        );
    }
    return {
        type: "engine",
        name: live.name ?? "Engine",
        engineId: live.id,
        handle: live.handle,
        // The persisted selection is a snapshot; engine-owned fields come from the live record,
        // so a re-registered binary is not launched from a stale handle. Per-game settings are
        // the player's own and still win over the engine's defaults.
        options: normalizeEngineOptions(settings.engineSettings ?? live.settings ?? []).filter(
            (setting) => setting.name !== "MultiPV",
        ),
        go: settings.timeControl ? null : effectiveGameGo(settings.go),
    };
}
