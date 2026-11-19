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
import type { Color } from "chessops";
import dayjs from "dayjs";
import { useSetAtom, useStore } from "jotai";
import { ChevronLeft, RotateCcw } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DatabaseHandle, NormalizedGame, Player } from "@/bindings";
import { Chessground } from "@/chessground/Chessground";
import { IconAction } from "@/components/common/IconAction";
import { useGameOpen } from "@/components/common/gameOpen";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import ResultsChart from "@/components/home/PersonalCardPanels/ResultsChart";
import DatabaseLoader from "@/components/panels/database/DatabaseLoader";
import {
  type LocalExplorerResult,
  mergeLocalOpenings,
  useLocalExplorer,
} from "@/components/panels/database/useLocalExplorer";
import {
  addRecentFileAtom,
  dbTabFamily,
  dbTypeFamily,
  localOptionsFamily,
  pinnedExplorerDatabaseFamily,
  tabFamily,
  tabsAtom,
} from "@/state/atoms";
import { positionFromFen, parseSanOrUci } from "@/utils/chessops";
import { databaseGameHeaders } from "@/utils/databaseGameTree";
import { openDatabaseGame } from "@/utils/databaseGame";
import { databaseHandleKey, type LocalOptions } from "@/utils/db";
import { createTab, runTabCreation } from "@/utils/tabs";
import GamePreview from "./GamePreview";
import PlayerOpeningRecency from "./PlayerOpeningRecency";
import { playerOpeningLine } from "./playerOpeningLine";
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

export default function PlayerOpeningTree({
  player,
  file,
}: {
  player: Player;
  file: DatabaseHandle;
}) {
  const { t } = useTranslation();
  const key = `${databaseHandleKey(file)}:${player.id}`;
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
}: {
  variant: OpeningTreeVariant;
  name: string;
  tabName: string;
  sources: OpeningTreeSource[];
}) {
  const { t } = useTranslation();
  const [color, setColor] = useState<Color>("white");
  const [since, setSince] = useState({ preset: "all", startDate: undefined as string | undefined });
  const [moves, setMoves] = useState<string[]>([]);
  const line = useMemo(() => playerOpeningLine(moves, color), [moves, color]);
  const colorLabel = t("Databases.OpeningTree.PlayerPlays", {
    defaultValue: "{{name}} plays:",
    name,
  });
  const queries: SourceQuery[] = sources.map((source) => ({
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
  }));
  // A selection belongs to the sources and filters it was made under.
  const scope = JSON.stringify(sources.map(({ key, timeControls }) => [key, timeControls]));
  const [selected, setSelected] = useState<{
    source: OpeningTreeSource;
    game: NormalizedGame;
  } | null>(null);
  const [selectionScope, setSelectionScope] = useState(scope);
  if (selectionScope !== scope) {
    setSelectionScope(scope);
    setSelected(null);
  }
  const [preparing, setPreparing] = useState(false);
  const setTabs = useSetAtom(tabsAtom);
  const addRecentFile = useSetAtom(addRecentFileAtom);
  const atoms = useStore();
  const navigate = useNavigate();
  const onError = (cause: unknown) => notifyUnlessCancelled(t("Common.Error"), cause);
  const gameOpen = useGameOpen(
    ({ source, game }: { source: OpeningTreeSource; game: NormalizedGame }) =>
      runTabCreation({
        create: () => openDatabaseGame({ game, database: source.file, setTabs, addRecentFile }),
        onSuccess: () => navigate({ to: "/" }),
        onError,
      }),
    onError,
  );
  const changeMoves = (next: string[]) => {
    setSelected(null);
    setMoves(next);
  };
  const advance = (san: string) => {
    const [position] = positionFromFen(line.fen);
    if (position && parseSanOrUci(position, san)) changeMoves([...moves, san]);
  };
  const prepare = async () => {
    // The board's explorer reads one database, so only a single source can be pinned there.
    const pinned = queries.length === 1 ? queries[0] : undefined;
    setPreparing(true);
    try {
      await runTabCreation({
        create: () =>
          createTab({
            tab: { type: "analysis", name: tabName },
            setTabs,
            initialTree: line.tree,
          }),
        onSuccess: (id) => {
          if (pinned) {
            // The board has no time-control control, so that filter stays behind.
            const { time_controls: _searchOnly, ...options } = pinned.options;
            atoms.set(localOptionsFamily(id), options);
            atoms.set(pinnedExplorerDatabaseFamily(id), pinned.source.file);
            atoms.set(dbTypeFamily(id), "local");
            atoms.set(dbTabFamily(id), "stats");
            atoms.set(tabFamily(id), "database");
          }
          return navigate({ to: "/" });
        },
        onError,
      });
    } finally {
      setPreparing(false);
    }
  };

  return (
    <Stack className={classes.root} gap="sm" data-player-opening-tree>
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
        <NativeSelect
          className={classes.since}
          size="xs"
          label={t("Databases.OpeningTree.Since", { defaultValue: "Since" })}
          value={since.preset}
          onChange={(event) => {
            const preset = event.currentTarget.value;
            setSince({
              preset,
              startDate:
                preset === "all"
                  ? undefined
                  : dayjs().subtract(Number(preset), "year").format("YYYY.MM.DD"),
            });
            setSelected(null);
          }}
          data={[
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
          ]}
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
      <ExplorerSources queries={queries}>
        {(results) => {
          const { openings, games, loading, progressId, failures, failed } =
            combineSourceResults(results);
          const total = openings.reduce(
            (sum, row) => sum + row.white + row.draw + row.black + row.unknown,
            0,
          );
          return (
            <>
              {!loading && !failed && failures.length > 0 && (
                <Alert
                  color="warning"
                  title={t("Databases.OpeningTree.PartialSources", {
                    defaultValue: "Some games are missing. These databases could not be searched:",
                  })}
                  data-opening-partial
                >
                  {failures.map((failure) => (
                    <Text key={failureText(failure)} size="sm" className="wrap-anywhere">
                      {failureText(failure)}
                    </Text>
                  ))}
                </Alert>
              )}
              <div className={classes.body}>
                <div className={classes.board} data-opening-board data-fen={line.fen}>
                  <Chessground
                    fen={line.fen}
                    orientation={color}
                    coordinates={false}
                    viewOnly
                    drawable={{ enabled: false }}
                  />
                </div>
                <div className={classes.inset}>
                  {loading && (
                    <>
                      <DatabaseLoader
                        isLoading
                        tab={progressId}
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
                          <table
                            className={`${classes.table} ${classes.movesTable}`}
                            data-opening-moves
                          >
                            <thead>
                              <tr>
                                <th>{t("Databases.OpeningTree.Move", { defaultValue: "Move" })}</th>
                                <th className={classes.number}>{t("Common.Games")}</th>
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
                                return (
                                  <tr
                                    key={row.move}
                                    className={terminal ? classes.terminal : classes.row}
                                    tabIndex={terminal ? undefined : 0}
                                    onClick={terminal ? undefined : () => advance(row.move)}
                                    onKeyDown={
                                      terminal
                                        ? undefined
                                        : (event) => {
                                            if (event.key === "Enter") advance(row.move);
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
                                      <span
                                        className={classes.compactColumnLabel}
                                        data-opening-column-label
                                      >
                                        {t("Databases.OpeningTree.Move", { defaultValue: "Move" })}
                                      </span>
                                      {terminal
                                        ? t("Databases.OpeningTree.Ended", {
                                            defaultValue: "Game ended here",
                                          })
                                        : row.move}
                                    </td>
                                    <td className={classes.number}>
                                      <span
                                        className={classes.compactColumnLabel}
                                        data-opening-column-label
                                      >
                                        {t("Common.Games")}
                                      </span>
                                      {scored + row.unknown}
                                    </td>
                                    <td className={classes.number}>
                                      <span
                                        className={classes.compactColumnLabel}
                                        data-opening-column-label
                                      >
                                        {t("Databases.OpeningTree.Score", {
                                          defaultValue: "Score",
                                        })}
                                      </span>
                                      {scored
                                        ? `${(((won + row.draw / 2) / scored) * 100).toFixed(1)}%`
                                        : "–"}
                                    </td>
                                    <td className={classes.results}>
                                      <span
                                        className={classes.compactColumnLabel}
                                        data-opening-column-label
                                      >
                                        {t("Databases.OpeningTree.WDL", { defaultValue: "W/D/L" })}
                                      </span>
                                      <ResultsChart
                                        won={won}
                                        draw={row.draw}
                                        lost={lost}
                                        size="1.125rem"
                                        playerPerspective
                                        labelThreshold={0.2}
                                      />
                                    </td>
                                    <td className={classes.recencyColumn}>
                                      <PlayerOpeningRecency row={row} />
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
              </div>
              {!loading && !failed && games.length > 0 && (
                <>
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
                          <th>
                            {t("Databases.OpeningTree.Opponent", { defaultValue: "Opponent" })}
                          </th>
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
                            aria-selected={
                              selected?.source.key === source.key && selected.game.id === game.id
                            }
                            onClick={() => setSelected({ source, game })}
                            onDoubleClick={() => void gameOpen.activate({ source, game })}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") setSelected({ source, game });
                            }}
                          >
                            <td>{game.date || "–"}</td>
                            <td>
                              {color === "white" ? game.black : game.white}
                              <Text size="xs" c="dimmed">
                                {formatOpponentRating(
                                  color === "white" ? game.black_elo : game.white_elo,
                                )}
                              </Text>
                            </td>
                            <td>{game.result}</td>
                            <td>{game.event}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
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
              )}
            </>
          );
        }}
      </ExplorerSources>
    </Stack>
  );
}
