/** Database choices of the explorer and puzzle pages, and account workflow state. */
import type { SetStateAction } from "react";
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { z } from "zod";
import type {
    DatabaseHandle,
    CollectionDescriptor,
    FileWorkspaceHandle,
    PathRef,
} from "@/bindings";
import {
    type ExplorerFilterEntry,
    type ExplorerFilters,
    explorerFilterEntriesSchema,
    explorerFiltersFor,
    replaceExplorerFilterDatabase,
    withExplorerFilters,
    withoutExplorerFilters,
} from "../explorerFilters";
import { type OpponentLink, opponentLinksSchema } from "../opponentLinks";
import {
    fileWorkspaceHandleSchema,
    databaseHandleSchema,
    comparisonSourceSchema,
    type ComparisonSource,
    isDatabaseComparisonSource,
    fileWorkspaceKey,
    capabilityKey,
    pathRefSchema,
} from "../../utils/pathCapabilities";
import { createZodStorage, initializeBeforeUse } from "../utils";
import { fileWorkspaceAtom } from "./directories";
import { documentPreferences, initializeRendererState } from "./rendererState";

// Read at document initialization like the explorer's other database choices, so a write that
// follows a replaced database sees the stored reference although no consumer has mounted it.
const storedReferenceDbAtom = documentPreferences.atomWithStorage<DatabaseHandle | null>(
    "reference-database",
    null,
    createZodStorage(databaseHandleSchema.nullable(), localStorage),
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

/**
 * The board explorer's saved filters per local database, keyed by the opaque database id. The
 * Databases page and the player opening tree do not read them.
 */
export const explorerDatabaseFiltersAtom = documentPreferences.atomWithStorage<
    ExplorerFilterEntry[]
>(
    // Read once at document initialization, so a write from a page that never mounted the
    // explorer still starts from the stored list.
    "explorer-database-filters",
    [],
    createZodStorage(explorerFilterEntriesSchema, localStorage),
);

/**
 * The online accounts linked to database players, least recently changed first. A link names its
 * player and its database file by value; both are matched against what a database lists whenever
 * they are read, so nothing here keeps a path capability alive.
 */
export const opponentLinksAtom = documentPreferences.atomWithStorage<OpponentLink[]>(
    "opponent-links",
    [],
    createZodStorage(opponentLinksSchema, localStorage),
);

/** Running downloads of online games by link id, each with its ticket once the import has one. */
export const opponentImportsAtom = atom<ReadonlyMap<string, string | null>>(new Map());

/** One-shot target for opening a player's Preparation card once DatabaseView resolves the route. */
export type PendingPlayerCard = {
    database: string;
    playerId: number;
    playerName: string;
};

/** In-memory only: consumed by DatabaseView once the route resolves to the matching database. */
export const pendingPlayerCardAtom = atom<PendingPlayerCard | null>(null);

export type { ComparisonSource };
export { comparisonSourceSchema, isDatabaseComparisonSource };

/**
 * The app-wide second source of the board explorer, shown beside the first column. What a panel
 * shows is derived from it on read; the stored choice is never reset by that derivation. A handle
 * and `null` keep their present shape; a value that does not parse becomes `null`.
 */
export const comparisonDbAtom = documentPreferences.atomWithStorage<ComparisonSource>(
    "comparison-database",
    null,
    createZodStorage(comparisonSourceSchema, localStorage),
);

export const setExplorerFiltersAtom = atom(
    null,
    (get, set, change: { database: DatabaseHandle; update: SetStateAction<ExplorerFilters> }) => {
        const entries = get(explorerDatabaseFiltersAtom);
        const key = capabilityKey(change.database);
        const next =
            typeof change.update === "function"
                ? change.update(explorerFiltersFor(entries, key))
                : change.update;
        set(explorerDatabaseFiltersAtom, withExplorerFilters(entries, key, next));
    },
);

/** Database `from` was replaced by `to`: every stored explorer choice keyed on it follows. */
export const replaceExplorerDatabaseAtom = atom(
    null,
    (get, set, change: { from: DatabaseHandle; to: DatabaseHandle }) => {
        const from = capabilityKey(change.from);
        const to = capabilityKey(change.to);
        if (from === to) return;
        const entries = get(explorerDatabaseFiltersAtom);
        if (entries.some((entry) => entry.database === from)) {
            set(explorerDatabaseFiltersAtom, replaceExplorerFilterDatabase(entries, from, to));
        }
        const reference = get(referenceDbAtom);
        if (reference && capabilityKey(reference) === from) set(referenceDbAtom, change.to);
        const comparison = get(comparisonDbAtom);
        if (isDatabaseComparisonSource(comparison) && capabilityKey(comparison) === from) {
            set(comparisonDbAtom, change.to);
        }
    },
);

/** A deleted database keeps no stored explorer choice. */
export const forgetExplorerDatabaseAtom = atom(null, (get, set, database: DatabaseHandle) => {
    const key = capabilityKey(database);
    const entries = get(explorerDatabaseFiltersAtom);
    if (entries.some((entry) => entry.database === key)) {
        set(explorerDatabaseFiltersAtom, withoutExplorerFilters(entries, key));
    }
    const comparison = get(comparisonDbAtom);
    if (isDatabaseComparisonSource(comparison) && capabilityKey(comparison) === key) {
        set(comparisonDbAtom, null);
    }
});

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

/** In-memory only: account keys mapped to their pending download ticket; owned by AccountCard's download action. */
export const accountDownloadsInFlightAtom = atom<ReadonlyMap<string, string | null>>(new Map());

/** Native account workflows survive the document's in-memory download tickets. */
export const accountCompletionsAtom = atom<
    ReadonlyMap<string, import("@/bindings").AccountCompletion>
>(new Map());
