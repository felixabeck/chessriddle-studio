import { Text } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useAtom, useSetAtom } from "jotai";
import { DataTable } from "mantine-datatable";
import { memo, useEffect, useState } from "react";
import type { DatabaseHandle, NormalizedGame } from "@/bindings";
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
        const game = e.record;
        void runTabCreation({
          create: () =>
            openDatabaseGame({ game: game, database: databasePath, setTabs, addRecentFile }),
          onSuccess: () => navigate({ to: "/" }),
          onError: (error) => notifyUnlessCancelled(t("Common.Error"), error),
        });
      }}
      columns={[
        {
          accessor: "white",
          render: ({ white, white_elo }) => (
            <div>
              <Text size="sm" fw={500}>
                {white}
              </Text>
              <Text size="xs" c="dimmed">
                {white_elo === 0 ? "Unrated" : white_elo}
              </Text>
            </div>
          ),
        },
        {
          accessor: "black",
          render: ({ black, black_elo }) => (
            <div>
              <Text size="sm" fw={500}>
                {black}
              </Text>
              <Text size="xs" c="dimmed">
                {black_elo === 0 ? "Unrated" : black_elo}
              </Text>
            </div>
          ),
        },
        { accessor: "date" },
        { accessor: "result" },
        { accessor: "ply_count" },
      ]}
      noRecordsText="No games found"
    />
  );
}

export default memo(GamesTable);
