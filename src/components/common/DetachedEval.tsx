import { useOwnerTabId } from "@/state/tabScope";
import { Box, Group, Paper, Stack, Text, Tooltip, useMantineTheme } from "@mantine/core";
import { ArrowDownToLine, ArrowUpToLine, PinOff, Pause, Play } from "lucide-react";
import { useAtom, useAtomValue } from "jotai";
import { memo, useContext, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  currentDetachedEngineAtom,
  type DetachedEnginePlacement,
  detachedEngineLinesAtom,
  detachedEnginePlacementAtom,
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
import { EngineScoreBubble } from "../panels/analysis/ScoreBubble";
import classes from "./DetachedEval.module.css";
import IconAction from "./IconAction";
import { TreeStateContext } from "./TreeStateContext";

/** Moves rendered per line; the row clips whatever does not fit its width. */
const MOVES_PER_LINE = 12;

/**
 * Set by the swap button: the bar remounts in its other slot, so the new instance takes focus on
 * its own swap button instead of leaving it on the body.
 */
let focusSwapOnMount = false;

/**
 * The pinned engine bar. The analysis board mounts it in both slots it can occupy; only the one
 * matching the stored placement renders, so the bar exists once.
 */
function DetachedEval({ placement }: { placement: DetachedEnginePlacement }) {
  const [detachedEngineId, setDetachedEngineId] = useAtom(currentDetachedEngineAtom);
  const engines = useAtomValue(enginesAtom);
  const storedPlacement = useAtomValue(detachedEnginePlacementAtom);

  if (placement !== storedPlacement || !detachedEngineId || !engines) return null;

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
  const [placement, setPlacement] = useAtom(detachedEnginePlacementAtom);
  const swapRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focusSwapOnMount) return;
    focusSwapOnMount = false;
    swapRef.current?.focus();
  }, []);
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
    <Paper withBorder px="sm" py={6} data-testid="pinned-engine">
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
        <IconAction
          label={t(placement === "tabs" ? "Engine.MoveAboveNotation" : "Engine.MoveAboveTabs")}
          size="sm"
          variant="subtle"
          ref={swapRef}
          onClick={() => {
            focusSwapOnMount = true;
            setPlacement(placement === "tabs" ? "notation" : "tabs");
            // A click is a discrete update, so the new slot mounts and runs its effect before this
            // task ends. When no slot mounts (board editing hides the notation slot), the flag
            // must not leak into a later, unrelated mount.
            setTimeout(() => {
              focusSwapOnMount = false;
            }, 0);
          }}
        >
          {placement === "tabs" ? (
            <ArrowDownToLine size="0.875rem" />
          ) : (
            <ArrowUpToLine size="0.875rem" />
          )}
        </IconAction>
        <IconAction label={t("Engine.Unpin")} size="sm" variant="subtle" onClick={onClose}>
          <PinOff size="0.875rem" />
        </IconAction>
      </Group>
      {lineFen && shownLines.length > 0 && (
        <Stack gap={0} mt={4} opacity={dimmed ? 0.5 : 1} inert={dimmed}>
          {shownLines.map((line, lineIndex) => (
            <DetachedLine
              key={lineIndex}
              engineId={engine.id}
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
  engineId,
  line,
  fen,
  halfMoves,
  threat,
  orientation,
  inert,
}: {
  engineId: string;
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
      <EngineScoreBubble engineId={engineId} size="sm" score={line.score} inert={inert} />
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
