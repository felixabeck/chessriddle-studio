import { useTabAtom, useOwnerTab } from "@/state/tabScope";
import {
  Alert,
  Badge,
  Button,
  Divider,
  Group,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  ThemeIcon,
} from "@mantine/core";
import { useToggle } from "@mantine/hooks";
import { Undo2, Check, Info, Target, X } from "lucide-react";
import { RepertoireIcon } from "@/components/common/iconCatalog";
import { useAtom, useAtomValue } from "jotai";
import { useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatMoveNumber, formatNumber } from "@/utils/format";
import { useStore } from "zustand";
import { useTreeViewDeferred } from "@/state/deferredTreeView";
import ConfirmModal from "@/components/common/ConfirmModal";
import Comment from "@/components/common/Comment";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { IconAction } from "@/components/common/IconAction";
import { buildFromTree, getStats } from "@/components/files/opening";
import { practiceRunSummaryFamily, practiceTabFamily, timedRunAtom } from "@/state/atoms";
import { getTabDestinationFile, getTabFile, getTabGameNumber } from "@/utils/tabs";
import { ChapterColorNotice } from "./ChapterColorNotice";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import RepertoireInfo from "./RepertoireInfo";
import { LogsModal, PositionsModal } from "./PracticeModals";
import { QualityRatingPanel } from "./QualityRatingPanel";
import { useDueBoundaryRerender } from "./useDueBoundaryRerender";
import { useDeckSync } from "./useDeckSync";
import { useDeckWeights } from "./useDeckWeights";
import { PracticeStatisticsContext, usePracticeStatistics } from "./usePracticeStatistics";
import { usePracticeSession } from "./usePracticeSession";
import { PRACTICE_RUN_COUNTDOWN_TICK_MS } from "./session";
import { useScaledMaxWidth } from "@/hooks/useScaledMaxWidth";
import paneClasses from "@/components/common/PaneTabs.module.css";
import { COMPACT_PANE_TABS_WIDTH_EM } from "@/components/boards/paneTabs";

const PRACTICE_START_BUTTON_STYLE = { scrollMarginBlock: "var(--mantine-spacing-xs)" };

function formatRunClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function PracticePanel() {
  const { t, i18n } = useTranslation();
  const compactTabs = useScaledMaxWidth(COMPACT_PANE_TABS_WIDTH_EM);

  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (s) => s.root);
  const headers = useStore(store, (s) => s.headers);
  const currentFen = useStore(store, (s) => s.currentNode().fen);
  const treeViewDeferred = useTreeViewDeferred(store);

  const [currentTab] = useOwnerTab();
  const tabFile = getTabFile(currentTab);
  const [resetModal, toggleResetModal] = useToggle();
  const [repairModal, toggleRepairModal] = useToggle();
  const [positionsOpen, setPositionsOpen] = useToggle();
  const [logsOpen, setLogsOpen] = useToggle();
  const [tab, setTab] = useAtom(useTabAtom(practiceTabFamily));
  const timedRun = useAtomValue(timedRunAtom);
  const runSummary = useAtomValue(useTabAtom(practiceRunSummaryFamily));
  const deckIdentity = {
    file: tabFile ? fileWorkspaceKey(tabFile.handle) : "",
    game: getTabGameNumber(currentTab),
  };

  const {
    deck,
    setDeck,
    syncMessage,
    setSyncMessage,
    clearSyncMessageTimer,
    syncedWithTreeAndScope,
  } = useDeckSync({
    root,
    headers,
    treeViewDeferred,
    deckIdentity,
    currentTabId: currentTab?.value,
  });
  const referenceStatistics = usePracticeStatistics();
  useDeckWeights({
    root,
    headers,
    treeViewDeferred,
    deck,
    setDeck,
    statistics: referenceStatistics,
  });

  const deckCanWrite = deck.status === "ready";
  const stats = getStats(deck.positions);
  useDueBoundaryRerender(
    stats.nextDue,
    JSON.stringify([deckIdentity.file, deckIdentity.game, currentTab?.value]),
  );

  const {
    practiceState,
    sessionStats,
    completedSummary,
    newPerSession,
    alternative,
    currentCard,
    liveCard,
    answerFrame,
    answerComment,
    manualPrompt,
    startPractice,
    startFullPractice,
    showMove,
    advancePresentation,
    handleQualityRating,
    endPracticeSession,
    goBackToPosition,
  } = usePracticeSession({
    store,
    root,
    headers,
    currentFen,
    deck,
    setDeck,
    deckIdentity,
    currentTabId: currentTab?.value,
    currentTabTreeKey: currentTab?.treeKey,
    tab,
    clearSyncMessageTimer,
    syncedWithTreeAndScope,
  });

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (timedRun?.phase !== "running") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), PRACTICE_RUN_COUNTDOWN_TICK_MS);
    return () => window.clearInterval(timer);
  }, [timedRun?.phase, timedRun?.id]);
  const remainingMs = timedRun?.phase === "running" ? Math.max(0, timedRun.deadline - now) : 0;

  const displayedSessionStats = completedSummary ?? sessionStats;
  const showPracticeContent =
    deck.status === "ready" || deck.status === "write-pending" || deck.status === "write-blocked";

  return (
    <PracticeStatisticsContext.Provider value={referenceStatistics}>
      <>
        <Tabs
          h="100%"
          orientation={compactTabs ? "horizontal" : "vertical"}
          placement="right"
          value={tab}
          onChange={(v) => setTab(v!)}
          data-compact={compactTabs || undefined}
          classNames={{
            root: paneClasses.root,
            list: paneClasses.list,
            panel: paneClasses.panel,
            tab: paneClasses.tab,
            tabLabel: paneClasses.label,
          }}
          style={{
            display: "flex",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <Tabs.List>
            <Tabs.Tab value="train">{t("Board.Practice.Train")}</Tabs.Tab>
            <Tabs.Tab value="build">{t("Board.Practice.Build")}</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel
            value="train"
            style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}
          >
            <Stack p="sm" gap="md">
              <ChapterColorNotice store={store} file={getTabDestinationFile(currentTab)} />
              {timedRun?.phase === "running" && (
                <Text fz="sm" fw={500} style={{ fontVariantNumeric: "tabular-nums" }}>
                  {t("Board.Practice.RunCountdown", { time: formatRunClock(remainingMs) })}
                </Text>
              )}
              {runSummary && (
                <Text fz="sm">
                  {t("Board.Practice.RunSummary", {
                    positions: runSummary.positions,
                    correct: runSummary.correct,
                    incorrect: runSummary.incorrect,
                    accuracy: Math.round(
                      (100 * runSummary.correct) /
                        Math.max(1, runSummary.correct + runSummary.incorrect),
                    ),
                    elapsed: formatRunClock(runSummary.elapsedMs),
                  })}
                </Text>
              )}
              {deck.status === "loading" && (
                <Alert icon={<Info />}>{t("Board.Practice.Loading")}</Alert>
              )}
              {deck.status === "read-failed" && (
                <Alert
                  icon={<Info />}
                  color="danger"
                  title={t("Board.Practice.ReadFailed", { cause: deck.error?.message })}
                >
                  <Stack gap="xs">
                    <Group gap="xs">
                      <Button
                        variant="light"
                        color="danger"
                        size="xs"
                        onClick={() => setDeck({ type: "retry" })}
                      >
                        {t("Board.Practice.Retry")}
                      </Button>
                      {deck.repairable !== false && (
                        <Button
                          variant="light"
                          color="danger"
                          size="xs"
                          onClick={() => toggleRepairModal()}
                        >
                          {t("Board.Practice.Repair")}
                        </Button>
                      )}
                    </Group>
                  </Stack>
                </Alert>
              )}
              {deck.status === "write-blocked" && (
                <Alert
                  icon={<Info />}
                  color="danger"
                  title={t("Board.Practice.WriteBlocked", { cause: deck.error?.message })}
                />
              )}
              {showPracticeContent && (
                <>
                  {stats.total === 0 && (
                    <Alert icon={<Info />}>
                      <Stack gap="xs">
                        <Text fz="sm">{t("Board.Practice.NoPositionForTrain1")}</Text>
                        <Button variant="light" size="xs" onClick={() => setTab("build")}>
                          {t("Board.Practice.GoToBuild")}
                        </Button>
                      </Stack>
                    </Alert>
                  )}
                  {syncMessage && (
                    <Alert
                      title={t("Board.Practice.DeckSynced")}
                      withCloseButton
                      onClose={() => setSyncMessage(null)}
                    >
                      {syncMessage.added > 0 &&
                        t("Board.Practice.SyncAdded", {
                          count: syncMessage.added ?? 0,
                          number: formatNumber(syncMessage.added ?? 0),
                        })}
                      {syncMessage.added > 0 && syncMessage.removed > 0 && " · "}
                      {syncMessage.removed > 0 &&
                        t("Board.Practice.SyncRemoved", {
                          count: syncMessage.removed ?? 0,
                          number: formatNumber(syncMessage.removed ?? 0),
                        })}
                    </Alert>
                  )}
                  {deck.unappliedReviews > 0 && !deck.orphansAcknowledged && (
                    <Alert color="warning">
                      <Group justify="space-between" wrap="nowrap">
                        <Text fz="sm">
                          {t("Board.Practice.UnappliedReviews", {
                            count: deck.unappliedReviews,
                          })}
                        </Text>
                        <Button
                          variant="subtle"
                          size="compact-xs"
                          onClick={() => setDeck({ type: "acknowledge" })}
                        >
                          {t("Board.Practice.DismissUnappliedReviews")}
                        </Button>
                      </Group>
                    </Alert>
                  )}
                  {stats.total > 0 && (
                    <>
                      {practiceState.phase === "idle" ? (
                        <Stack gap="sm">
                          <Text fz="sm" c="dimmed">
                            {t("Board.Practice.Explanation")}
                          </Text>
                          <Stack gap="sm" mt="sm">
                            {deckCanWrite &&
                            stats.due === 0 &&
                            Math.min(stats.unseen, newPerSession) === 0 ? (
                              <Paper p="sm" withBorder>
                                <Stack gap="xs" align="center">
                                  <ThemeIcon size="xl" radius="xl" color="success" variant="light">
                                    <Check size={24} />
                                  </ThemeIcon>
                                  <Text ta="center" fw={500}>
                                    {t("Board.Practice.PracticedAll1")}
                                  </Text>
                                  <Text ta="center" fz="sm" c="dimmed">
                                    {stats.nextDue &&
                                      t("Board.Practice.NextDue", {
                                        date: new Intl.DateTimeFormat(i18n.language, {
                                          month: "short",
                                          day: "numeric",
                                          hour: "2-digit",
                                          minute: "2-digit",
                                        }).format(stats.nextDue),
                                      })}
                                  </Text>
                                </Stack>
                              </Paper>
                            ) : (
                              <Button
                                size="md"
                                variant="light"
                                fullWidth
                                onClick={startPractice}
                                style={PRACTICE_START_BUTTON_STYLE}
                                disabled={!deckCanWrite}
                                leftSection={<Target size={20} />}
                                justify="space-between"
                                rightSection={
                                  <Badge size="sm" color="gold">
                                    {stats.due + Math.min(stats.unseen, newPerSession)}
                                  </Badge>
                                }
                              >
                                {t("Board.Practice.StartPractice")}
                              </Button>
                            )}
                            <Button
                              size="md"
                              variant="light"
                              color="gray"
                              fullWidth
                              onClick={startFullPractice}
                              style={PRACTICE_START_BUTTON_STYLE}
                              disabled={!deckCanWrite}
                              leftSection={<RepertoireIcon size={20} />}
                              justify="space-between"
                              rightSection={
                                <Badge size="sm" color="gray">
                                  {stats.total}
                                </Badge>
                              }
                            >
                              {t("Board.Practice.PracticeFullRepertoire")}
                            </Button>
                          </Stack>

                          <Text fz="xs">
                            {t("Board.Practice.LearnedProgress", {
                              learned: stats.learned,
                              total: stats.total,
                            })}
                          </Text>
                          <Progress.Root size="sm">
                            <Progress.Section
                              value={(stats.learned / stats.total) * 100}
                              aria-label={t("Board.Practice.LearnedProgress", {
                                learned: stats.learned,
                                total: stats.total,
                              })}
                            />
                          </Progress.Root>
                          <SimpleGrid cols={3} spacing="xs">
                            <Paper p="xs" withBorder radius="sm">
                              <Text fz="xs" c="dimmed">
                                {t("Board.Practice.Due")}
                              </Text>
                              <Text fw={700}>{stats.due}</Text>
                            </Paper>
                            <Paper p="xs" withBorder radius="sm">
                              <Text fz="xs" c="dimmed">
                                {t("Board.Practice.New")}
                              </Text>
                              <Text fw={700}>{stats.unseen}</Text>
                            </Paper>
                            <Paper p="xs" withBorder radius="sm">
                              <Text fz="xs" c="dimmed">
                                {t("Board.Practice.Learned")}
                              </Text>
                              <Text fw={700}>{stats.learned}</Text>
                            </Paper>
                          </SimpleGrid>
                          {displayedSessionStats.correct + displayedSessionStats.incorrect > 0 && (
                            <Text fz="sm">
                              {t("Board.Practice.SessionSummary", {
                                correct: displayedSessionStats.correct,
                                incorrect: displayedSessionStats.incorrect,
                                accuracy: Math.round(
                                  (100 * displayedSessionStats.correct) /
                                    (displayedSessionStats.correct +
                                      displayedSessionStats.incorrect),
                                ),
                                bestStreak: displayedSessionStats.bestStreak,
                              })}
                            </Text>
                          )}
                        </Stack>
                      ) : (
                        <Group justify="space-between" wrap="nowrap">
                          <Text fz="sm">
                            {t("Board.Practice.SessionLine", {
                              remaining: sessionStats.remainingPositionKeys.length,
                              correct: sessionStats.correct,
                              incorrect: sessionStats.incorrect,
                            })}
                          </Text>
                          <IconAction
                            label={t("Common.Stop")}
                            onClick={() => endPracticeSession("stop")}
                          >
                            <X size={16} />
                          </IconAction>
                        </Group>
                      )}

                      {practiceState.phase === "replaying" && (
                        <Text fz="sm" c="dimmed">
                          {t("Board.Practice.Replaying")}
                        </Text>
                      )}
                      {(practiceState.phase === "waiting" ||
                        practiceState.phase === "retry" ||
                        practiceState.phase === "learning" ||
                        practiceState.phase === "revealed") && (
                        <Paper p="sm" withBorder>
                          <Stack gap="xs">
                            {currentFen !== practiceState.currentFen ? (
                              <>
                                <Text fz="sm">{t("Board.Practice.NotOnPosition")}</Text>
                                <Button
                                  variant="light"
                                  size="xs"
                                  leftSection={<Undo2 size={14} />}
                                  onClick={goBackToPosition}
                                >
                                  {t("Board.Practice.GoBackToPosition")}
                                </Button>
                              </>
                            ) : (
                              <>
                                {practiceState.phase === "waiting" && (
                                  <Text fz="sm">{t("Board.Practice.MakeYourMove")}</Text>
                                )}
                                {practiceState.phase === "retry" && (
                                  <Text fz="sm">{t("Board.Practice.TryAgain")}</Text>
                                )}
                                {practiceState.phase === "learning" && (
                                  <Text fz="sm">
                                    {t("Board.Practice.LearnMove", {
                                      move: answerFrame
                                        ? formatMoveNumber(answerFrame.node.halfMoves + 1) +
                                          " " +
                                          liveCard?.answer
                                        : liveCard?.answer,
                                    })}
                                  </Text>
                                )}
                                {practiceState.phase === "revealed" && (
                                  <Text fz="sm">
                                    {t("Board.Practice.PlayRevealedMove", {
                                      move: liveCard?.answer,
                                    })}
                                  </Text>
                                )}
                                {alternative && (
                                  <Text fz="sm">{t("Board.Practice.Alternative")}</Text>
                                )}
                                {practiceState.phase === "retry" && (
                                  <Button variant="light" size="xs" onClick={showMove}>
                                    {t("Board.Practice.ShowMove")}
                                  </Button>
                                )}
                              </>
                            )}
                          </Stack>
                        </Paper>
                      )}
                      {manualPrompt && (
                        <QualityRatingPanel
                          onRate={handleQualityRating}
                          card={currentCard?.card}
                          weight={currentCard?.weight}
                          timeTaken={practiceState.timeTaken}
                        />
                      )}
                      {answerComment &&
                        (practiceState.phase === "learning" ||
                          practiceState.phase === "correct" ||
                          practiceState.phase === "advancing") && (
                          <Paper p="sm" withBorder>
                            <Comment comment={answerComment} />
                          </Paper>
                        )}
                      {answerComment &&
                        !manualPrompt &&
                        (practiceState.phase === "correct" ||
                          practiceState.phase === "advancing") && (
                          <Button variant="light" onClick={advancePresentation}>
                            {t("Board.Practice.Continue")}
                          </Button>
                        )}

                      <Divider />

                      <Group gap="xs">
                        <Button variant="subtle" size="xs" onClick={() => setPositionsOpen(true)}>
                          {t("Board.Practice.ShowAll")}
                        </Button>
                        <Button variant="subtle" size="xs" onClick={() => setLogsOpen(true)}>
                          {t("Board.Practice.ShowLogs")}
                        </Button>
                        <Button
                          variant="subtle"
                          size="xs"
                          color="danger"
                          disabled={!deckCanWrite}
                          onClick={() => toggleResetModal()}
                        >
                          {t("Common.Reset")}
                        </Button>
                      </Group>
                    </>
                  )}
                </>
              )}
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="build" style={{ overflow: "hidden" }}>
            <RepertoireInfo />
          </Tabs.Panel>
        </Tabs>

        <ConfirmModal
          title={t("Board.Practice.Reset.Title")}
          description={t("Board.Practice.Reset.Description", {
            name: tabFile?.name,
          })}
          opened={resetModal}
          onClose={toggleResetModal}
          onConfirm={async () => {
            const cards = buildFromTree(root, headers.orientation || "white", headers.start || []);
            await setDeck({ type: "reset", positions: cards });
            endPracticeSession();
          }}
          confirmLabel={t("Common.Reset")}
        />
        <ConfirmModal
          title={t("Board.Practice.Repair.Title")}
          description={t("Board.Practice.Repair.Description", { name: tabFile?.name })}
          opened={repairModal}
          onClose={toggleRepairModal}
          onConfirm={async () => {
            await setDeck({ type: "repair" });
          }}
          confirmLabel={t("Board.Practice.Repair")}
        />
        {positionsOpen && (
          <PositionsModal open={positionsOpen} setOpen={setPositionsOpen} deck={deck} />
        )}
        <LogsModal
          open={logsOpen}
          setOpen={setLogsOpen}
          identity={deckIdentity}
          generation={deck.generation}
          epoch={deck.epoch}
        />
      </>
    </PracticeStatisticsContext.Provider>
  );
}

export default PracticePanel;
