import { Button, Group, Paper, Stack, Text } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { FileMetadata } from "@/components/files/file";
import type { TreeStore } from "@/state/store/tree";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { type RepertoireColor, repertoireFileColor } from "@/components/files/repertoireColor";

/**
 * Tells the player that the open repertoire chapter has no color and therefore trains as White,
 * and lets them set it. Hidden when the chapter has a color, when the tab is not a chapter of a
 * repertoire file, and when the file's colored chapters are all White, since White is then
 * already right.
 */
export function ChapterColorNotice({
  store,
  file,
}: {
  store: TreeStore;
  file: FileMetadata | undefined;
}) {
  const { t } = useTranslation();
  const orientation = useStore(store, (s) => s.headers.orientation);
  const setHeaders = useStore(store, (s) => s.setHeaders);
  const isRepertoire = file?.metadata.type === "repertoire";
  // The lookup follows the file's identity, not the object, which a tab update may replace.
  const fileKey = file && isRepertoire ? fileWorkspaceKey(file.handle) : null;
  const fileRef = useRef(file);
  fileRef.current = file;
  // `undefined` while the file's color is still being read.
  const [fileColor, setFileColor] = useState<RepertoireColor | null | undefined>(undefined);

  useEffect(() => {
    const target = fileRef.current;
    if (fileKey === null || !target || orientation) return;
    let current = true;
    setFileColor(undefined);
    void repertoireFileColor(target).then(
      (color) => current && setFileColor(color),
      () => current && setFileColor(null),
    );
    return () => {
      current = false;
    };
  }, [fileKey, orientation]);

  if (!isRepertoire || orientation || fileColor === undefined || fileColor === "white") {
    return null;
  }
  const choose = (color: RepertoireColor) =>
    setHeaders({ ...store.getState().headers, orientation: color });

  return (
    <Paper p="sm" my="sm" withBorder data-chapter-color-notice="">
      <Stack gap="xs">
        <Text fz="xs" c="dimmed">
          {t("Repertoire.Color.ChapterMissing")}
        </Text>
        <Group gap="xs" grow>
          <Button size="xs" variant="light" onClick={() => choose("white")}>
            {t("Repertoire.Color.TrainAsWhite")}
          </Button>
          <Button size="xs" variant="light" onClick={() => choose("black")}>
            {t("Repertoire.Color.TrainAsBlack")}
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
