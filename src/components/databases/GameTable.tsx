import {
  Box,
  Collapse,
  Flex,
  Group,
  InputWrapper,
  RangeSlider,
  Select,
  Stack,
} from "@mantine/core";
import { DateInput } from "@mantine/dates";
import { useHotkeys } from "@mantine/hooks";
import { EllipsisVertical } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import dayjs from "dayjs";
import { useAtom, useSetAtom } from "jotai";
import { DataTable } from "mantine-datatable";
import { useContext } from "react";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { useStore } from "zustand";
import type { GameSort, NormalizedGame, Outcome } from "@/bindings";
import { IconAction } from "@/components/common/IconAction";
import { gameRowActivation, useGameOpen } from "@/components/common/gameOpen";
import { inlineFailureMessage, notifyUnlessCancelled } from "@/components/files/notifyError";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { addRecentFileAtom, tabsAtom } from "@/state/atoms";
import { ELO_FILTER_MAX, query_games, sameDatabaseHandle } from "@/utils/db";
import { runTabCreation } from "@/utils/tabs";
import { openDatabaseGame } from "@/utils/databaseGame";
import { DatabaseViewStateContext } from "./DatabaseViewStateContext";
import { dateColumn, numericColumn, truncatedTextColumn } from "./databaseColumns";
import GameCard from "./GameCard";
import GridLayout from "./GridLayout";
import layoutClasses from "./GridLayout.module.css";
import { getAdjacentRecordId } from "./pageSelection";
import { PlayerSearchInput } from "./PlayerSearchInput";
import PlayerRatingCell from "./PlayerRatingCell";
import { SideInput } from "./SideInput";
import sideInputClasses from "./SideInput.module.css";
import classes from "./styles.module.css";

type GameSortAccessor = "date" | "ply_count";
const gameSortAccessors: Partial<Record<GameSort, GameSortAccessor>> = {
  date: "date",
  plyCount: "ply_count",
};
const gameSortByAccessor: Record<GameSortAccessor, GameSort> = {
  date: "date",
  ply_count: "plyCount",
};

function isGameSortAccessor(accessor: string): accessor is GameSortAccessor {
  return accessor === "date" || accessor === "ply_count";
}

function GameTable() {
  const { t } = useTranslation();
  const store = useContext(DatabaseViewStateContext)!;
  const databaseTitle = useStore(store, (s) => s.database?.title);

  const file = useStore(store, (s) => s.database?.file)!;
  const query = useStore(store, (s) => s.games.query);
  const setQuery = useStore(store, (s) => s.setGamesQuery);
  const openedSettings = useStore(store, (s) => s.games.isFilterExpanded);
  const toggleOpenedSettings = useStore(store, (s) => s.toggleGamesOpenedSettings);

  const selectedGameId = useStore(store, (s) => s.games.selectedGameId);
  const setSelectedGameId = useStore(store, (s) => s.setGamesSelectedGameId);
  const generation = useStore(store, (s) => s.database?.collection?.generation);

  const navigate = useNavigate();

  const [, setTabs] = useAtom(tabsAtom);
  const addRecentFile = useSetAtom(addRecentFileAtom);

  const requestKey = generation
    ? (["games", file, query, generation] as const)
    : (["games", file, query] as const);
  const requestOwner = useNativeRequestOwner(requestKey);
  const { data, error, isLoading } = useSWR(requestKey, () =>
    requestOwner!.run((signal) => query_games(file, query, { signal })),
  );

  const games = error ? [] : (data?.data ?? []);
  const game = games.find((game) => game.id === selectedGameId);
  const count = error ? undefined : data?.count;
  const reportOpenError = (error: unknown) => notifyUnlessCancelled(t("Common.Error"), error);
  const gameOpen = useGameOpen(
    (record: NormalizedGame) =>
      runTabCreation({
        create: () =>
          openDatabaseGame({
            game: record,
            database: file,
            setTabs,
            addRecentFile,
            databaseTitle: databaseTitle,
          }),
        onSuccess: () => navigate({ to: "/" }),
        onError: reportOpenError,
      }),
    reportOpenError,
  );

  useHotkeys([
    [
      "ArrowUp",
      () => {
        const id = getAdjacentRecordId(games, selectedGameId, -1);
        if (id != null) setSelectedGameId(id);
      },
    ],
    [
      "ArrowDown",
      () => {
        const id = getAdjacentRecordId(games, selectedGameId, 1);
        if (id != null) setSelectedGameId(id);
        else if (!game && games[0]) setSelectedGameId(games[0].id);
      },
    ],
  ]);

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
                    <RangeSlider
                      step={10}
                      min={0}
                      max={ELO_FILTER_MAX}
                      marks={[
                        { value: 1000, label: String(1000) },
                        { value: 2000, label: String(2000) },
                        { value: ELO_FILTER_MAX, label: String(ELO_FILTER_MAX) },
                      ]}
                      value={query.range1 ?? undefined}
                      onChangeEnd={(value) => setQuery({ ...query, range1: value })}
                    />
                  </InputWrapper>

                  <InputWrapper label="ELO">
                    <RangeSlider
                      step={10}
                      min={0}
                      max={ELO_FILTER_MAX}
                      marks={[
                        { value: 1000, label: String(1000) },
                        { value: 2000, label: String(2000) },
                        { value: ELO_FILTER_MAX, label: String(ELO_FILTER_MAX) },
                      ]}
                      value={query.range2 ?? undefined}
                      onChangeEnd={(value) => setQuery({ ...query, range2: value })}
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
          withTableBorder
          highlightOnHover
          records={games}
          fetching={isLoading}
          customRowAttributes={(record) => ({
            ...gameRowActivation(record, gameOpen.activate),
            "aria-selected": record.id === selectedGameId,
          })}
          columns={[
            {
              accessor: "white",
              title: t("Fen.White"),
              render: ({ white, white_elo }) => <PlayerRatingCell name={white} elo={white_elo} />,
            },
            {
              accessor: "black",
              title: t("Fen.Black"),
              render: ({ black, black_elo }) => <PlayerRatingCell name={black} elo={black_elo} />,
            },
            { ...dateColumn, accessor: "date", title: t("Common.Date"), sortable: true },
            {
              accessor: "result",
              title: t("Board.Database.Local.Result"),
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
            },
            {
              ...truncatedTextColumn<NormalizedGame>((game) => game.site),
              accessor: "site",
              title: t("Databases.Game.Site"),
            },
          ]}
          rowClassName={(record) => (record.id === selectedGameId ? classes.selected : "")}
          noRecordsText={
            inlineFailureMessage(error, "database", t("Databases.LoadError.Title")) ??
            t("Databases.Game.NoGamesFound")
          }
          totalRecords={count!}
          recordsPerPage={query.options?.pageSize ?? 25}
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
            columnAccessor: gameSortAccessors[query.options?.sort ?? "date"] ?? "date",
            direction: query.options?.direction || "desc",
          }}
          onSortStatusChange={(value) => {
            const accessor = value.columnAccessor;
            if (!isGameSortAccessor(accessor)) return;
            setQuery({
              ...query,
              options: {
                ...query.options!,
                sort: gameSortByAccessor[accessor],
                direction: value.direction,
              },
            });
          }}
          recordsPerPageLabel={t("Common.RecordsPerPage")}
          recordsPerPageOptions={[10, 25, 50]}
          onRowClick={({ record }) => {
            setSelectedGameId(record.id);
          }}
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
