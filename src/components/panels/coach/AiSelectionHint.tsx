import { Anchor, Group, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

/**
 * The line under an AI action while it cannot run: what is still to be chosen, or why the model
 * list is missing. When the model list failed, a Retry link reads it again in place, so the user
 * does not have to leave for Settings.
 */
export function AiSelectionHint({
  text,
  onRetry,
  mt,
  ...dataAttributes
}: {
  text: string;
  onRetry?: () => void;
  mt?: number;
  [dataAttribute: `data-${string}`]: boolean | string | undefined;
}) {
  const { t } = useTranslation();
  return (
    <Group gap={6} mt={mt} wrap="wrap">
      <Text size="xs" c="dimmed" {...dataAttributes}>
        {text}
      </Text>
      {onRetry && (
        <Anchor component="button" type="button" size="xs" onClick={onRetry}>
          {t("Common.Retry")}
        </Anchor>
      )}
    </Group>
  );
}
