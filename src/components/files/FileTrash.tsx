import {
  libraryButtonProps,
  libraryDangerButtonProps,
  LibrarySectionHeading,
  libraryClasses,
} from "@/components/library/presentation";
import { Box, Button, Group, Stack, Text } from "@mantine/core";
import { FileText, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { childUnreadableMessage } from "./DirectoryTree";
import type { FileWorkspace } from "./useFileWorkspace";

export function FileTrashNotice({ files }: { files: FileWorkspace }) {
  const { t } = useTranslation();
  const { uncertainTrashName, trashed } = files;
  return (
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
          <Button size="xs" {...libraryButtonProps} onClick={() => files.setRestoreTarget(trashed)}>
            {t("Common.Undo", { defaultValue: "Undo" })}
          </Button>
          <Button
            size="xs"
            {...libraryDangerButtonProps}
            onClick={() => files.setPurgeTarget(trashed)}
          >
            {t("Files.DeletePermanently", { defaultValue: "Delete permanently" })}
          </Button>
        </Group>
      )}
    </>
  );
}

export function FileTrashView({ files }: { files: FileWorkspace }) {
  const { t, i18n } = useTranslation();
  const { displayedTrash } = files;
  if (
    !(
      files.workspace &&
      (!!displayedTrash?.items?.length ||
        Number(displayedTrash?.olderCount) > 0 ||
        files.trashFailure !== "silent")
    )
  )
    return null;

  return (
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
              count={(displayedTrash?.items?.length ?? 0) + Number(displayedTrash?.olderCount ?? 0)}
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
            onClick={() => files.setEmptyTarget(true)}
          >
            {t("Files.EmptyTrash", { defaultValue: "Empty trash" })}
          </Button>
        </Group>
        <Stack gap="xs" miw={0} className={libraryClasses.trashBody}>
          {files.trashFailure !== "silent" && (
            <Group gap="xs" wrap="wrap">
              <Text c="danger" role="alert" size="sm">
                {files.trashLoadFailureMessage}
              </Text>
              <Button
                size="xs"
                variant="default"
                {...libraryButtonProps}
                onClick={() => void files.retryTrash()}
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
                  onClick={() => files.setRestoreTarget(row)}
                >
                  {t("Files.Restore", { defaultValue: "Restore" })}
                </Button>
                <Button
                  size="xs"
                  variant="subtle"
                  {...libraryButtonProps}
                  color="danger"
                  disabled={!!row.category}
                  onClick={() => files.setPurgeTarget(row)}
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
              loading={files.loadingOlderTrash}
              disabled={files.loadingOlderTrash}
              onClick={() => void files.loadOlderTrash()}
            >
              {t("Files.LoadOlderTrash", { defaultValue: "Load older items" })} (
              {displayedTrash.olderCount})
            </Button>
          )}
        </Stack>
      </Stack>
    </Box>
  );
}
