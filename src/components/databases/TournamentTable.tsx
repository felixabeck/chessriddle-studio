import { tauri } from "@/platform/tauri";
import { Center, Flex, Text, TextInput } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { Search } from "lucide-react";
import { DataTable } from "mantine-datatable";
import { useContext } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { useStore } from "zustand";
import type { Event, TournamentSort } from "@/bindings";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { NAME_SEARCH_DEBOUNCE_MS } from "@/utils/db";
import { DatabaseViewStateContext } from "./DatabaseViewStateContext";
import {
  dateColumn,
  formatEventDateRange,
  numericColumn,
  truncatedTextColumn,
} from "./databaseColumns";
import GridLayout from "./GridLayout";
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
  const [debouncedQuery] = useDebouncedValue(query, NAME_SEARCH_DEBOUNCE_MS);
  const selected = useStore(store, (s) => s.tournaments.selectedTournament);
  const setQuery = useStore(store, (s) => s.setTournamentsQuery);
  const setSelected = useStore(store, (s) => s.setTournamentsSelectedTournament);

  const requestKey = ["tournaments", file, debouncedQuery] as const;
  const requestOwner = useNativeRequestOwner(requestKey);
  const { data, error, isLoading } = useSWR(requestKey, () =>
    requestOwner!.run((signal) => tauri.getTournaments(file, debouncedQuery, { signal })),
  );
  const tournaments = data?.data ?? [];
  const count = data?.count;
  const tournament = tournaments.find((t) => t.id === selected);

  const table = useDatabaseListTable({
    records: tournaments,
    count,
    error,
    isLoading,
    query,
    setQuery,
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
        <DataTable<Event>
          {...table}
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
