import { libraryButtonProps, libraryDangerButtonProps } from "@/components/library/presentation";
import { formatNumber } from "@/utils/format";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { Box, Button, Center, Group, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import FileCard from "./FileCard";
import type { FileWorkspace } from "./useFileWorkspace";

const FILE_CARD_MIN_HEIGHT = "32rem";
const EMPTY_PANE_MIN_HEIGHT = "12rem";

export function FileWorkspaceDetail({ files }: { files: FileWorkspace }) {
  const { t } = useTranslation();
  const { selected } = files;
  return (
    <>
      {selected?.type === "file" ? (
        <Stack gap="xs" h="100%" miw={0}>
          <Group gap="xs" wrap="wrap" miw={0}>
            <Button
              size="xs"
              {...libraryButtonProps}
              onClick={() => {
                files.rename();
              }}
            >
              {t("Files.Rename", { defaultValue: "Rename" })}
            </Button>
            <Button
              size="xs"
              {...libraryButtonProps}
              onClick={() => {
                files.requestMove(selected);
              }}
            >
              {t("Files.Move", { defaultValue: "Move" })}
            </Button>
            <Button
              size="xs"
              {...libraryDangerButtonProps}
              onClick={() => files.requestTrash(selected)}
            >
              {t("Files.Trash", { defaultValue: "Trash" })}
            </Button>
          </Group>
          {/* The card fills the column down to the window's bottom edge and splits that height
                  between its game list and preview. A fixed height left a wide, short window's list
                  two rows high; the floor keeps a 200% font scale usable, where the page scrolls. */}
          <Box flex={1} mih={FILE_CARD_MIN_HEIGHT} miw={0} maw="100%">
            <FileCard
              key={`file:${fileWorkspaceKey(selected.handle)}`}
              selected={selected}
              omitNewGame={files.omitNewGame}
              onEditMetadata={() => {
                files.editMetadata();
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
  );
}
