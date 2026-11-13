import { z } from "zod";
import type { GoMode, InstalledEngineResult } from "@/bindings";
import type { TimeType } from "@/components/common/TimeInput";
import type { TimeControlField } from "@/utils/clock";
import {
    engineSettingsSchema,
    limitedGoModeSchema,
    localEngineSchema,
    type EngineSettings,
    type LocalEngine,
    upgradeEngineFromCatalog,
    upgradeEngineSettings,
    type EngineCatalogMetadata,
} from "@/utils/engines";

const timeControlSchema: z.ZodType<TimeControlField> = z.object({
    seconds: z.number(),
    increment: z.number().optional(),
});
const timeTypeSchema: z.ZodType<TimeType> = z.enum(["ms", "s", "m", "h"]);

export type OpponentSettings =
    | {
          type: "human";
          timeControl?: TimeControlField;
          name?: string;
          timeUnit?: TimeType;
          incrementUnit?: TimeType;
      }
    | {
          type: "engine";
          timeControl?: TimeControlField;
          engine: LocalEngine | null;
          go: import("@/bindings").GoMode;
          engineSettings?: EngineSettings;
          timeUnit?: TimeType;
          incrementUnit?: TimeType;
      };

const DEFAULT_ENGINE_GO: GoMode = { t: "Depth", c: 24 };

export const opponentSettingsSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("human"),
        timeControl: timeControlSchema.optional(),
        name: z.string().optional(),
        timeUnit: timeTypeSchema.optional(),
        incrementUnit: timeTypeSchema.optional(),
    }),
    z.object({
        type: z.literal("engine"),
        timeControl: timeControlSchema.optional(),
        engine: localEngineSchema.nullable(),
        go: limitedGoModeSchema.catch(DEFAULT_ENGINE_GO),
        engineSettings: engineSettingsSchema.optional(),
        timeUnit: timeTypeSchema.optional(),
        incrementUnit: timeTypeSchema.optional(),
    }),
]) as z.ZodType<OpponentSettings, z.ZodTypeDef, unknown>;

export const DEFAULT_TIME_CONTROL: TimeControlField = {
    seconds: 180_000,
    increment: 2_000,
};

export const defaultPlayerSettings: OpponentSettings = {
    type: "human",
    name: "Player",
    timeControl: DEFAULT_TIME_CONTROL,
    timeUnit: "m",
    incrementUnit: "s",
};

export function upgradeOpponentEngine(
    opponent: OpponentSettings,
    engineId: string,
    catalog: EngineCatalogMetadata,
    installed: InstalledEngineResult,
): OpponentSettings {
    if (opponent.type !== "engine" || opponent.engine?.id !== engineId) return opponent;
    return {
        ...opponent,
        engine: upgradeEngineFromCatalog(opponent.engine, catalog, installed),
        ...(opponent.engineSettings == null
            ? {}
            : { engineSettings: upgradeEngineSettings(opponent.engineSettings, installed.config) }),
    };
}

/** Switches discriminated branches without carrying fields owned by the previous branch. */
export function switchOpponentType(
    opponent: OpponentSettings,
    type: "engine" | "human",
): OpponentSettings {
    const shared = {
        ...(opponent.timeControl ? { timeControl: opponent.timeControl } : {}),
        ...(opponent.timeUnit ? { timeUnit: opponent.timeUnit } : {}),
        ...(opponent.incrementUnit ? { incrementUnit: opponent.incrementUnit } : {}),
    };
    if (type === "human") return { type: "human", ...shared, name: "Player" };
    return {
        type: "engine",
        ...shared,
        engine: null,
        go: opponent.type === "engine" ? opponent.go : { ...DEFAULT_ENGINE_GO },
    };
}
