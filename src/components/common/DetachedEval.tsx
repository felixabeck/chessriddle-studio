import { useOwnerTabId } from "@/state/tabScope";
import { Box, Group, Paper, Stack, Text, Tooltip, useMantineTheme } from "@mantine/core";
import { PinOff, Pause, Play } from "lucide-react";
import { useAtom, useAtomValue } from "jotai";
import { memo, useContext } from "react";
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
import { engineMultiPv, type Engine } from "@/utils/engines";
import EngineLineMove from "../panels/analysis/EngineLineMove";
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
  } = useDisplayedEngineLines(engine, rootFen, moves, currentHalfMoves);

  const multiPv = engineMultiPv(settings.settings);
  const shownLines =
    engineVariations && !isGameOver ? engineVariations.slice(0, lineCap ?? undefined) : [];

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
      {shownLines.length > 0 && (
        <Stack gap={0} mt={4} opacity={dimmed ? 0.5 : 1} inert={dimmed}>
          {shownLines.map((line, lineIndex) => (
            <Group key={lineIndex} gap="xs" wrap="nowrap">
              <ScoreBubble size="sm" score={line.score} />
              <Box className={classes.moves}>
                {line.sanMoves.slice(0, MOVES_PER_LINE).map((san, index) => (
                  <EngineLineMove
                    key={index}
                    san={san}
                    index={index}
                    moves={line.sanMoves}
                    halfMoves={halfMoves}
                    threat={threat}
                    inert={dimmed}
                  />
                ))}
              </Box>
            </Group>
          ))}
        </Stack>
      )}
    </Paper>
  );
});

export default memo(DetachedEval);
