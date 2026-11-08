import { tauri } from "@/platform/tauri";
import { Center, Flex, Text, TextInput } from "@mantine/core";
import { Search } from "lucide-react";
import { DataTable } from "mantine-datatable";
import { useContext } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { useStore } from "zustand";
import { type Event, type TournamentSort } from "@/bindings";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { DatabaseViewStateContext } from "./DatabaseViewStateContext";
import {
  dateColumn,
  formatEventDateRange,
  numericColumn,
  truncatedTextColumn,
} from "./databaseColumns";
import GridLayout from "./GridLayout";
import { getAdjacentRecordId } from "./pageSelection";
import classes from "./styles.module.css";
import TournamentCard from "./TournamentCard";

function TournamentTable() {
  const { t } = useTranslation();
  const store = useContext(DatabaseViewStateContext)!;

  const file = useStore(store, (s) => s.database?.file)!;
  const query = useStore(store, (s) => s.tournaments.query);
  const selected = useStore(store, (s) => s.tournaments.selectedTournament);
  const setQuery = useStore(store, (s) => s.setTournamentsQuery);
  const setSelected = useStore(store, (s) => s.setTournamentsSelectedTournament);

  const requestKey = ["tournaments", file, query] as const;
  const requestOwner = useNativeRequestOwner(requestKey);
  const { data, error, isLoading } = useSWR(requestKey, () =>
    requestOwner!.run((signal) => tauri.getTournaments(file, query, { signal })),
  );
  const tournaments = data?.data ?? [];
  const count = data?.count;
  const tournament = tournaments.find((t) => t.id === selected);

  useHotkeys("ArrowUp", () => {
    const id = getAdjacentRecordId(tournaments, selected, -1);
    if (id != null) {
      setSelected(id);
    }
  });
  useHotkeys("ArrowDown", () => {
    const id = getAdjacentRecordId(tournaments, selected, 1);
    if (id != null) {
      setSelected(id);
    }
  });

  return (
    <GridLayout
      search={
        <Flex style={{ alignItems: "center", gap: 10 }}>
          <TextInput
            style={{ flexGrow: 1 }}
            placeholder={t("Common.Search")}
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
          withTableBorder
          highlightOnHover
          records={tournaments}
          fetching={isLoading}
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
          rowClassName={(t) => (t.id === selected ? classes.selected : "")}
          noRecordsText={
            error
              ? `${t("Common.Error")}: ${error instanceof Error ? error.message : String(error)}`
              : t("Databases.Tournament.NoneFound")
          }
          totalRecords={count!}
          recordsPerPage={query.options.pageSize ?? 25}
          page={query.options.page ?? 1}
          onPageChange={(page) =>
            setQuery({
              ...query,
              options: {
                ...query.options!,
                page,
              },
            })
          }
          onRecordsPerPageChange={(value) =>
            setQuery({
              ...query,
              options: { ...query.options!, pageSize: value },
            })
          }
          sortStatus={{
            columnAccessor: (
              {
                date: "start_date",
                players: "player_count",
                games: "game_count",
                avgElo: "avg_elo",
                name: "name",
              } as const
            )[query.options.sort],
            direction: query.options?.direction || "desc",
          }}
          onSortStatusChange={(value) =>
            setQuery({
              ...query,
              options: {
                ...query.options!,
                sort:
                  (
                    {
                      start_date: "date",
                      player_count: "players",
                      game_count: "games",
                      avg_elo: "avgElo",
                      name: "name",
                    } as Record<string, TournamentSort>
                  )[value.columnAccessor] ?? "date",
                direction: value.direction,
              },
            })
          }
          recordsPerPageLabel={t("Common.RecordsPerPage")}
          recordsPerPageOptions={[10, 25, 50]}
          onRowClick={({ index }) => {
            setSelected(tournaments[index].id);
          }}
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
