import { Button, Group, SegmentedControl, Stack, Text } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import type { Color } from "chessops";
import { useSetAtom, useStore } from "jotai";
import { ChevronLeft, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DatabaseHandle, NormalizedGame, Player } from "@/bindings";
import { Chessground } from "@/chessground/Chessground";
import { IconAction } from "@/components/common/IconAction";
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
import { playerOpeningLine } from "./playerOpeningLine";
import classes from "./PlayerOpeningTree.module.css";

export default function PlayerOpeningTree(props: { player: Player; file: DatabaseHandle }) {
  return <OpeningTree key={`${databaseHandleKey(props.file)}:${props.player.id}`} {...props} />;
}

function OpeningTree({ player, file }: { player: Player; file: DatabaseHandle }) {
  const { t } = useTranslation();
  const [color, setColor] = useState<Color>("white");
  const [moves, setMoves] = useState<string[]>([]);
  const [selected, setSelected] = useState<NormalizedGame | null>(null);
  const [preparing, setPreparing] = useState(false);
  const line = useMemo(() => playerOpeningLine(moves, color), [moves, color]);
  const options: LocalOptions = {
    path: file,
    player: player.id,
    color,
    fen: line.fen,
    type: "exact",
    result: "any",
    include_unknown_results: true,
    sample_order: "date",
  };
  const { openings, games, loading, error, progressId } = useLocalExplorer(options, true);
  const total = openings.reduce(
    (sum, row) => sum + row.white + row.draw + row.black + row.unknown,
    0,
  );
  const setTabs = useSetAtom(tabsAtom);
  const addRecentFile = useSetAtom(addRecentFileAtom);
  const atoms = useStore();
  const navigate = useNavigate();
  const onError = (cause: unknown) => notifyUnlessCancelled(t("Common.Error"), cause);
  const open = (game: NormalizedGame) =>
    void runTabCreation({
      create: () => openDatabaseGame({ game, database: file, setTabs, addRecentFile }),
      onSuccess: () => navigate({ to: "/" }),
      onError,
    });
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
      <div className={classes.toolbar}>
        <SegmentedControl
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
          {loading && <DatabaseLoader isLoading tab={progressId} />}
          {error ? (
            <Text role="alert" c="danger">
              {t("Home.Databases.ErrorLoading", { error })}
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
                  <table className={classes.table} data-opening-moves>
                    <thead>
                      <tr>
                        <th>{t("Databases.OpeningTree.Move", { defaultValue: "Move" })}</th>
                        <th className={classes.number}>{t("Common.Games")}</th>
                        <th className={classes.number}>
                          {t("Databases.OpeningTree.Score", { defaultValue: "Score" })}
                        </th>
                        <th>{t("Databases.OpeningTree.WDL", { defaultValue: "W/D/L" })}</th>
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
                              {terminal
                                ? t("Databases.OpeningTree.Ended", {
                                    defaultValue: "Game ended here",
                                  })
                                : row.move}
                            </td>
                            <td className={classes.number}>{scored + row.unknown}</td>
                            <td className={classes.number}>
                              {scored
                                ? `${(((won + row.draw / 2) / scored) * 100).toFixed(1)}%`
                                : "–"}
                            </td>
                            <td>
                              <ResultsChart
                                won={won}
                                draw={row.draw}
                                lost={lost}
                                size="0.6rem"
                                playerPerspective
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
                    onDoubleClick={() => open(game)}
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
                <Button size="xs" variant="default" onClick={() => open(selected)}>
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
