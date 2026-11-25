import {
  Center,
  Divider,
  Group,
  InputWrapper,
  SegmentedControl,
  Stack,
  TextInput,
} from "@mantine/core";
import { PersonIcon, EngineIcon } from "@/components/common/iconCatalog";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import GoModeInput from "@/components/common/GoModeInput";
import TimeInput from "@/components/common/TimeInput";
import EngineSettingsForm from "@/components/panels/analysis/EngineSettingsForm";
import {
  DEFAULT_TIME_CONTROL,
  switchOpponentType,
  type OpponentSettings,
} from "@/state/opponentSettings";
import { effectiveGameGo } from "@/utils/engines";
import { EnginesSelect } from "./EnginesSelect";

export { DEFAULT_TIME_CONTROL, type OpponentSettings } from "@/state/opponentSettings";

export function OpponentForm({
  sameTimeControl,
  opponent,
  setOpponent,
  setOtherOpponent,
  sideLabel,
}: {
  sameTimeControl: boolean;
  opponent: OpponentSettings;
  setOpponent: React.Dispatch<React.SetStateAction<OpponentSettings>>;
  setOtherOpponent: React.Dispatch<React.SetStateAction<OpponentSettings>>;
  sideLabel: string;
}) {
  const { t } = useTranslation();
  const timeId = useId();
  const incrementId = useId();

  function updateType(type: "engine" | "human") {
    setOpponent((prev) => switchOpponentType(prev, type));
  }

  return (
    <Stack flex={1} role="group" aria-label={sideLabel}>
      <SegmentedControl
        data={[
          {
            value: "human",
            label: (
              <Center style={{ gap: 10 }}>
                <PersonIcon size={16} />
                <span>{t("Board.Opponent.Human")}</span>
              </Center>
            ),
          },
          {
            value: "engine",
            label: (
              <Center style={{ gap: 10 }}>
                <EngineIcon size={16} />
                <span>{t("Common.Engine")}</span>
              </Center>
            ),
          },
        ]}
        value={opponent.type}
        onChange={(v) => updateType(v as "human" | "engine")}
      />

      {opponent.type === "human" && (
        <TextInput
          value={opponent.name ?? ""}
          onChange={(e) => setOpponent((prev) => ({ ...prev, name: e.target.value }))}
          aria-label={t("Common.Name")}
        />
      )}

      {opponent.type === "engine" && (
        <EnginesSelect
          engine={opponent.engine}
          setEngine={(engine) =>
            setOpponent((prev) => {
              const previous = prev.type === "engine" ? prev.engine : null;
              // Per-game settings belong to the player, not to the engine record, so a
              // refreshed record for the same engine keeps them; only a different engine
              // replaces them with that engine's own defaults.
              const sameEngine = engine !== null && previous?.id === engine.id;
              return {
                ...prev,
                engine,
                engineSettings: sameEngine
                  ? prev.type === "engine"
                    ? prev.engineSettings
                    : undefined
                  : engine?.settings || undefined,
              };
            })
          }
        />
      )}

      <Divider variant="dashed" label={t("Board.Opponent.TimeSettings")} />
      <SegmentedControl
        data={[
          { value: "time", label: t("GoMode.Time") },
          { value: "unlimited", label: t("Board.Opponent.Unlimited") },
        ]}
        value={opponent.timeControl ? "time" : "unlimited"}
        onChange={(v) => {
          setOpponent((prev) => ({
            ...prev,
            timeControl: v === "time" ? DEFAULT_TIME_CONTROL : undefined,
          }));
          if (sameTimeControl) {
            setOtherOpponent((prev) => ({
              ...prev,
              timeControl: v === "time" ? DEFAULT_TIME_CONTROL : undefined,
            }));
          }
        }}
      />
      <Group grow wrap="nowrap">
        {opponent.timeControl && (
          <>
            <InputWrapper label={t("GoMode.Time")} id={timeId}>
              <TimeInput
                id={timeId}
                unitLabel={t("Board.Opponent.TimeUnit")}
                defaultType="m"
                type={opponent.timeUnit}
                onTypeChange={(unit) => {
                  setOpponent((prev) => ({ ...prev, timeUnit: unit }));
                  if (sameTimeControl) {
                    setOtherOpponent((prev) => ({ ...prev, timeUnit: unit }));
                  }
                }}
                value={opponent.timeControl.seconds}
                setValue={(v) => {
                  setOpponent((prev) => ({
                    ...prev,
                    timeControl: {
                      seconds: v.t === "Time" ? v.c : 0,
                      increment: prev.timeControl?.increment ?? 0,
                    },
                  }));
                  if (sameTimeControl) {
                    setOtherOpponent((prev) => ({
                      ...prev,
                      timeControl: {
                        seconds: v.t === "Time" ? v.c : 0,
                        increment: prev.timeControl?.increment ?? 0,
                      },
                    }));
                  }
                }}
              />
            </InputWrapper>
            <InputWrapper label={t("Board.Opponent.Increment")} id={incrementId}>
              <TimeInput
                id={incrementId}
                unitLabel={t("Board.Opponent.IncrementUnit")}
                defaultType="s"
                type={opponent.incrementUnit}
                onTypeChange={(unit) => {
                  setOpponent((prev) => ({ ...prev, incrementUnit: unit }));
                  if (sameTimeControl) {
                    setOtherOpponent((prev) => ({ ...prev, incrementUnit: unit }));
                  }
                }}
                value={opponent.timeControl.increment ?? 0}
                setValue={(v) => {
                  setOpponent((prev) => ({
                    ...prev,
                    timeControl: {
                      seconds: prev.timeControl?.seconds ?? 0,
                      increment: v.t === "Time" ? v.c : 0,
                    },
                  }));
                  if (sameTimeControl) {
                    setOtherOpponent((prev) => ({
                      ...prev,
                      timeControl: {
                        seconds: prev.timeControl?.seconds ?? 0,
                        increment: v.t === "Time" ? v.c : 0,
                      },
                    }));
                  }
                }}
              />
            </InputWrapper>
          </>
        )}
      </Group>

      {opponent.type === "engine" && (
        <Stack>
          {!opponent.timeControl && (
            <GoModeInput
              gameMode
              goMode={effectiveGameGo(opponent.go)}
              setGoMode={(go) =>
                setOpponent((prev) => {
                  if (prev.type === "human") {
                    return prev;
                  }
                  return {
                    ...prev,
                    go,
                  };
                })
              }
            />
          )}
          <Divider variant="dashed" label={t("Board.Opponent.EngineSettings", "Engine Settings")} />
          {opponent.engine && (
            <EngineSettingsForm
              engine={opponent.engine}
              remote={false}
              gameMode
              settings={{
                go: opponent.go,
                settings: opponent.engineSettings || opponent.engine.settings || [],
                enabled: true,
                synced: false,
              }}
              setSettings={(fn) =>
                setOpponent((prev) => {
                  if (prev.type === "human") {
                    return prev;
                  }
                  const newSettings = fn({
                    go: prev.go,
                    settings: prev.engineSettings || prev.engine?.settings || [],
                    enabled: true,
                    synced: false,
                  });
                  return {
                    ...prev,
                    go: newSettings.go,
                    engineSettings: newSettings.settings,
                  };
                })
              }
              minimal={true}
            />
          )}
        </Stack>
      )}
    </Stack>
  );
}
