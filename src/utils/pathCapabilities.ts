import { z } from "zod";
import type { DatabaseHandle, FileWorkspaceHandle, PathRef } from "@/bindings";

type NestedCapabilityHandle = { id: PathRef };

/**
 * Renderer widgets require primitive values for keys and selection controls. This is the only
 * projection of an opaque workspace capability: it is never sent back to native tauri.
 */
export function fileWorkspaceKey(handle: FileWorkspaceHandle): string {
    return capabilityKey(handle);
}

/** A primitive widget key derived from an opaque handle, never a native path. */
export function pathRefKey(handle: PathRef): string {
    return handle.id;
}

/** A primitive widget key derived from any opaque authority handle, never a native path. */
export function capabilityKey(handle: PathRef | NestedCapabilityHandle): string {
    return typeof handle.id === "string" ? handle.id : pathRefKey(handle.id);
}

/** Renderer fallback only; display metadata remains separate from an opaque capability. */
export function capabilityDisplayName(displayName: string, fallback: string): string {
    return displayName.trim() || fallback;
}

// Stryker disable all: Vitest proves these exported schemas directly, but the runner cannot
// activate mutants created during ESM module initialization.
export const pathRefSchema = z.object({ id: z.string().min(1) });
export const fileWorkspaceHandleSchema: z.ZodType<FileWorkspaceHandle> = z.object({
    id: pathRefSchema,
    kind: z.literal("fileWorkspace"),
});
export const databaseHandleSchema: z.ZodType<DatabaseHandle> = z.object({
    id: pathRefSchema,
    kind: z.literal("database"),
});

/** A Lichess source stored as the board explorer's app-wide second column. */
export const explorerOnlineSourceSchema = z.enum(["lch_all", "lch_master"]);

/**
 * The stored second source of the board explorer: a local database handle, a Lichess source, or
 * none. A handle and `null` keep their present shape.
 */
export const comparisonSourceSchema = z
    .union([databaseHandleSchema, explorerOnlineSourceSchema])
    .nullable();

export type ComparisonSource = z.infer<typeof comparisonSourceSchema>;

export function isDatabaseComparisonSource(value: ComparisonSource): value is DatabaseHandle {
    return typeof value === "object" && value !== null;
}

export const linkedGameLocatorSchema = z.object({
    collection: z.string().uuid(),
    generation: z.string().min(1).max(256),
    ordinal: z.number().int().nonnegative(),
    stamp: z.string().regex(/^[a-f0-9]{64}$/),
});
// Stryker restore all
