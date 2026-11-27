import { useOwnerTabId } from "@/state/tabScope";
import { Button, Group, Paper, ScrollArea, Space, Stack, Text } from "@mantine/core";
import { ChevronsUpDown, Pause, Play, Settings } from "lucide-react";
import { useAtom, useAtomValue } from "jotai";
import {
  memo,
  startTransition,
  useCallback,
  useContext,
  useMemo,
  useOptimistic,
  useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import AppPopover from "@/components/common/AppPopover";
import { IconAction } from "@/components/common/IconAction";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { BoardArrangementContext } from "@/components/tabs/BoardTabLayout";
import { useTabCommands } from "@/components/tabs/TabCommands";
import { allEnabledFamily, enableAllFamily, enginesAtom } from "@/state/atoms";
import { engineAreaId } from "@/state/boardArrangement";
import { getVariationLine } from "@/utils/chess";
import { getPiecesCount, hasCaptures, isOp1, positionFromFen } from "@/utils/chessops";
import type { Engine } from "@/utils/engines";
import BestMoves from "./BestMoves";
import { notifyAnalysisPanelScroll } from "./analysisPanelScroll";
import EngineSelection from "./EngineSelection";
import TablebaseInfo from "./TablebaseInfo";
import classes from "./AnalysisPanel.module.css";

function AnalysisPanel() {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);

  const {
    shownEngineAreas,
    arrangingAvailable,
    canTakeOutEngine,
    beginDrag,
    consumeSuppressedClick,
    startPlacing,
  } = useContext(BoardArrangementContext);

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

  const listedEngines = useMemo(
    () =>
      loadedEngines
        .map((engine, loadedIndex) => ({ engine, loadedIndex }))
        .filter(({ engine }) => !shownEngineAreas.has(engineAreaId(engine.id))),
    [loadedEngines, shownEngineAreas],
  );
  const listedIds = useMemo(() => listedEngines.map(({ engine }) => engine.id), [listedEngines]);

  const reorderListed = useCallback(
    (fromListedIndex: number, toListedIndex: number) => {
      if (
        fromListedIndex === toListedIndex ||
        fromListedIndex < 0 ||
        toListedIndex < 0 ||
        fromListedIndex >= listedIds.length ||
        toListedIndex >= listedIds.length
      ) {
        return;
      }
      const nextListedIds = [...listedIds];
      const [moved] = nextListedIds.splice(fromListedIndex, 1);
      nextListedIds.splice(toListedIndex, 0, moved);

      // Reinsert the reordered listed ids into the slots they occupy in the full loaded order.
      let cursor = 0;
      const listedSet = new Set(listedIds);
      const nextFullOrder = loadedEngines.map((engine) =>
        listedSet.has(engine.id) ? nextListedIds[cursor++] : engine.id,
      );

      startTransition(async () => {
        setOptimisticOrder(nextFullOrder);
        try {
          await setEngines((current) => applyEngineOrder(current, nextFullOrder));
        } catch (error) {
          notifyUnlessCancelled(t("Common.Error"), error);
        }
      });
    },
    [listedIds, loadedEngines, setEngines, setOptimisticOrder, t],
  );

  const [, enable] = useAtom(enableAllFamily(useOwnerTabId()));
  const allEnabled = useAtomValue(allEnabledFamily(useOwnerTabId()));

  const [pos] = positionFromFen(currentNodeFen);
  const { showPageTab } = useTabCommands();

  return (
    <Stack h="100%" pt="xs" pl="xs" style={{ minWidth: 0, minHeight: 0 }}>
      <ScrollArea h="100%" offsetScrollbars onScrollPositionChange={notifyAnalysisPanelScroll}>
        {pos &&
          (getPiecesCount(pos) <= 7 ||
            (getPiecesCount(pos) === 8 && (hasCaptures(pos) || isOp1(pos)))) && (
            <>
              <TablebaseInfo fen={currentNodeFen} turn={pos.turn} />
              <Space h="sm" />
            </>
          )}
        <Stack gap="xs" mr="xs">
          {listedEngines.length > 0 ? (
            <Stack ref={listRef} w="100%" gap="xs">
              {listedEngines.map(({ engine, loadedIndex }, listedIndex) => {
                const area = engineAreaId(engine.id);
                const canShowAsArea = arrangingAvailable && canTakeOutEngine(area);
                return (
                  <Paper
                    key={engine.id}
                    withBorder
                    className={classes.engine}
                    data-engine-card-id={engine.id}
                  >
                    <BestMoves
                      id={loadedIndex}
                      engine={engine}
                      fen={rootFen}
                      moves={moves}
                      halfMoves={currentNodeHalfMoves}
                      orientation={headers.orientation || "white"}
                      mode="panel"
                      onDragStart={(e) =>
                        beginDrag(area, e, {
                          listContainer: listRef.current,
                          reorderIds: listedIds,
                          onReorder: reorderListed,
                        })
                      }
                      onSuppressClick={consumeSuppressedClick}
                      canMoveUp={listedIndex > 0}
                      canMoveDown={listedIndex < listedEngines.length - 1}
                      onMoveUp={() => reorderListed(listedIndex, listedIndex - 1)}
                      onMoveDown={() => reorderListed(listedIndex, listedIndex + 1)}
                      canShowAsArea={canShowAsArea}
                      onShowAsArea={() => startPlacing(area, area)}
                    />
                  </Paper>
                );
              })}
            </Stack>
          ) : (
            loadedEngines.length > 0 && (
              <Text fz="sm" c="dimmed" ta="center" py="sm" data-testid="all-engines-pulled-out">
                {t("Board.Analysis.AllEnginesPulledOut")}
              </Text>
            )
          )}
          <Group gap="xs">
            {listedEngines.length > 0 && (
              <IconAction
                label={t(
                  allEnabled ? "Board.Analysis.PauseAllEngines" : "Board.Analysis.EnableAllEngines",
                )}
                size="lg"
                variant="default"
                onClick={() => enable(!allEnabled)}
              >
                {allEnabled ? <Pause size="1rem" /> : <Play size="1rem" />}
              </IconAction>
            )}
            <Button
              flex={1}
              variant="default"
              onClick={() => {
                void showPageTab("engines");
              }}
              leftSection={<Settings size="0.875rem" />}
            >
              {t("Board.Analysis.ManageEngines")}
            </Button>
            <AppPopover width={250} position="top-end" shadow="md">
              <AppPopover.Target>
                <IconAction label={t("Board.Analysis.SelectEngines")} variant="default" size="lg">
                  <ChevronsUpDown />
                </IconAction>
              </AppPopover.Target>

              <AppPopover.Dropdown>
                <EngineSelection />
              </AppPopover.Dropdown>
            </AppPopover>
          </Group>
        </Stack>
      </ScrollArea>
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

export default memo(AnalysisPanel);
