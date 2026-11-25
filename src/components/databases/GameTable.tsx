import { Box, Collapse, Flex, Group, InputWrapper, Select, Stack } from "@mantine/core";
import { DateInput } from "@mantine/dates";
import { EllipsisVertical } from "lucide-react";
import dayjs from "dayjs";
import { DataTable } from "mantine-datatable";
import { useContext } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { useStore } from "zustand";
import type { GameSort, NormalizedGame, Outcome } from "@/bindings";
import { EloRangeSlider } from "@/components/common/EloRangeSlider";
import { IconAction } from "@/components/common/IconAction";
import { useOpenDatabaseGame } from "@/components/common/useOpenDatabaseGame";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { query_games, sameDatabaseHandle } from "@/utils/db";
import { failureUnlessCancelled } from "@/platform/errors";
import { DatabaseViewStateContext } from "./DatabaseViewStateContext";
import { dateColumn, numericColumn, truncatedTextColumn } from "./databaseColumns";
import GameCard from "./GameCard";
import GridLayout from "./GridLayout";
import layoutClasses from "./GridLayout.module.css";
import { PlayerSearchInput } from "./PlayerSearchInput";
import PlayerRatingCell from "./PlayerRatingCell";
import { SideInput } from "./SideInput";
import sideInputClasses from "./SideInput.module.css";
import { useDatabaseListTable } from "./useDatabaseListTable";

const gameSortByAccessor = {
  white: "white",
  black: "black",
  date: "date",
  result: "result",
  ply_count: "plyCount",
  event: "event",
  site: "site",
} as const satisfies Partial<Record<keyof NormalizedGame, GameSort>>;
type GameSortAccessor = keyof typeof gameSortByAccessor;
const gameSortAccessors = Object.fromEntries(
  Object.entries(gameSortByAccessor).map(([accessor, sort]) => [sort, accessor]),
) as Partial<Record<GameSort, GameSortAccessor>>;

function isGameSortAccessor(accessor: string): accessor is GameSortAccessor {
  return Object.hasOwn(gameSortByAccessor, accessor);
}

function GameTable() {
  const { t } = useTranslation();
  const store = useContext(DatabaseViewStateContext)!;

  const file = useStore(store, (s) => s.database?.file)!;
  const query = useStore(store, (s) => s.games.query);
  const setQuery = useStore(store, (s) => s.setGamesQuery);
  const openedSettings = useStore(store, (s) => s.games.isFilterExpanded);
  const toggleOpenedSettings = useStore(store, (s) => s.toggleGamesOpenedSettings);

  const selectedGameId = useStore(store, (s) => s.games.selectedGameId);
  const setSelectedGameId = useStore(store, (s) => s.setGamesSelectedGameId);
  const generation = useStore(store, (s) => s.database?.collection?.generation);

  const requestKey = generation
    ? (["games", file, query, generation] as const)
    : (["games", file, query] as const);
  const requestOwner = useNativeRequestOwner(requestKey);
  const { data, error, isLoading } = useSWR(requestKey, () =>
    requestOwner!.run((signal) => query_games(file, query, { signal })),
  );

  const failure = failureUnlessCancelled(error);
  const games = failure ? [] : (data?.data ?? []);
  const game = games.find((game) => game.id === selectedGameId);
  const count = failure ? undefined : data?.count;
  const gameOpen = useOpenDatabaseGame((record: NormalizedGame) => ({
    game: record,
    database: file,
  }));

  const table = useDatabaseListTable({
    records: games,
    count,
    error,
    isLoading,
    query,
    setQuery,
    selectedId: selectedGameId,
    setSelectedId: setSelectedGameId,
    sortAccessor: (sort) => gameSortAccessors[sort ?? "date"] ?? "date",
    sortOf: (accessor) => (isGameSortAccessor(accessor) ? gameSortByAccessor[accessor] : undefined),
    emptyText: t("Databases.Game.NoGamesFound"),
    activate: gameOpen.activate,
  });

  return (
    <GridLayout
      search={
        <Flex style={{ gap: 20 }} className={layoutClasses.searchRow}>
          <Box
            style={{ flexGrow: 1 }}
            className={`${layoutClasses.searchFields} ${sideInputClasses.fields}`}
          >
            <Group grow>
              <PlayerSearchInput
                value={query?.player1 ?? undefined}
                setValue={(value) => setQuery({ ...query, player1: value })}
                rightSection={
                  <SideInput
                    sides={query.sides!}
                    setSides={(value) => setQuery({ ...query, sides: value })}
                    role="player"
                  />
                }
                label={t("Board.Database.Local.Player")}
                file={file}
              />
              <PlayerSearchInput
                value={query?.player2 ?? undefined}
                setValue={(value) => setQuery({ ...query, player2: value })}
                rightSection={
                  <SideInput
                    sides={query.sides!}
                    setSides={(value) => setQuery({ ...query, sides: value })}
                    role="opponent"
                  />
                }
                label={t("Board.Database.Local.Opponent")}
                file={file}
              />
            </Group>
            <Collapse in={openedSettings} mx={10}>
              <Stack mt="md">
                <Group grow>
                  <InputWrapper label="ELO">
                    <EloRangeSlider
                      value={query.range1}
                      onCommit={(value) => setQuery({ ...query, range1: value })}
                    />
                  </InputWrapper>

                  <InputWrapper label="ELO">
                    <EloRangeSlider
                      value={query.range2}
                      onCommit={(value) => setQuery({ ...query, range2: value })}
                    />
                  </InputWrapper>
                </Group>
                <Select
                  label={t("Board.Database.Local.Result")}
                  value={query.outcome}
                  onChange={(value) =>
                    setQuery({
                      ...query,
                      outcome: (value as Outcome | null) ?? undefined,
                    })
                  }
                  clearable
                  placeholder={t("Common.PickValue")}
                  data={[
                    { label: t("Board.Analysis.Tablebase.WhiteWins"), value: "1-0" },
                    { label: t("Board.Analysis.Tablebase.BlackWins"), value: "0-1" },
                    { label: t("Board.Analysis.Tablebase.Draw"), value: "1/2-1/2" },
                  ]}
                />
                <Group>
                  <DateInput
                    label={t("Common.From")}
                    placeholder={t("Common.StartDate")}
                    clearable
                    valueFormat="YYYY-MM-DD"
                    value={query.startDate ? dayjs(query.startDate, "YYYY.MM.DD").toDate() : null}
                    onChange={(value) =>
                      setQuery({
                        ...query,
                        startDate: value ? dayjs(value).format("YYYY.MM.DD") : undefined,
                      })
                    }
                  />
                  <DateInput
                    label={t("Common.To")}
                    placeholder={t("Common.EndDate")}
                    clearable
                    valueFormat="YYYY-MM-DD"
                    value={query.endDate ? dayjs(query.endDate, "YYYY.MM.DD").toDate() : null}
                    onChange={(value) =>
                      setQuery({
                        ...query,
                        endDate: value ? dayjs(value).format("YYYY.MM.DD") : undefined,
                      })
                    }
                  />
                </Group>
              </Stack>
            </Collapse>
          </Box>
          <IconAction
            label={t("Common.MoreOptions")}
            pressed={openedSettings}
            style={{ flexGrow: 0 }}
            onClick={() => toggleOpenedSettings()}
          >
            <EllipsisVertical size="1rem" />
          </IconAction>
        </Flex>
      }
      table={
        <DataTable<NormalizedGame>
          {...table}
          columns={[
            {
              accessor: "white",
              title: t("Fen.White"),
              sortable: true,
              render: ({ white, white_elo }) => <PlayerRatingCell name={white} elo={white_elo} />,
            },
            {
              accessor: "black",
              title: t("Fen.Black"),
              sortable: true,
              render: ({ black, black_elo }) => <PlayerRatingCell name={black} elo={black_elo} />,
            },
            { ...dateColumn, accessor: "date", title: t("Common.Date"), sortable: true },
            {
              accessor: "result",
              title: t("Board.Database.Local.Result"),
              sortable: true,
              render: ({ result }) => result?.replaceAll("1/2", "½"),
            },
            {
              ...numericColumn,
              accessor: "ply_count",
              title: t("Databases.Game.Plies"),
              sortable: true,
            },
            {
              ...truncatedTextColumn<NormalizedGame>((game) => game.event),
              accessor: "event",
              title: t("Databases.Game.Event"),
              sortable: true,
            },
            {
              ...truncatedTextColumn<NormalizedGame>((game) => game.site),
              accessor: "site",
              title: t("Databases.Game.Site"),
              sortable: true,
            },
          ]}
        />
      }
      preview={
        <GameCard
          game={game}
          file={file}
          onOpen={gameOpen.activate}
          pending={gameOpen.pending}
          onDeleted={(deletedFile) => {
            if (sameDatabaseHandle(store.getState().database?.file, deletedFile)) {
              // A refused clear is harmless because the deleted ID matches no remaining row.
              setSelectedGameId(undefined);
            }
          }}
        />
      }
    />
  );
}

export default GameTable;
