import { Alert, Badge, Button, Group, Paper, Stack, Text, TextInput } from "@mantine/core";
import { useAtomValue, useStore as useJotaiStore } from "jotai";
import { AlertCircle, Pencil, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import AppModal from "@/components/common/AppModal";
import IconAction from "@/components/common/IconAction";
import { warnSafely } from "@/platform/errors";
import { enginesAtom } from "@/state/atoms";
import type { BoardLayoutKind } from "@/state/layoutPresets";
import {
  applyBoardLayoutToKind,
  boardLayoutListAtom,
  boardLayoutsAtom,
  deleteBoardLayout,
  findSavedLayoutByName,
  LAYOUT_NAME_MAX_LENGTH,
  type LayoutMutationError,
  MAX_SAVED_LAYOUTS,
  renameBoardLayout,
  saveBoardLayout,
  type SavedBoardLayout,
} from "@/state/layoutStorage";
import { storageErrorCause } from "@/state/storageError";

export interface BoardLayoutModalProps {
  opened: boolean;
  mode: "save" | "manage";
  kind: BoardLayoutKind;
  onClose: () => void;
}

function reportLayoutMutationError(
  t: ReturnType<typeof useTranslation>["t"],
  reason: LayoutMutationError,
  error?: unknown,
): string {
  switch (reason) {
    case "empty-name":
      return t("Board.Layout.Error.EmptyName");
    case "name-too-long":
      return t("Board.Layout.Error.NameTooLong", { max: LAYOUT_NAME_MAX_LENGTH });
    case "duplicate-name":
      return t("Board.Layout.Error.DuplicateName");
    case "limit-reached":
      return t("Board.Layout.Error.LimitReached", { max: MAX_SAVED_LAYOUTS });
    case "storage": {
      const cause = storageErrorCause(error);
      warnSafely(`Board layout storage write failed: ${cause}`);
      return `${t("Board.Layout.Error.Storage")} ${cause}`;
    }
    case "not-found":
      return t("Board.Layout.Error.Storage");
  }
}

export default function BoardLayoutModal({ opened, mode, kind, onClose }: BoardLayoutModalProps) {
  const { t } = useTranslation();
  const store = useJotaiStore();
  const layoutList = useAtomValue(boardLayoutListAtom);
  const engines = useAtomValue(enginesAtom);

  const [activeMode, setActiveMode] = useState<"save" | "manage">(mode);
  const [name, setName] = useState("");
  const [pendingReplace, setPendingReplace] = useState<SavedBoardLayout | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setActiveMode(mode);
    setName("");
    setPendingReplace(null);
    setRenamingId(null);
    setRenameValue("");
    setConfirmDeleteId(null);
    setError(null);
  }, [mode, opened]);

  const handleSaveSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const result = saveBoardLayout(store, kind, name);
    if (result.ok) {
      onClose();
      return;
    }
    if (result.reason === "duplicate-name") {
      const existing = findSavedLayoutByName(store.get(boardLayoutsAtom), name);
      if (existing) {
        setPendingReplace(existing);
        return;
      }
    }
    setPendingReplace(null);
    setError(reportLayoutMutationError(t, result.reason, result.error));
  };

  const handleConfirmReplace = () => {
    setError(null);
    const result = saveBoardLayout(store, kind, name, { replace: true });
    if (result.ok) {
      onClose();
      return;
    }
    setError(reportLayoutMutationError(t, result.reason, result.error));
  };

  const handleApply = (layoutId: string) => {
    applyBoardLayoutToKind(store, kind, layoutId, engines);
    onClose();
  };

  const startRename = (saved: SavedBoardLayout) => {
    setConfirmDeleteId(null);
    setError(null);
    setRenamingId(saved.id);
    setRenameValue(saved.name);
  };

  const handleRenameSubmit = (event: FormEvent, id: string) => {
    event.preventDefault();
    setError(null);
    const result = renameBoardLayout(store, id, renameValue);
    if (result.ok) {
      setRenamingId(null);
      setRenameValue("");
      return;
    }
    setError(reportLayoutMutationError(t, result.reason, result.error));
  };

  const startDelete = (id: string) => {
    setRenamingId(null);
    setError(null);
    setConfirmDeleteId(id);
  };

  const handleConfirmDelete = (id: string) => {
    setError(null);
    const result = deleteBoardLayout(store, id);
    if (result.ok) {
      setConfirmDeleteId(null);
      return;
    }
    setError(reportLayoutMutationError(t, result.reason, result.error));
  };

  return (
    <AppModal
      opened={opened}
      onClose={onClose}
      title={activeMode === "save" ? t("Board.Layout.SaveTitle") : t("Board.Layout.ManageTitle")}
      size="md"
    >
      {activeMode === "save" ? (
        <form onSubmit={handleSaveSubmit}>
          <Stack gap="sm">
            <TextInput
              label={t("Board.Layout.NameLabel")}
              placeholder={t("Board.Layout.NamePlaceholder")}
              value={name}
              onChange={(event) => {
                setName(event.currentTarget.value);
                setPendingReplace(null);
                setError(null);
              }}
              data-autofocus
            />
            {error && (
              <Alert color="danger" role="alert" icon={<AlertCircle size="1rem" />}>
                {error}
              </Alert>
            )}
            {pendingReplace ? (
              <Paper withBorder variant="inset" p="sm">
                <Stack gap="xs">
                  <Text size="sm">
                    {t("Board.Layout.ReplacePrompt", { name: pendingReplace.name })}
                  </Text>
                  <Group justify="flex-end" gap="xs">
                    <Button
                      type="button"
                      variant="default"
                      size="xs"
                      onClick={() => setPendingReplace(null)}
                    >
                      {t("Common.Cancel")}
                    </Button>
                    <Button type="button" size="xs" onClick={handleConfirmReplace}>
                      {t("Board.Layout.Replace")}
                    </Button>
                  </Group>
                </Stack>
              </Paper>
            ) : (
              <Group justify="flex-end" gap="xs">
                <Button type="button" variant="default" onClick={onClose}>
                  {t("Common.Cancel")}
                </Button>
                <Button type="submit">{t("Common.Save")}</Button>
              </Group>
            )}
          </Stack>
        </form>
      ) : (
        <Stack gap="sm">
          {error && (
            <Alert color="danger" role="alert" icon={<AlertCircle size="1rem" />}>
              {error}
            </Alert>
          )}
          <Stack gap="xs">
            {layoutList.map((entry) => {
              if (entry.kind === "preset") {
                const label = t(entry.preset.nameKey);
                return (
                  <Paper
                    key={entry.preset.id}
                    data-layout-id={entry.preset.id}
                    withBorder
                    variant="inset"
                    px="sm"
                    py="xs"
                  >
                    <Group justify="space-between" wrap="nowrap" gap="xs">
                      <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                        <Text size="sm" fw={500} truncate>
                          {label}
                        </Text>
                        <Badge size="xs" variant="light">
                          {t("Board.Layout.PresetBadge")}
                        </Badge>
                      </Group>
                      <Button
                        size="xs"
                        variant="default"
                        onClick={() => handleApply(entry.preset.id)}
                      >
                        {t("Board.Layout.Apply")}
                      </Button>
                    </Group>
                  </Paper>
                );
              }

              const { saved } = entry;
              if (renamingId === saved.id) {
                return (
                  <Paper key={saved.id} withBorder variant="inset" px="sm" py="xs">
                    <form onSubmit={(event) => handleRenameSubmit(event, saved.id)}>
                      <Group wrap="nowrap" gap="xs">
                        <TextInput
                          aria-label={t("Board.Layout.NameLabel")}
                          size="xs"
                          style={{ flex: 1 }}
                          value={renameValue}
                          onChange={(event) => {
                            setRenameValue(event.currentTarget.value);
                            setError(null);
                          }}
                          data-autofocus
                        />
                        <Button type="submit" size="xs">
                          {t("Common.Save")}
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="default"
                          onClick={() => {
                            setRenamingId(null);
                            setRenameValue("");
                            setError(null);
                          }}
                        >
                          {t("Common.Cancel")}
                        </Button>
                      </Group>
                    </form>
                  </Paper>
                );
              }

              if (confirmDeleteId === saved.id) {
                return (
                  <Paper key={saved.id} withBorder variant="inset" px="sm" py="xs">
                    <Stack gap="xs">
                      <Text size="sm">{t("Board.Layout.DeletePrompt", { name: saved.name })}</Text>
                      <Group justify="flex-end" gap="xs">
                        <Button
                          type="button"
                          size="xs"
                          variant="default"
                          onClick={() => {
                            setConfirmDeleteId(null);
                            setError(null);
                          }}
                        >
                          {t("Common.Cancel")}
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          color="danger"
                          onClick={() => handleConfirmDelete(saved.id)}
                        >
                          {t("Common.Delete")}
                        </Button>
                      </Group>
                    </Stack>
                  </Paper>
                );
              }

              return (
                <Paper
                  key={saved.id}
                  data-layout-id={saved.id}
                  withBorder
                  variant="inset"
                  px="sm"
                  py="xs"
                >
                  <Group justify="space-between" wrap="nowrap" gap="xs">
                    <Text size="sm" fw={500} truncate>
                      {saved.name}
                    </Text>
                    <Group gap={4} wrap="nowrap">
                      <Button size="xs" variant="default" onClick={() => handleApply(saved.id)}>
                        {t("Board.Layout.Apply")}
                      </Button>
                      <IconAction
                        label={t("Files.Rename")}
                        size="sm"
                        variant="subtle"
                        onClick={() => startRename(saved)}
                      >
                        <Pencil size="0.875rem" />
                      </IconAction>
                      <IconAction
                        label={t("Common.Delete")}
                        size="sm"
                        variant="subtle"
                        color="danger"
                        onClick={() => startDelete(saved.id)}
                      >
                        <Trash2 size="0.875rem" />
                      </IconAction>
                    </Group>
                  </Group>
                </Paper>
              );
            })}
          </Stack>
          <Group justify="space-between" gap="xs">
            <Button
              type="button"
              variant="default"
              onClick={() => {
                setActiveMode("save");
                setName("");
                setPendingReplace(null);
                setRenamingId(null);
                setConfirmDeleteId(null);
                setError(null);
              }}
            >
              {t("Board.Layout.SaveAs")}
            </Button>
            <Button type="button" variant="subtle" onClick={onClose}>
              {t("Common.Close")}
            </Button>
          </Group>
        </Stack>
      )}
    </AppModal>
  );
}
