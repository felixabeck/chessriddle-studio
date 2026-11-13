import { useNavigate } from "@tanstack/react-router";
import { useAtom, useSetAtom } from "jotai";
import { DataTable } from "mantine-datatable";
import { memo, useEffect, useState } from "react";
import type { DatabaseHandle, NormalizedGame } from "@/bindings";
import { gameRowActivation, useGameOpen } from "@/components/common/gameOpen";
import PlayerRatingCell from "@/components/databases/PlayerRatingCell";
import { dateColumn, numericColumn } from "@/components/databases/databaseColumns";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { addRecentFileAtom, tabsAtom } from "@/state/atoms";
import { runTabCreation } from "@/utils/tabs";
import { openDatabaseGame } from "@/utils/databaseGame";
import { useTranslation } from "react-i18next";

function GamesTable({
  games,
  loading,
  databasePath,
}: {
  games: NormalizedGame[];
  loading: boolean;
  databasePath?: DatabaseHandle | null;
}) {
  const [, setTabs] = useAtom(tabsAtom);
  const addRecentFile = useSetAtom(addRecentFileAtom);
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const filteredGames = games.slice((page - 1) * 20, page * 20);

  useEffect(() => {
    setPage(1);
  }, [games]);

  const navigate = useNavigate();
  const reportOpenError = (error: unknown) => notifyUnlessCancelled(t("Common.Error"), error);
  const gameOpen = useGameOpen(
    (game: NormalizedGame) =>
      runTabCreation({
        create: () => openDatabaseGame({ game, database: databasePath, setTabs, addRecentFile }),
        onSuccess: () => navigate({ to: "/" }),
        onError: reportOpenError,
      }),
    reportOpenError,
  );
  return (
    <DataTable
      withTableBorder
      highlightOnHover
      records={filteredGames}
      fetching={loading}
      totalRecords={games.length}
      recordsPerPage={20}
      page={page}
      onPageChange={setPage}
      onRowClick={(e) => {
        void gameOpen.activate(e.record);
      }}
      customRowAttributes={(record) => ({
        tabIndex: 0,
        onKeyDown: gameRowActivation(record, gameOpen.activate).onKeyDown,
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
        { ...dateColumn, accessor: "date", title: t("Common.Date") },
        { accessor: "result", title: t("Board.Database.Local.Result") },
        { ...numericColumn, accessor: "ply_count", title: t("Databases.Game.Plies") },
      ]}
      noRecordsText={t("Databases.Game.NoGamesFound")}
    />
  );
}

export default memo(GamesTable);
