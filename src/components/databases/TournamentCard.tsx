import { Paper, Stack, Tabs, Text, useMantineTheme } from "@mantine/core";
import { Eye } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useSetAtom } from "jotai";
import { DataTable, type DataTableSortStatus } from "mantine-datatable";
import { useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import useSWRImmutable from "swr/immutable";
import { match } from "ts-pattern";
import { useStore } from "zustand";
import type { DatabaseHandle, Event, NormalizedGame } from "@/bindings";
import { IconAction } from "@/components/common/IconAction";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { addRecentFileAtom, tabsAtom } from "@/state/atoms";
import type { DatabaseViewStore } from "@/state/store/database";
import { getTournamentGames } from "@/utils/db";
import { runTabCreation } from "@/utils/tabs";
import { openDatabaseGame } from "@/utils/databaseGame";
import { DatabaseViewStateContext } from "./DatabaseViewStateContext";
import { dateColumn, numericColumn } from "./databaseColumns";
import PlayerRatingCell from "./PlayerRatingCell";

const gamePoints = (game: NormalizedGame, player: string) => {
  if (game.white === player) {
    return match(game.result)
      .with("1-0", () => 1)
      .with("0-1", () => 0)
      .with("1/2-1/2", () => 0.5)
      .otherwise(() => 0);
  }
  return match(game.result)
    .with("1-0", () => 0)
    .with("0-1", () => 1)
    .with("1/2-1/2", () => 0.5)
    .otherwise(() => 0);
};

function TournamentCard({ tournament, file }: { tournament: Event; file: DatabaseHandle }) {
  const { t } = useTranslation();
  const store = useContext(DatabaseViewStateContext)!;
  const databaseTitle = useStore(store, (s) => s.database?.title);
  const tournamentsActiveTab = useStore(store, (s) => s.tournaments.activeTab);
  const setTournamentsActiveTab = useStore(store, (s) => s.setTournamentsActiveTab);

  const theme = useMantineTheme();
  const navigate = useNavigate();
  const [, setTabs] = useAtom(tabsAtom);
  const addRecentFile = useSetAtom(addRecentFileAtom);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const requestKey = ["tournament-games", file, tournament.id] as const;
  const requestOwner = useNativeRequestOwner(requestKey);

  const {
    data: games,
    error,
    isLoading,
  } = useSWRImmutable(requestKey, ([_key, file, id]) =>
    requestOwner!.run(async (signal) => (await getTournamentGames(file, id, signal)).data),
  );

  useEffect(() => {
    if (error) notifyUnlessCancelled(t("Common.Error"), error);
  }, [error, t]);

  const [sort, setSort] = useState<DataTableSortStatus<NormalizedGame>>({
    columnAccessor: "date",
    direction: "asc",
  });

  const sortedGames = games
    ? [...games].sort((a, b) => {
        const key = sort.columnAccessor;
        if (sort.direction === "asc") {
          /// @ts-expect-error we know they're the same type
          return a[key] > b[key] ? 1 : -1;
        }
        /// @ts-expect-error we know they're the same type
        return a[key] < b[key] ? 1 : -1;
      })
    : [];

  const players =
    games?.reduce(
      (acc, game) => {
        const whitePlayer = acc.find((p) => p.name === game.white);
        if (!whitePlayer) {
          acc.push({
            name: game.white,
            points: gamePoints(game, game.white),
          });
        } else {
          whitePlayer.points += gamePoints(game, game.white);
        }

        if (game.white === game.black) return acc;

        const blackPlayer = acc.find((p) => p.name === game.black);
        if (!blackPlayer) {
          acc.push({
            name: game.black,
            points: gamePoints(game, game.black),
          });
        } else {
          blackPlayer.points += gamePoints(game, game.black);
        }

        return acc;
      },
      [] as { name: string; points: number }[],
    ) || [];

  players.sort(
    (a, b) => b.points - a.points || a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
  );

  const lastPage = Math.max(1, Math.ceil(sortedGames.length / pageSize));
  useEffect(() => {
    setPage((currentPage) => Math.min(currentPage, lastPage));
  }, [lastPage]);

  const paginatedGames = sortedGames.slice((page - 1) * pageSize, page * pageSize);

  return (
    <Paper shadow="sm" p="sm" withBorder h="100%">
      <Stack h="100%">
        <Text fz="lg" fw={500}>
          {tournament.name}
        </Text>
        <Tabs
          value={tournamentsActiveTab}
          onChange={(tab) =>
            setTournamentsActiveTab(tab as DatabaseViewStore["tournaments"]["activeTab"])
          }
          style={{ flexDirection: "column", overflow: "hidden" }}
          display="flex"
          h="100%"
        >
          <Tabs.List>
            <Tabs.Tab value="games">{t("Common.Games")}</Tabs.Tab>
            <Tabs.Tab value="leaderboard">{t("Databases.Tournament.Leaderboard")}</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="games" flex={1} style={{ overflow: "hidden" }}>
            <DataTable<NormalizedGame>
              fetching={isLoading}
              withTableBorder
              highlightOnHover
              records={paginatedGames}
              totalRecords={sortedGames.length}
              recordsPerPage={pageSize}
              onRecordsPerPageChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              recordsPerPageLabel={t("Common.RecordsPerPage")}
              recordsPerPageOptions={[10, 25, 50]}
              page={page}
              onPageChange={setPage}
              sortStatus={sort}
              onSortStatusChange={setSort}
              columns={[
                {
                  accessor: "actions",
                  title: "",
                  render: (game) => (
                    <IconAction
                      label={t("Common.Open")}
                      variant="filled"
                      color={theme.primaryColor}
                      onClick={() => {
                        void runTabCreation({
                          create: () =>
                            openDatabaseGame({
                              game: game,
                              database: file,
                              setTabs,
                              addRecentFile,
                              databaseTitle: databaseTitle,
                            }),
                          onSuccess: () => navigate({ to: "/" }),
                          onError: (error) => notifyUnlessCancelled(t("Common.Error"), error),
                        });
                      }}
                    >
                      <Eye size="1rem" strokeWidth={2} />
                    </IconAction>
                  ),
                },
                {
                  accessor: "white",
                  title: t("Fen.White"),
                  render: ({ white, white_elo }) => (
                    <PlayerRatingCell name={white} elo={white_elo} />
                  ),
                },
                {
                  accessor: "black",
                  title: t("Fen.Black"),
                  render: ({ black, black_elo }) => (
                    <PlayerRatingCell name={black} elo={black_elo} />
                  ),
                },
                { ...dateColumn, accessor: "date", title: t("Common.Date"), sortable: true },
                { accessor: "result", title: t("Board.Database.Local.Result") },
                {
                  ...numericColumn,
                  accessor: "ply_count",
                  title: t("Databases.Game.Plies"),
                  sortable: true,
                },
              ]}
              noRecordsText={t("Databases.Game.NoGamesFound")}
            />
          </Tabs.Panel>
          <Tabs.Panel value="leaderboard" flex={1} style={{ overflow: "hidden" }}>
            <DataTable
              fetching={isLoading}
              withTableBorder
              highlightOnHover
              records={players}
              columns={[
                {
                  ...numericColumn,
                  accessor: "rank",
                  title: t("Databases.Tournament.Rank"),
                  render: (player, index) => (
                    <Text size="sm" fw={500}>
                      {index + 1}
                    </Text>
                  ),
                },
                {
                  accessor: "name",
                  title: t("Databases.Tournament.Player"),
                  render: (player) => (
                    <Text size="sm" fw={500}>
                      {player.name}
                    </Text>
                  ),
                },
                {
                  ...numericColumn,
                  accessor: "points",
                  title: t("Databases.Tournament.Points"),
                  render: (player) => (
                    <Text size="sm" fw={500}>
                      {player.points}
                    </Text>
                  ),
                },
              ]}
              noRecordsText={t("Databases.Player.NoPlayersFound")}
            />
          </Tabs.Panel>
        </Tabs>
      </Stack>
    </Paper>
  );
}

export default TournamentCard;
