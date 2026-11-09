import type { SyncStringStorage } from "jotai/vanilla/utils/atomWithStorage";
import { z } from "zod";
import i18n from "@/i18n";
import enUSCatalogue from "@/translation/en-US.json";
import { decodeCompressedOrJson, serializeStorageValue } from "./store/debouncedStorage";
import { createTabIdSchema, persistStorageWriteError, tabStorage } from "./store/tabStorage";
import { reportPersistError } from "./persistError";
import { getTabTreeKey, newWorkspaceId, tabSchema, type Tab } from "./workspaceTypes";
import {
    LEGACY_PUZZLE_SUFFIX,
    legacyPuzzleKey,
    removeLegacyPuzzleKey,
    restorePuzzleSession,
} from "./puzzleSession";
import { defaultTree, type TreeState } from "@/utils/treeReducer";

export const WORKSPACE_STORAGE_KEY = "workspace";
export class WorkspaceReadError extends Error {
    constructor(cause: unknown) {
        super("Could not read the saved workspace", { cause });
        this.name = "WorkspaceReadError";
    }
}
const WORKSPACE_VERSION = 1;
export const LEGACY_WORKSPACE_VERSION = 0;

/**
 * Ownership snapshots persist at most 1,024 tree keys, each no longer than 128 characters.
 * Larger snapshots fail closed: the uncertainty marker remains and orphan sweeping is skipped.
 */
export const MAX_PROTECTED_TREE_KEYS = 1_024;
export const MAX_PROTECTED_TREE_KEY_LENGTH = 128;

export type Workspace = z.infer<ReturnType<typeof createLiveWorkspaceSchema>>;

export const MAX_WORKSPACE_TABS = 100;
export const MAX_PENDING_TREE_REMOVALS = 100;
export const MAX_PENDING_PUZZLE_REMOVALS = 100;
const MAX_LEGACY_PUZZLE_REMOVAL_KEY_LENGTH = 256;
const MAX_ACTIVE_TAB_ID_LENGTH = 128;

function createLiveWorkspaceSchema() {
    return z.object({
        version: z.literal(WORKSPACE_VERSION),
        tabs: z
            .array(tabSchema)
            .max(MAX_WORKSPACE_TABS)
            .refine(
                (tabs) =>
                    new Set(tabs.map(getTabTreeKey)).size === tabs.length &&
                    new Set(tabs.map((tab) => tab.value)).size === tabs.length,
            ),
        activeTab: z.string().max(MAX_ACTIVE_TAB_ID_LENGTH).nullable(),
        treeOwnershipUncertain: z.literal(true).optional(),
        treeOwnershipProtectedIds: z
            .array(z.string().min(1).max(MAX_PROTECTED_TREE_KEY_LENGTH))
            .max(MAX_PROTECTED_TREE_KEYS)
            .optional(),
        treeOwnershipPendingRemovalIds: z
            .array(z.string().min(1))
            .max(MAX_PENDING_TREE_REMOVALS)
            .optional(),
        // Remove this legacy-only field and its replay when migration is retired and no
        // supported workspace carries outstanding history cleanup intents (d-20261015-24).
        legacyPuzzleRemovalKeys: z
            .array(
                z
                    .string()
                    .min(LEGACY_PUZZLE_SUFFIX.length)
                    .max(MAX_LEGACY_PUZZLE_REMOVAL_KEY_LENGTH)
                    .endsWith(LEGACY_PUZZLE_SUFFIX),
            )
            .max(MAX_PENDING_PUZZLE_REMOVALS)
            .refine((keys) => new Set(keys).size === keys.length)
            .optional(),
    });
}

function createWorkspaceLoadSchemas() {
    const workspaceLiveSchema = createLiveWorkspaceSchema();
    const workspaceInputSchema = z.object({
        version: z.number().int().nonnegative().optional().catch(undefined),
        // Scrub individual legacy/corrupt tabs while keeping every independently
        // valid tab recoverable. A corrupt entry must not erase its neighbours.
        tabs: z
            .array(tabSchema.nullable().catch(null))
            .max(MAX_WORKSPACE_TABS)
            .transform((tabs) => tabs.filter((tab): tab is Tab => tab !== null)),
        activeTab: workspaceLiveSchema.shape.activeTab.catch(null),
    });
    const legacyWorkspaceSchema = workspaceInputSchema.extend({
        version: z.literal(LEGACY_WORKSPACE_VERSION).optional(),
        tabs: z.array(tabSchema).max(MAX_WORKSPACE_TABS),
    });
    const uncertainOwnershipSchema = workspaceLiveSchema
        .pick({ treeOwnershipUncertain: true })
        .required();
    return {
        workspaceInputSchema,
        workspaceLiveSchema,
        legacyWorkspaceSchema,
        uncertainOwnershipSchema,
        uuidSchema: createTabIdSchema(),
    };
}

type WorkspaceLoadSchemas = ReturnType<typeof createWorkspaceLoadSchemas>;

function newTab(used: Iterable<string>): Tab {
    return {
        name: "Tab.NewTab",
        value: newWorkspaceId(used),
        type: "new",
        gameOrigin: { kind: "none" },
    };
}

export function defaultWorkspace(): Workspace {
    const first = newTab(new Set());
    return { version: WORKSPACE_VERSION, tabs: [first], activeTab: first.value };
}

type WorkspaceRepairPlan = {
    workspace: Workspace;
    unrepairedWorkspace: Workspace;
    cloneTargets: Array<{
        sourceId: string;
        logicalId: string;
        puzzle: boolean;
        targetId: string;
        requireExisting: boolean;
    }>;
};

function resolveActiveTab(tabs: readonly Tab[], legacyActive: string | null): string {
    return tabs.some((tab) => tab.value === legacyActive) ? legacyActive! : tabs[0]!.value;
}

function planWorkspaceRepair(
    input: unknown,
    { workspaceInputSchema, uuidSchema }: WorkspaceLoadSchemas,
): WorkspaceRepairPlan {
    const inputResult = workspaceInputSchema.safeParse(input);
    if (!inputResult.success) {
        const workspace = defaultWorkspace();
        return {
            workspace,
            unrepairedWorkspace: workspace,
            cloneTargets: [],
        };
    }
    const parsed = inputResult.data;
    const candidates = parsed.tabs;
    const ids = new Set<string>();
    const treeKeys = new Set<string>();
    const reserved = candidates.flatMap((tab) => [tab.value, getTabTreeKey(tab)]);
    const cloneTargets: WorkspaceRepairPlan["cloneTargets"] = [];
    const tabs = candidates.map((tab) => {
        const sourceId = getTabTreeKey(tab);
        const validId = uuidSchema.safeParse(tab.value).success && !ids.has(tab.value);
        if (validId && !treeKeys.has(sourceId)) {
            ids.add(tab.value);
            treeKeys.add(sourceId);
            return tab;
        }

        const migratedId = newWorkspaceId([...reserved, ...ids, ...treeKeys]);
        cloneTargets.push({
            sourceId,
            logicalId: tab.value,
            puzzle: tab.type === "puzzles",
            targetId: migratedId,
            requireExisting: tab.treeKey !== undefined,
        });
        const repaired: Tab = {
            ...tab,
            value: validId ? tab.value : migratedId,
            treeKey: migratedId,
        };
        if (!validId) delete repaired.treeKey;
        ids.add(repaired.value);
        treeKeys.add(migratedId);
        return repaired;
    });

    if (tabs.length === 0) tabs.push(newTab(ids));
    const legacyActive = parsed.activeTab;
    const legacyActiveIndex = candidates.findIndex((tab) => tab.value === legacyActive);
    const activeTab = legacyActiveIndex === -1 ? tabs[0]!.value : tabs[legacyActiveIndex]!.value;
    const unrepairedTabs = candidates.length > 0 ? candidates : tabs;
    const unrepairedActiveTab = resolveActiveTab(unrepairedTabs, legacyActive);
    return {
        workspace: { version: WORKSPACE_VERSION, tabs, activeTab },
        unrepairedWorkspace: {
            version: WORKSPACE_VERSION,
            tabs: unrepairedTabs,
            activeTab: unrepairedActiveTab,
        },
        cloneTargets,
    };
}

/** Failed removals remain excluded from this load's sweep so they are not retried twice. */
export function sweepOrphanedTreeKeys(
    retainedTabs: readonly Tab[],
    protectedTreeIds: readonly string[] = [],
    failedKnownRemovals: ReadonlySet<string> = new Set(),
) {
    const retainedIds = new Set([
        ...retainedTabs.map(getTabTreeKey),
        ...protectedTreeIds,
        ...failedKnownRemovals,
    ]);
    tabStorage.removeOrphanedTrees(retainedIds);
}

/** Reconcile durable deletion intents before a workspace write can exceed its schema bound. */
export function reconcilePendingTreeRemovals(
    priorIds: readonly string[],
    newIds: Iterable<string>,
    retainedIds: ReadonlySet<string>,
): { ids: string[]; droppedIds: string[]; unreadableIds: Set<string> } {
    const unreadableIds = new Set<string>();
    let firstError: unknown;
    let prior = priorIds.filter((id) => {
        if (retainedIds.has(id)) return false;
        try {
            return tabStorage.hasPendingRemovalTarget(id);
        } catch (error) {
            if (unreadableIds.size === 0) firstError = error;
            unreadableIds.add(id);
            return true;
        }
    });
    if (unreadableIds.size > 0) reportPersistError(persistStorageWriteError(firstError));
    const additions = [...newIds].filter((id) => !retainedIds.has(id));
    let pending = new Set([...prior, ...additions]);
    if (pending.size > MAX_PENDING_TREE_REMOVALS) {
        const failedPriorRemovals = tabStorage.removeKnownTreesSafely(
            prior.filter((id) => !unreadableIds.has(id)),
        );
        prior = prior.filter((id) => {
            if (failedPriorRemovals.has(id) || unreadableIds.has(id)) return true;
            try {
                return sessionStorage.getItem(id) !== null;
            } catch {
                return true;
            }
        });
        pending = new Set([...prior, ...additions]);
    }
    const { kept, dropped } = boundPendingRemovals(pending, MAX_PENDING_TREE_REMOVALS);
    return { ids: kept, droppedIds: dropped, unreadableIds };
}

function boundPendingRemovals(pending: ReadonlySet<string>, cap: number) {
    const entries = [...pending];
    const overflow = Math.max(0, entries.length - cap);
    return { kept: entries.slice(overflow), dropped: entries.slice(0, overflow) };
}

/** Old intents already carry durable authority. New keys cannot be removed before publication. */
export function reconcileLegacyPuzzleRemovals(
    prior: readonly string[],
    retiredLogicalIds: Iterable<string>,
    retainedTabs: readonly Tab[],
): { keys: string[]; droppedKeys: string[] } {
    const retained = new Set(retainedTabs.map((tab) => legacyPuzzleKey(tab.value)));
    const keys = new Set(prior.filter((key) => !retained.has(key) && !removeLegacyPuzzleKey(key)));
    for (const id of retiredLogicalIds) {
        const key = legacyPuzzleKey(id);
        if (!retained.has(key)) keys.add(key);
    }
    const { kept, dropped } = boundPendingRemovals(keys, MAX_PENDING_PUZZLE_REMOVALS);
    return { keys: kept, droppedKeys: dropped };
}

/** UUID orphans are discoverable only with authoritative workspace ownership. */
export function sweepLegacyPuzzleKeys(workspace: Workspace) {
    workspace.legacyPuzzleRemovalKeys?.forEach(removeLegacyPuzzleKey);
    if (workspace.treeOwnershipUncertain) return;
    const retained = new Set(workspace.tabs.map((tab) => legacyPuzzleKey(tab.value)));
    const uuid = createTabIdSchema();
    try {
        const keys = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i));
        for (const key of keys) {
            if (
                key?.endsWith(LEGACY_PUZZLE_SUFFIX) &&
                !retained.has(key) &&
                uuid.safeParse(key.slice(0, -LEGACY_PUZZLE_SUFFIX.length)).success
            )
                removeLegacyPuzzleKey(key);
        }
    } catch (error) {
        reportPersistError(persistStorageWriteError(error));
    }
}

const workspaceErrorKey = "Common.ConfirmationError.unexpected";

function workspaceActionError(cause: Error): Error {
    // Workspace hydration can report an error before index.tsx initializes i18next.
    return new Error(i18n.t(workspaceErrorKey) || enUSCatalogue.translation[workspaceErrorKey], {
        cause,
    });
}

export function pendingTreeRemovalCapacityError(droppedCount: number): Error {
    return new Error(
        i18n.t("Common.PendingTreeRemovalOverflow") ||
            enUSCatalogue.translation["Common.PendingTreeRemovalOverflow"],
        {
            cause: new Error(
                `Pending tree removals exceeded ${MAX_PENDING_TREE_REMOVALS}; dropped ${droppedCount}`,
            ),
        },
    );
}

export function pendingPuzzleRemovalCapacityError(droppedCount: number): Error {
    return new Error(
        i18n.t("Common.PendingPuzzleRemovalOverflow") ||
            enUSCatalogue.translation["Common.PendingPuzzleRemovalOverflow"],
        {
            cause: new Error(
                `Pending legacy puzzle removals exceeded ${MAX_PENDING_PUZZLE_REMOVALS}; dropped ${droppedCount}`,
            ),
        },
    );
}

export function reportPendingRemovalOverflow(
    droppedTreeCount: number,
    droppedPuzzleCount: number,
): void {
    if (droppedTreeCount > 0) reportPersistError(pendingTreeRemovalCapacityError(droppedTreeCount));
    if (droppedPuzzleCount > 0)
        reportPersistError(pendingPuzzleRemovalCapacityError(droppedPuzzleCount));
}

export function readStoredWorkspaceValue(storage: SyncStringStorage, key: string): unknown | null {
    return decodeCompressedOrJson(storage.getItem(key));
}

function workspaceFromValue(value: unknown): Workspace | null {
    const workspaceLiveSchema = createLiveWorkspaceSchema();
    const parsed = workspaceLiveSchema.safeParse(value);
    if (!parsed.success) return null;
    const tabs = parsed.data.tabs;
    const workspace: Workspace = {
        version: WORKSPACE_VERSION,
        tabs,
        activeTab: tabs.length === 0 ? null : resolveActiveTab(tabs, parsed.data.activeTab),
    };
    if (parsed.data.treeOwnershipUncertain) {
        workspace.treeOwnershipUncertain = true;
        if (parsed.data.treeOwnershipProtectedIds !== undefined) {
            workspace.treeOwnershipProtectedIds = parsed.data.treeOwnershipProtectedIds;
        }
    }
    if (parsed.data.treeOwnershipPendingRemovalIds !== undefined) {
        workspace.treeOwnershipPendingRemovalIds = parsed.data.treeOwnershipPendingRemovalIds;
    }
    if (parsed.data.legacyPuzzleRemovalKeys !== undefined)
        workspace.legacyPuzzleRemovalKeys = parsed.data.legacyPuzzleRemovalKeys;
    return workspace;
}

/** Saves and returns the exact canonical workspace acknowledged by synchronous storage. */
export function saveWorkspace(
    storage: SyncStringStorage,
    key: string,
    value: unknown,
): Workspace | null {
    const workspace = workspaceFromValue(value);
    if (!workspace) {
        reportPersistError(
            workspaceActionError(new Error("Workspace failed live schema validation")),
        );
        return null;
    }
    try {
        storage.setItem(key, serializeStorageValue(workspace));
        return workspace;
    } catch (error) {
        reportPersistError(persistStorageWriteError(error));
        return null;
    }
}

/** Migrates separate legacy tabs/activeTab keys into one repairable envelope. */
export function loadWorkspace(storage: SyncStringStorage, key: string): Workspace {
    const schemas = createWorkspaceLoadSchemas();
    const { workspaceLiveSchema, legacyWorkspaceSchema, uncertainOwnershipSchema } = schemas;
    let storedWorkspace: string | null;
    let legacy: unknown;
    let current: unknown;
    try {
        storedWorkspace = storage.getItem(key);
        current = decodeCompressedOrJson(storedWorkspace);
        legacy = current ?? {
            tabs: readStoredWorkspaceValue(storage, "tabs"),
            activeTab: readStoredWorkspaceValue(storage, "activeTab"),
        };
    } catch (error) {
        throw new WorkspaceReadError(error);
    }
    const currentResult = workspaceLiveSchema.safeParse(current);
    const hasAuthoritativeWorkspace = currentResult.success;
    const persistedProtectedTreeIds =
        currentResult.success && currentResult.data.treeOwnershipUncertain
            ? currentResult.data.treeOwnershipProtectedIds
            : undefined;
    const persistedPendingRemovals = currentResult.success
        ? (currentResult.data.treeOwnershipPendingRemovalIds ?? [])
        : [];
    const persistedPuzzleRemovals = currentResult.success
        ? (currentResult.data.legacyPuzzleRemovalKeys ?? [])
        : [];
    const validMigrationSource = legacyWorkspaceSchema.safeParse(
        storedWorkspace === null ? legacy : current,
    ).success;
    let legacyStoragePresent = false;
    let legacyPresenceReadable = true;
    try {
        legacyStoragePresent =
            storage.getItem("tabs") !== null || storage.getItem("activeTab") !== null;
    } catch (error) {
        legacyPresenceReadable = false;
        reportPersistError(persistStorageWriteError(error));
    }
    const plan = planWorkspaceRepair(legacy, schemas);
    const repairedRetainedIds = new Set(plan.workspace.tabs.map(getTabTreeKey));
    const failedAdmissions = tabStorage.replayFailedAdmissions(repairedRetainedIds);
    const snapshotExclusions = new Set([
        ...failedAdmissions.markedIds,
        ...persistedPendingRemovals,
    ]);
    const takeOwnershipSnapshot = (): string[] | null => {
        const snapshot = tabStorage.snapshotStoredTreeKeys(
            MAX_PROTECTED_TREE_KEYS,
            MAX_PROTECTED_TREE_KEY_LENGTH,
            snapshotExclusions,
        );
        const enumerableStorage = storage as SyncStringStorage &
            Partial<Pick<Storage, "length" | "key">>;
        if (snapshot === null || typeof enumerableStorage.key !== "function") return snapshot;
        if (persistedPendingRemovals.some((id) => id.length > MAX_PROTECTED_TREE_KEY_LENGTH))
            return null;
        // Excluded pending values still consume the snapshot budget without being read or protected.
        const pendingIds = new Set(persistedPendingRemovals);
        let presentPendingCount = 0;
        try {
            for (let index = 0; index < (enumerableStorage.length ?? 0); index++) {
                const id = enumerableStorage.key(index);
                // Stryker disable next-line ConditionalExpression: null is never a member of the pending-id set, so replacing the null check with true is equivalent
                const isPendingId = id !== null && pendingIds.has(id);
                if (isPendingId) presentPendingCount++;
            }
        } catch (error) {
            reportPersistError(persistStorageWriteError(error));
            return null;
        }
        return snapshot.length + presentPendingCount > MAX_PROTECTED_TREE_KEYS ? null : snapshot;
    };
    const missingWorkspaceTreeSnapshot =
        storedWorkspace === null && !validMigrationSource ? takeOwnershipSnapshot() : undefined;
    const treeOwnershipUncertain =
        uncertainOwnershipSchema.safeParse(current).success ||
        (storedWorkspace !== null && !hasAuthoritativeWorkspace && !validMigrationSource) ||
        (storedWorkspace === null &&
            !validMigrationSource &&
            (legacyStoragePresent ||
                missingWorkspaceTreeSnapshot === null ||
                missingWorkspaceTreeSnapshot!.length > 0));
    if (persistedPendingRemovals.length > 0) {
        plan.unrepairedWorkspace.treeOwnershipPendingRemovalIds = [...persistedPendingRemovals];
    }
    if (persistedPuzzleRemovals.length > 0)
        plan.unrepairedWorkspace.legacyPuzzleRemovalKeys = [...persistedPuzzleRemovals];
    const takingFreshOwnershipSnapshot =
        treeOwnershipUncertain && persistedProtectedTreeIds === undefined;
    if (treeOwnershipUncertain) {
        plan.workspace.treeOwnershipUncertain = true;
        plan.unrepairedWorkspace.treeOwnershipUncertain = true;
        const protectedTreeIds =
            persistedProtectedTreeIds ??
            (missingWorkspaceTreeSnapshot !== undefined
                ? missingWorkspaceTreeSnapshot
                : takeOwnershipSnapshot()) ??
            undefined;
        if (protectedTreeIds !== undefined) {
            const protectedWithoutFailedAdmissions = protectedTreeIds.filter(
                (id) => !failedAdmissions.markedIds.has(id),
            );
            plan.workspace.treeOwnershipProtectedIds = [...protectedWithoutFailedAdmissions];
            plan.unrepairedWorkspace.treeOwnershipProtectedIds = [
                ...protectedWithoutFailedAdmissions,
            ];
        }
    }
    // One ownership record drives refusal cleanup, durable verification and source retirement.
    const stagedClones = new Map<string, boolean>();
    const refuseRepair = (...errors: unknown[]): Workspace => {
        if (errors.length > 0) reportPersistError(persistStorageWriteError(errors[0]));
        tabStorage.removeKnownTreesSafely(stagedClones.keys());
        return plan.unrepairedWorkspace;
    };
    for (const { sourceId, logicalId, puzzle, targetId, requireExisting } of plan.cloneTargets) {
        const result = tabStorage.clone(sourceId, targetId, requireExisting);
        if (result.kind === "unavailable" || result.kind === "copy-failed") {
            return refuseRepair(result.error);
        }
        if (result.kind === "unreadable") {
            if (puzzle)
                return refuseRepair(
                    new Error("Cannot migrate puzzle ownership from an unreadable tree"),
                );
            try {
                tabStorage.copyUnreadableForWorkspaceRepair(targetId, result.rawValue);
            } catch (error) {
                return refuseRepair(error);
            }
            stagedClones.set(targetId, false);
            continue;
        }
        if (result.kind === "copied") {
            stagedClones.set(targetId, true);
            if (puzzle) {
                try {
                    const copied = tabStorage.readTree(targetId);
                    if (copied.kind !== "available")
                        throw new Error("Puzzle migration target is unavailable");
                    const tree = copied.value.state as TreeState;
                    tabStorage.seed(targetId, {
                        ...tree,
                        puzzleSession: restorePuzzleSession(logicalId, tree),
                    });
                } catch (error) {
                    return refuseRepair(error);
                }
            }
        }
        if (result.kind === "absent" && puzzle) {
            try {
                const tree = defaultTree();
                tabStorage.seed(targetId, {
                    ...tree,
                    puzzleSession: restorePuzzleSession(logicalId, tree),
                });
                stagedClones.set(targetId, true);
            } catch (error) {
                return refuseRepair(error);
            }
        }
    }
    if (stagedClones.size > 0) {
        const failedIds = new Set(tabStorage.flush({ notify: true }));
        if ([...stagedClones.keys()].some((id) => failedIds.has(id))) {
            return refuseRepair();
        }
    }

    for (const [targetId, readable] of stagedClones) {
        if (!readable) continue;
        const result = tabStorage.readTree(targetId);
        if (result.kind === "available") continue;
        return refuseRepair(
            result.kind === "unavailable"
                ? result.error
                : new Error(`Could not verify the migrated tree at ${targetId}.`),
        );
    }
    const durableMigratedSources = new Set(
        plan.cloneTargets
            .filter(({ sourceId }) =>
                plan.cloneTargets.every(
                    (target) => target.sourceId !== sourceId || stagedClones.has(target.targetId),
                ),
            )
            .map(({ sourceId }) => sourceId),
    );
    const pendingRemovalResult = reconcilePendingTreeRemovals(
        persistedPendingRemovals,
        durableMigratedSources,
        repairedRetainedIds,
    );
    const pendingRemovalIds = pendingRemovalResult.ids;
    if (pendingRemovalIds.length > 0) {
        plan.workspace.treeOwnershipPendingRemovalIds = pendingRemovalIds;
    }
    if (plan.workspace.treeOwnershipProtectedIds) {
        plan.workspace.treeOwnershipProtectedIds = plan.workspace.treeOwnershipProtectedIds.filter(
            (id) => !durableMigratedSources.has(id),
        );
    }

    const puzzleRemovalResult = reconcileLegacyPuzzleRemovals(
        persistedPuzzleRemovals,
        plan.cloneTargets.filter(({ puzzle }) => puzzle).map(({ logicalId }) => logicalId),
        plan.workspace.tabs,
    );
    const puzzleRemovalKeys = puzzleRemovalResult.keys;
    if (puzzleRemovalKeys.length > 0) plan.workspace.legacyPuzzleRemovalKeys = puzzleRemovalKeys;

    const payload = serializeStorageValue(plan.workspace);
    if (storedWorkspace !== payload || legacyStoragePresent) {
        try {
            storage.setItem(key, payload);
        } catch (error) {
            return refuseRepair(error);
        }
    }

    reportPendingRemovalOverflow(
        pendingRemovalResult.droppedIds.length,
        puzzleRemovalResult.droppedKeys.length,
    );

    // Kept migrated sources are in the published pending-removal list. This also reclaims
    // unreadable bytes, which ordinary orphan sweeps cannot decode.
    const failedKnownRemovals = tabStorage.removeKnownTreesSafely(
        pendingRemovalIds.filter((id) => !pendingRemovalResult.unreadableIds.has(id)),
    );
    if (hasAuthoritativeWorkspace || validMigrationSource) sweepLegacyPuzzleKeys(plan.workspace);
    else
        for (const historyKey of plan.workspace.legacyPuzzleRemovalKeys ?? [])
            removeLegacyPuzzleKey(historyKey);
    for (const id of failedAdmissions.failedIds) failedKnownRemovals.add(id);
    for (const id of pendingRemovalResult.unreadableIds) failedKnownRemovals.add(id);

    if (!treeOwnershipUncertain && (hasAuthoritativeWorkspace || validMigrationSource)) {
        sweepOrphanedTreeKeys(plan.workspace.tabs, [], failedKnownRemovals);
    } else if (treeOwnershipUncertain && !takingFreshOwnershipSnapshot) {
        // The first snapshot protects prior trees; later loads sweep only outside that set.
        // A non-fresh uncertain load has a persisted protected set by construction.
        sweepOrphanedTreeKeys(
            plan.workspace.tabs,
            plan.workspace.treeOwnershipProtectedIds!,
            failedKnownRemovals,
        );
    }
    for (const legacyKey of legacyPresenceReadable ? ["tabs", "activeTab"] : []) {
        try {
            storage.removeItem(legacyKey);
        } catch (error) {
            reportPersistError(persistStorageWriteError(error));
        }
    }
    return plan.workspace;
}
