import {
  Alert,
  Button,
  Group,
  NativeSelect,
  SegmentedControl,
  Skeleton,
  Stack,
  Text,
} from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DatabaseHandle, Player } from "@/bindings";
import { inlineFailureMessage, notifyUnlessCancelled } from "@/components/files/notifyError";
import DatabaseLoader from "@/components/panels/database/DatabaseLoader";
import {
  activeTabAtom,
  opponentPreparationAtom,
  tabPreparationViewFamily,
  tabsAtom,
} from "@/state/atoms";
import { OPPONENT_PERIODS, type OpponentPeriod } from "@/state/opponentLinks";
import { databaseHandleKey } from "@/utils/db";
import type { LineTitle } from "@/utils/lineTitle";
import { openFile } from "@/utils/openFile";
import {
  type PreparationColor,
  type PreparationGap,
  type PreparationLine,
  type PreparationSource,
  type PreparationView,
  userColorForOpponent,
} from "@/utils/opponentPreparation";
import { formatPgnYearMonth } from "@/utils/pgnDate";
import { findChapterTab, runTabCreation } from "@/utils/tabs";
import { useOnlineGames } from "./useOnlineGames";
import { useOpponentPreparation } from "./useOpponentPreparation";
import classes from "./PlayerPreparation.module.css";

const INITIAL_ROW_LIMIT = 30;

/** Period options in display order: All games, 5 years, 3 years, 1 year. */
const PERIOD_OPTIONS: readonly OpponentPeriod[] = [...OPPONENT_PERIODS].reverse();

function periodToValue(period: OpponentPeriod): string {
  return period === null ? "all" : String(period);
}

function valueToPeriod(value: string): OpponentPeriod {
  if (value === "all") return null;
  const parsed = Number(value);
  return parsed === 1 || parsed === 3 || parsed === 5 ? parsed : 3;
}

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
  const [period, setPeriod] = useState<OpponentPeriod>(() => (matchesPlayer ? stored.period : 3));
  const [showAllLines, setShowAllLines] = useState(false);
  const [showAllGaps, setShowAllGaps] = useState(false);
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);

  const online = useOnlineGames(player, file);
  const { state, refresh, retry, setSource } = useOpponentPreparation({
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

  const handleSourceChange = (next: PreparationSource) => {
    setSource(next);
    setShowAllLines(false);
    setShowAllGaps(false);
  };

  const handleColorChange = (next: PreparationColor) => {
    setOpponentColor(next);
    setShowAllLines(false);
    setShowAllGaps(false);
  };

  const handlePeriodChange = (next: OpponentPeriod) => {
    setPeriod(next);
    setShowAllLines(false);
    setShowAllGaps(false);
  };

  const openRow = useCallback(
    async (row: PreparationRow) => {
      if (openingRef.current || state.kind !== "ready") return;
      openingRef.current = true;
      setOpening(true);
      const preparationId = state.preparation.id;
      const landing = { path: [...row.path], boardState: row.boardState };
      try {
        const existing = findChapterTab(atoms.get(tabsAtom), row.workspaceKey, row.chapter);
        if (existing) {
          if (!atoms.set(activeTabAtom, existing.value)) return;
          atoms.set(tabPreparationViewFamily(existing.value), {
            preparationId,
            landing,
            showAllLines: false,
          });
          await navigate({ to: "/" });
          return;
        }
        await runTabCreation({
          create: () =>
            openFile(row.file, setTabs, {
              gameNumber: row.chapter,
              store: atoms,
            }),
          onSuccess: (tabId) => {
            atoms.set(tabPreparationViewFamily(tabId), {
              preparationId,
              landing,
              showAllLines: false,
            });
            return navigate({ to: "/" });
          },
          onError: (error) => notifyUnlessCancelled(t("Common.Error"), error, "files"),
        });
      } finally {
        openingRef.current = false;
        setOpening(false);
      }
    },
    [atoms, navigate, setTabs, state, t],
  );

  const periodLabel = (p: OpponentPeriod): string => {
    switch (p) {
      case null:
        return t("Databases.OpeningTree.AllGames", { defaultValue: "All games" });
      case 5:
        return t("Databases.OpeningTree.FiveYears", { defaultValue: "5 years" });
      case 3:
        return t("Databases.Opponent.ThreeYears", { defaultValue: "3 years" });
      case 1:
        return t("Databases.OpeningTree.OneYear", { defaultValue: "1 year" });
    }
  };

  const colorLabel = t("Databases.OpeningTree.PlayerPlays", {
    defaultValue: "{{name}} plays:",
    name: shortName,
  });
  const opponentColorName = opponentColor === "white" ? t("Fen.White") : t("Fen.Black");
  const userColorName =
    userColorForOpponent(opponentColor) === "white" ? t("Fen.White") : t("Fen.Black");

  const readyViews = state.kind === "ready" ? state.preparation.views : null;
  const activeView: PreparationView | null = readyViews
    ? effectiveSource === "online"
      ? (readyViews.online ?? readyViews.otb)
      : effectiveSource === "both"
        ? (readyViews.both ?? readyViews.otb)
        : readyViews.otb
    : null;

  const otbLabel = t("Databases.OpeningTree.OverTheBoard", {
    defaultValue: "Over the board",
  });
  const onlineLabel = t("Databases.OpeningTree.Online", { defaultValue: "Online" });
  const bothLabel = t("Databases.Preparation.Both", { defaultValue: "Both" });

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
        <NativeSelect
          className={classes.since}
          size="xs"
          label={t("Databases.OpeningTree.Since", { defaultValue: "Since" })}
          value={periodToValue(period)}
          onChange={(event) => handlePeriodChange(valueToPeriod(event.currentTarget.value))}
          data={PERIOD_OPTIONS.map((option) => ({
            value: periodToValue(option),
            label: periodLabel(option),
          }))}
        />
        <Button
          size="xs"
          variant="default"
          className={classes.refresh}
          leftSection={<RefreshCw size={14} />}
          onClick={refresh}
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
            <Button size="xs" variant="default" onClick={retry}>
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
            <Button size="xs" variant="default" onClick={retry}>
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
              period: periodLabel(period),
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
                  period: periodLabel(period),
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
                emptyText={t("Databases.Preparation.LinesEmpty", {
                  defaultValue: "None of your repertoire lines appeared in these games.",
                })}
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
                emptyText={t("Databases.Preparation.GapsEmpty", {
                  defaultValue: "No uncovered moves found.",
                })}
                rowKey={(gap) => `${gap.workspaceKey}:${gap.chapter}:${gap.boardState}:${gap.move}`}
                listAttr="data-preparation-gaps"
                rowAttr="data-preparation-gap-row"
                showAllAttr="data-preparation-show-all-gaps"
              />
            </>
          )}
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
