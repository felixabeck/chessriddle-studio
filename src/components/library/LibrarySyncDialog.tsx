import type {
  LibrarySyncError,
  LibrarySyncFile,
  LibrarySyncFileStatus,
  LibrarySyncHandle,
  LibrarySyncSnapshot,
  LibrarySyncState,
  LibrarySyncTurnOffMode,
} from "@/bindings";
import AppModal from "@/components/common/AppModal";
import { useScaledMaxWidth } from "@/hooks/useScaledMaxWidth";
import { capabilityKey } from "@/utils/pathCapabilities";
import { Alert, Box, Button, Checkbox, Group, Progress, Radio, Stack, Text } from "@mantine/core";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LibrarySyncBadge, type LibrarySyncBadgeColor } from "./LibrarySyncBadge";
import { libraryButtonProps, libraryDangerButtonProps } from "./presentation";

const COMPACT_DIALOG_WIDTH_EM = 30;

export type LibrarySyncDialogProps = {
  opened: boolean;
  onClose: () => void;
  snapshot: LibrarySyncSnapshot;
  busy: boolean;
  error: LibrarySyncError | null;
  onTurnOn: (deselected: LibrarySyncHandle[]) => Promise<void>;
  onTurnOff: (mode: LibrarySyncTurnOffMode) => Promise<void>;
  onSetFileSelected: (file: LibrarySyncHandle, selected: boolean) => Promise<void>;
  onSyncNow: () => Promise<void>;
};

type FileStatusBadge = {
  label: string;
  color: LibrarySyncBadgeColor;
};

function fileStatusPresentation(status: LibrarySyncFileStatus, t: TFunction): FileStatusBadge {
  switch (status.kind) {
    case "synced":
      return {
        label: t("Library.Sync.File.Synced", { defaultValue: "Synced" }),
        color: "success",
      };
    case "pending":
      return {
        label: t("Library.Sync.File.Pending", { defaultValue: "Waiting" }),
        color: "gray",
      };
    case "uploading":
      return {
        label: t("Library.Sync.File.Uploading", { defaultValue: "Uploading" }),
        color: "gold",
      };
    case "notSelected":
      return {
        label: t("Library.Sync.File.NotSelected", { defaultValue: "Not selected" }),
        color: "gray",
      };
    case "tooLarge":
      return {
        label: t("Library.Sync.File.TooLarge", { defaultValue: "Too large" }),
        color: "warning",
      };
    case "tooManyMoves":
      return {
        label: t("Library.Sync.File.TooManyMoves", { defaultValue: "Too many moves" }),
        color: "warning",
      };
    case "tooManyGames":
      return {
        label: t("Library.Sync.File.TooManyGames", { defaultValue: "Too many games" }),
        color: "warning",
      };
    case "invalidPgn":
      return {
        label:
          status.gameNumber !== null
            ? t("Library.Sync.File.InvalidPgnGame", {
                defaultValue: "Game {{gameNumber}} could not be read",
                gameNumber: status.gameNumber,
              })
            : t("Library.Sync.File.InvalidPgn", { defaultValue: "Could not be read as PGN" }),
        color: "danger",
      };
    case "unsupportedVariant":
      return {
        label: t("Library.Sync.File.UnsupportedVariant", {
          defaultValue: "Variant not supported",
        }),
        color: "warning",
      };
    case "tooComplex":
      return {
        label: t("Library.Sync.File.TooComplex", { defaultValue: "Too complex" }),
        color: "warning",
      };
    case "commentTooLong":
      return {
        label: t("Library.Sync.File.CommentTooLong", { defaultValue: "Comment too long" }),
        color: "warning",
      };
    case "empty":
      return {
        label: t("Library.Sync.File.Empty", { defaultValue: "No games" }),
        color: "warning",
      };
    case "libraryFull":
      return {
        label: t("Library.Sync.File.LibraryFull", { defaultValue: "Library is full" }),
        color: "warning",
      };
    case "storageFull":
      return {
        label: t("Library.Sync.File.StorageFull", { defaultValue: "Storage is full" }),
        color: "warning",
      };
    case "unreadable":
      return {
        label: t("Library.Sync.File.Unreadable", {
          defaultValue: "File could not be read",
        }),
        color: "danger",
      };
    case "rejected":
      return {
        label: t("Library.Sync.File.Rejected", {
          defaultValue: "Not accepted by the website",
        }),
        color: "danger",
      };
  }
}

function stateSummary(
  state: LibrarySyncState,
  t: TFunction,
): { message: string; tone: "neutral" | "success" | "warning" | "danger" } {
  switch (state.status) {
    case "off":
      return { message: "", tone: "neutral" };
    case "otherFolder":
      return {
        message: t("Library.Sync.OtherFolder.Description", {
          defaultValue:
            "Sync is on for another Library folder. Turn off sync there before turning it on for this folder.",
        }),
        tone: "warning",
      };
    case "syncing":
      return {
        message: t("Library.Sync.Status.Syncing", {
          defaultValue: "Syncing {{done}} of {{total}}…",
          done: state.done,
          total: state.total,
        }),
        tone: "neutral",
      };
    case "synced":
      return {
        message: t("Library.Sync.Status.Synced", {
          defaultValue: "All selected files are synced.",
        }),
        tone: "success",
      };
    case "attention":
      return {
        message: t("Library.Sync.Status.Attention", {
          count: state.count,
          defaultValue: "{{count}} files could not be synced.",
        }),
        tone: "warning",
      };
    case "removing":
      return {
        message: t("Library.Sync.Status.Removing", {
          defaultValue: "Removing synced files from ChessRiddle ({{done}} of {{total}})…",
          done: state.done,
          total: state.total,
        }),
        tone: "warning",
      };
    case "offline":
      return {
        message: t("Library.Sync.Status.Offline", {
          defaultValue: "Offline. Sync will continue when ChessRiddle is reachable.",
        }),
        tone: "warning",
      };
    case "serverBusy":
      return {
        message: t("Library.Sync.Status.ServerBusy", {
          defaultValue: "ChessRiddle is busy. Sync will retry automatically.",
        }),
        tone: "warning",
      };
    case "serverError":
      return {
        message: t("Library.Sync.Status.ServerError", {
          defaultValue:
            "ChessRiddle could not complete the request. Sync will retry automatically.",
        }),
        tone: "danger",
      };
    case "signInNeeded":
      return {
        message: t("Library.Sync.Status.SignInNeeded", {
          defaultValue:
            "Your ChessRiddle session expired. Sign in again under Accounts to continue syncing.",
        }),
        tone: "danger",
      };
    case "unavailable":
      return {
        message: t("Library.Sync.Status.Unavailable", {
          defaultValue: "Library sync is not available on ChessRiddle yet.",
        }),
        tone: "warning",
      };
    case "folderUnavailable":
      return {
        message: t("Library.Sync.Status.FolderUnavailable", {
          defaultValue:
            "This Library folder is currently unavailable. No files were removed from ChessRiddle.",
        }),
        tone: "danger",
      };
    case "localError":
      return {
        message: t("Library.Sync.Status.LocalError", {
          defaultValue: "Could not read or save local sync state.",
        }),
        tone: "danger",
      };
  }
}

function commandErrorMessage(error: LibrarySyncError, t: TFunction): string {
  switch (error) {
    case "busy":
      return t("Library.Sync.CommandError.Busy", {
        defaultValue: "Sync is busy. Try again in a moment.",
      });
    case "localStorage":
      return stateSummary({ status: "localError" }, t).message;
    case "invalidWorkspace":
      return stateSummary({ status: "folderUnavailable" }, t).message;
    case "notActive":
      return t("Library.Sync.CommandError.NotActive", {
        defaultValue: "Sync is currently turned off.",
      });
    case "unavailable":
      return stateSummary({ status: "unavailable" }, t).message;
  }
}

function SyncFileList({
  files,
  isChecked,
  onToggle,
  busy,
  showBadge,
  t,
}: {
  files: LibrarySyncFile[];
  isChecked: (file: LibrarySyncFile, key: string) => boolean;
  onToggle: (file: LibrarySyncFile, key: string, checked: boolean) => void;
  busy: boolean;
  showBadge: (status: LibrarySyncFileStatus) => boolean;
  t: TFunction;
}) {
  return (
    <Box mah="18rem" style={{ overflowY: "auto" }}>
      <Stack gap="xs" miw={0}>
        {files.map((file) => {
          const key = capabilityKey(file.handle);
          const badge = showBadge(file.status) ? fileStatusPresentation(file.status, t) : null;
          return (
            <Group key={key} justify="space-between" align="center" gap="xs" wrap="wrap" miw={0}>
              <Checkbox
                miw={0}
                checked={isChecked(file, key)}
                disabled={busy}
                onChange={(event) => onToggle(file, key, event.currentTarget.checked)}
                label={file.name}
                description={file.folderLabel || undefined}
                classNames={{ label: "wrap-anywhere" }}
                styles={{
                  root: { flex: "1 1 12rem", minWidth: 0 },
                  labelWrapper: { minWidth: 0 },
                  label: { minWidth: 0 },
                }}
              />
              {badge && <LibrarySyncBadge color={badge.color}>{badge.label}</LibrarySyncBadge>}
            </Group>
          );
        })}
      </Stack>
    </Box>
  );
}

const showPreCheckBadge = (status: LibrarySyncFileStatus) =>
  status.kind === "tooLarge" || status.kind === "tooManyGames" || status.kind === "unreadable";

const showAllBadges = () => true;

function initialDeselectedKeys(files: LibrarySyncFile[]): Set<string> {
  return new Set(files.filter((file) => !file.selected).map((file) => capabilityKey(file.handle)));
}

export function LibrarySyncDialog({
  opened,
  onClose,
  snapshot,
  busy,
  error,
  onTurnOn,
  onTurnOff,
  onSetFileSelected,
  onSyncNow,
}: LibrarySyncDialogProps) {
  const { t } = useTranslation();
  const compactDialog = useScaledMaxWidth(COMPACT_DIALOG_WIDTH_EM);
  const filesRef = useRef(snapshot.files);
  filesRef.current = snapshot.files;
  const [deselectedKeys, setDeselectedKeys] = useState<Set<string>>(() =>
    initialDeselectedKeys(snapshot.files),
  );
  const [turnOffConfirm, setTurnOffConfirm] = useState(false);
  const [turnOffMode, setTurnOffMode] = useState<LibrarySyncTurnOffMode>("keep");
  const workspaceKey = capabilityKey(snapshot.workspace);
  const status = snapshot.state.status;
  const active = snapshot.active;

  useEffect(() => {
    setDeselectedKeys(initialDeselectedKeys(filesRef.current));
    setTurnOffConfirm(false);
    setTurnOffMode("keep");
  }, [workspaceKey, opened]);

  useEffect(() => {
    if (!active || status === "removing") {
      setTurnOffConfirm(false);
      setTurnOffMode("keep");
    }
    if (active) {
      setDeselectedKeys(new Set());
    } else {
      setDeselectedKeys(initialDeselectedKeys(filesRef.current));
    }
  }, [active, status]);

  const summary = stateSummary(snapshot.state, t);
  const turnOffChoiceSection = (
    <Stack gap="sm" pt="xs">
      <Radio.Group
        miw={0}
        label={t("Library.Sync.TurnOff.Prompt", {
          defaultValue: "What should happen to the synced files on ChessRiddle?",
        })}
        value={turnOffMode}
        onChange={(value) => setTurnOffMode(value as LibrarySyncTurnOffMode)}
      >
        <Stack gap="xs" mt="xs">
          <Radio
            miw={0}
            value="keep"
            disabled={busy}
            label={t("Library.Sync.TurnOff.Keep", {
              defaultValue: "Keep files on ChessRiddle (readable on the website)",
            })}
            classNames={{ label: "wrap-anywhere" }}
            styles={{ labelWrapper: { minWidth: 0 }, label: { minWidth: 0 } }}
          />
          <Radio
            miw={0}
            value="remove"
            disabled={busy}
            label={t("Library.Sync.TurnOff.Remove", {
              defaultValue: "Remove synced files from ChessRiddle",
            })}
            classNames={{ label: "wrap-anywhere" }}
            styles={{ labelWrapper: { minWidth: 0 }, label: { minWidth: 0 } }}
          />
        </Stack>
      </Radio.Group>
      <Group gap="xs" wrap="wrap">
        <Button
          miw={0}
          {...libraryDangerButtonProps}
          loading={busy}
          onClick={() => void onTurnOff(turnOffMode)}
        >
          {t("Library.Sync.TurnOff.Confirm", { defaultValue: "Turn off sync" })}
        </Button>
        <Button
          miw={0}
          variant="subtle"
          disabled={busy}
          onClick={() => {
            setTurnOffConfirm(false);
            setTurnOffMode("keep");
          }}
        >
          {t("Common.Cancel", { defaultValue: "Cancel" })}
        </Button>
      </Group>
    </Stack>
  );

  return (
    <AppModal
      opened={opened}
      onClose={onClose}
      fullScreen={compactDialog}
      size="lg"
      pending={busy}
      className="wrap-anywhere"
      title={t("Library.Sync.Action", { defaultValue: "Sync with ChessRiddle" })}
    >
      <Stack gap="md" miw={0}>
        {error && (
          <Alert color="danger" role="alert" px="sm">
            {commandErrorMessage(error, t)}
          </Alert>
        )}

        {!active ? (
          snapshot.state.status === "folderUnavailable" ? (
            <Alert color="danger" role="status" px="sm">
              {summary.message}
            </Alert>
          ) : (
            <>
              <Stack gap="xs">
                <Text size="sm">
                  {t("Library.Sync.Off.Overview", {
                    defaultValue:
                      "Selected PGN files and game databases in this Library are uploaded to your private Library on ChessRiddle. Only your account can see them, and the website only reads them.",
                  })}
                </Text>
                <Text size="sm" c="dimmed">
                  {t("Library.Sync.Off.Excluded", {
                    defaultValue: "Downloaded game histories are not synced.",
                  })}
                </Text>
                <Text size="sm" c="dimmed">
                  {t("Library.Sync.Off.Limits", {
                    defaultValue:
                      "Limits: up to 100 files, 5 MB, 40,000 moves and 5,000 games per file.",
                  })}
                </Text>
              </Stack>

              {snapshot.files.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t("Library.Sync.EmptyFiles", {
                    defaultValue:
                      "No PGN files or game databases yet. New ones added later will sync automatically when selected by default.",
                  })}
                </Text>
              ) : (
                <SyncFileList
                  files={snapshot.files}
                  isChecked={(_file, key) => !deselectedKeys.has(key)}
                  onToggle={(_file, key, nextChecked) => {
                    setDeselectedKeys((current) => {
                      const next = new Set(current);
                      if (nextChecked) next.delete(key);
                      else next.add(key);
                      return next;
                    });
                  }}
                  busy={busy}
                  showBadge={showPreCheckBadge}
                  t={t}
                />
              )}

              <Group justify="flex-end" gap="xs" wrap="wrap">
                <Button
                  miw={0}
                  {...libraryButtonProps}
                  loading={busy}
                  onClick={() => {
                    const deselected = snapshot.files
                      .filter((file) => deselectedKeys.has(capabilityKey(file.handle)))
                      .map((file) => file.handle);
                    void onTurnOn(deselected);
                  }}
                >
                  {t("Library.Sync.TurnOn", { defaultValue: "Turn on sync" })}
                </Button>
              </Group>
            </>
          )
        ) : snapshot.state.status === "otherFolder" ? (
          <>
            <Alert color="warning" px="sm">
              {summary.message}
            </Alert>
            {turnOffConfirm ? (
              turnOffChoiceSection
            ) : (
              <Group gap="xs" wrap="wrap">
                <Button
                  miw={0}
                  {...libraryDangerButtonProps}
                  disabled={busy}
                  onClick={() => setTurnOffConfirm(true)}
                >
                  {t("Library.Sync.TurnOff", { defaultValue: "Turn off sync" })}
                </Button>
              </Group>
            )}
          </>
        ) : snapshot.state.status === "removing" ? (
          <Stack gap="sm" miw={0}>
            <Text size="sm" role="status">
              {summary.message}
            </Text>
            <Progress
              value={
                snapshot.state.total > 0
                  ? Math.round((snapshot.state.done / snapshot.state.total) * 100)
                  : 0
              }
              aria-label={summary.message}
            />
          </Stack>
        ) : (
          <>
            {summary.tone === "warning" || summary.tone === "danger" ? (
              <Alert color={summary.tone} role="status" px="sm">
                {summary.message}
              </Alert>
            ) : (
              <Text size="sm" role="status" fw={500}>
                {summary.message}
              </Text>
            )}

            {snapshot.files.length > 0 && (
              <SyncFileList
                files={snapshot.files}
                isChecked={(file) => file.selected}
                onToggle={(file, _key, nextChecked) =>
                  void onSetFileSelected(file.handle, nextChecked)
                }
                busy={busy}
                showBadge={showAllBadges}
                t={t}
              />
            )}

            {turnOffConfirm ? (
              turnOffChoiceSection
            ) : (
              <Group justify="space-between" gap="xs" wrap="wrap">
                <Button
                  miw={0}
                  {...libraryDangerButtonProps}
                  disabled={busy}
                  onClick={() => setTurnOffConfirm(true)}
                >
                  {t("Library.Sync.TurnOff", { defaultValue: "Turn off sync" })}
                </Button>
                <Button
                  miw={0}
                  {...libraryButtonProps}
                  loading={busy}
                  onClick={() => void onSyncNow()}
                >
                  {t("Library.Sync.SyncNow", { defaultValue: "Sync now" })}
                </Button>
              </Group>
            )}
          </>
        )}
      </Stack>
    </AppModal>
  );
}

export default LibrarySyncDialog;
