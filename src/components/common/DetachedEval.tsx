import { useOwnerTabId } from "@/state/tabScope";
import { Box, Group, Paper, Stack, Text, Tooltip, useMantineTheme } from "@mantine/core";
import { PinOff, Pause, Play } from "lucide-react";
import { useAtom, useAtomValue } from "jotai";
import { memo, useContext, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  currentDetachedEngineAtom,
  detachedEngineLinesAtom,
  enginesAtom,
  tabEngineSettingsFamily,
} from "@/state/atoms";
import { getVariationLine } from "@/utils/chess";
import type { BestMoves } from "@/bindings";
import { engineMultiPv, type Engine } from "@/utils/engines";
import AssessmentSymbol from "../panels/analysis/AssessmentSymbol";
import { engineLinePositions, PreviewEngineLineMove } from "../panels/analysis/EngineLinePreview";
import LinesSlider, { LINE_COUNT_OPTIONS } from "../panels/analysis/LinesSlider";
import { useDisplayedEngineLines } from "../panels/analysis/useDisplayedEngineLines";
import ScoreBubble from "../panels/analysis/ScoreBubble";
import classes from "./DetachedEval.module.css";
import IconAction from "./IconAction";
import { TreeStateContext } from "./TreeStateContext";

/** Moves rendered per line; the row clips whatever does not fit its width. */
const MOVES_PER_LINE = 12;

function DetachedEval() {
  const [detachedEngineId, setDetachedEngineId] = useAtom(currentDetachedEngineAtom);
  const engines = useAtomValue(enginesAtom);

  if (!detachedEngineId || !engines) return null;

  const engine = engines.find((e) => e.id === detachedEngineId);
  if (!engine || !engine.loaded) {
    return null;
  }

  return <DetachedEvalInner engine={engine} onClose={() => setDetachedEngineId(null)} />;
}

const DetachedEvalInner = memo(function DetachedEvalInner({
  engine,
  onClose,
}: {
  engine: Engine;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ownerTabId = useOwnerTabId();
  const store = useContext(TreeStateContext)!;
  const rootFen = useStore(store, (s) => s.root.fen);
  const moves = useStore(
    store,
    useShallow((s) => getVariationLine(s.root, s.position)),
  );
  const currentHalfMoves = useStore(store, (s) => s.currentNode().halfMoves);
  const orientation = useStore(store, (s) => s.headers.orientation || "white");
  const [lineCap, setLineCap] = useAtom(detachedEngineLinesAtom);
  const theme = useMantineTheme();

  const [settings, setSettings] = useAtom(
    tabEngineSettingsFamily({
      engineId: engine.id,
      defaultSettings: engine.settings ?? undefined,
      defaultGo: engine.go ?? undefined,
      tab: ownerTabId,
    }),
  );

  const {
    lines: engineVariations,
    dimmed,
    failure,
    isGameOver,
    threat,
    halfMoves,
    searchedBoardFen,
  } = useDisplayedEngineLines(engine, rootFen, moves, currentHalfMoves);

  const multiPv = engineMultiPv(settings.settings);
  // Lines are replayed from the board they were searched on; like the full panel, none
  // render without it.
  const lineFen = searchedBoardFen;
  const shownLines =
    engineVariations && !isGameOver && lineFen
      ? engineVariations.slice(0, lineCap ?? undefined)
      : [];

  return (
    <Paper withBorder px="sm" py={6}>
      <Group gap="xs" wrap="nowrap" justify="space-between">
        <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
          <IconAction
            label={t(settings.enabled ? "Engine.PauseAnalysis" : "Engine.StartAnalysis")}
            size="sm"
            variant={settings.enabled ? "filled" : "transparent"}
            color={theme.primaryColor}
            onClick={() => setSettings((s) => ({ ...s, enabled: !s.enabled }))}
            pressed={settings.enabled}
          >
            {settings.enabled ? <Pause size="0.875rem" /> : <Play size="0.875rem" />}
          </IconAction>
          <Text fw={700} fz="sm" style={{ whiteSpace: "nowrap" }}>
            {engine.name}
          </Text>
          {failure && (
            <Text fz="xs" c="danger" role="status">
              {t("Board.Analysis.EngineFailed")}
            </Text>
          )}
          {shownLines.length > 0 && (
            <Group gap="xs" wrap="nowrap" opacity={dimmed ? 0.5 : 1} className={classes.stats}>
              <Text fz="xs" fw={700} tt="uppercase" c="dimmed">
                {t("GoMode.Depth")}
              </Text>
              <Text fz="sm" fw={700}>
                {shownLines[0].depth}
              </Text>
              <AssessmentSymbol score={shownLines[0].score.value} fz="md" />
            </Group>
          )}
          {shownLines.length === 0 && (
            <Text fz="xs" c="dimmed" lh={"1.6rem"}>
              {isGameOver ? t("Board.Analysis.GameOver") : "—"}
            </Text>
          )}
        </Group>
        {multiPv > 1 && (
          <Tooltip label={t("Engines.Settings.NumOfLines")}>
            <Box>
              <LinesSlider
                ariaLabel={t("Engines.Settings.NumOfLines")}
                value={Math.min(lineCap ?? multiPv, multiPv, LINE_COUNT_OPTIONS.length)}
                setValue={setLineCap}
                max={multiPv}
              />
            </Box>
          </Tooltip>
        )}
        <IconAction label={t("Engine.Unpin")} size="sm" variant="subtle" onClick={onClose}>
          <PinOff size="0.875rem" />
        </IconAction>
      </Group>
      {lineFen && shownLines.length > 0 && (
        <Stack gap={0} mt={4} opacity={dimmed ? 0.5 : 1} inert={dimmed}>
          {shownLines.map((line, lineIndex) => (
            <DetachedLine
              key={lineIndex}
              line={line}
              fen={lineFen}
              halfMoves={halfMoves}
              threat={threat}
              orientation={orientation}
              inert={dimmed}
            />
          ))}
        </Stack>
      )}
    </Paper>
  );
});

/** One pinned engine line: its score and moves, each previewing its position on hover. */
function DetachedLine({
  line,
  fen,
  halfMoves,
  threat,
  orientation,
  inert,
}: {
  line: BestMoves;
  fen: string;
  halfMoves: number;
  threat: boolean;
  orientation: "white" | "black";
  inert: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const positions = engineLinePositions(fen, line.sanMoves.slice(0, MOVES_PER_LINE));
  return (
    <Group ref={ref} gap="xs" wrap="nowrap">
      <ScoreBubble size="sm" score={line.score} />
      <Box className={classes.moves}>
        {positions.map((move, index) => (
          <PreviewEngineLineMove
            key={index}
            move={move}
            index={index}
            moves={line.sanMoves}
            halfMoves={halfMoves}
            threat={threat}
            orientation={orientation}
            anchor={ref}
            inert={inert}
          />
        ))}
      </Box>
    </Group>
  );
}

export default memo(DetachedEval);
