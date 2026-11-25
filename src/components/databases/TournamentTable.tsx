import { tauri } from "@/platform/tauri";
import { Box, Center, Flex, Text, TextInput } from "@mantine/core";
import { Search } from "lucide-react";
import { DataTable } from "mantine-datatable";
import { useContext } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { Event, TournamentSort } from "@/bindings";
import { NAME_SEARCH_DEBOUNCE_MS } from "@/utils/db";
import { DatabaseListFooter } from "./DatabaseListFooter";
import { DatabaseViewStateContext } from "./DatabaseViewStateContext";
import {
  dateColumn,
  formatEventDateRange,
  numericColumn,
  truncatedTextColumn,
} from "./databaseColumns";
import GridLayout from "./GridLayout";
import layoutClasses from "./GridLayout.module.css";
import { useDatabaseListQuery } from "./useDatabaseListQuery";
import { useDatabaseListTable } from "./useDatabaseListTable";
import TournamentCard from "./TournamentCard";

const tournamentSortAccessors: Record<TournamentSort, string> = {
  date: "start_date",
  players: "player_count",
  games: "game_count",
  avgElo: "avg_elo",
  name: "name",
};
const tournamentSortByAccessor: Record<string, TournamentSort> = Object.fromEntries(
  Object.entries(tournamentSortAccessors).map(([sort, accessor]) => [accessor, sort]),
) as Record<string, TournamentSort>;

function TournamentTable() {
  const { t } = useTranslation();
  const store = useContext(DatabaseViewStateContext)!;

  const file = useStore(store, (s) => s.database?.file)!;
  const query = useStore(store, (s) => s.tournaments.query);
  const listMode = useStore(store, (s) => s.tournaments.listMode);
  const selected = useStore(store, (s) => s.tournaments.selectedTournament);
  const setQuery = useStore(store, (s) => s.setTournamentsQuery);
  const setRecordsPerPage = useStore(store, (s) => s.setTournamentsRecordsPerPage);
  const setSelected = useStore(store, (s) => s.setTournamentsSelectedTournament);
  const generation = useStore(store, (s) => s.database?.collection?.generation);

  const list = useDatabaseListQuery({
    kind: "tournaments",
    file,
    query,
    mode: listMode,
    generation,
    debounceMs: NAME_SEARCH_DEBOUNCE_MS,
    fetchPage: tauri.getTournaments,
  });
  const tournament = list.records.find((row) => row.id === selected);

  const { tableProps, footerProps } = useDatabaseListTable({
    list,
    mode: listMode,
    query,
    setQuery,
    setRecordsPerPage,
    selectedId: selected,
    setSelectedId: setSelected,
    sortAccessor: (sort) => tournamentSortAccessors[sort ?? "date"],
    sortOf: (accessor) => tournamentSortByAccessor[accessor] ?? "date",
    emptyText: t("Databases.Tournament.NoneFound"),
    activate: (record) => void setSelected(record.id),
  });

  return (
    <GridLayout
      search={
        <Flex style={{ alignItems: "center", gap: 10 }}>
          <TextInput
            style={{ flexGrow: 1 }}
            placeholder={t("Common.Search")}
            aria-label={t("Common.Search")}
            leftSection={<Search size="1rem" />}
            value={query.name ?? ""}
            onChange={(v) =>
              setQuery({
                ...query,
                name: v.currentTarget.value,
              })
            }
          />
        </Flex>
      }
      table={
        <>
          <Box className={layoutClasses.tableViewport}>
            <DataTable<Event>
              {...tableProps}
              columns={[
                { accessor: "name", title: t("Common.Name"), sortable: true },
                {
                  ...dateColumn,
                  accessor: "start_date",
                  title: t("Common.Date"),
                  sortable: true,
                  render: ({ start_date, end_date }) => formatEventDateRange(start_date, end_date),
                },
                {
                  ...truncatedTextColumn<Event>((event) => event.site),
                  accessor: "site",
                  title: t("Databases.Game.Site"),
                },
                {
                  ...numericColumn,
                  accessor: "player_count",
                  title: t("Databases.Card.Players"),
                  sortable: true,
                },
                {
                  ...numericColumn,
                  accessor: "game_count",
                  title: t("Common.Games"),
                  sortable: true,
                },
                {
                  ...numericColumn,
                  accessor: "avg_elo",
                  title: t("Databases.Tournament.AvgElo"),
                  sortable: true,
                },
              ]}
            />
          </Box>
          <DatabaseListFooter {...footerProps} />
        </>
      }
      preview={
        tournament != null ? (
          <TournamentCard tournament={tournament} file={file} key={tournament.id} />
        ) : (
          <Center h="100%">
            <Text>{t("Databases.Tournament.NoSelection")}</Text>
          </Center>
        )
      }
    />
  );
}

export default TournamentTable;
