import equal from "fast-deep-equal";
import { z } from "zod";
import type { PathOwnerFamily, PathRef, StartupPathOwners } from "@/bindings";
import { tauri } from "@/platform/tauri";
import { isDatabaseRecent, recentFileSchema } from "./recentFiles";
import { decodeCompressedOrJson } from "./store/debouncedStorage";
import {
    EXPANDED_DIRECTORIES_STORAGE_KEY,
    parseExpandedDirectoriesValue,
    repairExpandedDirectoriesAtStartup,
} from "./expandedDirectories";
import { tabSchema } from "./workspaceTypes";
import { reportPreferenceStorageFailure } from "./utils";
import { reportPersistError } from "./persistError";
import {
    databaseHandleSchema,
    fileWorkspaceHandleSchema,
    fileWorkspaceKey,
    pathRefKey,
    pathRefSchema,
} from "@/utils/pathCapabilities";
import {
    collectOriginalEngineOwnerSnapshot,
    reconcileStartupEngineAttachments,
} from "./engineOwnerStorage";
import {
    ensurePracticeMigration,
    listPracticeDecks,
    reportPracticeInventoryAnomalies,
    retireMigratedLegacyDeckKeysFromBrowser,
    scanLegacyPracticeDeckKeys,
    type PracticeLegacyDeckScan,
} from "./practiceStorage";

type StorageRead = { present: false } | { present: true; value: unknown } | { failed: true };

function readJson(storage: Storage, key: string): StorageRead {
    try {
        const raw = storage.getItem(key);
        if (raw === null) return { present: false };
        return { present: true, value: JSON.parse(raw) as unknown };
    } catch {
        return { failed: true };
    }
}

function readCompressed(storage: Storage, key: string): StorageRead {
    try {
        const raw = storage.getItem(key);
        if (raw === null) return { present: false };
        const value = decodeCompressedOrJson(raw);
        return value === null ? { failed: true } : { present: true, value };
    } catch {
        return { failed: true };
    }
}

function collectOne<T>(
    read: StorageRead,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    consume: (value: T) => void,
): boolean {
    if ("failed" in read) return false;
    if (!read.present) return true;
    const parsed = schema.safeParse(read.value);
    if (!parsed.success || !equal(read.value, parsed.data)) return false;
    consume(parsed.data);
    return true;
}

type OriginalOwnerSnapshots = {
    pathOwners: StartupPathOwners;
    engineAttachmentIds: PathRef[] | null;
};

function collectOriginalSnapshots(local?: Storage, session?: Storage): OriginalOwnerSnapshots {
    const ids = new Set<string>();
    const trusted = new Set<PathOwnerFamily>();
    const trust = (family: PathOwnerFamily, ok: boolean) => {
        if (ok) trusted.add(family);
    };

    try {
        local ??= globalThis.localStorage;
        session ??= globalThis.sessionStorage;
    } catch {
        return {
            pathOwners: { retainedIds: [], trustedFamilies: [] },
            engineAttachmentIds: null,
        };
    }

    trust(
        "downloadDestination",
        collectOne(
            readJson(local, "download-destination-capability"),
            pathRefSchema.nullable(),
            (value) => value && ids.add(pathRefKey(value)),
        ),
    );
    let currentWorkspaceId: string | null = null;
    const fileWorkspaceReadable = collectOne(
        readJson(local, "file-workspace"),
        fileWorkspaceHandleSchema.nullable(),
        (value) => {
            if (!value) return;
            currentWorkspaceId = fileWorkspaceKey(value);
            ids.add(pathRefKey(value.id));
        },
    );
    trust("fileWorkspace", fileWorkspaceReadable);
    trust(
        "recentFiles",
        collectOne(readJson(local, "recent-files"), z.array(recentFileSchema), (values) =>
            values.forEach((entry) =>
                ids.add(pathRefKey(isDatabaseRecent(entry) ? entry.database.id : entry.handle.id)),
            ),
        ),
    );
    trust(
        "referenceDatabase",
        collectOne(
            readJson(local, "reference-database"),
            databaseHandleSchema.nullable(),
            (value) => value && ids.add(pathRefKey(value.id)),
        ),
    );
    trust(
        "puzzleDatabase",
        collectOne(
            readJson(local, "puzzle-db"),
            pathRefSchema.nullable(),
            (value) => value && ids.add(pathRefKey(value)),
        ),
    );
    trust(
        "openingBook",
        collectOne(
            readJson(local, "game-opening-book-handle"),
            z.object({ id: pathRefSchema, kind: z.literal("openingBook") }).nullable(),
            (value) => value && ids.add(pathRefKey(value.id)),
        ),
    );

    const engineOwners = collectOriginalEngineOwnerSnapshot(local);
    engineOwners.capabilityIds.forEach((id) => ids.add(id));
    trust("engines", engineOwners.trusted);

    const workspaceSchema = z.object({ tabs: z.array(tabSchema) }).passthrough();
    const tabsSchema = z.array(tabSchema);
    const consumeTabs = (tabs: z.output<typeof tabsSchema>) => {
        for (const tab of tabs) {
            if (tab.gameOrigin.kind === "file" || tab.gameOrigin.kind === "temp_file") {
                ids.add(pathRefKey(tab.gameOrigin.file.handle.id));
            } else if (
                tab.gameOrigin.kind === "database" ||
                tab.gameOrigin.kind === "databaseDraft"
            ) {
                ids.add(pathRefKey(tab.gameOrigin.database.id));
            }
        }
    };
    let workspaceTrusted = collectOne(
        readCompressed(session, "workspace"),
        workspaceSchema,
        (value) => consumeTabs(value.tabs),
    );
    workspaceTrusted =
        collectOne(readCompressed(session, "tabs"), tabsSchema, consumeTabs) && workspaceTrusted;
    trust("sessionWorkspace", workspaceTrusted);

    const expandedDirectoriesRead = readCompressed(session, EXPANDED_DIRECTORIES_STORAGE_KEY);
    let expandedDirectoriesTrusted = false;
    if (fileWorkspaceReadable && !("failed" in expandedDirectoriesRead)) {
        if (!expandedDirectoriesRead.present) {
            expandedDirectoriesTrusted = true;
        } else {
            const parsed = parseExpandedDirectoriesValue(expandedDirectoriesRead.value);
            if (parsed.kind === "record") {
                expandedDirectoriesTrusted = true;
                if (
                    currentWorkspaceId !== null &&
                    parsed.record.workspaceId === currentWorkspaceId
                ) {
                    parsed.ids.forEach((id) => ids.add(id));
                }
            }
        }
    }
    trust("expandedDirectories", expandedDirectoriesTrusted);
    trust(
        "databaseView",
        collectOne(
            readCompressed(session, "database-view"),
            z
                .object({
                    state: z
                        .object({
                            database: z
                                .object({ file: databaseHandleSchema })
                                .passthrough()
                                .optional(),
                        })
                        .passthrough(),
                })
                .passthrough(),
            (value) =>
                value.state.database?.file && ids.add(pathRefKey(value.state.database.file.id)),
        ),
    );

    return {
        pathOwners: {
            retainedIds: [...ids].sort().map((id) => ({ id })),
            trustedFamilies: [...trusted].sort(),
        },
        engineAttachmentIds: engineOwners.attachmentIds?.map((id) => ({ id })) ?? null,
    };
}

export function collectOriginalPathOwners(local?: Storage, session?: Storage): StartupPathOwners {
    const snapshots = collectOriginalSnapshots(local, session).pathOwners;
    const scan = scanLegacyPracticeDeckKeys(local);
    const retainedIds = new Set(snapshots.retainedIds.map(({ id }) => id));
    scan.keys.forEach(({ identity }) => retainedIds.add(identity.file));
    return {
        retainedIds: [...retainedIds].sort().map((id) => ({ id })),
        trustedFamilies: scan.trusted
            ? [...new Set([...snapshots.trustedFamilies, "practiceDeck" as const])].sort()
            : snapshots.trustedFamilies,
    };
}

let originalSnapshots: OriginalOwnerSnapshots | undefined;

/** Capture original authority once, before any repair can replace its evidence. */
export function initializeOriginalPathOwners(): OriginalOwnerSnapshots {
    if (!originalSnapshots) {
        originalSnapshots = collectOriginalSnapshots();
        try {
            repairExpandedDirectoriesAtStartup(globalThis.sessionStorage);
        } catch (cause) {
            reportPreferenceStorageFailure("read", cause);
        }
    }
    return originalSnapshots;
}

let initialization: Promise<void> | undefined;
let legacyDeckScanComplete = false;

export function startupLegacyDeckScanComplete(): boolean {
    return legacyDeckScanComplete;
}

export function initializePathOwners(): Promise<void> {
    const {
        pathOwners: originalPathOwnersSnapshot,
        engineAttachmentIds: originalEngineAttachmentIds,
    } = initializeOriginalPathOwners();
    if (!initialization) {
        initialization = (async () => {
            const migration = await ensurePracticeMigration();

            let inventory: Awaited<ReturnType<typeof listPracticeDecks>> | null = null;
            let inventoryTrusted = true;
            try {
                inventory = await listPracticeDecks();
                reportPracticeInventoryAnomalies(inventory);
            } catch {
                inventoryTrusted = false;
            }
            const scan: PracticeLegacyDeckScan = scanLegacyPracticeDeckKeys();
            legacyDeckScanComplete = scan.complete;
            const retainedIds = new Set(originalPathOwnersSnapshot.retainedIds.map(({ id }) => id));
            inventory?.decks.forEach(({ fileId }) => retainedIds.add(fileId));
            inventory?.anomalies.forEach((anomaly) => {
                if (
                    (anomaly.kind === "OrphanShard" ||
                        anomaly.kind === "DamagedDeck" ||
                        anomaly.kind === "Unreadable") &&
                    anomaly.fileId
                ) {
                    retainedIds.add(anomaly.fileId);
                }
            });
            scan.keys.forEach(({ identity }) => retainedIds.add(identity.file));

            const trustedFamilies = new Set(originalPathOwnersSnapshot.trustedFamilies);
            if (inventoryTrusted && scan.trusted && inventory && inventory.anomalies.length === 0) {
                trustedFamilies.add("practiceDeck");
            }
            const owners = tauri.reconcileStartupPathOwners({
                retainedIds: [...retainedIds].sort().map((id) => ({ id })),
                trustedFamilies: [...trustedFamilies].sort(),
            });
            await reconcileStartupEngineAttachments(originalEngineAttachmentIds, owners);
            try {
                if (scan.complete) retireMigratedLegacyDeckKeysFromBrowser(migration.outcomes);
            } catch (error) {
                reportPersistError(error);
            }
        })();
    }
    const current = initialization;
    return current;
}

export function resetPathOwnerInitializationForTests() {
    initialization = undefined;
    legacyDeckScanComplete = false;
}
