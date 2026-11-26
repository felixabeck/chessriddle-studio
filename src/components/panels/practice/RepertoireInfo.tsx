import { useOwnerTab } from "@/state/tabScope";
import {
  Alert,
  Box,
  Button,
  Divider,
  Group,
  Loader,
  Paper,
  Progress,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { Check, ChevronDown, ChevronRight, FileText, Flag, Info, Play } from "lucide-react";
import { useAtomValue } from "jotai";
import { useCallback, useContext, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { isTreeViewDeferred, useTreeView } from "@/state/deferredTreeView";
import { ResultBar } from "@/components/common/ResultBar";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { TreeStatsBar } from "@/components/common/TreeStatsBar";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { coverageMinGamesAtom } from "@/state/atoms";
import { formatMoveNumber, roundKeepSum } from "@/utils/format";
import { isPrefix } from "@/utils/misc";
import { isUserToMove } from "@/utils/practiceScope";
import { findBiggestGap, findNextGap, type PositionMove } from "@/utils/repertoire";
import {
  getBoardState,
  getMemoizedBoardStateMap,
  getNodeAtPath,
  type TreeNode,
} from "@/utils/treeReducer";
import { useReferenceMoves } from "./useReferenceMoves";
import {
  PracticeStatisticsProvider,
  usePracticeStatisticsContext,
  type CoverageStatus,
} from "./usePracticeStatistics";
import { ImportIntoRepertoireModal } from "./ImportIntoRepertoireModal";
import classes from "./RepertoireInfo.module.css";
import paneClasses from "@/components/common/PaneTabs.module.css";

function formatMoveNotation(halfMoves: number, san: string): string {
  return `${formatMoveNumber(halfMoves)} ${san}`;
}

function RepertoireInfo() {
  const statistics = usePracticeStatisticsContext();
  if (!statistics) {
    // Standalone mount (no Practice panel above) owns the statistics fetch here.
    return (
      <PracticeStatisticsProvider>
        <RepertoireInfoView />
      </PracticeStatisticsProvider>
    );
  }
  return <RepertoireInfoView />;
}

function RepertoireInfoView() {
  const { t } = useTranslation();
  const errorTitle = t("Common.Error");
  const commonErrorRef = useRef(errorTitle);
  commonErrorRef.current = errorTitle;
  const store = useContext(TreeStateContext)!;
  const view = useTreeView(store);
  const { root, headers } = view;
  const position = useStore(store, (s) => s.position);
  const currentNode = useStore(store, (s) => s.currentNode());
  const goToMove = useCallback(
    (path: number[]) => {
      if (store.getState().root === root) store.getState().goToMove(path);
    },
    [store, root],
  );
  const makeMove = useStore(store, (s) => s.makeMove);
  const makeMoves = useStore(store, (s) => s.makeMoves);
  const setStart = useStore(store, (s) => s.setStart);

  const statistics = usePracticeStatisticsContext()!;
  const {
    statisticsResult: coverageResult,
    statisticsStatus: coverageStatus,
    coverageMap,
    retryStatistics: retryCoverage,
    referenceDb,
    selectedReference,
    selectedReferenceKey,
    referenceKey,
    currencyGeneration,
    currencyStatus,
    currencyError,
    currencyPending,
  } = statistics;
  const [currentTab] = useOwnerTab();
  const minGames = useAtomValue(coverageMinGamesAtom);

  const orientation = useMemo(() => headers.orientation || "white", [headers.orientation]);

  const { dbMovesMap, replaceMoves } = useReferenceMoves({
    currentFen: currentNode.fen,
    referenceDb,
    selectedReferenceKey,
    referenceKey,
    currencyGeneration,
    currencyStatus,
    currencyError,
    currencyPending,
    errorTitle,
  });
  const seededCoverageResult = useRef<typeof coverageResult>(null);
  if (coverageResult && seededCoverageResult.current !== coverageResult) {
    seededCoverageResult.current = coverageResult;
    replaceMoves(coverageResult.dbMovesMap);
  }

  const startPath = useMemo(() => headers.start || [], [headers.start]);
  const boardStateMap = useMemo(() => {
    if (isTreeViewDeferred(store)) return {};
    return getMemoizedBoardStateMap(root, startPath);
  }, [root, startPath, store]);
  const hasStart = headers.start != null && headers.start.length > 0;
  const isBeforeStart =
    hasStart && position.length < startPath.length && isPrefix(position, startPath);
  const isEmptyTree = root.children.length === 0;

  const nodeToPath = useMemo(() => {
    const map = new Map<TreeNode, number[]>();
    for (const entries of Object.values(boardStateMap)) {
      for (const { node, path } of entries) {
        map.set(node, path);
      }
    }
    return map;
  }, [boardStateMap]);

  const transpositionMoves = useMemo(() => {
    const boardFen = getBoardState(currentNode.fen);
    const entries = boardStateMap[boardFen] || [];
    const moveMap = new Map<string, number[]>();
    for (const { node, path } of entries) {
      if (!isPrefix(startPath, path)) continue;
      for (const child of node.children) {
        if (child.san && !moveMap.has(child.san)) {
          const childPath = nodeToPath.get(child);
          if (childPath && isPrefix(startPath, childPath)) {
            moveMap.set(child.san, childPath);
          }
        }
      }
    }
    return moveMap;
  }, [currentNode.fen, boardStateMap, nodeToPath, startPath]);

  const positionMoves = useMemo(() => {
    const boardFen = getBoardState(currentNode.fen);
    const dbData = dbMovesMap.get(boardFen);
    const movesFromDb = dbData?.moves ?? [];
    const total = dbData?.total ?? 0;

    const dbMoveMap = new Map(movesFromDb.map((m) => [m.move, m]));

    const allMoves: PositionMove[] = [];
    const seenSans = new Set<string>();

    // Prepared moves (always available)
    for (const [san, targetPath] of transpositionMoves) {
      const dbMove = dbMoveMap.get(san);
      const games = dbMove ? dbMove.white + dbMove.draw + dbMove.black : 0;
      const coveragePath = targetPath.join(",");
      const coverage = coverageMap?.get(coveragePath) ?? 0;
      seenSans.add(san);
      allMoves.push({
        san,
        games,
        totalGames: total,
        frequency: total > 0 ? games / total : 0,
        white: dbMove ? (games > 0 ? dbMove.white / games : 0) : 0,
        draw: dbMove ? (games > 0 ? dbMove.draw / games : 0) : 0,
        black: dbMove ? (games > 0 ? dbMove.black / games : 0) : 0,
        inRepertoire: true,
        coverage,
        path: targetPath,
      });
    }

    // DB moves not in repertoire
    for (const dbMove of movesFromDb) {
      if (!seenSans.has(dbMove.move)) {
        const games = dbMove.white + dbMove.draw + dbMove.black;
        allMoves.push({
          san: dbMove.move,
          games,
          totalGames: total,
          frequency: total > 0 ? games / total : 0,
          white: games > 0 ? dbMove.white / games : 0,
          draw: games > 0 ? dbMove.draw / games : 0,
          black: games > 0 ? dbMove.black / games : 0,
          inRepertoire: false,
          coverage: 0,
          path: [],
        });
      }
    }

    return allMoves.sort((a, b) => b.frequency - a.frequency);
  }, [currentNode.fen, dbMovesMap, transpositionMoves, coverageMap]);

  const isUserTurn = isUserToMove(currentNode.halfMoves, orientation);

  const handleMoveClick = useCallback(
    (move: PositionMove) => {
      if (store.getState().root !== root) return;
      if (move.inRepertoire && move.path.length > 0) {
        goToMove(move.path);
      } else {
        makeMove({ payload: move.san });
      }
    },
    [goToMove, makeMove, store, root],
  );

  const nextGap = useMemo(
    () =>
      coverageResult
        ? findNextGap(
            root,
            position,
            orientation,
            coverageResult.coverageMap,
            coverageResult.gamesMap,
            minGames,
          )
        : null,
    [root, position, orientation, coverageResult, minGames],
  );

  const biggestGap = useMemo(
    () =>
      coverageResult
        ? findBiggestGap(
            root,
            orientation,
            coverageResult.coverageMap,
            coverageResult.gamesMap,
            coverageResult.missingGamesMap,
            minGames,
            startPath,
          )
        : null,
    [root, orientation, coverageResult, startPath, minGames],
  );

  const [importOpen, setImportOpen] = useState(false);

  if (!currentTab) return null;

  const importPgnButton = (
    <Button
      variant="default"
      size="xs"
      leftSection={<FileText size={16} />}
      onClick={() => setImportOpen(true)}
    >
      {t("Board.Practice.Build.ImportPgn")}
    </Button>
  );

  return (
    <>
      {!referenceDb ? (
        <Stack h="100%" p="sm" className={`${paneClasses.root} ${paneClasses.content}`}>
          <TreeStatsBar store={store} />
          <Alert icon={<Info />} color={selectedReference ? "warning" : undefined}>
            {selectedReference
              ? t("Collections.Unavailable", {
                  defaultValue:
                    "The search index is unavailable. Retry, or select the collection's source file again.",
                })
              : t("Board.Practice.Build.NoRefDb")}
          </Alert>
          {importPgnButton}
        </Stack>
      ) : (
        <Stack h="100%" p="sm" gap={0} className={`${paneClasses.root} ${paneClasses.content}`}>
          {isBeforeStart && (
            <Paper p="sm" my="sm" withBorder>
              <Stack gap="xs">
                <Text fz="xs" c="dimmed">
                  {t("Board.Practice.Build.BeforeStart")}
                </Text>
                <Button
                  leftSection={<Play size={16} />}
                  variant="light"
                  size="xs"
                  onClick={() => goToMove(startPath)}
                >
                  {t("Board.Practice.Build.GoToStart")}
                </Button>
              </Stack>
            </Paper>
          )}

          {!hasStart && !isEmptyTree && (
            <Paper p="sm" my="sm" withBorder>
              <Stack gap="xs">
                <Text fz="xs" c="dimmed">
                  {t("Board.Practice.MarkStart")}
                </Text>
                <Button
                  leftSection={<Flag size={16} />}
                  variant="light"
                  size="xs"
                  onClick={() => setStart(position)}
                >
                  {t("Board.Practice.Build.SetAsStart")}
                </Button>
              </Stack>
            </Paper>
          )}

          {isEmptyTree && position.length === 0 && (
            <Paper p="sm" my="sm" withBorder>
              <Stack gap="xs">
                <Text fz="sm" fw={600}>
                  {t("Board.Practice.Build.Presets")}
                </Text>
                <Text fz="xs" c="dimmed">
                  {t("Board.Practice.Build.PresetsDesc")}
                </Text>
                <Stack gap={4}>
                  {(orientation === "white"
                    ? [
                        {
                          name: "Italian Game",
                          moves: ["e4", "e5", "Nf3", "Nc6", "Bc4"],
                        },
                        {
                          name: "Ruy Lopez",
                          moves: ["e4", "e5", "Nf3", "Nc6", "Bb5"],
                        },
                        { name: "Catalan", moves: ["d4", "Nf6", "c4", "e6", "g3"] },
                      ]
                    : [
                        { name: "French Defense", moves: ["e4", "e6", "d4", "d5"] },
                        { name: "King's Indian", moves: ["d4", "Nf6", "c4", "g6"] },
                        {
                          name: "Najdorf",
                          moves: [
                            "e4",
                            "c5",
                            "Nf3",
                            "d6",
                            "d4",
                            "cxd4",
                            "Nxd4",
                            "Nf6",
                            "Nc3",
                            "a6",
                          ],
                        },
                      ]
                  ).map((preset) => (
                    <Button
                      key={preset.name}
                      variant="default"
                      size="xs"
                      justify="start"
                      onClick={() => {
                        const result = makeMoves({ payload: preset.moves });
                        if (!result.success) {
                          notifyUnlessCancelled(commonErrorRef.current, result.error);
                          return;
                        }
                        setStart(store.getState().position);
                      }}
                    >
                      {preset.name}
                    </Button>
                  ))}
                </Stack>
              </Stack>
            </Paper>
          )}

          {isEmptyTree && <Box my="xs">{importPgnButton}</Box>}

          <MovesView
            isUserTurn={isUserTurn}
            currentNode={currentNode}
            positionMoves={positionMoves}
            coverageMap={coverageMap}
            coverageStatus={coverageStatus}
            onRetryCoverage={retryCoverage}
            root={root}
            nextGap={nextGap}
            biggestGap={biggestGap}
            goToMove={goToMove}
            onMoveClick={handleMoveClick}
            t={t}
            minGames={minGames}
            boardStateMap={boardStateMap}
            nodeToPath={nodeToPath}
            startPath={startPath}
          />

          <Divider pb="sm" />
          <TreeStatsBar store={store} />
          {!isEmptyTree && <Box mt="xs">{importPgnButton}</Box>}
        </Stack>
      )}
      <ImportIntoRepertoireModal opened={importOpen} onClose={() => setImportOpen(false)} />
    </>
  );
}

type TResponse = {
  san: string;
  halfMoves: number;
  childPath: number[];
  coverage: number;
  dbGames: number;
  dbFrequency: number;
  white: number;
  draw: number;
  black: number;
};

function MovesView({
  isUserTurn,
  currentNode,
  positionMoves,
  coverageMap,
  coverageStatus,
  onRetryCoverage,
  root,
  nextGap,
  biggestGap,
  goToMove,
  onMoveClick,
  t,
  minGames,
  boardStateMap,
  nodeToPath,
  startPath,
}: {
  isUserTurn: boolean;
  currentNode: TreeNode;
  positionMoves: PositionMove[];
  coverageMap: Map<string, number> | undefined;
  coverageStatus: CoverageStatus;
  onRetryCoverage: () => void;
  root: TreeNode;
  nextGap: number[] | null;
  biggestGap: number[] | null;
  goToMove: (path: number[]) => void;
  onMoveClick: (move: PositionMove) => void;
  t: ReturnType<typeof useTranslation>["t"];
  minGames: number;
  boardStateMap: Record<string, { node: TreeNode; path: number[] }[]>;
  nodeToPath: Map<TreeNode, number[]>;
  startPath: number[];
}) {
  const unifiedUserResponses: TResponse[] = useMemo(() => {
    if (!isUserTurn) return [];
    const boardFen = getBoardState(currentNode.fen);
    const entries = boardStateMap[boardFen] || [];
    const seenSans = new Set<string>();
    const responses: TResponse[] = [];

    for (const { node, path } of entries) {
      if (!isPrefix(startPath, path)) continue;
      for (const child of node.children) {
        if (child.san && !seenSans.has(child.san)) {
          const childPath = nodeToPath.get(child);
          if (childPath && isPrefix(startPath, childPath)) {
            seenSans.add(child.san);
            const coveragePath = childPath.join(",");
            const coverage = coverageMap?.get(coveragePath) ?? 0;
            const dbEntry = positionMoves.find((pm) => pm.san === child.san);
            responses.push({
              san: child.san,
              halfMoves: child.halfMoves,
              childPath,
              coverage,
              dbGames: dbEntry?.games ?? 0,
              dbFrequency: dbEntry?.frequency ?? 0,
              white: dbEntry?.white ?? 0,
              draw: dbEntry?.draw ?? 0,
              black: dbEntry?.black ?? 0,
            });
          }
        }
      }
    }
    return responses;
  }, [
    isUserTurn,
    currentNode.fen,
    boardStateMap,
    nodeToPath,
    coverageMap,
    positionMoves,
    startPath,
  ]);

  const hasResponses = unifiedUserResponses.length > 0;
  const [showRare, setShowRare] = useState(false);

  const relevantMoves = useMemo(
    () => (isUserTurn ? [] : positionMoves.filter((m) => m.games >= minGames)),
    [isUserTurn, positionMoves, minGames],
  );

  const rareMoves = useMemo(
    () => (isUserTurn ? [] : positionMoves.filter((m) => m.games < minGames)),
    [isUserTurn, positionMoves, minGames],
  );

  const nextGapLabel = useMemo(() => {
    if (!nextGap) return null;
    const node = getNodeAtPath(root, nextGap);
    return node.san ? formatMoveNotation(node.halfMoves, node.san) : null;
  }, [nextGap, root]);

  const biggestGapLabel = useMemo(() => {
    if (!biggestGap) return null;
    const node = getNodeAtPath(root, biggestGap);
    return node.san ? formatMoveNotation(node.halfMoves, node.san) : null;
  }, [biggestGap, root]);

  const title = isUserTurn
    ? t("Board.Practice.Build.YourResponse")
    : t("Board.Practice.Build.OpponentMoves");
  const coverageLoading = coverageStatus === "loading";
  const coverageKnown = coverageStatus === "success";
  const feedback = (
    <CoverageFeedback
      status={coverageStatus}
      onRetry={onRetryCoverage}
      nextGap={nextGap}
      biggestGap={biggestGap}
      nextGapLabel={nextGapLabel}
      biggestGapLabel={biggestGapLabel}
      hasMoves={isUserTurn ? hasResponses : positionMoves.length > 0}
      complete={coverageKnown && coverageMap?.get(startPath.join(",")) === 1}
      goToMove={goToMove}
      t={t}
    />
  );

  if (positionMoves.length === 0 && !hasResponses) {
    return (
      <ScrollArea
        className={paneClasses.scroll}
        classNames={{ content: paneClasses.scrollContent }}
        pt="sm"
      >
        <Stack gap="md">
          <Stack align="center" py="xl">
            <Text c="dimmed" fz="sm">
              {t("Board.Practice.Build.NoMovesFound")}
            </Text>
          </Stack>
          {feedback}
        </Stack>
      </ScrollArea>
    );
  }

  return (
    <ScrollArea
      className={paneClasses.scroll}
      classNames={{ content: paneClasses.scrollContent }}
      pt="sm"
    >
      <Stack gap="md">
        <Stack gap={0}>
          <Group justify="space-between" mb={4} px="xs">
            <Text fz="xs" fw={600} style={{ flex: 1 }}>
              {title}
            </Text>
            <Group gap="xs" wrap="nowrap">
              <Text fz="xs" c="dimmed" w={50} ta="center">
                %
              </Text>
              <Text fz="xs" c="dimmed" w={70} ta="center">
                {t("Common.Games")}
              </Text>
              <Text fz="xs" c="dimmed" w={100} ta="center">
                {t("Board.Practice.Build.Results")}
              </Text>
              {(!isUserTurn || hasResponses || coverageLoading) && (
                <Group gap={4} w={100} justify="center" wrap="nowrap">
                  <Text fz="xs" c="dimmed" ta="center">
                    {t("Board.Practice.Build.YourCoverage")}
                  </Text>
                  {coverageLoading && <Loader size={10} />}
                </Group>
              )}
            </Group>
          </Group>

          {isUserTurn &&
            hasResponses &&
            unifiedUserResponses.map((response) => (
              <MoveRow
                key={response.san}
                move={{
                  san: response.san,
                  games: response.dbGames,
                  totalGames: 0,
                  frequency: response.dbFrequency,
                  white: response.white,
                  draw: response.draw,
                  black: response.black,
                  inRepertoire: true,
                  coverage: response.coverage,
                  path: response.childPath,
                }}
                halfMoves={response.halfMoves}
                onClick={() => goToMove(response.childPath)}
                dimmed={false}
                showCoverage
                coverageKnown={coverageKnown}
                minGames={minGames}
              />
            ))}

          {isUserTurn &&
            !hasResponses &&
            positionMoves.map((move) => (
              <MoveRow
                key={move.san}
                move={move}
                halfMoves={currentNode.halfMoves + 1}
                onClick={() => onMoveClick(move)}
                dimmed={false}
                showCoverage={false}
                minGames={minGames}
              />
            ))}

          {!isUserTurn &&
            relevantMoves.map((move) => (
              <MoveRow
                key={move.san}
                move={move}
                halfMoves={currentNode.halfMoves + 1}
                onClick={() => onMoveClick(move)}
                dimmed={false}
                coverageKnown={coverageKnown}
                minGames={minGames}
              />
            ))}

          {!isUserTurn && rareMoves.length > 0 && relevantMoves.length > 0 && (
            <UnstyledButton
              onClick={() => setShowRare((v) => !v)}
              px="xs"
              py={6}
              style={{ width: "100%" }}
            >
              <Group gap="xs" justify="center">
                <Divider style={{ flex: 1 }} />
                <Group gap={4} wrap="nowrap">
                  {showRare ? (
                    <ChevronDown size={12} color="var(--mantine-color-dimmed)" />
                  ) : (
                    <ChevronRight size={12} color="var(--mantine-color-dimmed)" />
                  )}
                  <Text fz="xs" c="dimmed">
                    {t("Board.Practice.Build.RareMoves")}
                  </Text>
                </Group>
                <Divider style={{ flex: 1 }} />
              </Group>
            </UnstyledButton>
          )}

          {!isUserTurn &&
            (showRare || relevantMoves.length === 0) &&
            rareMoves.map((move) => (
              <MoveRow
                key={move.san}
                move={move}
                halfMoves={currentNode.halfMoves + 1}
                onClick={() => onMoveClick(move)}
                dimmed
                coverageKnown={coverageKnown}
                minGames={minGames}
              />
            ))}
        </Stack>

        {feedback}
      </Stack>
    </ScrollArea>
  );
}

function CoverageFeedback({
  status,
  onRetry,
  nextGap,
  biggestGap,
  nextGapLabel,
  biggestGapLabel,
  hasMoves,
  complete,
  goToMove,
  t,
}: {
  status: CoverageStatus;
  onRetry: () => void;
  nextGap: number[] | null;
  biggestGap: number[] | null;
  nextGapLabel: string | null;
  biggestGapLabel: string | null;
  hasMoves: boolean;
  complete: boolean;
  goToMove: (path: number[]) => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  if (status === "absent") return null;
  if (status === "loading") {
    return (
      <>
        <Divider />
        <Group justify="center" py="sm" gap="xs">
          <Loader size={12} />
          <Text fz="xs" c="dimmed">
            {t("Board.Practice.Build.Loading")}
          </Text>
        </Group>
      </>
    );
  }
  if (status === "error") {
    return (
      <Alert
        className={paneClasses.feedback}
        classNames={{ body: paneClasses.feedbackBody }}
        color="danger"
        title={t("Common.Error")}
      >
        <Button
          className={paneClasses.feedbackButton}
          classNames={{ label: paneClasses.feedbackLabel }}
          variant="light"
          size="xs"
          onClick={onRetry}
        >
          {t("Common.Retry")}
        </Button>
      </Alert>
    );
  }
  if (nextGap || biggestGap) {
    return (
      <>
        <Divider />
        <Stack gap={0}>
          {nextGap && (
            <GapButton
              label={t("Board.Practice.Build.NextGap")}
              detail={nextGapLabel}
              onClick={() => goToMove(nextGap)}
            />
          )}
          {biggestGap && (
            <GapButton
              label={t("Board.Practice.Build.BiggestGap")}
              detail={biggestGapLabel}
              onClick={() => goToMove(biggestGap)}
            />
          )}
        </Stack>
      </>
    );
  }
  if (!hasMoves || !complete) return null;
  return (
    <>
      <Divider />
      <Paper p="sm" withBorder>
        <Group gap="xs" justify="center">
          <ThemeIcon size="sm" color="success" variant="light" radius="xl">
            <Check size={14} />
          </ThemeIcon>
          <Text fz="sm" c="success" fw={500}>
            {t("Board.Practice.Build.NoGapsFound")}
          </Text>
        </Group>
      </Paper>
    </>
  );
}

function getCoverageColor(coverage: number): string {
  if (coverage <= 0) return "gray";
  if (coverage < 0.33) return "danger";
  if (coverage < 0.67) return "warning";
  return "success";
}

const MOVE_ROW_LABEL_MIN_PERCENT = 20;

function MoveRow({
  move,
  halfMoves,
  onClick,
  dimmed,
  showCoverage = true,
  coverageKnown,
  minGames,
}: {
  move: PositionMove;
  halfMoves: number;
  onClick: () => void;
  dimmed: boolean;
  showCoverage?: boolean;
  coverageKnown?: boolean;
  minGames: number;
}) {
  const { t } = useTranslation();
  const notation = formatMoveNotation(halfMoves, move.san);
  const coverageColor = getCoverageColor(move.coverage);
  const pct = move.frequency > 0 ? `${(move.frequency * 100).toFixed(0)}%` : "—";
  const [wPct, dPct, bPct] = roundKeepSum([move.white * 100, move.draw * 100, move.black * 100]);
  const segmentLabel = (share: number) =>
    share > MOVE_ROW_LABEL_MIN_PERCENT ? String(share) : undefined;

  return (
    <UnstyledButton
      onClick={onClick}
      py="sm"
      px="xs"
      className={classes.moveRow}
      style={{
        borderBottom: "1px solid var(--cf-border)",
        borderRadius: 0,
        opacity: dimmed ? 0.45 : 1,
      }}
    >
      <Group justify="space-between" wrap="nowrap">
        <Group gap="sm" style={{ flex: 1, minWidth: 0 }}>
          <Text fw={700} fz="sm">
            {notation}
          </Text>
          {move.inRepertoire && (
            <ThemeIcon size="xs" color="success" variant="transparent">
              <Check size={12} />
            </ThemeIcon>
          )}
        </Group>

        <Group gap="xs" wrap="nowrap">
          <Text fz="sm" c="dimmed" w={50} ta="center">
            {pct}
          </Text>
          <Text fz="sm" c="dimmed" w={70} ta="center">
            {move.games > 0 ? move.games.toLocaleString() : "—"}
          </Text>
          <Tooltip
            label={t("Board.Practice.ResultDistribution", {
              white: wPct,
              draw: dPct,
              black: bPct,
            })}
            position="top"
            withArrow
          >
            <ResultBar
              size="xl"
              w={100}
              segments={[
                {
                  value: wPct,
                  color: "var(--cf-eval-bar-light)",
                  label: segmentLabel(wPct),
                  labelColor: "var(--cf-eval-bar-dark)",
                },
                {
                  value: dPct,
                  color: "var(--cf-chart-4)",
                  label: segmentLabel(dPct),
                },
                {
                  value: bPct,
                  color: "var(--cf-eval-bar-dark)",
                  label: segmentLabel(bPct),
                },
              ]}
            />
          </Tooltip>
          {showCoverage && (
            <Box w={100}>
              {!coverageKnown ? (
                <Text fz="xs" c="dimmed" ta="center">
                  —
                </Text>
              ) : dimmed || move.games < minGames ? (
                <Tooltip label={t("Board.Practice.Build.RareTooltip")} withArrow>
                  <Text fz="xs" c="dimmed" ta="center">
                    {t("Common.NotAvailable")}
                  </Text>
                </Tooltip>
              ) : (
                <Progress
                  value={move.inRepertoire ? Math.max(move.coverage * 100, 3) : 0}
                  color={coverageColor}
                  size="sm"
                  radius="xl"
                />
              )}
            </Box>
          )}
        </Group>
      </Group>
    </UnstyledButton>
  );
}

function GapButton({
  label,
  detail,
  onClick,
}: {
  label: string;
  detail: string | null;
  onClick: () => void;
}) {
  return (
    <UnstyledButton
      onClick={onClick}
      py="sm"
      px="xs"
      style={{
        borderBottom: "1px solid var(--cf-border)",
        borderRadius: 0,
      }}
    >
      <Group justify="space-between" wrap="nowrap">
        <Text fz="sm" fw={500}>
          {label}
        </Text>
        <Group gap="xs" wrap="nowrap">
          {detail && (
            <Text fz="sm" c="dimmed">
              {detail}
            </Text>
          )}
          <ChevronRight size={16} color="var(--mantine-color-dimmed)" />
        </Group>
      </Group>
    </UnstyledButton>
  );
}

export default RepertoireInfo;
