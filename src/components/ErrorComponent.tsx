import { Anchor, Button, Code, CopyButton, Group, Stack, Text, Title } from "@mantine/core";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Trans, useTranslation } from "react-i18next";
import { normalizeError } from "@/platform/errors";
import LazyFeedbackModal from "@/components/feedback/LazyFeedbackModal";
import { runUnlessCancelled } from "@/components/files/notifyError";
import { REPOSITORY_URL } from "@/utils/product.json";

const issueUrl = `${REPOSITORY_URL}/issues/new?assignees=&labels=bug&projects=&template=bug.yml`;

export default function ErrorComponent({ error }: { error: unknown }) {
  const { t } = useTranslation();
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
          <CopyButton value={normalized.diagnostic ?? ""}>
            {({ copied, copy }) => (
              <Button color={copied ? "success" : undefined} onClick={copy}>
                {copied ? t("Common.Copied") : t("Error.CopyStackTrace")}
              </Button>
            )}
          </CopyButton>
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
