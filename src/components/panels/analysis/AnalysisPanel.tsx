import { useTabAtom, useOwnerTabId } from "@/state/tabScope";
import { DragDropContext, Draggable, Droppable } from "@hello-pangea/dnd";
import {
  Accordion,
  Button,
  Card,
  Group,
  Paper,
  Popover,
  ScrollArea,
  Space,
  Stack,
  Tabs,
  Text,
} from "@mantine/core";
import { Play, Pause, ChevronsUpDown, Settings } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomValue } from "jotai";
import { memo, startTransition, useContext, useMemo, useOptimistic } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { IconAction } from "@/components/common/IconAction";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { useElementWidth } from "@/hooks/useElementWidth";
import { useRootFontPx } from "@/hooks/useRootFontPx";
import {
  allEnabledFamily,
  analysisTabFamily,
  expandedEnginesFamily,
  enableAllFamily,
  enginesAtom,
} from "@/state/atoms";
import { getVariationLine } from "@/utils/chess";
import { getPiecesCount, hasCaptures, isOp1, positionFromFen } from "@/utils/chessops";
import type { Engine } from "@/utils/engines";
import { getInitials } from "@/utils/format";
import BestMoves, { arrowColors } from "./BestMoves";
import EngineSelection from "./EngineSelection";
import LogsPanel from "./LogsPanel";
import ReportPanel from "./ReportPanel";
import { EngineScoreBubble } from "./ScoreBubble";
import TablebaseInfo from "./TablebaseInfo";
import { useDisplayedEngineLines } from "./useDisplayedEngineLines";
import classes from "./AnalysisPanel.module.css";

// The 16rem panel floor, tab list, margins and gap, with room for longer locale labels.
const COMPACT_ANALYSIS_PANE_REM = 26;

function AnalysisPanel() {
  const { t } = useTranslation();
  const { ref: paneRef, width: paneWidth } = useElementWidth();
  const rootFont = useRootFontPx();
  const compact = paneWidth > 0 && paneWidth <= COMPACT_ANALYSIS_PANE_REM * rootFont;

  const store = useContext(TreeStateContext)!;
  const rootFen = useStore(store, (s) => s.root.fen);
  const headers = useStore(store, (s) => s.headers);
  const currentNodeFen = useStore(
    store,
    useShallow((s) => s.currentNode().fen),
  );
  const moves = useStore(
    store,
    useShallow((s) => getVariationLine(s.root, s.position)),
  );
  const currentNodeHalfMoves = useStore(
    store,
    useShallow((s) => s.currentNode().halfMoves),
  );

  const [engines, setEngines] = useAtom(enginesAtom);
  const [optimisticOrder, setOptimisticOrder] = useOptimistic<string[], string[]>(
    (engines ?? []).filter((engine) => engine.loaded).map((engine) => engine.id),
    (_, order) => order,
  );

  const loadedEngines = useMemo(
    () => applyEngineOrder(engines ?? [], optimisticOrder).filter((e) => e.loaded),
    [engines, optimisticOrder],
  );

  const [, enable] = useAtom(enableAllFamily(useOwnerTabId()));
  const allEnabled = useAtomValue(allEnabledFamily(useOwnerTabId()));

  const [tab, setTab] = useAtom(useTabAtom(analysisTabFamily));
  const [expanded, setExpanded] = useAtom(useTabAtom(expandedEnginesFamily));

  const [pos] = positionFromFen(currentNodeFen);
  const navigate = useNavigate();

  return (
    <Stack h="100%" pl="xs" ref={paneRef} style={{ minWidth: 0, minHeight: 0 }}>
      <Tabs
        h="100%"
        orientation={compact ? "horizontal" : "vertical"}
        data-compact={compact || undefined}
        placement="right"
        value={tab}
        onChange={(v) => setTab(v!)}
        style={{
          display: "flex",
        }}
        keepMounted={false}
        classNames={{ root: classes.tabs, list: classes.sideTabs, panel: classes.panel }}
      >
        <Tabs.List>
          <Tabs.Tab value="engines">{t("Board.Analysis.Engines")}</Tabs.Tab>
          <Tabs.Tab value="report">{t("Board.Analysis.Report")}</Tabs.Tab>
          <Tabs.Tab value="logs" disabled={loadedEngines.length === 0}>
            {t("Board.Analysis.Logs")}
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel
          value="engines"
          style={{
            overflow: "hidden",
            display: tab === "engines" ? "flex" : "none",
            flexDirection: "column",
          }}
          pt="sm"
        >
          <ScrollArea
            offsetScrollbars
            onScrollPositionChange={() =>
              document.dispatchEvent(new Event("analysis-panel-scroll"))
            }
          >
            {pos &&
              (getPiecesCount(pos) <= 7 ||
                (getPiecesCount(pos) === 8 && (hasCaptures(pos) || isOp1(pos)))) && (
                <>
                  <TablebaseInfo fen={currentNodeFen} turn={pos.turn} />
                  <Space h="sm" />
                </>
              )}
            {loadedEngines.length > 1 && (
              <Paper withBorder p="xs" flex={1} className={classes.summary}>
                <Group w="100%" gap="xs" wrap="nowrap">
                  <IconAction
                    label={t(
                      allEnabled
                        ? "Board.Analysis.PauseAllEngines"
                        : "Board.Analysis.EnableAllEngines",
                    )}
                    size="lg"
                    variant="default"
                    onClick={() => enable(!allEnabled)}
                  >
                    {allEnabled ? <Pause size="1.25rem" /> : <Play size="1.25rem" />}
                  </IconAction>
                  <Group grow flex={1} gap="xs">
                    {loadedEngines.map((engine, i) => (
                      <EngineSummary
                        key={engine.id}
                        engine={engine}
                        fen={rootFen}
                        moves={moves}
                        shorten={loadedEngines.length > 3}
                        i={i}
                      />
                    ))}
                  </Group>
                </Group>
              </Paper>
            )}
            <Stack mt="sm">
              <Accordion
                variant="separated"
                multiple
                chevronSize={0}
                value={expanded ?? loadedEngines.map((e) => e.id)}
                onChange={(v) => setExpanded(v)}
                styles={{
                  label: {
                    paddingTop: 0,
                    paddingBottom: 0,
                  },
                  content: {
                    padding: "0.3rem",
                  },
                }}
              >
                <DragDropContext
                  onDragEnd={({ destination, source }) => {
                    if (destination?.index === undefined) return;
                    startTransition(async () => {
                      const order = loadedEngines.map((engine) => engine.id);
                      const [moved] = order.splice(source.index, 1);
                      order.splice(destination!.index, 0, moved);
                      setOptimisticOrder(order);
                      try {
                        await setEngines((current) => applyEngineOrder(current, order));
                      } catch (error) {
                        notifyUnlessCancelled(t("Common.Error"), error);
                      }
                    });
                  }}
                >
                  <Droppable droppableId="droppable" direction="vertical">
                    {(provided) => (
                      <div ref={provided.innerRef} {...provided.droppableProps}>
                        <Stack w="100%" gap="xs">
                          {loadedEngines.map((engine, i) => (
                            <Draggable key={engine.id} draggableId={engine.id} index={i}>
                              {(provided) => (
                                <div ref={provided.innerRef} {...provided.draggableProps}>
                                  <Accordion.Item value={engine.id} className={classes.engine}>
                                    <BestMoves
                                      id={i}
                                      engine={engine}
                                      fen={rootFen}
                                      moves={moves}
                                      halfMoves={currentNodeHalfMoves}
                                      dragHandleProps={provided.dragHandleProps}
                                      orientation={headers.orientation || "white"}
                                    />
                                  </Accordion.Item>
                                </div>
                              )}
                            </Draggable>
                          ))}
                        </Stack>

                        {provided.placeholder}
                      </div>
                    )}
                  </Droppable>
                </DragDropContext>
              </Accordion>
              <Group gap="xs">
                <Button
                  flex={1}
                  variant="default"
                  onClick={() => {
                    navigate({ to: "/engines" });
                  }}
                  leftSection={<Settings size="0.875rem" />}
                >
                  {t("Board.Analysis.ManageEngines")}
                </Button>
                <Popover width={250} position="top-end" shadow="md">
                  <Popover.Target>
                    <IconAction
                      label={t("Board.Analysis.SelectEngines")}
                      variant="default"
                      size="lg"
                    >
                      <ChevronsUpDown />
                    </IconAction>
                  </Popover.Target>

                  <Popover.Dropdown>
                    <EngineSelection />
                  </Popover.Dropdown>
                </Popover>
              </Group>
            </Stack>
          </ScrollArea>
        </Tabs.Panel>
        <Tabs.Panel
          value="report"
          pt="xs"
          style={{
            overflow: "hidden",
            display: tab === "report" ? "flex" : "none",
            flexDirection: "column",
          }}
        >
          <ReportPanel />
        </Tabs.Panel>
        <Tabs.Panel
          value="logs"
          pt="xs"
          style={{
            overflow: "hidden",
            display: tab === "logs" ? "flex" : "none",
            flexDirection: "column",
          }}
        >
          <LogsPanel />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

export function applyEngineOrder(engines: Engine[], order: string[]): Engine[] {
  const byId = new Map(
    engines.filter((engine) => engine.loaded).map((engine) => [engine.id, engine]),
  );
  const ordered = [...new Set(order)].flatMap((id) => {
    const engine = byId.get(id);
    if (!engine) return [];
    byId.delete(id);
    return [engine];
  });
  ordered.push(...byId.values());
  let index = 0;
  return engines.map((engine) => (engine.loaded ? ordered[index++] : engine));
}

export function EngineSummary({
  engine,
  fen,
  moves,
  shorten,
  i,
}: {
  engine: Engine;
  fen: string;
  moves: string[];
  shorten: boolean;
  i: number;
}) {
  const { t } = useTranslation();
  const { lines: curEval, dimmed, failure } = useDisplayedEngineLines(engine, fen, moves);
  const score = curEval && curEval.length > 0 ? curEval[0].score : null;

  return (
    <Card
      withBorder
      py={4}
      px="xs"
      className={classes.summaryChip}
      style={{ "--cf-engine-color": `var(--mantine-color-${arrowColors[i]?.strong ?? "gold"}-6)` }}
    >
      <Group gap="xs" wrap="nowrap" justify="center">
        <Text
          fw="bold"
          fz="xs"
          style={{
            whiteSpace: "nowrap",
            overflow: "hidden",
          }}
        >
          {(shorten && engine.name.length > 3) || engine.name.length > 10
            ? `${getInitials(engine.name)}.`
            : engine.name}
        </Text>
        {failure && (
          <Text fz="xs" c="danger" role="status">
            {t("Board.Analysis.EngineFailed")}
          </Text>
        )}
        {score ? (
          <Group opacity={dimmed ? 0.5 : 1} inert={dimmed}>
            <EngineScoreBubble engineId={engine.id} size="sm" score={score} inert={dimmed} />
          </Group>
        ) : (
          <Text fz="sm" c="dimmed">
            ???
          </Text>
        )}
      </Group>
    </Card>
  );
}

export default memo(AnalysisPanel);
