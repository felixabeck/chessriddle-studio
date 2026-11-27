import {
  Alert,
  Button,
  Group,
  Select,
  SegmentedControl,
  Skeleton,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import type { Color, Move } from "chessops";
import { makeSan } from "chessops/san";
import dayjs from "dayjs";
import { ChevronLeft, RotateCcw } from "lucide-react";
import { Fragment, type ReactNode, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { DatabaseHandle, NormalizedGame, Player, PositionStats } from "@/bindings";
import { fitSelectProps } from "@/components/common/fitSelectProps";
import { IconAction } from "@/components/common/IconAction";
import { useOpenDatabaseGame } from "@/components/common/useOpenDatabaseGame";
import PuzzleBoardSurface from "@/components/puzzles/PuzzleBoardSurface";
import ResultsChart from "@/components/home/PersonalCardPanels/ResultsChart";
import DatabaseLoader from "@/components/panels/database/DatabaseLoader";
import {
  type LocalExplorerResult,
  mergeLocalOpenings,
  useLocalExplorer,
} from "@/components/panels/database/useLocalExplorer";
import { positionFromFen, parseSanOrUci } from "@/utils/chessops";
import { databaseGameHeaders } from "@/utils/databaseGameTree";
import { MIN_OPENING_BOARD_SIZE_REM } from "@/state/openingBoardSize";
import { databaseHandleKey, type LocalOptions } from "@/utils/db";
import { formatPgnYearMonth } from "@/utils/pgnDate";
import GamePreview from "./GamePreview";
import { sectionYearTotals, summarizeRecentGames, type RecentGamesSummary } from "./openingRecency";
import { type OnlineGames, useOnlineGames } from "./useOnlineGames";
import PlayerOpeningRecency from "./PlayerOpeningRecency";
import { playerOpeningLine } from "./playerOpeningLine";
import { usePrepareOpponentOnBoard } from "./prepareOpponentOnBoard";
import { useOpeningBoardSize } from "./useOpeningBoardSize";
import classes from "./PlayerOpeningTree.module.css";

/** One player in one database; `label` names the database when several are merged. */
export type OpeningTreeSource = {
  key: string;
  label: string;
  file: DatabaseHandle;
  player: number;
  /** Verbatim TimeControl values to keep; absent applies no filter. */
  timeControls?: string[];
};

type SourceQuery = { source: OpeningTreeSource; options: LocalOptions };
type SourceResult = { source: OpeningTreeSource; result: LocalExplorerResult };
type OpeningTreeVariant = "database" | "account";
type CombinedResults = ReturnType<typeof combineSourceResults>;

export default function PlayerOpeningTree({
  player,
  file,
}: {
  player: Player;
  file: DatabaseHandle;
}) {
  const { t } = useTranslation();
  const key = `${databaseHandleKey(file)}:${player.id}`;
  const online = useOnlineGames(player, file);
  return (
    <OpeningTree
      key={key}
      variant="database"
      name={
        player.name?.split(",")[0].trim() ||
        t("Databases.OpeningTree.Player", { defaultValue: "Player" })
      }
      tabName={player.name ?? ""}
      sources={[{ key, label: "", file, player: player.id }]}
      online={online}
    />
  );
}

/** The opening tree of an account player, merged over every source given. */
export function AccountOpeningTree({
  name,
  sources,
}: {
  name: string;
  sources: OpeningTreeSource[];
}) {
  return <OpeningTree variant="account" name={name} tabName={name} sources={sources} />;
}

/** Mounts one unchanged single-database explorer query per source and hands all results on. */
function ExplorerSources({
  queries,
  collected = [],
  children,
}: {
  queries: SourceQuery[];
  collected?: SourceResult[];
  children: (results: SourceResult[]) => ReactNode;
}) {
  if (queries.length === 0) return children(collected);
  const [head, ...rest] = queries;
  return (
    <ExplorerSource key={head.source.key} query={head} rest={rest} collected={collected}>
      {children}
    </ExplorerSource>
  );
}

function ExplorerSource({
  query,
  rest,
  collected,
  children,
}: {
  query: SourceQuery;
  rest: SourceQuery[];
  collected: SourceResult[];
  children: (results: SourceResult[]) => ReactNode;
}) {
  const result = useLocalExplorer(
    { ...query.options, include_unknown_results: true, sample_order: "date" },
    true,
  );
  return (
    <ExplorerSources queries={rest} collected={[...collected, { source: query.source, result }]}>
      {children}
    </ExplorerSources>
  );
}

/** Sources that answered are merged; the ones that could not be searched are named once each. */
function combineSourceResults(results: SourceResult[]) {
  const pending = results.find(({ result }) => result.loading);
  const settled = results.filter(({ result }) => !result.loading);
  const failures = new Map<string, { label: string; error: string }>();
  for (const { source, result } of settled) {
    if (result.error !== undefined) {
      failures.set(`${source.label}\n${result.error}`, {
        label: source.label,
        error: result.error,
      });
    }
  }
  const answered = settled.filter(({ result }) => result.error === undefined);
  return {
    loading: pending !== undefined,
    progressId: (pending ?? results[0])?.result.progressId ?? "",
    failures: [...failures.values()],
    // Without any source there is nothing to fail: the tree is empty, not broken.
    failed: answered.length === 0 && failures.size > 0,
    ...mergeLocalOpenings(
      answered.map(({ source, result }) => ({
        source,
        openings: result.openings,
        games: result.games,
      })),
    ),
  };
}

/** 0 is the database's unrated value ("-" or "0" in the PGN), shown like a missing rating. */
export function formatOpponentRating(elo: number | null | undefined) {
  return elo != null && elo > 0 ? elo : "–";
}

function failureText({ label, error }: { label: string; error: string }) {
  return label ? `${label}: ${error}` : error;
}

function OpeningTree({
  variant,
  name,
  tabName,
  sources,
  online,
}: {
  variant: OpeningTreeVariant;
  name: string;
  tabName: string;
  sources: OpeningTreeSource[];
  /** Shown as a second section here and as a second column on the board that "Prepare on board" opens. */
  online?: OnlineGames;
}) {
  const { t } = useTranslation();
  const [color, setColor] = useState<Color>("white");
  const [since, setSince] = useState({ preset: "all", startDate: undefined as string | undefined });
  const [moves, setMoves] = useState<string[]>([]);
  const line = useMemo(() => playerOpeningLine(moves, color), [moves, color]);
  const [position] = useMemo(() => positionFromFen(line.fen), [line.fen]);
  const board = useOpeningBoardSize();
  const colorLabel = t("Databases.OpeningTree.PlayerPlays", {
    defaultValue: "{{name}} plays:",
    name,
  });
  const sinceOptions = [
    {
      value: "all",
      label: t("Databases.OpeningTree.AllGames", { defaultValue: "All games" }),
    },
    {
      value: "5",
      label: t("Databases.OpeningTree.FiveYears", { defaultValue: "5 years" }),
    },
    { value: "2", label: t("Databases.OpeningTree.TwoYears", { defaultValue: "2 years" }) },
    { value: "1", label: t("Databases.OpeningTree.OneYear", { defaultValue: "1 year" }) },
  ];
  const queryFor = (source: OpeningTreeSource): SourceQuery => ({
    source,
    options: {
      path: source.file,
      player: source.player,
      player_database: databaseHandleKey(source.file),
      color,
      fen: line.fen,
      type: "exact",
      result: "any",
      ...(since.startDate ? { start_date: since.startDate } : {}),
      ...(source.timeControls ? { time_controls: source.timeControls } : {}),
    },
  });
  const queries = sources.map(queryFor);
  // The online games are searched for their own player, with the same colour, period and position.
  const onlineSource: OpeningTreeSource | undefined =
    online?.lookup.kind === "found"
      ? {
          key: `online:${databaseHandleKey(online.file)}:${online.lookup.player}`,
          label: "",
          file: online.file,
          player: online.lookup.player,
        }
      : undefined;
  const searched = onlineSource ? [...queries, queryFor(onlineSource)] : queries;
  // A selection belongs to the sources and filters it was made under.
  const scope = JSON.stringify(
    searched.map(({ source: { key, timeControls } }) => [key, timeControls]),
  );
  const [selected, setSelected] = useState<{
    source: OpeningTreeSource;
    game: NormalizedGame;
  } | null>(null);
  const [selectionScope, setSelectionScope] = useState(scope);
  if (selectionScope !== scope) {
    setSelectionScope(scope);
    setSelected(null);
  }
  const { preparing, prepare: prepareOnBoard } = usePrepareOpponentOnBoard();
  const gameOpen = useOpenDatabaseGame(
    ({ source, game }: { source: OpeningTreeSource; game: NormalizedGame }) => ({
      game,
      database: source.file,
      targetFens: [line.fen],
    }),
    { fromPreview: true },
  );
  const changeMoves = (next: string[]) => {
    setSelected(null);
    setMoves(next);
  };
  const playOnBoard = (move: Move) => {
    if (position) advance(makeSan(position, move));
  };
  const advance = (san: string) => {
    if (position && parseSanOrUci(position, san)) changeMoves([...moves, san]);
  };
  const prepare = () => {
    // The board's explorer reads one database, so only a single source can be pinned there.
    const pinned = queries.length === 1 ? queries[0] : undefined;
    return prepareOnBoard({
      ...(pinned
        ? {
            pin: {
              file: pinned.source.file,
              player: pinned.source.player,
              color,
              startDate: since.startDate,
            },
          }
        : { color }),
      online,
      includeReference: variant === "database",
      tabName,
      initialTree: line.tree,
    });
  };

  return (
    <Stack className={classes.root} gap="sm" ref={board.rootRef} data-player-opening-tree>
      <div className={classes.toolbar} data-opening-toolbar>
        <Text size="sm" className="wrap-anywhere">
          {colorLabel}
        </Text>
        <SegmentedControl
          aria-label={colorLabel}
          value={color}
          onChange={(value) => {
            setColor(value as Color);
            setSelected(null);
          }}
          data={[
            { value: "white", label: t("Fen.White") },
            { value: "black", label: t("Fen.Black") },
          ]}
        />
        <Select
          className={classes.since}
          size="xs"
          allowDeselect={false}
          label={t("Databases.OpeningTree.Since", { defaultValue: "Since" })}
          value={since.preset}
          onChange={(preset) => {
            if (preset == null) return;
            setSince({
              preset,
              startDate:
                preset === "all"
                  ? undefined
                  : dayjs().subtract(Number(preset), "year").format("YYYY.MM.DD"),
            });
            setSelected(null);
          }}
          data={sinceOptions}
          {...fitSelectProps(sinceOptions)}
        />
        <Text size="sm" className={classes.notation} data-opening-sequence>
          {line.notation || t("Databases.OpeningTree.Start", { defaultValue: "Start position" })}
        </Text>
        <IconAction
          label={t("Common.MoveControls.Previous")}
          disabled={!moves.length}
          onClick={() => changeMoves(moves.slice(0, -1))}
        >
          <ChevronLeft size={16} />
        </IconAction>
        <IconAction
          label={t("Databases.OpeningTree.Reset", { defaultValue: "Reset to start" })}
          disabled={!moves.length}
          onClick={() => changeMoves([])}
        >
          <RotateCcw size={16} />
        </IconAction>
        <Button
          size="xs"
          className={classes.prepare}
          loading={preparing}
          onClick={() => void prepare()}
        >
          {variant === "account"
            ? t("Databases.OpeningTree.Analyse", { defaultValue: "Analyze on board" })
            : t("Databases.OpeningTree.Prepare", { defaultValue: "Prepare on board" })}
        </Button>
      </div>
      <Text size="sm" c="dimmed" className="wrap-anywhere">
        {variant === "account"
          ? color === "white"
            ? t("Databases.OpeningTree.AccountWhiteHint", {
                defaultValue: "Showing games where {{name}} has White.",
                name,
              })
            : t("Databases.OpeningTree.AccountBlackHint", {
                defaultValue: "Showing games where {{name}} has Black.",
                name,
              })
          : color === "white"
            ? t("Databases.OpeningTree.WhiteHint", {
                defaultValue: "Showing games where {{name}} has White. You prepare with Black.",
                name,
              })
            : t("Databases.OpeningTree.BlackHint", {
                defaultValue: "Showing games where {{name}} has Black. You prepare with White.",
                name,
              })}
      </Text>
      <ExplorerSources queries={searched}>
        {(results) => {
          const primary = combineSourceResults(
            results.filter(({ source }) => source.key !== onlineSource?.key),
          );
          const sections: OpeningSection[] = [
            {
              key: "primary",
              title: online
                ? t("Databases.OpeningTree.OverTheBoard", { defaultValue: "Over the board" })
                : undefined,
              combined: primary,
            },
          ];
          if (online) {
            sections.push({
              key: "online",
              title: t("Databases.OpeningTree.Online", { defaultValue: "Online" }),
              combined: onlineSource
                ? combineSourceResults(
                    results.filter(({ source }) => source.key === onlineSource.key),
                  )
                : online.lookup.kind === "pending"
                  ? { ...EMPTY_RESULTS, loading: true }
                  : {
                      ...EMPTY_RESULTS,
                      failed: true,
                      failures: [
                        {
                          label: "",
                          error: t("Databases.OpeningTree.OnlineUnavailable", {
                            defaultValue: "The online games could not be read.",
                          }),
                        },
                      ],
                    },
            });
          }
          const isSelected = (source: OpeningTreeSource, game: NormalizedGame) =>
            selected?.source.key === source.key && selected.game.id === game.id;
          const sectionRecentGames = sections.map((section) => ({
            section,
            recent: summarizeRecentGames(section.combined.openings),
          }));
          const summaryParts = sectionRecentGames
            .map(({ section, recent }) => renderRecentGamesSummaryPart(section, recent))
            .filter((part): part is ReactNode => part !== null);
          return (
            <>
              {!primary.loading && !primary.failed && primary.failures.length > 0 && (
                <Alert
                  color="warning"
                  title={t("Databases.OpeningTree.PartialSources", {
                    defaultValue: "Some games are missing. These databases could not be searched:",
                  })}
                  data-opening-partial
                >
                  {primary.failures.map((failure) => (
                    <Text key={failureText(failure)} size="sm" className="wrap-anywhere">
                      {failureText(failure)}
                    </Text>
                  ))}
                </Alert>
              )}
              <div className={classes.body} style={board.bodyStyle} data-opening-body>
                <div
                  className={classes.board}
                  ref={board.boardRef}
                  data-opening-board
                  data-fen={line.fen}
                >
                  <PuzzleBoardSurface
                    position={position}
                    orientation={color}
                    lastMove={line.lastMove}
                    canPlay={position !== null && !position.isEnd()}
                    onMove={playOnBoard}
                    drawable={{ enabled: false }}
                  />
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={t("Databases.OpeningTree.ResizeBoard", {
                      defaultValue: "Resize board",
                    })}
                    aria-valuemin={MIN_OPENING_BOARD_SIZE_REM}
                    aria-valuemax={board.maxRem}
                    aria-valuenow={board.sizeRem}
                    tabIndex={0}
                    className={classes.boardHandle}
                    data-dragging={board.dragging ? "true" : undefined}
                    data-opening-board-resize
                    {...board.handleProps}
                  />
                </div>
                <Stack gap="sm" miw={0}>
                  {summaryParts.length > 0 && (
                    <Text size="sm" className={classes.recentSummary} data-opening-recent-summary>
                      <Trans
                        i18nKey="Databases.OpeningTree.Recent.Summary"
                        components={{ parts: <SummaryParts parts={summaryParts} /> }}
                      />
                    </Text>
                  )}
                  {sectionRecentGames.map(({ section, recent }) => (
                    <MovesPanel
                      key={section.key}
                      section={section}
                      recent={recent}
                      name={name}
                      color={color}
                      onMove={advance}
                    />
                  ))}
                </Stack>
              </div>
              {sections.map((section) => (
                <GamesPanel
                  key={section.key}
                  section={section}
                  color={color}
                  isSelected={isSelected}
                  onSelect={(source, game) => setSelected({ source, game })}
                  onOpen={(source, game) => void gameOpen.activate({ source, game })}
                />
              ))}
              {selected && (
                <div data-opening-preview>
                  <Group justify="end">
                    <Button
                      size="xs"
                      variant="default"
                      loading={gameOpen.pending}
                      aria-busy={gameOpen.pending}
                      onClick={() => void gameOpen.activate(selected)}
                      data-opening-open
                    >
                      {t("Databases.OpeningTree.Open", { defaultValue: "Open on board" })}
                    </Button>
                  </Group>
                  <div className={classes.preview}>
                    <GamePreview
                      pgn={selected.game.moves}
                      headers={databaseGameHeaders(selected.game)}
                      fitHeight
                    />
                  </div>
                </div>
              )}
            </>
          );
        }}
      </ExplorerSources>
    </Stack>
  );
}

/** Nothing found and nothing pending: the base of a section that has no search of its own. */
const EMPTY_RESULTS: CombinedResults = {
  loading: false,
  progressId: "",
  failures: [],
  failed: false,
  openings: [],
  games: [],
};

/** How many games reached the position: every continuation, including games that ended there. */
function positionTotal(openings: readonly PositionStats[]) {
  return openings.reduce((sum, row) => sum + row.white + row.draw + row.black + row.unknown, 0);
}

/** One group of the player's games: over the board, or online. `title` is set when both show. */
type OpeningSection = { key: string; title?: string; combined: CombinedResults };

function SectionTitle({ title }: { title?: string }) {
  return title ? (
    <Text size="sm" fw={600} mb="xs" data-opening-section-title>
      {title}
    </Text>
  ) : null;
}

function SummaryParts({ parts }: { parts: ReactNode[] }) {
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? " · " : null}
          {part}
        </Fragment>
      ))}
    </>
  );
}

function renderRecentGamesSummaryPart(
  section: OpeningSection,
  recent: RecentGamesSummary,
): ReactNode | null {
  if (section.combined.loading || section.combined.failed || recent.windowSize === 0) {
    return null;
  }
  const move = recent.leaders.join(" / ");
  const played = recent.leaderCount;
  const total = recent.windowSize;
  const tie = recent.leaders.length > 1;
  const key = section.title
    ? tie
      ? "Databases.OpeningTree.Recent.SummarySourceTie"
      : "Databases.OpeningTree.Recent.SummarySourceMove"
    : tie
      ? "Databases.OpeningTree.Recent.SummaryTie"
      : "Databases.OpeningTree.Recent.SummaryMove";
  return (
    <Trans
      i18nKey={key}
      values={{ ...(section.title ? { source: section.title } : {}), move, played, total }}
      components={{ move: <span className={classes.summaryMove} /> }}
    />
  );
}

/** The moves a section's games continue with from the shown position. */
function MovesPanel({
  section: { key, title, combined },
  recent,
  name,
  color,
  onMove,
}: {
  section: OpeningSection;
  recent: RecentGamesSummary;
  name: string;
  color: Color;
  onMove: (san: string) => void;
}) {
  // The compiler otherwise caches Date construction for the lifetime of this mount.
  "use no memo";

  const { t } = useTranslation();
  const { openings, loading, progressId, failures, failed } = combined;
  const total = positionTotal(openings);
  const currentYear = new Date().getFullYear();
  const sectionTotals = sectionYearTotals(openings, currentYear);
  const recentCountLabel =
    recent.windowSize > 0
      ? t("Databases.OpeningTree.Recent.HeaderCount", {
          defaultValue: "Last {{count}} games",
          count: recent.windowSize,
        })
      : t("Databases.OpeningTree.Recent.HeaderEmpty", {
          defaultValue: "Recently",
        });
  const recentSinceLabel =
    recent.windowSize > 0
      ? t("Databases.OpeningTree.Recent.HeaderSince", {
          defaultValue: "since {{date}}",
          date: formatPgnYearMonth(recent.oldestDate),
        })
      : null;
  const compactRecentLabel = recentSinceLabel
    ? `${recentCountLabel} ${recentSinceLabel}`
    : recentCountLabel;
  return (
    <div className={classes.inset} data-opening-section={key}>
      <SectionTitle title={title} />
      {loading && (
        <>
          <DatabaseLoader
            progressId={progressId}
            label={t("Databases.OpeningTree.Searching", {
              defaultValue: "Searching {{name}}'s games…",
              name,
            })}
          />
          <Stack gap="xs" mt="sm" aria-hidden="true" data-opening-skeleton>
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} height="1.5rem" />
            ))}
          </Stack>
        </>
      )}
      {!loading && failed ? (
        <div role="alert">
          {failures.map((failure) => (
            <Text key={failureText(failure)} c="danger" className="wrap-anywhere">
              {failureText(failure)}
            </Text>
          ))}
        </div>
      ) : (
        !loading && (
          <>
            <Text size="sm" mb="xs">
              {t("Databases.OpeningTree.Total", {
                defaultValue: "{{count}} games in this position",
                count: total,
              })}
            </Text>
            {total === 0 ? (
              <Text c="dimmed" size="sm">
                {t("Databases.OpeningTree.Empty", {
                  defaultValue: "No games in this position",
                })}
              </Text>
            ) : (
              <table className={`${classes.table} ${classes.movesTable}`} data-opening-moves>
                <thead>
                  <tr>
                    <th>{t("Databases.OpeningTree.Move", { defaultValue: "Move" })}</th>
                    <th className={classes.number}>{t("Common.Games")}</th>
                    <th className={classes.number}>
                      {recentSinceLabel ? (
                        <span className={classes.recentHeader}>
                          <span>{recentCountLabel} </span>
                          <span className={classes.recentHeaderSince}>{recentSinceLabel}</span>
                        </span>
                      ) : (
                        recentCountLabel
                      )}
                    </th>
                    <th className={classes.number}>
                      {t("Databases.OpeningTree.Score", { defaultValue: "Score" })}
                    </th>
                    <th>{t("Databases.OpeningTree.WDL", { defaultValue: "W/D/L" })}</th>
                    <th className={classes.recencyColumn}>
                      {t("Databases.OpeningTree.LastPlayed", {
                        defaultValue: "Last played",
                      })}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {openings.map((row) => {
                    const won = color === "white" ? row.white : row.black;
                    const lost = color === "white" ? row.black : row.white;
                    const scored = won + row.draw + lost;
                    const terminal = row.move === "*";
                    const recentCount = recent.counts.get(row.move) ?? 0;
                    const isRecentLeader = !terminal && recent.uniqueLeader === row.move;
                    return (
                      <tr
                        key={row.move}
                        className={terminal ? classes.terminal : classes.row}
                        tabIndex={terminal ? undefined : 0}
                        onClick={terminal ? undefined : () => onMove(row.move)}
                        onKeyDown={
                          terminal
                            ? undefined
                            : (event) => {
                                if (event.key === "Enter") onMove(row.move);
                              }
                        }
                      >
                        <td
                          style={{
                            fontFamily: terminal
                              ? undefined
                              : "var(--mantine-font-family-monospace)",
                          }}
                        >
                          <span className={classes.compactColumnLabel} data-opening-column-label>
                            {t("Databases.OpeningTree.Move", { defaultValue: "Move" })}
                          </span>
                          {terminal
                            ? t("Databases.OpeningTree.Ended", {
                                defaultValue: "Game ended here",
                              })
                            : row.move}
                        </td>
                        <td className={classes.number}>
                          <span className={classes.compactColumnLabel} data-opening-column-label>
                            {t("Common.Games")}
                          </span>
                          {scored + row.unknown}
                        </td>
                        <td
                          className={`${classes.number} ${isRecentLeader ? classes.recentLeader : ""}`}
                          data-recent-leader={isRecentLeader ? "true" : undefined}
                        >
                          {!terminal && (
                            <>
                              <span
                                className={classes.compactColumnLabel}
                                data-opening-column-label
                              >
                                {compactRecentLabel}
                              </span>
                              {recent.windowSize === 0 ? (
                                "–"
                              ) : (
                                <Tooltip
                                  label={t("Databases.OpeningTree.Recent.Tooltip", {
                                    defaultValue: "{{percent}}% of the last {{count}} games here",
                                    percent: Math.round((recentCount / recent.windowSize) * 100),
                                    count: recent.windowSize,
                                  })}
                                >
                                  <span data-opening-recent-count>
                                    {t("Databases.OpeningTree.Recent.Cell", {
                                      defaultValue: "{{played}} of {{total}}",
                                      played: recentCount,
                                      total: recent.windowSize,
                                    })}
                                  </span>
                                </Tooltip>
                              )}
                            </>
                          )}
                        </td>
                        <td className={classes.number}>
                          <span className={classes.compactColumnLabel} data-opening-column-label>
                            {t("Databases.OpeningTree.Score", {
                              defaultValue: "Score",
                            })}
                          </span>
                          {scored ? `${(((won + row.draw / 2) / scored) * 100).toFixed(1)}%` : "–"}
                        </td>
                        <td className={classes.results}>
                          <span className={classes.compactColumnLabel} data-opening-column-label>
                            {t("Databases.OpeningTree.WDL", { defaultValue: "W/D/L" })}
                          </span>
                          <ResultsChart
                            won={won}
                            draw={row.draw}
                            lost={lost}
                            size="1.125rem"
                            labelThreshold={0.2}
                          />
                        </td>
                        <td className={classes.recencyColumn}>
                          <PlayerOpeningRecency
                            row={row}
                            currentYear={currentYear}
                            sectionTotals={sectionTotals}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )
      )}
    </div>
  );
}

/** A section's most recent games in the shown position; a click previews, a double click opens. */
function GamesPanel({
  section: { key, title, combined },
  color,
  isSelected,
  onSelect,
  onOpen,
}: {
  section: OpeningSection;
  color: Color;
  isSelected: (source: OpeningTreeSource, game: NormalizedGame) => boolean;
  onSelect: (source: OpeningTreeSource, game: NormalizedGame) => void;
  onOpen: (source: OpeningTreeSource, game: NormalizedGame) => void;
}) {
  const { t } = useTranslation();
  const { openings, games, loading, failed } = combined;
  if (loading || failed || games.length === 0) return null;
  const total = positionTotal(openings);
  return (
    <Stack gap="sm" data-opening-games-section={key}>
      <SectionTitle title={title} />
      {total > games.length && (
        <Text size="xs" c="dimmed">
          {t("Databases.OpeningTree.Truncated", {
            defaultValue: "Showing the most recent {{shown}} of {{total}}",
            shown: games.length,
            total,
          })}
        </Text>
      )}
      <div className={`${classes.inset} ${classes.games}`}>
        <table className={classes.table} data-opening-games>
          <thead>
            <tr>
              <th>{t("Common.Date")}</th>
              <th>{t("Databases.OpeningTree.Opponent", { defaultValue: "Opponent" })}</th>
              <th>{t("Board.Database.Local.Result")}</th>
              <th>{t("Databases.Game.Event")}</th>
            </tr>
          </thead>
          <tbody>
            {games.map(({ source, game }) => (
              <tr
                key={`${source.key}:${game.id}`}
                className={classes.row}
                tabIndex={0}
                aria-selected={isSelected(source, game)}
                onClick={() => onSelect(source, game)}
                onDoubleClick={() => onOpen(source, game)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onSelect(source, game);
                }}
              >
                <td>{game.date || "–"}</td>
                <td>
                  {color === "white" ? game.black : game.white}
                  <Text size="xs" c="dimmed">
                    {formatOpponentRating(color === "white" ? game.black_elo : game.white_elo)}
                  </Text>
                </td>
                <td>{game.result}</td>
                <td>{game.event}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Stack>
  );
}
