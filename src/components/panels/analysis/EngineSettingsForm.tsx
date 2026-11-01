import { useOwnerTabId } from "@/state/tabScope";
import { Checkbox, Group, type MantineColor, Stack, Text } from "@mantine/core";
import { Square, Settings } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { GoMode } from "@/bindings";
import type { AnalysisSettings } from "@/state/analysisSettings";
import GoModeInput from "@/components/common/GoModeInput";
import { IconAction } from "@/components/common/IconAction";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { enginesAtom } from "@/state/atoms";
import { type Engine, engineMultiPv, killEngine } from "@/utils/engines";
import CoresSlider from "./CoresSlider";
import HashSlider from "./HashSlider";
import LinesSlider from "./LinesSlider";

export type Settings = AnalysisSettings;

interface EngineSettingsProps {
  engine: Engine;
  settings: Settings;
  setSettings: (fn: (prev: Settings) => Settings) => void;
  color?: MantineColor;
  minimal?: boolean;
  remote: boolean;
  gameMode?: boolean;
}

function EngineSettingsForm({
  engine,
  settings,
  setSettings,
  color,
  minimal,
  remote,
  gameMode,
}: EngineSettingsProps) {
  const { t } = useTranslation();

  const multipv = settings.settings.findLast((o) => o.name === "MultiPV");
  const threads = settings.settings.findLast((o) => o.name === "Threads");
  const hash = settings.settings.findLast((o) => o.name === "Hash");
  const ownerTabId = useOwnerTabId();

  const setGoMode = useCallback(
    (v: GoMode) => {
      setSettings((prev) => ({
        ...prev,
        go: v,
      }));
    },
    [setSettings],
  );

  return (
    <Stack>
      {!remote && !minimal && (
        <GoModeInput gameMode={gameMode} goMode={settings.go} setGoMode={setGoMode} />
      )}

      {!minimal && multipv && (
        <Group grow>
          <Text size="sm" fw="bold">
            {t("Engines.Settings.NumOfLines")}
          </Text>
          <LinesSlider
            value={engineMultiPv(settings.settings)}
            setValue={(v) =>
              setSettings((prev) => {
                return {
                  ...prev,
                  settings: prev.settings.map((o) =>
                    o.name === "MultiPV" && o.type === "string"
                      ? { ...o, value: String(v || 1) }
                      : o,
                  ),
                };
              })
            }
            color={color}
          />
        </Group>
      )}

      {!remote && threads && (
        <>
          <Group grow>
            <Text size="sm" fw="bold">
              {t("Engines.Settings.NumOfCores")}
            </Text>
            <CoresSlider
              value={Number(threads.type === "string" ? threads.value || 1 : 1)}
              setValue={(v) =>
                setSettings((prev) => ({
                  ...prev,
                  settings: prev.settings.map((o) =>
                    o.name === "Threads" && o.type === "string"
                      ? { ...o, value: String(v || 1) }
                      : o,
                  ),
                }))
              }
              color={color}
            />
          </Group>

          {hash && (
            <Group grow>
              <Text size="sm" fw="bold">
                {t("Engines.Settings.SizeOfHash")}
              </Text>
              <HashSlider
                value={Number(hash.type === "string" ? hash.value || 1 : 1)}
                setValue={(v) =>
                  setSettings((prev) => ({
                    ...prev,
                    settings: prev.settings.map((o) =>
                      o.name === "Hash" && o.type === "string"
                        ? { ...o, value: String(v || 1) }
                        : o,
                    ),
                  }))
                }
                color={color}
              />
            </Group>
          )}
        </>
      )}
      {!minimal && (
        <Group>
          <SyncSettings settings={settings} engineId={engine.id} setSettings={setSettings} />
          <Group gap={0}>
            {engine.type === "local" && (
              <IconAction
                label={t("Board.Analysis.KillEngine")}
                variant="default"
                onClick={async () => {
                  try {
                    await killEngine(engine, ownerTabId);
                    setSettings((prev) => ({
                      ...prev,
                      enabled: false,
                    }));
                  } catch (error) {
                    notifyUnlessCancelled(t("Common.Error"), error);
                  }
                }}
              >
                <Square size="1rem" />
              </IconAction>
            )}
            <AdvancedSettings engineId={engine.id} />
          </Group>
        </Group>
      )}
    </Stack>
  );
}

function SyncSettings({
  engineId,
  settings,
  setSettings,
}: {
  engineId: string;
  settings: Settings;
  setSettings: (fn: (prev: Settings) => Settings) => void;
}) {
  const { t } = useTranslation();

  const engines = useAtomValue(enginesAtom);
  const engineDefault = useMemo(
    () => (engines ?? []).find((o) => o.id === engineId),
    [engines, engineId],
  );

  return (
    <Checkbox
      label={t("Board.Analysis.SyncGlobally")}
      checked={settings.synced}
      onChange={(e) => {
        if (e.currentTarget.checked) {
          if (!engineDefault) return;
          setSettings((prev) => ({
            ...prev,
            go: engineDefault.go || prev.go,
            settings: engineDefault.settings || prev.settings,
            synced: true,
          }));
        } else {
          setSettings((prev) => ({
            ...prev,
            synced: false,
          }));
        }
      }}
    />
  );
}

function AdvancedSettings({ engineId }: { engineId: string }) {
  const { t } = useTranslation();

  const navigate = useNavigate();
  const engines = useAtomValue(enginesAtom);

  return (
    <IconAction
      label={t("Engines.Settings.AdvancedSettings")}
      variant="default"
      onClick={() => {
        const selected = (engines ?? []).findIndex((engine) => engine.id === engineId);
        if (selected < 0) return;
        navigate({
          to: "/engines",
          search: { selected },
        });
      }}
    >
      <Settings size="1rem" />
    </IconAction>
  );
}

export default memo(EngineSettingsForm);
