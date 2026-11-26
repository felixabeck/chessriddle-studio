import { notifications } from "@mantine/notifications";
import type { TFunction } from "i18next";
import type { getDefaultStore } from "jotai";
import type { FileMetadata } from "@/components/files/file";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { workspaceErrorMessage } from "@/components/files/workspaceError";
import {
    errorUnlessCancelled,
    normalizeError,
    safeFailureContext,
    warnSafely,
} from "@/platform/errors";
import { MAX_TREE_DEPTH, MAX_TREE_NODES } from "@/state/store/tabStorage";
import { getPGN } from "@/utils/chess";
import { createFile, ensureFileWorkspace } from "@/utils/files";
import { openFile } from "@/utils/openFile";
import {
    MAX_REPERTOIRE_IMPORT_GAMES,
    mergeIntoRepertoire,
    readRepertoireSource,
    RepertoireImportError,
    type RepertoireImportSource,
    type RepertoireMergeRefusalReason,
    type RepertoireMergeReport,
} from "@/utils/repertoireImport";
import type { SetTabs } from "@/utils/tabs";
import { defaultTree } from "@/utils/treeReducer";
import type { WorkspaceListingCache } from "@/utils/workspaceListing";

/** Maps a PGN source or read error to a translated user-facing message. */
export function repertoireImportErrorMessage(error: unknown, t: TFunction): string {
    if (!(error instanceof RepertoireImportError)) {
        return normalizeError(error).message;
    }
    switch (error.code) {
        case "too-many-games":
            return t("Repertoire.Import.Error.TooManyGames", { max: MAX_REPERTOIRE_IMPORT_GAMES });
        case "too-large":
            return t("Repertoire.Import.Error.MaxNodes", { max: MAX_TREE_NODES });
        case "file-changed":
            return t("Repertoire.Import.Error.FileChanged");
        case "no-usable-games":
            return t("Repertoire.Import.Error.NoUsableGames");
        case "io":
            return error.message;
    }
}

/** Maps a `mergeIntoRepertoire` refusal reason to a translated user-facing message. */
export function repertoireMergeRefusalMessage(
    reason: RepertoireMergeRefusalReason,
    t: TFunction,
): string {
    switch (reason) {
        case "max-nodes":
            return t("Repertoire.Import.Error.MaxNodes", { max: MAX_TREE_NODES });
        case "max-depth":
            return t("Repertoire.Import.Error.MaxDepth", { max: MAX_TREE_DEPTH });
        case "max-bytes":
            return t("Repertoire.Import.Error.MaxBytes");
        case "max-line-bytes":
            return t("Repertoire.Import.Error.MaxLineBytes");
    }
}

/** Shows the post-import summary notification with read, skipped, unplaced and conflict counts. */
export function notifyRepertoireImportSuccess(
    t: TFunction,
    counts: { read: number; skipped: number; report: RepertoireMergeReport },
): void {
    notifications.show({
        color: "success",
        title: t("Repertoire.Import.SuccessTitle"),
        message: t("Repertoire.Import.SuccessSummary", {
            read: counts.read,
            skipped: counts.skipped,
            unplaced: counts.report.unplaced,
            conflicts: counts.report.conflicts,
        }),
    });
}

export type CreateRepertoireFromPgnResult =
    | {
          status: "opened";
          tabId: string;
          report: RepertoireMergeReport;
          read: number;
          skipped: number;
      }
    | { status: "created-in-library"; fileName: string }
    | { status: "cancelled" }
    | { status: "refused"; stage: "source" | "create"; message: string; error?: unknown };

function createRefusal(error: unknown, t: TFunction): CreateRepertoireFromPgnResult {
    return {
        status: "refused",
        stage: "create",
        message: workspaceErrorMessage(error, normalizeError(error).message, t),
        error,
    };
}

function notifyCreatedInLibrary(t: TFunction, fileName: string): CreateRepertoireFromPgnResult {
    notifications.show({
        color: "warning",
        title: t("Repertoire.Import.CreatedInLibraryTitle"),
        message: t("Repertoire.Import.CreatedInLibraryBody", { name: fileName }),
    });
    return { status: "created-in-library", fileName };
}

/**
 * Shared submission/outcome router for dialogs calling `createRepertoireFromPgn`.
 */
export async function submitCreateRepertoireFromPgn({
    runAbortable,
    isMounted,
    t,
    request,
    onCreateRefusal,
    onSourceRefusal,
    onComplete,
}: {
    runAbortable: (
        operation: (signal: AbortSignal) => Promise<CreateRepertoireFromPgnResult>,
    ) => Promise<CreateRepertoireFromPgnResult>;
    isMounted: () => boolean;
    t: TFunction;
    request: (signal: AbortSignal) => Promise<CreateRepertoireFromPgnResult>;
    onCreateRefusal: (message: string) => void;
    onSourceRefusal: (message: string) => void;
    onComplete: (
        outcome: Extract<
            CreateRepertoireFromPgnResult,
            { status: "opened" | "created-in-library" }
        >,
    ) => void;
}): Promise<void> {
    let outcome: CreateRepertoireFromPgnResult;
    try {
        outcome = await runAbortable(request);
    } catch (error) {
        if (errorUnlessCancelled(error) === null) return;
        if (!isMounted()) {
            notifyUnlessCancelled(t("Common.Error"), error, "files");
            return;
        }
        onCreateRefusal(workspaceErrorMessage(error, normalizeError(error).message, t));
        return;
    }

    if (!isMounted()) {
        if (outcome.status === "refused" && outcome.stage === "create") {
            notifyUnlessCancelled(
                t("Common.Error"),
                outcome.error ?? new Error(outcome.message),
                "files",
            );
        }
        return;
    }
    if (outcome.status === "cancelled") return;
    if (outcome.status === "refused") {
        if (outcome.stage === "create") onCreateRefusal(outcome.message);
        else onSourceRefusal(outcome.message);
        return;
    }
    onComplete(outcome);
}

/**
 * Creates a repertoire file from a PGN file or pasted PGN text, merges its lines under the chosen
 * color, writes the file with `Orientation` set, and opens it.
 */
export async function createRepertoireFromPgn({
    name,
    color,
    source,
    listingCache,
    setTabs,
    t,
    signal,
    ownerId,
    store,
}: {
    name: string;
    color: "white" | "black";
    source: RepertoireImportSource;
    listingCache: WorkspaceListingCache;
    setTabs: SetTabs;
    t: TFunction;
    signal?: AbortSignal;
    ownerId?: string;
    store?: ReturnType<typeof getDefaultStore>;
}): Promise<CreateRepertoireFromPgnResult> {
    if (signal?.aborted) return { status: "cancelled" };

    let readResult;
    try {
        readResult = await readRepertoireSource(source, { signal });
    } catch (error) {
        if (errorUnlessCancelled(error) === null || signal?.aborted) {
            return { status: "cancelled" };
        }
        return {
            status: "refused",
            stage: "source",
            message: repertoireImportErrorMessage(error, t),
            error,
        };
    }
    if (signal?.aborted) return { status: "cancelled" };

    const base = defaultTree();
    base.headers = {
        ...base.headers,
        event: name,
        orientation: color,
    };
    const merged = mergeIntoRepertoire(base, readResult.games, color);
    if (!merged.ok) {
        return {
            status: "refused",
            stage: "source",
            message: repertoireMergeRefusalMessage(merged.reason, t),
        };
    }

    const pgn = getPGN(merged.tree.root, {
        headers: merged.tree.headers,
        comments: true,
        extraMarkups: true,
        glyphs: true,
        variations: true,
    });

    let fileInfo: FileMetadata;
    let createAttempted = false;
    try {
        const workspace = await ensureFileWorkspace();
        if (signal?.aborted || !workspace) return { status: "cancelled" };
        createAttempted = true;
        const createResult = await createFile({
            filename: name,
            filetype: "repertoire",
            content: { kind: "text", pgn },
            workspace,
            parent: workspace,
            listingCache,
        });
        if (createResult.isErr) {
            return createRefusal(createResult.error, t);
        }
        fileInfo = createResult.value;
    } catch (error) {
        if (errorUnlessCancelled(error) === null || (!createAttempted && signal?.aborted)) {
            return { status: "cancelled" };
        }
        return createRefusal(error, t);
    }

    try {
        const tabId = await openFile(fileInfo, setTabs, {
            tabName: fileInfo.name,
            ...(ownerId !== undefined ? { ownerId } : {}),
            ...(store !== undefined ? { store } : {}),
            ...(signal ? { signal } : {}),
        });
        if (tabId === null) {
            return notifyCreatedInLibrary(t, fileInfo.name);
        }
        notifyRepertoireImportSuccess(t, {
            read: readResult.games.length,
            skipped: readResult.skipped,
            report: merged.report,
        });
        return {
            status: "opened",
            tabId,
            report: merged.report,
            read: readResult.games.length,
            skipped: readResult.skipped,
        };
    } catch (error) {
        if (errorUnlessCancelled(error) !== null) {
            warnSafely(
                `Repertoire created in library could not open: ${safeFailureContext(error).message}`,
            );
        }
        return notifyCreatedInLibrary(t, fileInfo.name);
    }
}
