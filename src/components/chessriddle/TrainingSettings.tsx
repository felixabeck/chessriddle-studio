import { Button, Select, Stack, Switch, Text } from "@mantine/core";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import AppModal from "@/components/common/AppModal";
import { trainingSettings as settings } from "@/state/chessRiddleTrainingSettings";
import { difficultyOptions, motifLabel } from "./trainingLabels";
import TrainingError from "./TrainingError";

export default function TrainingSettings({
  id,
  opened,
  onClose,
}: {
  id: string;
  opened: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(settings.subscribe, settings.get);
  const { values } = state;
  const disabled = state.status !== "ready" || state.reconciling;
  const durations = [...new Set([60, 180, 300, 600, values.timerDuration])].sort((a, b) => a - b);
  return (
    <AppModal opened={opened} onClose={onClose} title={t("Training.Settings.Title")}>
      <Stack gap="sm">
        <Select
          label={t("Training.Settings.Difficulty")}
          value={String(values.difficulty)}
          data={difficultyOptions(t)}
          disabled={disabled}
          onChange={(value) => {
            if (value !== null) settings.change({ difficulty: Number(value) });
          }}
        />
        <Select
          searchable
          label={t("Training.Settings.Motif")}
          value={values.motif && state.motifs.includes(values.motif) ? values.motif : ""}
          data={[
            { value: "", label: t("Training.Settings.AllMotifs") },
            ...state.motifs.map((name) => ({ value: name, label: motifLabel(name, t) })),
          ]}
          disabled={disabled || !!state.motifError}
          onChange={(value) => settings.change({ motif: value || null })}
        />
        {state.motifError && (
          <>
            <TrainingError id={id} error={state.motifError} />
            <Button variant="default" onClick={() => void settings.retryMotifs()}>
              {t("Training.Retry")}
            </Button>
          </>
        )}
        <Switch
          label={t("Training.Settings.ShowTimer")}
          checked={values.showTimer}
          disabled={disabled}
          onChange={(event) => settings.change({ showTimer: event.currentTarget.checked })}
        />
        <Select
          label={t("Training.Settings.TimerMode")}
          value={values.timerMode}
          data={[
            { value: "up", label: t("Training.Settings.Up") },
            { value: "down", label: t("Training.Settings.Down") },
          ]}
          disabled={disabled}
          onChange={(value) => {
            if (value) settings.change({ timerMode: value });
          }}
        />
        {values.timerMode === "down" && (
          <Select
            label={t("Training.Settings.Duration")}
            value={String(values.timerDuration)}
            data={durations.map((seconds) => ({
              value: String(seconds),
              label:
                seconds % 60 === 0
                  ? t("Training.Settings.Minutes", { minutes: seconds / 60 })
                  : t("Training.Settings.Seconds", { seconds }),
            }))}
            disabled={disabled}
            onChange={(value) => {
              if (value) settings.change({ timerDuration: Number(value) });
            }}
          />
        )}
        <Text size="sm" c="dimmed">
          {t("Training.Settings.NextPuzzle")}
        </Text>
        {state.saveError && <TrainingError id={id} error={state.saveError} />}
        {state.error && (
          <>
            <TrainingError id={id} error={state.error} />
            <Button onClick={() => void settings.load(true)}>{t("Training.Retry")}</Button>
          </>
        )}
      </Stack>
    </AppModal>
  );
}
