import { tauri } from "@/platform/tauri";
import { type Platform } from "@/platform/native";
import { CatalogVerificationError, loadSignedCatalog } from "@/utils/signedCatalog";
import useSWR from "swr";
import { z } from "zod";
import {
    type BestMoves,
    type EngineHandle,
    type EngineImageHandle,
    type EngineResourceHandle,
    type EngineOption,
    type EngineConfig,
    type EngineOptions,
    type GoMode,
    type InstalledEngineResult,
} from "@/bindings";

export const requiredEngineSettings = ["MultiPV", "Threads", "Hash"];

/**
 * How many lines the engine is asked for (UCI `MultiPV`), read with `parseInt` semantics (a
 * leading integer counts, a fraction truncates); 1 when unset or that integer is below 1.
 */
export function engineMultiPv(settings: EngineOption[]): number {
    const option = settings.findLast((o) => o.name === "MultiPV");
    const value = option?.type === "string" ? Number.parseInt(option.value, 10) : Number.NaN;
    return Number.isInteger(value) && value >= 1 ? value : 1;
}

export function setEngineMultiPv(settings: EngineOption[], count: number): EngineOption[] {
    return settings.map((option) =>
        option.name === "MultiPV" && option.type === "string"
            ? { ...option, value: String(count || 1) }
            : option,
    );
}

/** Defaults for the settings every local engine entry needs. */
export function requiredEngineSettingsDefaults(config: EngineConfig): EngineOption[] {
    return config.options
        .filter((option) => requiredEngineSettings.includes(option.value.name))
        .filter((option) => option.type !== "button")
        .map((option) => ({
            type: "string" as const,
            name: option.value.name,
            value: String(option.value.default ?? ""),
        }));
}

export const goModeSchema: z.ZodSchema<GoMode> = z.union([
    z.object({
        t: z.literal("Depth"),
        c: z.number(),
    }),
    z.object({
        t: z.literal("Time"),
        c: z.number(),
    }),
    z.object({
        t: z.literal("Nodes"),
        c: z.number(),
    }),
    z.object({
        t: z.literal("Infinite"),
    }),
]);

export const engineResourceHandleSchema: z.ZodType<EngineResourceHandle> = z.object({
    id: z.object({ id: z.string().min(1) }),
    kind: z.enum(["file", "directory"]),
    displayName: z.string().min(1),
});
export const engineSettingsSchema: z.ZodType<EngineOption[]> = z.array(
    z.discriminatedUnion("type", [
        z.object({ type: z.literal("string"), name: z.string(), value: z.string() }),
        z.object({
            type: z.literal("resource"),
            name: z.string(),
            resources: z.array(engineResourceHandleSchema).min(1),
        }),
    ]),
);

export type EngineSettings = z.infer<typeof engineSettingsSchema>;

export function isEngineResourcePathOptionName(name: string): boolean {
    return name.toLocaleLowerCase().includes("path");
}

export function isEngineResourceFileOptionName(name: string): boolean {
    return name.toLocaleLowerCase().includes("file");
}

export function isEngineResourceOptionName(name: string): boolean {
    return isEngineResourcePathOptionName(name) || isEngineResourceFileOptionName(name);
}

export function engineOptionValue(option: EngineOption): string | undefined {
    return option.type === "string"
        ? option.value
        : option.resources.map((resource) => resource.displayName).join(":");
}

const persistedEngineSettingsSchema = engineSettingsSchema.transform((settings) => {
    const collapsed = new Map<string, EngineOption>();
    for (const option of settings) {
        collapsed.set(option.name, option);
    }
    return [...collapsed.values()].filter(
        (option) => option.type === "resource" || !isEngineResourceOptionName(option.name),
    );
});

export const engineImageHandleSchema: z.ZodType<EngineImageHandle> = z.object({
    id: z.object({ id: z.string().min(1) }),
    kind: z.literal("engineImage"),
});

const engineHandleSchema: z.ZodType<EngineHandle> = z.object({
    id: z.object({ id: z.string().min(1) }),
    kind: z.literal("engine"),
});

export const localEngineSchema = z.object({
    type: z.literal("local"),
    id: z.string().default(() => crypto.randomUUID()),
    // Absent means never assessed; null means assessed and not a legacy claim.
    // An object keeps this record's historical identity and whether its group was ambiguous.
    legacyAssessment: z
        .object({ identity: z.string(), ambiguous: z.boolean() })
        .nullable()
        .optional(),
    name: z.string(),
    version: z.string(),
    handle: engineHandleSchema,
    filename: z.string().min(1),
    imageHandle: engineImageHandleSchema.nullish(),
    elo: z.number().nullish(),
    downloadSize: z.number().nullish(),
    downloadLink: z.string().nullish(),
    loaded: z.boolean().nullish(),
    go: goModeSchema.nullish(),
    enabled: z.boolean().nullish(),
    settings: persistedEngineSettingsSchema.nullish(),
});

export type LocalEngine = z.output<typeof localEngineSchema>;

export function isManifestEngineInstalled(
    installed: readonly LocalEngine[],
    manifest: { downloadLink?: string | null },
): boolean {
    const link = manifest.downloadLink;
    return Boolean(link) && installed.some((engine) => engine.downloadLink === link);
}

export function defaultEngineProgressId(downloadLink: string): string {
    return `engine:${downloadLink}`;
}

export function manifestEngineInstallCard(
    installed: readonly LocalEngine[],
    manifest: { downloadLink?: string | null },
): { progressId: string | null; initInstalled: boolean } {
    const link = manifest.downloadLink;
    if (!link) {
        return { progressId: null, initInstalled: false };
    }
    return {
        progressId: defaultEngineProgressId(link),
        initInstalled: isManifestEngineInstalled(installed, { downloadLink: link }),
    };
}

export const bundledEngineImagePath = z
    .string()
    .regex(/^\/engines\/[A-Za-z0-9._-]+\.(png|svg|jpe?g|webp)$/);

/**
 * The bundled catalog document is authenticated by a detached minisign signature over its exact
 * bytes. Per-entry signatures still authenticate only the download URL and SHA-256; the backend
 * remains the containment boundary for `path`.
 */
export const defaultEngineManifestSchema = z
    .object({
        type: z.literal("local"),
        name: z.string().min(1),
        version: z.string(),
        path: z
            .string()
            .min(1)
            // DEFENCE IN DEPTH: mirror the backend's relative-component checks; the backend
            // remains the containment boundary (`src-tauri/src/infra/path_authority.rs`).
            .refine(
                (path) =>
                    !path.includes("\0") &&
                    !path.includes("\\") &&
                    !path.startsWith("/") &&
                    !/^[A-Za-z]:/.test(path) &&
                    !path.includes("//") &&
                    !path.endsWith("/") &&
                    path.split("/").every((segment) => segment !== "." && segment !== ".."),
                "path must contain only relative, non-traversing components",
            ),
        downloadLink: z.string().url(),
        sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
        signature: z.string().min(1),
        // Catalog portraits are bundled under public/engines/. Remote URLs are rejected so
        // display cannot fetch extra hosts and CSP img-src does not need widening.
        image: bundledEngineImagePath.optional(),
        imageUrl: bundledEngineImagePath.optional(),
        os: z.enum([
            "linux",
            "macos",
            "ios",
            "freebsd",
            "dragonfly",
            "netbsd",
            "openbsd",
            "solaris",
            "android",
            "windows",
        ]),
        bmi2: z.boolean(),
    })
    .passthrough();

/** Entry from the verified catalog, used for installation and portraits, never persisted as an engine. */
export type DefaultEngine = Omit<LocalEngine, "handle" | "filename"> & {
    path: string;
    sha256: string;
    signature: string;
    imageUrl?: string;
    os: z.infer<typeof defaultEngineManifestSchema>["os"];
    bmi2: boolean;
};

const remoteEngineSchema = z.object({
    type: z.enum(["chessdb", "lichess"]),
    id: z.string().default(() => crypto.randomUUID()),
    name: z.string(),
    url: z.string(),
    imageHandle: engineImageHandleSchema.nullish(),
    loaded: z.boolean().nullish(),
    enabled: z.boolean().nullish(),
    go: goModeSchema.nullish(),
    settings: persistedEngineSettingsSchema.nullish(),
});

export type RemoteEngine = z.output<typeof remoteEngineSchema>;

export const engineSchema = z.union([localEngineSchema, remoteEngineSchema]);
export type Engine = z.output<typeof engineSchema>;

export function parsePersistedEngineJson(value: string) {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return { success: false as const };
    }
    return engineSchema.safeParse(parsed);
}

export async function stopEngine(
    engine: LocalEngine,
    tab: string,
    expectedGeneration: string | null = null,
): Promise<boolean> {
    return tauri.stopEngine(engine.id, tab, expectedGeneration);
}

export function prepareEngineSearch(engine: LocalEngine, tab: string): Promise<string> {
    return tauri.prepareEngineSearch(engine.id, engine.handle, tab);
}

export async function releaseEngineSearch(
    engine: LocalEngine,
    tab: string,
    generation: string,
): Promise<void> {
    await tauri.releaseEngineSearch(engine.id, tab, generation);
}

export async function killEngine(engine: LocalEngine, tab: string): Promise<void> {
    await tauri.killEngine(engine.id, tab);
}

export async function retireEngine(engine: LocalEngine): Promise<void> {
    await tauri.retireEngine(engine.id);
}

export function getBestMoves(
    engine: LocalEngine,
    tab: string,
    goMode: GoMode,
    options: EngineOptions,
    generation: string,
): Promise<[number, BestMoves[]] | null> {
    return tauri.getBestMoves(engine.id, engine.handle, tab, goMode, options, generation);
}

/** Raised when the bundled engine catalog does not match its release signature. */
export class EngineCatalogVerificationError extends CatalogVerificationError {
    constructor(cause: unknown) {
        super(cause, "engine catalog signature verification failed");
        this.name = "EngineCatalogVerificationError";
    }
}

/** The local CPU-capability IPC failed; no catalog build can safely be offered. */
export class EngineCapabilityQueryError extends Error {
    constructor(cause: unknown) {
        super("engine CPU-capability query failed", { cause });
        this.name = "EngineCapabilityQueryError";
    }
}

export async function loadDefaultEngineCatalog(
    document?: string,
    signature?: string,
): Promise<DefaultEngine[]> {
    // Startup recovery needs engine schemas and application helpers, but no catalog lookup.
    // Load signed catalog bytes on demand for installation, upgrades or saved-engine portraits.
    const [catalogDocument, catalogSignature] = await Promise.all([
        document ?? import("@/catalogs/engines.json?raw").then((module) => module.default),
        signature ?? import("@/catalogs/engines.json.minisig?raw").then((module) => module.default),
    ]);
    let parsed: z.infer<typeof defaultEngineManifestSchema>[];
    try {
        parsed = await loadSignedCatalog(
            catalogDocument,
            catalogSignature,
            z.array(defaultEngineManifestSchema),
        );
    } catch (error) {
        // Keep the engine-specific type so AddEngine maps it to its catalog error.
        if (error instanceof CatalogVerificationError) {
            throw new EngineCatalogVerificationError(error.cause);
        }
        throw error;
    }
    return parsed.map((engine) => {
        const imageUrl = engine.imageUrl ?? engine.image;
        return (imageUrl ? { ...engine, imageUrl } : engine) as unknown as DefaultEngine;
    });
}

export async function loadCompatibleEngineCatalog(os: Platform): Promise<DefaultEngine[]> {
    let bmi2: boolean;
    try {
        bmi2 = await tauri.isBmi2Compatible();
    } catch (error) {
        throw new EngineCapabilityQueryError(error);
    }
    const engines = await loadDefaultEngineCatalog();
    return engines.filter((engine) => engine.os === os && engine.bmi2 === bmi2);
}

export async function loadStockfishCatalogEntry(os: Platform): Promise<DefaultEngine | undefined> {
    return selectStockfishCatalogEntry(await loadCompatibleEngineCatalog(os));
}

export function selectStockfishCatalogEntry(engines: readonly DefaultEngine[] | undefined) {
    return engines?.find((engine) => engine.name === "Stockfish");
}

export function useDefaultEngines(os: Platform | undefined, opened: boolean) {
    const { data, error, isLoading } = useSWR(opened ? os : null, loadCompatibleEngineCatalog);
    return {
        defaultEngines: data,
        error,
        isLoading,
    };
}

export {
    installCatalogEngine,
    installCatalogEngine as installDefaultEngine,
} from "./engineInstall";

export type EngineCatalogMetadata = Pick<
    DefaultEngine,
    "name" | "version" | "elo" | "downloadSize" | "downloadLink"
>;

export function installedEngineFromCompletion(
    id: string,
    engine: EngineCatalogMetadata,
    installed: InstalledEngineResult,
): LocalEngine {
    const { handle, config, filename } = installed;
    return localEngineSchema.parse({
        id,
        type: "local",
        name: engine.name,
        version: engine.version,
        elo: engine.elo,
        downloadSize: engine.downloadSize,
        downloadLink: engine.downloadLink,
        handle,
        filename,
        loaded: true,
        settings: requiredEngineSettingsDefaults(config),
    });
}

/** Preserve advertised preferences and fill missing required options from the new binary. */
export function upgradeEngineSettings(
    settings: EngineOption[] | null | undefined,
    config: EngineConfig,
): EngineOption[] {
    const names = new Set(config.options.map((option) => option.value.name));
    const kept = (settings ?? []).filter((option) => names.has(option.name));
    return [
        ...kept,
        ...requiredEngineSettingsDefaults(config).filter(
            (option) => !kept.some((stored) => stored.name === option.name),
        ),
    ];
}

/** Swaps binary metadata while retaining this entry's identity and user preferences. */
export function upgradeEngineFromCatalog(
    engine: LocalEngine,
    catalogEntry: EngineCatalogMetadata,
    installed: InstalledEngineResult,
): LocalEngine {
    return localEngineSchema.parse({
        ...engine,
        handle: installed.handle,
        filename: installed.filename,
        name: installed.config.name,
        version: catalogEntry.version,
        elo: catalogEntry.elo,
        downloadLink: catalogEntry.downloadLink,
        downloadSize: catalogEntry.downloadSize,
        settings: upgradeEngineSettings(engine.settings, installed.config),
    });
}
