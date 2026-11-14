import { tauri } from "@/platform/tauri";
import { notifications } from "@mantine/notifications";
import { Divider, Group, ScrollArea, Stack, Text, TextInput } from "@mantine/core";
import { Check, Pencil, Trash2 } from "lucide-react";
import { useAtomValue, useSetAtom } from "jotai";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { sessionsAtom } from "@/state/atoms";
import { useCollectionCurrencies } from "@/state/linkedCollections";
import { getChessComAccount, getStats } from "@/utils/chess.com/api";
import { findAccountDatabase, type AccountDatabaseListing } from "../home/accountDatabase";
import { getLichessAccount } from "@/utils/lichess/api";
import { revocationReason, revocationReasonText } from "@/utils/lichess/revocation";
import { sameAccountUsername, type Session, sessionPlayerName } from "@/utils/session";
import { notifyUnlessCancelled } from "../files/notifyError";
import { AccountCard } from "../home/AccountCard";
import { EmptyAccounts } from "../home/EmptyAccounts";
import IconAction from "./IconAction";

async function removeLichessCredential(handle: string | undefined, t: TFunction) {
  if (!handle) return;
  const removal = await tauri.removeLichessAccount(handle);
  if (removal.state === "removed" && removal.revocation_pending) {
    const reason = revocationReason(removal.revocation_outcome);
    if (reason)
      notifications.show({
        message: t("Home.Accounts.RevocationPending", {
          reason: revocationReasonText(reason, t),
          defaultValue: "Local logout completed. {{reason}} Revocation at Lichess is unconfirmed.",
        }),
        color: "warning",
      });
  }
  if (removal.state === "removed" && removal.durability_uncertain) {
    notifications.show({
      message: t("Home.Accounts.RemoveDurabilityUncertain", {
        defaultValue:
          "The account was removed, but the save could not be fully confirmed. Do not retry.",
      }),
      color: "warning",
    });
  }
}

async function removeAuthenticatedLichessSession(
  handle: string,
  t: TFunction,
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>,
) {
  await removeLichessCredential(handle, t);
  setSessions((current) => current.filter((s) => s.lichess?.handle !== handle));
}

function AccountCards({
  listing,
  listingAvailable = true,
  listingPending = false,
  onAddAccount,
}: {
  listing?: AccountDatabaseListing;
  listingAvailable?: boolean;
  listingPending?: boolean;
  onAddAccount: () => void;
}) {
  const sessions = useAtomValue(sessionsAtom);
  useCollectionCurrencies(
    (listing?.databases ?? []).flatMap((database) =>
      database.collection ? [database.collection] : [],
    ),
  );
  const playerNames = Array.from(new Set(sessions.map(sessionPlayerName)));

  const playerSessions = playerNames.map((name) => ({
    name,
    sessions: sessions.filter((s) => sessionPlayerName(s) === name),
  }));

  if (sessions.length === 0) {
    return <EmptyAccounts onAddAccount={onAddAccount} />;
  }

  return (
    <ScrollArea offsetScrollbars>
      <Stack>
        {playerSessions.map(({ name, sessions }) => (
          <PlayerSession
            key={name}
            name={name}
            sessions={sessions}
            listing={listing}
            listingAvailable={listingAvailable}
            listingPending={listingPending}
          />
        ))}
      </Stack>
    </ScrollArea>
  );
}

function PlayerSession({
  name,
  sessions,
  listing,
  listingAvailable,
  listingPending,
}: {
  name: string;
  sessions: Session[];
  listing?: AccountDatabaseListing;
  listingAvailable: boolean;
  listingPending: boolean;
}) {
  const { t } = useTranslation();
  const setSessions = useSetAtom(sessionsAtom);
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(name);
  useEffect(() => {
    setText(name);
  }, [name]);
  const ref = useRef(null);

  return (
    <Stack>
      <Group justify="space-between" align="center">
        {edit ? (
          <TextInput
            ref={ref}
            variant="unstyled"
            fw="bold"
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            styles={{
              input: {
                fontSize: "1.1rem",
                textDecoration: "underline",
              },
            }}
            autoFocus
          />
        ) : (
          <Text fz="lg" fw="bold">
            {name}
          </Text>
        )}
        <Group>
          {edit ? (
            <IconAction
              label={t("Accounts.SaveName", { defaultValue: "Save player name" })}
              size="sm"
              variant="subtle"
              color="success"
              onClick={() => {
                setEdit(false);
                setSessions((prev) =>
                  prev.map((s) => {
                    if (sessions.includes(s)) {
                      return {
                        ...s,
                        player: text,
                      };
                    }
                    return s;
                  }),
                );
              }}
            >
              <Check />
            </IconAction>
          ) : (
            <IconAction
              label={t("Accounts.EditName", { defaultValue: "Edit player name" })}
              size="sm"
              variant="subtle"
              color="gray"
              onClick={() => {
                setEdit(true);
              }}
            >
              <Pencil />
            </IconAction>
          )}
          <IconAction
            label={t("Accounts.Remove", { defaultValue: "Remove account" })}
            size="sm"
            variant="subtle"
            color="danger"
            onClick={async () => {
              for (const member of sessions) {
                const handle = member.lichess?.handle;
                try {
                  if (handle) {
                    await removeAuthenticatedLichessSession(handle, t, setSessions);
                  } else if (member.lichess) {
                    setSessions((current) =>
                      current.filter(
                        (s) =>
                          !sameAccountUsername(s.lichess?.username, member.lichess?.username) ||
                          s.lichess?.handle,
                      ),
                    );
                  } else if (member.chessCom) {
                    setSessions((current) =>
                      current.filter(
                        (s) =>
                          !sameAccountUsername(s.chessCom?.username, member.chessCom?.username) ||
                          s.lichess?.handle,
                      ),
                    );
                  }
                } catch (error) {
                  notifyUnlessCancelled(t("Common.Error"), error);
                }
              }
            }}
          >
            <Trash2 />
          </IconAction>
        </Group>
      </Group>
      <Divider />
      <Group>
        {sessions.map((session, i) => (
          <LichessOrChessCom
            key={i}
            session={session}
            listing={listing}
            listingAvailable={listingAvailable}
            listingPending={listingPending}
            setSessions={setSessions}
          />
        ))}
      </Group>
    </Stack>
  );
}

function LichessOrChessCom({
  session,
  listing,
  listingAvailable,
  listingPending,
  setSessions,
}: {
  session: Session;
  listing?: AccountDatabaseListing;
  listingAvailable: boolean;
  listingPending: boolean;
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
}) {
  const { t } = useTranslation();
  if (session.lichess?.account) {
    const account = session.lichess.account;
    const lichessSession = session.lichess;
    const association = findAccountDatabase(
      listing,
      "lichess",
      lichessSession.username,
      listingAvailable,
    );
    const title =
      typeof account.username === "string" && account.username.length > 0
        ? account.username
        : lichessSession.username;
    const totalGames =
      (account.perfs?.ultraBullet?.games ?? 0) +
      (account.perfs?.bullet?.games ?? 0) +
      (account.perfs?.blitz?.games ?? 0) +
      (account.perfs?.rapid?.games ?? 0) +
      (account.perfs?.classical?.games ?? 0) +
      (account.perfs?.correspondence?.games ?? 0);

    const stats = [];
    const speeds = ["bullet", "blitz", "rapid", "classical"] as const;

    if (account.perfs) {
      for (const speed of speeds) {
        const perf = account.perfs[speed];
        if (perf) {
          stats.push({
            value: perf.rating,
            label: speed,
            diff: perf.prog,
          });
        }
      }
    }

    return (
      <AccountCard
        key={lichessSession.username}
        authenticated={Boolean(lichessSession.handle)}
        accountHandle={lichessSession.handle}
        type="lichess"
        database={association?.type === "unavailable" ? null : association}
        associationIssue={association?.type === "unavailable" ? association : undefined}
        associationPending={listingPending}
        title={title}
        accountUsername={lichessSession.username}
        updatedAt={session.updatedAt}
        total={totalGames}
        logout={async () => {
          const handle = lichessSession.handle;
          if (handle) {
            await removeAuthenticatedLichessSession(handle, t, setSessions);
          } else {
            setSessions((sessions) =>
              sessions.filter(
                (s) =>
                  !sameAccountUsername(s.lichess?.username, lichessSession.username) ||
                  s.lichess?.handle,
              ),
            );
          }
        }}
        reload={async () => {
          const account = await getLichessAccount(
            lichessSession.handle
              ? { handle: lichessSession.handle }
              : { username: lichessSession.username },
          );
          if (!account) return;
          setSessions((sessions) =>
            sessions.map((s) =>
              s.lichess && sameAccountUsername(s.lichess.username, lichessSession.username)
                ? {
                    ...s,
                    lichess: {
                      ...s.lichess,
                      account,
                    },
                    updatedAt: Date.now(),
                  }
                : s,
            ),
          );
        }}
        stats={stats}
      />
    );
  }
  if (session.chessCom?.stats) {
    const chessComSession = session.chessCom;
    const association = findAccountDatabase(
      listing,
      "chesscom",
      chessComSession.username,
      listingAvailable,
    );
    let totalGames = 0;
    for (const stat of Object.values(chessComSession.stats)) {
      if (stat.record) {
        totalGames += stat.record.win + stat.record.loss + stat.record.draw;
      }
    }
    return (
      <AccountCard
        key={chessComSession.username}
        type="chesscom"
        title={chessComSession.username}
        database={association?.type === "unavailable" ? null : association}
        associationIssue={association?.type === "unavailable" ? association : undefined}
        associationPending={listingPending}
        updatedAt={session.updatedAt}
        total={totalGames}
        stats={getStats(chessComSession.stats)}
        logout={() => {
          setSessions((sessions) =>
            sessions.filter(
              (s) => !sameAccountUsername(s.chessCom?.username, chessComSession.username),
            ),
          );
        }}
        reload={async () => {
          const stats = await getChessComAccount(chessComSession.username);
          if (!stats) return;
          setSessions((sessions) =>
            sessions.map((s) =>
              s.chessCom && sameAccountUsername(s.chessCom.username, chessComSession.username)
                ? {
                    ...s,
                    chessCom: {
                      ...s.chessCom,
                      stats,
                    },
                    updatedAt: Date.now(),
                  }
                : s,
            ),
          );
        }}
      />
    );
  }
}

export default AccountCards;
