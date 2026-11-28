import { Button, Checkbox, Group, Paper, Select, Stack, Text, Tooltip } from "@mantine/core";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useAtom, useAtomValue, useStore } from "jotai";
import { Plus, Settings, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSWRConfig } from "swr";
import { CheckboxRow } from "@/components/common/CheckboxRow";
import { fitSelectProps } from "@/components/common/fitSelectProps";
import type { DatabaseHandle, OpponentAccount, OpponentTimeControl } from "@/bindings";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { useDatabaseList } from "@/hooks/useDatabaseList";
import { useProgress } from "@/hooks/useProgress";
import { failureUnlessCancelled } from "@/platform/errors";
import { opponentImportsAtom, opponentLinksAtom } from "@/state/atoms";
import {
  findLinkWithAccount,
  findOpponentLink,
  isOpponentPlayerName,
  MAX_OPPONENT_ACCOUNTS,
  normalizeOpponentName,
  OPPONENT_PERIODS,
  OPPONENT_TIME_CONTROLS,
  type OpponentLink,
  withOpponentAccount,
  withOpponentFilter,
  withOpponentLinkRenamed,
  withoutOpponentAccount,
} from "@/state/opponentLinks";
import { activeDatabaseViewStore } from "@/state/store/database";
import { sameDatabaseHandle } from "@/utils/db";
import ConfirmModal from "../common/ConfirmModal";
import { GamesLoadedProgress } from "../common/GamesLoadedProgress";
import { IconAction } from "../common/IconAction";
import { SiteLogo } from "../home/SiteLogo";
import AddOpponentAccount from "./AddOpponentAccount";
import { openOpponentCard } from "./openOpponentCard";
import {
  opponentPeriodOptions,
  opponentPeriodToValue,
  valueToOpponentPeriod,
} from "./opponentPeriod";
import {
  cancelOpponentImport,
  removeOpponentGames,
  runOpponentImport,
  unlinkOpponent,
} from "./opponentImport";
import { reportOpponentImport, reportOpponentLeftover } from "./opponentImportNotice";
import { useOpponentPlayers } from "./useOpponentPlayers";
import classes from "./OpponentAccounts.module.css";

/** What the database listing says about the link's downloaded games. */
export type OpponentGames =
  | { kind: "none" }
  | { kind: "games"; count: number; file: DatabaseHandle }
  | { kind: "unreadable" }
  | { kind: "pending" }
  | { kind: "failed" };

/**
 * Derives the state of a link's online games from the listing; the link itself is never rewritten.
 * A listing that failed is a failure even while an earlier answer is still cached.
 */
export function opponentGames(
  link: OpponentLink | undefined,
  listing: ReturnType<typeof useDatabaseList>["data"],
  listingError: unknown,
): OpponentGames {
  if (!link?.database) return { kind: "none" };
  if (failureUnlessCancelled(listingError)) return { kind: "failed" };
  if (!listing) return { kind: "pending" };
  const entry = listing.databases.find((database) => database.filename === link.database);
  if (!entry) return { kind: "none" };
  return entry.type === "success"
    ? { kind: "games", count: entry.game_count, file: entry.file }
    : { kind: "unreadable" };
}

export function ImportProgress({ ticket }: { ticket: string }) {
  const { item } = useProgress(ticket);
  return (
    <GamesLoadedProgress count={item?.count ?? null} phase={item?.state ?? "running"} mt="xs" />
  );
}

/**
 * Whether the link was made for an opponent known only online: the online-opponent entry names its
 * link exactly like the account. A database player whose name equals one of his usernames reads the
 * same; taking his link over only renames it, keeping accounts, filter and games.
 */
function isOnlineOnlyLink(link: OpponentLink): boolean {
  const name = normalizeOpponentName(link.playerName);
  return link.accounts.some((account) => normalizeOpponentName(account.username) === name);
}

/**
 * The online-account state of one database player card, shared by the header button and the
 * strip under the name. The caller keys its component by player and database, so a switch to
 * another player starts closed with no dialog open.
 */
export function useOpponentAccounts(playerName: string) {
  const [links, setLinks] = useAtom(opponentLinksAtom);
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState(false);
  const link = findOpponentLink(links, playerName);

  function linkAccount(account: OpponentAccount) {
    setLinks((current) => {
      if (!findOpponentLink(current, playerName)) {
        const existing = findLinkWithAccount(current, account);
        if (existing && isOnlineOnlyLink(existing)) {
          return withOpponentLinkRenamed(current, existing.id, playerName);
        }
      }
      return withOpponentAccount(current, playerName, account, crypto.randomUUID());
    });
    // A new link opens on its settings.
    setExpanded(true);
  }

  return {
    link,
    setLinks,
    // A name that cannot be stored cannot carry a link, so there is nothing to offer.
    offered: link !== undefined || isOpponentPlayerName(playerName),
    expanded,
    setExpanded,
    adding,
    setAdding,
    linkAccount,
  };
}

export type OpponentAccountsState = ReturnType<typeof useOpponentAccounts>;

/** The quiet button in the card's name line that links a first online account. */
export function OpponentAccountAdd({ accounts }: { accounts: OpponentAccountsState }) {
  const { t } = useTranslation();
  if (accounts.link || !accounts.offered) return null;
  const label = t("Databases.Opponent.Add", { defaultValue: "Add online account" });
  return (
    <Tooltip label={label}>
      <Button
        size="xs"
        variant="subtle"
        color="gray"
        leftSection={<Plus size="0.9rem" />}
        aria-label={label}
        onClick={() => accounts.setAdding(true)}
        data-opponent-add
      >
        {t("Databases.Opponent.AddShort", { defaultValue: "Online account" })}
      </Button>
    </Tooltip>
  );
}

/**
 * The linked online accounts of the player shown on a database player card, under the name: the
 * accounts as chips, how many online games are downloaded, and the actions on them. It also owns
 * the Add dialog, so the dialog stays mounted while a first link turns the header button into
 * this strip.
 */
function OpponentAccounts({ accounts }: { accounts: OpponentAccountsState }) {
  const { t } = useTranslation();
  const store = useStore();
  const router = useRouter();
  const navigate = useNavigate();
  const { mutate: mutateCache } = useSWRConfig();
  const deps = useMemo(() => ({ store, mutateCache }), [store, mutateCache]);
  const imports = useAtomValue(opponentImportsAtom);
  const { data: listing, error: listingError } = useDatabaseList();
  const [confirming, setConfirming] = useState<"games" | "unlink" | null>(null);
  const { link, setLinks, expanded, setExpanded, adding, setAdding, linkAccount } = accounts;

  const games = opponentGames(link, listing, listingError);
  const inFlight = link !== undefined && imports.has(link.id);
  const periodOptions = opponentPeriodOptions(OPPONENT_PERIODS, t);
  const ticket = link ? (imports.get(link.id) ?? null) : null;
  const gamesFile = games.kind === "games" ? games.file : null;
  // Usernames that met each other stay separate players; the board then follows the first one.
  const { data: players } = useOpponentPlayers(link, gamesFile);

  const dialog = (
    <AddOpponentAccount
      opened={adding}
      onClose={() => setAdding(false)}
      linked={link?.accounts ?? []}
      onLink={linkAccount}
    />
  );
  if (!link) return accounts.offered ? dialog : null;

  const downloading = t("Databases.Opponent.Downloading", {
    defaultValue: "Downloading online games",
  });
  const status =
    games.kind === "games"
      ? t("Databases.Opponent.Games", {
          defaultValue: "{{count}} online games",
          count: games.count,
        })
      : games.kind === "unreadable"
        ? t("Databases.Opponent.Unreadable", { defaultValue: "The online games cannot be read" })
        : games.kind === "failed"
          ? t("Databases.Opponent.ListFailed", {
              defaultValue: "The databases could not be listed",
            })
          : games.kind === "pending"
            ? t("Common.Loading")
            : t("Databases.Opponent.NoGames", { defaultValue: "No games downloaded" });
  const problem = games.kind === "unreadable" || games.kind === "failed";

  return (
    <Paper variant="inset" p="xs" mt="xs" data-opponent-accounts>
      <Group justify="space-between" wrap="wrap" gap="xs" align="flex-start">
        <Group gap="xs" miw={0} wrap="wrap">
          {link.accounts.map((account) => (
            <Group
              key={`${account.provider}:${account.username.toLowerCase()}`}
              gap={4}
              wrap="nowrap"
              miw={0}
              className={classes.chip}
              data-opponent-chip
            >
              <SiteLogo site={account.provider} size={16} />
              <Text size="sm" fw={500} className="wrap-anywhere">
                {account.username}
              </Text>
              {expanded && (
                <IconAction
                  label={t("Databases.Opponent.RemoveAccount", {
                    defaultValue: "Remove {{username}}",
                    username: account.username,
                  })}
                  variant="subtle"
                  color="gray"
                  size="xs"
                  disabled={inFlight}
                  onClick={() =>
                    link.accounts.length === 1
                      ? setConfirming("unlink")
                      : setLinks((current) => withoutOpponentAccount(current, link.id, account))
                  }
                >
                  <X size="0.9rem" />
                </IconAction>
              )}
            </Group>
          ))}
          {link.accounts.length < MAX_OPPONENT_ACCOUNTS && (
            <IconAction
              label={t("Databases.Opponent.Add", { defaultValue: "Add online account" })}
              variant="subtle"
              color="gray"
              size="sm"
              disabled={inFlight}
              onClick={() => setAdding(true)}
            >
              <Plus size="0.9rem" />
            </IconAction>
          )}
          <Text
            size="sm"
            c={problem ? "danger" : "dimmed"}
            role={problem ? "alert" : "status"}
            data-opponent-status
          >
            {inFlight ? downloading : status}
          </Text>
        </Group>
        <Group gap={4} wrap="nowrap">
          {inFlight ? (
            <Button
              size="xs"
              variant="default"
              disabled={ticket === null}
              onClick={() =>
                void cancelOpponentImport(store, link.id).catch((error) =>
                  notifyUnlessCancelled(t("Common.Error"), error, "database"),
                )
              }
            >
              {t("Common.Cancel")}
            </Button>
          ) : (
            <Button
              size="xs"
              variant={games.kind === "games" ? "light" : "filled"}
              onClick={() => {
                const cardDatabase = activeDatabaseViewStore.getState().database;
                const reopenRoute =
                  games.kind === "games" && sameDatabaseHandle(cardDatabase?.file, games.file)
                    ? router.state.location.pathname
                    : null;
                void runOpponentImport(
                  deps,
                  link.id,
                  t("Databases.Opponent.DatabaseTitle", {
                    defaultValue: "{{name}} (online)",
                    name: link.playerName,
                  }),
                ).then((result) => {
                  reportOpponentImport(t, result);
                  if (
                    result.kind === "imported" &&
                    reopenRoute !== null &&
                    router.state.location.pathname === reopenRoute
                  ) {
                    void openOpponentCard(store, navigate, mutateCache, link.id);
                  }
                });
              }}
            >
              {games.kind === "games"
                ? t("Databases.Opponent.Update", { defaultValue: "Update games" })
                : t("Databases.Opponent.Download", { defaultValue: "Download games" })}
            </Button>
          )}
          <IconAction
            label={t("Databases.Opponent.Manage", { defaultValue: "Manage online accounts" })}
            variant="subtle"
            color="gray"
            pressed={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            <Settings size="1rem" />
          </IconAction>
        </Group>
      </Group>
      {inFlight && ticket !== null && <ImportProgress ticket={ticket} />}
      {players !== undefined && players.length > 1 && (
        <Text size="xs" c="dimmed" mt={4} className="wrap-anywhere" data-opponent-separate>
          {t("Databases.Opponent.Separate", {
            defaultValue:
              "The linked usernames played each other, so they stay separate players. The board shows the games of {{username}}.",
            username: players[0].name,
          })}
        </Text>
      )}
      {expanded && (
        <Stack gap="xs" mt="xs" data-opponent-details>
          <Group gap="md" align="flex-start" wrap="wrap">
            <Select
              size="xs"
              allowDeselect={false}
              label={t("Databases.OpeningTree.Since", { defaultValue: "Since" })}
              disabled={inFlight}
              value={opponentPeriodToValue(link.filter.years)}
              onChange={(value) => {
                if (value == null) return;
                const years = valueToOpponentPeriod(value, link.filter.years);
                setLinks((current) =>
                  withOpponentFilter(current, link.id, { ...link.filter, years }),
                );
              }}
              data={periodOptions}
              {...fitSelectProps(periodOptions)}
            />
            <Checkbox.Group
              label={t("Databases.Opponent.TimeControls", { defaultValue: "Time controls" })}
              value={link.filter.timeControls}
              onChange={(value) =>
                setLinks((current) =>
                  withOpponentFilter(current, link.id, {
                    ...link.filter,
                    timeControls: value as OpponentTimeControl[],
                  }),
                )
              }
            >
              <CheckboxRow mt={4}>
                {OPPONENT_TIME_CONTROLS.map((control) => (
                  <CheckboxRow.Item
                    key={control}
                    value={control}
                    disabled={inFlight}
                    label={
                      control === "bullet"
                        ? t("TimeControl.Bullet")
                        : control === "blitz"
                          ? t("TimeControl.Blitz")
                          : control === "rapid"
                            ? t("TimeControl.Rapid")
                            : control === "classical"
                              ? t("TimeControl.Classical")
                              : t("TimeControl.Correspondence")
                    }
                  />
                ))}
              </CheckboxRow>
            </Checkbox.Group>
          </Group>
          <Text size="xs" c="dimmed">
            {t("Databases.Opponent.FilterHint", {
              defaultValue: "Both apply to the next download.",
            })}
          </Text>
          <Group gap="xs">
            <Button
              size="xs"
              variant="subtle"
              color="danger"
              disabled={inFlight || games.kind === "none" || games.kind === "pending"}
              onClick={() => setConfirming("games")}
            >
              {t("Databases.Opponent.RemoveGames", { defaultValue: "Remove online games" })}
            </Button>
            <Button
              size="xs"
              variant="subtle"
              color="danger"
              disabled={inFlight}
              onClick={() => setConfirming("unlink")}
            >
              {t("Databases.Opponent.Unlink", { defaultValue: "Unlink accounts" })}
            </Button>
          </Group>
        </Stack>
      )}
      {dialog}
      <ConfirmModal
        title={t("Databases.Opponent.RemoveGames", { defaultValue: "Remove online games" })}
        description={t("Databases.Opponent.RemoveGames.Confirm", {
          defaultValue:
            "The downloaded online games of {{name}} are deleted. The linked accounts stay.",
          name: link.playerName,
        })}
        confirmLabel={t("Databases.Opponent.RemoveGames", { defaultValue: "Remove online games" })}
        opened={confirming === "games"}
        onClose={() => setConfirming(null)}
        onConfirm={async () => {
          if ((await removeOpponentGames(deps, link.id)) > 0) reportOpponentLeftover(t);
        }}
      />
      <ConfirmModal
        title={t("Databases.Opponent.Unlink", { defaultValue: "Unlink accounts" })}
        description={t("Databases.Opponent.Unlink.Confirm", {
          defaultValue: "The linked accounts of {{name}} and their downloaded games are removed.",
          name: link.playerName,
        })}
        confirmLabel={t("Databases.Opponent.Unlink", { defaultValue: "Unlink accounts" })}
        opened={confirming === "unlink"}
        onClose={() => setConfirming(null)}
        onConfirm={async () => {
          if ((await unlinkOpponent(deps, link.id)) > 0) reportOpponentLeftover(t);
        }}
      />
    </Paper>
  );
}

export default OpponentAccounts;
