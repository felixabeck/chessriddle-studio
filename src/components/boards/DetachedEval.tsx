import { Box, Group, Menu, Paper, Stack, Text, Tooltip, useMantineTheme } from "@mantine/core";
import { Check, Move, PinOff, Pause, Play } from "lucide-react";
import { useAtom, useAtomValue } from "jotai";
import { memo, useContext, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  currentDetachedEngineAtom,
  PINNED_PLACEMENTS,
  type PinnedPlacement,
  detachedEngineLinesAtom,
  detachedEnginePlacementAtom,
  enginesAtom,
} from "@/state/atoms";
import { getVariationLine } from "@/utils/chess";
import type { BestMoves } from "@/bindings";
import { engineMultiPv, setEngineMultiPv, type Engine } from "@/utils/engines";
import AssessmentSymbol from "../panels/analysis/AssessmentSymbol";
import { EngineLinePreviewMoves, useEngineLinePreview } from "../panels/analysis/EngineLinePreview";
import LinesSlider, { LINE_COUNT_OPTIONS } from "../panels/analysis/LinesSlider";
import { useDisplayedEngineLines } from "../panels/analysis/useDisplayedEngineLines";
import { useTabEngineSettings } from "../panels/analysis/useTabEngineSettings";
import { EngineScoreBubble } from "../panels/analysis/ScoreBubble";
import { ThreatBadge } from "../panels/analysis/ThreatBadge";
import classes from "./DetachedEval.module.css";
import IconAction from "../common/IconAction";
import { TreeStateContext } from "../common/TreeStateContext";

/** Moves rendered per line; the row clips whatever does not fit its width. */
const MOVES_PER_LINE = 12;

/**
 * Set by the position menu: the bar remounts in the chosen slot, so the new instance takes focus
 * on its own position button instead of leaving it on the body.
 */
let focusPositionOnMount = false;

/**
 * The pinned engine bar. The analysis board mounts it in every slot it can occupy; only the one
 * matching the stored placement renders, so the bar exists once.
 */
function DetachedEval({ placement }: { placement: PinnedPlacement }) {
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
  const positionRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focusPositionOnMount) return;
    focusPositionOnMount = false;
    positionRef.current?.focus();
  }, []);
  const theme = useMantineTheme();
  const moveTo = (next: PinnedPlacement) => {
    focusPositionOnMount = true;
    setPlacement(next);
    // A click is a discrete update, so the new slot mounts and runs its effect before this task
    // ends. When no slot mounts (board editing hides the notation slots), the flag must not leak
    // into a later, unrelated mount.
    setTimeout(() => {
      focusPositionOnMount = false;
    }, 0);
  };

  const { settings, setSettings } = useTabEngineSettings(engine);

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
          {threat && <ThreatBadge />}
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
        {settings.settings.some(
          (option) => option.name === "MultiPV" && option.type === "string",
        ) && (
          <Tooltip label={t("Engines.Settings.NumOfLines")}>
            <Box>
              <LinesSlider
                ariaLabel={t("Engines.Settings.NumOfLines")}
                value={Math.min(lineCap ?? multiPv, multiPv, LINE_COUNT_OPTIONS.length)}
                setValue={(count) => {
                  setLineCap(count);
                  setSettings((previous) =>
                    count > engineMultiPv(previous.settings)
                      ? { ...previous, settings: setEngineMultiPv(previous.settings, count) }
                      : previous,
                  );
                }}
              />
            </Box>
          </Tooltip>
        )}
        <Menu position="bottom-end" shadow="md">
          <Menu.Target>
            <IconAction label={t("Engine.Position")} size="sm" variant="subtle" ref={positionRef}>
              <Move size="0.875rem" />
            </IconAction>
          </Menu.Target>
          <Menu.Dropdown>
            {PINNED_PLACEMENTS.map((option) => {
              const label =
                option === "tabs"
                  ? t("Pinned.AboveTabs")
                  : option === "notation"
                    ? t("Pinned.AboveNotation")
                    : option === "belowNotation"
                      ? t("Pinned.BelowNotation")
                      : t("Pinned.BelowBoard");
              return (
                <Menu.Item
                  key={option}
                  aria-current={option === placement || undefined}
                  leftSection={
                    option === placement ? (
                      <Check size="0.875rem" />
                    ) : (
                      <Box w="0.875rem" aria-hidden />
                    )
                  }
                  onClick={() => {
                    if (option !== placement) moveTo(option);
                  }}
                >
                  {label}
                </Menu.Item>
              );
            })}
          </Menu.Dropdown>
        </Menu>
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
  const preview = useEngineLinePreview({
    fen,
    moves: line.sanMoves,
    visibleCount: MOVES_PER_LINE,
    orientation,
    anchor: ref,
    inert,
  });
  return (
    <Group ref={ref} gap="xs" wrap="nowrap">
      <EngineScoreBubble engineId={engineId} size="sm" score={line.score} inert={inert} />
      <Box className={classes.moves} onMouseLeave={preview.close}>
        <EngineLinePreviewMoves
          preview={preview}
          halfMoves={halfMoves}
          threat={threat}
          inert={inert}
        />
      </Box>
      {preview.board}
    </Group>
  );
}

export default memo(DetachedEval);
