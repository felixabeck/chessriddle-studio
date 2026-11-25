import { tauri } from "@/platform/tauri";
import { Box, Divider, Group, Paper, Stack, Text } from "@mantine/core";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PathRef } from "@/bindings";
import { runUnlessCancelled } from "@/components/files/notifyError";
import type { RootFailureDomain } from "@/components/files/listingFailure";
import { cancelDownloadJob, runDownloadJob, useDownloadJob } from "@/hooks/downloadJobs";
import ProgressButton from "./ProgressButton";

export interface CatalogDownloadItem {
  title: string;
  description: string;
  downloadLink: string;
  sha256: string;
  signature: string;
}

/**
 * One signed-catalog entry with its install button. The card owns the download
 * job: it resolves the destination inside the job, downloads `leaf` there with
 * the catalog digest, and runs `onInstalled` before the job settles.
 */
export default function CatalogDownloadCard({
  item,
  kindLabel,
  stats,
  credit,
  progressId,
  initInstalled,
  resolveDestination,
  leaf,
  onInstalled,
  errorDomain,
}: {
  item: CatalogDownloadItem;
  kindLabel: string;
  stats: readonly { label: string; value: string }[];
  /** Attribution the source's licence requires, shown under the description. */
  credit?: ReactNode;
  progressId: string;
  initInstalled: boolean;
  resolveDestination: () => Promise<PathRef>;
  leaf: string;
  onInstalled: () => Promise<unknown>;
  errorDomain: RootFailureDomain;
}) {
  const { t } = useTranslation();
  const [inProgress, setInProgress] = useState<boolean>(false);
  const hasJob = useDownloadJob(progressId);

  async function download() {
    setInProgress(true);
    try {
      await runUnlessCancelled(
        t("Common.Error"),
        () =>
          runDownloadJob(progressId, async (ticket) => {
            const destination = await resolveDestination();
            await tauri.downloadFile(
              progressId,
              item.downloadLink,
              destination,
              leaf,
              null,
              ticket,
              {
                sha256: item.sha256,
                signature: item.signature,
              },
            );
            await onInstalled();
          }),
        errorDomain,
      );
    } finally {
      setInProgress(false);
    }
  }

  return (
    <Paper withBorder radius="md" p={0}>
      <Group wrap="nowrap" gap={0} grow>
        <Box p="md" flex={1}>
          <Text tt="uppercase" c="dimmed" fw={700} size="xs">
            {kindLabel}
          </Text>
          <Text fw="bold" mb="xs">
            {item.title}
          </Text>

          <Text size="xs" c="dimmed">
            {item.description}
          </Text>
          {credit && <Box mb="xs">{credit}</Box>}
          <Divider />
          <Group wrap="nowrap" grow my="md">
            {stats.map((stat) => (
              <Stack key={stat.label} gap={0} align="center">
                <Text tt="uppercase" c="dimmed" fw={700} size="xs">
                  {stat.label}
                </Text>
                <Text size="xs">{stat.value}</Text>
              </Stack>
            ))}
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
              void download();
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
