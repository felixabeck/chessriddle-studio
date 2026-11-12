import { useOwnerTabId } from "@/state/tabScope";
import { tauri } from "@/platform/tauri";
import { Select, Stack, Text } from "@mantine/core";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import {
  engineTerminalFamily,
  engineRetryFamily,
  enginesAtom,
  tabEngineSettingsFamily,
} from "@/state/atoms";
import type { LocalEngine } from "@/utils/engines";
import { engineLineContext } from "./analysisLineContext";
import { engineTerminalLogs, matchingEngineTerminal } from "./useDisplayedEngineLines";
import EngineLogsView from "../../common/EngineLogsView";

export default function LogsPanel() {
  const { t } = useTranslation();
  const engines = useAtomValue(enginesAtom);
  const localEngines = (engines ?? [])
    .filter((e): e is LocalEngine => e.type === "local")
    .filter((e) => e.loaded);
  const [engineId, setEngineId] = useState<string | undefined>(localEngines[0]?.id);
  const engine = localEngines.find((engine) => engine.id === engineId) ?? localEngines[0];
  const selection = (
    <Select
      aria-label={t("Common.Engine")}
      allowDeselect={false}
      value={engine?.id ?? ""}
      onChange={(id) => setEngineId(id ?? undefined)}
      data={localEngines.map((e) => ({ value: e.id, label: e.name }))}
    />
  );

  return engine ? <SelectedEngineLogs engine={engine} selection={selection} /> : null;
}

function SelectedEngineLogs({
  engine,
  selection,
}: {
  engine: LocalEngine;
  selection: React.ReactNode;
}) {
  const { t } = useTranslation();
  const ownerTabId = useOwnerTabId();
  const terminal = useAtomValue(engineTerminalFamily({ tab: ownerTabId, engine: engine.id }));
  const retry = useAtomValue(engineRetryFamily({ tab: ownerTabId, engine: engine.id }));
  const settings = useAtomValue(
    tabEngineSettingsFamily({
      tab: ownerTabId,
      engineId: engine.id,
      defaultSettings: engine.settings ?? undefined,
      defaultGo: engine.go ?? undefined,
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
          additionalControls={selection}
        />
      )}
    </Stack>
  );
}
