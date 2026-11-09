import { Alert, Button, Card, Group, Stack, Text } from "@mantine/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AccountError, AccountStatus, DisconnectOutcome } from "@/bindings";
import { ChessRiddleCommandError } from "@/platform/chessriddle";
import { tauri } from "@/platform/tauri";

type Action = "refresh" | "connect" | "disconnect";

export function ChessRiddleAccountCard({ onConnected }: { onConnected?: () => void } = {}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [pending, setPending] = useState<Action | null>("refresh");
  const [error, setError] = useState<AccountError | null>(null);
  const [removed, setRemoved] = useState<Extract<DisconnectOutcome, { status: "removed" }> | null>(
    null,
  );
  const [unavailable, setUnavailable] = useState(false);
  const owner = useRef<symbol | null>(null);
  const running = useRef(false);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  const run = useCallback(
    async (action: Action, identity = owner.current, userTriggered = true) => {
      if (!identity || identity !== owner.current || running.current) return;
      running.current = true;
      setPending(action);
      setError(null);
      const current = () => owner.current === identity;
      let connected = false;
      const accept = (next: AccountStatus) => {
        if (!current()) return;
        setStatus(next);
        connected = next.status === "connected" && !next.durability_uncertain;
      };
      const report = (cause: unknown) => {
        if (!current()) return;
        connected = false;
        const code = new ChessRiddleCommandError(cause).code;
        if (code === "unavailable") setUnavailable(true);
        else setError(code);
      };
      try {
        if (action === "disconnect") {
          const outcome = await tauri.disconnectChessriddle();
          if (!current()) return;
          setRemoved(outcome.status === "removed" ? outcome : null);
          // Removal has settled, but only a native status read decides the next account action.
          setStatus(null);
          const next = await tauri.chessriddleAccount();
          if (current()) setStatus(next);
        } else if (action === "connect") {
          try {
            const next = await tauri.connectChessriddle();
            accept(next);
          } catch (cause) {
            if (!current()) return;
            // The native owner may have linked before a profile fetch failed. Reconcile once,
            // after connect settles, so a retry never assumes that no credential exists.
            try {
              const next = await tauri.chessriddleAccount();
              accept(next);
            } catch (refreshCause) {
              report(refreshCause);
            }
            report(cause);
          }
        } else {
          const next = await tauri.chessriddleAccount();
          accept(next);
        }
      } catch (cause) {
        report(cause);
      } finally {
        if (current()) {
          running.current = false;
          setPending(null);
          if (userTriggered && action !== "disconnect" && connected) onConnectedRef.current?.();
        }
      }
    },
    [],
  );

  useEffect(() => {
    const identity = Symbol("ChessRiddle account card");
    owner.current = identity;
    running.current = false;
    void run("refresh", identity, false);
    return () => {
      // Native owns the action, including the browser round trip. Retire only this view.
      owner.current = null;
    };
  }, [run]);

  const errors: Record<AccountError, string> = {
    notConnected: t("Home.ChessRiddle.Error.Server"),
    dailyLimit: t("Home.ChessRiddle.Error.Server"),
    updateRequired: t("Home.ChessRiddle.Error.Server"),
    invalidRequest: t("Home.ChessRiddle.Error.Server"),
    submissionInProgress: t("Home.ChessRiddle.Error.Server"),
    engineTimeout: t("Home.ChessRiddle.Error.Server"),
    engineBusy: t("Home.ChessRiddle.Error.Server"),
    engineUnavailable: t("Home.ChessRiddle.Error.Server"),
    unavailable: t("Home.ChessRiddle.Error.Server"),
    busy: t("Home.ChessRiddle.Error.Busy"),
    storage: t("Home.ChessRiddle.Error.Storage"),
    network: t("Home.ChessRiddle.Error.Network"),
    rateLimited: t("Home.ChessRiddle.Error.RateLimited"),
    server: t("Home.ChessRiddle.Error.Server"),
    invalidGrant: t("Home.ChessRiddle.Error.Server"),
    authentication: t("Home.ChessRiddle.Error.Authentication"),
    invalidLink: t("Home.ChessRiddle.Error.Server"),
    browser: t("Home.ChessRiddle.Error.Browser"),
    alreadyConnected: t("Home.ChessRiddle.Error.AlreadyConnected"),
  };

  if (unavailable || (!status && !error)) return null;
  const hasAccount = status?.status === "connected" || status?.status === "statusUnreadable";
  const visibleError = error ?? (status?.status === "statusUnreadable" ? status.error : null);

  return (
    <Card
      component="section"
      aria-label={t("Home.ChessRiddle.Title")}
      withBorder
      radius="md"
      padding="lg"
      px={{ base: "xs", xs: "lg" }}
      mt="md"
      miw={0}
      className="wrap-anywhere"
      style={{ flexShrink: 0 }}
    >
      <Stack gap="sm" miw={0}>
        <Text fw={600} size="sm">
          {t("Home.ChessRiddle.Title")}
        </Text>
        <div role="status" aria-live="polite">
          {pending === "connect" ? (
            <Text size="sm">{t("Home.ChessRiddle.Connecting")}</Text>
          ) : status?.status === "connected" ? (
            <Stack gap={4}>
              <Text size="sm" className="wrap-anywhere">
                {status.account.username
                  ? t("Home.ChessRiddle.ConnectedAs", { username: status.account.username })
                  : t("Home.ChessRiddle.Connected")}
              </Text>
              <Text size="sm" c="dimmed">
                {status.account.plan === "gold"
                  ? t("Home.ChessRiddle.PlanGold")
                  : t("Home.ChessRiddle.PlanFree")}
              </Text>
            </Stack>
          ) : status?.status === "statusUnreadable" ? (
            <Text size="sm">{t("Home.ChessRiddle.StatusUnreadable")}</Text>
          ) : status?.status === "reconnectNeeded" ? (
            <Text size="sm">{t("Home.ChessRiddle.ReconnectNeeded")}</Text>
          ) : status?.status === "disconnected" ? (
            <Text size="sm">{t("Home.ChessRiddle.Disconnected")}</Text>
          ) : null}
        </div>
        {visibleError && (
          <Alert color="danger" px="xs">
            {errors[visibleError]}
          </Alert>
        )}
        {removed?.revocation_pending && (
          <Alert color="warning" px="xs">
            {t("Home.ChessRiddle.RevocationPending")}
          </Alert>
        )}
        {removed?.durability_uncertain && (
          <Alert color="warning" px="xs">
            {t("Home.ChessRiddle.RemovalDurabilityUncertain")}
          </Alert>
        )}
        {status?.status === "connected" && status.durability_uncertain && (
          <Alert color="warning" px="xs">
            {t("Home.ChessRiddle.ConnectionDurabilityUncertain")}
          </Alert>
        )}
        <Group gap="xs">
          {status && (
            <Button
              className="wrap-button"
              miw={0}
              maw="100%"
              variant={hasAccount ? "default" : "filled"}
              disabled={pending !== null}
              loading={pending === "connect" || pending === "disconnect"}
              onClick={() => void run(hasAccount ? "disconnect" : "connect")}
            >
              {hasAccount
                ? t("Home.ChessRiddle.Disconnect")
                : status.status === "reconnectNeeded"
                  ? t("Home.ChessRiddle.Reconnect")
                  : t("Home.ChessRiddle.Connect")}
            </Button>
          )}
          <Button
            className="wrap-button"
            miw={0}
            maw="100%"
            variant="subtle"
            disabled={pending !== null}
            loading={pending === "refresh"}
            onClick={() => void run("refresh")}
          >
            {t("Home.ChessRiddle.Refresh")}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
