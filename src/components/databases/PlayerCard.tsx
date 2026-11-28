import { Center, Loader, Paper, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { DatabaseHandle, Player, PlayerGameInfo } from "@/bindings";
import { inlineFailureMessage } from "@/components/files/notifyError";
import { failureUnlessCancelled } from "@/platform/errors";
import { databaseHandleKey } from "@/utils/db";
import PersonalPlayerCard, { type OnlineStatistics } from "../home/PersonalCard";
import OpponentAccounts, { OpponentAccountAdd, useOpponentAccounts } from "./OpponentAccounts";
import { type OnlineGames, useOnlineGames } from "./useOnlineGames";
import { type PlayerGameInfoState, usePlayerGameInfo } from "./usePlayerGameInfo";

/**
 * What the Overview and Ratings tabs show for the online games. A lookup that found no player, a
 * failed read and an unreadable index all read as unavailable; a cancelled read is still loading.
 */
function onlineStatistics(online: OnlineGames, state: PlayerGameInfoState): OnlineStatistics {
  if (online.lookup.kind === "unavailable") return { kind: "unavailable" };
  if (online.lookup.kind === "pending") return { kind: "pending" };
  if (state.info) {
    return {
      kind: "ready",
      info: state.info,
      databasePlayer: { player: { id: online.lookup.player }, file: online.file },
    };
  }
  if (state.unavailable || failureUnlessCancelled(state.error)) return { kind: "unavailable" };
  return { kind: "pending" };
}

/** The shared personal card for one database player, with that player's online accounts. */
function DatabasePlayerCard({
  player,
  file,
  info,
  online,
}: {
  player: Player;
  file: DatabaseHandle;
  info: PlayerGameInfo;
  online: OnlineStatistics | undefined;
}) {
  const accounts = useOpponentAccounts(player.name!);
  return (
    <PersonalPlayerCard
      name={player.name!}
      info={info}
      isDatabase
      headerAction={<OpponentAccountAdd accounts={accounts} />}
      notice={<OpponentAccounts accounts={accounts} />}
      databasePlayer={{ player, file }}
      online={online}
    />
  );
}

function PlayerCard({ player, file }: { player: Player; file: DatabaseHandle }) {
  const { t } = useTranslation();
  const { info, loading, error, unavailable } = usePlayerGameInfo(file, player.id);
  const online = useOnlineGames(player, file);
  const onlineState = usePlayerGameInfo(
    online?.lookup.kind === "found" ? online.file : null,
    online?.lookup.kind === "found" ? online.lookup.player : null,
  );
  const errorText = unavailable
    ? t("Collections.Unavailable", {
        defaultValue:
          "The search index is unavailable. Retry, or select the collection's source file again.",
      })
    : inlineFailureMessage(error, "database", t("Databases.LoadError.Title"));

  return (
    <>
      {loading && (
        <Paper withBorder h="100%">
          <Center h="100%">
            <Stack align="center">
              <Text fw="bold">{t("Databases.Player.ProcessingData")}</Text>
              <Loader />
            </Stack>
          </Center>
        </Paper>
      )}
      {errorText !== undefined && (
        <Paper withBorder h="100%">
          <Center h="100%">
            <Text ta="center">{errorText}</Text>
          </Center>
        </Paper>
      )}
      {info && (
        <DatabasePlayerCard
          // A new player or database starts on the over-the-board games again, with the
          // online-account strip closed and no dialog open.
          key={`${databaseHandleKey(file)}:${player.id}`}
          player={player}
          file={file}
          info={info}
          online={online && onlineStatistics(online, onlineState)}
        />
      )}
    </>
  );
}

export default PlayerCard;
