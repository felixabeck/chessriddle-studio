import { tauri } from "@/platform/tauri";
import { Alert, Box, Button, Divider, Group, Paper, ScrollArea, Stack, Text } from "@mantine/core";
import { AlertCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import useSWRImmutable from "swr/immutable";
import { type PuzzleDatabaseInfo } from "@/bindings";
import {
  getDefaultPuzzleDatabases,
  manifestPuzzleDatabaseInstallCard,
  type DownloadablePuzzleDatabase,
} from "@/utils/db";
import { formatBytes, formatNumber } from "@/utils/format";
import { notifyUnlessCancelled, runUnlessCancelled } from "@/components/files/notifyError";
import { cancelDownloadJob, runDownloadJob, useDownloadJob } from "@/hooks/downloadJobs";
import { choosePuzzleDatabase } from "@/utils/puzzles";
import ProgressButton from "../common/ProgressButton";
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
      await choosePuzzleDatabase();
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
              <PuzzleDbCard
                puzzleDb={db}
                key={card.progressId}
                progressId={card.progressId}
                refreshPuzzleDbs={refreshPuzzleDbs}
                initInstalled={card.initInstalled}
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

function PuzzleDbCard({
  refreshPuzzleDbs,
  puzzleDb,
  progressId,
  initInstalled,
}: {
  refreshPuzzleDbs: (signal?: AbortSignal) => Promise<void>;
  puzzleDb: DownloadablePuzzleDatabase;
  progressId: string;
  initInstalled: boolean;
}) {
  const { t } = useTranslation();
  const [inProgress, setInProgress] = useState<boolean>(false);
  const hasJob = useDownloadJob(progressId);

  async function downloadDatabase() {
    setInProgress(true);
    try {
      await runUnlessCancelled(
        t("Common.Error"),
        () =>
          runDownloadJob(progressId, async (ticket) => {
            const destination = await tauri.issuePuzzleDownloadDestination();
            await tauri.downloadFile(
              progressId,
              puzzleDb.downloadLink,
              destination,
              `${puzzleDb.title}.db3`,
              null,
              ticket,
              { sha256: puzzleDb.sha256, signature: puzzleDb.signature },
            );
            await refreshPuzzleDbs();
          }),
        "puzzle",
      );
    } finally {
      setInProgress(false);
    }
  }

  return (
    <Paper withBorder radius="md" p={0} key={puzzleDb.title}>
      <Group wrap="nowrap" gap={0} grow>
        <Box p="md" flex={1}>
          <Text tt="uppercase" c="dimmed" fw={700} size="xs">
            {t("Puzzle.Database")}
          </Text>
          <Text fw="bold" mb="xs">
            {puzzleDb.title}
          </Text>

          <Text size="xs" c="dimmed">
            {puzzleDb.description}
          </Text>
          <Divider />
          <Group wrap="nowrap" grow my="md">
            <Stack gap={0} align="center">
              <Text tt="uppercase" c="dimmed" fw={700} size="xs">
                {t("Common.Size")}
              </Text>
              <Text size="xs">{formatBytes(puzzleDb.storageSize)}</Text>
            </Stack>
            <Stack gap={0} align="center">
              <Text tt="uppercase" c="dimmed" fw={700} size="xs">
                {t("Puzzle.Puzzles")}
              </Text>
              <Text size="xs">{formatNumber(puzzleDb.puzzleCount)}</Text>
            </Stack>
          </Group>
          <ProgressButton
            id={progressId}
            initInstalled={initInstalled}
            labels={{
              completed: t("Common.Installed"),
              action: t("Common.Install"),
              inProgress: t("Common.Downloading"),
              finalizing: t("Common.Extracting"),
            }}
            onClick={() => {
              void downloadDatabase();
            }}
            onCancel={() => cancelDownloadJob(progressId, t("Common.Error"))}
            clearOnCancel={false}
            inProgress={inProgress || hasJob}
            setInProgress={setInProgress}
          />
        </Box>
      </Group>
    </Paper>
  );
}

export default AddPuzzle;
