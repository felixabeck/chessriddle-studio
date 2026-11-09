import { tauri, tauriSubscriptions } from "@/platform/tauri";
import {
  Alert,
  Center,
  Loader,
  Paper,
  Progress,
  Select,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { DatabaseX } from "lucide-react";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import useSWRImmutable from "swr/immutable";
import type { PlayerGameInfo } from "@/bindings";
import { notifyListenerError } from "@/components/files/notifyError";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { errorUnlessCancelled, logFailureSafely, safeFailureContext } from "@/platform/errors";
import { sessionsAtom } from "@/state/atoms";
import { useCollectionCurrencies } from "@/state/linkedCollections";
import { useTauriListener } from "@/platform/useTauriListener";
import { activeDatabaseViewStore } from "@/state/store/database";
import {
  databaseHandleKey,
  getDatabases,
  query_players,
  type ManagedDatabaseInfo,
  type DatabaseList,
} from "@/utils/db";
import { capabilityKey } from "@/utils/pathCapabilities";
import { findAccountDatabase } from "./accountDatabase";
import { collectSequential } from "@/utils/collectSequential";
import { sessionPlayerName, type Session } from "@/utils/session";
import { DatabaseViewStateContext } from "../databases/DatabaseViewStateContext";
import PersonalPlayerCard from "./PersonalCard";

type PersonalUnread = { type: "unread"; filename: string; error: string; key: string };
type PersonalDatabase = {
  db: ManagedDatabaseInfo | PersonalUnread;
  username: string;
  players: string[];
};

function databaseLabel(db: PersonalDatabase["db"]): string {
  return db.type === "success" ? db.title || db.filename : db.filename;
}

function sessionAccountDatabase(
  session: Session,
): { username: string; provider: "lichess" | "chesscom" } | undefined {
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

interface PersonalInfo {
  db: Extract<ManagedDatabaseInfo, { type: "success" }>;
  info: PlayerGameInfo;
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

/** Stable identity matching the `["personalInfo", name, playerDatabases]` SWR key. */
function personalInfoProgressKey(name: string, databases: PersonalDatabase[]): string {
  return JSON.stringify([
    "personalInfo",
    name,
    databases.map(({ db }) => (db.type === "unread" ? db.key : databaseHandleKey(db.file))),
  ]);
}

/**
 * Owned progress ids for an in-flight personalInfo fetch. Module-scoped so a remount
 * can still match ProgressEvents while SWR reuses the original fetcher. The entry is
 * replaced at the start of each fetch so the map cannot grow without bound.
 */
const ownedProgressByKey = new Map<string, Map<string, number>>();

function Databases() {
  const { t } = useTranslation();
  const sessions = useAtomValue(sessionsAtom);

  const players = Array.from(new Set(sessions.map(sessionPlayerName)));

  const [name, setName] = useState("");
  useEffect(() => {
    if (sessions.length > 0) {
      setName(sessionPlayerName(sessions[0]));
    }
  }, [sessions]);

  const databasesKey = sessions.length === 0 ? null : ["personalDatabases", sessions];
  const databasesOwner = useNativeRequestOwner(databasesKey);
  const { data: databases, error: databasesError } = useSWRImmutable<PersonalDatabase[]>(
    databasesKey,
    () =>
      databasesOwner!.run(async (signal) => {
        let dbs: DatabaseList;
        try {
          dbs = await getDatabases({ signal });
        } catch (cause) {
          if (!signal.aborted && errorUnlessCancelled(cause)) {
            const failure = safeFailureContext(cause);
            await logFailureSafely(
              `personal database listing failed: ${failure.message}`,
              { operation: "personal database listing", primaryFailure: failure },
              "Personal database listing logging failed",
            );
          }
          throw cause;
        }
        const accounts = sessions.flatMap((session) => {
          const account = sessionAccountDatabase(session);
          return account ? [{ ...account, player: sessionPlayerName(session) }] : [];
        });
        const associations = accounts.map((account) => ({
          ...account,
          association: findAccountDatabase(dbs, account.provider, account.username),
        }));
        const readable: PersonalDatabase[] = dbs.databases.flatMap((db) => {
          const owners = associations.filter((account) => account.association === db);
          const account = owners[0];
          return account
            ? [{ db, username: account.username, players: owners.map((owner) => owner.player) }]
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
                    error: [t("Home.Accounts.HistoryUnavailable"), issue.error]
                      .filter(Boolean)
                      .join(" "),
                    key: `${capabilityKey(dbs.root)}:account:${index}`,
                  },
                  username: account.username,
                  players: [account.player],
                },
              ]
            : [];
        });
        return [...readable, ...unread];
      }),
  );

  useCollectionCurrencies(
    databases?.flatMap(({ db }) =>
      db.type !== "unread" && db.collection ? [db.collection] : [],
    ) ?? [],
  );
  const playerDatabases = databases?.filter(({ players }) => players.includes(name));
  const personalKey = playerDatabases && name ? ["personalInfo", name, playerDatabases] : null;
  const personalOwner = useNativeRequestOwner(personalKey);
  const {
    data: personalInfo,
    isLoading,
    error,
  } = useSWRImmutable<PersonalSummary>(
    personalKey,
    ([, playerName, playerDatabases]: [string, string, PersonalDatabase[]]) =>
      personalOwner!.run(async (signal) => {
        const progressKey = personalInfoProgressKey(playerName, playerDatabases);
        const map = new Map<string, number>();
        ownedProgressByKey.clear();
        ownedProgressByKey.set(progressKey, map);
        const candidates = playerDatabases;
        const { values, failures } = await collectSequential(
          candidates.filter(
            (
              item,
            ): item is PersonalDatabase & {
              db: Extract<ManagedDatabaseInfo, { type: "success" }>;
            } => item.db.type === "success",
          ),
          async ({ db, username }) => {
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
            return { db, info };
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
      }),
  );

  const loadError = databasesError ?? error;
  const [progress, setProgress] = useState(0);
  useTauriListener(
    tauriSubscriptions.progress,
    (e) => {
      if (!playerDatabases || !name) {
        return;
      }
      const map = ownedProgressByKey.get(personalInfoProgressKey(name, playerDatabases));
      if (!map?.has(e.payload.id)) {
        return;
      }
      map.set(e.payload.id, e.payload.progress);
      const values = [...map.values()];
      setProgress(values.reduce((sum, value) => sum + value, 0) / values.length);
    },
    { onError: notifyListenerError },
  );

  return (
    <>
      {isLoading && databases && (
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
              <Progress w="100%" value={progress} animated striped size="md" radius="xl" />
              <Text fw="bold" fz="sm" c="dimmed">
                {Math.round(progress)}%
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
      {personalInfo &&
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

                <Select
                  aria-label={t("Home.Accounts.SelectPlayer")}
                  value={name}
                  data={players}
                  onChange={(e) => setName(e || "")}
                  clearable={false}
                  allowDeselect={false}
                  fw="bold"
                  styles={{
                    input: {
                      textAlign: "center",
                      fontSize: "1.25rem",
                    },
                  }}
                  mt="md"
                />
              </Stack>
            </Center>
          </Paper>
        ) : (
          <DatabaseViewStateContext.Provider value={activeDatabaseViewStore}>
            <PersonalPlayerCard
              name={name}
              setName={setName}
              info={{
                site_stats_data: personalInfo.entries.flatMap((i) => i.info.site_stats_data),
              }}
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
