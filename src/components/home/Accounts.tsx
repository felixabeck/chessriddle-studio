import {
  Autocomplete,
  Button,
  Checkbox,
  Group,
  InputWrapper,
  Loader,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { Plus } from "lucide-react";
import { useAtom, useAtomValue } from "jotai";
import { notifications } from "@mantine/notifications";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { useDatabaseList } from "@/hooks/useDatabaseList";
import { sessionsAtom } from "@/state/atoms";
import { getChessComAccount } from "@/utils/chess.com/api";
import { getLichessAccount } from "@/utils/lichess/api";
import { authenticateLichess } from "@/utils/lichess/authentication";
import {
  type ChessComSession,
  type LichessSession,
  sessionPlayerName,
  upsertLichessSession,
} from "@/utils/session";
import AccountCards from "../common/AccountCards";
import GenericCard from "../common/GenericCard";
import AppModal from "../common/AppModal";
import LichessLogo from "./LichessLogo";

function Accounts() {
  const { t } = useTranslation();
  const [sessions, setSessions] = useAtom(sessionsAtom);
  const { data, error, isValidating } = useDatabaseList();
  // Import association needs the complete shared listing. Account management remains usable
  // while that evidence is loading, unavailable or conflicting.
  const [open, setOpen] = useState(false);

  const addChessComSession = useCallback(
    (alias: string, session: ChessComSession) => {
      setSessions((sessions) => {
        const newSessions = sessions.filter((s) => s.chessCom?.username !== session.username);
        return [
          ...newSessions,
          {
            chessCom: session,
            player: alias,
            updatedAt: Date.now(),
          },
        ];
      });
    },
    [setSessions],
  );

  const addLichessSession = useCallback(
    (alias: string, session: LichessSession) => {
      setSessions((sessions) => upsertLichessSession(sessions, alias, session));
    },
    [setSessions],
  );

  const showAuthenticationFailed = useCallback(() => {
    notifications.show({
      message: t("Home.Accounts.AuthenticationFailed"),
      color: "danger",
    });
  }, [t]);

  const showLinkDurabilityUncertain = useCallback(() => {
    notifications.show({
      message: t("Home.Accounts.LinkDurabilityUncertain", {
        defaultValue:
          "The account is linked, but the save could not be fully confirmed. Do not retry.",
      }),
      color: "warning",
    });
  }, [t]);

  const addChessCom = useCallback(
    async (player: string, username: string): Promise<boolean> => {
      const p = player !== "" ? player : username;
      try {
        const stats = await getChessComAccount(username);
        if (!stats) return false;
        addChessComSession(p, { username, stats });
        return true;
      } catch (cause) {
        notifyUnlessCancelled(t("Common.Error"), cause);
        return false;
      }
    },
    [addChessComSession, t],
  );

  const addLichessNoLogin = useCallback(
    async (player: string, username: string): Promise<boolean> => {
      const p = player !== "" ? player : username;
      try {
        const account = await getLichessAccount({ username });
        if (!account) return false;
        addLichessSession(p, { username, account });
        return true;
      } catch (cause) {
        notifyUnlessCancelled(t("Common.Error"), cause);
        return false;
      }
    },
    [addLichessSession, t],
  );

  const addLichess = useCallback(
    async (player: string, username: string, withLogin: boolean): Promise<boolean> => {
      if (withLogin) {
        try {
          const result = await authenticateLichess(player, username);
          if (!result.ok) {
            showAuthenticationFailed();
            return false;
          }
          if (result.durabilityUncertain) showLinkDurabilityUncertain();
          return true;
        } catch {
          // Native errors are intentionally not exposed in the interface.
        }
        showAuthenticationFailed();
        return false;
      }
      return addLichessNoLogin(player, username);
    },
    [addLichessNoLogin, showAuthenticationFailed, showLinkDurabilityUncertain],
  );

  return (
    <>
      <AccountCards
        listing={data}
        listingAvailable={!error}
        listingPending={isValidating}
        onAddAccount={() => setOpen(true)}
      />
      {sessions.length > 0 && (
        <Group>
          <Button
            fullWidth
            className="wrap-button"
            variant="light"
            rightSection={<Plus size="1rem" />}
            onClick={() => setOpen(true)}
          >
            {t("Home.Accounts.Add")}
          </Button>
        </Group>
      )}
      <AccountModal
        open={open}
        setOpen={setOpen}
        addLichess={addLichess}
        addChessCom={addChessCom}
      />
    </>
  );
}

export default Accounts;

function AccountModal({
  open,
  setOpen,
  addLichess,
  addChessCom,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  addLichess: (player: string, username: string, withLogin: boolean) => Promise<boolean>;
  addChessCom: (player: string, username: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const sessions = useAtomValue(sessionsAtom);
  const [username, setUsername] = useState("");
  const [player, setPlayer] = useState<string>("");
  const [website, setWebsite] = useState<"lichess" | "chesscom">("lichess");
  const [withLogin, setWithLogin] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const submitLock = useRef(false);

  const players = new Set(sessions.map(sessionPlayerName));

  function closeAndClear() {
    setOpen(false);
    setUsername("");
    setPlayer("");
    setWebsite("lichess");
    setWithLogin(false);
  }

  async function addAccount() {
    if (submitLock.current) return;
    submitLock.current = true;
    setIsPending(true);
    try {
      const success =
        website === "lichess"
          ? await addLichess(player, username, withLogin)
          : await addChessCom(player, username);
      if (success) closeAndClear();
    } catch {
      // Account providers own their lookup failure notifications.
    } finally {
      submitLock.current = false;
      setIsPending(false);
    }
  }

  return (
    <AppModal
      opened={open}
      onClose={() => !isPending && setOpen(false)}
      title={t("Home.Accounts.Add")}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          addAccount();
        }}
      >
        <Stack>
          <Autocomplete
            label={t("Home.Accounts.PlayerName")}
            description={t("Home.Accounts.PlayerName.Desc")}
            data={Array.from(players)}
            value={player}
            onChange={(value) => setPlayer(value)}
            placeholder={t("Home.Accounts.SelectPlayer")}
          />
          <InputWrapper label={t("Home.Accounts.Website")} required>
            <Group grow>
              <GenericCard
                id={"lichess"}
                isSelected={website === "lichess"}
                setSelected={() => setWebsite("lichess")}
                Header={
                  <Group>
                    <LichessLogo />
                    Lichess
                  </Group>
                }
              />
              <GenericCard
                id={"chesscom"}
                isSelected={website === "chesscom"}
                setSelected={() => setWebsite("chesscom")}
                Header={
                  <Group>
                    <img width={30} height={30} src="/chesscom.png" alt="chess.com" />
                    Chess.com
                  </Group>
                }
              />
            </Group>
          </InputWrapper>

          <TextInput
            label={t("Home.Accounts.Username")}
            placeholder={t("Home.Accounts.EnterUsername")}
            required
            value={username}
            onChange={(e) => setUsername(e.currentTarget.value)}
          />
          {website === "lichess" && (
            <Checkbox
              label={t("Home.Accounts.LoginWithBrowser")}
              description={t("Home.Accounts.LoginWithBrowser.Desc")}
              checked={withLogin}
              onChange={(e) => setWithLogin(e.currentTarget.checked)}
            />
          )}
          <Button
            mt="1rem"
            type="submit"
            className="wrap-button"
            loading={isPending}
            disabled={isPending}
          >
            {t("Common.Add")}
          </Button>
          {isPending && (
            <Group gap="xs" role="status" aria-live="polite">
              <Loader size="sm" />
              <Text size="sm">{t("Common.Loading")}</Text>
            </Group>
          )}
        </Stack>
      </form>
    </AppModal>
  );
}
