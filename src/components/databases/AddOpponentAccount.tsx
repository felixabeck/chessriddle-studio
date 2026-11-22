import { Badge, Button, Group, InputWrapper, Paper, Stack, Text, TextInput } from "@mantine/core";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OpponentAccount, OpponentProvider } from "@/bindings";
import { opponentProviderName, sameOpponentAccount } from "@/state/opponentLinks";
import AppModal from "../common/AppModal";
import GenericCard from "../common/GenericCard";
import { SiteLogo } from "../home/SiteLogo";
import { isOpponentUsername, lookupOpponentAccount, type OpponentLookup } from "./opponentLookup";

const PROVIDERS: OpponentProvider[] = ["lichess", "chesscom"];

/**
 * Asks for a site and a username, shows what the site says about that account, and links it only
 * once the user confirms that this is the opponent.
 */
function AddOpponentAccount({
  opened,
  onClose,
  linked,
  onLink,
}: {
  opened: boolean;
  onClose: () => void;
  linked: readonly OpponentAccount[];
  onLink: (account: OpponentAccount) => void;
}) {
  const { t } = useTranslation();
  const [provider, setProvider] = useState<OpponentProvider>("lichess");
  const [username, setUsername] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [pending, setPending] = useState(false);
  const [lookup, setLookup] = useState<OpponentLookup | null>(null);
  // A lookup answers the question it was asked: a changed site or name discards its answer.
  const question = useRef(0);

  function reset(next: { provider?: OpponentProvider; username?: string }) {
    question.current += 1;
    if (next.provider) setProvider(next.provider);
    if (next.username !== undefined) setUsername(next.username);
    setInvalid(false);
    setPending(false);
    setLookup(null);
  }

  function close() {
    reset({ provider: "lichess", username: "" });
    onClose();
  }

  async function lookUp() {
    const name = username.trim();
    if (!isOpponentUsername(provider, name)) {
      setInvalid(true);
      return;
    }
    const asked = ++question.current;
    setPending(true);
    const answer = await lookupOpponentAccount(provider, name);
    if (asked !== question.current) return;
    setPending(false);
    setLookup(answer);
  }

  const profile = lookup?.kind === "found" ? lookup.profile : null;
  const alreadyLinked =
    profile !== null && linked.some((account) => sameOpponentAccount(account, profile));
  const site = opponentProviderName(provider);
  const failure =
    lookup === null || lookup.kind === "found"
      ? null
      : lookup.kind === "notFound"
        ? t("Databases.Opponent.Failure.NotFound", {
            defaultValue: "{{site}} has no account named {{username}}.",
            site,
            username: username.trim(),
          })
        : lookup.kind === "closed"
          ? t("Databases.Opponent.Failure.Closed", {
              defaultValue:
                "This Lichess account is closed. Its games can no longer be downloaded.",
            })
          : lookup.kind === "rateLimited"
            ? t("Databases.Opponent.Failure.RateLimited", {
                defaultValue: "{{site}} is limiting requests. Try again in a minute.",
                site,
              })
            : t("Databases.Opponent.Failure.Lookup", {
                defaultValue: "The account could not be looked up. Try again.",
              });

  return (
    <AppModal
      opened={opened}
      onClose={close}
      title={t("Databases.Opponent.Add", { defaultValue: "Add online account" })}
      pending={pending}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void lookUp();
        }}
      >
        <Stack>
          <InputWrapper label={t("Home.Accounts.Website")} required>
            {/* Cards that do not fit side by side wrap, each then taking the full width. */}
            <Group grow preventGrowOverflow={false} wrap="wrap">
              {PROVIDERS.map((option) => (
                <GenericCard
                  key={option}
                  id={option}
                  isSelected={provider === option}
                  setSelected={() => reset({ provider: option })}
                  Header={
                    <Group gap="xs">
                      <SiteLogo site={option} />
                      <Text span className="wrap-anywhere">
                        {opponentProviderName(option)}
                      </Text>
                    </Group>
                  }
                />
              ))}
            </Group>
          </InputWrapper>
          <TextInput
            label={t("Home.Accounts.Username")}
            required
            value={username}
            onChange={(event) => reset({ username: event.currentTarget.value })}
            error={
              invalid
                ? t("Databases.Opponent.InvalidUsername", {
                    defaultValue: "Enter the username as the site shows it.",
                  })
                : undefined
            }
            data-autofocus
          />
          {failure !== null && (
            <Text c="danger" size="sm" role="alert" className="wrap-anywhere">
              {failure}
            </Text>
          )}
          {profile !== null && (
            <Paper variant="inset" p="sm" data-opponent-profile>
              <Stack gap={4}>
                <Group gap="xs">
                  <SiteLogo site={profile.provider} size={22} />
                  <Text fw={600} className="wrap-anywhere">
                    {profile.username}
                  </Text>
                  {profile.title && <Badge>{profile.title}</Badge>}
                </Group>
                {(profile.realName || profile.country) && (
                  <Text size="sm" className="wrap-anywhere">
                    {[profile.realName, profile.country].filter(Boolean).join(", ")}
                  </Text>
                )}
                {profile.ratedGames !== undefined && (
                  <Text size="sm" c="dimmed">
                    {t("Databases.Opponent.RatedGames", {
                      defaultValue: "{{count}} rated games",
                      count: profile.ratedGames,
                    })}
                  </Text>
                )}
                {profile.closed && (
                  <Text size="sm" c="dimmed">
                    {t("Databases.Opponent.ClosedChessCom", {
                      defaultValue: "This account is closed. Its games are still available.",
                    })}
                  </Text>
                )}
                {alreadyLinked && (
                  <Text size="sm" c="dimmed" role="status">
                    {t("Databases.Opponent.AlreadyLinked", {
                      defaultValue: "This account is already linked.",
                    })}
                  </Text>
                )}
              </Stack>
            </Paper>
          )}
          <Group justify="right">
            <Button variant="default" className="wrap-button" disabled={pending} onClick={close}>
              {t("Common.Cancel")}
            </Button>
            {profile !== null ? (
              <Button
                className="wrap-button"
                disabled={alreadyLinked}
                onClick={() => {
                  onLink({ provider: profile.provider, username: profile.username });
                  close();
                }}
              >
                {t("Databases.Opponent.Link", { defaultValue: "Link account" })}
              </Button>
            ) : (
              <Button type="submit" className="wrap-button" loading={pending}>
                {t("Databases.Opponent.LookUp", { defaultValue: "Look up" })}
              </Button>
            )}
          </Group>
        </Stack>
      </form>
    </AppModal>
  );
}

export default AddOpponentAccount;
