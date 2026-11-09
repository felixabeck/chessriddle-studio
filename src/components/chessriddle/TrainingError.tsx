import { Alert, Button, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { AccountError } from "@/bindings";
import { chessRiddleTrainingSessions as sessions } from "@/state/chessRiddleTraining";

export default function TrainingError({ id, error }: { id: string; error: AccountError }) {
  const { t } = useTranslation();
  const messages: Record<AccountError, string> = {
    notConnected: t("Training.Error.NotConnected"),
    authentication: t("Training.Error.Reconnect"),
    invalidGrant: t("Training.Error.Reconnect"),
    dailyLimit: t("Training.Error.DailyLimit"),
    updateRequired: t("Training.Error.UpdateRequired"),
    rateLimited: t("Training.Error.RateLimited"),
    engineTimeout: t("Training.Error.EngineTimeout"),
    engineBusy: t("Training.Error.EngineBusy"),
    engineUnavailable: t("Training.Error.EngineUnavailable"),
    submissionInProgress: t("Training.Error.SubmissionInProgress"),
    network: t("Training.Error.Network"),
    unavailable: t("Training.Error.Unavailable"),
    busy: t("Training.Error.Busy"),
    invalidRequest: t("Training.Error.InvalidRequest"),
    server: t("Training.Error.Server"),
    storage: t("Training.Error.Server"),
    invalidLink: t("Training.Error.Server"),
    browser: t("Training.Error.Browser"),
    alreadyConnected: t("Training.Error.Server"),
  };
  return (
    <Alert color="warning" role="alert">
      <Stack gap="sm">
        <Text>{messages[error]}</Text>
        {error === "dailyLimit" && (
          <Button onClick={() => void sessions.openUpgrade(id)}>{t("Training.Upgrade")}</Button>
        )}
      </Stack>
    </Alert>
  );
}
