import {
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
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DatabaseHandle, NormalizedGame, Player } from "@/bindings";
import { Chessground } from "@/chessground/Chessground";
import { IconAction } from "@/components/common/IconAction";
import { useGameOpen } from "@/components/common/gameOpen";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import ResultsChart from "@/components/home/PersonalCardPanels/ResultsChart";
import DatabaseLoader from "@/components/panels/database/DatabaseLoader";
import { useLocalExplorer } from "@/components/panels/database/useLocalExplorer";
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

export default function PlayerOpeningTree(props: { player: Player; file: DatabaseHandle }) {
  return <OpeningTree key={`${databaseHandleKey(props.file)}:${props.player.id}`} {...props} />;
}

function OpeningTree({ player, file }: { player: Player; file: DatabaseHandle }) {
  const { t } = useTranslation();
  const [color, setColor] = useState<Color>("white");
  const [since, setSince] = useState({ preset: "all", startDate: undefined as string | undefined });
  const [moves, setMoves] = useState<string[]>([]);
  const [selected, setSelected] = useState<NormalizedGame | null>(null);
  const [preparing, setPreparing] = useState(false);
  const line = useMemo(() => playerOpeningLine(moves, color), [moves, color]);
  const name =
    player.name?.split(",")[0].trim() ||
    t("Databases.OpeningTree.Player", { defaultValue: "Player" });
  const colorLabel = t("Databases.OpeningTree.PlayerPlays", {
    defaultValue: "{{name}} plays:",
    name,
  });
  const options: LocalOptions = {
    path: file,
    player: player.id,
    player_database: databaseHandleKey(file),
    color,
    fen: line.fen,
    type: "exact",
    result: "any",
    ...(since.startDate ? { start_date: since.startDate } : {}),
  };
  const { openings, games, loading, error, progressId } = useLocalExplorer(
    { ...options, include_unknown_results: true, sample_order: "date" },
    true,
  );
  const total = openings.reduce(
    (sum, row) => sum + row.white + row.draw + row.black + row.unknown,
    0,
  );
  const setTabs = useSetAtom(tabsAtom);
  const addRecentFile = useSetAtom(addRecentFileAtom);
  const atoms = useStore();
  const navigate = useNavigate();
  const onError = (cause: unknown) => notifyUnlessCancelled(t("Common.Error"), cause);
  const gameOpen = useGameOpen(
    (game: NormalizedGame) =>
      runTabCreation({
        create: () => openDatabaseGame({ game, database: file, setTabs, addRecentFile }),
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
    setPreparing(true);
    try {
      await runTabCreation({
        create: () =>
          createTab({
            tab: { type: "analysis", name: player.name ?? "" },
            setTabs,
            initialTree: line.tree,
          }),
        onSuccess: (id) => {
          atoms.set(localOptionsFamily(id), options);
          atoms.set(pinnedExplorerDatabaseFamily(id), file);
          atoms.set(dbTypeFamily(id), "local");
          atoms.set(dbTabFamily(id), "stats");
          atoms.set(tabFamily(id), "database");
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
          {t("Databases.OpeningTree.Prepare", { defaultValue: "Prepare on board" })}
        </Button>
      </div>
      <Text size="sm" c="dimmed" className="wrap-anywhere">
        {color === "white"
          ? t("Databases.OpeningTree.WhiteHint", {
              defaultValue: "Showing games where {{name}} has White. You prepare with Black.",
              name,
            })
          : t("Databases.OpeningTree.BlackHint", {
              defaultValue: "Showing games where {{name}} has Black. You prepare with White.",
              name,
            })}
      </Text>
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
          {error ? (
            <Text role="alert" c="danger">
              {error}
            </Text>
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
                          {t("Databases.OpeningTree.Score", { defaultValue: "Score" })}
                        </th>
                        <th>{t("Databases.OpeningTree.WDL", { defaultValue: "W/D/L" })}</th>
                        <th className={classes.recencyColumn}>
                          {t("Databases.OpeningTree.LastPlayed", { defaultValue: "Last played" })}
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
                                {t("Databases.OpeningTree.Score", { defaultValue: "Score" })}
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
      {!loading && !error && games.length > 0 && (
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
                  <th>{t("Databases.OpeningTree.Opponent", { defaultValue: "Opponent" })}</th>
                  <th>{t("Board.Database.Local.Result")}</th>
                  <th>{t("Databases.Game.Event")}</th>
                </tr>
              </thead>
              <tbody>
                {games.map((game) => (
                  <tr
                    key={game.id}
                    className={classes.row}
                    tabIndex={0}
                    aria-selected={selected?.id === game.id}
                    onClick={() => setSelected(game)}
                    onDoubleClick={() => void gameOpen.activate(game)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") setSelected(game);
                    }}
                  >
                    <td>{game.date || "–"}</td>
                    <td>
                      {color === "white" ? game.black : game.white}
                      <Text size="xs" c="dimmed">
                        {(color === "white" ? game.black_elo : game.white_elo) ?? "–"}
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
                  pgn={selected.moves}
                  headers={databaseGameHeaders(selected)}
                  fitHeight
                />
              </div>
            </div>
          )}
        </>
      )}
    </Stack>
  );
}
