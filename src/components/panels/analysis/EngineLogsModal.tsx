import { useOwnerTabId } from "@/state/tabScope";
import { tauri } from "@/platform/tauri";
import { Box, Stack, Text } from "@mantine/core";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import AppModal from "@/components/common/AppModal";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { engineTerminalFamily, engineRetryFamily, tabEngineSettingsFamily } from "@/state/atoms";
import type { LocalEngine } from "@/utils/engines";
import { engineLineContext } from "./analysisLineContext";
import { engineTerminalLogs } from "./engineFailure";
import { matchingEngineTerminal } from "./engineLines";
import EngineLogsView from "../../common/EngineLogsView";

/**
 * Raw engine traffic is a diagnostic, not part of everyday analysis, so it lives behind the
 * engine card's Logs buttons instead of a permanent panel tab. The body mounts only while open,
 * so a closed dialog never fetches.
 */
export default function EngineLogsModal({
  engine,
  opened,
  onClose,
}: {
  engine: LocalEngine;
  opened: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AppModal
      opened={opened}
      onClose={onClose}
      size="xl"
      title={`${t("Board.Analysis.Logs")} · ${engine.name}`}
    >
      {opened && (
        <Box h="70vh" style={{ display: "flex" }}>
          <EngineLogs engine={engine} />
        </Box>
      )}
    </AppModal>
  );
}

function EngineLogs({ engine }: { engine: LocalEngine }) {
  const { t } = useTranslation();
  const ownerTabId = useOwnerTabId();
  const terminal = useAtomValue(engineTerminalFamily({ tab: ownerTabId, engine: engine.id }));
  const retry = useAtomValue(engineRetryFamily({ tab: ownerTabId, engine: engine.id }));
  const settings = useAtomValue(
    tabEngineSettingsFamily({
      tab: ownerTabId,
      engineId: engine.id,
    }),
  );
  const currentTerminal = matchingEngineTerminal(
    terminal,
    engine,
    engineLineContext(settings, engine),
    retry,
  );
  const failure = currentTerminal?.type === "failed" ? currentTerminal : null;

  const { data, error, mutate } = useSWR(
    failure ? null : ["logs", engine.id, ownerTabId],
    async () => await tauri.getEngineLogs(engine.id, ownerTabId),
    {
      errorRetryCount: 0,
      onError: (cause) => notifyUnlessCancelled(t("Common.Error"), cause),
    },
  );
  const terminalLogs = failure?.snapshot
    ? engineTerminalLogs(t, failure.snapshot.entries)
    : undefined;

  return (
    <Stack flex={1} h="100%">
      {failure && (
        <Text fw={700} role="status">
          {t("Engines.Logs.TerminalDiagnostics")}
        </Text>
      )}
      {(failure || (!error && data !== undefined)) && (
        <EngineLogsView
          logs={failure ? (terminalLogs ?? []) : data!}
          onRefresh={failure ? undefined : () => mutate()}
        />
      )}
    </Stack>
  );
}
