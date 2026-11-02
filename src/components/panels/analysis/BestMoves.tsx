import { useTabAtom, useOwnerTabId } from "@/state/tabScope";
import {
  Accordion,
  Box,
  Button,
  Code,
  Collapse,
  Group,
  Progress,
  Skeleton,
  Stack,
  Table,
  Text,
  Tooltip,
  useMantineTheme,
} from "@mantine/core";
import { useToggle } from "@mantine/hooks";
import {
  GripVertical,
  Pin,
  PinOff,
  Pause,
  Play,
  Settings as SettingsIcon,
  Crosshair,
} from "lucide-react";
import equal from "fast-deep-equal";
import { useAtom, useAtomValue, useStore } from "jotai";
import { memo, startTransition, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { BestMoves } from "@/bindings";
import { IconAction } from "@/components/common/IconAction";
import { useEngineEditDraft, type EngineEditIntent } from "@/components/engines/engineEditDraft";
import { projectAnalysisSettings } from "@/state/analysisSettings";
import {
  currentDetachedEngineAtom,
  threatFamily,
  engineProgressFamily,
  engineRetryFamily,
  tabEngineSettingsFamily,
} from "@/state/atoms";
import { translateChessopsError } from "@/utils/chessops";
import type { ChessDBLine } from "@/utils/chessdb/api";
import { engineMultiPv, type Engine } from "@/utils/engines";
import { formatNodes } from "@/utils/format";
import { formatScore } from "@/utils/score";
import AnalysisRow from "./AnalysisRow";
import AssessmentSymbol from "./AssessmentSymbol";
import classes from "./BestMoves.module.css";
import EngineSettingsForm, { type Settings } from "./EngineSettingsForm";
import { engineFailureMessage, useDisplayedEngineLines } from "./useDisplayedEngineLines";

export const arrowColors = [
  { strong: "blue", pale: "paleBlue" },
  { strong: "green", pale: "paleGreen" },
  { strong: "red", pale: "paleRed" },
  { strong: "yellow", pale: "yellow" }, // there's no paleYellow in chessground
];

interface BestMovesProps {
  id: number;
  engine: Engine;
  fen: string;
  moves: string[];
  halfMoves: number;
  dragHandleProps: any;
  orientation: "white" | "black";
}

function BestMovesComponent({
  id,
  engine,
  fen,
  moves,
  halfMoves,
  dragHandleProps,
  orientation,
}: BestMovesProps) {
  const { t } = useTranslation();

  const ownerTabId = useOwnerTabId();
  const engineProgress = useAtomValue(engineProgressFamily({ engine: engine.id, tab: ownerTabId }));
  const [, setRetry] = useAtom(engineRetryFamily({ engine: engine.id, tab: ownerTabId }));
  const { displayed, readDisplayed, submit } = useEngineEditDraft(engine);
  const store = useStore();
  const settingsAtom = tabEngineSettingsFamily({
    engineId: engine.id,
    defaultSettings: engine.settings ?? undefined,
    defaultGo: engine.go ?? undefined,
    tab: ownerTabId,
  });
  const [committedSettings, setSettings2] = useAtom(settingsAtom);

  const settings = projectAnalysisSettings(committedSettings, displayed);

  const setSettings = useCallback(
    (fn: (prev: Settings) => Settings) => {
      const pending = readDisplayed();
      const current = store.get(settingsAtom);
      const previous = projectAnalysisSettings(current, pending);
      const newSettings = fn(previous);
      if (!newSettings.synced) {
        setSettings2(newSettings);
        return;
      }
      setSettings2((current) => ({
        ...current,
        enabled: newSettings.enabled,
        synced: newSettings.synced,
      }));
      const syncing = !previous.synced;
      const changedOptions = newSettings.settings.filter(
        (option) =>
          syncing ||
          !equal(
            option,
            previous.settings.find((old) => old.name === option.name),
          ),
      );
      const removedOptions = previous.settings
        .filter((old) => !newSettings.settings.some((option) => option.name === old.name))
        .map((option) => option.name);
      const goChanged = syncing || !equal(newSettings.go, previous.go);
      const intents: EngineEditIntent[] = [];
      if (syncing) intents.push({ kind: "reset", settings: newSettings.settings });
      else {
        for (const option of changedOptions)
          intents.push({ kind: "option", name: option.name, value: option });
        for (const name of removedOptions) intents.push({ kind: "option", name, value: null });
      }
      if (goChanged) intents.push({ kind: "field", field: "go", value: newSettings.go });
      submit(intents);
    },
    [readDisplayed, settingsAtom, store, setSettings2, submit],
  );

  const [settingsOn, toggleSettingsOn] = useToggle();
  const [threat, setThreat] = useAtom(useTabAtom(threatFamily));
  const [detachedEngineId, setDetachedEngineId] = useAtom(currentDetachedEngineAtom);
  const isDetached = detachedEngineId === engine.id;
  const theme = useMantineTheme();

  const {
    lines: engineVariations,
    dimmed,
    failure,
    terminal,
    loading,
    error,
    isGameOver,
    searchedBoardFen,
    halfMoves: displayedHalfMoves,
    available,
  } = useDisplayedEngineLines(engine, fen, moves, halfMoves);
  const progress = available ? engineProgress : 0;

  return (
    <Box
      className={classes.engine}
      style={{
        "--cf-engine-status":
          settings.enabled && !isGameOver && !failure
            ? `var(--mantine-color-${id < 4 ? arrowColors[id].strong : theme.primaryColor}-6)`
            : "var(--cf-border-strong)",
      }}
    >
      <Box className={classes.header}>
        <Stack gap={0} py="1rem">
          <IconAction
            label={
              settings.enabled
                ? t("Board.Analysis.DisableEngine")
                : t("Board.Analysis.EnableEngine")
            }
            pressed={settings.enabled}
            size="md"
            variant={settings.enabled ? "filled" : "transparent"}
            color={theme.primaryColor}
            onClick={() => {
              setSettings((prev) => ({ ...prev, enabled: !prev.enabled }));
            }}
            style={{ marginLeft: 12 }}
          >
            {settings.enabled ? <Pause size="1rem" /> : <Play size="1rem" />}
          </IconAction>
        </Stack>
        <Accordion.Control>
          <EngineTop
            name={engine.name}
            showNodes={engine.type !== "chessdb"}
            engineVariations={engineVariations}
            isGameOver={isGameOver}
            enabled={settings.enabled}
            progress={progress}
            error={error}
            loading={loading}
            dimmed={dimmed}
            failed={failure !== null}
          />
        </Accordion.Control>
        <Group gap={0}>
          <IconAction
            label={t("Board.Analysis.CheckThreat")}
            pressed={threat}
            size="lg"
            onClick={() => setThreat(!threat)}
            disabled={!settings.enabled}
            variant="transparent"
            style={{ marginTop: "auto", marginBottom: "auto" }}
          >
            <Crosshair color={threat ? "var(--cf-destructive)" : undefined} size="1rem" />
          </IconAction>
          <IconAction
            label={isDetached ? t("Board.Analysis.Unpin") : t("Board.Analysis.Pin")}
            pressed={isDetached}
            size="lg"
            onClick={() =>
              startTransition(() => {
                setDetachedEngineId(isDetached ? null : engine.id);
              })
            }
            variant={isDetached ? "light" : "transparent"}
            style={{ marginTop: "auto", marginBottom: "auto" }}
          >
            {isDetached ? <PinOff size="1rem" /> : <Pin size="1rem" />}
          </IconAction>
          <IconAction
            label={t("Engines.Settings.AdvancedSettings")}
            pressed={settingsOn}
            size="lg"
            onClick={() => toggleSettingsOn()}
            style={{ marginTop: "auto", marginBottom: "auto" }}
          >
            <SettingsIcon size="1rem" />
          </IconAction>
          <IconAction
            label={t("Board.Analysis.ReorderEngine")}
            size="lg"
            style={{ marginRight: 8, marginTop: "auto", marginBottom: "auto", cursor: "grab" }}
            {...dragHandleProps}
          >
            <GripVertical size="1rem" />
          </IconAction>
        </Group>
        <Progress
          aria-label={engine.name}
          className={classes.progress}
          color="var(--cf-engine-status)"
          value={isGameOver || failure ? 0 : progress}
          animated={available && progress < 100 && settings.enabled && !isGameOver && !failure}
          size={3}
          striped={available && progress < 100 && !settings.enabled && !failure}
        />
      </Box>
      <Collapse in={settingsOn} px={30} pb={15}>
        <EngineSettingsForm
          engine={engine}
          settings={settings}
          setSettings={setSettings}
          remote={engine.type !== "local"}
        />
      </Collapse>

      <Accordion.Panel pos="relative">
        <Table>
          <Table.Tbody>
            {failure && (
              <Table.Tr>
                <Table.Td colSpan={3}>
                  <Stack gap="xs" role="status">
                    <Text c="danger" fw={700}>
                      {t("Board.Analysis.EngineFailed")}
                    </Text>
                    <Text size="sm">
                      {engineFailureMessage(
                        t,
                        failure.snapshot,
                        failure.message,
                        failure.cleanupFailed,
                      )}
                    </Text>
                    <Button
                      size="xs"
                      variant="light"
                      onClick={() => setRetry((value) => value + 1)}
                    >
                      {t("Board.Analysis.RetryEngine")}
                    </Button>
                  </Stack>
                </Table.Td>
              </Table.Tr>
            )}
            {error && (
              <Table.Tr>
                <Table.Td>
                  <Text ta="center" my="lg">
                    {t("Board.Analysis.InvalidPosition", {
                      error: translateChessopsError(t, error),
                    })}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
            {isGameOver && (
              <Table.Tr>
                <Table.Td>
                  <Text ta="center" my="lg">
                    {t("Board.Analysis.GameOver")}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
            {engineVariations && engineVariations.length === 0 && !isGameOver && (
              <Table.Tr>
                <Table.Td>
                  <Text ta="center" my="lg">
                    {terminal?.type === "not-in-database"
                      ? t("Board.Analysis.NotInChessDB")
                      : t("Board.Analysis.NoAnalysisAvailable")}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
            {!isGameOver &&
              !error &&
              !engineVariations &&
              (settings.enabled ? (
                loading &&
                [...Array(engineMultiPv(settings.settings))].map((_, i) => (
                  <Table.Tr key={i}>
                    <Table.Td>
                      <Skeleton height={35} radius="xl" p={5} />
                    </Table.Td>
                  </Table.Tr>
                ))
              ) : (
                <Table.Tr>
                  <Table.Td>
                    <Text c="dimmed" size="sm" my={4}>
                      {t("Board.Analysis.InactiveEngine")}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            {!isGameOver &&
              !error &&
              searchedBoardFen &&
              engineVariations &&
              engineVariations.map((engineVariation, index) => {
                return (
                  <AnalysisRow
                    key={index}
                    engineId={engine.id}
                    engineName={engine.name}
                    moves={engineVariation.sanMoves}
                    score={engineVariation.score}
                    chessdb={
                      engine.type === "chessdb"
                        ? (engineVariation as ChessDBLine).chessdb
                        : undefined
                    }
                    halfMoves={displayedHalfMoves}
                    inert={dimmed}
                    threat={threat}
                    fen={searchedBoardFen}
                    orientation={orientation}
                  />
                );
              })}
          </Table.Tbody>
        </Table>
      </Accordion.Panel>
    </Box>
  );
}

function EngineTop({
  name,
  showNodes,
  engineVariations,
  isGameOver,
  enabled,
  progress,
  error,
  loading,
  dimmed,
  failed,
}: {
  name: string;
  showNodes: boolean;
  engineVariations: BestMoves[] | undefined;
  isGameOver: boolean;
  enabled: boolean;
  progress: number;
  error: any;
  loading: boolean;
  dimmed: boolean;
  failed: boolean;
}) {
  const { t } = useTranslation();
  const isComputed = engineVariations && engineVariations.length > 0;
  const depth = isComputed ? engineVariations[0].depth : 0;
  const nodes = isComputed ? formatNodes(engineVariations[0].nodes, 2) : 0;
  const nps = isComputed ? formatNodes(engineVariations[0].nps, 1) : 0;

  return (
    <Group justify="space-between" wrap="wrap" gap="xs" opacity={dimmed ? 0.5 : 1}>
      <Group align="center" wrap="nowrap">
        <Text fw={600} fz="sm" lineClamp={1}>
          {name}
        </Text>
        {loading && enabled && !isGameOver && !error && <Code fz="xs">{t("Common.Loading")}</Code>}
        {showNodes &&
          progress < 100 &&
          !failed &&
          enabled &&
          !isGameOver &&
          engineVariations &&
          engineVariations.length > 0 && (
            <Tooltip label={t("Board.Analysis.EngineSpeedHint")}>
              <Code fz="xs">{nps}n/s</Code>
            </Tooltip>
          )}
      </Group>
      <Group gap="sm" wrap="nowrap" className={classes.stats}>
        {!isGameOver && engineVariations && engineVariations.length > 0 && (
          <>
            <Stack align="center" gap={0}>
              <Text size="0.7rem" tt="uppercase" fw={700} className={classes.subtitle}>
                {t("Board.Analysis.Evaluation")}
              </Text>
              <Group gap={6} wrap="nowrap">
                <Text fw="bold" fz="md">
                  {formatScore(engineVariations[0].score.value, 1) ?? 0}
                </Text>
                <AssessmentSymbol score={engineVariations[0].score.value} fz="md" />
              </Group>
            </Stack>
            <Stack align="center" gap={0}>
              <Text size="0.7rem" tt="uppercase" fw={700} className={classes.subtitle}>
                {t("GoMode.Depth")}
              </Text>
              <Text fw="bold" fz="md">
                {depth}
              </Text>
            </Stack>
            {showNodes && (
              <Stack align="center" gap={0}>
                <Text size="0.7rem" tt="uppercase" fw={700} className={classes.subtitle}>
                  {t("GoMode.Nodes")}
                </Text>
                <Text fw="bold" fz="md">
                  {nodes}
                </Text>
              </Stack>
            )}
          </>
        )}
      </Group>
    </Group>
  );
}

export default memo(BestMovesComponent, (prev, next) => {
  return (
    prev.id === next.id &&
    prev.engine === next.engine &&
    prev.fen === next.fen &&
    equal(prev.moves, next.moves) &&
    prev.halfMoves === next.halfMoves &&
    prev.orientation === next.orientation
  );
});
