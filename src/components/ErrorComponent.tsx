import { Anchor, Button, Code, Group, Stack, Text, Title } from "@mantine/core";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Trans, useTranslation } from "react-i18next";
import { useClipboardCopy } from "@/hooks/useClipboardCopy";
import { normalizeError } from "@/platform/errors";
import LazyFeedbackModal from "@/components/feedback/LazyFeedbackModal";
import { runUnlessCancelled } from "@/components/files/notifyError";
import { REPOSITORY_URL } from "@/utils/product.json";

const issueUrl = `${REPOSITORY_URL}/issues/new?assignees=&labels=bug&projects=&template=bug.yml`;

// Keep Mantine CopyButton's former default feedback duration.
const COPIED_FEEDBACK_MS = 1000;

export default function ErrorComponent({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const { copied, copy } = useClipboardCopy(t("Error.CopyFailed"), COPIED_FEEDBACK_MS);
  const navigate = useNavigate();
  const [feedbackOpened, setFeedbackOpened] = useState(false);
  const normalized = normalizeError(error);
  const showDiagnostic = Boolean(
    normalized.diagnostic && normalized.diagnostic !== normalized.message,
  );

  return (
    <Stack p="md">
      <Title>{t("Error.Title")}</Title>
      <Text>
        <b>{t("Error.Unexpected")}:</b> {normalized.message}
      </Text>
      {showDiagnostic && <Code>{normalized.diagnostic}</Code>}
      <Group>
        <Button onClick={() => setFeedbackOpened(true)}>{t("Menu.Help.SendFeedback")}</Button>
        {showDiagnostic && (
          <Button
            color={copied ? "success" : undefined}
            onClick={() => void copy(normalized.diagnostic ?? "")}
          >
            {copied ? t("Common.Copied") : t("Error.CopyStackTrace")}
          </Button>
        )}
        <Button
          variant="default"
          onClick={() => {
            void runUnlessCancelled(t("Common.Error"), async () => {
              await navigate({ to: "/" });
              window.location.reload();
            });
          }}
        >
          {t("Menu.View.Reload")}
        </Button>
      </Group>

      <Text>
        <Trans
          i18nKey="Error.ReportIssue"
          components={{
            github: <Anchor href={issueUrl} target="_blank" />,
          }}
        />
      </Text>
      <LazyFeedbackModal opened={feedbackOpened} onClose={() => setFeedbackOpened(false)} />
    </Stack>
  );
}
