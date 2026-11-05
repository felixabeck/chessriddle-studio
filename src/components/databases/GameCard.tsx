import { tauri } from "@/platform/tauri";
import { Box, Divider, Group, Paper, Stack, Text } from "@mantine/core";
import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useContext, useEffect, useRef, useState } from "react";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { DatabaseLayoutContext } from "@/state/databaseLayout";
import { useSWRConfig } from "swr";
import { type DatabaseHandle, type NormalizedGame } from "@/bindings";
import { OpenGameButton } from "@/components/common/gameOpen";
import { IconAction } from "@/components/common/IconAction";
import ConfirmModal from "@/components/common/ConfirmModal";
import GameInfo from "../common/GameInfo";
import GamePreview from "./GamePreview";
import { refreshDatabaseGameQueries } from "./databaseMutation";
import classes from "./GridLayout.module.css";

function GameCard({
  game,
  file,
  onOpen,
  pending,
  onDeleted,
}: {
  game?: NormalizedGame;
  file: DatabaseHandle;
  onOpen: (game: NormalizedGame) => void | Promise<void>;
  pending: boolean;
  onDeleted?: (file: DatabaseHandle, gameId: number) => void;
}) {
  const { t } = useTranslation();
  const { compact } = useContext(DatabaseLayoutContext);
  const { cache, mutate: globalMutate } = useSWRConfig();
  const [deleting, setDeleting] = useState(false);
  const [deleteSnapshot, setDeleteSnapshot] = useState<{
    game: NormalizedGame;
    file: DatabaseHandle;
  } | null>(null);
  const deletionPending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const deleteGame = async () => {
    if (!deleteSnapshot || deletionPending.current) return;
    const { game, file: targetFile } = deleteSnapshot;
    const targetGameId = game.id;
    deletionPending.current = true;
    setDeleting(true);
    try {
      try {
        if (game.linked) {
          await tauri.editLinkedCollection(game.linked.collection, game.linked.generation, {
            kind: "delete",
            games: [game.linked],
          });
        } else await tauri.deleteDbGame(targetFile, targetGameId);
      } catch (error) {
        if (mounted.current) notifyUnlessCancelled(t("Common.Error"), error);
        return;
      }

      onDeleted?.(targetFile, targetGameId);

      try {
        const refreshed = await refreshDatabaseGameQueries(targetFile, cache, globalMutate);
        for (const result of refreshed) {
          if (result.status === "rejected" && mounted.current) {
            notifyUnlessCancelled(t("Databases.Game.DeletedRefreshFailed"), result.reason);
          }
        }
      } catch (error) {
        if (mounted.current) notifyUnlessCancelled(t("Databases.Game.DeletedRefreshFailed"), error);
      }
    } finally {
      deletionPending.current = false;
      if (mounted.current) setDeleting(false);
    }
  };

  return (
    <Paper shadow="sm" p="sm" withBorder h={compact ? "auto" : "100%"} className={classes.gameCard}>
      <ConfirmModal
        title={t("Databases.Game.Delete")}
        description={t("Databases.Game.DeleteConfirm", {
          white: deleteSnapshot?.game.white || "?",
          black: deleteSnapshot?.game.black || "?",
          date: deleteSnapshot?.game.date || "?",
        })}
        opened={deleteSnapshot !== null}
        onClose={() => setDeleteSnapshot(null)}
        onConfirm={deleteGame}
      />
      <Stack gap="xs" className={classes.gameCardStack}>
        <Group justify="left" className={classes.gameActions}>
          <OpenGameButton disabled={!game} pending={pending} onOpen={() => game && onOpen(game)} />

          <IconAction
            label={t("Databases.Game.Delete")}
            variant="subtle"
            color="danger"
            disabled={!game}
            pending={deleting}
            onClick={() => game && setDeleteSnapshot({ game, file })}
          >
            <Trash2 size="1.2rem" strokeWidth={2} />
          </IconAction>
        </Group>
        <Divider />
        {game ? (
          <>
            <Box className={classes.gameMetadata}>
              <GameInfo headers={game} />
            </Box>
            <Divider />
            <GamePreview pgn={game.moves} headers={game} showOpening adaptive />
          </>
        ) : (
          <Text>{t("Databases.Game.NoSelection")}</Text>
        )}
      </Stack>
    </Paper>
  );
}

export default GameCard;
