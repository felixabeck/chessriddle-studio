import { tauri } from "@/platform/tauri";
import { Center, Loader, Paper, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import useSWRImmutable from "swr/immutable";
import { type DatabaseHandle, type Player } from "@/bindings";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { inlineFailureMessage } from "@/components/files/notifyError";
import PersonalPlayerCard from "../home/PersonalCard";

function PlayerCard({ player, file }: { player: Player; file: DatabaseHandle }) {
  const { t } = useTranslation();
  const requestKey = ["player-game-info", file, player.id] as const;
  const requestOwner = useNativeRequestOwner(requestKey);
  const {
    data: info,
    isLoading,
    error,
  } = useSWRImmutable(requestKey, ([, file, id]) =>
    requestOwner!.run((signal) =>
      tauri.getPlayersGameInfo(crypto.randomUUID(), file, id, { signal }),
    ),
  );
  const errorText = inlineFailureMessage(error, "database", t("Databases.LoadError.Title"));

  return (
    <>
      {isLoading && (
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
        <PersonalPlayerCard
          name={player.name!}
          info={info}
          isDatabase
          databasePlayer={{ player, file }}
        />
      )}
    </>
  );
}

export default PlayerCard;
