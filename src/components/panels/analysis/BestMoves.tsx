import { useTabAtom, useOwnerTabId } from "@/state/tabScope";
import {
  Box,
  Button,
  Code,
  Collapse,
  Group,
  Menu,
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
  ChevronDown,
  Crosshair,
  GripVertical,
  Pause,
  Play,
  ScrollText,
  Settings as SettingsIcon,
  X,
} from "lucide-react";
import equal from "fast-deep-equal";
import { useAtom, useAtomValue } from "jotai";
import {
  memo,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import PanelHeader from "@/components/boards/PanelHeader";
import { IconAction } from "@/components/common/IconAction";
import {
  engineProgressFamily,
  engineRetryFamily,
  enginesAtom,
  expandedEnginesFamily,
  threatFamily,
} from "@/state/atoms";
import { engineAreaId } from "@/state/boardArrangement";
import { translateChessopsError } from "@/utils/chessops";
import type { ChessDBLine } from "@/utils/chessdb/api";
import { engineMultiPv, setEngineMultiPv, type Engine } from "@/utils/engines";
import AnalysisRow from "./AnalysisRow";
import AssessmentSymbol from "./AssessmentSymbol";
import classes from "./BestMoves.module.css";
import EngineLogsModal from "./EngineLogsModal";
import EngineSettingsForm from "./EngineSettingsForm";
import LinesSlider, { LINE_COUNT_OPTIONS } from "./LinesSlider";
import { ThreatBadge } from "./ThreatBadge";
import { engineFailureMessage } from "./engineFailure";
import { useDisplayedEngineLines } from "./useDisplayedEngineLines";
import { useTabEngineSettings } from "./useTabEngineSettings";

export const arrowColors = [
  { strong: "blue", pale: "paleBlue" },
  { strong: "green", pale: "paleGreen" },
  { strong: "red", pale: "paleRed" },
  { strong: "yellow", pale: "yellow" }, // there's no paleYellow in chessground
];

interface BestMovesProps {
  /** Index in the loaded-engine order (determines arrow colour and status stripe). */
  id: number;
  engine: Engine;
  fen: string;
  moves: string[];
  halfMoves: number;
  orientation: "white" | "black";
  /** `"panel"` inside the Engines panel, `"window"` when pulled out as its own tile. */
  mode?: "panel" | "window";
  /** Pointer-down handler for the six-dot grip (and top row in window mode). */
  onDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
  /** Suppresses the trailing click after a drag gesture finishes. */
  onSuppressClick?: (event: ReactMouseEvent) => void;
  /** Panel mode: grip menu actions for reordering or pulling out. */
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  canShowAsArea?: boolean;
  onShowAsArea?: () => void;
  /** Window mode: click grip starts placing; × returns to the Engines panel. */
  onStartPlacing?: () => void;
  onReturn?: () => void;
}

function BestMovesComponent({
  id,
  engine,
  fen,
  moves,
  halfMoves,
  orientation,
  mode = "panel",
  onDragStart,
  onSuppressClick,
  canMoveUp = false,
  canMoveDown = false,
  onMoveUp,
  onMoveDown,
  canShowAsArea = false,
  onShowAsArea,
  onStartPlacing,
  onReturn,
}: BestMovesProps) {
  const { t } = useTranslation();

  const ownerTabId = useOwnerTabId();
  const engineProgress = useAtomValue(engineProgressFamily({ engine: engine.id, tab: ownerTabId }));
  const [, setRetry] = useAtom(engineRetryFamily({ engine: engine.id, tab: ownerTabId }));
  const engines = useAtomValue(enginesAtom);
  const [expanded, setExpanded] = useAtom(useTabAtom(expandedEnginesFamily));
  const { settings, setSettings } = useTabEngineSettings(engine);

  const [settingsOn, toggleSettingsOn] = useToggle();
  const [logsOpen, setLogsOpen] = useState(false);
  const localEngine = engine.type === "local" ? engine : null;
  const logsButton = localEngine && (
    <Button
      size="xs"
      variant="default"
      leftSection={<ScrollText size="0.875rem" />}
      onClick={() => setLogsOpen(true)}
    >
      {t("Board.Analysis.Logs")}
    </Button>
  );
  const [threat, setThreat] = useAtom(useTabAtom(threatFamily));
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

  const isExpanded = expanded === undefined || expanded.includes(engine.id);
  const toggleExpanded = () => {
    setExpanded((prev) => {
      if (prev === undefined) {
        const loadedIds = (engines ?? []).filter((e) => e.loaded).map((e) => e.id);
        return loadedIds.filter((item) => item !== engine.id);
      }
      return prev.includes(engine.id)
        ? prev.filter((item) => item !== engine.id)
        : [...prev, engine.id];
    });
  };

  const hasMultiPv = settings.settings.some(
    (option) => option.name === "MultiPV" && option.type === "string",
  );
  const multiPv = engineMultiPv(settings.settings);
  const engineArea = engineAreaId(engine.id);
  const isWindow = mode === "window";
  const showLoading = loading && settings.enabled && !isGameOver && !error;
  const hasVariations = !isGameOver && Boolean(engineVariations && engineVariations.length > 0);
  const headerStatus =
    threat || showLoading || hasVariations ? (
      <>
        {threat && <ThreatBadge />}
        {showLoading && <Code fz="xs">{t("Common.Loading")}</Code>}
        {hasVariations && engineVariations && (
          <Group gap={4} wrap="nowrap" className={classes.stats}>
            <Text fz="xs" fw={700} tt="uppercase" c="dimmed">
              {t("GoMode.Depth")}
            </Text>
            <Text fz="sm" fw={700} c={dimmed ? "dimmed" : undefined}>
              {engineVariations[0].depth}
            </Text>
            <AssessmentSymbol score={engineVariations[0].score.value} fz="sm" />
          </Group>
        )}
      </>
    ) : undefined;

  return (
    <Box
      className={classes.engine}
      style={{
        "--cf-engine-status":
          settings.enabled && !isGameOver && !failure
            ? threat
              ? "var(--cf-destructive)"
              : `var(--mantine-color-${id < 4 ? arrowColors[id].strong : theme.primaryColor}-6)`
            : "var(--cf-border-strong)",
      }}
    >
      <PanelHeader
        area={engineArea}
        title={engine.name}
        arrangeable={isWindow}
        onDragStart={isWindow ? onDragStart : undefined}
        onSuppressClick={isWindow ? onSuppressClick : undefined}
        onStartPlacing={isWindow ? onStartPlacing : undefined}
        className={isWindow ? `${classes.header} ${classes.windowHeader}` : classes.header}
        leading={
          <>
            {!isWindow && (
              <Menu position="bottom-start" shadow="md" withinPortal>
                <Menu.Target>
                  <IconAction
                    label={t("Board.Analysis.ReorderEngine")}
                    size="xs"
                    variant="subtle"
                    className={classes.grip}
                    data-arrange-grip={engineArea}
                    onPointerDown={onDragStart}
                    onClickCapture={onSuppressClick}
                  >
                    <GripVertical size="0.875rem" />
                  </IconAction>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item disabled={!canMoveUp} onClick={onMoveUp}>
                    {t("Board.Analysis.MoveUp")}
                  </Menu.Item>
                  <Menu.Item disabled={!canMoveDown} onClick={onMoveDown}>
                    {t("Board.Analysis.MoveDown")}
                  </Menu.Item>
                  {canShowAsArea && onShowAsArea && (
                    <Menu.Item onClick={onShowAsArea}>
                      {t("Board.Analysis.ShowAsOwnArea")}
                    </Menu.Item>
                  )}
                </Menu.Dropdown>
              </Menu>
            )}
            <IconAction
              label={
                settings.enabled
                  ? t("Board.Analysis.DisableEngine")
                  : t("Board.Analysis.EnableEngine")
              }
              pressed={settings.enabled}
              size="sm"
              variant={settings.enabled ? "filled" : "transparent"}
              color={theme.primaryColor}
              data-no-drag="true"
              onClick={() => {
                setSettings((prev) => ({ ...prev, enabled: !prev.enabled }));
              }}
            >
              {settings.enabled ? <Pause size="0.875rem" /> : <Play size="0.875rem" />}
            </IconAction>
          </>
        }
        status={headerStatus}
        actions={
          <>
            {hasMultiPv && (
              <Tooltip label={t("Engines.Settings.NumOfLines")}>
                <Box>
                  <LinesSlider
                    ariaLabel={t("Engines.Settings.NumOfLines")}
                    value={Math.min(Math.max(1, multiPv), LINE_COUNT_OPTIONS.length)}
                    setValue={(count) => {
                      setSettings((previous) => ({
                        ...previous,
                        settings: setEngineMultiPv(previous.settings, count),
                      }));
                    }}
                  />
                </Box>
              </Tooltip>
            )}
            <IconAction
              label={t("Board.Analysis.CheckThreat")}
              pressed={threat}
              size="sm"
              onClick={() => setThreat(!threat)}
              disabled={!settings.enabled}
              variant="subtle"
            >
              <Crosshair color={threat ? "var(--cf-destructive)" : undefined} size="0.875rem" />
            </IconAction>
            <IconAction
              label={t("Board.Analysis.EngineSettings")}
              pressed={settingsOn}
              size="sm"
              variant="subtle"
              onClick={() => toggleSettingsOn()}
            >
              <SettingsIcon size="0.875rem" />
            </IconAction>
            <IconAction
              label={isExpanded ? t("Board.Analysis.Collapse") : t("Board.Analysis.Expand")}
              pressed={isExpanded}
              size="sm"
              variant="subtle"
              style={{
                transition: "transform 200ms ease",
                transform: isExpanded ? "rotate(180deg)" : "none",
              }}
              onClick={toggleExpanded}
            >
              <ChevronDown size="0.875rem" />
            </IconAction>
            {isWindow && onReturn && (
              <IconAction
                label={t("Board.Area.ReturnToEngines")}
                size="sm"
                variant="subtle"
                onClick={onReturn}
              >
                <X size="0.875rem" />
              </IconAction>
            )}
          </>
        }
        progress={
          <Progress
            aria-label={engine.name}
            className={classes.progress}
            color="var(--cf-engine-status)"
            value={isGameOver || failure ? 0 : progress}
            animated={available && progress < 100 && settings.enabled && !isGameOver && !failure}
            size={3}
            striped={available && progress < 100 && !settings.enabled && !failure}
          />
        }
      />
      <Collapse in={settingsOn} px="sm" py="xs">
        <EngineSettingsForm
          engine={engine}
          settings={settings}
          setSettings={setSettings}
          remote={engine.type !== "local"}
        />
        {logsButton && (
          <Group justify="flex-end" mt="sm">
            {logsButton}
          </Group>
        )}
      </Collapse>
      {localEngine && (
        <EngineLogsModal
          engine={localEngine}
          opened={logsOpen}
          onClose={() => setLogsOpen(false)}
        />
      )}

      {isExpanded && (
        <Box className={classes.body} pos="relative">
          <Table verticalSpacing={2} horizontalSpacing="xs">
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
                      <Group gap="xs" grow>
                        <Button
                          size="xs"
                          variant="light"
                          onClick={() => setRetry((value) => value + 1)}
                        >
                          {t("Board.Analysis.RetryEngine")}
                        </Button>
                        {logsButton}
                      </Group>
                    </Stack>
                  </Table.Td>
                </Table.Tr>
              )}
              {error && (
                <Table.Tr>
                  <Table.Td>
                    <Text ta="center" my="xs">
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
                    <Text ta="center" my="xs">
                      {t("Board.Analysis.GameOver")}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
              {engineVariations && engineVariations.length === 0 && !isGameOver && (
                <Table.Tr>
                  <Table.Td>
                    <Text ta="center" my="xs">
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
                  [...Array(multiPv)].map((_, i) => (
                    <Table.Tr key={i}>
                      <Table.Td>
                        <Skeleton height={26} radius="xl" p={4} />
                      </Table.Td>
                    </Table.Tr>
                  ))
                ) : (
                  <Table.Tr>
                    <Table.Td>
                      <Text c="dimmed" size="sm" my={2}>
                        {t("Board.Analysis.InactiveEngine")}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              {!isGameOver &&
                !error &&
                searchedBoardFen &&
                engineVariations &&
                engineVariations.map((engineVariation, index) => (
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
                ))}
            </Table.Tbody>
          </Table>
        </Box>
      )}
    </Box>
  );
}

export default memo(BestMovesComponent, (prev, next) => {
  return (
    prev.id === next.id &&
    prev.engine === next.engine &&
    prev.fen === next.fen &&
    equal(prev.moves, next.moves) &&
    prev.halfMoves === next.halfMoves &&
    prev.orientation === next.orientation &&
    prev.mode === next.mode &&
    prev.canMoveUp === next.canMoveUp &&
    prev.canMoveDown === next.canMoveDown &&
    prev.canShowAsArea === next.canShowAsArea &&
    prev.onDragStart === next.onDragStart &&
    prev.onSuppressClick === next.onSuppressClick &&
    prev.onMoveUp === next.onMoveUp &&
    prev.onMoveDown === next.onMoveDown &&
    prev.onShowAsArea === next.onShowAsArea &&
    prev.onStartPlacing === next.onStartPlacing &&
    prev.onReturn === next.onReturn
  );
});
