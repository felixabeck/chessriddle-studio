import { Button, Group, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { FolderStatus, FolderSwitchGrant, FolderSwitchMode } from "@/bindings";
import { normalizeError } from "@/platform/errors";
import { tauri } from "@/platform/tauri";
import AppModal from "../common/AppModal";
import {
  folderSwitchFailureMessage,
  getPendingFolderSwitch,
  setPendingFolderSwitch,
  subscribePendingFolderSwitch,
} from "./folderSwitch";

function FolderSwitchModal({
  opened,
  grant,
  displayName,
  itemCount,
  onDone,
}: {
  opened: boolean;
  grant: FolderSwitchGrant | null;
  displayName: string;
  itemCount: number;
  onDone: (status: FolderStatus | null) => void;
}) {
  const { t } = useTranslation();
  const [pendingMode, setPendingMode] = useState<FolderSwitchMode | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const pending = pendingMode !== null;

  async function handleCancel() {
    if (pending) return;
    const currentGrant = grant;
    setErrorMessage(null);
    onDone(null);
    if (currentGrant) {
      try {
        await tauri.cancelFolderSwitch(currentGrant);
      } catch {
        // Best-effort grant cleanup on cancel.
      }
    }
  }

  async function handleApply(mode: FolderSwitchMode) {
    if (pending || !grant) return;
    setPendingMode(mode);
    setErrorMessage(null);
    try {
      const status = await tauri.applyFolderSwitch(grant, mode);
      if (mode === "move") {
        if (status.rootFailure === "interrupted-move") {
          notifications.show({
            color: "danger",
            title: t("Common.Error"),
            message: folderSwitchFailureMessage({ reason: "interrupted-move" }, t),
          });
        } else {
          notifications.show({
            color: "success",
            title: t("Settings.Directories.MoveSuccessTitle"),
            message: t("Settings.Directories.MoveSuccessMessage", {
              folder: status.displayName,
            }),
          });
        }
      }
      onDone(status);
    } catch (error) {
      const normalized = normalizeError(error);
      const message = normalized.folderSwitch
        ? folderSwitchFailureMessage(normalized.folderSwitch, t)
        : normalized.message;
      setErrorMessage(message);
    } finally {
      setPendingMode(null);
    }
  }

  return (
    <AppModal
      withCloseButton={false}
      opened={opened}
      onClose={() => void handleCancel()}
      pending={pending}
      title={t("Settings.Directories.SwitchDialog.Title")}
    >
      <Stack>
        <Text>
          {t("Settings.Directories.SwitchDialog.Body", {
            count: itemCount,
            folder: displayName,
          })}
        </Text>
        {errorMessage && (
          <Text c="danger" role="alert">
            {errorMessage}
          </Text>
        )}
        <Group justify="right">
          <Button variant="default" onClick={() => void handleCancel()} disabled={pending}>
            {t("Common.Cancel")}
          </Button>
          <Button
            variant="default"
            onClick={() => void handleApply("useOnly")}
            loading={pendingMode === "useOnly"}
            disabled={pending && pendingMode !== "useOnly"}
          >
            {t("Settings.Directories.SwitchDialog.UseOnly")}
          </Button>
          <Button
            onClick={() => void handleApply("move")}
            loading={pendingMode === "move"}
            disabled={pending && pendingMode !== "move"}
          >
            {t("Settings.Directories.SwitchDialog.Move")}
          </Button>
        </Group>
      </Stack>
    </AppModal>
  );
}

export function FolderSwitchDialogHost() {
  const pending = useSyncExternalStore(
    subscribePendingFolderSwitch,
    getPendingFolderSwitch,
    getPendingFolderSwitch,
  );

  return (
    <FolderSwitchModal
      opened={pending !== null}
      grant={pending?.grant ?? null}
      displayName={pending?.displayName ?? ""}
      itemCount={pending?.itemCount ?? 0}
      onDone={(status) => {
        const resolve = pending?.resolve;
        setPendingFolderSwitch(null);
        resolve?.(status);
      }}
    />
  );
}
