import { libraryButtonProps } from "@/components/library/presentation";
import { useScaledMaxWidth } from "@/hooks/useScaledMaxWidth";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { Box, Button, Radio, Select, Stack, Text, TextInput } from "@mantine/core";
import { useTranslation } from "react-i18next";
import AppModal from "../common/AppModal";
import ConfirmModal from "../common/ConfirmModal";
import { RepertoireColorControl } from "../tabs/RepertoireColorControl";
import { FILE_TYPES, type FileType } from "./file";
import type { FileWorkspace } from "./useFileWorkspace";

// At 320px/200% the default modal clipped the type Select's "Repertoire";
// below this width the shared create/rename/edit dialog and Move go full-screen.
// The threshold follows the app font scale, measured in scaled root-em.
const COMPACT_DIALOG_WIDTH_EM = 30;

export function FileWorkspaceDialogs({ files }: { files: FileWorkspace }) {
  const { t } = useTranslation();
  const compactDialog = useScaledMaxWidth(COMPACT_DIALOG_WIDTH_EM);
  const fileTypeOptions = FILE_TYPES.map(({ value, translationKey }) => ({
    value,
    label: t(translationKey),
  }));
  const { deleteTarget, restoreTarget, purgeTarget } = files;
  return (
    <>
      <AppModal
        opened={files.action !== null}
        fullScreen={compactDialog}
        onClose={files.closePresentation}
        pending={files.submitting}
        title={
          files.action === "edit"
            ? t("Files.EditMetadata")
            : files.action === "rename"
              ? t("Files.RenameFile", { defaultValue: "Rename file" })
              : files.action === "folder"
                ? t("Files.CreateFolder", { defaultValue: "Create folder" })
                : t("Files.CreateFile", { defaultValue: "Create file" })
        }
      >
        <Stack miw={0}>
          <TextInput
            miw={0}
            ref={files.actionInputRef}
            autoFocus
            data-autofocus
            label={t("Common.Name", { defaultValue: "Name" })}
            value={files.name}
            onChange={(event) => files.setName(event.currentTarget.value)}
            error={files.actionError}
          />
          {files.action === "edit" && (
            <Select
              miw={0}
              required
              allowDeselect={false}
              label={t("Files.FileType")}
              value={files.fileType}
              onChange={(value) => {
                if (value) files.setFileType(value as FileType);
              }}
              data={fileTypeOptions}
            />
          )}
          {files.action === "edit" && files.fileType === "repertoire" && (
            <Box miw={0}>
              <RepertoireColorControl
                value={files.repertoireColor}
                onChange={files.setRepertoireColor}
                disabled={files.submitting}
              />
            </Box>
          )}
          <Button
            miw={0}
            {...libraryButtonProps}
            disabled={files.submitting}
            onClick={files.submitAction}
          >
            {t("Common.Confirm", { defaultValue: "Confirm" })}
          </Button>
        </Stack>
      </AppModal>
      <AppModal
        opened={files.moveTarget !== null}
        fullScreen={compactDialog}
        onClose={files.closePresentation}
        title={t("Files.MoveFile", { defaultValue: "Move file" })}
      >
        <Stack miw={0}>
          <Radio.Group
            miw={0}
            classNames={{ label: "wrap-anywhere" }}
            styles={{ label: { minWidth: 0 } }}
            label={t("Files.DestinationFolder", { defaultValue: "Destination folder" })}
            value={files.moveTarget ?? ""}
            onChange={files.selectMoveDestination}
          >
            <Stack miw={0} mt="xs">
              {files.moveDestinations.map((entry) => (
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
            disabled={!files.moveTarget || files.moving}
            onClick={files.confirmMove}
          >
            {t("Files.Move", { defaultValue: "Move" })}
          </Button>
          {files.actionError && (
            <Text c="danger" role="alert">
              {files.actionError}
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
          onClose={() => files.setDeleteTarget(null)}
          onConfirm={() => files.confirmTrash(deleteTarget)}
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
          onClose={() => files.setRestoreTarget(null)}
          onConfirm={() => files.confirmRestore(restoreTarget)}
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
          onClose={() => files.setPurgeTarget(null)}
          onConfirm={() => files.confirmPurge(purgeTarget)}
        />
      )}
      {files.emptyTarget && (
        <ConfirmModal
          title={t("Files.EmptyTrash", { defaultValue: "Empty trash" })}
          description={t("Files.EmptyTrashConfirm", {
            defaultValue: "Permanently delete every item in this collection's trash?",
          })}
          opened
          onClose={() => files.setEmptyTarget(false)}
          onConfirm={files.confirmEmptyTrash}
        />
      )}
    </>
  );
}
