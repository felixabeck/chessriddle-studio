import { Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { LineTitle } from "./lineTitle";

export function GameTitle({ title, repertoire }: { title: LineTitle; repertoire: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      <Text component="span" inherit c={repertoire && !title.name ? "dimmed" : undefined}>
        {title.name || (repertoire ? t("GameInfo.UntitledLine") : "...")}
      </Text>
      {repertoire && title.idea && (
        <Text component="span" size="xs" c="dimmed" ml="xs">
          {title.idea}
        </Text>
      )}
    </>
  );
}
