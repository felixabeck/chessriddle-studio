import { libraryButtonProps } from "@/components/library/presentation";
import { Button, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { FileWorkspace } from "./useFileWorkspace";

export function FileWorkspaceCreation({ files }: { files: FileWorkspace }) {
  const { t } = useTranslation();
  return (
    <>
      <Button
        miw={0}
        {...libraryButtonProps}
        disabled={!files.workspace}
        onClick={() => files.createFile()}
      >
        {t("Files.CreateFile", { defaultValue: "Create file" })}
      </Button>
      <Button
        miw={0}
        {...libraryButtonProps}
        disabled={!files.workspace}
        onClick={() => files.createFolder()}
        variant="default"
      >
        {t("Files.CreateFolder", { defaultValue: "Create folder" })}
      </Button>
    </>
  );
}

export function FileWorkspaceStatus({ files }: { files: FileWorkspace }) {
  const { t } = useTranslation();
  return (
    <Stack
      gap="xs"
      className="wrap-anywhere"
      role="region"
      aria-label={t("Files.Title")}
      data-library-source="files"
    >
      {!files.workspace ? (
        <Text c="dimmed">{t("Files.EmptyWorkspace")}</Text>
      ) : files.failure !== "silent" ? (
        <Text c="danger" role="alert" className="wrap-anywhere">
          {files.loadFailureMessage}
        </Text>
      ) : !files.data ? (
        <Text role="status">
          {t("Library.FilesLoading", { defaultValue: "Loading PGN files…" })}
        </Text>
      ) : null}
      {/* The folder is otherwise changed in Settings; here it is offered only as the way out. */}
      {(!files.workspace || files.failure !== "silent") && (
        <Button
          miw={0}
          {...libraryButtonProps}
          style={{ alignSelf: "flex-start" }}
          disabled={files.pickerPending}
          onClick={() => void files.chooseWorkspace()}
        >
          {t("Files.ChooseFolder", { defaultValue: "Choose folder" })}
        </Button>
      )}
      {files.actionError && !files.moveTarget && (
        <Text c="danger" role="alert">
          {files.actionError}
        </Text>
      )}
    </Stack>
  );
}
