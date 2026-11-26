import { tauri } from "@/platform/tauri";
import { Alert, Button, ScrollArea, Stack } from "@mantine/core";
import { AlertCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import useSWRImmutable from "swr/immutable";
import type { PuzzleDatabaseInfo } from "@/bindings";
import {
  catalogPuzzleFilename,
  getDefaultPuzzleDatabases,
  manifestPuzzleDatabaseInstallCard,
} from "@/utils/db";
import { formatBytes, formatNumber } from "@/utils/format";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { choosePuzzleDatabase } from "@/utils/puzzles";
import CatalogDownloadCard from "../common/CatalogDownloadCard";
import { CatalogVerificationError } from "@/utils/signedCatalog";
import AppModal from "../common/AppModal";

function AddPuzzle({
  puzzleDbs,
  opened,
  setOpened,
  refreshPuzzleDbs,
  onWorkspaceChanged,
}: {
  puzzleDbs: PuzzleDatabaseInfo[];
  opened: boolean;
  setOpened: (opened: boolean) => void;
  refreshPuzzleDbs: (signal?: AbortSignal) => Promise<void>;
  onWorkspaceChanged: () => void;
}) {
  const { t } = useTranslation();
  const previewRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!opened) previewRequest.current?.abort();
    return () => previewRequest.current?.abort();
  }, [opened]);
  const { data: dbs, error } = useSWRImmutable(
    "default_puzzle_databases",
    getDefaultPuzzleDatabases,
  );
  async function chooseLocalWorkspace() {
    previewRequest.current?.abort();
    const controller = new AbortController();
    previewRequest.current = controller;
    try {
      const result = await choosePuzzleDatabase();
      if (!result.switched) return;
      onWorkspaceChanged();
      if (controller.signal.aborted) return;
      await refreshPuzzleDbs(controller.signal);
      if (controller.signal.aborted || previewRequest.current !== controller) return;
      setOpened(false);
    } catch (error) {
      if (!controller.signal.aborted) notifyUnlessCancelled(t("Common.Error"), error, "puzzle");
    }
  }

  return (
    <AppModal
      opened={opened}
      onClose={() => {
        previewRequest.current?.abort();
        setOpened(false);
      }}
      title={t("Databases.Add.Title")}
    >
      <ScrollArea.Autosize mah={500} offsetScrollbars>
        <Stack>
          <Button variant="default" onClick={() => void chooseLocalWorkspace()}>
            {t("Puzzle.ChooseLocalFolder")}
          </Button>
          {dbs?.map((db) => {
            const card = manifestPuzzleDatabaseInstallCard(puzzleDbs, db);
            return (
              <CatalogDownloadCard
                item={db}
                key={card.progressId}
                kindLabel={t("Puzzle.Database")}
                stats={[
                  { label: t("Common.Size"), value: formatBytes(db.storageSize) },
                  { label: t("Puzzle.Puzzles"), value: formatNumber(db.puzzleCount) },
                ]}
                progressId={card.progressId}
                initInstalled={card.initInstalled}
                resolveDestination={() => tauri.issuePuzzleDownloadDestination()}
                leaf={catalogPuzzleFilename(db.title)}
                onInstalled={() => refreshPuzzleDbs()}
                errorDomain="puzzle"
              />
            );
          })}
          {error && (
            <Alert icon={<AlertCircle size="1rem" />} title={t("Common.Error")} color="danger">
              {t(
                error instanceof CatalogVerificationError
                  ? "Databases.Add.ErrorCatalog"
                  : "Databases.Add.ErrorFetch",
              )}
            </Alert>
          )}
        </Stack>
      </ScrollArea.Autosize>
    </AppModal>
  );
}

export default AddPuzzle;
