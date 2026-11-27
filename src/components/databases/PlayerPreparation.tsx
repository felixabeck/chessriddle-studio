import {
  Alert,
  Button,
  Group,
  Select,
  SegmentedControl,
  Skeleton,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DatabaseHandle, Player } from "@/bindings";
import { fitSelectProps } from "@/components/common/fitSelectProps";
import { inlineFailureMessage, notifyUnlessCancelled } from "@/components/files/notifyError";
import DatabaseLoader from "@/components/panels/database/DatabaseLoader";
import { isAbortError } from "@/components/panels/practice/prepareTimedRun";
import TrainMinutesControl from "@/components/panels/practice/TrainMinutesControl";
import {
  activeTabAtom,
  opponentPreparationAtom,
  practiceTrainMinutesAtom,
  tabPreparationViewFamily,
  tabsAtom,
  timedRunLaunchAtom,
} from "@/state/atoms";
import { OPPONENT_PERIODS, type OpponentPeriod } from "@/state/opponentLinks";
import { databaseHandleKey } from "@/utils/db";
import type { LineTitle } from "@/utils/lineTitle";
import { openFile } from "@/utils/openFile";
import {
  PREPARATION_MIN_GAMES_OPTIONS,
  type PreparationColor,
  type PreparationGap,
  type PreparationLine,
  type PreparationMinGames,
  type PreparationSource,
  type PreparationView,
  parsePreparationMinGames,
  preparationViewForSource,
  userColorForOpponent,
} from "@/utils/opponentPreparation";
import { formatPgnYearMonth } from "@/utils/pgnDate";
import {
  buildPreparationRunCandidates,
  collectPreparationCandidateChapters,
  readPreparationDecks,
} from "@/utils/preparationRun";
import { createTab, findChapterTab, runTabCreation } from "@/utils/tabs";
import {
  DEFAULT_PREPARATION_PERIOD,
  opponentPeriodLabel,
  opponentPeriodOptions,
  opponentPeriodToValue,
  valueToOpponentPeriod,
} from "./opponentPeriod";
import { usePrepareOpponentOnBoard } from "./prepareOpponentOnBoard";
import { useOnlineGames } from "./useOnlineGames";
import { preparationStartDate, useOpponentPreparation } from "./useOpponentPreparation";
import classes from "./PlayerPreparation.module.css";

const INITIAL_ROW_LIMIT = 30;

/** Period options in display order: All games, 5 years, 3 years, 1 year. */
const PERIOD_OPTIONS: readonly OpponentPeriod[] = [...OPPONENT_PERIODS].reverse();

function formatChapterLabel(title: LineTitle, fallback: string): string {
  const parts = [title.name, title.idea].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" — ") : fallback;
}

type PreparationRow = Pick<
  PreparationLine,
  | "workspaceKey"
  | "file"
  | "chapter"
  | "chapterTitle"
  | "path"
  | "boardState"
  | "games"
  | "lastPlayed"
>;

export default function PlayerPreparation({
  player,
  file,
}: {
  player: Player;
  file: DatabaseHandle;
}) {
  const { t } = useTranslation();
  const atoms = useStore();
  const navigate = useNavigate();
  const setTabs = useSetAtom(tabsAtom);
  const stored = useAtomValue(opponentPreparationAtom);
  const minutes = useAtomValue(practiceTrainMinutesAtom);
  const cardDatabaseKey = databaseHandleKey(file);

  const shortName =
    player.name?.split(",")[0].trim() ||
    t("Databases.OpeningTree.Player", { defaultValue: "Player" });

  // Restore the player's last selection when returning to this tab with a stored preparation.
  const matchesPlayer =
    stored !== null && stored.cardDatabaseKey === cardDatabaseKey && stored.playerId === player.id;

  const [opponentColor, setOpponentColor] = useState<PreparationColor>(() =>
    matchesPlayer ? stored.opponentColor : "white",
  );
  const [period, setPeriod] = useState<OpponentPeriod>(() =>
    matchesPlayer ? stored.period : DEFAULT_PREPARATION_PERIOD,
  );
  const [showAllLines, setShowAllLines] = useState(false);
  const [showAllGaps, setShowAllGaps] = useState(false);
  const [opening, setOpening] = useState(false);
  const openAbortRef = useRef<AbortController | null>(null);
  const [startingRun, setStartingRun] = useState(false);
  const [trainError, setTrainError] = useState<"practice-unreadable" | null>(null);
  const trainAbortRef = useRef<AbortController | null>(null);

  const online = useOnlineGames(player, file);
  const { preparing, prepare: prepareOnBoard } = usePrepareOpponentOnBoard();
  const { state, restart, setSource, minGames, setMinGames } = useOpponentPreparation({
    player,
    file,
    opponentName: shortName,
    online,
    opponentColor,
    period,
  });

  const onlineUnavailable =
    online !== undefined &&
    (online.lookup.kind === "unavailable" ||
      (state.kind === "ready" && state.preparation.onlineFailed));
  const onlineAvailable =
    online !== undefined &&
    online.lookup.kind === "found" &&
    state.kind === "ready" &&
    !state.preparation.onlineFailed &&
    state.preparation.views.online !== null &&
    state.preparation.views.both !== null;

  const effectiveSource: PreparationSource =
    state.kind === "ready" && onlineAvailable ? state.preparation.source : "otb";

  /** Every selection change shows the lists from their first rows again. */
  const collapsingLists =
    <Value,>(change: (next: Value) => void) =>
    (next: Value) => {
      change(next);
      setShowAllLines(false);
      setShowAllGaps(false);
    };
  const handleSourceChange = collapsingLists<PreparationSource>(setSource);
  const handleColorChange = collapsingLists<PreparationColor>(setOpponentColor);
  const handlePeriodChange = collapsingLists<OpponentPeriod>(setPeriod);
  const handleMinGamesChange = collapsingLists<PreparationMinGames>(setMinGames);

  const openRow = useCallback(
    async (row: PreparationRow) => {
      if (openAbortRef.current !== null || state.kind !== "ready") return;
      const controller = new AbortController();
      openAbortRef.current = controller;
      setOpening(true);
      const preparationId = state.preparation.id;
      const landing = { path: [...row.path], boardState: row.boardState };
      const isStillValid = () =>
        !controller.signal.aborted && atoms.get(opponentPreparationAtom)?.id === preparationId;
      try {
        const existing = findChapterTab(atoms.get(tabsAtom), row.workspaceKey, row.chapter);
        if (existing) {
          if (!isStillValid()) return;
          if (!atoms.set(activeTabAtom, existing.value)) return;
          atoms.set(tabPreparationViewFamily(existing.value), {
            preparationId,
            landing,
            showAllLines: false,
          });
          try {
            await navigate({ to: "/" });
          } catch (error) {
            if (!controller.signal.aborted) {
              notifyUnlessCancelled(t("Common.Error"), error);
            }
          }
          return;
        }
        await runTabCreation({
          create: () =>
            openFile(row.file, setTabs, {
              gameNumber: row.chapter,
              store: atoms,
              signal: controller.signal,
            }),
          onSuccess: (tabId) => {
            if (!isStillValid()) return;
            atoms.set(tabPreparationViewFamily(tabId), {
              preparationId,
              landing,
              showAllLines: false,
            });
            return navigate({ to: "/" });
          },
          onError: (error) => {
            if (isStillValid()) {
              notifyUnlessCancelled(t("Common.Error"), error, "files");
            }
          },
        });
      } finally {
        if (openAbortRef.current === controller) {
          openAbortRef.current = null;
          setOpening(false);
        }
      }
    },
    [atoms, navigate, setTabs, state, t],
  );

  const colorLabel = t("Databases.OpeningTree.PlayerPlays", {
    defaultValue: "{{name}} plays:",
    name: shortName,
  });
  const opponentColorName = opponentColor === "white" ? t("Fen.White") : t("Fen.Black");
  const userColorName =
    userColorForOpponent(opponentColor) === "white" ? t("Fen.White") : t("Fen.Black");

  const readyViews = state.kind === "ready" ? state.preparation.views : null;
  const preparationId = state.kind === "ready" ? state.preparation.id : null;
  const preparationFiles = state.kind === "ready" ? state.preparation.files : undefined;
  const activeView: PreparationView | null = readyViews
    ? preparationViewForSource(readyViews, effectiveSource)
    : null;

  useEffect(() => {
    return () => {
      openAbortRef.current?.abort();
      openAbortRef.current = null;
      setOpening(false);
    };
  }, [preparationId]);

  useEffect(() => {
    setTrainError(null);
    return () => {
      trainAbortRef.current?.abort();
      trainAbortRef.current = null;
      setStartingRun(false);
    };
  }, [preparationId, effectiveSource, minGames]);

  const candidateChapters = useMemo(() => {
    if (!preparationId || !activeView || !preparationFiles) return [];
    return collectPreparationCandidateChapters(
      preparationFiles,
      opponentColor,
      activeView.playedPositions,
    );
  }, [preparationId, preparationFiles, opponentColor, activeView]);

  const hasCandidates = candidateChapters.length > 0;

  const startTrainingRun = useCallback(async () => {
    if (
      trainAbortRef.current !== null ||
      state.kind !== "ready" ||
      !activeView ||
      candidateChapters.length === 0
    ) {
      return;
    }
    const controller = new AbortController();
    trainAbortRef.current = controller;
    setStartingRun(true);
    setTrainError(null);
    try {
      const decks = await readPreparationDecks(
        atoms,
        candidateChapters.map((chapter) => ({
          file: chapter.workspaceKey,
          game: chapter.chapter,
        })),
        controller.signal,
      );
      if (controller.signal.aborted) return;

      const { candidates, chapters, skippedChapters } = buildPreparationRunCandidates(
        candidateChapters,
        activeView,
        decks,
      );
      if (candidates.length === 0) {
        setTrainError("practice-unreadable");
        return;
      }

      await runTabCreation({
        create: () =>
          createTab({
            tab: { name: t("Tab.NewTab"), type: "new" },
            setTabs,
            signal: controller.signal,
          }),
        onSuccess: async (newTabId) => {
          if (controller.signal.aborted) return;
          if (skippedChapters > 0) {
            notifications.show({
              color: "warning",
              message: t("Databases.Preparation.ChaptersSkipped", {
                count: skippedChapters,
                defaultValue:
                  "{{count}} chapters were left out because their practice data could not be read.",
              }),
            });
          }
          const launchId = crypto.randomUUID();
          const startedAt = Date.now();
          atoms.set(timedRunLaunchAtom, {
            id: launchId,
            deadline: startedAt + minutes * 60 * 1000,
            startedAt,
            newTabId,
            candidates,
            chapters,
          });
          try {
            await navigate({ to: "/" });
          } catch (error) {
            if (atoms.get(timedRunLaunchAtom)?.id === launchId) {
              atoms.set(timedRunLaunchAtom, null);
            }
            throw error;
          }
        },
        onError: (error) => {
          if (!controller.signal.aborted) {
            notifyUnlessCancelled(t("Common.Error"), error);
          }
        },
      });
    } catch (error) {
      if (!controller.signal.aborted && !isAbortError(error)) {
        notifyUnlessCancelled(t("Common.Error"), error);
      }
    } finally {
      if (trainAbortRef.current === controller) {
        trainAbortRef.current = null;
        setStartingRun(false);
      }
    }
  }, [activeView, atoms, candidateChapters, minutes, navigate, setTabs, state.kind, t]);

  const otbLabel = t("Databases.OpeningTree.OverTheBoard", {
    defaultValue: "Over the board",
  });
  const onlineLabel = t("Databases.OpeningTree.Online", { defaultValue: "Online" });
  const bothLabel = t("Databases.Preparation.Both", { defaultValue: "Both" });
  const periodOptions = opponentPeriodOptions(PERIOD_OPTIONS, t);
  const minGamesOptions = PREPARATION_MIN_GAMES_OPTIONS.map((option) => String(option));

  return (
    <Stack className={classes.root} gap="sm" data-player-preparation>
      <div className={classes.toolbar} data-preparation-toolbar>
        <Text size="sm" className="wrap-anywhere">
          {colorLabel}
        </Text>
        <SegmentedControl
          aria-label={colorLabel}
          value={opponentColor}
          onChange={(value) => handleColorChange(value as PreparationColor)}
          data={[
            { value: "white", label: t("Fen.White") },
            { value: "black", label: t("Fen.Black") },
          ]}
        />
        <Select
          className={classes.toolbarSelect}
          size="xs"
          allowDeselect={false}
          label={t("Databases.OpeningTree.Since", { defaultValue: "Since" })}
          value={opponentPeriodToValue(period)}
          onChange={(value) => {
            if (value == null) return;
            handlePeriodChange(valueToOpponentPeriod(value));
          }}
          data={periodOptions}
          {...fitSelectProps(periodOptions)}
        />
        <Select
          className={classes.toolbarSelect}
          size="xs"
          allowDeselect={false}
          label={t("Databases.Preparation.MinGames", { defaultValue: "Minimum games" })}
          value={String(minGames)}
          onChange={(value) => {
            if (value == null) return;
            handleMinGamesChange(parsePreparationMinGames(value));
          }}
          data={minGamesOptions}
          {...fitSelectProps(minGamesOptions)}
          data-preparation-min-games
        />
        <Button
          size="xs"
          className={`wrap-button ${classes.prepare}`}
          loading={preparing}
          data-prepare-on-board
          onClick={() =>
            void prepareOnBoard({
              pin: {
                file,
                player: player.id,
                color: opponentColor,
                startDate: preparationStartDate(period),
              },
              online,
              includeReference: true,
              tabName: player.name ?? "",
            })
          }
        >
          {t("Databases.OpeningTree.Prepare", { defaultValue: "Prepare on board" })}
        </Button>
        <Button
          size="xs"
          variant="default"
          leftSection={<RefreshCw size={14} />}
          onClick={restart}
          data-preparation-refresh
        >
          {t("Databases.Preparation.Refresh", { defaultValue: "Refresh" })}
        </Button>
      </div>

      {online && (
        <SegmentedControl
          fullWidth
          data-preparation-source
          value={effectiveSource}
          onChange={(next) => handleSourceChange(next as PreparationSource)}
          data={[
            {
              value: "otb",
              label: readyViews ? `${otbLabel} · ${readyViews.otb.total}` : otbLabel,
            },
            {
              value: "online",
              label:
                readyViews?.online !== undefined && readyViews.online !== null
                  ? `${onlineLabel} · ${readyViews.online.total}`
                  : onlineLabel,
              disabled: !onlineAvailable,
            },
            {
              value: "both",
              label:
                readyViews?.both !== undefined && readyViews.both !== null
                  ? `${bothLabel} · ${readyViews.both.total}`
                  : bothLabel,
              disabled: !onlineAvailable,
            },
          ]}
        />
      )}

      {onlineUnavailable && (
        <Alert color="warning" data-preparation-online-unavailable>
          <Text size="sm">
            {t("Databases.OpeningTree.OnlineUnavailable", {
              defaultValue: "The online games could not be read.",
            })}
          </Text>
        </Alert>
      )}

      {state.kind === "loading" && (
        <div className={classes.inset} data-preparation-loading={state.stage}>
          <DatabaseLoader
            progressId={state.progressId}
            label={
              state.stage === "repertoire"
                ? t("Databases.Preparation.ReadingRepertoire", {
                    defaultValue: "Reading your repertoire…",
                  })
                : t("Databases.OpeningTree.Searching", {
                    defaultValue: "Searching {{name}}'s games…",
                    name: shortName,
                  })
            }
          />
          <Stack gap="xs" mt="sm" aria-hidden="true">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} height="1.5rem" />
            ))}
          </Stack>
        </div>
      )}

      {state.kind === "repertoire-failed" && (
        <Alert color="danger" role="alert" data-preparation-repertoire-error>
          <Stack gap="xs" align="flex-start">
            <Text size="sm">
              {t("Databases.Preparation.RepertoireReadFailed", {
                defaultValue: "Your repertoire could not be read.",
              })}
            </Text>
            <Button size="xs" variant="default" onClick={restart}>
              {t("Common.Retry")}
            </Button>
          </Stack>
        </Alert>
      )}

      {state.kind === "empty-repertoire" && (
        <div className={classes.inset} data-preparation-empty-repertoire={state.reason}>
          <Text size="sm" c="dimmed">
            {state.reason === "no-workspace"
              ? t("Databases.Preparation.NoWorkspace", {
                  defaultValue:
                    "Select a library folder with repertoire files to prepare against this opponent.",
                })
              : state.reason === "no-files"
                ? t("Databases.Preparation.NoRepertoireFiles", {
                    defaultValue: "You have no repertoire files yet.",
                  })
                : t("Databases.Preparation.NoColorChapters", {
                    defaultValue: "You have no {{color}} repertoire chapters yet.",
                    color: userColorName,
                  })}
          </Text>
        </div>
      )}

      {state.kind === "search-failed" && (
        <Alert color="danger" role="alert" data-preparation-search-error>
          <Stack gap="xs" align="flex-start">
            <Text size="sm" className="wrap-anywhere">
              {inlineFailureMessage(state.error, "database", t("Databases.LoadError.Title")) ??
                t("Databases.LoadError.Title")}
            </Text>
            <Button size="xs" variant="default" onClick={restart}>
              {t("Common.Retry")}
            </Button>
          </Stack>
        </Alert>
      )}

      {state.kind === "ready" && activeView && (
        <>
          {state.preparation.partial && (
            <Alert color="warning" data-preparation-partial>
              <Text size="sm">
                {t("Databases.Preparation.PartialRepertoire", {
                  defaultValue: "Your repertoire was read only in part. Some lines may be missing.",
                })}
              </Text>
            </Alert>
          )}

          <Text size="sm" c="dimmed" className="wrap-anywhere" data-preparation-summary>
            {t("Databases.Preparation.Summary", {
              defaultValue: "{{name}} as {{color}} ({{period}}) · {{count}} games",
              name: shortName,
              color: opponentColorName,
              period: opponentPeriodLabel(period, t),
              count: activeView.total,
            })}
          </Text>

          {activeView.total === 0 &&
          activeView.lines.length === 0 &&
          activeView.gaps.length === 0 ? (
            <div className={classes.inset} data-preparation-no-games>
              <Text size="sm" c="dimmed">
                {t("Databases.Preparation.NoGames", {
                  defaultValue: "No games found for {{name}} as {{color}} ({{period}}).",
                  name: shortName,
                  color: opponentColorName,
                  period: opponentPeriodLabel(period, t),
                })}
              </Text>
            </div>
          ) : (
            <>
              <PreparationList<PreparationLine>
                title={t("Databases.Preparation.LinesTitle", {
                  defaultValue: "Lines {{name}} plays",
                  name: shortName,
                })}
                rows={activeView.lines}
                total={activeView.total}
                expanded={showAllLines}
                onExpand={() => setShowAllLines(true)}
                disabled={opening}
                onOpen={(line) => void openRow(line)}
                moveColumnHeader={t("Databases.Preparation.ColumnMoves", {
                  defaultValue: "Moves",
                })}
                renderMoves={(line) =>
                  line.moves.length > 0
                    ? line.moves.join(" ")
                    : t("Databases.OpeningTree.Start", {
                        defaultValue: "Start position",
                      })
                }
                emptyText={
                  minGames > 1
                    ? t("Databases.Preparation.LinesBelowMinimum", {
                        defaultValue:
                          "None of your repertoire lines was played often enough for this minimum.",
                      })
                    : t("Databases.Preparation.LinesEmpty", {
                        defaultValue: "None of your repertoire lines appeared in these games.",
                      })
                }
                rowKey={(line) => `${line.workspaceKey}:${line.chapter}:${line.boardState}`}
                listAttr="data-preparation-lines"
                rowAttr="data-preparation-line-row"
                showAllAttr="data-preparation-show-all-lines"
              />
              <PreparationList<PreparationGap>
                title={t("Databases.Preparation.GapsTitle", {
                  defaultValue: "Gaps in your repertoire",
                })}
                rows={activeView.gaps}
                total={activeView.total}
                expanded={showAllGaps}
                onExpand={() => setShowAllGaps(true)}
                disabled={opening}
                onOpen={(gap) => void openRow(gap)}
                moveColumnHeader={t("Databases.Preparation.ColumnMove", {
                  defaultValue: "Uncovered move",
                })}
                renderMoves={(gap) => (
                  <>
                    {gap.moves.length > 0 ? `${gap.moves.join(" ")} ` : ""}
                    <span className={classes.gapMove}>{gap.move}</span>
                  </>
                )}
                emptyText={
                  minGames > 1
                    ? t("Databases.Preparation.GapsBelowMinimum", {
                        defaultValue: "No uncovered move was played often enough for this minimum.",
                      })
                    : t("Databases.Preparation.GapsEmpty", {
                        defaultValue: "No uncovered moves found.",
                      })
                }
                rowKey={(gap) => `${gap.workspaceKey}:${gap.chapter}:${gap.boardState}:${gap.move}`}
                listAttr="data-preparation-gaps"
                rowAttr="data-preparation-gap-row"
                showAllAttr="data-preparation-show-all-gaps"
              />
            </>
          )}

          <div className={classes.inset} data-preparation-train>
            <Stack gap="xs">
              <div className={classes.trainFooter}>
                <TrainMinutesControl
                  disabled={startingRun}
                  ariaLabel={t("Databases.Preparation.TrainDuration", {
                    defaultValue: "Training duration",
                  })}
                />
                <Button
                  size="xs"
                  loading={startingRun}
                  disabled={!hasCandidates || startingRun}
                  onClick={() => void startTrainingRun()}
                  data-preparation-train-start
                >
                  {t("Databases.Preparation.TrainLines", {
                    defaultValue: "Train these lines",
                  })}
                </Button>
              </div>
              {!hasCandidates && (
                <Text size="sm" c="dimmed" data-preparation-train-disabled-reason>
                  {t("Databases.Preparation.NoTrainableLines", {
                    defaultValue: "No repertoire lines to train in this selection.",
                  })}
                </Text>
              )}
              {trainError === "practice-unreadable" && (
                <Alert color="danger" role="alert" data-preparation-train-error>
                  <Text size="sm">
                    {t("Databases.Preparation.PracticeDataUnreadable", {
                      defaultValue: "Practice data could not be read.",
                    })}
                  </Text>
                </Alert>
              )}
            </Stack>
          </div>
        </>
      )}
    </Stack>
  );
}

function formatGamesCount(
  t: ReturnType<typeof useTranslation>["t"],
  games: number,
  total: number,
): string {
  return total > 0
    ? t("Databases.Preparation.GamesOfTotal", {
        defaultValue: "{{games}} of {{total}} games",
        games,
        total,
      })
    : t("Databases.Preparation.GamesCount", {
        defaultValue: "{{games}} games",
        games,
      });
}

function PreparationList<Row extends PreparationRow>({
  title,
  rows,
  total,
  expanded,
  onExpand,
  disabled,
  onOpen,
  moveColumnHeader,
  renderMoves,
  emptyText,
  rowKey,
  listAttr,
  rowAttr,
  showAllAttr,
}: {
  title: string;
  rows: readonly Row[];
  total: number;
  expanded: boolean;
  onExpand: () => void;
  disabled: boolean;
  onOpen: (row: Row) => void;
  moveColumnHeader: string;
  renderMoves: (row: Row) => ReactNode;
  emptyText: string;
  rowKey: (row: Row) => string;
  listAttr: "data-preparation-lines" | "data-preparation-gaps";
  rowAttr: "data-preparation-line-row" | "data-preparation-gap-row";
  showAllAttr: "data-preparation-show-all-lines" | "data-preparation-show-all-gaps";
}) {
  const { t } = useTranslation();
  const visible = expanded ? rows : rows.slice(0, INITIAL_ROW_LIMIT);
  return (
    <div className={classes.inset} {...{ [listAttr]: "" }}>
      <Text size="sm" fw={600} mb="xs">
        {title}
      </Text>
      {rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          {emptyText}
        </Text>
      ) : (
        <>
          <table className={classes.table}>
            <thead>
              <tr>
                <th>
                  {t("Databases.Preparation.ColumnLine", {
                    defaultValue: "Line",
                  })}
                </th>
                <th>{moveColumnHeader}</th>
                <th className={classes.number}>{t("Common.Games")}</th>
                <th className={classes.number}>
                  {t("Databases.OpeningTree.LastPlayed", {
                    defaultValue: "Last played",
                  })}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const chapterLabel = formatChapterLabel(
                  row.chapterTitle,
                  t("Databases.Preparation.ChapterFallback", {
                    defaultValue: "Chapter {{number}}",
                    number: row.chapter + 1,
                  }),
                );
                return (
                  <tr
                    key={rowKey(row)}
                    className={classes.row}
                    tabIndex={0}
                    aria-disabled={disabled || undefined}
                    {...{ [rowAttr]: "" }}
                    onClick={() => onOpen(row)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpen(row);
                      }
                    }}
                  >
                    <td>
                      <div>{row.file.name}</div>
                      <div className={classes.chapterTitle}>{chapterLabel}</div>
                    </td>
                    <td className={classes.moves}>{renderMoves(row)}</td>
                    <td className={classes.number}>{formatGamesCount(t, row.games, total)}</td>
                    <td className={classes.number}>{formatPgnYearMonth(row.lastPlayed)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!expanded && rows.length > INITIAL_ROW_LIMIT && (
            <Group justify="center" mt="xs">
              <Button size="xs" variant="subtle" onClick={onExpand} {...{ [showAllAttr]: "" }}>
                {t("Databases.Preparation.ShowAll", {
                  defaultValue: "Show all ({{count}})",
                  count: rows.length,
                })}
              </Button>
            </Group>
          )}
        </>
      )}
    </div>
  );
}
