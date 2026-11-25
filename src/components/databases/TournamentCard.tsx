import { Box, Paper, Stack, Tabs, Text, useMantineTheme } from "@mantine/core";
import { Eye } from "lucide-react";
import { DataTable, type DataTableSortStatus } from "mantine-datatable";
import { useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import useSWRImmutable from "swr/immutable";
import { match } from "ts-pattern";
import { useStore } from "zustand";
import type { DatabaseHandle, Event, NormalizedGame } from "@/bindings";
import { IconAction } from "@/components/common/IconAction";
import { useOpenDatabaseGame } from "@/components/common/useOpenDatabaseGame";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { useDatabaseContentRevision } from "@/state/linkedCollections";
import type {
  DatabaseViewStore,
  ListDisplayMode,
  RecordsPerPageChoice,
} from "@/state/store/database";
import { getTournamentGames } from "@/utils/db";
import { DatabaseListFooter, DEFAULT_PAGE_SIZE } from "./DatabaseListFooter";
import { DatabaseViewStateContext } from "./DatabaseViewStateContext";
import { dateColumn, numericColumn } from "./databaseColumns";
import PlayerRatingCell from "./PlayerRatingCell";
import { ALL_RECORDS_MAX_ROWS } from "./useDatabaseListQuery";

type TournamentGameSortKey = "date" | "ply_count";

function compareTournamentGames(
  a: NormalizedGame,
  b: NormalizedGame,
  key: TournamentGameSortKey,
  direction: "asc" | "desc",
): number {
  const left = a[key] ?? null;
  const right = b[key] ?? null;
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;

  const order =
    typeof left === "number" && typeof right === "number" ? left - right : left < right ? -1 : 1;
  return direction === "asc" ? order : -order;
}

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
  const tournamentsActiveTab = useStore(store, (s) => s.tournaments.activeTab);
  const setTournamentsActiveTab = useStore(store, (s) => s.setTournamentsActiveTab);

  const theme = useMantineTheme();
  const gameOpen = useOpenDatabaseGame((record: NormalizedGame) => ({
    game: record,
    database: file,
  }));
  const [mode, setMode] = useState<ListDisplayMode>("paged");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const { revision, unavailable } = useDatabaseContentRevision(file);
  const requestKey =
    revision && !unavailable
      ? (["tournament-games", file, tournament.id, ...revision] as const)
      : null;
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

  const key = sort.columnAccessor === "ply_count" ? "ply_count" : "date";
  const sortedGames = games
    ? [...games].sort((a, b) => compareTournamentGames(a, b, key, sort.direction))
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

  const displayedGames =
    mode === "all"
      ? sortedGames.slice(0, ALL_RECORDS_MAX_ROWS)
      : sortedGames.slice((page - 1) * pageSize, page * pageSize);
  const boundReachedWithMore = mode === "all" && sortedGames.length > ALL_RECORDS_MAX_ROWS;

  const handleRecordsPerPageChange = (choice: RecordsPerPageChoice) => {
    if (choice === "all") {
      setMode("all");
      setPage(1);
      return;
    }
    setMode("paged");
    setPageSize(choice);
    setPage(1);
  };

  return (
    <Paper shadow="sm" p="sm" withBorder h="100%">
      <Stack h="100%" style={{ minHeight: 0 }}>
        <Text fz="lg" fw={500}>
          {tournament.name}
        </Text>
        {unavailable && (
          <Text>
            {t("Collections.Unavailable", {
              defaultValue:
                "The search index is unavailable. Retry, or select the collection's source file again.",
            })}
          </Text>
        )}
        {!unavailable && (
          <Tabs
            value={tournamentsActiveTab}
            onChange={(tab) =>
              setTournamentsActiveTab(tab as DatabaseViewStore["tournaments"]["activeTab"])
            }
            style={{ flexDirection: "column", overflow: "hidden", flex: 1, minHeight: 0 }}
            display="flex"
            h="100%"
          >
            <Tabs.List>
              <Tabs.Tab value="games">{t("Common.Games")}</Tabs.Tab>
              <Tabs.Tab value="leaderboard">{t("Databases.Tournament.Leaderboard")}</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel
              value="games"
              flex={1}
              style={{ overflow: "hidden", display: "flex", flexDirection: "column", minHeight: 0 }}
            >
              <Box style={{ flex: 1, minHeight: 0 }}>
                <DataTable<NormalizedGame>
                  height={mode === "all" ? "100%" : undefined}
                  fetching={isLoading || revision === null}
                  withTableBorder
                  highlightOnHover
                  records={displayedGames}
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
                          onClick={() => void gameOpen.activate(game)}
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
              </Box>
              <DatabaseListFooter
                mode={mode}
                page={page}
                recordsPerPage={pageSize}
                shownCount={displayedGames.length}
                totalRecords={sortedGames.length}
                isLoading={isLoading || revision === null}
                boundReachedWithMore={boundReachedWithMore}
                onPageChange={setPage}
                onRecordsPerPageChange={handleRecordsPerPageChange}
              />
            </Tabs.Panel>
            <Tabs.Panel value="leaderboard" flex={1} style={{ overflow: "hidden" }}>
              <DataTable
                fetching={isLoading || revision === null}
                withTableBorder
                highlightOnHover
                records={players}
                columns={[
                  {
                    ...numericColumn,
                    accessor: "rank",
                    title: t("Databases.Tournament.Rank"),
                    render: (_player, index) => (
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
        )}
      </Stack>
    </Paper>
  );
}

export default TournamentCard;
