import {
  libraryButtonProps,
  LibrarySectionHeading,
  libraryClasses,
} from "@/components/library/presentation";
import { FileText, Trash2 } from "lucide-react";
import { tauri } from "@/platform/tauri";
import { listingFailure, rootFailureMessage } from "@/components/files/listingFailure";
import { useSingleFlight } from "@/hooks/useSingleFlight";
import {
  isOperationAndCleanup,
  normalizeError,
  runDestructiveWithRefresh,
} from "@/platform/errors";
import { runUnlessCancelled } from "@/components/files/notifyError";
import { Box, Button, Center, Group, Radio, Select, Stack, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useAtom } from "jotai";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import useSWR, { useSWRConfig } from "swr";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { useScaledMaxWidth } from "@/hooks/useScaledMaxWidth";
import { fileWorkspaceAtom, fileWorkspaceDisplayNameAtom } from "@/state/atoms";
import { formatNumber } from "@/utils/format";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import FileCard from "./FileCard";
import ConfirmModal, { durabilityUncertainMessage } from "../common/ConfirmModal";
import AppModal from "../common/AppModal";
import type { Entry, UsableEntry, FileType } from "./file";
import { FILE_TYPES } from "./file";
import { useWorkspaceListing } from "@/components/library/useWorkspaceListing";
import { filesMutationErrorMessage, runFilesMutationWithRefresh } from "./workspaceError";
import { childUnreadableMessage } from "./DirectoryTree";
import {
  reconcileWorkspaceListing,
  workspaceListingKey,
  type WorkspaceListingCache,
} from "./workspaceListing";
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
const FILE_CARD_MIN_HEIGHT = "32rem";
const EMPTY_PANE_MIN_HEIGHT = "12rem";
// At 320px/200% the default modal clipped the type Select's "Repertoire";
// below this width the shared create/rename/edit dialog and Move go full-screen.
// The threshold follows the app font scale, measured in scaled root-em.
const COMPACT_DIALOG_WIDTH_EM = 30;

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

function findEntry(entries: Entry[], key: string, kind: Entry["type"]): UsableEntry | null {
  for (const entry of entries) {
    if (
      entry.type !== "unreadable" &&
      entry.type === kind &&
      fileWorkspaceKey(entry.handle) === key
    )
      return entry;
    if (entry.type === "directory") {
      const child = findEntry(entry.children, key, kind);
      if (child) return child;
    }
  }
  return null;
}

export function useFileWorkspace(
  selectedEntry: Entry | null,
  setSelectedEntry: (entry: Entry | null) => void,
  selectedWorkspaceKey?: string,
) {
  const { t, i18n } = useTranslation();
  const listingCache = useSWRConfig();
  const compactDialog = useScaledMaxWidth(COMPACT_DIALOG_WIDTH_EM);
  const fileTypeOptions = FILE_TYPES.map(({ value, translationKey }) => ({
    value,
    label: t(translationKey),
  }));
  const picker = useSingleFlight();
  const [workspace, setWorkspace] = useAtom(fileWorkspaceAtom);
  const [, setWorkspaceDisplayName] = useAtom(fileWorkspaceDisplayNameAtom);
  const [action, setAction] = useState<FileAction | null>(null);
  const [name, setName] = useState("");
  const [fileType, setFileType] = useState<FileType>("other");
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
  const displayedTrash = olderTrash && olderTrash.root === trashPage ? olderTrash.page : trashPage;
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
        () => tauri.issueFileWorkspace(),
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
    setAction(next);
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
        filesMutationErrorMessage({ category: "not-found", message: "" }, operationFailed, t),
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
          cleanupFailure ? reconcile() : owner.cache.mutate(workspaceListingKey(owner.workspace)),
        reconcile,
      );
      durabilityUncertain = outcome.kind === "durability-uncertain";
      if (owns(owner)) onSuccess();
    } catch (cause) {
      if (normalizeError(cause).backendCategory === "durability") {
        durabilityUncertain = true;
        if (owns(owner)) onSuccess();
      } else if (owns(owner)) setActionError(filesMutationErrorMessage(cause, operationFailed, t));
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
      (entry) => fileWorkspaceKey(entry.handle) === fileWorkspaceKey(retainedDestination.handle),
    )
  )
    moveDestinations.push(retainedDestination);
  const moveTargetHandle = moveDestinations.find(
    (entry) => fileWorkspaceKey(entry.handle) === moveTarget,
  )?.handle;
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
      (action === fileAction.file || action === fileAction.folder || (editing && !nameUnchanged))
    )
      return;
    const chosenType =
      action === fileAction.edit ? fileType : source ? source.metadata.type : "other";
    if (editing && source && nameUnchanged && chosenType === source.metadata.type) {
      closePresentation();
      setName("");
      return;
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
          const metadata = {
            type: chosenType,
            tags: source.metadata.tags,
          };
          if (nameUnchanged)
            await tauri.writeWorkspaceFileMetadata(owner.workspace, source.handle, metadata);
          else await tauri.renameWorkspaceFile(owner.workspace, source.handle, name, metadata);
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
  return {
    workspace,
    data,
    selected,
    failure,
    mutate,
    chooser: (
      <>
        <Button
          miw={0}
          {...libraryButtonProps}
          disabled={picker.pending}
          onClick={() => void chooseWorkspace()}
        >
          {workspace
            ? t("Files.ChangeCollection", { defaultValue: "Change collection" })
            : t("Files.ChooseCollection", { defaultValue: "Choose collection" })}
        </Button>
      </>
    ),
    creation: (
      <>
        <Button
          miw={0}
          {...libraryButtonProps}
          disabled={!workspace}
          onClick={() => openAction(fileAction.file)}
        >
          {t("Files.CreateFile", { defaultValue: "Create file" })}
        </Button>
        <Button
          miw={0}
          {...libraryButtonProps}
          disabled={!workspace}
          onClick={() => openAction(fileAction.folder)}
          variant="default"
        >
          {t("Files.CreateFolder", { defaultValue: "Create folder" })}
        </Button>
      </>
    ),
    trash: (
      <>
        {uncertainTrashName && (
          <Text size="sm">
            {t("Files.MovedToTrash", {
              defaultValue: "Moved {{name}} to trash.",
              name: uncertainTrashName,
            })}
          </Text>
        )}
        {trashed && (
          <Group wrap="wrap" miw={0}>
            <Text size="sm" miw={0}>
              {t("Files.MovedToTrash", {
                defaultValue: "Moved {{name}} to trash.",
                name: trashed.name,
              })}
            </Text>
            <Button size="xs" {...libraryButtonProps} onClick={() => setRestoreTarget(trashed)}>
              {t("Common.Undo", { defaultValue: "Undo" })}
            </Button>
            <Button
              size="xs"
              {...libraryButtonProps}
              color="danger"
              onClick={() => setPurgeTarget(trashed)}
            >
              {t("Files.DeletePermanently", { defaultValue: "Delete permanently" })}
            </Button>
          </Group>
        )}
      </>
    ),
    trashView:
      workspace &&
      (!!displayedTrash?.items?.length ||
        Number(displayedTrash?.olderCount) > 0 ||
        trashFailure !== "silent") ? (
        // The library's container queries measure the file tree. The trash view sits beside
        // it, so it needs its own query container for the section inset and heading icon.
        <Box mt="md" miw={0} className={libraryClasses.trashContainer}>
          <Stack
            gap="xs"
            miw={0}
            className={`${libraryClasses.section} wrap-anywhere`}
            role="region"
            aria-label={t("Files.Trash", { defaultValue: "Trash" })}
            data-section="trash"
          >
            <Group gap={0} wrap="wrap" align="center" pr="xs">
              <Box flex="1 1 8rem" miw={0}>
                <LibrarySectionHeading
                  count={
                    (displayedTrash?.items?.length ?? 0) + Number(displayedTrash?.olderCount ?? 0)
                  }
                  icon={<Trash2 />}
                >
                  {t("Files.Trash", { defaultValue: "Trash" })}
                </LibrarySectionHeading>
              </Box>
              <Button
                size="xs"
                variant="subtle"
                {...libraryButtonProps}
                color="danger"
                onClick={() => setEmptyTarget(true)}
              >
                {t("Files.EmptyTrash", { defaultValue: "Empty trash" })}
              </Button>
            </Group>
            <Stack gap="xs" miw={0} className={libraryClasses.trashBody}>
              {trashFailure !== "silent" && (
                <Group gap="xs" wrap="wrap">
                  <Text c="danger" role="alert" size="sm">
                    {trashLoadFailureMessage}
                  </Text>
                  <Button
                    size="xs"
                    variant="default"
                    {...libraryButtonProps}
                    onClick={() =>
                      void (olderTrashError ? loadOlderTrash() : mutateTrash().catch(() => {}))
                    }
                  >
                    {t("Common.Retry")}
                  </Button>
                </Group>
              )}
              {(displayedTrash?.items ?? []).map((row) => (
                <div key={row.item} className={libraryClasses.trashRow}>
                  <span className={libraryClasses.trashRowIcon} aria-hidden>
                    <FileText />
                  </span>
                  <Box miw={0} className={libraryClasses.trashRowMain}>
                    <Text size="sm" fw={500}>
                      {row.name}
                    </Text>
                    <Group gap="sm" wrap="wrap" mt={2}>
                      <Text size="xs" c="dimmed">
                        {row.originalFolder ||
                          t("Files.CollectionRoot", { defaultValue: "Collection root" })}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {new Date(Number(row.trashedSeconds) * 1000).toLocaleString(i18n.language)}
                      </Text>
                    </Group>
                    {row.category && (
                      <Text size="sm" c="danger" mt={4}>
                        {childUnreadableMessage(row.category, t)}
                      </Text>
                    )}
                  </Box>
                  <Group wrap="wrap" gap="xs" className={libraryClasses.trashRowActions}>
                    <Button
                      size="xs"
                      variant="default"
                      {...libraryButtonProps}
                      disabled={!!row.category}
                      onClick={() => setRestoreTarget(row)}
                    >
                      {t("Files.Restore", { defaultValue: "Restore" })}
                    </Button>
                    <Button
                      size="xs"
                      variant="subtle"
                      {...libraryButtonProps}
                      color="danger"
                      disabled={!!row.category}
                      onClick={() => setPurgeTarget(row)}
                    >
                      {t("Files.DeletePermanently", { defaultValue: "Delete permanently" })}
                    </Button>
                  </Group>
                </div>
              ))}
              {displayedTrash?.cursor && (
                <Button
                  size="xs"
                  variant="default"
                  {...libraryButtonProps}
                  loading={loadingOlderTrash}
                  disabled={loadingOlderTrash}
                  onClick={() => void loadOlderTrash()}
                >
                  {t("Files.LoadOlderTrash", { defaultValue: "Load older items" })} (
                  {displayedTrash.olderCount})
                </Button>
              )}
            </Stack>
          </Stack>
        </Box>
      ) : null,
    status: (
      <Stack
        gap="xs"
        className="wrap-anywhere"
        role="region"
        aria-label={t("Files.Title")}
        data-library-source="files"
      >
        {!workspace ? (
          <Text c="dimmed">{t("Files.EmptyWorkspace")}</Text>
        ) : failure !== "silent" ? (
          <Text c="danger" role="alert" className="wrap-anywhere">
            {loadFailureMessage}
          </Text>
        ) : !data ? (
          <Text role="status">
            {t("Library.FilesLoading", { defaultValue: "Loading PGN files…" })}
          </Text>
        ) : null}
        {actionError && !moveTarget && (
          <Text c="danger" role="alert">
            {actionError}
          </Text>
        )}
      </Stack>
    ),
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
        if (destination.type !== "unreadable") return moveEntry(entry, destination.handle);
      },
    },
    detail: (
      <>
        {selected?.type === "file" ? (
          <Stack gap="xs" h="100%" miw={0}>
            <Group gap="xs" wrap="wrap" miw={0}>
              <Button
                size="xs"
                {...libraryButtonProps}
                onClick={() => {
                  openAction(fileAction.rename);
                }}
              >
                {t("Files.Rename", { defaultValue: "Rename" })}
              </Button>
              <Button
                size="xs"
                {...libraryButtonProps}
                onClick={() => {
                  openMove(selected);
                }}
              >
                {t("Files.Move", { defaultValue: "Move" })}
              </Button>
              <Button
                size="xs"
                {...libraryButtonProps}
                variant="default"
                color="danger"
                c="var(--cf-foreground)"
                onClick={() => setDeleteTarget(selected)}
              >
                {t("Files.Trash", { defaultValue: "Trash" })}
              </Button>
            </Group>
            {/* The card fills the column down to the window's bottom edge and splits that height
                    between its game list and preview. A fixed height left a wide, short window's list
                    two rows high; the floor keeps a 200% font scale usable, where the page scrolls. */}
            <Box flex={1} mih={FILE_CARD_MIN_HEIGHT}>
              <FileCard
                key={`file:${fileWorkspaceKey(selected.handle)}`}
                selected={selected}
                onEditMetadata={() => {
                  openAction(fileAction.edit);
                }}
              />
            </Box>
          </Stack>
        ) : selected?.type === "directory" ? (
          <Center mih={EMPTY_PANE_MIN_HEIGHT}>
            <Stack align="center" gap="xs" miw={0}>
              <Text fw={600} size="lg" miw={0}>
                {selected.name}
              </Text>
              <Text c="dimmed" size="sm">
                {t("Files.FolderEntryCount", {
                  defaultValue: "Entries: {{number}}",
                  number: formatNumber(selected.children.length),
                })}
              </Text>
            </Stack>
          </Center>
        ) : (
          <Center mih={EMPTY_PANE_MIN_HEIGHT}>
            <Text c="dimmed" ta="center" miw={0} className="wrap-anywhere">
              {t("Files.NoSelection", { defaultValue: "No file selected" })}
            </Text>
          </Center>
        )}
      </>
    ),
    dialogs: (
      <>
        <AppModal
          opened={action !== null}
          fullScreen={compactDialog}
          onClose={closePresentation}
          title={
            action === fileAction.edit
              ? t("Files.EditMetadata")
              : action === fileAction.rename
                ? t("Files.RenameFile", { defaultValue: "Rename file" })
                : action === fileAction.folder
                  ? t("Files.CreateFolder", { defaultValue: "Create folder" })
                  : t("Files.CreateFile", { defaultValue: "Create file" })
          }
        >
          <Stack miw={0}>
            <TextInput
              miw={0}
              ref={actionInputRef}
              autoFocus
              data-autofocus
              label={t("Common.Name", { defaultValue: "Name" })}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              error={actionError}
            />
            {action === fileAction.edit && (
              <Select
                miw={0}
                required
                allowDeselect={false}
                label={t("Files.FileType")}
                value={fileType}
                onChange={(value) => {
                  if (value) setFileType(value as FileType);
                }}
                data={fileTypeOptions}
              />
            )}
            <Button miw={0} {...libraryButtonProps} disabled={submitting} onClick={submitAction}>
              {t("Common.Confirm", { defaultValue: "Confirm" })}
            </Button>
          </Stack>
        </AppModal>
        <AppModal
          opened={moveTarget !== null}
          fullScreen={compactDialog}
          onClose={closePresentation}
          title={t("Files.MoveFile", { defaultValue: "Move file" })}
        >
          <Stack miw={0}>
            <Radio.Group
              miw={0}
              classNames={{ label: "wrap-anywhere" }}
              styles={{ label: { minWidth: 0 } }}
              label={t("Files.DestinationFolder", { defaultValue: "Destination folder" })}
              value={moveTarget ?? ""}
              onChange={(value) => {
                const owner = presentation.current;
                if (!owner || !owns(owner)) return;
                owner.destination = moveDestinations.find(
                  (entry) => fileWorkspaceKey(entry.handle) === value,
                );
                setMoveTarget(value);
              }}
            >
              <Stack miw={0} mt="xs">
                {moveDestinations.map((entry) => (
                  <Radio
                    key={fileWorkspaceKey(entry.handle)}
                    miw={0}
                    value={fileWorkspaceKey(entry.handle)}
                    label={entry.label}
                    classNames={{ label: "wrap-anywhere" }}
                    styles={{ labelWrapper: { minWidth: 0 }, label: { minWidth: 0 } }}
                  />
                ))}
              </Stack>
            </Radio.Group>
            <Button
              miw={0}
              {...libraryButtonProps}
              px="xs"
              disabled={!moveTarget || moving}
              onClick={async () => {
                const owner = presentation.current;
                if (!owner || !owns(owner) || owner.pending) return;
                if (owner.target.kind !== "entry" || !moveTargetHandle) {
                  refuseUnavailable();
                  return;
                }
                await moveEntry(owner.target.entry, moveTargetHandle, owner);
              }}
            >
              {t("Files.Move", { defaultValue: "Move" })}
            </Button>
            {actionError && (
              <Text c="danger" role="alert">
                {actionError}
              </Text>
            )}
          </Stack>
        </AppModal>
        {deleteTarget && (
          <ConfirmModal
            title={t("Files.MoveToTrash", { defaultValue: "Move to trash" })}
            description={t("Files.MoveToTrashConfirm", {
              defaultValue: "Move {{name}} to trash?",
              name: deleteTarget.name,
            })}
            opened
            onClose={() => setDeleteTarget(null)}
            onConfirm={async () => {
              await runTrashMutationWithRefresh(
                async () => {
                  try {
                    const item = await tauri.trashWorkspaceEntry(workspace!, deleteTarget.handle);
                    if (environment.current.workspaceIdentity === workspaceIdentity) {
                      setUncertainTrashName(null);
                      setTrashed({ item, name: deleteTarget.name });
                    }
                  } catch (cause) {
                    if (
                      normalizeError(cause).backendCategory === "durability" &&
                      environment.current.workspaceIdentity === workspaceIdentity
                    ) {
                      setTrashed(null);
                      setUncertainTrashName(deleteTarget.name);
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
            }}
          />
        )}
        {restoreTarget && (
          <ConfirmModal
            title={t("Files.RestoreFile", { defaultValue: "Restore file" })}
            description={t("Files.RestoreConfirm", {
              defaultValue: "Restore {{name}}?",
              name: restoreTarget.name,
            })}
            confirmLabel={t("Files.Restore", { defaultValue: "Restore" })}
            opened
            onClose={() => setRestoreTarget(null)}
            onConfirm={async () => {
              await runTrashMutationWithRefresh(
                () => tauri.restoreWorkspaceTrashItem(workspace!, restoreTarget.item),
                clearTrashAndRelist,
              );
            }}
          />
        )}
        {purgeTarget && (
          <ConfirmModal
            title={t("Files.DeletePermanently", { defaultValue: "Delete permanently" })}
            description={t("Files.DeletePermanentlyConfirm", {
              defaultValue: "Permanently delete {{name}}?",
              name: purgeTarget.name,
            })}
            opened
            onClose={() => setPurgeTarget(null)}
            onConfirm={async () => {
              await runDestructiveWithRefresh(
                () => tauri.deleteWorkspaceTrashItem(workspace!, purgeTarget.item),
                clearTrashAndRelist,
              );
            }}
          />
        )}
        {emptyTarget && (
          <ConfirmModal
            title={t("Files.EmptyTrash", { defaultValue: "Empty trash" })}
            description={t("Files.EmptyTrashConfirm", {
              defaultValue: "Permanently delete every item in this collection's trash?",
            })}
            opened
            onClose={() => setEmptyTarget(false)}
            onConfirm={async () => {
              await runDestructiveWithRefresh(
                () => tauri.emptyWorkspaceTrash(workspace!),
                clearTrashAndRelist,
              );
            }}
          />
        )}
      </>
    ),
  };
}
