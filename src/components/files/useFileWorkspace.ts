import { tauri } from "@/platform/tauri";
import { listingFailure, rootFailureMessage } from "@/components/files/listingFailure";
import { useSingleFlight } from "@/hooks/useSingleFlight";
import {
    isOperationAndCleanup,
    normalizeError,
    runDestructiveWithRefresh,
} from "@/platform/errors";
import { runUnlessCancelled } from "@/components/files/notifyError";
import { notifications } from "@mantine/notifications";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import useSWR, { useSWRConfig } from "swr";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { fileWorkspaceAtom, fileWorkspaceDisplayNameAtom, tabsAtom } from "@/state/atoms";
import { fileGameHasBlockingOpenTab } from "@/utils/fileGameWrite";
import { patchFileTabsSidecar } from "@/utils/tabs";
import { readFileGame, setFileGameOrientation } from "@/utils/files";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { durabilityUncertainMessage } from "../common/ConfirmModal";
import type { Entry, UsableEntry, FileType } from "./file";
import { findEntry } from "./file";
import { useWorkspaceListing } from "@/components/library/useWorkspaceListing";
import { filesMutationErrorMessage, runFilesMutationWithRefresh } from "./workspaceError";
import {
    reconcileWorkspaceListing,
    workspaceListingKey,
    type WorkspaceListingCache,
} from "@/utils/workspaceListing";
import type { FileWorkspaceHandle, TrashItemId, WorkspaceTrashPage } from "@/bindings";

type TrashTarget = { item: TrashItemId; name: string };

const fileAction = { file: "file", folder: "folder", rename: "rename", edit: "edit" } as const;
type FileAction = (typeof fileAction)[keyof typeof fileAction];
type ActionTarget =
    | { kind: "root"; handle: FileWorkspaceHandle }
    | { kind: "entry"; entry: UsableEntry };
type Presentation = {
    workspace: FileWorkspaceHandle;
    cache: WorkspaceListingCache;
    target: ActionTarget;
    pending: boolean;
    destination?: { handle: FileWorkspaceHandle; label: string };
};

async function runTrashMutationWithRefresh(
    run: () => Promise<unknown>,
    refresh: () => void | Promise<void>,
    refreshCleanup: () => unknown | Promise<unknown> = refresh,
) {
    try {
        await runDestructiveWithRefresh(run, refresh);
    } catch (cause) {
        if (isOperationAndCleanup(cause)) {
            try {
                await refreshCleanup();
            } catch {
                // The listing cannot replace the operation and cleanup failure.
            }
        }
        throw cause;
    }
}

export type FileWorkspace = ReturnType<typeof useFileWorkspace>;

export function useFileWorkspace(
    selectedEntry: Entry | null,
    setSelectedEntry: (entry: Entry | null) => void,
    selectedWorkspaceKey?: string,
    omitNewGame = false,
) {
    const { t } = useTranslation();
    const listingCache = useSWRConfig();
    const picker = useSingleFlight();
    const [workspace, setWorkspace] = useAtom(fileWorkspaceAtom);
    const [, setWorkspaceDisplayName] = useAtom(fileWorkspaceDisplayNameAtom);
    const tabs = useAtomValue(tabsAtom);
    const setTabs = useSetAtom(tabsAtom);
    const [action, setAction] = useState<FileAction | null>(null);
    const [name, setName] = useState("");
    const [fileType, setFileType] = useState<FileType>("other");
    const [repertoireColor, setRepertoireColor] = useState<"white" | "black">("white");
    const [actionError, setActionError] = useState("");
    const [trashed, setTrashed] = useState<TrashTarget | null>(null);
    const [uncertainTrashName, setUncertainTrashName] = useState<string | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<UsableEntry | null>(null);
    const [restoreTarget, setRestoreTarget] = useState<TrashTarget | null>(null);
    const [purgeTarget, setPurgeTarget] = useState<TrashTarget | null>(null);
    const [emptyTarget, setEmptyTarget] = useState(false);
    const [olderTrash, setOlderTrash] = useState<{
        root: WorkspaceTrashPage;
        page: WorkspaceTrashPage;
    } | null>(null);
    const [olderTrashError, setOlderTrashError] = useState<unknown>();
    const [loadingOlderTrash, setLoadingOlderTrash] = useState(false);
    const olderRequest = useRef<object | null>(null);
    const [moveTarget, setMoveTarget] = useState<string | null>(null);
    const [moving, setMoving] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const operationFailed = t("Files.OperationFailed", {
        defaultValue: "The file operation could not be completed. Please try again.",
    });
    const presentation = useRef<Presentation | null>(null);
    const moveInFlight = useRef<Presentation | null>(null);
    const actionInputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (action) actionInputRef.current?.focus();
    }, [action]);
    const workspaceIdentity = workspace ? fileWorkspaceKey(workspace) : null;
    const trashKey = workspace ? ["workspace-trash", workspaceIdentity] : null;
    const trashOwner = useNativeRequestOwner(trashKey);
    const olderTrashOwner = useNativeRequestOwner(
        workspace ? ["workspace-trash-older", workspaceIdentity] : null,
    );
    const {
        data: trashPage,
        error: trashError,
        mutate: mutateTrash,
    } = useSWR(trashKey, async () =>
        trashOwner!.run(async (signal) => tauri.listWorkspaceTrash(workspace!, null, { signal })),
    );
    const environment = useRef({ workspaceIdentity, cache: listingCache.cache });
    environment.current = { workspaceIdentity, cache: listingCache.cache };
    useEffect(() => {
        setAction(null);
        setMoveTarget(null);
        setRepertoireColor("white");
        setActionError("");
        setSubmitting(false);
        setMoving(false);
        setTrashed(null);
        setUncertainTrashName(null);
        setRestoreTarget(null);
        setPurgeTarget(null);
        setEmptyTarget(false);
        return () => {
            presentation.current = null;
            moveInFlight.current = null;
        };
    }, [workspaceIdentity, listingCache.cache]);
    useEffect(() => {
        olderRequest.current = null;
        setOlderTrash(null);
        setOlderTrashError(undefined);
        setLoadingOlderTrash(false);
        return () => {
            olderRequest.current = null;
        };
    }, [workspaceIdentity, listingCache.cache, trashPage]);
    const displayedTrash =
        olderTrash && olderTrash.root === trashPage ? olderTrash.page : trashPage;
    async function loadOlderTrash() {
        if (!workspace || !trashPage || !displayedTrash?.cursor || olderRequest.current) return;
        const request = {};
        olderRequest.current = request;
        setLoadingOlderTrash(true);
        setOlderTrashError(undefined);
        try {
            await olderTrashOwner!.supersede();
            if (olderRequest.current !== request) return;
            const page = await olderTrashOwner!.run((signal) =>
                tauri.listWorkspaceTrash(workspace, displayedTrash.cursor, { signal }),
            );
            if (olderRequest.current !== request) return;
            setOlderTrash({
                root: trashPage,
                page: { ...page, items: [...displayedTrash.items, ...page.items] },
            });
        } catch (cause) {
            if (olderRequest.current === request) setOlderTrashError(cause);
        } finally {
            if (olderRequest.current === request) {
                olderRequest.current = null;
                setLoadingOlderTrash(false);
            }
        }
    }
    const { data, error, mutate } = useWorkspaceListing(workspace);
    const failure = listingFailure(error);
    const trashListingError = trashError ?? olderTrashError;
    const trashFailure = listingFailure(trashListingError);
    const trashLoadFailureMessage =
        rootFailureMessage("files", trashListingError, t) ??
        t("Files.LoadFailed", {
            defaultValue: "Files could not be loaded. Please try again.",
        });
    const loadFailureMessage =
        rootFailureMessage("files", error, t) ??
        t("Files.LoadFailed", {
            defaultValue: "Files could not be loaded. Please try again.",
        });
    // Handle ids survive relisting and rename, so every fresh listing re-derives the selection;
    // an entry that is gone clears it. Before the first listing the chosen entry stands.
    const ownedEntry =
        !selectedWorkspaceKey || (workspace && selectedWorkspaceKey === fileWorkspaceKey(workspace))
            ? selectedEntry
            : null;
    const selected =
        ownedEntry?.type === "unreadable"
            ? null
            : ownedEntry && data
              ? findEntry(data, fileWorkspaceKey(ownedEntry.handle), ownedEntry.type)
              : ownedEntry;
    function chooseWorkspace() {
        return picker.run(async () => {
            const result = await runUnlessCancelled(
                t("Common.Error"),
                () => tauri.issueFileWorkspace(workspace),
                "files",
            );
            if (!result) return;
            setWorkspace(result.handle);
            setWorkspaceDisplayName(result.displayName);
        });
    }
    function owns(owner: Presentation) {
        return (
            presentation.current === owner &&
            environment.current.workspaceIdentity === fileWorkspaceKey(owner.workspace) &&
            environment.current.cache === owner.cache.cache
        );
    }
    function closePresentation() {
        moveInFlight.current = null;
        presentation.current = null;
        setAction(null);
        setMoveTarget(null);
        setActionError("");
        setSubmitting(false);
        setMoving(false);
    }
    function openPresentation(target: ActionTarget) {
        if (!workspace) return;
        const owner: Presentation = { workspace, cache: listingCache, target, pending: false };
        presentation.current = owner;
        moveInFlight.current = null;
        setActionError("");
        setSubmitting(false);
        setMoving(false);
        return owner;
    }
    function openAction(next: FileAction) {
        const editing = next === fileAction.edit || next === fileAction.rename;
        if (editing && selected?.type !== "file") return;
        const target: ActionTarget =
            editing || selected?.type === "directory"
                ? { kind: "entry", entry: selected! }
                : { kind: "root", handle: workspace! };
        if (!openPresentation(target)) return;
        setMoveTarget(null);
        setName(editing ? selected!.name : "");
        if (selected?.type === "file") setFileType(selected.metadata.type);
        if (next === fileAction.edit) setRepertoireColor("white");
        setAction(next);
    }
    function createFile() {
        openAction(fileAction.file);
    }
    function createFolder() {
        openAction(fileAction.folder);
    }
    function rename() {
        openAction(fileAction.rename);
    }
    function editMetadata() {
        openAction(fileAction.edit);
    }
    function openMove(entry: UsableEntry) {
        const owner = openPresentation({ kind: "entry", entry });
        if (!owner) return;
        owner.destination = {
            handle: owner.workspace,
            label: t("Files.CollectionRoot", { defaultValue: "Collection root" }),
        };
        setAction(null);
        setSelectedEntry(entry);
        setMoveTarget(fileWorkspaceKey(workspace!));
    }
    function currentTarget(owner: Presentation, target: ActionTarget) {
        if (!owns(owner) || !data || failure !== "silent" || error) return null;
        if (target.kind === "root") return target.handle;
        const found = findEntry(data, fileWorkspaceKey(target.entry.handle), target.entry.type);
        return found && !(found.type === "file" && found.readError) ? found : null;
    }
    function refuseUnavailable() {
        setActionError(
            (previous) =>
                previous ||
                filesMutationErrorMessage(
                    { category: "not-found", message: "" },
                    operationFailed,
                    t,
                ),
        );
    }
    async function runMutation(
        owner: Presentation,
        run: () => Promise<unknown>,
        setPending: (pending: boolean) => void,
        onSuccess: () => void,
    ) {
        if (!owns(owner) || owner.pending) return;
        owner.pending = true;
        setPending(true);
        setActionError("");
        const reconcile = () => reconcileWorkspaceListing(owner.workspace, owner.cache);
        let durabilityUncertain = false;
        try {
            const outcome = await runFilesMutationWithRefresh(
                run,
                (cleanupFailure) =>
                    cleanupFailure
                        ? reconcile()
                        : owner.cache.mutate(workspaceListingKey(owner.workspace)),
                reconcile,
            );
            durabilityUncertain = outcome.kind === "durability-uncertain";
            if (owns(owner)) onSuccess();
        } catch (cause) {
            if (normalizeError(cause).backendCategory === "durability") {
                durabilityUncertain = true;
                if (owns(owner)) onSuccess();
            } else if (owns(owner))
                setActionError(filesMutationErrorMessage(cause, operationFailed, t));
        } finally {
            owner.pending = false;
            if (owns(owner)) setPending(false);
        }
        if (durabilityUncertain)
            notifications.show({ color: "warning", message: durabilityUncertainMessage(t) });
    }
    const directories = (
        entries: Entry[],
    ): { handle: NonNullable<typeof workspace>; label: string }[] =>
        entries.flatMap((entry) =>
            entry.type === "directory"
                ? [{ handle: entry.handle, label: entry.name }, ...directories(entry.children)]
                : [],
        );
    const destinationDirectories = data ? directories(data) : [];
    const moveDestinations = [
        ...(workspace
            ? [
                  {
                      handle: workspace,
                      label: t("Files.CollectionRoot", { defaultValue: "Collection root" }),
                  },
              ]
            : []),
        ...destinationDirectories,
    ];
    // Keep the chosen destination visible after it disappears, without making it writable.
    const retainedDestination = presentation.current?.destination;
    if (
        retainedDestination &&
        !moveDestinations.some(
            (entry) =>
                fileWorkspaceKey(entry.handle) === fileWorkspaceKey(retainedDestination.handle),
        )
    )
        moveDestinations.push(retainedDestination);
    const moveTargetHandle = moveDestinations.find(
        (entry) => fileWorkspaceKey(entry.handle) === moveTarget,
    )?.handle;
    function selectMoveDestination(value: string) {
        const owner = presentation.current;
        if (!owner || !owns(owner)) return;
        owner.destination = moveDestinations.find(
            (entry) => fileWorkspaceKey(entry.handle) === value,
        );
        setMoveTarget(value);
    }
    async function confirmMove() {
        const owner = presentation.current;
        if (!owner || !owns(owner) || owner.pending) return;
        if (owner.target.kind !== "entry" || !moveTargetHandle) {
            refuseUnavailable();
            return;
        }
        await moveEntry(owner.target.entry, moveTargetHandle, owner);
    }
    async function moveEntry(
        entry: Entry,
        destination: UsableEntry["handle"],
        dialogOwner?: Presentation,
    ) {
        if (entry.type === "unreadable") return;
        if (moveInFlight.current) return;
        if (!workspace) return;
        const owner = dialogOwner ?? openPresentation({ kind: "entry", entry });
        if (!owner || !owns(owner) || owner.pending) return;
        const destinationEntry = data
            ? findEntry(data, fileWorkspaceKey(destination), "directory")
            : null;
        const destinationTarget: ActionTarget | null =
            fileWorkspaceKey(destination) === fileWorkspaceKey(owner.workspace)
                ? { kind: "root", handle: destination }
                : destinationEntry
                  ? { kind: "entry", entry: destinationEntry }
                  : null;
        const source = currentTarget(owner, owner.target);
        if (
            !source ||
            !("type" in source) ||
            !destinationTarget ||
            !currentTarget(owner, destinationTarget)
        ) {
            refuseUnavailable();
            return;
        }
        try {
            await runMutation(
                owner,
                () => {
                    moveInFlight.current = owner;
                    setSelectedEntry(source);
                    return tauri.moveWorkspaceEntry(owner.workspace, source.handle, destination);
                },
                setMoving,
                closePresentation,
            );
        } finally {
            if (moveInFlight.current === owner) moveInFlight.current = null;
        }
    }
    async function submitAction() {
        const owner = presentation.current;
        if (!owner || !owns(owner) || owner.pending || !action) return;
        const target = currentTarget(owner, owner.target);
        if (!target) {
            refuseUnavailable();
            return;
        }
        const source = "type" in target && target.type === "file" ? target : null;
        const parent = "type" in target ? target.handle : target;
        const nameUnchanged = source && name === source.name;
        const editing = action === fileAction.edit || action === fileAction.rename;
        if (editing && !source) {
            refuseUnavailable();
            return;
        }
        if (
            !name.trim() &&
            (action === fileAction.file ||
                action === fileAction.folder ||
                (editing && !nameUnchanged))
        )
            return;
        const chosenType =
            action === fileAction.edit ? fileType : source ? source.metadata.type : "other";
        const typeUnchanged = !source || chosenType === source.metadata.type;
        const convertingToRepertoire =
            action === fileAction.edit &&
            !!source &&
            chosenType === "repertoire" &&
            source.metadata.type !== "repertoire";
        const nonDefaultColor =
            action === fileAction.edit &&
            chosenType === "repertoire" &&
            repertoireColor !== "white";
        const needsOrientationWrite = convertingToRepertoire || nonDefaultColor;
        if (editing && source && nameUnchanged && typeUnchanged && !nonDefaultColor) {
            closePresentation();
            setName("");
            return;
        }
        if (needsOrientationWrite && source) {
            for (let index = 0; index < source.numGames; index += 1) {
                if (fileGameHasBlockingOpenTab(tabs, source.handle, index)) {
                    setActionError(t("Files.LineSection.UnsavedTab"));
                    return;
                }
            }
        }
        await runMutation(
            owner,
            async () => {
                if (action === fileAction.file)
                    await tauri.createWorkspaceFile(
                        owner.workspace,
                        parent,
                        name,
                        { type: "game", tags: [] },
                        {
                            kind: "text",
                            pgn: "*",
                        },
                    );
                if (action === fileAction.folder)
                    await tauri.createWorkspaceDirectory(owner.workspace, parent, name);
                if (editing && source) {
                    if (needsOrientationWrite) {
                        for (let index = 0; index < source.numGames; index += 1) {
                            let game: Awaited<ReturnType<typeof readFileGame>>;
                            try {
                                game = await readFileGame(source.handle, index);
                            } catch (cause) {
                                if (normalizeError(cause).backendCategory === "resource-limit")
                                    continue;
                                throw cause;
                            }
                            if (!game.present || game.omission) continue;
                            await setFileGameOrientation(
                                source.handle,
                                index,
                                repertoireColor,
                                game.stamp,
                                game.revision,
                            );
                        }
                    }
                    if (!nameUnchanged || !typeUnchanged) {
                        const metadata = {
                            type: chosenType,
                            tags: source.metadata.tags,
                        };
                        const applySidecarPatch = () =>
                            patchFileTabsSidecar({
                                setTabs,
                                fileKey: fileWorkspaceKey(source.handle),
                                name: nameUnchanged ? source.name : name,
                                metadata,
                            });
                        try {
                            if (nameUnchanged)
                                await tauri.writeWorkspaceFileMetadata(
                                    owner.workspace,
                                    source.handle,
                                    metadata,
                                );
                            else
                                await tauri.renameWorkspaceFile(
                                    owner.workspace,
                                    source.handle,
                                    name,
                                    metadata,
                                );
                            applySidecarPatch();
                        } catch (cause) {
                            if (normalizeError(cause).backendCategory === "durability")
                                applySidecarPatch();
                            throw cause;
                        }
                    }
                }
            },
            setSubmitting,
            () => {
                closePresentation();
                setName("");
            },
        );
    }
    async function clearTrashAndRelist() {
        if (environment.current.workspaceIdentity !== workspaceIdentity) return;
        setTrashed(null);
        setUncertainTrashName(null);
        // SWR reports list failures separately; they must not replace the native mutation outcome
        // with a false generic failure or hide its applied-despite-error warning.
        await refreshListings();
    }
    async function refreshListings() {
        if (environment.current.workspaceIdentity !== workspaceIdentity) return;
        olderRequest.current = null;
        setOlderTrash(null);
        setOlderTrashError(undefined);
        setLoadingOlderTrash(false);
        await Promise.allSettled([olderTrashOwner?.supersede(), mutate(), mutateTrash()]);
    }
    async function confirmTrash(target: UsableEntry) {
        await runTrashMutationWithRefresh(
            async () => {
                try {
                    const item = await tauri.trashWorkspaceEntry(workspace!, target.handle);
                    if (environment.current.workspaceIdentity === workspaceIdentity) {
                        setUncertainTrashName(null);
                        setTrashed({ item, name: target.name });
                    }
                } catch (cause) {
                    if (
                        normalizeError(cause).backendCategory === "durability" &&
                        environment.current.workspaceIdentity === workspaceIdentity
                    ) {
                        setTrashed(null);
                        setUncertainTrashName(target.name);
                    }
                    throw cause;
                }
            },
            async () => {
                if (environment.current.workspaceIdentity !== workspaceIdentity) return;
                setSelectedEntry(null);
                // A durably successful trash still closes when the listing fails.
                // ConfirmModal calls onClose only after this refresh resolves.
                // A durability rejection throws after this refresh, so the confirm stays open.
                await refreshListings();
            },
            refreshListings,
        );
    }
    async function confirmRestore(target: TrashTarget) {
        await runTrashMutationWithRefresh(
            () => tauri.restoreWorkspaceTrashItem(workspace!, target.item),
            clearTrashAndRelist,
        );
    }
    async function confirmPurge(target: TrashTarget) {
        await runDestructiveWithRefresh(
            () => tauri.deleteWorkspaceTrashItem(workspace!, target.item),
            clearTrashAndRelist,
        );
    }
    async function confirmEmptyTrash() {
        await runDestructiveWithRefresh(
            () => tauri.emptyWorkspaceTrash(workspace!),
            clearTrashAndRelist,
        );
    }
    function retryTrash() {
        return olderTrashError ? loadOlderTrash() : mutateTrash().catch(() => {});
    }
    return {
        workspace,
        data,
        selected,
        failure,
        listProps: {
            files: failure === "silent" ? (data ?? []) : [],
            selectedFile: selected,
            setSelectedFile: setSelectedEntry,
            onRequestDelete: (entry: Entry) => {
                if (entry.type !== "unreadable") setDeleteTarget(entry);
            },
            onRequestMove: (entry: Entry) => {
                if (entry.type === "unreadable") return;
                openMove(entry);
            },
            onMove: (entry: Entry, destination: Entry) => {
                if (destination.type === "unreadable") return undefined;
                return moveEntry(entry, destination.handle);
            },
        },
        action,
        name,
        setName,
        fileType,
        setFileType,
        repertoireColor,
        setRepertoireColor,
        actionError,
        submitting,
        submitAction,
        moving,
        moveTarget,
        moveDestinations,
        selectMoveDestination,
        confirmMove,
        closePresentation,
        actionInputRef,
        createFile,
        createFolder,
        rename,
        editMetadata,
        requestMove: openMove,
        deleteTarget,
        setDeleteTarget,
        confirmTrash,
        restoreTarget,
        setRestoreTarget,
        confirmRestore,
        purgeTarget,
        setPurgeTarget,
        confirmPurge,
        emptyTarget,
        setEmptyTarget,
        confirmEmptyTrash,
        trashed,
        uncertainTrashName,
        displayedTrash,
        trashFailure,
        trashLoadFailureMessage,
        retryTrash,
        loadingOlderTrash,
        loadOlderTrash,
        loadFailureMessage,
        pickerPending: picker.pending,
        chooseWorkspace,
        omitNewGame,
    };
}
