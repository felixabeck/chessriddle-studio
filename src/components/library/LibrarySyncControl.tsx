import type { FileWorkspaceHandle, LibrarySyncError, LibrarySyncState } from "@/bindings";
import { Button, Group } from "@mantine/core";
import type { TFunction } from "i18next";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LibrarySyncBadge, type LibrarySyncBadgeColor } from "./LibrarySyncBadge";
import { libraryButtonProps } from "./presentation";
import { useLibrarySync } from "./useLibrarySync";

const LibrarySyncDialog = lazy(() => import("./LibrarySyncDialog"));

type BadgePresentation = {
  label: string;
  color: LibrarySyncBadgeColor;
};

function effectiveButtonState(
  state: LibrarySyncState,
  error: LibrarySyncError | null,
): LibrarySyncState {
  if (!error) return state;
  if (error === "localStorage") return { status: "localError" };
  if (error === "invalidWorkspace") return { status: "folderUnavailable" };
  if (error === "unavailable") return { status: "unavailable" };
  return state;
}

function librarySyncBadge(state: LibrarySyncState, t: TFunction): BadgePresentation {
  switch (state.status) {
    case "off":
      return {
        label: t("Library.Sync.Badge.Off", { defaultValue: "Off" }),
        color: "gray",
      };
    case "otherFolder":
      return {
        label: t("Library.Sync.Badge.OtherFolder", { defaultValue: "Other folder" }),
        color: "warning",
      };
    case "syncing":
      return {
        label: t("Library.Sync.Badge.Syncing", {
          defaultValue: "{{done}} of {{total}}",
          done: state.done,
          total: state.total,
        }),
        color: "gold",
      };
    case "synced":
      return {
        label: t("Library.Sync.Badge.Synced", { defaultValue: "Synced" }),
        color: "success",
      };
    case "attention":
      return {
        label: t("Library.Sync.Badge.Attention", {
          count: state.count,
          defaultValue: "{{count}} files not synced",
        }),
        color: "warning",
      };
    case "removing":
      return {
        label: t("Library.Sync.Badge.Removing", {
          defaultValue: "Removing {{done}} of {{total}}",
          done: state.done,
          total: state.total,
        }),
        color: "warning",
      };
    case "offline":
      return {
        label: t("Library.Sync.Badge.Offline", { defaultValue: "Offline" }),
        color: "warning",
      };
    case "serverBusy":
      return {
        label: t("Library.Sync.Badge.ServerBusy", { defaultValue: "Server busy" }),
        color: "warning",
      };
    case "serverError":
      return {
        label: t("Library.Sync.Badge.ServerError", { defaultValue: "Sync error" }),
        color: "danger",
      };
    case "signInNeeded":
      return {
        label: t("Library.Sync.Badge.SignInNeeded", { defaultValue: "Sign in again" }),
        color: "danger",
      };
    case "unavailable":
      return {
        label: t("Library.Sync.Badge.Unavailable", { defaultValue: "Not available yet" }),
        color: "gray",
      };
    case "folderUnavailable":
      return {
        label: t("Library.Sync.Badge.FolderUnavailable", {
          defaultValue: "Folder unavailable",
        }),
        color: "danger",
      };
    case "localError":
      return {
        label: t("Library.Sync.Badge.LocalError", { defaultValue: "Local error" }),
        color: "danger",
      };
  }
}

export function LibrarySyncControl({ workspace }: { workspace: FileWorkspaceHandle | null }) {
  const { t } = useTranslation();
  const sync = useLibrarySync(workspace);
  const [opened, setOpened] = useState(false);

  const available = Boolean(workspace && sync.snapshot?.available);
  const handleClose = useCallback(() => setOpened(false), []);

  useEffect(() => {
    if (!available) setOpened(false);
  }, [available]);

  if (!available || !sync.snapshot) return null;

  const badge = librarySyncBadge(effectiveButtonState(sync.snapshot.state, sync.error), t);

  return (
    <>
      <Button miw={0} variant="default" {...libraryButtonProps} onClick={() => setOpened(true)}>
        <Group component="span" gap="xs" align="center" wrap="wrap" miw={0}>
          <span>{t("Library.Sync.Action", { defaultValue: "Sync with ChessRiddle" })}</span>
          <LibrarySyncBadge component="span" color={badge.color}>
            {badge.label}
          </LibrarySyncBadge>
        </Group>
      </Button>
      {opened && (
        <Suspense fallback={null}>
          <LibrarySyncDialog
            opened={opened}
            onClose={handleClose}
            snapshot={sync.snapshot}
            busy={sync.busy}
            error={sync.error}
            onTurnOn={sync.turnOn}
            onTurnOff={sync.turnOff}
            onSetFileSelected={sync.setFileSelected}
            onSyncNow={sync.syncNow}
          />
        </Suspense>
      )}
    </>
  );
}
