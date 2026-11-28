import { useAtomValue } from "jotai";
import { DataTable } from "mantine-datatable";
import { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DatabaseHandle, NormalizedGame } from "@/bindings";
import { gameRowActivation } from "@/components/common/gameOpen";
import { useOpenDatabaseGame } from "@/components/common/useOpenDatabaseGame";
import { dateColumn, tableScrollAreaProps } from "@/components/databases/databaseColumns";
import PlayerRatingCell from "@/components/databases/PlayerRatingCell";
import { moveNotationTypeAtom } from "@/state/atoms";
import { addPieceSymbol } from "@/utils/annotation";
import { formatNumberedMove } from "@/utils/format";
import { type GameNotationPart, gameNotationPreview } from "./gameNotation";
import classes from "./GamesTable.module.css";

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
  const moveNotationType = useAtomValue(moveNotationTypeAtom);
  const [page, setPage] = useState(1);
  const filteredGames = useMemo(() => games.slice((page - 1) * 20, page * 20), [games, page]);
  const notations = useMemo(
    () => new Map(filteredGames.map((game) => [game, gameNotationPreview(game, targetFen)])),
    [filteredGames, targetFen],
  );

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
      classNames={{ table: classes.table }}
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
          cellsStyle: () => ({ overflowWrap: "anywhere" }),
          render: ({ white, white_elo }) => <PlayerRatingCell name={white} elo={white_elo} />,
        },
        {
          accessor: "black",
          title: t("Fen.Black"),
          cellsStyle: () => ({ overflowWrap: "anywhere" }),
          render: ({ black, black_elo }) => <PlayerRatingCell name={black} elo={black_elo} />,
        },
        {
          accessor: "notation",
          title: t("Board.Area.Notation"),
          render: (game) => {
            const notation = notations.get(game);
            if (!notation || notation.preview.length === 0) return null;
            const formatSan = (san: string) =>
              moveNotationType === "symbols" ? addPieceSymbol(san) : san;
            const formatPart = (part: GameNotationPart) => formatNumberedMove(part, formatSan);
            const fullText = notation.full.map(formatPart).join(" ");
            const [first, ...rest] = notation.preview;
            const restText = rest.map(formatPart).join(" ");
            return (
              <span
                title={fullText}
                style={{
                  display: "block",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {first.moveNumber ? `${first.moveNumber} ` : null}
                <strong>{formatSan(first.san)}</strong>
                {restText ? ` ${restText}` : null}
                {notation.hasMore ? " …" : null}
              </span>
            );
          },
        },
        { ...dateColumn, accessor: "date", title: t("Common.Date") },
        {
          accessor: "result",
          title: t("Board.Database.Local.Result"),
          noWrap: true,
        },
      ]}
      noRecordsText={t("Databases.Game.NoGamesFound")}
    />
  );
}

export default memo(GamesTable);
