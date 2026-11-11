import {
  Button,
  Group,
  Input,
  Popover,
  ScrollArea,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Tooltip,
} from "@mantine/core";
import { ChevronDown } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import AppModal from "@/components/common/AppModal";
import { trainingSettings as settings } from "@/state/chessRiddleTrainingSettings";
import { difficultyOptions, motifCategoryLabels, motifLabel } from "./trainingLabels";
import { ALL_MOTIFS_ICON, CATEGORY_ORDER, CATEGORY_PATHS, motifMeta } from "./motifCatalog";
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
  const difficulties = difficultyOptions(t);
  return (
    <AppModal opened={opened} onClose={onClose} title={t("Training.Settings.Title")}>
      <Stack gap="sm">
        <Select
          label={t("Training.Settings.Difficulty")}
          value={String(values.difficulty)}
          data={difficulties}
          leftSection={
            <span aria-hidden>
              {difficulties.find((option) => option.value === String(values.difficulty))?.glyph}
            </span>
          }
          renderOption={({ option }) => (
            <Group gap="xs">
              <span aria-hidden>
                {difficulties.find((item) => item.value === option.value)?.glyph}
              </span>
              {option.label}
            </Group>
          )}
          disabled={disabled}
          onChange={(value) => {
            if (value !== null) settings.change({ difficulty: Number(value) });
          }}
        />
        <MotifPicker
          motifs={state.motifs}
          value={values.motif && state.motifs.includes(values.motif) ? values.motif : null}
          disabled={disabled || !!state.motifError}
          onChange={(motif) => settings.change({ motif })}
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
          label={t("Training.Settings.ShowSolutionLength")}
          checked={values.showMoveCounter}
          disabled={disabled}
          onChange={(event) => settings.change({ showMoveCounter: event.currentTarget.checked })}
        />
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

function MotifPicker({
  motifs,
  value,
  disabled,
  onChange,
}: {
  motifs: string[];
  value: string | null;
  disabled: boolean;
  onChange: (motif: string | null) => void;
}) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  const [category, setCategory] = useState("all");
  const labels = motifCategoryLabels(t);
  const available = CATEGORY_ORDER.filter((item) =>
    motifs.some((name) => motifMeta(name).category === item),
  );
  const activeCategory = available.some((item) => item === category) ? category : "all";
  const allLabel = t("Training.Settings.AllMotifs");
  const choose = (motif: string | null) => {
    onChange(motif);
    setOpened(false);
  };
  const option = (name: string | null) => {
    const label = name ? motifLabel(name, t) : allLabel;
    return (
      <Tooltip key={name ?? "all"} label={label}>
        <Button
          variant={value === name ? "light" : "subtle"}
          aria-pressed={value === name}
          onClick={() => choose(name)}
          h="auto"
          p="xs"
          styles={{ label: { whiteSpace: "normal", width: "100%" } }}
        >
          <Stack gap={4} align="center" w="100%">
            <Text component="span" size="lg" aria-hidden>
              {name ? motifMeta(name).icon : ALL_MOTIFS_ICON}
            </Text>
            <Text component="span" size="xs" style={{ overflowWrap: "anywhere" }}>
              {label}
            </Text>
          </Stack>
        </Button>
      </Tooltip>
    );
  };
  return (
    <Input.Wrapper label={t("Training.Settings.Motif")}>
      <Popover
        opened={opened && !disabled}
        onChange={setOpened}
        width="min(560px, calc(100vw - 32px))"
        position="bottom-start"
        trapFocus
        returnFocus
      >
        <Popover.Target>
          <Button
            fullWidth
            variant="default"
            disabled={disabled}
            aria-label={t("Training.Settings.Motif")}
            aria-haspopup="dialog"
            aria-expanded={opened && !disabled}
            onClick={() => setOpened((current) => !current)}
            leftSection={<span aria-hidden>{value ? motifMeta(value).icon : ALL_MOTIFS_ICON}</span>}
            rightSection={<ChevronDown size={16} aria-hidden />}
            styles={{
              label: { flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis" },
            }}
          >
            {value ? motifLabel(value, t) : allLabel}
          </Button>
        </Popover.Target>
        <Popover.Dropdown role="dialog" aria-label={t("Training.Settings.Motif")}>
          <Stack gap="sm">
            <ScrollArea type="auto" offsetScrollbars>
              <SegmentedControl
                value={activeCategory}
                onChange={setCategory}
                size="xs"
                data={[
                  { value: "all", label: labels.all },
                  ...available.map((item) => ({
                    value: item,
                    label: (
                      <Group gap={4} wrap="nowrap">
                        <svg
                          width={16}
                          height={16}
                          viewBox="0 0 24 24"
                          fill="currentColor"
                          aria-hidden
                        >
                          <path d={CATEGORY_PATHS[item]} />
                        </svg>
                        <span>{labels[item]}</span>
                      </Group>
                    ),
                  })),
                ]}
              />
            </ScrollArea>
            <ScrollArea.Autosize mah={280} type="auto" offsetScrollbars>
              <SimpleGrid cols={{ base: 3, xs: 5 }} spacing="xs">
                {activeCategory === "all" && option(null)}
                {motifs
                  .filter(
                    (name) =>
                      activeCategory === "all" || motifMeta(name).category === activeCategory,
                  )
                  .map(option)}
              </SimpleGrid>
            </ScrollArea.Autosize>
          </Stack>
        </Popover.Dropdown>
      </Popover>
    </Input.Wrapper>
  );
}
