import type { SetStateAction } from "react";
import { atom } from "jotai";
import { atomFamily, atomWithStorage, unwrap } from "jotai/utils";
import { chessRiddleTrainingSessions } from "./chessRiddleTraining";
import { z } from "zod";
import { normalizeGameSignature } from "./gameSignature";
import { recentFileSchema, type RecentFile, type RecentEntryInput } from "./recentFiles";
import {
    boundLastOpened,
    createLastOpenedStorage,
    databaseGameOpenedKey,
    type LastOpened,
} from "./lastOpened";
import type {
    BestMoves,
    EngineTerminalSnapshot,
    GameResult,
    DatabaseHandle,
    CollectionDescriptor,
    FileWorkspaceHandle,
    GoMode,
    OpeningBookHandle,
    PathRef,
} from "@/bindings";
import type { OpponentSettings } from "@/state/opponentSettings";
import type { LocalOptions } from "@/utils/db";
import { analysisSearch } from "@/components/panels/analysis/analysisSearch";
import { AnalysisLineMemory } from "@/components/panels/analysis/analysisLineMemory";
import type { SuccessDatabaseInfo } from "@/utils/db";
import { type Engine, type EngineSettings } from "@/utils/engines";
import {
    type LichessGamesOptions,
    lichessGamesOptionsSchema,
    type MasterGamesOptions,
    masterOptionsSchema,
} from "@/utils/lichess/explorer";
import { getWinChance, normalizeScore } from "@/utils/score";
import { getTabTreeKey, type Tab } from "./workspaceTypes";
import {
    fileWorkspaceHandleSchema,
    databaseHandleSchema,
    fileWorkspaceKey,
    capabilityKey,
    pathRefSchema,
} from "../utils/pathCapabilities";
import {
    getSessionPersistenceSnapshot,
    savePublicSessions,
    subscribeSessionPersistence,
    type Session,
    type SessionPersistenceSnapshot,
} from "../utils/session";
import {
    createDocumentStorageAtoms,
    createPreferenceStorage,
    createZodStorage,
    initializeBeforeUse,
} from "./utils";
import { FONT_SCALE_DEFAULT, fontScaleSchema } from "./fontScale";
import {
    coverageMinGamesSchema,
    openingBookMaxPlySchema,
    puzzleRatingRangeSchema,
    soundCollectionSchema,
    soundVolumeSchema,
} from "./preferenceSchemas";
import { PIECE_SCALE_DEFAULT, pieceScaleSchema } from "./pieceScale";
import {
    DEFAULT_BOARD_IMAGE,
    DEFAULT_PIECE_SET,
    boardImageSchema,
    pieceSetSchema,
    type BoardImage,
    type PieceSet,
} from "./artworkCatalog";
import { createExpandedDirectoriesAtom } from "./expandedDirectories";
import {
    WORKSPACE_STORAGE_KEY,
    loadWorkspace,
    reportPendingRemovalOverflow,
    reconcilePendingTreeRemovals,
    reconcileLegacyPuzzleRemovals,
    sweepLegacyPuzzleKeys,
    saveWorkspace,
    type Workspace,
} from "./workspace";
import { persistStorageWriteError, tabStorage } from "./store/tabStorage";
import { reportPersistError } from "./persistError";
import { initializeOriginalPathOwners } from "./pathOwners";
import {
    createEngineOwnerStorage,
    enginesSchema,
    stampLegacyAssessments,
    saveEngineOwnerValue,
    type EngineOwnerSaveReceipt,
    type EngineOwnerCompletionUpdate,
    type EngineOwnerKey,
    engineOwnerCompletionReceipt,
    refuseUntrustedEnginesUpdate,
} from "./engineOwnerStorage";
import { serializeStorageValue } from "./store/debouncedStorage";
import { defaultPlayerSettings, opponentSettingsSchema } from "@/state/opponentSettings";
import { createPracticeDeckAtom, type PracticeData } from "./practiceStorage";
import { removeFileFreshness } from "./fileFreshness";
import { projectAnalysisSettings, type AnalysisSettings } from "./analysisSettings";
import { cancellationError, tauri, withConversionTicket } from "@/platform/tauri";

export type { PracticeData } from "./practiceStorage";
export { enginesSchema } from "./engineOwnerStorage";

const documentPreferences = createDocumentStorageAtoms(initializeRendererState);
let rendererStateInitialized = false;

/** Establish the document's original owners and eager preferences before hydration or cleanup. */
export function initializeRendererState() {
    if (rendererStateInitialized) return;
    initializeOriginalPathOwners();
    // Legacy renderer-visible directories are scrubbed, never migrated into opaque authority.
    // Retired borrowed PostHog telemetry is scrubbed the same way: never migrated.
    if (typeof localStorage !== "undefined") {
        localStorage.removeItem("document-dir");
        localStorage.removeItem("telemetry-enabled");
        localStorage.removeItem("ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_posthog");
        localStorage.removeItem("__ph_opt_in_out_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z");
    }
    if (typeof sessionStorage !== "undefined") {
        sessionStorage.removeItem("ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_posthog");
        sessionStorage.removeItem("ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_window_id");
    }
    if (typeof document !== "undefined") {
        const expired =
            "ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_posthog=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
        document.cookie = expired;
        document.cookie = `${expired}; Domain=.tauri.localhost`;
        document.cookie = `${expired}; Domain=.localhost`;
        document.cookie = `${expired}; Domain=tauri.localhost`;
    }
    documentPreferences.initialize();
    rendererStateInitialized = true;
}

// Tabs

let initialWorkspace: Workspace | undefined;

/** One successful document snapshot, shared by new stores without replacing their later edits. */
export function initializeWorkspace(): Workspace {
    initializeRendererState();
    initialWorkspace ??= loadWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY);
    return initialWorkspace;
}

const committedWorkspaceAtom = atom<Workspace | null>(null);
const workspaceAtom = atom((get) => get(committedWorkspaceAtom) ?? initializeWorkspace());
const commitWorkspaceAtom = atom(
    null,
    (get, set, workspace: Workspace, onSaved?: (saved: Workspace) => void) => {
        const previous = get(workspaceAtom);
        const retainedIds = new Set(workspace.tabs.map(getTabTreeKey));
        const closedIds = new Set(
            previous.tabs.map(getTabTreeKey).filter((id) => !retainedIds.has(id)),
        );
        const protectedIds = workspace.treeOwnershipProtectedIds?.filter(
            (id) => !closedIds.has(id),
        );
        const pendingRemovalResult = reconcilePendingTreeRemovals(
            workspace.treeOwnershipPendingRemovalIds ?? [],
            closedIds,
            retainedIds,
        );
        const pendingRemovalIds = pendingRemovalResult.ids;
        const puzzleRemovals = reconcileLegacyPuzzleRemovals(
            previous.legacyPuzzleRemovalKeys ?? [],
            previous.tabs
                .filter((tab) => !workspace.tabs.some((next) => next.value === tab.value))
                .map((tab) => tab.value),
            workspace.tabs,
        );
        const canonical = {
            ...workspace,
            ...(protectedIds === undefined ? {} : { treeOwnershipProtectedIds: protectedIds }),
            treeOwnershipPendingRemovalIds:
                pendingRemovalIds.length === 0 ? undefined : pendingRemovalIds,
            legacyPuzzleRemovalKeys:
                puzzleRemovals.keys.length === 0 ? undefined : puzzleRemovals.keys,
        };
        const saved = saveWorkspace(sessionStorage, WORKSPACE_STORAGE_KEY, canonical);
        if (!saved) return false;
        reportPendingRemovalOverflow(
            pendingRemovalResult.droppedIds.length,
            puzzleRemovals.droppedKeys.length,
        );
        set(committedWorkspaceAtom, saved);
        sweepLegacyPuzzleKeys(saved);
        onSaved?.(saved);
        return true;
    },
);

export const tabsAtom = atom(
    (get) => get(workspaceAtom).tabs,
    (
        get,
        set,
        update: Tab[] | ((tabs: Tab[]) => Tab[]),
        requestedActiveTab?: string,
        onSaved?: (saved: Workspace) => void,
    ) => {
        const workspace = get(workspaceAtom);
        const tabs = typeof update === "function" ? update(workspace.tabs) : update;
        const desiredActiveTab = requestedActiveTab ?? workspace.activeTab;
        const activeTab = tabs.some((tab) => tab.value === desiredActiveTab)
            ? desiredActiveTab
            : (tabs[0]?.value ?? null);
        return set(commitWorkspaceAtom, { ...workspace, tabs, activeTab }, onSaved);
    },
);

export const activeTabAtom = atom(
    (get) => get(workspaceAtom).activeTab,
    (get, set, update: string | null | ((activeTab: string | null) => string | null)) => {
        const workspace = get(workspaceAtom);
        const activeTab = typeof update === "function" ? update(workspace.activeTab) : update;
        return set(commitWorkspaceAtom, {
            ...workspace,
            activeTab: workspace.tabs.some((tab) => tab.value === activeTab) ? activeTab : null,
        });
    },
);

/** Transient close intent shared with async listeners; never persisted. */
export const closingTabsAtom = atom<Set<string>>(new Set<string>());

/** Reclaims per-tab state after workspace metadata stops owning it. */
export function reclaimTabLocalState(tabId: string, treeKey = tabId) {
    removeFileFreshness(tabId);
    let cleanupError: unknown;
    try {
        tabStorage.remove(treeKey);
    } catch (error) {
        cleanupError = error;
    }
    try {
        disposeTabAtoms(tabId);
    } catch (error) {
        cleanupError ??= error;
    }
    if (cleanupError !== undefined) {
        reportPersistError(persistStorageWriteError(cleanupError));
    }
}

/** Commits tab metadata, then attempts every tab-local cleanup category. */
export const closeWorkspaceTabAtom = atom(null, (get, set, tabId: string) => {
    const workspace = get(workspaceAtom);
    const index = workspace.tabs.findIndex((tab) => tab.value === tabId);
    if (index === -1) return false;
    const tabs = workspace.tabs.filter((tab) => tab.value !== tabId);
    const activeTab =
        workspace.activeTab !== tabId
            ? workspace.activeTab
            : (tabs[index]?.value ?? tabs[index - 1]?.value ?? null);
    if (!set(commitWorkspaceAtom, { ...workspace, tabs, activeTab })) return false;
    reclaimTabLocalState(tabId, getTabTreeKey(workspace.tabs[index]));
    return true;
});

export function updateTabById(
    setTabs: (
        update: Tab[] | ((tabs: Tab[]) => Tab[]),
        activeTab?: string,
        onSaved?: (saved: Workspace) => void,
    ) => boolean,
    tabId: string,
    update: SetStateAction<Tab>,
    onAdmitted?: (successor: Tab) => void,
) {
    let found = false;
    const committed = setTabs(
        (tabs) =>
            tabs.map((tab) => {
                if (tab.value !== tabId) return tab;
                found = true;
                return typeof update === "function" ? update(tab) : update;
            }),
        undefined,
        onAdmitted
            ? (saved) => {
                  const successor = saved.tabs.find((tab) => tab.value === tabId);
                  if (found && successor) onAdmitted(successor);
              }
            : undefined,
    );
    return committed && found;
}

export const currentTabAtom = atom(
    (get) => get(tabsAtom).find((tab) => tab.value === get(activeTabAtom)),
    (get, set, newValue: Tab | ((currentTab: Tab) => Tab)) => {
        const activeTab = get(activeTabAtom);
        return (
            activeTab !== null &&
            updateTabById((update) => set(tabsAtom, update), activeTab, newValue)
        );
    },
);

// Directories
// Legacy builds stored a renderer-visible document directory. It is deliberately
// scrubbed instead of migrated: only the native-issued opaque workspace survives.
// A native-issued, DownloadFile-only path capability.  Unlike the legacy directory settings it
// is opaque and never serializes a physical filesystem location into renderer storage.
export const downloadDestinationAtom = documentPreferences.atomWithStorage<PathRef | null>(
    "download-destination-capability",
    null,
    createZodStorage(pathRefSchema.nullable(), localStorage),
);
export const fileWorkspaceAtom = documentPreferences.atomWithStorage<FileWorkspaceHandle | null>(
    "file-workspace",
    null,
    createZodStorage(fileWorkspaceHandleSchema.nullable(), localStorage),
);
export const expandedDirectoriesAtom = createExpandedDirectoriesAtom(
    fileWorkspaceAtom,
    sessionStorage,
);
/** Display metadata only; authority remains exclusively in fileWorkspaceAtom. */
export const fileWorkspaceDisplayNameAtom = atomWithStorage<string>(
    "file-workspace-display-name",
    "",
    createZodStorage(z.string().max(256), localStorage),
);

type EngineUpdate =
    | { removeLocalId: string }
    | Engine[]
    | Promise<Engine[]>
    | ((current: Engine[]) => Engine[] | Promise<Engine[]>);

function engineOwnerApplication<Value>(key: EngineOwnerKey, current: Value, update: unknown) {
    if (typeof update !== "object" || update === null || !("completionId" in update)) return;
    const completion = update as EngineOwnerCompletionUpdate<Value>;
    const previous = engineOwnerCompletionReceipt(key, completion.completionId);
    const { value, disposition } = previous
        ? { value: current, disposition: previous }
        : completion.apply(current);
    return { value, receipt: { id: completion.completionId, disposition } };
}

/** Serializes functional calculation, renderer persistence and native synchronization together. */
function createEngineOwnerAtom<Value, Update, Fallback extends Value | undefined>(
    key: EngineOwnerKey,
    schema: z.ZodType<Value, z.ZodTypeDef, unknown>,
    initialValue: Value,
    fallback: Fallback,
    applyUpdate: (current: Value, update: Update) => Value | Promise<Value>,
    options: {
        normalize?: (current: Value, next: Value) => Value;
        publishOnRefusal?: (update: Update | EngineOwnerCompletionUpdate<Value>) => boolean;
    } = {},
) {
    const ownerStorage = createEngineOwnerStorage(key, schema, initialValue);
    const storage: typeof ownerStorage = {
        ...ownerStorage,
        getItem(key, initialValue) {
            initializeRendererState();
            return ownerStorage.getItem(key, initialValue);
        },
    };
    // The outcome and its promise belong to the reading Jotai store. The public storage
    // fallback cannot distinguish confirmed absence from a failed engines read.
    const enginesRead =
        key === "engines"
            ? atom(() => {
                  initializeRendererState();
                  return ownerStorage.readOutcome(key, initialValue);
              })
            : undefined;
    const stored = enginesRead
        ? unwrap(
              atom(async (get) => {
                  const outcome = await get(enginesRead);
                  return "value" in outcome ? outcome.value : fallback;
              }),
              () => fallback,
          )
        : unwrap(atomWithStorage(key, initialValue, storage), () => fallback);
    // Once a write publishes, it takes precedence over asynchronous storage hydration.
    const published = atom<Value | undefined>(undefined);
    let updates = Promise.resolve();
    return atom(
        (get) => get(published) ?? get(stored),
        (
            get,
            set,
            update: Update | EngineOwnerCompletionUpdate<Value>,
        ): Promise<EngineOwnerSaveReceipt> => {
            const run = updates.then(async () => {
                let current = get(published);
                if (current === undefined && enginesRead) {
                    const outcome = await get(enginesRead);
                    current = get(published);
                    if (current === undefined) {
                        if ("value" in outcome) {
                            current = outcome.value;
                        } else {
                            const derived =
                                typeof update === "function" ||
                                isEngineRemoval(update) ||
                                (typeof update === "object" &&
                                    update !== null &&
                                    "completionId" in update);
                            if (derived) return refuseUntrustedEnginesUpdate(outcome.error);
                            // A complete replacement has no trusted previous assessment base.
                            current = initialValue;
                        }
                    }
                }
                current ??= await storage.getItem(key, initialValue);
                const application = engineOwnerApplication(key, current, update);
                let next: Value;
                if (application) {
                    next = application.value;
                } else {
                    next = await applyUpdate(current, update as Update);
                }
                if (options.normalize) next = options.normalize(current, next);
                if (options.publishOnRefusal?.(update)) set(published, next);
                const receipt = await saveEngineOwnerValue(
                    key,
                    serializeStorageValue(next),
                    application?.receipt,
                );
                if (receipt.saved) set(published, next);
                return receipt;
            });
            updates = run.then(
                () => undefined,
                () => undefined,
            );
            return run;
        },
    );
}

function isEngineRemoval(update: unknown): update is { removeLocalId: string } {
    return typeof update === "object" && update !== null && "removeLocalId" in update;
}

export const enginesAtom = createEngineOwnerAtom(
    "engines",
    enginesSchema,
    [],
    undefined,
    (current, update: EngineUpdate) =>
        isEngineRemoval(update)
            ? current.filter(
                  (engine) => engine.type !== "local" || engine.id !== update.removeLocalId,
              )
            : typeof update === "function"
              ? update(current)
              : update,
    {
        normalize: stampLegacyAssessments,
        // Permanent retirement keeps its session-only omission even on refusal.
        publishOnRefusal: isEngineRemoval,
    },
);

// Settings

export const tableViewAtom = atomWithStorage<boolean>(
    "table-view",
    false,
    createPreferenceStorage(false),
);

export const fontSizeAtom = atomWithStorage(
    "font-size",
    FONT_SCALE_DEFAULT,
    createZodStorage(fontScaleSchema, localStorage),
);

export const pieceSizeAtom = atomWithStorage(
    "piece-size",
    PIECE_SCALE_DEFAULT,
    createZodStorage(pieceScaleSchema, localStorage),
);

export const moveNotationTypeAtom = atomWithStorage<"letters" | "symbols">(
    "letters",
    "symbols",
    createZodStorage(z.enum(["letters", "symbols"]), localStorage),
);
export const moveMethodAtom = atomWithStorage<"drag" | "select" | "both">(
    "move-method",
    "both",
    createZodStorage(z.enum(["drag", "select", "both"]), localStorage),
);
export const spellCheckAtom = atomWithStorage<boolean>(
    "spell-check",
    false,
    createPreferenceStorage(false),
);
export const moveInputAtom = atomWithStorage<boolean>(
    "move-input",
    false,
    createPreferenceStorage(false),
);
export const showDestsAtom = atomWithStorage<boolean>(
    "show-dests",
    true,
    createPreferenceStorage(true),
);
export const moveHighlightAtom = atomWithStorage<boolean>(
    "move-highlight",
    true,
    createPreferenceStorage(true),
);
export const snapArrowsAtom = atomWithStorage<boolean>(
    "snap-dests",
    true,
    createPreferenceStorage(true),
);
export const showArrowsAtom = atomWithStorage<boolean>(
    "show-arrows",
    true,
    createPreferenceStorage(true),
);
export const showConsecutiveArrowsAtom = atomWithStorage<boolean>(
    "show-consecutive-arrows",
    false,
    createPreferenceStorage(false),
);
export const showVariationArrowsAtom = atomWithStorage<boolean>(
    "show-variation-arrows",
    false,
    createPreferenceStorage(false),
);
export const eraseDrawablesOnClickAtom = atomWithStorage<boolean>(
    "erase-drawables-on-click",
    true,
    createPreferenceStorage(true),
);
export const autoPromoteAtom = atomWithStorage<boolean>(
    "auto-promote",
    true,
    createPreferenceStorage(true),
);
export const autoSaveAtom = atomWithStorage<boolean>(
    "auto-save",
    true,
    createPreferenceStorage(true),
);
export const previewBoardOnHoverAtom = atomWithStorage<boolean>(
    "preview-board-on-hover",
    true,
    createPreferenceStorage(true),
);
export const flipBoardAfterMoveAtom = atomWithStorage<boolean>(
    "flip-board-after-move",
    true,
    createPreferenceStorage(true),
);
export const enableBoardScrollAtom = atomWithStorage<boolean>(
    "board-scroll",
    true,
    createPreferenceStorage(true),
);
/** Next move at a branch point opens a list of every continuation instead of following the main line. */
export const chooseVariationAtom = atomWithStorage<boolean>(
    "choose-variation",
    true,
    createPreferenceStorage(true),
);
export const materialDisplayAtom = atomWithStorage<"diff" | "all">(
    "material-display",
    "diff",
    createZodStorage(z.enum(["diff", "all"]), localStorage),
);
export const BOARD_ANIMATION_SPEEDS = ["off", "fast", "normal", "slow"] as const;
export type BoardAnimationSpeed = (typeof BOARD_ANIMATION_SPEEDS)[number];
/** Piece movement animation length in milliseconds; "off" disables animation. */
export const BOARD_ANIMATION_DURATION_MS: Record<Exclude<BoardAnimationSpeed, "off">, number> = {
    fast: 100,
    normal: 200,
    slow: 400,
};
export const boardAnimationSpeedAtom = atomWithStorage<BoardAnimationSpeed>(
    "board-animation-speed",
    "normal",
    createZodStorage(z.enum(BOARD_ANIMATION_SPEEDS), localStorage),
);
export const showCoordinatesAtom = documentPreferences.atomWithStorage<"no" | "edge" | "all">(
    "show-coordinates-v2",
    "no",
    createZodStorage(z.enum(["no", "edge", "all"]), localStorage),
);
export const soundCollectionAtom = documentPreferences.atomWithStorage<string>(
    "sound-collection",
    "standard",
    createZodStorage<string>(soundCollectionSchema, localStorage),
);

export const soundVolumeAtom = documentPreferences.atomWithStorage<number>(
    "sound-volume",
    0.8,
    createZodStorage(soundVolumeSchema, localStorage),
);

export const pieceSetAtom = atomWithStorage<PieceSet>(
    "piece-set",
    DEFAULT_PIECE_SET,
    createZodStorage(pieceSetSchema, localStorage),
);
export const boardImageAtom = atomWithStorage<BoardImage>(
    "board-image",
    DEFAULT_BOARD_IMAGE,
    createZodStorage(boardImageSchema, localStorage),
);
export const boardWoodTextureAtom = atomWithStorage<boolean>(
    "board-wood-texture",
    true,
    createPreferenceStorage(true),
);
// Mount and remount synchronize with the document owner, never with an absent or stale key.
const sessionStateAtom = atom<SessionPersistenceSnapshot | null>(null);
sessionStateAtom.onMount = (setSnapshot) => {
    const synchronize = () => setSnapshot(getSessionPersistenceSnapshot());
    const unsubscribe = subscribeSessionPersistence(synchronize);
    synchronize();
    return unsubscribe;
};
export const sessionsAtom = atom(
    (get) => (get(sessionStateAtom) ?? getSessionPersistenceSnapshot()).sessions,
    (_get, set, update: SetStateAction<Session[]>) => {
        const current = getSessionPersistenceSnapshot().sessions;
        const snapshot = savePublicSessions(
            typeof update === "function" ? update(current) : update,
        );
        set(sessionStateAtom, snapshot);
    },
);
export const nativeBarAtom = atomWithStorage<boolean>(
    "native-bar",
    false,
    createPreferenceStorage(false),
);

// Recent Files

const MAX_RECENT_FILES = 10;

export {
    recentFileSchema,
    isDatabaseRecent,
    type RecentFile,
    type RecentDatabaseGame,
    type RecentEntryInput,
} from "./recentFiles";

export function recentFileKey(file: RecentFile | RecentEntryInput): string {
    if (!("kind" in file)) return fileWorkspaceKey(file.handle);
    return JSON.stringify([
        "database",
        capabilityKey(file.database),
        file.linked
            ? [file.linked.locator.collection, normalizeGameSignature(file.linked.signature)]
            : file.gameId,
    ]);
}

export function dedupeRecentFiles(files: RecentFile[]): RecentFile[] {
    const seen = new Set<string>();
    return [...files]
        .sort((a, b) => b.lastOpened - a.lastOpened)
        .filter((file) => {
            const key = recentFileKey(file);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, MAX_RECENT_FILES);
}

/** Refresh native identities without changing the last-opened timestamp. */
export const updateRecentFilesAtom = atom(null, (get, set, files: SetStateAction<RecentFile[]>) => {
    set(
        recentFilesAtom,
        dedupeRecentFiles(typeof files === "function" ? files(get(recentFilesAtom)) : files),
    );
});

export const recentFilesAtom = initializeBeforeUse(
    atomWithStorage<RecentFile[]>(
        "recent-files",
        [],
        createZodStorage(z.array(recentFileSchema), localStorage),
    ),
    initializeRendererState,
);

export const lastOpenedAtom = documentPreferences.atomWithStorage<LastOpened>(
    "last-opened",
    {},
    createLastOpenedStorage(localStorage),
);

export const recordLastOpenedAtom = atom(null, (get, set, keys: string[]) => {
    const now = Date.now();
    set(
        lastOpenedAtom,
        boundLastOpened({
            ...Object.fromEntries(keys.map((key) => [key, now])),
            ...Object.fromEntries(
                Object.entries(get(lastOpenedAtom)).filter(([key]) => !keys.includes(key)),
            ),
        }),
    );
});

export const addRecentFileAtom = atom(null, (get, set, file: RecentEntryInput) => {
    const current = get(recentFilesAtom);
    set(recentFilesAtom, dedupeRecentFiles([{ ...file, lastOpened: Date.now() }, ...current]));
    set(
        recordLastOpenedAtom,
        "kind" in file
            ? [capabilityKey(file.database), databaseGameOpenedKey(file.database, file.gameId)]
            : [fileWorkspaceKey(file.handle)],
    );
});

// Database

const storedReferenceDbAtom = initializeBeforeUse(
    atomWithStorage<DatabaseHandle | null>(
        "reference-database",
        null,
        createZodStorage(databaseHandleSchema.nullable(), localStorage),
    ),
    initializeRendererState,
);

const referenceCollectionOwnerAtom = documentPreferences.atomWithStorage(
    "reference-collection-owner",
    null as {
        database: DatabaseHandle;
        workspace: FileWorkspaceHandle;
        collection: string;
    } | null,
    createZodStorage(
        z
            .object({
                database: databaseHandleSchema,
                workspace: fileWorkspaceHandleSchema,
                collection: z.string().uuid(),
            })
            .nullable(),
        localStorage,
    ),
);

export const referenceDbAtom = atom(
    (get) => get(storedReferenceDbAtom),
    (get, set, update: SetStateAction<DatabaseHandle | null>) => {
        const previous = get(storedReferenceDbAtom);
        const next = typeof update === "function" ? update(previous) : update;
        if (previous?.id.id !== next?.id.id) set(referenceCollectionOwnerAtom, null);
        set(storedReferenceDbAtom, next);
    },
);

/** Retain one selected collection owner across reloads, so only its removal clears the preference. */
export const reconcileReferenceCollectionAtom = atom(
    null,
    (
        get,
        set,
        listing: {
            workspace: FileWorkspaceHandle | null;
            reference: DatabaseHandle | null;
            collections: readonly CollectionDescriptor[];
        },
    ) => {
        const reference = get(referenceDbAtom);
        const workspace = get(fileWorkspaceAtom);
        if (
            !reference ||
            !workspace ||
            reference.id.id !== listing.reference?.id.id ||
            fileWorkspaceKey(workspace) !==
                (listing.workspace ? fileWorkspaceKey(listing.workspace) : null)
        )
            return;
        const collection = listing.collections.find(
            (item) =>
                item.database?.id.id === reference.id.id ||
                item.retiredDatabase?.id.id === reference.id.id,
        );
        const owner = get(referenceCollectionOwnerAtom);
        if (collection) {
            if (
                owner?.collection !== collection.id ||
                owner.database.id.id !== reference.id.id ||
                fileWorkspaceKey(owner.workspace) !== fileWorkspaceKey(workspace)
            ) {
                set(referenceCollectionOwnerAtom, {
                    database: reference,
                    workspace,
                    collection: collection.id,
                });
            }
            return;
        }
        if (
            owner?.database.id.id === reference.id.id &&
            fileWorkspaceKey(owner.workspace) === fileWorkspaceKey(workspace) &&
            !listing.collections.some((item) => item.id === owner.collection)
        )
            set(referenceDbAtom, null);
    },
);

export const selectedPuzzleDbAtom = initializeBeforeUse(
    atomWithStorage<PathRef | null>(
        "puzzle-db",
        null,
        createZodStorage(pathRefSchema.nullable(), localStorage),
    ),
    initializeRendererState,
);
/** In-memory invalidation signal shared by Settings, the local picker, and Puzzle tabs. */
export const puzzleWorkspaceGenerationAtom = atom(0);

export type DatabaseConversionEntry = {
    id: string;
    totalGames: number;
    elapsedSeconds: number;
    targetDatabase: DatabaseHandle | null;
    targetDatabaseTitle: string | null;
    sourceFileName: string | null;
    cancel?: () => Promise<void>;
    cancelPending?: boolean;
};

export type DatabaseConversionOperation = {
    id: string;
    ticket: string | null;
    throwIfCancelled: () => void;
    setTarget: (handle: DatabaseHandle) => void;
};

/** In-memory only: one entry per in-flight conversion, removed by its owning route; never persisted or restored. */
export const databaseConversionStateAtom = atom<DatabaseConversionEntry[]>([]);
/** A failed post-import reload keeps the library's existing retry action available across navigation. */
export const databaseConversionRefreshFailedAtom = atom(false);

/** In-memory only: account keys mapped to their pending download ticket; owned by AccountCard's download action. */
export const accountDownloadsInFlightAtom = atom<ReadonlyMap<string, string | null>>(new Map());

/** Native account workflows survive the document's in-memory download tickets. */
export const accountCompletionsAtom = atom<
    ReadonlyMap<string, import("@/bindings").AccountCompletion>
>(new Map());

/** Retains one entry per active owner, in start order, until that owner's work settles. */
export async function runDatabaseConversion<T>(
    setState: (update: (previous: DatabaseConversionEntry[]) => DatabaseConversionEntry[]) => void,
    target: Pick<
        DatabaseConversionEntry,
        "targetDatabase" | "targetDatabaseTitle" | "sourceFileName"
    >,
    run: (operation: DatabaseConversionOperation) => Promise<T>,
    local?: { onCancelError: (cause: unknown) => void },
): Promise<T> {
    const id = `conversion:${crypto.randomUUID()}`;
    let live = true;
    let ticket: string | null = null;
    let cancelRequested = false;
    let pending: Promise<void> | undefined;
    const updatePending = (cancelPending: boolean) =>
        setState((previous) =>
            previous.map((entry) => (entry.id === id ? { ...entry, cancelPending } : entry)),
        );
    const cancel = (): Promise<void> => {
        if (!live) return Promise.resolve();
        if (pending) return pending;
        cancelRequested = true;
        if (!ticket) return Promise.resolve();
        updatePending(true);
        pending = (async () => {
            try {
                await tauri.cancelConversion(ticket);
            } catch (cause) {
                cancelRequested = false;
                local?.onCancelError(cause);
            } finally {
                pending = undefined;
                if (live) updatePending(false);
            }
        })();
        return pending;
    };
    setState((previous) => [
        ...previous,
        {
            ...target,
            id,
            totalGames: 0,
            elapsedSeconds: 0,
            ...(local ? { cancel, cancelPending: false } : {}),
        },
    ]);
    try {
        const execute = async (preparedTicket: string | null) => {
            ticket = preparedTicket;
            if (local && cancelRequested) throw cancellationError();
            return run({
                id,
                ticket,
                throwIfCancelled: () => {
                    if (local && cancelRequested) throw cancellationError();
                },
                setTarget: (handle) => {
                    setState((previous) =>
                        previous.some((entry) => entry.id === id)
                            ? previous.map((entry) =>
                                  entry.id === id ? { ...entry, targetDatabase: handle } : entry,
                              )
                            : previous,
                    );
                },
            });
        };
        return await (local ? withConversionTicket(execute) : execute(null));
    } finally {
        if (pending) await pending;
        live = false;
        setState((previous) =>
            previous.some((entry) => entry.id === id)
                ? previous.filter((entry) => entry.id !== id)
                : previous,
        );
    }
}

/** Database metadata is authoritative in native storage, not in renderer persistence. */
export const selectedDatabaseAtom = atom<SuccessDatabaseInfo | null>(null);

// Game Settings

export type GameInputColor = "white" | "random" | "black";

export const gameInputColorAtom = atomWithStorage<GameInputColor>(
    "game-input-color",
    "white",
    createZodStorage(z.enum(["white", "random", "black"]), localStorage),
);

function createPlayerSettingsAtom(key: "game-player1-settings" | "game-player2-settings") {
    return createEngineOwnerAtom(
        key,
        opponentSettingsSchema,
        defaultPlayerSettings,
        defaultPlayerSettings,
        (current, update: SetStateAction<OpponentSettings>) =>
            typeof update === "function" ? update(current) : update,
    );
}

export const gamePlayer1SettingsAtom = createPlayerSettingsAtom("game-player1-settings");
export const gamePlayer2SettingsAtom = createPlayerSettingsAtom("game-player2-settings");

export const gameSameTimeControlAtom = atomWithStorage<boolean>(
    "game-same-time-control",
    true,
    createPreferenceStorage(true),
);

export const gameOpeningBookHandleAtom = initializeBeforeUse(
    atomWithStorage<OpeningBookHandle | null>(
        "game-opening-book-handle",
        null,
        createZodStorage(
            z.object({ id: pathRefSchema, kind: z.literal("openingBook") }).nullable(),
            localStorage,
        ),
    ),
    initializeRendererState,
);

export const gameOpeningBookEnabledAtom = atomWithStorage<boolean>(
    "game-opening-book-enabled",
    false,
    createPreferenceStorage(false),
);

export const gameOpeningBookMaxPlyAtom = atomWithStorage<number>(
    "game-opening-book-max-ply",
    40,
    createZodStorage(openingBookMaxPlySchema, localStorage),
);

// Puzzles
export const hidePuzzleRatingAtom = atomWithStorage<boolean>(
    "hide-puzzle-rating",
    false,
    createPreferenceStorage(false),
);
export const progressivePuzzlesAtom = atomWithStorage<boolean>(
    "progressive-puzzles",
    false,
    createPreferenceStorage(false),
);
export const jumpToNextPuzzleAtom = atomWithStorage<boolean>(
    "puzzle-jump-immediately",
    true,
    createPreferenceStorage(true),
);
export const trackPuzzleTimeAtom = atomWithStorage<boolean>(
    "track-puzzle-time",
    true,
    createPreferenceStorage(true),
);
export const puzzleRatingRangeAtom = atomWithStorage<[number, number]>(
    "puzzle-ratings",
    [1000, 1500],
    createZodStorage(puzzleRatingRangeSchema, localStorage),
);

export const puzzleThemeAtom = atomWithStorage<string | null>(
    "puzzle-theme",
    null,
    createZodStorage(z.string().nullable(), localStorage),
);

export const coverageMinGamesAtom = atomWithStorage<number>(
    "coverage-min-games",
    50,
    createZodStorage(coverageMinGamesSchema, localStorage),
);

export type PuzzleTimer = { attemptId: string } & (
    | { startedAt: number; elapsed?: never }
    | { elapsed: number; startedAt?: never }
);

export const puzzleTimerFamily = atomFamily((_tab: string) => atom<PuzzleTimer | null>(null));

// CP / WDL

export const reportTypeAtom = atom<"CP" | "WDL">("CP");

export const scoreTypeFamily = atomFamily((_engine: string) => atom<"cp" | "wdl">("cp"));

// Per tab settings

export const threatFamily = atomFamily((_tab: string) => atom(false));

export const evalOpenFamily = atomFamily((_tab: string) => atom(true));

export const evalBarDisplayFamily = atomFamily((_tab: string) => atom<"cp" | "wdl">("cp"));

export const invisibleFamily = atomFamily((_tab: string) => atom(false));

export const showCommentsFamily = atomFamily((_tab: string) => atom(true));

export const showVariationsFamily = atomFamily((_tab: string) => atom(true));

export const tabFamily = atomFamily((_tab: string) => atom("info"));

export const reportModalOpenFamily = atomFamily((_tab: string) => atom(false));

export const localOptionsFamily = atomFamily((_tab: string) =>
    atom<LocalOptions>({
        path: null,
        type: "exact",
        fen: "",
        player: null,
        color: "white",
        result: "any",
    }),
);

export const pinnedExplorerDatabaseFamily = atomFamily((_tab: string) =>
    atom<DatabaseHandle | null>(null),
);

export const lichessOptionsAtom = documentPreferences.atomWithStorage<LichessGamesOptions>(
    "lichess-all-options",
    {
        ratings: [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500],
        speeds: ["bullet", "blitz", "rapid", "classical", "correspondence"],
        color: "white",
    },
    createZodStorage(lichessGamesOptionsSchema, localStorage),
);

export const masterOptionsAtom = documentPreferences.atomWithStorage<MasterGamesOptions>(
    "lichess-master-options",
    {},
    createZodStorage(masterOptionsSchema, localStorage),
);

export const dbTypeFamily = atomFamily((_tab: string) =>
    atom<"local" | "lch_all" | "lch_master">("local"),
);

export const dbTabFamily = atomFamily((_tab: string) => atom("stats"));

export const analysisTabFamily = atomFamily((_tab: string) => atom("engines"));

export const practiceTabFamily = atomFamily((_tab: string) => atom("train"));

export const expandedEnginesFamily = atomFamily((_tab: string) =>
    atom<string[] | undefined>(undefined),
);

export const currentDetachedEngineAtom = atomWithStorage<string | null>(
    "detached-engine",
    null,
    createZodStorage(z.string().nullable(), localStorage),
);

/** How many lines the pinned engine bar shows at most; null shows every line the engine computes. */
export const detachedEngineLinesAtom = atomWithStorage<number | null>(
    "detached-engine-lines",
    null,
    createZodStorage(z.number().int().min(1).max(5).nullable(), localStorage),
);

/** Where the pinned engine bar sits: above the panel tabs, or above the move notation. */
export type DetachedEnginePlacement = "tabs" | "notation";

export const detachedEnginePlacementAtom = atomWithStorage<DetachedEnginePlacement>(
    "detached-engine-placement",
    "tabs",
    createZodStorage(z.enum(["tabs", "notation"]), localStorage),
);

export const pgnOptionsFamily = atomFamily((_tab: string) =>
    atom({
        comments: true,
        glyphs: true,
        variations: true,
        extraMarkups: true,
    }),
);

// Game

type GameState = "settingUp" | "playing" | "gameOver";
export const gameStateFamily = atomFamily((_tab: string) => atom<GameState>("settingUp"));

export const playersFamily = atomFamily((_tab: string) =>
    atom<{
        white: OpponentSettings;
        black: OpponentSettings;
    }>({ white: {} as OpponentSettings, black: {} as OpponentSettings }),
);

export const gameIdFamily = atomFamily((_tab: string) => atom<string | null>(null));
export const gameSessionFamily = atomFamily((_tab: string) => atom<bigint | null>(null));
export const pendingGameStartFamily = atomFamily((_tab: string) =>
    atom<Promise<void> | null>(null),
);

// Practice

export const deckAtomFamily = atomFamily(
    ({ file, game }: { file: string; game: number }) =>
        initializeBeforeUse(createPracticeDeckAtom({ file, game }), initializeRendererState),

    (a, b) => a.file === b.file && a.game === b.game,
);

/** A delete changes ordinal resolution for the whole file, including decks without open tabs. */
export function invalidateFileDeckAtoms(file: string): void {
    for (const identity of Array.from(deckAtomFamily.getParams())) {
        if (identity.file === file) deckAtomFamily.remove(identity);
    }
}

export type PracticePhase =
    | "idle" // Not practicing
    | "replaying" // Playing the line into the card position
    | "learning" // Showing an unseen move before its first quiz
    | "waiting" // Waiting for user to make a move
    | "retry" // First attempt was wrong, waiting for another attempt
    | "revealed" // Showing the answer, waiting for it to be played
    | "correct" // Correct presentation waiting for a grade, Continue or the short delay
    | "advancing"; // Presentation finished, including an unrated learn step

export type PracticeState = {
    phase: PracticePhase;
    currentFen?: string;
    answer?: string;
    playedMove?: string;
    timeTaken?: number;
    positionKey?: string;
};

export const practiceStateFamily = atomFamily((_tab: string) =>
    atom<PracticeState>({ phase: "idle" }),
);

/** Runtime-only bridge between the practice controller and the board. */
export type PracticeMoveController = {
    canMove: boolean;
    hintSan?: string;
    submitMove: (san: string) => void;
};

export const practiceMoveControllerFamily = atomFamily((_tab: string) =>
    atom<PracticeMoveController | null>(null),
);

export type PracticeSessionStats = {
    mode: "anki" | "full";
    remainingPositionKeys: string[];
    reappendedPositionKeys: string[];
    introducedPositionKeys: string[];
    correct: number;
    incorrect: number;
    streak: number;
    bestStreak: number;
};

export const practiceSessionStatsFamily = atomFamily((_tab: string) =>
    atom<PracticeSessionStats>({
        mode: "anki",
        remainingPositionKeys: [],
        reappendedPositionKeys: [],
        introducedPositionKeys: [],
        correct: 0,
        incorrect: 0,
        streak: 0,
        bestStreak: 0,
    }),
);

/** Completed runs remain visible without keeping an inactive session alive. */
export const practiceCompletedSummaryFamily = atomFamily((_tab: string) =>
    atom<PracticeSessionStats | null>(null),
);

export const practiceGradingAtom = atomWithStorage<"auto" | "manual">(
    "practice-grading",
    "auto",
    createZodStorage(z.enum(["auto", "manual"]), localStorage),
);

export const PRACTICE_NEW_PER_SESSION = { min: 0, max: 100, default: 10 } as const;

export const practiceNewPerSessionAtom = atomWithStorage<number>(
    "practice-new-per-session",
    PRACTICE_NEW_PER_SESSION.default,
    createZodStorage(
        z.number().int().min(PRACTICE_NEW_PER_SESSION.min).max(PRACTICE_NEW_PER_SESSION.max),
        localStorage,
    ),
);

export const practiceCardStartTimeFamily = atomFamily((_tab: string) => atom<number>(0));

export const engineMovesFamily = atomFamily(
    ({ tab: _tab, engine: _engine }: { tab: string; engine: string }) =>
        atom<Map<string, BestMoves[]>>(new AnalysisLineMemory()),
    (a, b) => a.tab === b.tab && a.engine === b.engine,
);

export const engineProgressFamily = atomFamily(
    ({ tab: _tab, engine: _engine }: { tab: string; engine: string }) => atom<number>(0),
    (a, b) => a.tab === b.tab && a.engine === b.engine,
);

export type AnalysisTerminal = {
    searchedKey: string;
    context: string;
    fingerprint: string;
    engineIdentity: string;
    generation: string | null;
    retry: number;
} & (
    | { type: "completed-without-lines" }
    | { type: "not-in-database" }
    | {
          type: "failed";
          snapshot?: EngineTerminalSnapshot;
          message?: string;
          cleanupFailed?: boolean;
      }
);

/** Retained only while the owner tab exists, including inactive-tab unmounts. */
export const gameInterruptionFamily = atomFamily((_tab: string) =>
    atom<
        | (Extract<GameResult, { type: "interrupted" }> & {
              engineColor: "white" | "black" | null;
          })
        | null
    >(null),
);

/** One ephemeral terminal outcome for the owned engine's current attempt. */
export const engineTerminalFamily = atomFamily(
    ({ tab: _tab, engine: _engine }: { tab: string; engine: string }) =>
        atom<AnalysisTerminal | null>(null),
    (a, b) => a.tab === b.tab && a.engine === b.engine,
);

export const engineRetryFamily = atomFamily(
    ({ tab: _tab, engine: _engine }: { tab: string; engine: string }) => atom(0),
    (a, b) => a.tab === b.tab && a.engine === b.engine,
);

const BEST_MOVE_ARROW_MAX_WIN_CHANCE_LOSS = 10; // win-chance percentage points

type BestMoveArrows = Map<number, { pv: string[]; winChance: number }[]>;

function equalBestMoveArrows(previous: BestMoveArrows, next: BestMoveArrows): boolean {
    if (previous.size !== next.size) return false;
    const entries = previous.entries();
    for (const [key, lines] of next) {
        const entry = entries.next().value;
        if (!entry || entry[0] !== key || entry[1].length !== lines.length) return false;
        for (let i = 0; i < lines.length; i++) {
            const before = entry[1][i];
            const after = lines[i];
            if (
                before.winChance !== after.winChance ||
                before.pv.length !== after.pv.length ||
                !before.pv.every((move, index) => move === after.pv[index])
            )
                return false;
        }
    }
    return true;
}

/** Returns each engine's best moves for the current position. Callers must memoize the result. */
export const createBestMovesAtom = (tab: string, fen: string, gameMoves: string[]) => {
    let previous: BestMoveArrows = new Map();
    const reuse = (next: BestMoveArrows) => {
        if (!equalBestMoveArrows(previous, next)) previous = next;
        return previous;
    };
    return atom<BestMoveArrows>((get) => {
        const engines = get(enginesAtom);
        if (!engines) return reuse(new Map());
        const bestMoves: BestMoveArrows = new Map();
        const search = analysisSearch(fen, gameMoves, get(threatFamily(tab)));
        if (!search.available) return reuse(bestMoves);
        const { searchingTurn, key } = search;
        let n = 0;
        for (const engine of engines.filter((e) => e.loaded)) {
            const engineMoves = get(engineMovesFamily({ tab, engine: engine.id }));
            const moves = engineMoves.get(key);
            if (moves && moves.length > 0) {
                const bestWinChange = getWinChance(
                    normalizeScore(moves[0].score.value, searchingTurn),
                );
                bestMoves.set(
                    n,
                    moves.reduce<{ pv: string[]; winChance: number }[]>((acc, m) => {
                        const winChance = getWinChance(
                            normalizeScore(m.score.value, searchingTurn),
                        );
                        if (bestWinChange - winChance < BEST_MOVE_ARROW_MAX_WIN_CHANCE_LOSS) {
                            acc.push({ pv: m.uciMoves, winChance });
                        }
                        return acc;
                    }, []),
                );
            }
            n++;
        }
        return reuse(bestMoves);
    });
};

/** Returns the first engine with lines for this position. Callers must memoize the result. */
export const createFirstEngineWithLinesAtom = (tab: string, fen: string, gameMoves: string[]) =>
    atom<string | null>((get) => {
        const engines = get(enginesAtom);
        if (!engines) return null;

        const search = analysisSearch(fen, gameMoves, get(threatFamily(tab)));
        if (!search.available) return null;
        const { key } = search;

        for (const engine of engines.filter((e) => e.loaded)) {
            const engineMoves = get(engineMovesFamily({ tab, engine: engine.id }));
            const moves = engineMoves.get(key);

            if (moves && moves.length > 0) {
                return engine.id;
            }
        }
        return null;
    });

export const tabEngineSettingsFamily = atomFamily(
    ({
        tab: _tab,
        engineId,
        defaultSettings,
        defaultGo,
    }: {
        tab: string;
        engineId: string;
        defaultSettings?: EngineSettings;
        defaultGo?: GoMode;
    }) => {
        const local = atom<AnalysisSettings>({
            enabled: false,
            settings: defaultSettings || [],
            go: defaultGo || { t: "Infinite" },
            synced: true,
        });
        const effective = atom(
            (get) => {
                const settings = get(local);
                const engine = get(enginesAtom)?.find((item) => item.id === engineId);
                return projectAnalysisSettings(settings, engine);
            },
            (
                get,
                set,
                update: AnalysisSettings | ((current: AnalysisSettings) => AnalysisSettings),
            ) => {
                set(local, typeof update === "function" ? update(get(effective)) : update);
            },
        );
        return effective;
    },
    (a, b) => a.tab === b.tab && a.engineId === b.engineId,
);

export const allEnabledFamily = atomFamily((tab: string) =>
    atom((get) => {
        const engines = get(enginesAtom);
        if (!engines) return false;

        const v = engines
            .filter((e) => e.loaded)
            .every((engine) => {
                const atom = tabEngineSettingsFamily({
                    tab,
                    engineId: engine.id,
                    defaultSettings: engine.type === "local" ? engine.settings || [] : undefined,
                    defaultGo: engine.go ?? undefined,
                });
                return get(atom).enabled;
            });

        return v;
    }),
);

export const enableAllFamily = atomFamily((tab: string) =>
    atom(null, (get, set, value: boolean) => {
        const engines = get(enginesAtom);
        if (!engines) return;

        for (const engine of engines.filter((e) => e.loaded)) {
            const atom = tabEngineSettingsFamily({
                tab,
                engineId: engine.id,
                defaultSettings: engine.type === "local" ? engine.settings || [] : undefined,
                defaultGo: engine.go ?? undefined,
            });
            set(atom, { ...get(atom), enabled: value });
        }
    }),
);

/** Remove every runtime atom whose identity is a closed tab, including per-engine entries. */
export function disposeTabAtoms(tabId: string) {
    chessRiddleTrainingSessions.remove(tabId);
    for (const family of [
        allEnabledFamily,
        enableAllFamily,
        puzzleTimerFamily,
        threatFamily,
        evalOpenFamily,
        evalBarDisplayFamily,
        invisibleFamily,
        showCommentsFamily,
        showVariationsFamily,
        tabFamily,
        reportModalOpenFamily,
        localOptionsFamily,
        pinnedExplorerDatabaseFamily,
        dbTypeFamily,
        dbTabFamily,
        analysisTabFamily,
        practiceTabFamily,
        expandedEnginesFamily,
        pgnOptionsFamily,
        gameStateFamily,
        playersFamily,
        gameIdFamily,
        gameSessionFamily,
        gameInterruptionFamily,
        pendingGameStartFamily,
        practiceStateFamily,
        practiceMoveControllerFamily,
        practiceSessionStatsFamily,
        practiceCompletedSummaryFamily,
        practiceCardStartTimeFamily,
    ]) {
        family.remove(tabId);
    }

    for (const family of [
        engineMovesFamily,
        engineProgressFamily,
        engineTerminalFamily,
        engineRetryFamily,
    ]) {
        for (const param of Array.from(family.getParams())) {
            if (param.tab === tabId) family.remove(param);
        }
    }
    for (const param of Array.from(tabEngineSettingsFamily.getParams())) {
        if (param.tab === tabId) tabEngineSettingsFamily.remove(param);
    }
}
