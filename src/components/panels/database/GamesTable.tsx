import { DataTable } from "mantine-datatable";
import { memo, useEffect, useState } from "react";
import type { DatabaseHandle, NormalizedGame } from "@/bindings";
import { gameRowActivation } from "@/components/common/gameOpen";
import { useOpenDatabaseGame } from "@/components/common/useOpenDatabaseGame";
import PlayerRatingCell from "@/components/databases/PlayerRatingCell";
import {
  dateColumn,
  numericColumn,
  tableScrollAreaProps,
} from "@/components/databases/databaseColumns";
import { useTranslation } from "react-i18next";

function GamesTable({
  games,
  loading,
  databasePath,
  targetFen,
}: {
  games: NormalizedGame[];
  loading: boolean;
  databasePath?: DatabaseHandle | null;
  /** The position the games were searched for; each opens there when its mainline reaches it. */
  targetFen?: string;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const filteredGames = games.slice((page - 1) * 20, page * 20);

  useEffect(() => {
    setPage(1);
  }, [games]);

  const gameOpen = useOpenDatabaseGame((game: NormalizedGame) => ({
    game,
    database: databasePath,
    targetFens: targetFen === undefined ? undefined : [targetFen],
  }));
  return (
    <DataTable
      withTableBorder
      highlightOnHover
      scrollAreaProps={tableScrollAreaProps}
      records={filteredGames}
      fetching={loading}
      totalRecords={games.length}
      recordsPerPage={20}
      page={page}
      onPageChange={setPage}
      onRowClick={({ record }) => void gameOpen.activate(record)}
      customRowAttributes={(record) => {
        // Single click already opens through onRowClick, so the row takes only focus and Enter
        // from the shared activation; its double-click would open a second tab after a fast open.
        const { tabIndex, onKeyDown } = gameRowActivation(record, gameOpen.activate);
        return { tabIndex, onKeyDown };
      }}
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
