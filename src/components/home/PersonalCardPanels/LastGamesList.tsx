import { Box, Group, Loader, Stack, Text, UnstyledButton } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useSetAtom } from "jotai";
import { useTranslation } from "react-i18next";
import useSWRImmutable from "swr/immutable";
import type { DatabaseHandle, NormalizedGame, Player } from "@/bindings";
import { useGameOpen } from "@/components/common/gameOpen";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { errorUnlessCancelled } from "@/platform/errors";
import { addRecentFileAtom, tabsAtom } from "@/state/atoms";
import { openDatabaseGame } from "@/utils/databaseGame";
import { query_games } from "@/utils/db";
import { runTabCreation } from "@/utils/tabs";
import classes from "./LastGamesList.module.css";

const LAST_GAMES_LIMIT = 10;

function LastGamesList({ player, file }: { player: Player; file: DatabaseHandle }) {
  const { t } = useTranslation();
  const setTabs = useSetAtom(tabsAtom);
  const addRecentFile = useSetAtom(addRecentFileAtom);
  const navigate = useNavigate();
  const onError = (cause: unknown) => notifyUnlessCancelled(t("Common.Error"), cause);
  const gameOpen = useGameOpen(
    (game: NormalizedGame) =>
      runTabCreation({
        create: () => openDatabaseGame({ game, database: file, setTabs, addRecentFile }),
        onSuccess: () => navigate({ to: "/" }),
        onError,
      }),
    onError,
  );
  const requestKey = ["player-last-games", file, player.id] as const;
  const requestOwner = useNativeRequestOwner(requestKey);
  const { data, error, isLoading } = useSWRImmutable(
    requestKey,
    ([, database, playerId]) =>
      requestOwner!.run((signal) =>
        query_games(
          database,
          {
            player1: playerId,
            sides: "Any",
            options: {
              sort: "date",
              direction: "desc",
              pageSize: LAST_GAMES_LIMIT,
              page: 1,
              skipCount: true,
            },
          },
          { signal },
        ),
      ),
    { shouldRetryOnError: false },
  );

  const visibleError = error ? errorUnlessCancelled(error) : null;
  if (error && visibleError === null) return null;

  return (
    <Stack gap="xs" data-last-games>
      <Text fw={500}>{t("Home.Personal.Overview.LastGames")}</Text>
      {visibleError && (
        <Text c="danger" size="sm">
          {t("Home.Personal.Overview.LastGamesError", { error: visibleError.message })}
        </Text>
      )}
      {!visibleError && isLoading && (
        <Group gap="xs">
          <Loader size="sm" />
          <Text size="sm">{t("Common.Loading")}</Text>
        </Group>
      )}
      {!visibleError &&
        !isLoading &&
        data?.data.map((game) => (
          <LastGameRow
            key={game.id}
            game={game}
            player={player}
            pending={gameOpen.pending}
            onOpen={() => gameOpen.activate(game)}
          />
        ))}
    </Stack>
  );
}

function LastGameRow({
  game,
  player,
  pending,
  onOpen,
}: {
  game: NormalizedGame;
  player: Player;
  pending: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const isWhite = game.white_id === player.id;
  const opponent = isWhite ? game.black : game.white;
  const opponentElo = isWhite ? game.black_elo : game.white_elo;
  const result = playerPerspectiveResult(game, isWhite);
  const resultLabel =
    result === "win"
      ? t("Home.Personal.Overview.ResultWin")
      : result === "draw"
        ? t("Board.Analysis.Tablebase.Draw")
        : result === "loss"
          ? t("Home.Personal.Overview.ResultLoss")
          : "*";
  const opening = game.eco ?? "";

  return (
    <UnstyledButton className={classes.row} aria-busy={pending} onClick={() => void onOpen()}>
      <Group gap="xs" wrap="wrap" justify="space-between">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Box
            className={classes.swatch}
            aria-label={isWhite ? t("Fen.White") : t("Fen.Black")}
            style={{
              background: isWhite ? "var(--cf-eval-bar-light)" : "var(--cf-eval-bar-dark)",
            }}
          />
          <Text size="sm" truncate>
            {game.date ?? "????.??.??"}
          </Text>
          <Text size="sm" truncate>
            {opponent}
            {opponentElo != null ? ` (${opponentElo})` : ""}
          </Text>
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Text size="sm">{resultLabel}</Text>
          {opening !== "" && (
            <Text size="sm" c="dimmed">
              {opening}
            </Text>
          )}
        </Group>
      </Group>
    </UnstyledButton>
  );
}

function playerPerspectiveResult(
  game: NormalizedGame,
  isWhite: boolean,
): "win" | "draw" | "loss" | "unknown" {
  if (game.result === "1/2-1/2") return "draw";
  if (game.result === "1-0") return isWhite ? "win" : "loss";
  if (game.result === "0-1") return isWhite ? "loss" : "win";
  return "unknown";
}

export default LastGamesList;
