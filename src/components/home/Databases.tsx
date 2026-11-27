import { tauri, tauriSubscriptions } from "@/platform/tauri";
import {
  Alert,
  Center,
  Loader,
  Paper,
  Progress,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { DatabaseX } from "lucide-react";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { unstable_serialize } from "swr";
import useSWRImmutable from "swr/immutable";
import type { PlayerGameInfo } from "@/bindings";
import { notifyListenerError } from "@/components/files/notifyError";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { useDatabaseWritesRevision } from "@/platform/databaseWrites";
import { failureUnlessCancelled, logFailureSafely, safeFailureContext } from "@/platform/errors";
import { listingFailure } from "@/components/files/listingFailure";
import { sessionsAtom } from "@/state/atoms";
import { useCollectionCurrencies } from "@/state/linkedCollections";
import { useTauriListener } from "@/platform/useTauriListener";
import { activeDatabaseViewStore } from "@/state/store/database";
import { useDatabaseList } from "@/hooks/useDatabaseList";
import {
  databaseHandleKey,
  query_players,
  type ManagedDatabaseInfo,
  type DatabaseList,
} from "@/utils/db";
import { capabilityKey } from "@/utils/pathCapabilities";
import { findAccountDatabase } from "./accountDatabase";
import { collectSequential } from "@/utils/collectSequential";
import { playerGroups, sessionPlayerKeys, type AccountSite, type Session } from "@/utils/session";
import { DatabaseViewStateContext } from "../databases/DatabaseViewStateContext";
import PersonalPlayerCard from "./PersonalCard";
import type { AccountOpeningSource } from "./PersonalCardPanels/OpeningsPanel";
import { PlayerSelect } from "./PlayerSelect";

type PersonalUnread = { type: "unread"; filename: string; error: string; key: string };
type PersonalDatabase = {
  db: ManagedDatabaseInfo | PersonalUnread;
  username: string;
  provider: AccountSite;
  playerKeys: string[];
};

function databaseLabel(db: PersonalDatabase["db"]): string {
  return db.type === "success" ? db.title || db.filename : db.filename;
}

function sessionAccountDatabase(
  session: Session,
): { username: string; provider: AccountSite } | undefined {
  const lichessUsername = session.lichess?.username;
  if (typeof lichessUsername === "string" && lichessUsername.length > 0) {
    return {
      username: lichessUsername,
      provider: "lichess",
    };
  }
  const chessComUsername = session.chessCom?.username;
  if (typeof chessComUsername === "string" && chessComUsername.length > 0) {
    return {
      username: chessComUsername,
      provider: "chesscom",
    };
  }
  return undefined;
}

/**
 * Each account's database from the shared listing, or an unread row when its association is
 * unavailable, owned by every player key that reads it.
 */
function personalDatabases(
  listing: DatabaseList,
  sessions: Session[],
  unavailableLabel: string,
): PersonalDatabase[] {
  const keys = sessionPlayerKeys(sessions);
  const accounts = sessions.flatMap((session, index) => {
    const account = sessionAccountDatabase(session);
    return account ? [{ ...account, playerKey: keys[index] }] : [];
  });
  const associations = accounts.map((account) => ({
    ...account,
    association: findAccountDatabase(listing, account.provider, account.username),
  }));
  const readable: PersonalDatabase[] = listing.databases.flatMap((db) => {
    const owners = associations.filter((account) => account.association === db);
    const account = owners[0];
    return account
      ? [
          {
            db,
            username: account.username,
            provider: account.provider,
            playerKeys: owners.map((owner) => owner.playerKey),
          },
        ]
      : [];
  });
  const unread: PersonalDatabase[] = associations.flatMap((account, index) => {
    const issue = account.association;
    return issue?.type === "unavailable"
      ? [
          {
            db: {
              type: "unread" as const,
              filename: issue.filenames.join(", ") || account.username,
              error: [unavailableLabel, issue.error].filter(Boolean).join(" "),
              key: `${capabilityKey(listing.root)}:account:${index}`,
            },
            username: account.username,
            provider: account.provider,
            playerKeys: [account.playerKey],
          },
        ]
      : [];
  });
  return [...readable, ...unread];
}

interface PersonalInfo {
  db: Extract<ManagedDatabaseInfo, { type: "success" }>;
  info: PlayerGameInfo;
  username: string;
  provider: AccountSite;
  /** The database-local ids the username resolved to, one per name variant. */
  players: number[];
}

/** One opening-tree source per database and resolved player id. */
function openingSources(entries: PersonalInfo[]): AccountOpeningSource[] {
  return entries.flatMap(({ db, info, username, provider, players }) =>
    players.map((player) => ({
      key: `${databaseHandleKey(db.file)}:${player}`,
      label: databaseLabel(db),
      file: db.file,
      player,
      provider,
      username,
      info,
    })),
  );
}

interface PersonalSummary {
  entries: PersonalInfo[];
  failed: PersonalDatabase["db"][];
}

function StatisticsNotice({
  failed,
  incomplete = false,
}: {
  failed: PersonalDatabase["db"][];
  incomplete?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Alert
      color="warning"
      mt="xs"
      title={
        incomplete
          ? t("Home.Databases.Incomplete.Title", { defaultValue: "Statistics are incomplete" })
          : undefined
      }
      style={{ flexShrink: 0 }}
    >
      {t("Home.Databases.Incomplete.Description", {
        defaultValue: "These databases could not be read: {{databases}}",
        databases: failed.map(databaseLabel).join(", "),
      })}
      {failed
        .filter((db): db is PersonalUnread => db.type === "unread")
        .map((db) => (
          <Text key={db.key} size="sm" className="wrap-anywhere">
            {db.filename}: {db.error}
          </Text>
        ))}
    </Alert>
  );
}

/** Exact SWR key identity (`unstable_serialize`) for `["personalInfo", playerKey, databases, revision]`. */
function personalInfoProgressKey(
  playerKey: string,
  databases: PersonalDatabase[],
  revision: number,
): string {
  return unstable_serialize(["personalInfo", playerKey, databases, revision]);
}

/**
 * Owned progress ids for an in-flight personalInfo fetch. Module-scoped so a remount
 * can still match ProgressEvents while SWR reuses the original fetcher. The entry is
 * set at fetch start and deleted in that fetch's finally when it is still that fetch's map.
 */
const ownedProgressByKey = new Map<string, Map<string, number>>();

function Databases() {
  const { t } = useTranslation();
  const sessions = useAtomValue(sessionsAtom);

  const players = playerGroups(sessions);

  const [selectedKey, setSelectedKey] = useState("");
  const player = players.find(({ key }) => key === selectedKey) ?? players[0];
  const playerKey = player?.key ?? "";

  const { data: listing, error: listingResultError } = useDatabaseList(sessions.length > 0);
  // A superseded or cancelled read is replaced by a newer one and keeps the current rows.
  const listingError =
    listingFailure(listingResultError) === "silent" ? undefined : listingResultError;
  useEffect(() => {
    if (!listingError) return;
    const failure = safeFailureContext(listingError);
    void logFailureSafely(
      `personal database listing failed: ${failure.message}`,
      { operation: "personal database listing", primaryFailure: failure },
      "Personal database listing logging failed",
    );
  }, [listingError]);
  const unavailableLabel = t("Home.Accounts.HistoryUnavailable");
  const databases = useMemo(
    () => (listing ? personalDatabases(listing, sessions, unavailableLabel) : undefined),
    [listing, sessions, unavailableLabel],
  );

  useCollectionCurrencies(
    databases?.flatMap(({ db }) =>
      db.type !== "unread" && db.collection ? [db.collection] : [],
    ) ?? [],
  );
  const playerDatabases = databases?.filter(({ playerKeys }) => playerKeys.includes(playerKey));
  const personalRevision = useDatabaseWritesRevision(
    playerDatabases?.map((item) => (item.db.type === "success" ? item.db.file : undefined)) ?? [],
  );
  const personalKey =
    playerDatabases && playerKey
      ? ["personalInfo", playerKey, playerDatabases, personalRevision]
      : null;
  const personalOwner = useNativeRequestOwner(personalKey);
  const {
    data: personalInfo,
    isLoading,
    error,
  } = useSWRImmutable<PersonalSummary>(
    personalKey,
    ([, requestedKey, playerDatabases, revision]: [string, string, PersonalDatabase[], number]) =>
      personalOwner!.run(async (signal) => {
        const progressKey = personalInfoProgressKey(requestedKey, playerDatabases, revision);
        const map = new Map<string, number>();
        ownedProgressByKey.clear();
        ownedProgressByKey.set(progressKey, map);
        try {
          const candidates = playerDatabases;
          const { values, failures } = await collectSequential(
            candidates.filter(
              (
                item,
              ): item is PersonalDatabase & {
                db: Extract<ManagedDatabaseInfo, { type: "success" }>;
              } => item.db.type === "success",
            ),
            async ({ db, username, provider }) => {
              const players = await query_players(
                db.file,
                {
                  name: username,
                  nameMatch: "exact",
                  options: {
                    direction: "asc",
                    sort: "id",
                    skipCount: false,
                  },
                },
                { signal },
              );
              if (players.data.length === 0) {
                return null;
              }
              const info: PlayerGameInfo = { site_stats_data: [] };
              // Variants form one atomic database contribution. The outer collector owns failures.
              for (const player of players.data) {
                if (signal.aborted) throw new DOMException("Cancellation", "AbortError");
                const progressId = crypto.randomUUID();
                map.set(progressId, 0);
                const variant = await tauri.getPlayersGameInfo(progressId, db.file, player.id, {
                  signal,
                });
                for (const site of variant.site_stats_data) {
                  info.site_stats_data.push({ ...site, player: username });
                }
              }
              return { db, info, username, provider, players: players.data.map(({ id }) => id) };
            },
            {
              signal,
              operation: "personal database summary",
              describe: ({ db }) => databaseLabel(db),
            },
          );
          const failedItems = new Set(failures.map(({ item }) => item));
          return {
            entries: values.filter((entry): entry is PersonalInfo => entry !== null),
            failed: candidates
              .filter((item) => !(item.db.type === "error" && item.db.transient))
              .filter(
                (item) =>
                  item.db.type !== "success" ||
                  failedItems.has(
                    item as PersonalDatabase & {
                      db: Extract<ManagedDatabaseInfo, { type: "success" }>;
                    },
                  ),
              )
              .map(({ db }) => db),
          };
        } finally {
          if (ownedProgressByKey.get(progressKey) === map) ownedProgressByKey.delete(progressKey);
        }
      }),
  );

  const loadError = listingError ?? failureUnlessCancelled(error);
  const [progress, setProgress] = useState<{ owner: Map<string, number>; value: number } | null>(
    null,
  );
  const currentProgressKey =
    playerDatabases && playerKey
      ? personalInfoProgressKey(playerKey, playerDatabases, personalRevision)
      : null;
  const currentProgress =
    currentProgressKey && progress && progress.owner === ownedProgressByKey.get(currentProgressKey)
      ? progress.value
      : 0;
  useTauriListener(
    tauriSubscriptions.progress,
    (e) => {
      if (!currentProgressKey) {
        return;
      }
      const map = ownedProgressByKey.get(currentProgressKey);
      if (!map?.has(e.payload.id)) {
        return;
      }
      map.set(e.payload.id, e.payload.progress);
      const values = [...map.values()];
      setProgress({
        owner: map,
        value: values.reduce((sum, value) => sum + value, 0) / values.length,
      });
    },
    { onError: notifyListenerError },
  );

  return (
    <>
      {/* A failed listing refresh keeps SWR's previous rows, so do not paint them as current. */}
      {isLoading && databases && !listingError && (
        <Paper
          h="100%"
          shadow="sm"
          p="md"
          withBorder
          style={{
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <Center h="100%">
            <Stack w="100%" maw={400} align="center" gap="md">
              <ThemeIcon size={80} radius="100%" variant="light" color="gold">
                <Loader color="gold" type="bars" />
              </ThemeIcon>
              <Title order={3}>{t("Home.Databases.ProcessingGames")}</Title>
              <Progress
                w="100%"
                value={currentProgress}
                animated
                striped
                size="md"
                radius="xl"
                aria-label={t("Home.Databases.ProcessingGames")}
              />
              <Text fw="bold" fz="sm" c="dimmed">
                {Math.round(currentProgress)}%
              </Text>
            </Stack>
          </Center>
        </Paper>
      )}
      {loadError && (
        <Text ta="center" miw={0} style={{ overflowWrap: "anywhere" }}>
          {t("Home.Databases.Failed.Title")}
        </Text>
      )}
      {!listingError &&
        personalInfo &&
        (personalInfo.entries.length === 0 ? (
          <Paper
            h="100%"
            shadow="sm"
            p="md"
            withBorder
            style={{
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <Center h="100%">
              <Stack align="center" gap="md">
                <ThemeIcon size={80} radius="100%" variant="light" color="gold">
                  <DatabaseX size={40} />
                </ThemeIcon>
                <Title order={3}>
                  {personalInfo.failed.length > 0
                    ? t("Home.Databases.Failed.Title", {
                        defaultValue: "Could not load statistics",
                      })
                    : t("Home.Databases.Empty.Title")}
                </Title>
                {personalInfo.failed.length > 0 ? (
                  <StatisticsNotice failed={personalInfo.failed} />
                ) : (
                  <Text c="dimmed" ta="center" maw={400}>
                    {t("Home.Databases.Empty.Description")}
                  </Text>
                )}

                <PlayerSelect
                  ariaLabel={t("Home.Accounts.SelectPlayer")}
                  value={playerKey}
                  onChange={setSelectedKey}
                  mt="md"
                />
              </Stack>
            </Center>
          </Paper>
        ) : (
          <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
            <PersonalPlayerCard
              name={player?.name ?? ""}
              playerKey={playerKey}
              setPlayerKey={setSelectedKey}
              info={{
                site_stats_data: personalInfo.entries.flatMap((i) => i.info.site_stats_data),
              }}
              openingSources={openingSources(personalInfo.entries)}
              notice={
                personalInfo.failed.length > 0 ? (
                  <StatisticsNotice failed={personalInfo.failed} incomplete />
                ) : undefined
              }
            />
          </DatabaseViewStateContext.Provider>
        ))}
    </>
  );
}

export default Databases;
