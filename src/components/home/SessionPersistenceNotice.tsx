import { Alert, Button, Stack, Text } from "@mantine/core";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import enUS from "@/translation/en-US.json";
import {
  getSessionPersistenceSnapshot,
  retrySessionPersistence,
  subscribeSessionPersistence,
} from "@/utils/session";

export function SessionPersistenceNotice() {
  const { t } = useTranslation(undefined, { useSuspense: false });
  const { status } = useSyncExternalStore(
    subscribeSessionPersistence,
    getSessionPersistenceSnapshot,
  );
  if (status === "saved") return null;

  const title =
    t("Accounts.Persistence.Title", {
      defaultValue: enUS.translation["Accounts.Persistence.Title"],
    }) || enUS.translation["Accounts.Persistence.Title"];

  return (
    <Alert
      color="warning"
      variant="outline"
      bg="var(--mantine-color-body)"
      title={title}
      role="alert"
      style={{
        // Placed by FixedNoticeStack; shrink with it so the Retry action stays reachable.
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflowWrap: "anywhere",
      }}
      styles={{
        wrapper: { minHeight: 0 },
        body: { minHeight: 0 },
        title: { flexShrink: 0 },
        message: { display: "flex", minHeight: 0 },
      }}
    >
      <Stack align="flex-start" gap="sm" mih={0} style={{ flex: 1 }}>
        <Text tabIndex={0} mih={0} style={{ overflowY: "auto" }}>
          {t("Accounts.Persistence.Unsaved", {
            defaultValue: enUS.translation["Accounts.Persistence.Unsaved"],
          }) || enUS.translation["Accounts.Persistence.Unsaved"]}
        </Text>
        <Button
          className="wrap-button"
          maw="100%"
          style={{ flexShrink: 0 }}
          onClick={() => retrySessionPersistence()}
        >
          {t("Accounts.Persistence.TryAgain", {
            defaultValue: enUS.translation["Accounts.Persistence.TryAgain"],
          }) || enUS.translation["Accounts.Persistence.TryAgain"]}
        </Button>
      </Stack>
    </Alert>
  );
}
