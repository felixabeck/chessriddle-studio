import { Button, Group, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import AppModal from "@/components/common/AppModal";

/** First-use disclosure dialog shown before sending the first question to a connection. */
export function AiNoticeModal({
  title,
  body,
  acceptLabel,
  onCancel,
  onAccept,
}: {
  title: string;
  body: string;
  acceptLabel: string;
  onCancel: () => void;
  onAccept: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AppModal opened onClose={onCancel} title={title}>
      <Stack>
        <Text>{body}</Text>
        <Group justify="right">
          <Button variant="default" onClick={onCancel}>
            {t("Common.Cancel")}
          </Button>
          <Button onClick={onAccept}>{acceptLabel}</Button>
        </Group>
      </Stack>
    </AppModal>
  );
}
