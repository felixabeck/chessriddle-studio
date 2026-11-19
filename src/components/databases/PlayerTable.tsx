import { Center, Collapse, Flex, Group, Text, TextInput } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { EllipsisVertical, Search } from "lucide-react";
import { DataTable } from "mantine-datatable";
import { useContext, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { useStore } from "zustand";
import type { Player, PlayerSort } from "@/bindings";
import DraftNumberInput from "@/components/common/DraftNumberInput";
import { gameRowActivation } from "@/components/common/gameOpen";
import { IconAction } from "@/components/common/IconAction";
import { inlineFailureMessage } from "@/components/files/notifyError";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { ELO_FILTER_MAX, NAME_SEARCH_DEBOUNCE_MS, query_players } from "@/utils/db";
import { DatabaseViewStateContext } from "./DatabaseViewStateContext";
import { numericColumn } from "./databaseColumns";
import GridLayout from "./GridLayout";
import { getAdjacentRecordId } from "./pageSelection";
import PlayerCard from "./PlayerCard";
import classes from "./styles.module.css";

// The native query takes whole-number bounds; a fraction or an out-of-range number is not stored.
function isEloBound(value: number | string): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= ELO_FILTER_MAX;
}

function PlayerTable() {
  const { t } = useTranslation();
  const store = useContext(DatabaseViewStateContext)!;

  const file = useStore(store, (s) => s.database?.file)!;
  const query = useStore(store, (s) => s.players.query);
  const [debouncedQuery] = useDebouncedValue(query, NAME_SEARCH_DEBOUNCE_MS);
  const setQuery = useStore(store, (s) => s.setPlayersQuery);

  const selectedPlayer = useStore(store, (s) => s.players.selectedPlayer);
  const setSelectedPlayer = useStore(store, (s) => s.setPlayersSelectedPlayer);

  const requestKey = ["players", file, debouncedQuery] as const;
  const requestOwner = useNativeRequestOwner(requestKey);
  const { data, error, isLoading } = useSWR(requestKey, () =>
    requestOwner!.run((signal) => query_players(file, debouncedQuery, { signal })),
  );
  const players = data?.data ?? [];
  const count = data?.count;
  const player = players.find((p) => p.id === selectedPlayer);

  const [open, setOpen] = useState(false);

  useHotkeys("ArrowUp", () => {
    const id = getAdjacentRecordId(players, selectedPlayer, -1);
    if (id != null) {
      setSelectedPlayer(id);
    }
  });
  useHotkeys("ArrowDown", () => {
    const id = getAdjacentRecordId(players, selectedPlayer, 1);
    if (id != null) {
      setSelectedPlayer(id);
    }
  });

  return (
    <GridLayout
      search={
        <>
          <Flex style={{ alignItems: "center", gap: 10 }}>
            <TextInput
              style={{ flexGrow: 1 }}
              placeholder={t("Common.Search")}
              aria-label={t("Common.Search")}
              leftSection={<Search size="1rem" />}
              value={query.name ?? undefined}
              onChange={(e) =>
                setQuery({
                  ...query,
                  name: e.currentTarget.value,
                  options: {
                    ...query.options,
                    page: 1,
                  },
                })
              }
            />
            <IconAction
              label={t("Common.MoreOptions")}
              pressed={open}
              style={{ flexGrow: 0 }}
              onClick={() => setOpen((prev) => !prev)}
            >
              <EllipsisVertical size="1rem" />
            </IconAction>
          </Flex>

          <Collapse in={open}>
            <Group mt="md">
              <DraftNumberInput
                label={t("Databases.Player.MinELO")}
                value={query.range?.[0] ?? 0}
                // An emptied field drops the bound; an out-of-range draft waits for the blur clamp.
                onChange={(v) => {
                  if (isEloBound(v) || v === "")
                    setQuery({
                      ...query,
                      range: [v === "" ? 0 : v, query.range?.[1] ?? ELO_FILTER_MAX],
                    });
                }}
                min={0}
                max={ELO_FILTER_MAX}
                allowDecimal={false}
                step={100}
              />
              <DraftNumberInput
                label={t("Databases.Player.MaxELO")}
                value={query.range?.[1] ?? ELO_FILTER_MAX}
                min={0}
                max={ELO_FILTER_MAX}
                allowDecimal={false}
                step={100}
                onChange={(v) => {
                  if (isEloBound(v) || v === "")
                    setQuery({
                      ...query,
                      range: [query.range?.[0] ?? 0, v === "" ? ELO_FILTER_MAX : v],
                    });
                }}
              />
            </Group>
          </Collapse>
        </>
      }
      table={
        <DataTable<Player>
          withTableBorder
          highlightOnHover
          records={players}
          fetching={isLoading}
          customRowAttributes={(record) => ({
            ...gameRowActivation(record.id, (id) => void setSelectedPlayer(id)),
            "aria-selected": record.id === selectedPlayer,
          })}
          columns={[
            { accessor: "name", title: t("Common.Name"), sortable: true },
            {
              ...numericColumn,
              accessor: "elo",
              title: t("Board.Database.Local.Elo"),
              sortable: true,
            },
            {
              ...numericColumn,
              accessor: "game_count",
              title: t("Board.Database.Games"),
              sortable: true,
            },
          ]}
          rowClassName={(r) => (r.id === selectedPlayer ? classes.selected : "")}
          noRecordsText={
            inlineFailureMessage(error, "database", t("Databases.LoadError.Title")) ??
            t("Databases.Player.NoPlayersFound")
          }
          totalRecords={count!}
          recordsPerPage={query.options.pageSize ?? 25}
          page={query.options?.page ?? 1}
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
            columnAccessor:
              query.options?.sort === "games" ? "game_count" : query.options?.sort || "name",
            direction: query.options?.direction || "desc",
          }}
          onSortStatusChange={(value) =>
            setQuery({
              ...query,
              options: {
                ...query.options!,
                sort:
                  value.columnAccessor === "game_count"
                    ? "games"
                    : (value.columnAccessor as PlayerSort),
                direction: value.direction,
              },
            })
          }
          recordsPerPageLabel={t("Common.RecordsPerPage")}
          recordsPerPageOptions={[10, 25, 50]}
          onRowClick={({ index }) => {
            setSelectedPlayer(players[index].id);
          }}
        />
      }
      preview={
        player != null ? (
          <PlayerCard player={player} file={file} />
        ) : (
          <Center h="100%">
            <Text>{t("Databases.Player.NoSelection")}</Text>
          </Center>
        )
      }
    />
  );
}

export default PlayerTable;
