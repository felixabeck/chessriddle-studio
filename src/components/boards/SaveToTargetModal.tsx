import { Alert, Button, Group, Loader, Select, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useAtomValue } from "jotai";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { StoreApi } from "zustand";
import AppModal from "@/components/common/AppModal";
import { wrappingButton } from "@/components/common/wrappingButton";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { listingFailure, rootFailureMessage } from "@/components/files/listingFailure";
import { databaseLoadFailureMessage } from "@/components/databases/databaseLoadFailure";
import type { FileMetadata } from "@/components/files/file";
import { joinLibraryCollections } from "@/components/library/libraryData";
import { LibraryTypeBadge } from "@/components/library/presentation";
import { useWorkspaceListing } from "@/components/library/useWorkspaceListing";
import { useDatabaseList } from "@/hooks/useDatabaseList";
import { useSingleFlight } from "@/hooks/useSingleFlight";
import { fileWorkspaceAtom } from "@/state/atoms";
import type { TreeStoreState } from "@/state/store/tree";
import { databaseHandleKey, type SuccessDatabaseInfo } from "@/utils/db";
import { capitalize } from "@/utils/format";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import {
  isCurrentOriginDestination,
  saveToDatabase,
  saveToFile,
  saveToLibraryFile,
  useTabActions,
  type SaveDestination,
  type Tab,
} from "@/utils/tabs";

const FILE_PREFIX = "file:";
const DATABASE_PREFIX = "database:";

function fileValue(file: FileMetadata) {
  return `${FILE_PREFIX}${fileWorkspaceKey(file.handle)}`;
}

function databaseValue(database: SuccessDatabaseInfo) {
  return `${DATABASE_PREFIX}${databaseHandleKey(database.file)}`;
}

export default function SaveToTargetModal({
  opened,
  onClose,
  tab,
  store,
}: {
  opened: boolean;
  onClose: () => void;
  tab: Tab | undefined;
  store: StoreApi<TreeStoreState>;
}) {
  const { t } = useTranslation();
  const workspace = useAtomValue(fileWorkspaceAtom);
  const filesListing = useWorkspaceListing(opened ? workspace : null);
  const databasesListing = useDatabaseList(opened);
  const filesFailure = listingFailure(filesListing.error);
  const databasesFailure = listingFailure(databasesListing.error);
  const { getTab, updateTab } = useTabActions();
  const [selected, setSelected] = useState<string | null>(null);
  const { pending, run, isMounted } = useSingleFlight();
  const fileTargets = useMemo(() => {
    if (!workspace || filesFailure !== "silent") return [];
    const { files } = joinLibraryCollections(
      filesListing.data ?? [],
      databasesListing.data?.collections ?? [],
    );
    return files.filter((file) => !file.readError);
  }, [workspace, filesFailure, filesListing.data, databasesListing.data?.collections]);
  const fileKeys = useMemo(
    () => new Set(fileTargets.map((file) => fileWorkspaceKey(file.handle))),
    [fileTargets],
  );
  const databaseTargets = useMemo(() => {
    if (databasesFailure !== "silent") return [];
    return (databasesListing.data?.databases ?? []).filter(
      (item): item is SuccessDatabaseInfo =>
        item.type === "success" &&
        (!item.collection || item.collection.status === "ready") &&
        !(item.collection && fileKeys.has(fileWorkspaceKey(item.collection.file))),
    );
  }, [databasesFailure, databasesListing.data?.databases, fileKeys]);
  const filesByValue = useMemo(
    () => new Map(fileTargets.map((file) => [fileValue(file), file])),
    [fileTargets],
  );
  const databasesByValue = useMemo(
    () => new Map(databaseTargets.map((item) => [databaseValue(item), item])),
    [databaseTargets],
  );
  const selectedFile = selected ? (filesByValue.get(selected) ?? null) : null;
  const selectedDatabase = selected ? (databasesByValue.get(selected) ?? null) : null;
  const selectedDestination: SaveDestination | null = selectedFile
    ? { kind: "file", file: selectedFile.handle }
    : selectedDatabase
      ? selectedDatabase.collection?.status === "ready"
        ? { kind: "file", file: selectedDatabase.collection.file }
        : { kind: "database", database: selectedDatabase.file }
      : null;
  const isCurrentOrigin =
    selectedDestination !== null && isCurrentOriginDestination(tab, selectedDestination);
  const filesListingFailed = !!workspace && filesFailure !== "silent";
  const databasesListingFailed = databasesFailure !== "silent";
  const filesReady = !!workspace && filesFailure === "silent" && !filesListing.isLoading;
  const databasesReady = databasesFailure === "silent" && !databasesListing.isLoading;
  const noTargets =
    filesReady && databasesReady && fileTargets.length === 0 && databaseTargets.length === 0;
  const selectDisabled = pending || ((!workspace || filesListingFailed) && databasesListingFailed);
  const saveDisabled =
    pending ||
    (selectedFile ? filesListingFailed : selectedDatabase ? databasesListingFailed : true);
  const selectData = [
    ...(fileTargets.length > 0
      ? [
          {
            group: t("Files.Title", { defaultValue: "Files" }),
            items: fileTargets.map((file) => ({
              value: fileValue(file),
              label: file.name,
            })),
          },
        ]
      : []),
    ...(databaseTargets.length > 0
      ? [
          {
            group: t("Board.Database.Databases", { defaultValue: "Databases" }),
            items: databaseTargets.map((item) => ({
              value: databaseValue(item),
              label: item.title,
            })),
          },
        ]
      : []),
  ];
  async function submit() {
    const file = selectedFile;
    const database = selectedDatabase;
    const destination = selectedDestination;
    if (!destination || (file ? filesListingFailed : database ? databasesListingFailed : true))
      return;
    await run(async () => {
      try {
        const result = isCurrentOriginDestination(tab, destination)
          ? await saveToFile({ tab, store, getTab, updateTab, isUserSave: true })
          : file
            ? await saveToLibraryFile({ tab, store, file, getTab, updateTab })
            : await saveToDatabase({ tab, store, database: database!.file, getTab, updateTab });
        if (typeof result === "object") {
          if (isMounted()) notifyUnlessCancelled(t("Common.Error"), result.error);
        } else if (result === "saved") {
          notifications.show({
            message: t("Board.SavedTo", { target: file ? file.name : database!.title }),
          });
          if (!isMounted()) return;
          onClose();
          const refresh = file ? filesListing.mutate : databasesListing.mutate;
          void refresh().catch((error) => {
            if (isMounted()) notifyUnlessCancelled(t("Common.Error"), error);
          });
        } else if (result === "conflict") {
          if (isMounted()) onClose();
        } else if (result === "superseded" && isMounted())
          notifyUnlessCancelled(t("Common.Error"), {
            category: "validation",
            message: t("Tab.SaveSuperseded"),
          });
      } catch (error) {
        if (isMounted()) notifyUnlessCancelled(t("Common.Error"), error);
      }
    });
  }
  return (
    <AppModal opened={opened} onClose={onClose} pending={pending} title={t("Board.Database.Save")}>
      <Stack>
        {(filesListing.isLoading || databasesListing.isLoading) && <Loader size="sm" />}
        {filesListingFailed && (
          <Alert color="danger">
            {rootFailureMessage("files", filesListing.error, t) ??
              t("Files.LoadFailed", {
                defaultValue: "Files could not be loaded. Please try again.",
              })}
          </Alert>
        )}
        {databasesListingFailed && (
          <Alert color="danger">{databaseLoadFailureMessage(databasesListing.error, t)}</Alert>
        )}
        <Select
          label={t("Board.Database.Target")}
          value={selectedFile || selectedDatabase ? selected : null}
          onChange={setSelected}
          disabled={selectDisabled}
          data={selectData}
          nothingFoundMessage={t("Board.Database.NoTargets")}
          searchable
          renderOption={({ option }) => {
            const file = filesByValue.get(option.value);
            if (!file) return option.label;
            return (
              <Group gap="xs" wrap="nowrap" justify="space-between" maw="100%" miw={0}>
                <Text size="sm" truncate="end" miw={0}>
                  {option.label}
                </Text>
                <LibraryTypeBadge>
                  {t(`Files.FileType.${capitalize(file.metadata.type)}`)}
                </LibraryTypeBadge>
              </Group>
            );
          }}
        />
        {isCurrentOrigin && (
          <Text size="sm" c="dimmed">
            {t("Board.Database.UpdateThisGameHint")}
          </Text>
        )}
        {noTargets && <Alert>{t("Board.Database.NoTargets")}</Alert>}
        <Group justify="end">
          <Button styles={wrappingButton} variant="default" disabled={pending} onClick={onClose}>
            {t("Common.Cancel")}
          </Button>
          <Button
            styles={wrappingButton}
            disabled={saveDisabled}
            loading={pending}
            onClick={() => void submit()}
          >
            {t(isCurrentOrigin ? "Board.Database.UpdateThisGame" : "Common.Save")}
          </Button>
        </Group>
      </Stack>
    </AppModal>
  );
}
